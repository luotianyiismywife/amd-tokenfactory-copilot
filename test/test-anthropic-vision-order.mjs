import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Verifies AnthropicApi.convertMessages() emits buffered tool results BEFORE a
// restored vision-history pair. Regression: the vision-history push ran before
// flushPendingToolResults(), so when a pure-tool-result user message was
// buffered and the next assistant message carried a vision-history DataPart,
// the output order became [vision tool_use/result] then [pending tool results]
// — the pending results answer an EARLIER assistant tool_use, so they must come
// first (Anthropic rejects tool_result blocks that do not immediately follow
// their tool_use).

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

class DataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}
class TextPart {
	constructor(value) {
		this.value = value;
	}
}
class ToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class ToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}
class ThinkingPart {}
const vscodeShim = {
	LanguageModelDataPart: DataPart,
	LanguageModelTextPart: TextPart,
	LanguageModelToolCallPart: ToolCallPart,
	LanguageModelToolResultPart: ToolResultPart,
	LanguageModelThinkingPart: ThinkingPart,
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
};
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeShim;
	}
	return originalLoad.call(this, request, parent, isMain);
};

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

try {
	const { serializeVisionToolHistory, VISION_TOOL_HISTORY_MIME } = require("../out/vision/historyCodec.js");
	const { AnthropicApi } = require("../out/api/anthropic/anthropicApi.js");

	// Vision-history DataPart payload (as emitted by the provider in a prior turn).
	const historyEntry = {
		id: "call_vision_1",
		name: "ask_image",
		args: { imageIndex: 0, query: "what is shown?" },
		result: "a settings dialog",
	};
	const historyPart = new DataPart(serializeVisionToolHistory(historyEntry), VISION_TOOL_HISTORY_MIME);

	// Sequence: assistant tool_use (native) → user tool_result (buffered) →
	// assistant message carrying the vision-history DataPart.
	const messages = [
		{
			role: 2, // assistant
			content: [new ToolCallPart("call_native_1", "read_file", { path: "a.ts" })],
		},
		{
			role: 1, // user
			content: [new ToolResultPart("call_native_1", [new TextPart("file contents")])],
		},
		{
			role: 2, // assistant
			content: [historyPart, new TextPart("Here is the answer.")],
		},
	];

	const api = new AnthropicApi("test-model");
	const out = api.convertMessages(messages, { includeReasoningInRequest: false, vision: false });

	check("缓冲的工具结果先于视觉历史输出", () => {
		// Find the index of the buffered native tool_result and the vision tool_use.
		const nativeResultIdx = out.findIndex(
			(m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "call_native_1")
		);
		const visionToolUseIdx = out.findIndex(
			(m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.id === "call_vision_1")
		);
		assert.ok(nativeResultIdx >= 0, "应包含原生 tool_result");
		assert.ok(visionToolUseIdx >= 0, "应包含视觉 tool_use");
		assert.ok(
			nativeResultIdx < visionToolUseIdx,
			`原生 tool_result (idx=${nativeResultIdx}) 必须先于视觉 tool_use (idx=${visionToolUseIdx})`
		);
	});

	check("视觉 tool_use 紧跟其 tool_result", () => {
		const visionToolUseIdx = out.findIndex(
			(m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.id === "call_vision_1")
		);
		const visionResultIdx = out.findIndex(
			(m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "call_vision_1")
		);
		assert.equal(visionResultIdx, visionToolUseIdx + 1, "视觉 tool_result 必须紧随其 tool_use");
	});
} finally {
	Module._load = originalLoad;
}

console.log(`\nanthropic vision order: ${passed} checks passed`);
