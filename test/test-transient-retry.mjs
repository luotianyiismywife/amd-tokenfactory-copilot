/**
 * 错误分类规则测试（`src/keys/health.ts` 的 `matchErrorRule` + `src/keys/config.ts`）。
 *
 * 核心断言：**三元组（statusCode + detail + action），只配置一处**：
 * - detail（错误体 detail 字段子串匹配，大小写不敏感）优先于 statusCode——
 *   AMD 错误体格式 `{"detail":"..."}`（无 error.code），按错误文本分类；
 *   detail 文本同时用作展示文案（经 l10n 翻译）
 * - statusCode 兜底
 * - action 与 key 状态一一对应：retrySameKey 状态不变 / rotateCooldown 冷却中 / rotatePersist 不可用
 *
 * AMD TokenFactory 默认规则（7 条，以 statusCode 为主）：
 *   401/402 → rotatePersist；429/502/503/504 → rotateCooldown；500 → retrySameKey
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-transient-retry.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim（支持 errorRules 覆盖） ──
const Module = require("node:module");
const originalLoad = Module._load;
const configOverrides = {};
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => (key in configOverrides ? configOverrides[key] : fallback),
        }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { matchErrorRule, isKeyRotationError, isTransientRetryError } = require("../out/keys/health.js");
const { getErrorRules } = require("../out/keys/config.js");

let passed = 0;
const pending = [];
function check(name, fn) {
    const r = fn();
    if (r && typeof r.then === "function") {
        pending.push(
            r.then(() => {
                passed++;
                console.log(`  ok  ${name}`);
            })
        );
    } else {
        passed++;
        console.log(`  ok  ${name}`);
    }
}

/** 构造与真实错误消息同形的 Error（provider 抛出的格式） */
const apiError = (status, body = "") =>
    new Error(`API error: [${status}] Bad Request ${body} URL: https://developer.amd.com.cn/radeon/api/v1/chat/completions`);

// ---------------------------------------------------------------------------
// 1. 默认规则
// ---------------------------------------------------------------------------
console.log("默认规则");

check("默认规则 7 条", () => {
    assert.equal(getErrorRules().length, 7);
});

// ---------------------------------------------------------------------------
// 2. statusCode 匹配
// ---------------------------------------------------------------------------
console.log("statusCode 匹配");

check("401（无效 key）→ rotatePersist", () => {
    const err = apiError(401);
    assert.equal(matchErrorRule(err)?.action, "rotatePersist");
    assert.equal(isKeyRotationError(err), true);
    assert.equal(isTransientRetryError(err), false);
});

check("402（余额不足）→ rotatePersist", () => {
    const err = apiError(402);
    assert.equal(matchErrorRule(err)?.action, "rotatePersist");
    assert.equal(isKeyRotationError(err), true);
});

check("429（限流）→ rotateCooldown", () => {
    const err = apiError(429);
    assert.equal(matchErrorRule(err)?.action, "rotateCooldown");
    assert.equal(isKeyRotationError(err), true);
    assert.equal(isTransientRetryError(err), true);
});

check("502/503/504（网关/繁忙）→ rotateCooldown", () => {
    for (const s of [502, 503, 504]) {
        assert.equal(matchErrorRule(apiError(s))?.action, "rotateCooldown", `status ${s}`);
    }
});

check("500（平台内部错误）→ retrySameKey（不换 key）", () => {
    const err = apiError(500);
    assert.equal(matchErrorRule(err)?.action, "retrySameKey");
    assert.equal(isKeyRotationError(err), false);
    assert.equal(isTransientRetryError(err), true);
});

check("403（不在任何规则中）→ undefined，不轮换不重试", () => {
    assert.equal(matchErrorRule(apiError(403)), undefined);
    assert.equal(isKeyRotationError(apiError(403)), false);
    assert.equal(isTransientRetryError(apiError(403)), false);
});

// ---------------------------------------------------------------------------
// 3. detail 子串匹配（AMD 错误体格式 {"detail":"..."}，优先于 statusCode）
// ---------------------------------------------------------------------------
console.log("detail 子串匹配");

check("detail 命中优先于 statusCode（AMD 实测签名）", () => {
    configOverrides["errorRules"] = [
        { detail: "invalid bearer token", action: "rotatePersist" },
        { statusCode: 400, action: "retrySameKey" },
    ];
    try {
        const err = apiError(400, '{"detail":"Invalid bearer token"}');
        assert.equal(matchErrorRule(err)?.action, "rotatePersist");
        assert.equal(isKeyRotationError(err), true);
        assert.equal(isTransientRetryError(err), false);
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("detail 子串匹配（部分文本即可命中）", () => {
    configOverrides["errorRules"] = [
        { detail: "bearer", action: "rotateCooldown" },
    ];
    try {
        const err = apiError(400, '{"detail":"Invalid Bearer Token"}');
        assert.equal(matchErrorRule(err)?.action, "rotateCooldown");
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("detail 不命中时回退 statusCode", () => {
    configOverrides["errorRules"] = [
        { detail: "quota exceeded", action: "rotateCooldown" },
        { statusCode: 401, action: "rotatePersist" },
    ];
    try {
        const err = apiError(401, '{"detail":"Invalid bearer token"}');
        assert.equal(matchErrorRule(err)?.action, "rotatePersist");
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("错误体无 detail 字段时不命中 detail 规则", () => {
    configOverrides["errorRules"] = [
        { detail: "invalid bearer token", action: "rotatePersist" },
    ];
    try {
        const err = apiError(400, '{"error":{"message":"something else"}}');
        assert.equal(matchErrorRule(err), undefined);
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("默认 401 规则带 detail（AMD 真实错误体）仍命中", () => {
    const err = apiError(401, '{"detail":"Invalid bearer token"}');
    assert.equal(matchErrorRule(err)?.action, "rotatePersist");
});

// ---------------------------------------------------------------------------
// 4. 规则可配置
// ---------------------------------------------------------------------------
console.log("规则可配置");

check("自定义规则生效（新增 detail）", () => {
    configOverrides["errorRules"] = [
        { detail: "my custom error", action: "retrySameKey" },
    ];
    try {
        const err = apiError(400, '{"detail":"My Custom Error"}');
        assert.equal(matchErrorRule(err)?.action, "retrySameKey");
        assert.equal(isKeyRotationError(err), false);
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("自定义规则生效（改 action）", () => {
    configOverrides["errorRules"] = [{ statusCode: 429, action: "rotatePersist" }];
    try {
        const err = apiError(429);
        assert.equal(matchErrorRule(err)?.action, "rotatePersist");
        assert.equal(isTransientRetryError(err), false);
    } finally {
        delete configOverrides["errorRules"];
    }
});

check("含未知字段（code/message）的规则被过滤，不参与匹配", () => {
    configOverrides["errorRules"] = [
        { code: "billing", message: "x", action: "rotatePersist" },
        { statusCode: 400, action: "retrySameKey" },
    ];
    try {
        // 第一条缺 detail/statusCode 被过滤 → 回落到第二条
        const err = apiError(400, '{"code":"billing"}');
        assert.equal(matchErrorRule(err)?.action, "retrySameKey");
    } finally {
        delete configOverrides["errorRules"];
    }
});

// ---------------------------------------------------------------------------
// 5. markApiKeyExhausted：处置由 action 决定
// ---------------------------------------------------------------------------
console.log("markApiKeyExhausted（action 决定处置）");

const { markApiKeyExhausted, isApiKeyEligible, getKeyDisplayStatus, getApiKeyStore, invalidateApiKeyStoreCache } =
    require("../out/keys/keyManager.js");

/** 内存版 SecretStorage mock */
function makeSecrets(initialKeys) {
    const data = new Map();
    data.set("amdTokenFactory.apiKeys", JSON.stringify({ keys: initialKeys, activeIndex: 0 }));
    return {
        async get(key) {
            return data.get(key);
        },
        async store(key, value) {
            data.set(key, value);
        },
        async delete(key) {
            data.delete(key);
        },
        _data: data,
    };
}

check("rotateCooldown → 仅冷却，不持久化（key 仍不可选但 available 不为 false）", async () => {
    const secrets = makeSecrets([{ value: "sk_a", available: null }]);
    invalidateApiKeyStoreCache();
    await markApiKeyExhausted(secrets, "sk_a", "限流", "rotateCooldown");
    invalidateApiKeyStoreCache();
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys[0].available, null, "available 不应被持久化为 false");
    assert.equal(isApiKeyEligible(store.keys[0]), false, "冷却中应不可选");
    assert.equal(getKeyDisplayStatus(store.keys[0]), "cooldown");
});

check("rotatePersist → 持久化 available=false", async () => {
    const secrets = makeSecrets([{ value: "sk_b", available: null }]);
    invalidateApiKeyStoreCache();
    await markApiKeyExhausted(secrets, "sk_b", "余额不足", "rotatePersist");
    invalidateApiKeyStoreCache();
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys[0].available, false, "available 应被持久化为 false");
    assert.equal(getKeyDisplayStatus(store.keys[0]), "unavailable");
});

Module._load = originalLoad;
await Promise.all(pending);
console.log(`\nerror rules: ${passed} checks passed`);
