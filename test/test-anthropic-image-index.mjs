import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Verifies AnthropicApi.convertMessages() assigns image indices INLINE in part
// order, matching collectLocalImages storage order. Regression: indices were
// assigned AFTER the part loop, so a message mixing an image DataPart with a
// text data-URI image produced indices that did not match the stored order —
// the model asked about "image N" and got a different image.

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
class ToolCallPart {}
class ToolResultPart {}
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

// 1x1 PNG bytes.
const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_DATA_URI =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

try {
	const { AnthropicApi } = require("../out/api/anthropic/anthropicApi.js");

	check("混排：文本 data-URI 先占 index 0，DataPart 图片得 index 1（按 part 顺序）", () => {
		const messages = [
			{
				role: 1, // user
				content: [new TextPart(`look at ${PNG_DATA_URI}`), new DataPart(PNG_BYTES, "image/png")],
			},
		];
		const api = new AnthropicApi("test-model");
		const out = api.convertMessages(messages, { includeReasoningInRequest: false, vision: false });
		const blocks = out[0].content;
		const textBlocks = blocks.filter((b) => b.type === "text");
		// joinedText (with the data-URI reference) is first, then the DataPart reference.
		assert.ok(textBlocks[0].text.includes("imageIndex=0"), "文本 data-URI 应为 index 0");
		assert.ok(textBlocks[1].text.includes("imageIndex=1"), "DataPart 图片应为 index 1");
	});

	check("纯 DataPart 图片：index 从 0 开始", () => {
		const messages = [{ role: 1, content: [new DataPart(PNG_BYTES, "image/png")] }];
		const api = new AnthropicApi("test-model");
		const out = api.convertMessages(messages, { includeReasoningInRequest: false, vision: false });
		const textBlocks = out[0].content.filter((b) => b.type === "text");
		assert.ok(textBlocks[0].text.includes("imageIndex=0"));
	});
} finally {
	Module._load = originalLoad;
}

console.log(`\nanthropic image index: ${passed} checks passed`);
