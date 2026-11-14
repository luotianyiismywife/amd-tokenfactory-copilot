/**
 * Key 可用性检测测试（`src/keys/availability.ts` 的 `testKeyAvailability`）。
 *
 * 判定规则（明确、可预期）：
 *   2xx            → 可用
 *   401            → 不可用（invalid）
 *   402 / 余额不足  → 不可用（balance）
 *   429            → 可用（鉴权已通过，只是模型并发/限流）
 *   其他           → 无法确认（ok: null）
 *
 * 核心回归（2026-11-14 实测定位）：测试模型不能只取 `/v1/models` 的第一个。
 * 列表第一个通常是平台最热门模型（`DeepSeek-V4.1-Flash`），长期 429
 * （`at its concurrency limit (192)`），会让可用 key 永远落到"无法确认"。
 * 现按候选列表依次尝试：429 / 400(model not supported) / 404 / 5xx 换下一个，
 * 全部 429 时按可用处理。
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-availability.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {
    env: { language: "en" },
    workspace: {
        getConfiguration: () => ({ get: (key, fallback) => fallback }),
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

const { testKeyAvailability } = require("../out/keys/availability.js");
const { getApiModelIds } = require("../out/models/apiModelList.js");
const { logger } = require("../out/core/logger.js");
logger.init();

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
}

const KEY = "rc-test-key";
const originalFetch = globalThis.fetch;

/**
 * 预热 `/v1/models` 缓存（`testKeyAvailability` 的候选模型来自该缓存）。
 * 缓存 TTL 5 分钟，本测试进程内只需预热一次。
 */
async function primeModelCache(ids) {
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
            data: ids.map((id) => ({
                id,
                architecture: { input_modalities: ["text"], output_modalities: ["text"] },
                context_length: 131072,
            })),
        }),
        text: async () => "",
    });
    const cached = await getApiModelIds("prime");
    assert.deepEqual([...cached], ids, "模型缓存预热失败");
}

/** 按 model → 状态码 的映射伪造 fetch，返回被请求过的模型顺序。 */
function stubChatFetch(byModel) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body.model);
        const status = byModel[body.model] ?? 500;
        const text =
            status === 402
                ? '{"detail":"INSUFFICIENT_BALANCE"}'
                : status === 401
                  ? '{"detail":"Invalid bearer token"}'
                  : status === 429
                    ? '{"detail":{"error":{"message":"at its concurrency limit (192)"}}}'
                    : status === 400
                      ? '{"error":{"message":"Requested model not supported"}}'
                      : "{}";
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: String(status),
            text: async () => text,
        };
    };
    return calls;
}

const MODELS = ["DeepSeek-V4.1-Flash", "DeepSeek-V4-Flash", "GLM-5.3-Flash"];
await primeModelCache(MODELS);

// ---------------------------------------------------------------------------
// 1. 直接判定
// ---------------------------------------------------------------------------
console.log("直接判定");

await check("200 → 可用", async () => {
    stubChatFetch({ "DeepSeek-V4.1-Flash": 200 });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: true });
});

await check("401 → 不可用（invalid）", async () => {
    stubChatFetch({ "DeepSeek-V4.1-Flash": 401 });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: false, reason: "invalid" });
});

await check("402 → 不可用（balance）", async () => {
    stubChatFetch({ "DeepSeek-V4.1-Flash": 402 });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: false, reason: "balance" });
});

await check("500 → 无法确认", async () => {
    stubChatFetch({ "DeepSeek-V4.1-Flash": 500 });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: null, reason: "network" });
});

await check("网络错误 → 无法确认", async () => {
    globalThis.fetch = async () => {
        throw new Error("fetch failed");
    };
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: null, reason: "network" });
});

// ---------------------------------------------------------------------------
// 2. 候选模型回退（核心回归）
// ---------------------------------------------------------------------------
console.log("候选模型回退");

await check("首个模型 429 → 换下一个模型拿到 200 → 可用", async () => {
    const calls = stubChatFetch({
        "DeepSeek-V4.1-Flash": 429,
        "DeepSeek-V4-Flash": 200,
    });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: true });
    assert.ok(calls.length >= 2, "应尝试至少两个候选模型");
    assert.notEqual(calls[0], calls[1], "第二个候选模型应与第一个不同");
});

await check("首个模型 400(model not supported) → 换下一个模型拿到 200 → 可用", async () => {
    const calls = stubChatFetch({
        "DeepSeek-V4.1-Flash": 400,
        "DeepSeek-V4-Flash": 200,
    });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: true });
    assert.ok(calls.length >= 2);
});

await check("全部候选 429 → 可用（rateLimited，鉴权已通过）", async () => {
    globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: async () => '{"detail":{"error":{"message":"at its concurrency limit (192)"}}}}',
    });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: true, reason: "rateLimited" });
});

await check("首个 429 后遇到 401 → 不可用（401 是确定性结论）", async () => {
    stubChatFetch({
        "DeepSeek-V4.1-Flash": 429,
        "DeepSeek-V4-Flash": 401,
    });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: false, reason: "invalid" });
});

await check("首个 429 后遇到 402 → 不可用（余额）", async () => {
    stubChatFetch({
        "DeepSeek-V4.1-Flash": 429,
        "DeepSeek-V4-Flash": 402,
    });
    assert.deepEqual(await testKeyAvailability({ value: KEY }), { ok: false, reason: "balance" });
});

globalThis.fetch = originalFetch;
Module._load = originalLoad;
console.log(`\nkey availability: ${passed} checks passed`);
