/**
 * OpenAI function-call entry emitted by assistant messages.
 */
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 */
export interface OpenAIFunctionToolDef {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: object;
    };
}

/**
 * OpenAI-style chat message used for chat completion requests.
 */
export interface OpenAIChatMessage {
    role: OpenAIChatRole;
    content?: string | ChatMessageContent[];
    name?: string;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
}

/**
 * Chat message content interface (supports multimodal).
 */
export interface ChatMessageContent {
    type: "text" | "image_url";
    text?: string;
    image_url?: {
        url: string;
    };
}

/**
 * OpenAI-style chat roles.
 */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";
