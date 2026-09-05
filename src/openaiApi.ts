import * as vscode from "vscode";
import {
    LanguageModelResponsePart,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelChatRequestMessage,
    Progress,
    CancellationToken,
} from "vscode";
import type { AmdModelItem } from "./types";
import type { StreamUsage } from "./types";
import { tryParseJSONObject } from "./utils";
import type { OpenAIChatMessage, OpenAIToolCall } from "./openaiTypes";

import {
    isImageMimeType,
    createDataUrl,
    isToolResultPart,
    convertToolsToOpenAI,
    mapRole,
    extractApiErrorMessage,
} from "./utils";

/**
 * OpenAI 兼容 API 实现：消息转换 / 请求体构建 / SSE 流式解析.
 *
 * AMD TokenFactory 的 /chat/completions 为标准 OpenAI Chat Completions 格式：
 * - 流式 delta 含 reasoning_content（思考内容，逐块输出）
 * - 支持 image_url 多模态输入（Vision 模型）
 * - 最后附加 usage 统计 chunk
 */
export class OpenaiApi {
    private _modelId: string;

    /** Buffer for assembling streamed tool calls by index. */
    private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map();

    /** Indices for which a tool call has been fully emitted. */
    private _completedToolCallIndices = new Set<number>();

    /** Track if we emitted any assistant text before seeing tool calls. */
    private _hasEmittedAssistantText = false;

    /** Track if we emitted the begin-tool-calls whitespace flush. */
    private _emittedBeginToolCallsHint = false;

    /** Finish/stop reason of the most recent stream (e.g. "length", "stop"). */
    private _lastFinishReason: string | undefined;

    // Thinking content state management
    private _currentThinkingId: string | null = null;
    private _thinkingBuffer = "";
    private _thinkingFlushTimer: NodeJS.Timeout | null = null;

    /** Callback for streaming usage updates (prompt/completion/cache tokens). */
    public onUsage: ((usage: StreamUsage) => void) | undefined;

    /** Finish/stop reason of the most recent stream, read by provider.ts. */
    public get lastFinishReason(): string | undefined {
        return this._lastFinishReason;
    }

    constructor(modelId: string) {
        this._modelId = modelId;
    }

    /**
     * Convert VS Code chat request messages into OpenAI-compatible message objects.
     */
    convertMessages(
        messages: readonly LanguageModelChatRequestMessage[],
        modelConfig: { includeReasoningInRequest: boolean; vision?: boolean }
    ): OpenAIChatMessage[] {
        const modelSupportsVision = modelConfig.vision !== false;
        const out: OpenAIChatMessage[] = [];

        for (const m of messages) {
            const role = mapRole(m);
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            const toolResults: { callId: string; content: string }[] = [];
            const reasoningParts: string[] = [];

            for (const part of m.content ?? []) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                    if (modelSupportsVision) {
                        imageParts.push(part);
                    } else {
                        // For non-vision models, replace image with a text note
                        textParts.push("\n[An image was attached, but this model cannot see images.]");
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    let args = "{}";
                    try {
                        args = JSON.stringify(part.input ?? {});
                    } catch {
                        args = "{}";
                    }
                    toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
                } else if (isToolResultPart(part)) {
                    const callId = (part as { callId?: string }).callId ?? "";
                    const toolContent = (part as { content?: ReadonlyArray<unknown> }).content;
                    const toolTexts: string[] = [];
                    if (toolContent) {
                        for (const inner of toolContent) {
                            if (inner instanceof vscode.LanguageModelTextPart) {
                                toolTexts.push(inner.value);
                            } else if (inner instanceof vscode.LanguageModelDataPart && isImageMimeType(inner.mimeType)) {
                                if (modelSupportsVision) {
                                    toolTexts.push(`[data:${inner.mimeType};base64 image from tool result]`);
                                } else {
                                    toolTexts.push("\n[An image was returned by a tool, but this model cannot see images.]");
                                }
                            } else if (inner && typeof (inner as { value?: unknown }).value === "string") {
                                // Stringify unknown text-bearing parts (best effort)
                                toolTexts.push(String((inner as { value: string }).value));
                            }
                        }
                    }
                    toolResults.push({ callId, content: toolTexts.join("\n") });
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    const content = Array.isArray(part.value) ? part.value.join("") : part.value;
                    reasoningParts.push(content);
                }
            }

            const joinedText = textParts.join("").trim();
            const joinedThinking = reasoningParts.join("").trim();

            // process assistant message
            if (role === "assistant") {
                const assistantMessage: OpenAIChatMessage = {
                    role: "assistant",
                };

                if (joinedText) {
                    assistantMessage.content = joinedText;
                }

                // DeepSeek-family thinking models require reasoning_content on EVERY
                // assistant message for round-tripping. VS Code does NOT re-send
                // LanguageModelThinkingPart in history messages, so reasoningParts is
                // usually empty on later turns; without the field the API may reject
                // the request with 400. Only sent when thinking is enabled in config.
                if (modelConfig.includeReasoningInRequest) {
                    assistantMessage.reasoning_content = joinedThinking;
                }

                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                }

                // Must have content or tool_calls — reasoning_content alone is rejected
                if (assistantMessage.content || assistantMessage.tool_calls) {
                    out.push(assistantMessage);
                }
            }

            // process tool result messages
            for (const tr of toolResults) {
                out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
            }

            // process user messages
            if (role === "user") {
                if (imageParts.length > 0) {
                    // multi-modal message
                    const contentArray: { type: "text" | "image_url"; text?: string; image_url?: { url: string } }[] = [];

                    if (joinedText) {
                        contentArray.push({ type: "text", text: joinedText });
                    }

                    for (const imagePart of imageParts) {
                        const dataUrl = createDataUrl(imagePart);
                        contentArray.push({
                            type: "image_url",
                            image_url: { url: dataUrl },
                        });
                    }
                    out.push({ role, content: contentArray });
                } else {
                    // text-only message
                    if (joinedText) {
                        out.push({ role, content: joinedText });
                    }
                }
            }

            // process system messages
            if (role === "system" && joinedText) {
                out.push({ role, content: joinedText });
            }
        }
        return out;
    }

    /**
     * Construct request body for the OpenAI-compatible API.
     */
    prepareRequestBody(
        rb: Record<string, unknown>,
        um: AmdModelItem | undefined,
        options?: ProvideLanguageModelChatResponseOptions
    ): Record<string, unknown> {
        // temperature
        if (um?.temperature !== undefined && um.temperature !== null) {
            rb.temperature = um.temperature;
        }

        // top_p
        if (um?.top_p !== undefined && um.top_p !== null) {
            rb.top_p = um.top_p;
        }

        // stop
        if (options?.modelOptions) {
            const mo = options.modelOptions as Record<string, unknown>;
            if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
                rb.stop = mo.stop;
            }
        }

        // tools
        const toolConfig = convertToolsToOpenAI(options);
        if (toolConfig.tools && toolConfig.tools.length > 0) {
            rb.tools = toolConfig.tools;
        }
        if (toolConfig.tool_choice) {
            rb.tool_choice = toolConfig.tool_choice;
        }

        return rb;
    }

    /**
     * Read and parse the SSE streaming response and report parts.
     */
    async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // Reset mutable state to prevent carryover from previous rounds
        this._resetStreamState();

        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let cancelDisposable: vscode.Disposable | undefined;

        // Immediately cancel the stream when user cancels, so reader.read() won't stay pending
        if (token.onCancellationRequested) {
            cancelDisposable = token.onCancellationRequested(() => {
                reader.cancel().catch(() => {});
            });
        }

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    break;
                }

                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data:")) {
                        continue;
                    }
                    const data = line.slice(5).trim();
                    if (data === "[DONE]") {
                        await this.flushToolCallBuffers(progress, false);
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);

                        // Capture usage from the final usage chunk (choices may be empty)
                        const usageData = parsed.usage as Record<string, unknown> | undefined;
                        if (usageData) {
                            let cacheHitTokens: number | undefined;
                            let cacheMissTokens: number | undefined;

                            // OpenAI format: prompt_tokens_details.cached_tokens
                            const details = usageData.prompt_tokens_details as Record<string, unknown> | undefined;
                            if (details && typeof details.cached_tokens === "number") {
                                cacheHitTokens = details.cached_tokens;
                                cacheMissTokens = ((usageData.prompt_tokens as number) ?? 0) - cacheHitTokens;
                            }

                            // DeepSeek format: prompt_cache_hit_tokens / prompt_cache_miss_tokens (overrides OpenAI)
                            if (typeof usageData.prompt_cache_hit_tokens === "number") {
                                cacheHitTokens = usageData.prompt_cache_hit_tokens as number;
                            }
                            if (typeof usageData.prompt_cache_miss_tokens === "number") {
                                cacheMissTokens = usageData.prompt_cache_miss_tokens as number;
                            }

                            this.onUsage?.({
                                promptTokens: (usageData.prompt_tokens as number) ?? 0,
                                completionTokens: (usageData.completion_tokens as number) ?? 0,
                                cacheHitTokens,
                                cacheMissTokens,
                            });
                        }

                        await this.processDelta(parsed, progress);
                    } catch (e) {
                        console.error("[AMD TokenFactory] Failed to parse SSE chunk:", e, "data:", data);
                    }
                }
            }
        } catch (e) {
            console.error("[AMD TokenFactory] Streaming response error:", e);
            throw e;
        } finally {
            cancelDisposable?.dispose();
            reader.releaseLock();
            this.reportEndThinking(progress);
        }
    }

    /**
     * Handle a single streamed delta chunk, emitting text and tool call parts.
     */
    private async processDelta(
        delta: Record<string, unknown>,
        progress: Progress<LanguageModelResponsePart>
    ): Promise<boolean> {
        let emitted = false;
        const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) {
            return false;
        }

        const deltaObj = choice.delta as Record<string, unknown> | undefined;

        // Process thinking content first (before regular text content).
        // AMD endpoint emits "reasoning_content" (null when absent) in delta.
        try {
            const maybeThinking =
                (deltaObj as Record<string, unknown> | undefined)?.reasoning_content ??
                (deltaObj as Record<string, unknown> | undefined)?.reasoning ??
                (choice as Record<string, unknown> | undefined)?.thinking;

            if (typeof maybeThinking === "string" && maybeThinking) {
                this.bufferThinkingContent(maybeThinking, progress);
                emitted = true;
            }
        } catch (e) {
            console.error("[AMD TokenFactory] Failed to process thinking content:", e);
        }

        if (deltaObj?.content) {
            const content = String(deltaObj.content);
            this.reportEndThinking(progress);
            if (content) {
                progress.report(new vscode.LanguageModelTextPart(content));
                this._hasEmittedAssistantText = true;
                emitted = true;
            }
        }

        if (deltaObj?.tool_calls) {
            this.reportEndThinking(progress);

            const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

            if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
                progress.report(new vscode.LanguageModelTextPart(" "));
                this._emittedBeginToolCallsHint = true;
            }

            for (const tc of toolCalls) {
                const idx = (tc.index as number) ?? 0;
                if (this._completedToolCallIndices.has(idx)) {
                    continue;
                }
                const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
                if (tc.id && typeof tc.id === "string") {
                    buf.id = tc.id as string;
                }
                const func = tc.function as Record<string, unknown> | undefined;
                if (func?.name && typeof func.name === "string") {
                    buf.name = func.name as string;
                }
                if (typeof func?.arguments === "string") {
                    buf.args += func.arguments as string;
                }
                this._toolCallBuffers.set(idx, buf);

                await this.tryEmitBufferedToolCall(idx, progress);
            }
        }

        const finish = (choice.finish_reason as string | undefined) ?? undefined;
        if (finish) {
            this._lastFinishReason = finish;
        }
        if (finish === "tool_calls" || finish === "stop") {
            await this.flushToolCallBuffers(progress, true);
        }
        return emitted;
    }

    /**
     * Try to emit a buffered tool call when a valid name and JSON arguments are available.
     */
    private async tryEmitBufferedToolCall(
        index: number,
        progress: Progress<LanguageModelResponsePart>
    ): Promise<void> {
        const buf = this._toolCallBuffers.get(index);
        if (!buf) {
            return;
        }
        if (!buf.name) {
            return;
        }
        const canParse = tryParseJSONObject(buf.args);
        if (!canParse.ok) {
            return;
        }
        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, canParse.value));
        this._toolCallBuffers.delete(index);
        this._completedToolCallIndices.add(index);
    }

    /**
     * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
     */
    private async flushToolCallBuffers(
        progress: Progress<LanguageModelResponsePart>,
        throwOnInvalid: boolean
    ): Promise<void> {
        if (this._toolCallBuffers.size === 0) {
            return;
        }
        for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
            const argsText = buf.args.trim() || "{}";
            const parsed = tryParseJSONObject(argsText);
            if (!parsed.ok) {
                if (throwOnInvalid) {
                    console.error("[AMD TokenFactory] Invalid JSON for tool call", {
                        idx,
                        snippet: (buf.args || "").slice(0, 200),
                    });
                    throw new Error("Invalid JSON for tool call");
                }
                continue;
            }
            const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = buf.name ?? "unknown_tool";
            progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
            this._toolCallBuffers.delete(idx);
            this._completedToolCallIndices.add(idx);
        }
    }

    /**
     * Reset mutable streaming state.
     */
    private _resetStreamState(): void {
        this._toolCallBuffers.clear();
        this._completedToolCallIndices.clear();
        this._hasEmittedAssistantText = false;
        this._lastFinishReason = undefined;
        this._emittedBeginToolCallsHint = false;
        this._currentThinkingId = null;
        this._thinkingBuffer = "";
        if (this._thinkingFlushTimer) {
            clearTimeout(this._thinkingFlushTimer);
            this._thinkingFlushTimer = null;
        }
    }

    /**
     * Report to VS Code for ending the current thinking block.
     */
    private reportEndThinking(progress: Progress<LanguageModelResponsePart>) {
        if (!this._currentThinkingId) {
            return;
        }
        try {
            this.flushThinkingBuffer(progress);
            progress.report(new vscode.LanguageModelThinkingPart("", this._currentThinkingId) as unknown as LanguageModelResponsePart);
        } catch (e) {
            console.error("[AMD TokenFactory] Failed to end thinking sequence:", e);
        }
        this._currentThinkingId = null;
        this._thinkingBuffer = "";
        if (this._thinkingFlushTimer) {
            clearTimeout(this._thinkingFlushTimer);
            this._thinkingFlushTimer = null;
        }
    }

    /**
     * Generate a unique thinking ID.
     */
    private generateThinkingId(): string {
        return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Buffer and schedule a flush for thinking content.
     */
    private bufferThinkingContent(text: string, progress: Progress<LanguageModelResponsePart>): void {
        if (!this._currentThinkingId) {
            this._currentThinkingId = this.generateThinkingId();
        }

        this._thinkingBuffer += text;

        if (!this._thinkingFlushTimer) {
            this._thinkingFlushTimer = setTimeout(() => {
                this.flushThinkingBuffer(progress);
            }, 100);
        }
    }

    /**
     * Flush the thinking buffer to the progress reporter.
     */
    private flushThinkingBuffer(progress: Progress<LanguageModelResponsePart>): void {
        if (this._thinkingFlushTimer) {
            clearTimeout(this._thinkingFlushTimer);
            this._thinkingFlushTimer = null;
        }

        if (this._thinkingBuffer && this._currentThinkingId) {
            const text = this._thinkingBuffer;
            this._thinkingBuffer = "";
            progress.report(new vscode.LanguageModelThinkingPart(text, this._currentThinkingId) as unknown as LanguageModelResponsePart);
        }
    }

    /**
     * Create a non-streaming-style chat message generator (for Git commit
     * generation). Streams the response and yields text chunks only
     * (reasoning_content is ignored).
     */
    async *createMessage(
        model: AmdModelItem,
        systemPrompt: string,
        messages: { role: string; content: string }[],
        baseUrl: string,
        apiKey: string,
        signal?: AbortSignal
    ): AsyncGenerator<{ type: "text"; text: string }> {
        const openaiMessages = [...messages];
        if (systemPrompt) {
            openaiMessages.unshift({ role: "system", content: systemPrompt });
        }

        const requestBody: Record<string, unknown> = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
        };

        const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            const message = extractApiErrorMessage(errorText);
            throw new Error(
                `API error: [${response.status}] ${response.statusText}${message ? ` ${message}` : ""}\nURL: ${url}`
            );
        }

        if (!response.body) {
            throw new Error("No response body from API");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Cancel the reader immediately when abort signal fires
        if (signal) {
            signal.addEventListener("abort", () => {
                reader.cancel().catch(() => {});
            });
        }

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data:")) {
                        continue;
                    }
                    const data = line.slice(5).trim();
                    if (data === "[DONE]") {
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0];
                        if (choice?.delta) {
                            const deltaObj = choice.delta as Record<string, unknown>;
                            const content = deltaObj.content as string | undefined;
                            if (content) {
                                yield { type: "text" as const, text: content };
                            }
                        }
                    } catch {
                        // Ignore malformed chunks
                    }
                }
            }
        } finally {
            try {
                reader.releaseLock();
            } catch {
                // already released
            }
        }
    }
}
