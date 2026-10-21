import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Verifies splitToolCallArguments() reassembles concatenated parallel tool-call
// JSON, and parseToolCallArguments() tolerant parsing. Regression (issue #2):
// SenseAudio-style streaming tool_calls drop `id` on argument fragments, so
// fragments of several parallel calls could merge into one buffer; the split
// fallback recovers them instead of throwing "Invalid JSON for tool call".

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim（utils.ts 顶层 import vscode） ──
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {
	workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
};
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeShim;
	}
	return originalLoad.call(this, request, parent, isMain);
};

const { splitToolCallArguments, parseToolCallArguments } = require("../out/core/utils.js");

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ── splitToolCallArguments ──
check("两个拼接的顶层 JSON 对象", () => {
	assert.deepEqual(splitToolCallArguments('{"tool":"a"}{"tool":"b"}'), [{ tool: "a" }, { tool: "b" }]);
});

check("三个拼接的顶层 JSON 对象", () => {
	assert.deepEqual(splitToolCallArguments('{"a":1}{"b":2}{"c":3}'), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

check("嵌套花括号不误拆", () => {
	assert.deepEqual(splitToolCallArguments('{"a":{"b":1}}{"c":2}'), [{ a: { b: 1 } }, { c: 2 }]);
});

check("字符串内的 { } 不误拆", () => {
	assert.deepEqual(splitToolCallArguments('{"a":"{ not a brace }"}{"b":2}'), [
		{ a: "{ not a brace }" },
		{ b: 2 },
	]);
});

check("转义引号不误拆", () => {
	assert.deepEqual(splitToolCallArguments('{"a":"say \\"hi\\""}{"b":2}'), [{ a: 'say "hi"' }, { b: 2 }]);
});

check("markdown 围栏被剥离", () => {
	assert.deepEqual(splitToolCallArguments('```json\n{"a":1}{"b":2}\n```'), [{ a: 1 }, { b: 2 }]);
});

check("空输入返回空数组", () => {
	assert.deepEqual(splitToolCallArguments(""), []);
});

check("纯空白返回空数组", () => {
	assert.deepEqual(splitToolCallArguments("   "), []);
});

check("单个 JSON 返回单元素数组", () => {
	assert.deepEqual(splitToolCallArguments('{"a":1}'), [{ a: 1 }]);
});

check("残缺片段被丢弃", () => {
	assert.deepEqual(splitToolCallArguments('{"a":1}{"b":'), [{ a: 1 }]);
});

// ── parseToolCallArguments ──
check("parseToolCallArguments：拼接串返回 undefined（需 split 兜底）", () => {
	assert.equal(parseToolCallArguments('{"a":1}{"b":2}'), undefined);
});

check("parseToolCallArguments：剥围栏", () => {
	assert.deepEqual(parseToolCallArguments('```json\n{"a":1}\n```'), { a: 1 });
});

check("parseToolCallArguments：剥首尾杂质", () => {
	assert.deepEqual(parseToolCallArguments('here you go: {"a":1} done'), { a: 1 });
});

check("parseToolCallArguments：空串 → {}", () => {
	assert.deepEqual(parseToolCallArguments(""), {});
});

check("parseToolCallArguments：undefined → {}", () => {
	assert.deepEqual(parseToolCallArguments(undefined), {});
});

check("parseToolCallArguments：尾逗号修复", () => {
	assert.deepEqual(parseToolCallArguments('{"a":1,}'), { a: 1 });
});

check("parseToolCallArguments：中文智能引号修复", () => {
	assert.deepEqual(parseToolCallArguments('{\u201ca\u201d:1}'), { a: 1 });
});

check("parseToolCallArguments：未闭合括号补全", () => {
	assert.deepEqual(parseToolCallArguments('{"a":1'), { a: 1 });
});

console.log(`\nsplit tool call args: ${passed} checks passed`);
Module._load = originalLoad;
