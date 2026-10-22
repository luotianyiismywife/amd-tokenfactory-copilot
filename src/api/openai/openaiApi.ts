import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    ProvideLanguageModelChatResponseOptions,
    Progress,
} from "vscode";

import type { ProviderModelItem } from "../../core/types";

import type {
    OpenAIChatMessage,
    OpenAIToolCall,
    ChatMessageContent,
    ReasoningDetail,
    ReasoningSummaryDetail,
    ReasoningTextDetail,
} from "./openaiTypes";

import {
    isImageMimeType,
    createDataUrl,
    isToolResultPart,
    convertToolsToOpenAI,
    mapRole,
    replaceDataUriImages,
} from "../../core/utils";

import { CommonApi, StreamUsage } from "../commonApi";
import { iterateSseEvents } from "../sse";
import {
    ASK_IMAGE_TOOL_DEF,
    ASK_WITH_MULTI_IMAGE_TOOL_DEF,
    buildUserImageReference,
    buildToolImageReference,
} from "../../vision/types";
import { parseVisionToolHistoryPart } from "../../vision/historyPart";
import { toOpenAIVisionToolMessages, type VisionToolHistoryEntry } from "../../vision/historyCodec";
import { postJson } from "../httpClient";

export class OpenaiApi extends CommonApi<OpenAIChatMessage, Record<string, unknown>> {
    constructor(modelId: string) {
        super(modelId);
    }

    /**
     * Convert VS Code chat request messages into OpenAI-compatible message objects.
     * For non-vision models, images are replaced with text references and stored
     * in instance-local _localImages for the ask_image tool.
     */
    convertMessages(
        messages: readonly LanguageModelChatRequestMessage[],
        modelConfig: { includeReasoningInRequest: boolean; vision?: boolean }
    ): OpenAIChatMessage[] {
        const modelSupportsVision = modelConfig.vision !== false;
        const out: OpenAIChatMessage[] = [];
        let imageIndex = 0;

        // Collect images to instance-local array if model doesn't support vision
        if (!modelSupportsVision) {
            this.collectLocalImages(messages);
        }

        for (const m of messages) {
            const role = mapRole(m);
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            const toolResults: { callId: string; content: string }[] = [];
            const reasoningParts: string[] = [];
            const visionToolHistory: VisionToolHistoryEntry[] = [];

            for (const part of m.content ?? []) {
                const historyEntry = parseVisionToolHistoryPart(part);
                if (historyEntry) {
                    visionToolHistory.push(historyEntry);
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    if (modelSupportsVision) {
                        textParts.push(part.value);
                    } else {
                        // Replace data URI images with references, and track imageIndex
                        const result = replaceDataUriImages(part.value, imageIndex);
                        imageIndex += result.count;
                        textParts.push(result.text);
                    }
                } else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                    if (modelSupportsVision) {
                        imageParts.push(part);
                    } else {
                        // For non-vision models, replace image with text reference
                        // Use strong directive language so the model knows it MUST use ask_image
                        textParts.push("\n" + buildUserImageReference(imageIndex));
                        imageIndex++;
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    let args: string;
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
                                if (modelSupportsVision) {
                                    toolTexts.push(inner.value);
                                } else {
                                    const result = replaceDataUriImages(inner.value, imageIndex);
                                    imageIndex += result.count;
                                    toolTexts.push(result.text);
                                }
                            } else if (!modelSupportsVision && inner instanceof vscode.LanguageModelDataPart && isImageMimeType(inner.mimeType)) {
                                toolTexts.push("\n" + buildToolImageReference(imageIndex));
                                imageIndex++;
                            }
                        }
                    }
                    const content = toolTexts.join("\n").trim();
                    toolResults.push({ callId, content });
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    const content = Array.isArray(part.value) ? part.value.join("") : part.value;
                    reasoningParts.push(content);
                }
            }

            const joinedText = textParts.join("").trim();
            const joinedThinking = reasoningParts.join("").trim();

            // Persisted ask_image calls are restored as ordinary API messages.
            // Put them before this message's normal content so that a DataPart
            // appended after the previous assistant text still forms the valid
            // sequence: assistant tool_call → tool result → assistant text.
            for (const entry of visionToolHistory) {
                out.push(...toOpenAIVisionToolMessages(entry));
            }

            // process assistant message
            if (role === "assistant") {
                const assistantMessage: OpenAIChatMessage = {
                    role: "assistant",
                };

                if (joinedText) {
                    assistantMessage.content = joinedText;
                }

                // Always set reasoning_content when includeReasoningInRequest is true.
                // DeepSeek thinking mode requires the reasoning_content field to be
                // present on EVERY assistant message for round-tripping — even an
                // empty string satisfies the requirement. VS Code does NOT re-send
                // LanguageModelThinkingPart in history messages, so reasoningParts is
                // usually empty on later turns of a conversation; without the field,
                // DeepSeek rejects the request with 400 ("reasoning_content ... must
                // be passed back to the API"). Thinking is off only when the user
                // disabled it (includeReasoningInRequest=false), so unconditional
                // emission here is safe.
                if (modelConfig.includeReasoningInRequest) {
                    assistantMessage.reasoning_content = joinedThinking;
                }

                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                }

                // Must have content or tool_calls — reasoning_content alone is rejected
                // by providers that require content/tool_calls to be set (e.g. DeepSeek).
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
                    const contentArray: ChatMessageContent[] = [];

                    if (joinedText) {
                        contentArray.push({
                            type: "text",
                            text: joinedText,
                        });
                    }

                    for (const imagePart of imageParts) {
                        const dataUrl = createDataUrl(imagePart);
                        contentArray.push({
                            type: "image_url",
                            image_url: {
                                url: dataUrl,
                            },
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
        this._originalApiMessages = out;
        return out;
    }

    prepareRequestBody(
        rb: Record<string, unknown>,
        um: ProviderModelItem | undefined,
        options?: ProvideLanguageModelChatResponseOptions
    ): Record<string, unknown> {
        // temperature / top_p
        this.applyTemperature(rb, um);

        // max_tokens / max_completion_tokens (mutually exclusive)
        if (um?.max_completion_tokens !== undefined) {
            rb.max_completion_tokens = um.max_completion_tokens;
        } else if (um?.max_tokens !== undefined) {
            rb.max_tokens = um.max_tokens;
        }

        // Reasoning control.
        //
        // ⚠️ AMD TokenFactory 实测（2026-10-21）：
        //   - `thinking` 参数**不被支持** → 400 `unsupported_parameter`
        //     （"thinking" is not supported on /v1/chat/completions ... Use
        //      "reasoning_effort" (or "reasoning.effort") to control thinking.）
        //   - `reasoning_effort` 被接受（200），合法取值 none/low/medium/high/max/minimal。
        //   - 思考内容在 **`reasoning`** 字段（非 `reasoning_content`，后者恒为 null）。
        //   - 思考是**模型固有属性**：Qwen3.8 系列恒产出 reasoning，
        //     DeepSeek-V4 系列恒不产出；`reasoning_effort` 只影响深度且非确定性。
        // 因此这里**只发 reasoning_effort，绝不发 thinking**。
        // 用户选「禁用思考」→ 发 `reasoning_effort: "none"`（平台接受，不报错）。
        if (um?.enable_thinking === false) {
            rb.reasoning_effort = "none";
        } else if (um?.reasoning_effort !== undefined && um.reasoning_effort !== 'adaptive') {
            rb.reasoning_effort = um.reasoning_effort;
        }

        // OpenRouter-style reasoning configuration
        if (um?.reasoning !== undefined && um.reasoning.enabled !== false) {
            const reasoningObj: Record<string, unknown> = {};
            const effort = um.reasoning.effort;
            if (effort && effort !== "auto") {
                reasoningObj.effort = effort;
            } else {
                reasoningObj.max_tokens = um.reasoning.max_tokens || 2000;
            }
            if (um.reasoning.exclude !== undefined) {
                reasoningObj.exclude = um.reasoning.exclude;
            }
            rb.reasoning = reasoningObj;
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
        const toolsList: unknown[] = [];
        if (toolConfig.tools) {
            toolsList.push(...toolConfig.tools);
        }
        // Inject ask_image + ask_with_multi_image for non-vision models with stored images
        if (this._hasImages) {
            toolsList.push(ASK_IMAGE_TOOL_DEF);
            if (this._localImages.length >= 2) {
                toolsList.push(ASK_WITH_MULTI_IMAGE_TOOL_DEF);
            }
        }
        if (toolsList.length > 0) {
            rb.tools = toolsList;
        }
        if (this._hasImages) {
            // Set to "auto" so the model can freely choose to call ask_image.
            // Some providers (DeepSeek) reject forced function tool_choice.
            // The converted messages already contain strong directives telling the
            // model it MUST use ask_image, and the tool definition is available.
            rb.tool_choice = "auto";
        } else if (toolConfig.tool_choice) {
            rb.tool_choice = toolConfig.tool_choice;
        }

        // Extra model parameters
        if (um?.top_k !== undefined) { rb.top_k = um.top_k; }
        if (um?.min_p !== undefined) { rb.min_p = um.min_p; }
        if (um?.frequency_penalty !== undefined) { rb.frequency_penalty = um.frequency_penalty; }
        if (um?.presence_penalty !== undefined) { rb.presence_penalty = um.presence_penalty; }
        if (um?.repetition_penalty !== undefined) { rb.repetition_penalty = um.repetition_penalty; }

        // Extra body parameters
        this.mergeExtraParams(rb, um);

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
        await this.runSseStream(
            responseBody,
            progress,
            token,
            "openai",
            async (parsed) => {
                const chunk = parsed as Record<string, unknown>;
                this.captureUsage(chunk);
                await this.processDelta(chunk, progress);
            },
            { debugChunks: true }
        );
    }

    /**
     * Capture token usage from a stream chunk (stream_options: include_usage).
     * Supports both OpenAI (prompt_tokens_details.cached_tokens) and
     * DeepSeek (prompt_cache_hit_tokens / prompt_cache_miss_tokens) formats.
     */
    private captureUsage(parsed: Record<string, unknown>): void {
        const usageData = parsed.usage as Record<string, unknown> | undefined;
        if (!usageData) {
            return;
        }
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

        const usage: StreamUsage = {
            promptTokens: (usageData.prompt_tokens as number) ?? 0,
            completionTokens: (usageData.completion_tokens as number) ?? 0,
            cacheHitTokens,
            cacheMissTokens,
        };
        this._onUsage?.(usage);
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

        // Process thinking content first (before regular text content)
        try {
            let maybeThinking =
                (choice as Record<string, unknown> | undefined)?.thinking ??
                (deltaObj as Record<string, unknown> | undefined)?.thinking ??
                (deltaObj as Record<string, unknown> | undefined)?.reasoning ??
                (deltaObj as Record<string, unknown> | undefined)?.reasoning_content;

            // OpenRouter reasoning_details array handling
            const maybeReasoningDetails =
                (deltaObj as Record<string, unknown>)?.reasoning_details ??
                (choice as Record<string, unknown>)?.reasoning_details;
            if (maybeReasoningDetails && Array.isArray(maybeReasoningDetails) && maybeReasoningDetails.length > 0) {
                const details: Array<ReasoningDetail> = maybeReasoningDetails as Array<ReasoningDetail>;
                const sortedDetails = details.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

                for (const detail of sortedDetails) {
                    let extractedText = "";
                    if (detail.type === "reasoning.summary") {
                        extractedText = (detail as ReasoningSummaryDetail).summary;
                    } else if (detail.type === "reasoning.text") {
                        extractedText = (detail as ReasoningTextDetail).text;
                    } else if (detail.type === "reasoning.encrypted") {
                        extractedText = "[REDACTED]";
                    } else {
                        extractedText = JSON.stringify(detail);
                    }

                    if (extractedText) {
                        this.bufferThinkingContent(extractedText, progress);
                        emitted = true;
                    }
                }
                maybeThinking = null;
            }

            if (maybeThinking !== undefined && maybeThinking !== null) {
                let text = "";
                if (maybeThinking && typeof maybeThinking === "object") {
                    const mt = maybeThinking as Record<string, unknown>;
                    text = typeof mt["text"] === "string" ? (mt["text"] as string) : JSON.stringify(mt);
                } else if (typeof maybeThinking === "string") {
                    text = maybeThinking;
                }
                if (text) {
                    // Accumulate reasoning content for echo-back in tool call proxy rounds
                    // DeepSeek thinking mode requires raw reasoning_content to be passed back verbatim
                    this._capturedReasoningContent += text;
                    this.bufferThinkingContent(text, progress);
                    emitted = true;
                }
            }
        } catch (e) {
            console.error("[AMD TokenFactory] Failed to process thinking/reasoning_details:", e);
        }

        if (deltaObj?.content) {
            const content = String(deltaObj.content);

            const xmlRes = this.processXmlThinkBlocks(content, progress);
            if (xmlRes.emittedAny) {
                emitted = true;
            } else {
                this.reportEndThinking(progress);
                const res = this.processTextContent(content, progress);
                if (res.emittedAny) {
                    this._hasEmittedAssistantText = true;
                    emitted = true;
                }
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
                const tcId = typeof tc.id === "string" && tc.id ? tc.id : undefined;
                const tcIndex = typeof tc.index === "number" ? String(tc.index) : undefined;
                const func = tc.function as Record<string, unknown> | undefined;
                const tcName = typeof func?.name === "string" && func.name ? (func.name as string) : undefined;
                // Resolve buffer key. The canonical key is the tool-call `id`. When a
                // chunk carries both id and index, record `index -> id` so that later
                // argument-only chunks (which carry only `index`, no id) resolve back to
                // the SAME bucket instead of opening a separate index bucket. This fixes
                // SenseAudio-style streaming tool_calls, whose argument fragments drop
                // `id` (non-standard vs OpenAI), which otherwise split name (id bucket) and
                // args (index bucket) apart and yield "Invalid JSON for tool call".
                let idx: string | undefined;
                if (tcId) {
                    idx = tcId;
                    if (tcIndex) {
                        this._indexToId.set(tcIndex, tcId);
                    }
                } else if (tcIndex) {
                    const mappedId = this._indexToId.get(tcIndex);
                    if (mappedId && !this._completedToolCallIndices.has(mappedId)) {
                        idx = mappedId;
                    } else {
                        idx = tcIndex;
                    }
                } else if (this._lastToolCallKey) {
                    idx = this._lastToolCallKey;
                } else {
                    let n = this._toolCallBuffers.size;
                    while (this._toolCallBuffers.has(`auto_${n}`) || this._completedToolCallIndices.has(`auto_${n}`)) {
                        n++;
                    }
                    idx = `auto_${n}`;
                }
                this._lastToolCallKey = idx;
                if (this._completedToolCallIndices.has(idx)) {
                    continue;
                }
                const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
                if (tcId) {
                    buf.id = tcId;
                }
                if (tcName) {
                    buf.name = tcName;
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
     * Create a non-streaming chat message (for Git commit generation).
     */
    async *createMessage(
        model: ProviderModelItem,
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

        let requestBody: Record<string, unknown> = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
        };
        requestBody = this.prepareRequestBody(requestBody, model, undefined);

        const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai", model.headers);

        const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

        const response = await postJson(url, headers, requestBody, signal, "API error");

        if (!response.body) {
            throw new Error("No response body from API");
        }

        for await (const event of iterateSseEvents(response.body, {
            tag: "openai",
            modelId: this._modelId,
            signal,
        })) {
            if (event.done) {
                continue;
            }
            const parsed = event.parsed as Record<string, unknown>;
            const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0];
            if (choice?.delta) {
                const deltaObj = choice.delta as Record<string, unknown>;
                const content = deltaObj.content as string | undefined;
                if (content) {
                    yield { type: "text", text: content };
                }
            }
        }
    }
}
