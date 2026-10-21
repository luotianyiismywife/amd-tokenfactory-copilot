/**
 * 批量导入解析器测试（`src/commands/apiKeyFlows.ts` 的 `parseBatchImport`）。
 *
 * 格式：`key---备注;key---备注;`
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-batch-import.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {},
    QuickPickItemKind: { Separator: -1 },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { parseBatchImport } = require("../out/commands/apiKeyFlows.js");

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

// ── 基本条目 ──
check("单个完整条目", () => {
    assert.deepEqual(parseBatchImport("sk_a---work"), [{ value: "sk_a", label: "work" }]);
});

check("多个条目（分号分隔）", () => {
    assert.deepEqual(parseBatchImport("sk_a---work;sk_c---backup"), [
        { value: "sk_a", label: "work" },
        { value: "sk_c", label: "backup" },
    ]);
});

check("末尾分号被忽略", () => {
    assert.deepEqual(parseBatchImport("sk_a---work;"), [{ value: "sk_a", label: "work" }]);
});

// ── 空字段 ──
check("无备注（尾随分隔符）", () => {
    assert.deepEqual(parseBatchImport("sk_a---"), [{ value: "sk_a", label: undefined }]);
});

check("只有 key", () => {
    assert.deepEqual(parseBatchImport("sk_a"), [{ value: "sk_a", label: undefined }]);
});

// ── 空白与容错 ──
check("前后空白被裁剪", () => {
    assert.deepEqual(parseBatchImport("  sk_a --- work  "), [{ value: "sk_a", label: "work" }]);
});

check("空条目被跳过", () => {
    assert.deepEqual(parseBatchImport(";;sk_a---work;;"), [{ value: "sk_a", label: "work" }]);
});

check("缺 key 的条目被跳过", () => {
    assert.deepEqual(parseBatchImport("---work;sk_c---ok"), [{ value: "sk_c", label: "ok" }]);
});

check("空字符串返回空数组", () => {
    assert.deepEqual(parseBatchImport(""), []);
});

check("只有分隔符返回空数组", () => {
    assert.deepEqual(parseBatchImport(";;;"), []);
});

// ── 备注含分隔符 ──
check("备注中的 --- 被完整保留", () => {
    assert.deepEqual(parseBatchImport("sk_a---my---label"), [{ value: "sk_a", label: "my---label" }]);
});

// ── 混合场景 ──
check("混合：有备注 / 无备注", () => {
    assert.deepEqual(parseBatchImport("sk_a---work;sk_c---;sk_d"), [
        { value: "sk_a", label: "work" },
        { value: "sk_c", label: undefined },
        { value: "sk_d", label: undefined },
    ]);
});

console.log(`\nbatch import parser: ${passed} checks passed`);
