#!/usr/bin/env node

/**
 * 探测 AMD TokenFactory 各 chat 模型的 reasoning_effort 档位支持范围。
 *
 * 平台 `/v1/models` 与 models.dev 都不返回具体档位列表（只给"是否支持
 * reasoning_effort"的布尔标记），档位范围只能实测（发请求看 200/400）确定。
 * 本脚本对每个 chat 模型 × 每个档位发一个最小请求，输出支持矩阵。
 *
 * 探测结果用于更新 `src/models/models.ts` 的 `supportedReasoningEfforts` /
 * `defaultReasoningEffort`（唯一手工维护处，见 AGENTS.md §4.6）。
 *
 * Usage:
 *   node scripts/dev/probe-reasoning-efforts.mjs [--api-key <key>]
 *   PROVIDER_API_KEY=<key> node scripts/dev/probe-reasoning-efforts.mjs
 *
 * ⚠️ 每个请求消耗额度（AMD 每天 $1/账号）。10 模型 × 7 档位 = 70 请求，
 * 建议在额度充足时运行，或先跑 `--models` 子集。
 *
 * Options:
 *   --models <id1,id2,...>   只探测指定模型（默认全部 chat 模型）
 *   --efforts <e1,e2,...>    只探测指定档位（默认 none/low/medium/high/xhigh/max/minimal）
 *   --gap-ms <n>             请求间隔（默认 1200ms，避免并发限流）
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ⚠️ 移植对接点：API 根地址与 models.ts 路径。
// 地址应与 src/platform/platformConfig.ts 的 API_BASE_URL 一致。
const API_BASE_URL = "https://developer.amd.com.cn/radeon/api/v1/";
const MODELS_TS_PATH = fileURLToPath(new URL("../../src/models/models.ts", import.meta.url));
const API_KEY_ENV = "PROVIDER_API_KEY";

const ALL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "minimal"];

// ── CLI 解析 ──

function parseArgs(argv) {
    const args = { models: null, efforts: null, gapMs: 1200 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--api-key") args.apiKey = argv[++i];
        else if (a === "--models") args.models = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        else if (a === "--efforts") args.efforts = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        else if (a === "--gap-ms") args.gapMs = Number(argv[++i]) || 1200;
    }
    return args;
}

// ── Helpers ──

function extractModelsFromBuiltIn(fileContent) {
    const ids = [];
    const regex = /\{\s*baseId:\s*"([^"]+)"/g;
    let match;
    while ((match = regex.exec(fileContent)) !== null) {
        ids.push(match[1]);
    }
    return [...new Set(ids)].sort();
}

function extractChatModelsFromApi(data) {
    return (data ?? []).filter((m) => {
        const out = m.architecture?.output_modalities ?? [];
        const ctx = typeof m.context_length === "number" ? m.context_length : undefined;
        return out.includes("text") && (ctx === undefined || ctx > 0);
    }).map((m) => m.id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 主流程 ──

const args = parseArgs(process.argv.slice(2));
const apiKey = args.apiKey || process.env[API_KEY_ENV];
if (!apiKey) {
    console.error(`用法: node scripts/dev/probe-reasoning-efforts.mjs --api-key <key>`);
    console.error(`  或: ${API_KEY_ENV}=<key> node scripts/dev/probe-reasoning-efforts.mjs`);
    process.exit(1);
}

// 1. 拉 /v1/models 拿 chat 模型列表
const modelsResp = await fetch(`${API_BASE_URL.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
});
if (!modelsResp.ok) {
    console.error(`/v1/models 失败: [${modelsResp.status}] ${modelsResp.statusText}`);
    process.exit(1);
}
const modelsData = await modelsResp.json();
const apiChatModels = extractChatModelsFromApi(modelsData.data);

// 2. 内置清单模型（兜底：API 失败时用内置清单）
const builtInModels = extractModelsFromBuiltIn(readFileSync(MODELS_TS_PATH, "utf8"));

// 3. 确定要探测的模型
const targetModels = args.models ?? [...new Set([...apiChatModels, ...builtInModels])].sort();
const targetEfforts = args.efforts ?? ALL_EFFORTS;

console.log(`探测模型 (${targetModels.length}): ${targetModels.join(", ")}`);
console.log(`探测档位 (${targetEfforts.length}): ${targetEfforts.join(", ")}`);
console.log(`请求间隔: ${args.gapMs}ms\n`);

// 4. 逐模型 × 逐档位发最小请求
const results = {};
let total = 0;
let okCount = 0;
let quotaExhausted = false;

for (const model of targetModels) {
    const ok = [];
    const bad = [];
    for (const effort of targetEfforts) {
        total++;
        const r = await fetch(`${API_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: "hi" }],
                stream: false,
                max_tokens: 8,
                reasoning_effort: effort,
            }),
        });
        if (r.ok) {
            ok.push(effort);
            okCount++;
        } else {
            const text = await r.text();
            if (text.includes("Daily usage limit exceeded") || text.includes("rate_limit_exceeded")) {
                quotaExhausted = true;
                bad.push(`${effort}(额度耗尽)`);
            } else {
                bad.push(`${effort}(400)`);
            }
        }
        await sleep(args.gapMs);
    }
    results[model] = { ok, bad };
    console.log(`${model}: ok=[${ok.join(",")}] bad=[${bad.join(",")}]`);
}

// 5. 汇总
console.log(`\n=== 汇总: ${okCount}/${total} 请求成功 ===`);
if (quotaExhausted) {
    console.log("⚠️ 检测到额度耗尽（Daily usage limit exceeded）——部分结果不可靠，请额度重置后重跑。");
}

// 6. 输出 models.ts 更新建议
console.log("\n=== models.ts supportedReasoningEfforts 更新建议 ===");
for (const model of targetModels) {
    const { ok } = results[model] ?? { ok: [] };
    if (ok.length === 0) {
        console.log(`  ${model}: 全部 400（可能额度问题或模型不支持 reasoning_effort）`);
        continue;
    }
    // 默认档位：优先 xhigh（Qwen3.8 系列），否则 high
    const defaultEffort = ok.includes("xhigh") ? "xhigh" : ok.includes("high") ? "high" : ok[ok.length - 1];
    console.log(`  ${model}: supportedReasoningEfforts: [${ok.map((e) => `"${e}"`).join(", ")}], defaultReasoningEffort: "${defaultEffort}"`);
}