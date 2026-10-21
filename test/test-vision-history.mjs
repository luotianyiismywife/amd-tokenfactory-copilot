import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
    deserializeVisionToolHistory,
    serializeVisionToolHistory,
    toAnthropicVisionToolMessages,
    toOpenAIVisionToolMessages,
} from "../out/vision/historyCodec.js";

const entry = {
    id: "call_vision_1",
    name: "ask_image",
    args: { imageIndex: 0, query: "What does this screenshot show?" },
    result: "It shows a settings dialog.",
    reasoningContent: "I need to inspect the attached screenshot.",
};

assert.deepEqual(deserializeVisionToolHistory(serializeVisionToolHistory(entry)), entry);
assert.deepEqual(toOpenAIVisionToolMessages(entry), [
    {
        role: "assistant",
        reasoning_content: entry.reasoningContent,
        tool_calls: [
            {
                id: entry.id,
                type: "function",
                function: { name: entry.name, arguments: JSON.stringify(entry.args) },
            },
        ],
    },
    { role: "tool", tool_call_id: entry.id, content: entry.result },
]);
assert.deepEqual(toAnthropicVisionToolMessages(entry), [
    {
        role: "assistant",
        content: [{ type: "tool_use", id: entry.id, name: entry.name, input: entry.args }],
    },
    {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: entry.id, content: entry.result }],
    },
]);
assert.equal(deserializeVisionToolHistory(new TextEncoder().encode("not-json")), null);
assert.equal(
    deserializeVisionToolHistory(new TextEncoder().encode(JSON.stringify({ version: 1, entry: { ...entry, result: 42 } }))),
    null
);

// Exercise both API converters with a minimal VS Code runtime shim. This
// proves the persisted response DataPart is consumed on the next turn and
// becomes the provider-specific standard tool exchange.
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
class ToolCallPart { }
class ToolResultPart { }
class ThinkingPart { }
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

try {
    const { createVisionToolHistoryPart } = require("../out/vision/historyPart.js");
    const { OpenaiApi } = require("../out/api/openai/openaiApi.js");
    const { AnthropicApi } = require("../out/api/anthropic/anthropicApi.js");
    const persistedPart = createVisionToolHistoryPart(entry);
    const nextTurnMessages = [
        { role: 2, content: [new TextPart("The previous answer."), persistedPart] },
        { role: 1, content: [new TextPart("Now continue.")] },
    ];

    const openaiMessages = await new OpenaiApi("test").convertMessages(nextTurnMessages, {
        includeReasoningInRequest: true,
        vision: false,
    });
    assert.deepEqual(openaiMessages.slice(0, 3), [
        {
            role: "assistant",
            reasoning_content: entry.reasoningContent,
            tool_calls: [{
                id: entry.id,
                type: "function",
                function: { name: entry.name, arguments: JSON.stringify(entry.args) },
            }],
        },
        { role: "tool", tool_call_id: entry.id, content: entry.result },
        // The provider always round-trips reasoning_content on assistant messages
        // when includeReasoningInRequest is true (DeepSeek requires the field on
        // every assistant message; empty string satisfies the presence check).
        { role: "assistant", content: "The previous answer.", reasoning_content: "" },
    ]);

    const anthropicMessages = await new AnthropicApi("test").convertMessages(nextTurnMessages, {
        includeReasoningInRequest: true,
        vision: false,
    });
    assert.deepEqual(anthropicMessages.slice(0, 3), [
        {
            role: "assistant",
            content: [{ type: "tool_use", id: entry.id, name: entry.name, input: entry.args }],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: entry.id, content: entry.result }],
        },
        { role: "assistant", content: [{ type: "text", text: "The previous answer." }] },
    ]);

    // A tool-call assistant message WITHOUT any reasoning parts must still carry
    // reasoning_content (empty string) when includeReasoningInRequest is true —
    // DeepSeek thinking mode requires the field on every assistant message that
    // follows a tool call; omitting it triggers a 400 on subsequent requests.
    const toolCallPart = new ToolCallPart();
    toolCallPart.callId = "call_tool_1";
    toolCallPart.name = "runTests";
    toolCallPart.input = {};
    const toolOnlyMessages = [
        { role: 2, content: [toolCallPart] },
        { role: 1, content: [new TextPart("tests passed")] },
    ];
    const openaiToolOnly = await new OpenaiApi("test").convertMessages(toolOnlyMessages, {
        includeReasoningInRequest: true,
        vision: false,
    });
    assert.deepEqual(openaiToolOnly[0], {
        role: "assistant",
        reasoning_content: "",
        tool_calls: [
            {
                id: "call_tool_1",
                type: "function",
                function: { name: "runTests", arguments: "{}" },
            },
        ],
    });
} finally {
    Module._load = originalLoad;
}

console.log("vision history codec: ok");
