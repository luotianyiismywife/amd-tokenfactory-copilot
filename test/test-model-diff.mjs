/**
 * 对比内置模型清单与实际 API 模型列表（`/v1/models`）。
 *
 * 内置清单**直接从编译产物读取**（`out/models/models.js` 的 `getBuiltInModelIds()`），
 * 因此永远不会与源码脱节——无需在此维护第二份模型列表。
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-model-diff.mjs <API_KEY>
 *      或设置环境变量 PROVIDER_API_KEY
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim（models.js 会读配置）──
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return { workspace: { getConfiguration: () => ({ get: (_k, f) => f }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const KEY = process.argv[2] || process.env.PROVIDER_API_KEY;
if (!KEY) {
    console.error("用法：node test/test-model-diff.mjs <API_KEY>");
    console.error("  或：PROVIDER_API_KEY=<key> node test/test-model-diff.mjs");
    process.exit(1);
}

const { getBuiltInModelIds } = require("../out/models/models.js");
const builtIn = [...getBuiltInModelIds()];

// AMD TokenFactory /v1/models 真实地址（脚手架遗留的 api.example.com 已替换）。
const r = await fetch("https://developer.amd.com.cn/radeon/api/v1/models", {
    headers: { Authorization: `Bearer ${KEY}` },
});
if (!r.ok) {
    console.error(`API error: [${r.status}] ${r.statusText}`);
    process.exit(1);
}
const d = await r.json();
// AMD 的 /v1/models 返回 { data: [...] }，无 mode 字段。
// 非 chat 端点过滤：architecture.output_modalities 不含 text 或 context_length <= 0。
const llm = (d.data ?? []).filter((m) => {
    const out = m.architecture?.output_modalities ?? [];
    const ctx = typeof m.context_length === "number" ? m.context_length : undefined;
    return out.includes("text") && (ctx === undefined || ctx > 0);
});
const apiIds = llm.map((m) => m.id);

console.log(`内置模型 ${builtIn.length} 个，API 返回 chat 模型 ${apiIds.length} 个\n`);

console.log("=== 内置但 API 不存在（死代码，会被自动发现过滤隐藏）===");
console.log(builtIn.filter((u) => !apiIds.includes(u)).join("\n") || "(none)");

console.log("\n=== API 有但无内置定义（走自动发现 + models.dev 规格）===");
console.log(apiIds.filter((i) => !builtIn.includes(i)).join("\n") || "(none)");

console.log("\n=== 两者交集（内置定义仍有效）===");
console.log(apiIds.filter((i) => builtIn.includes(i)).join("\n") || "(none)");

console.log("\n=== API 模型能力（input_modalities / vision / tools / reasoning）===");
for (const m of llm) {
    const input = m.architecture?.input_modalities ?? [];
    const p0 = m.providers?.[0] ?? {};
    console.log(
        `${m.id}: input=[${input.join(",")}] vision=${p0.vision ?? "-"} tools=${p0.tools ?? "-"} reasoning=${p0.reasoning ?? "-"} ctx=${m.context_length ?? "-"}`
    );
}
