/**
 * 轮换循环测试（`src/provider/rotation.ts`）。
 *
 * 覆盖核心行为：
 *  1. 首个 key 成功 → 直接返回，不换 key
 *  2. 402 余额不足 → 换 key（持久化 available=false）
 *  3. 429 限流 → 换 key（仅内存冷却）
 *  4. 500 平台错误 → **不换 key**，退避后重试同一个 key
 *  5. 全部 key 失败 → 抛错（含脱敏详情）
 *  6. 取消令牌 → 立即抛出，不轮换
 *  7. single 模式 + 余额不足 → 降级 rotation 切换
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-rotation.mjs
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
        _map: map,
    };
}

const { runKeyRotationLoop } = require("../out/provider/rotation.js");
const { getApiKeyStore, saveApiKeyStore, invalidateApiKeyStoreCache } = require("../out/keys/store.js");
const { resetExhaustedKeys } = require("../out/keys/health.js");
const { setRotationIndex } = require("../out/keys/state.js");
const { logger } = require("../out/core/logger.js");
logger.init();

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
}

/** 构造 provider 抛出的错误格式（含状态码） */
const apiError = (status, body = "") =>
    new Error(`API error: [${status}] ${body} URL: https://api.example.com/v1/chat/completions`);

/** 无取消的 token */
const noToken = { isCancellationRequested: false, onCancellationRequested: undefined };

async function reset(secrets, keys, activeIndex = 0) {
    invalidateApiKeyStoreCache();
    setRotationIndex(0);
    await resetExhaustedKeys(secrets, true);
    await saveApiKeyStore(secrets, { keys, activeIndex });
}

const K = (value, extra = {}) => ({ value, available: null, ...extra });

// ---------------------------------------------------------------------------
// 1. 首个 key 成功
// ---------------------------------------------------------------------------
console.log("成功路径");

await check("首个 key 成功 → 直接返回，不换 key", async () => {
    settings = { transientRetryTimes: 0 };
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    const tried = [];
    await runKeyRotationLoop({
        secrets,
        token: noToken,
        abortController: new AbortController(),
        apiMode: "openai",
        execute: async (apiKey) => {
            tried.push(apiKey);
        },
    });
    assert.deepEqual(tried, ["a"]);
    settings = {};
});

// ---------------------------------------------------------------------------
// 2. 402 余额不足 → 换 key
// ---------------------------------------------------------------------------
console.log("402 余额不足");

await check("402 → 换 key（持久化 available=false）", async () => {
    settings = { transientRetryTimes: 0 };
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    const tried = [];
    await runKeyRotationLoop({
        secrets,
        token: noToken,
        abortController: new AbortController(),
        apiMode: "openai",
        execute: async (apiKey) => {
            tried.push(apiKey);
            if (apiKey === "a") {
                throw apiError(402, '{"error":{"message":"余额不足"}}');
            }
        },
    });
    assert.deepEqual(tried, ["a", "b"]);
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.find((k) => k.value === "a").available, false); // 持久化
    settings = {};
});

// ---------------------------------------------------------------------------
// 3. 429 限流 → 换 key（仅冷却）
// ---------------------------------------------------------------------------
console.log("429 限流");

await check("429 → 换 key（仅内存冷却，不持久化）", async () => {
    settings = { transientRetryTimes: 0 };
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    const tried = [];
    await runKeyRotationLoop({
        secrets,
        token: noToken,
        abortController: new AbortController(),
        apiMode: "openai",
        execute: async (apiKey) => {
            tried.push(apiKey);
            if (apiKey === "a") {
                throw apiError(429, "RATE_LIMITED");
            }
        },
    });
    assert.deepEqual(tried, ["a", "b"]);
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.find((k) => k.value === "a").available, null); // 未持久化
    settings = {};
});

// ---------------------------------------------------------------------------
// 4. 500 平台错误 → 不换 key，重试同一个 key
// ---------------------------------------------------------------------------
console.log("500 平台错误（不换 key）");

await check("500 → 不换 key，退避后重试同一个 key", async () => {
    settings = { transientRetryTimes: 1 };
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    const tried = [];
    await runKeyRotationLoop({
        secrets,
        token: noToken,
        abortController: new AbortController(),
        apiMode: "openai",
        execute: async (apiKey) => {
            tried.push(apiKey);
            if (tried.length === 1) {
                throw apiError(500, "Internal Server Error");
            }
            // 第二次成功
        },
    });
    // 两次都是同一个 key "a"（500 不换 key）
    assert.deepEqual(tried, ["a", "a"]);
    settings = {};
});

// ---------------------------------------------------------------------------
// 5. 全部 key 失败 → 抛错
// ---------------------------------------------------------------------------
console.log("全部失败");

await check("全部 key 402 → 抛错（含脱敏详情）", async () => {
    settings = { transientRetryTimes: 0 };
    const secrets = makeSecrets();
    await reset(secrets, [K("sk-aaaaaaaaaaaa"), K("sk-bbbbbbbbbbbb")]);
    await assert.rejects(
        () =>
            runKeyRotationLoop({
                secrets,
                token: noToken,
                abortController: new AbortController(),
                apiMode: "openai",
                execute: async () => {
                    throw apiError(402, '{"error":{"message":"余额不足"}}');
                },
            }),
        (err) => {
            assert.match(err.message, /sk-\*\*\*\*aaaa/); // 脱敏
            assert.match(err.message, /sk-\*\*\*\*bbbb/);
            return true;
        }
    );
    settings = {};
});

// ---------------------------------------------------------------------------
// 6. 取消令牌 → 立即抛出
// ---------------------------------------------------------------------------
console.log("取消");

await check("取消令牌 → 立即抛出，不轮换", async () => {
    settings = { transientRetryTimes: 0 };
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    const tried = [];
    const cancelledToken = { isCancellationRequested: true, onCancellationRequested: undefined };
    await assert.rejects(() =>
        runKeyRotationLoop({
            secrets,
            token: cancelledToken,
            abortController: new AbortController(),
            apiMode: "openai",
            execute: async (apiKey) => {
                tried.push(apiKey);
                throw apiError(402, "余额不足");
            },
        })
    );
    assert.deepEqual(tried, ["a"]); // 只试了一次
    settings = {};
});

// ---------------------------------------------------------------------------
// 7. single 模式 + 余额不足 → 降级 rotation
// ---------------------------------------------------------------------------
console.log("single 模式 fallback");

await check("single + 余额不足 → 降级 rotation 切换", async () => {
    settings = { apiKeyMode: "single", singleKeyFallback: "switch", transientRetryTimes: 0 };
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")], 0);
    const tried = [];
    let switched = false;
    await runKeyRotationLoop({
        secrets,
        token: noToken,
        abortController: new AbortController(),
        apiMode: "openai",
        onFallbackSwitch: () => {
            switched = true;
        },
        execute: async (apiKey) => {
            tried.push(apiKey);
            if (apiKey === "a") {
                throw apiError(402, '{"error":{"message":"余额不足"}}');
            }
        },
    });
    assert.deepEqual(tried, ["a", "b"]);
    assert.equal(switched, true);
    // activeIndex 已移到 b
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys[store.activeIndex].value, "b");
    settings = {};
});

Module._load = originalLoad;
console.log(`\nrotation: ${passed} checks passed`);
