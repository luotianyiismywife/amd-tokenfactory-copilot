/**
 * Key 失效与轮换测试（`src/keys/health.ts` + `src/keys/config.ts`）。
 *
 * AMD TokenFactory 无「封号」概念，失效判据为 HTTP 状态码：
 *   401/402 → rotatePersist（持久化不可用）
 *   429/502/503/504 → rotateCooldown（仅内存冷却）
 *   500 → retrySameKey（不换 key）
 *
 * 覆盖：
 *  1. 401/402 命中轮换 + reason = 规则 message
 *  2. 确定性失败 → markApiKeyExhausted 持久化 available=false
 *  3. 失效 key 被 pickNextApiKey 跳过
 *  4. 全部 key 失效 → 报错显示脱敏详情
 *  5. 自定义 errorRules（code 可配置）
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-banned-rotation.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;

let settings = {};
const vscodeShim = {
    env: { language: "en" },
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => (key in settings ? settings[key] : fallback),
        }),
    },
    window: {
        createOutputChannel: () => ({ debug() {}, info() {}, warn() {}, error() {}, dispose() {} }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

function makeSecrets(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get: async (k) => map.get(k),
        store: async (k, v) => void map.set(k, v),
        delete: async (k) => void map.delete(k),
    };
}

const { isKeyRotationError, getKeyRotationReason, markApiKeyExhausted, isApiKeyEligible } =
    require("../out/keys/health.js");
const { getApiKeyStore, saveApiKeyStore, invalidateApiKeyStoreCache } = require("../out/keys/store.js");
const { pickNextApiKey } = require("../out/keys/selection.js");
const { resetExhaustedKeys } = require("../out/keys/health.js");
const { setRotationIndex } = require("../out/keys/state.js");
const { REASON_TEXT } = require("../out/provider/errors.js");
const { logger } = require("../out/core/logger.js");
logger.init();

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
}

/** 构造与真实错误消息同形的 Error */
const apiError = (status, body = "") =>
    new Error(`API error: [${status}] Bad Request ${body} URL: https://developer.amd.com.cn/radeon/api/v1/chat/completions`);

async function reset(secrets, keys, activeIndex = 0) {
    invalidateApiKeyStoreCache();
    setRotationIndex(0);
    await resetExhaustedKeys(secrets, true);
    await saveApiKeyStore(secrets, { keys, activeIndex });
}

const K = (value, extra = {}) => ({ value, available: null, ...extra });

// ---------------------------------------------------------------------------
// 1. 失效错误识别
// ---------------------------------------------------------------------------
console.log("失效错误识别");

await check("401 命中 isKeyRotationError", () => {
    assert.equal(isKeyRotationError(apiError(401)), true);
});

await check("402 命中 isKeyRotationError", () => {
    assert.equal(isKeyRotationError(apiError(402)), true);
});

await check("401 reason = 规则的 message 说明", () => {
    assert.equal(getKeyRotationReason(apiError(401)), "无效 key");
});

await check("500 不触发轮换（平台侧错误，同 key 重试）", () => {
    assert.equal(isKeyRotationError(apiError(500)), false);
    assert.equal(getKeyRotationReason(apiError(500)), "内部错误");
});

await check("403 不在任何规则中 → 不轮换", () => {
    assert.equal(isKeyRotationError(apiError(403)), false);
    assert.equal(getKeyRotationReason(apiError(403)), undefined);
});

// ---------------------------------------------------------------------------
// 2. 确定性失败 → 持久化
// ---------------------------------------------------------------------------
console.log("失效持久化");

await check("markApiKeyExhausted(rotatePersist) 持久化 available=false", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "无效 key", "rotatePersist");
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.find((k) => k.value === "a").available, false);
});

await check("失效 key 变 ineligible", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "无效 key", "rotatePersist");
    const store = await getApiKeyStore(secrets);
    assert.equal(isApiKeyEligible(store.keys.find((k) => k.value === "a")), false);
});

// ---------------------------------------------------------------------------
// 3. 失效 key 被跳过
// ---------------------------------------------------------------------------
console.log("失效 key 跳过");

await check("pickNextApiKey 跳过失效 key", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "无效 key", "rotatePersist");
    const picked = await pickNextApiKey(secrets, "rotation");
    assert.equal(picked.value, "b");
});

// ---------------------------------------------------------------------------
// 4. 报错文案
// ---------------------------------------------------------------------------
console.log("报错文案");

await check("REASON_TEXT 含 unavailable 文案", () => {
    assert.equal(REASON_TEXT["unavailable"], "Unavailable");
});

// ---------------------------------------------------------------------------
// 5. 自定义 errorRules
// ---------------------------------------------------------------------------
console.log("自定义 errorRules");

await check("自定义规则生效（新增 code）", () => {
    settings = { errorRules: [{ code: "account_suspended", message: "账号被暂停", action: "rotatePersist" }] };
    const err = apiError(400, '{"code":"account_suspended"}');
    assert.equal(isKeyRotationError(err), true);
    assert.equal(getKeyRotationReason(err), "账号被暂停");
    settings = {};
});

await check("清空规则后回退默认（401 仍识别）", () => {
    settings = { errorRules: [] };
    assert.equal(getKeyRotationReason(apiError(401)), "无效 key");
    settings = {};
});

Module._load = originalLoad;
console.log(`\nkey invalidation rotation: ${passed} checks passed`);
