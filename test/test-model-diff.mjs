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

const r = await fetch("https://api.example.com/v1/models", {
    headers: { Authorization: `Bearer ${KEY}` },
});
if (!r.ok) {
    console.error(`API error: [${r.status}] ${r.statusText}`);
    process.exit(1);
}
const d = await r.json();
const llm = (d.data ?? []).filter((m) => m.mode === "llm");
const apiIds = llm.map((m) => m.id);

console.log(`内置模型 ${builtIn.length} 个，API 返回 llm 模型 ${apiIds.length} 个\n`);

console.log("=== 内置但 API 不存在（死代码，会被自动发现过滤隐藏）===");
console.log(builtIn.filter((u) => !apiIds.includes(u)).join("\n") || "(none)");

console.log("\n=== API 有但无内置定义（走自动发现 + models.dev 规格）===");
console.log(apiIds.filter((i) => !builtIn.includes(i)).join("\n") || "(none)");

console.log("\n=== 两者交集（内置定义仍有效）===");
console.log(apiIds.filter((i) => builtIn.includes(i)).join("\n") || "(none)");

console.log("\n=== API 模型协议能力 ===");
for (const m of llm) {
    console.log(`${m.id}: ${(m.protocols || []).join(",")}`);
}
