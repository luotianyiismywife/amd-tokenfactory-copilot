import * as vscode from "vscode";
import {
    LanguageModelResponsePart,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelChatRequestMessage,
    LanguageModelToolCallPart,
    LanguageModelThinkingPart,
    Progress,
    CancellationToken,
} from "vscode";
import { ProviderModelItem } from "../core/types";
import { isImageMimeType, isToolResultPart, storeDataUriImages, parseToolCallArguments, splitToolCallArguments } from "../core/utils";
import { VersionManager } from "../core/versionManager";
import type { InterceptedToolCall, StoredImage } from "../vision/types";
import { ASK_IMAGE_TOOL_NAME, ASK_WITH_MULTI_IMAGE_TOOL_NAME } from "../vision/types";
import { consumeSseStream } from "./sse";

/**
 * Token usage information extracted from streaming response usage chunk.
 */
export interface StreamUsage {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
}

export abstract class CommonApi<TMessage, TRequestBody> {
    /** Buffer for assembling streamed tool calls by `key` (id / index / auto). */
    protected _toolCallBuffers: Map<string, { id?: string; name?: string; args: string }> = new Map<
        string,
        { id?: string; name?: string; args: string }
    >();

    /** Keys for which a tool call has been fully emitted. */
    protected _completedToolCallIndices = new Set<string>();

    /** Key of the most recently buffered tool call (fallback for chunks without id/index). */
    protected _lastToolCallKey: string | undefined;

    /** Maps stream `index` → tool-call `id` seen in the same call. OpenAI-compatible
     *  endpoints emit each tool call's first chunk with `{index, id, name}` and later
     *  argument fragments with only `{index, arguments}` (no id). Without this map, the
     *  id-carrying chunk goes to the id bucket while argument fragments go to a separate
     *  index bucket, so neither bucket ever has both name and args. Resolving index → id
     *  keeps every fragment of one parallel call in the same bucket. */
    protected _indexToId = new Map<string, string>();

    /** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
    protected _hasEmittedAssistantText = false;

    /** Finish/stop reason of the most recent stream (e.g. "length", "max_tokens"),
     *  used to detect budget exhaustion with zero answer text. */
    protected _lastFinishReason: string | undefined;

    /** Track if we emitted the begin-tool-calls whitespace flush. */
    protected _emittedBeginToolCallsHint = false;

    /** Finish/stop reason of the most recent stream (e.g. "length", "max_tokens").
     *  Read by provider.ts to detect budget exhaustion with zero answer text. */
    public get lastFinishReason(): string | undefined {
        return this._lastFinishReason;
    }

    // XML think block parsing state
    protected _xmlThinkActive = false;

    // Thinking content state management
    protected _currentThinkingId: string | null = null;

    /** Buffer for accumulating thinking content before emitting. */
    protected _thinkingBuffer = "";

    /** Timer for delayed flushing of thinking buffer. */
    protected _thinkingFlushTimer: NodeJS.Timeout | null = null;

    /** System prompts to include in requests. */
    protected _systemContent: string | undefined;

    /** Set the model ID for logging purposes. */
    protected _modelId = "";

    /** Callback for streaming usage updates (prompt/completion/cache tokens). */
    public _onUsage: ((usage: StreamUsage) => void) | undefined;

    public set onUsage(callback: ((usage: StreamUsage) => void) | undefined) {
        this._onUsage = callback;
    }

    /**
     * When an ask_image tool call is intercepted during streaming,
     * this holds the parsed tool call info for the provider to handle.
     */
    public interceptedToolCall: InterceptedToolCall | null = null;

    /**
     * Captures the reasoning_content from the streaming response so it can be
     * echoed back in the next round's assistant message. DeepSeek thinking mode
     * requires the original reasoning_content to be passed back verbatim.
     * Reset to "" at the start of each streaming round.
     */
    public _capturedReasoningContent: string = "";

    /**
     * Locally stored images collected during convertMessages.
     * Lives on the instance only — no global Map, automatically GC'd.
     */
    protected _localImages: StoredImage[] = [];

    /**
     * Whether images were found during convertMessages (non-vision models only).
     * Drives ask_image / ask_with_multi_image tool injection in prepareRequestBody.
     */
    protected _hasImages = false;

    /**
     * Store the converted API messages so the provider can reference them
     * when building the second round (tool call + result) request.
     * Protocol-specific shape (OpenAI / Anthropic), hence `unknown[]`.
     */
    protected _originalApiMessages: unknown[] | null = null;

    /**
     * Get the stored images associated with this instance, if any.
     */
    public getStoredImage(imageIndex: number): StoredImage | undefined {
        if (imageIndex < 0 || imageIndex >= this._localImages.length) return undefined;
        return this._localImages[imageIndex];
    }

    /** 已存储的本地图片（视觉代理用）。 */
    public get localImages(): readonly StoredImage[] {
        return this._localImages;
    }

    /** 转换后的原始 API 消息（视觉代理构建后续轮次用）。 */
    public get originalApiMessages(): unknown[] | null {
        return this._originalApiMessages;
    }

    /** 系统提示内容（Anthropic 后续轮次需回填 system 字段）。 */
    public get systemContent(): string | undefined {
        return this._systemContent;
    }

    /** 上一轮流式响应捕获的 reasoning_content（DeepSeek 兼容回填）。 */
    public get capturedReasoningContent(): string {
        return this._capturedReasoningContent;
    }

    public set capturedReasoningContent(value: string) {
        this._capturedReasoningContent = value;
    }

    constructor(modelId: string) {
        this._modelId = modelId;
    }

    /**
     * Convert VS Code chat messages to specific api message format.
     * @param messages The VS Code chat messages to convert.
     * @param modelConfig Config for special model.
     * @returns Specific api messages array.
     */
    abstract convertMessages(
        messages: readonly LanguageModelChatRequestMessage[],
        modelConfig: { includeReasoningInRequest: boolean }
    ): TMessage[];

    /**
     * Construct request body for Specific api
     * @param rb Specific api Request body
     * @param um Current Model Info
     * @param options From VS Code
     */
    abstract prepareRequestBody(
        rb: TRequestBody,
        um: ProviderModelItem | undefined,
        options?: ProvideLanguageModelChatResponseOptions
    ): TRequestBody;

    /**
     * Process specific api streaming response (JSON lines format).
     * @param responseBody The readable stream body.
     * @param progress Progress reporter for streamed parts.
     * @param token Cancellation token.
     */
    abstract processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void>;

    /**
     * Try to emit a buffered tool call when a valid name and JSON arguments are available.
     * @param key The tool call buffer key (id / index / auto).
     * @param progress Progress reporter for parts.
     */
    protected async tryEmitBufferedToolCall(
        key: string,
        progress: Progress<LanguageModelResponsePart>
    ): Promise<void> {
        const buf = this._toolCallBuffers.get(key);
        if (!buf) {
            return;
        }
        if (!buf.name) {
            return;
        }
        // Skip ask_image / ask_with_multi_image — handled by provider via interceptedToolCall
        if (buf.name === ASK_IMAGE_TOOL_NAME || buf.name === ASK_WITH_MULTI_IMAGE_TOOL_NAME) {
            return;
        }
        const parsed = parseToolCallArguments(buf.args);
        if (!parsed) {
            return;
        }
        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        let parameters = parsed;
        parameters = this.adjustReadFileParameters(buf.name, parameters);
        progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
        this._toolCallBuffers.delete(key);
        this._completedToolCallIndices.add(key);
    }

    /**
     * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
     * @param progress Progress reporter for parts.
     * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
     */
    protected async flushToolCallBuffers(
        progress: Progress<LanguageModelResponsePart>,
        throwOnInvalid: boolean
    ): Promise<void> {
        if (this._toolCallBuffers.size === 0) {
            return;
        }
        for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
            // Intercept ask_image / ask_with_multi_image — store on instance for provider to handle
            if (buf.name === ASK_IMAGE_TOOL_NAME || buf.name === ASK_WITH_MULTI_IMAGE_TOOL_NAME) {
                const parsed = parseToolCallArguments(buf.args);
                if (parsed) {
                    this.interceptedToolCall = {
                        id: buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
                        name: buf.name,
                        args: parsed as { imageIndex?: number; imageIndices?: number[]; query: string },
                    };
                }
                this._toolCallBuffers.delete(idx);
                this._completedToolCallIndices.add(idx);
                continue;
            }

            const parsed = parseToolCallArguments(buf.args);
            if (!parsed) {
                // Fallback: the buffer may hold fragments of several parallel tool
                // calls merged together (collision guard failed to separate them).
                // Split into individual JSON objects and emit each one separately
                // instead of throwing away the whole request.
                const split = splitToolCallArguments(buf.args);
                if (split.length > 1) {
                    const baseName = buf.name ?? "unknown_tool";
                    for (let i = 0; i < split.length; i++) {
                        let p = split[i];
                        p = this.adjustReadFileParameters(baseName, p);
                        progress.report(
                            new LanguageModelToolCallPart(
                                `call_${Math.random().toString(36).slice(2, 10)}`,
                                baseName,
                                p
                            )
                        );
                    }
                    this._toolCallBuffers.delete(idx);
                    this._completedToolCallIndices.add(idx);
                    continue;
                }
                if (throwOnInvalid) {
                    console.error("[Copilot Provider] Invalid JSON for tool call", {
                        idx,
                        snippet: (buf.args || "").slice(0, 200),
                    });
                    throw new Error("Invalid JSON for tool call");
                }
                continue;
            }
            const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = buf.name ?? "unknown_tool";
            let parameters = parsed;
            parameters = this.adjustReadFileParameters(name, parameters);
            progress.report(new LanguageModelToolCallPart(id, name, parameters));
            this._toolCallBuffers.delete(idx);
            this._completedToolCallIndices.add(idx);
        }
    }

    /**
     * Adjust read_file tool parameters to default to reading configurable number of lines.
     * @param toolName The name of the tool being called.
     * @param parameters The tool parameters.
     * @returns Adjusted parameters.
     */
    protected adjustReadFileParameters(toolName: string, parameters: Record<string, unknown>): Record<string, unknown> {
        if (toolName !== "read_file") {
            return parameters;
        }
        const config = vscode.workspace.getConfiguration();
        const defaultLines = config.get<number>("amdTokenFactory.readFileLines", 0);
        if (defaultLines <= 0) {
            return parameters;
        }

        const startLine = typeof parameters.startLine === "number" ? parameters.startLine : 1;
        const endLine = typeof parameters.endLine === "number" ? parameters.endLine : startLine;
        if (endLine < startLine + defaultLines) {
            return { ...parameters, endLine: startLine + defaultLines };
        }
        return parameters;
    }

    /**
     * Reset mutable streaming state. Must be called at the start of each
     * processStreamingResponse invocation to prevent state carryover between
     * rounds (e.g., first round → vision proxy → second round).
     * Optional fields like _onUsage and _capturedReasoningContent are left as-is
     * because they are intentionally managed across rounds.
     */
    protected _resetStreamState(): void {
        this._toolCallBuffers.clear();
        this._completedToolCallIndices.clear();
        this._indexToId.clear();
        this._lastToolCallKey = undefined;
        this._hasEmittedAssistantText = false;
        this._lastFinishReason = undefined;
        this._emittedBeginToolCallsHint = false;
        this._xmlThinkActive = false;
        this._currentThinkingId = null;
        this._thinkingBuffer = "";
        if (this._thinkingFlushTimer) {
            clearTimeout(this._thinkingFlushTimer);
            this._thinkingFlushTimer = null;
        }
        this.interceptedToolCall = null;
    }

    /**
     * Report to VS Code for ending thinking
     * @param progress Progress reporter for parts
     */
    protected reportEndThinking(progress: Progress<LanguageModelResponsePart>) {
        if (!this._currentThinkingId) {
            return;
        }
        try {
            this.flushThinkingBuffer(progress);
            progress.report(new LanguageModelThinkingPart("", this._currentThinkingId) as unknown as LanguageModelResponsePart);
        } catch (e) {
            console.error("[Copilot Provider] Failed to end thinking sequence:", e);
        }
        this._currentThinkingId = null;
        this._thinkingBuffer = "";
        if (this._thinkingFlushTimer) {
            clearTimeout(this._thinkingFlushTimer);
            this._thinkingFlushTimer = null;
        }
    }

    /**
     * Generate a unique thinking ID based on request start time and random suffix
     */
    protected generateThinkingId(): string {
        return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Buffer and schedule a flush for thinking content.
     * @param text The thinking text to buffer
     * @param progress Progress reporter for parts
     */
    protected bufferThinkingContent(text: string, progress: Progress<LanguageModelResponsePart>): void {
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
     * @param progress Progress reporter for parts.
     */
    protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart>): void {
        if (this._thinkingFlushTimer) {
            clearTimeout(this._thinkingFlushTimer);
            this._thinkingFlushTimer = null;
        }

        if (this._thinkingBuffer && this._currentThinkingId) {
            const text = this._thinkingBuffer;
            this._thinkingBuffer = "";
            progress.report(new LanguageModelThinkingPart(text, this._currentThinkingId) as unknown as LanguageModelResponsePart);
        }
    }

    /**
     * Process XML think blocks in text content.
     * @param content The text content to process.
     * @param progress Progress reporter for parts.
     * @returns Object indicating whether any think blocks were emitted.
     */
    protected processXmlThinkBlocks(
        content: string,
        progress: Progress<LanguageModelResponsePart>
    ): { emittedAny: boolean } {
        // XML think tags: <think>...</think> (same as removeThinkTags in
        // gitCommit/commitMessageGenerator.ts). Some models emit reasoning
        // inline in the text content instead of the structured reasoning field.
        if (!content.includes("<think>") && !content.includes("</think>") && !this._xmlThinkActive) {
            return { emittedAny: false };
        }

        let remaining = content;
        let emittedAny = false;
        while (remaining.length > 0) {
            if (this._xmlThinkActive) {
                const endIdx = remaining.indexOf("</think>");
                if (endIdx === -1) {
                    this.bufferThinkingContent(remaining, progress);
                    emittedAny = true;
                    break;
                } else {
                    const thinkText = remaining.slice(0, endIdx);
                    if (thinkText) {
                        this.bufferThinkingContent(thinkText, progress);
                        emittedAny = true;
                    }
                    this.reportEndThinking(progress);
                    this._xmlThinkActive = false;
                    remaining = remaining.slice(endIdx + "</think>".length);
                }
            } else {
                const startIdx = remaining.indexOf("<think>");
                if (startIdx === -1) {
                    if (!emittedAny) {
                        return { emittedAny: false };
                    }
                    // Emit remaining text after think block
                    this.reportEndThinking(progress);
                    if (remaining.trim()) {
                        progress.report(new vscode.LanguageModelTextPart(remaining));
                    }
                    break;
                } else {
                    // Emit text before <think> tag
                    const beforeThink = remaining.slice(0, startIdx);
                    if (beforeThink.trim()) {
                        this.reportEndThinking(progress);
                        progress.report(new vscode.LanguageModelTextPart(beforeThink));
                    }
                    this._xmlThinkActive = true;
                    remaining = remaining.slice(startIdx + "<think>".length);
                }
            }
        }

        return { emittedAny };
    }

    /**
     * Process regular text content (non-XML-think).
     * @param content Text content to process.
     * @param progress Progress reporter for parts.
     * @returns Object indicating whether any text was emitted.
     */
    protected processTextContent(
        content: string,
        progress: Progress<LanguageModelResponsePart>
    ): { emittedAny: boolean } {
        if (!content) {
            return { emittedAny: false };
        }
        progress.report(new vscode.LanguageModelTextPart(content));
        return { emittedAny: true };
    }

    /**
     * 收集消息中的图片并存入实例局部数组（仅非视觉模型需要）。
     *
     * 扫描范围：① 直接的图片 DataPart；② 工具结果内嵌的图片 DataPart；
     * ③ 文本 part 中的 base64 data URI 图片。命中后设置 `_localImages` 与
     * `_hasImages`，供 `prepareRequestBody` 注入 ask_image 工具。
     *
     * 双协议 `convertMessages` 共用（原先各自重复约 40 行）。
     */
    protected collectLocalImages(messages: readonly LanguageModelChatRequestMessage[]): void {
        const imagesToStore: StoredImage[] = [];
        for (const m of messages) {
            for (const part of m.content ?? []) {
                if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                    imagesToStore.push({ data: part.data, mimeType: part.mimeType });
                }
                // Also scan inside tool result content for images
                // (e.g., when view_image tool returns an image in a previous turn)
                if (isToolResultPart(part)) {
                    const toolContent = (part as { content?: ReadonlyArray<unknown> }).content;
                    if (toolContent) {
                        for (const inner of toolContent) {
                            if (inner instanceof vscode.LanguageModelDataPart && isImageMimeType(inner.mimeType)) {
                                imagesToStore.push({ data: inner.data, mimeType: inner.mimeType });
                            } else if (inner instanceof vscode.LanguageModelTextPart) {
                                // Scan text for base64 data URI images
                                storeDataUriImages(inner.value, imagesToStore);
                            }
                        }
                    }
                }
                // Scan direct text parts for base64 data URI images
                if (part instanceof vscode.LanguageModelTextPart) {
                    storeDataUriImages(part.value, imagesToStore);
                }
            }
        }
        if (imagesToStore.length > 0) {
            this._localImages = imagesToStore;
            this._hasImages = true;
        }
    }

    /**
     * 注入 temperature / top_p（模型声明 `supportsTemperature === false` 时跳过）。
     *
     * 双协议 `prepareRequestBody` 共用。
     * 需整体跳过温度控制，由调用方自行判断后决定是否调用本方法。
     */
    protected applyTemperature(rb: Record<string, unknown>, um: ProviderModelItem | undefined): void {
        if (um?.temperature !== undefined && um.temperature !== null && um.supportsTemperature !== false) {
            rb.temperature = um.temperature;
        }
        if (um?.top_p !== undefined && um.top_p !== null && um.supportsTemperature !== false) {
            rb.top_p = um.top_p;
        }
    }

    /**
     * 合并模型 `extra` 参数到请求体（`undefined` 值跳过）。
     *
     * 双协议 `prepareRequestBody` 共用。
     */
    protected mergeExtraParams(rb: Record<string, unknown>, um: ProviderModelItem | undefined): void {
        if (um?.extra && typeof um.extra === "object") {
            for (const [key, value] of Object.entries(um.extra)) {
                if (value !== undefined) {
                    rb[key] = value;
                }
            }
        }
    }

    /**
     * 统一的 SSE 流消费骨架（双协议 `processStreamingResponse` 共用）。
     *
     * 负责：重置流状态 → （可选）协议专属清理 → 逐事件回调 → 结束刷新工具调用
     * → 结束 thinking。reader 生命周期/取消回调/`[DONE]` 由 `sse.ts` 统一处理。
     *
     * @param tag 日志前缀（如 "openai"）。
     * @param onEvent 每个 SSE 事件的处理器。
     * @param options.onBefore 重置状态后的协议专属清理。
     * @param options.onDone 流结束时的工具调用刷新；缺省为基类 `flushToolCallBuffers`。
     * @param options.debugChunks 是否记录原始 chunk 日志。
     */
    protected async runSseStream(
        responseBody: ReadableStream<Uint8Array>,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken,
        tag: string,
        onEvent: (parsed: unknown) => Promise<void> | void,
        options: {
            onBefore?: () => void;
            onDone?: () => Promise<void> | void;
            debugChunks?: boolean;
        } = {}
    ): Promise<void> {
        this._resetStreamState();
        options.onBefore?.();
        await consumeSseStream(responseBody, {
            tag,
            modelId: this._modelId,
            token,
            debugChunks: options.debugChunks,
            onEvent,
            onDone: options.onDone ?? (() => this.flushToolCallBuffers(progress, false)),
            onFinally: () => this.reportEndThinking(progress),
        });
    }

    /**
     * Prepare headers for API request.
     * @param apiKey The API key to use.
     * @param apiMode The apiMode (affects header format).
     * @param customHeaders Optional custom headers from model config.
     * @returns Headers object.
     */
    public static prepareHeaders(
        apiKey: string,
        apiMode: string,
        customHeaders?: Record<string, string>
    ): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": VersionManager.getUserAgent(),
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br, zstd",
        };

        // Provider-specific header formats
        if (apiMode === "anthropic") {
            headers["x-api-key"] = apiKey;
            headers["anthropic-version"] = "2023-06-01";
        } else {
            // OpenAI-compatible API uses Bearer auth
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        // Merge custom headers if provided
        if (customHeaders) {
            for (const [key, value] of Object.entries(customHeaders)) {
                headers[key] = value;
            }
        }

        return headers;
    }
}
