import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { ProviderModelItem } from "../core/types";
import { convertToolsToOpenAI, createRetryConfig, executeWithRetry } from "../core/utils";
import { l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import type { CommonApi } from "../api/commonApi";
import { callVisionModel, callVisionModelMulti } from "../vision/imageProxy";
import {
    ASK_IMAGE_TOOL_DEF,
    ASK_WITH_MULTI_IMAGE_TOOL_DEF,
    ASK_WITH_MULTI_IMAGE_TOOL_NAME,
    type StoredImage,
} from "../vision/types";
import { createVisionToolHistoryPart } from "../vision/historyPart";
import type { VisionToolHistoryEntry } from "../vision/historyCodec";
import { isVisionCapableModelId } from "../models/provideModel";
import { VisionRoundError } from "./errors";

/**
 * 图片代理（ask_image）多轮处理。
 *
 * 非视觉模型收到图片时，`convertMessages` 会把图片替换为文本引用并存入
 * 实例的 `_localImages`；模型随后调用 `ask_image` / `ask_with_multi_image`
 * 工具，被 `CommonApi` 拦截到 `interceptedToolCall`。本模块负责：
 *   1. 用模型的具体提问调用视觉模型（流式转发到 thinking 块）
 *   2. 输出跨轮视觉历史 DataPart（VS Code 自动带入下一轮对话）
 *   3. 构建 assistant tool_call + tool result 消息并再次请求
 *   4. 若模型再次调用 ask_image 则继续下一轮（最多 visionMaxRounds 次）
 *
 * 从 `provider.ts` 抽出。
 */

export interface VisionRoundParams {
    api: CommonApi<unknown, unknown>;
    apiMode: string;
    model: LanguageModelChatInformation;
    um: ProviderModelItem | undefined;
    modelApiKey: string;
    baseUrl: string;
    dispatchFetch: typeof fetch;
    requestHeaders: Record<string, string>;
    retryConfig: ReturnType<typeof createRetryConfig>;
    abortController: AbortController;
    trackingProgress: Progress<LanguageModelResponsePart>;
    token: CancellationToken;
    options: ProvideLanguageModelChatResponseOptions;
}

export async function handleInterceptedToolCall(params: VisionRoundParams): Promise<void> {
    const api = params.api;
    const storedMessages = api.originalApiMessages as unknown[] | undefined;
    const localImages = api.localImages;
    const hasLocalImages = localImages.length > 0;

    // Nothing to proxy — no stored images
    if (!hasLocalImages) {
        logger.debug("vision.no-stored-images", { hasStoredMessages: !!storedMessages });
        return;
    }
    if (!storedMessages || storedMessages.length === 0) {
        logger.warn("vision.no-second-round-messages", {});
        return;
    }

    const config = vscode.workspace.getConfiguration();
    const visionModelId = config.get<string>("amdTokenFactory.visionProxyModel", "Qwen3.8-27B");
    // Clamp to [1, 20]: VS Code's schema minimum/maximum only warn in the UI —
    // a value set directly in settings.json (e.g. 0 or negative) would otherwise
    // silently drop every vision call (loop never runs).
    const rawMaxRounds = config.get<number>("amdTokenFactory.visionMaxRounds", 5);
    const maxRounds = Number.isFinite(rawMaxRounds) ? Math.min(20, Math.max(1, Math.floor(rawMaxRounds))) : 5;

    // Guard against a misconfigured visionProxyModel. The main model is ALWAYS
    // non-vision here (otherwise the image would have been sent directly), so
    // pointing the proxy at the same model — or at any known non-vision model —
    // would make the vision request trigger the ask_image proxy again → recursion.
    const bareVisionId = visionModelId.includes("/")
        ? visionModelId.substring(visionModelId.lastIndexOf("/") + 1)
        : visionModelId;
    const bareMainId = params.model.id.includes("/")
        ? params.model.id.substring(params.model.id.lastIndexOf("/") + 1)
        : params.model.id;
    if (bareVisionId === bareMainId || isVisionCapableModelId(visionModelId) === false) {
        logger.warn("vision.proxyModelNotVisionCapable", {
            visionModelId,
            mainModelId: params.model.id,
        });
        params.trackingProgress.report(
            new vscode.LanguageModelThinkingPart(
                l10nFormat(
                    "The configured vision model ({0}) does not support image input. Set amdTokenFactory.visionProxyModel to a vision-capable model.",
                    visionModelId
                )
            ) as unknown as LanguageModelResponsePart
        );
        return;
    }

    // Accumulate messages across rounds
    let currentMessages: Record<string, unknown>[] = [...(storedMessages as Record<string, unknown>[])];

    for (let round = 1; round <= maxRounds; round++) {
        const intercepted = api.interceptedToolCall;
        if (!intercepted) {
            break;
        }
        // Clear so processStreamingResponse in the next round can set a new one
        api.interceptedToolCall = null;

        logger.info("vision.intercepted", {
            round,
            toolName: intercepted.name,
            imageIndex: intercepted.args.imageIndex,
            imageIndices: intercepted.args.imageIndices,
            query: intercepted.args.query,
            apiMode: params.apiMode,
        });

        const visionPrompt = intercepted.args.query;

        // Block 1: show the model's question in a thinking block
        const questionThinkId = `vision_q_${Date.now()}_${round}`;
        params.trackingProgress.report(
            new vscode.LanguageModelThinkingPart(
                l10nFormat("Querying vision model: \"{0}\"", visionPrompt ?? ""),
                questionThinkId
            ) as unknown as LanguageModelResponsePart
        );
        // Close block 1
        params.trackingProgress.report(
            new vscode.LanguageModelThinkingPart("", questionThinkId) as unknown as LanguageModelResponsePart
        );

        // Block 2: vision model's thinking/reasoning (real-time streaming)
        const thinkBlockId = `vision_think_${Date.now()}_${round}`;
        // Block 3: vision model's final output (real-time streaming)
        const textBlockId = `vision_text_${Date.now()}_${round}`;

        const visionProgress = {
            onThinking: (text: string) => {
                params.trackingProgress.report(
                    new vscode.LanguageModelThinkingPart(text, thinkBlockId) as unknown as LanguageModelResponsePart
                );
            },
            onText: (text: string) => {
                params.trackingProgress.report(
                    new vscode.LanguageModelThinkingPart(text, textBlockId) as unknown as LanguageModelResponsePart
                );
            },
        };

        // Call vision model — single image or multi-image depending on tool used.
        let description: string;
        try {
            if (intercepted.name === ASK_WITH_MULTI_IMAGE_TOOL_NAME) {
                // Multi-image: collect all referenced images
                const indices = intercepted.args.imageIndices ?? [];
                const images: StoredImage[] = [];
                for (const idx of indices) {
                    const img = api.getStoredImage(idx);
                    if (img) images.push(img);
                }
                if (images.length < 2) {
                    logger.warn("vision.not-enough-images", { indices });
                    description = "[Not enough images for comparison]";
                } else {
                    description = await callVisionModelMulti(images, visionModelId, visionPrompt, params.token, visionProgress);
                }
            } else {
                // Single image
                const storedImage = api.getStoredImage(intercepted.args.imageIndex ?? 0);
                if (!storedImage) {
                    logger.warn("vision.image-not-found", { imageIndex: intercepted.args.imageIndex });
                    description = "[Image not found]";
                } else {
                    description = await callVisionModel(
                        storedImage.data,
                        storedImage.mimeType,
                        visionModelId,
                        visionPrompt,
                        params.token,
                        visionProgress
                    );
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error("vision.call-failed", { error: errMsg, visionModelId });
            description = "[Image query unavailable]";
        }

        // Close block 2 (vision thinking)
        params.trackingProgress.report(
            new vscode.LanguageModelThinkingPart("", thinkBlockId) as unknown as LanguageModelResponsePart
        );
        // Close block 3 (vision output)
        params.trackingProgress.report(
            new vscode.LanguageModelThinkingPart("", textBlockId) as unknown as LanguageModelResponsePart
        );

        // Persist the completed internal tool exchange in the response
        // stream. VS Code can carry this DataPart into the next request;
        // the API converters then rebuild the standard tool messages.
        const previousReasoning = params.apiMode === "openai" ? api.capturedReasoningContent : undefined;
        const historyEntry: VisionToolHistoryEntry = {
            id: intercepted.id,
            name: intercepted.name as VisionToolHistoryEntry["name"],
            args: intercepted.args,
            result: description,
            ...(previousReasoning !== undefined ? { reasoningContent: previousReasoning } : {}),
        };
        params.trackingProgress.report(
            createVisionToolHistoryPart(historyEntry) as unknown as LanguageModelResponsePart
        );

        if (params.token.isCancellationRequested) {
            logger.info("vision.skipped-round", { round, reason: "user_cancelled" });
            break;
        }

        // Build round messages
        // Create a fresh abort controller for this round
        const roundAbortController = new AbortController();
        const roundTimeoutMs = vscode.workspace.getConfiguration().get<number>("amdTokenFactory.requestTimeout", 600000);
        const roundTimeoutId = setTimeout(() => {
            if (!roundAbortController.signal.aborted) {
                roundAbortController.abort();
            }
        }, roundTimeoutMs);
        // Forward user cancellation to the new controller
        let cancelDisposable: vscode.Disposable | undefined;
        if (params.token.onCancellationRequested) {
            cancelDisposable = params.token.onCancellationRequested(() => {
                if (!roundAbortController.signal.aborted) {
                    roundAbortController.abort();
                }
            });
        }

        try {
            if (params.apiMode === "anthropic") {
                await runAnthropicRound(params, api, currentMessages, intercepted, description, hasLocalImages, roundAbortController);
            } else {
                await runOpenAIRound(params, api, currentMessages, intercepted, description, hasLocalImages, roundAbortController);
            }
        } catch (err) {
            // 视觉代理轮内失败：主请求已成功、tool 上下文已建立，换 key 重跑整个
            // 请求会导致主回答重复输出。用 VisionRoundError 标记，让轮换循环直接
            // 抛出、不轮换 key（由用户重试整个请求）。
            const msg = err instanceof Error ? err.message : String(err);
            throw new VisionRoundError(msg, { cause: err });
        } finally {
            clearTimeout(roundTimeoutId);
            cancelDisposable?.dispose();
        }
    }

    // The loop exited — if the model still wants to ask about the image but the
    // round cap is reached, tell the user instead of silently dropping the call.
    if (api.interceptedToolCall) {
        logger.warn("vision.maxRoundsReached", { maxRounds, pendingTool: api.interceptedToolCall.name });
        params.trackingProgress.report(
            new vscode.LanguageModelThinkingPart(
                l10nFormat("Vision question limit reached ({0} rounds); further image questions were dropped.", String(maxRounds))
            ) as unknown as LanguageModelResponsePart
        );
    }
}

/** Anthropic 格式：tool_use + tool_result content block。 */
async function runAnthropicRound(
    params: VisionRoundParams,
    api: CommonApi<unknown, unknown>,
    currentMessages: Record<string, unknown>[],
    intercepted: NonNullable<CommonApi<unknown, unknown>["interceptedToolCall"]>,
    description: string,
    hasLocalImages: boolean,
    roundAbortController: AbortController
): Promise<void> {
    currentMessages.push({
        role: "assistant" as const,
        content: [
            { type: "tool_use" as const, id: intercepted.id, name: intercepted.name, input: intercepted.args },
        ],
    });
    currentMessages.push({
        role: "user" as const,
        content: [
            { type: "tool_result" as const, tool_use_id: intercepted.id, content: description },
        ],
    });

    const body: Record<string, unknown> = {
        model: params.um?.id ?? params.model.id,
        messages: currentMessages,
        stream: true,
    };
    if (params.um?.max_completion_tokens !== undefined) {
        body.max_tokens = params.um.max_completion_tokens;
    } else if (params.um?.max_tokens !== undefined) {
        body.max_tokens = params.um.max_tokens;
    }
    if (params.um?.temperature !== undefined && params.um.temperature !== null) {
        if (params.um.supportsTemperature !== false) {
            body.temperature = params.um.temperature;
        }
    }
    const systemContent = api.systemContent;
    if (systemContent) {
        body.system = systemContent;
    }
    // ⚠️ AMD TokenFactory 不支持 `thinking` 参数（400）→ 绝不发送。
    // 只发 reasoning_effort（平台接受；模型仍会原生返回 thinking 块）。
    if (params.um?.enable_thinking === false) {
        body.reasoning_effort = "none";
    } else if (params.um?.reasoning_effort !== undefined && params.um.reasoning_effort !== 'adaptive') {
        body.reasoning_effort = params.um.reasoning_effort;
    }

    // Inject tools (VS Code + ask_image + ask_with_multi_image)
    const anthropicToolList: Array<{ name: string; description?: string; input_schema?: object }> = [];
    const toolConfig = convertToolsToOpenAI(params.options);
    if (toolConfig.tools) {
        for (const tool of toolConfig.tools) {
            anthropicToolList.push({
                name: tool.function.name,
                description: tool.function.description,
                input_schema: tool.function.parameters,
            });
        }
    }
    if (hasLocalImages) {
        const singleDef = ASK_IMAGE_TOOL_DEF as unknown as { function: { name: string; description: string; parameters: object } };
        anthropicToolList.push({
            name: singleDef.function.name,
            description: singleDef.function.description,
            input_schema: singleDef.function.parameters,
        });
        if (api.localImages.length >= 2) {
            const multiDef = ASK_WITH_MULTI_IMAGE_TOOL_DEF as unknown as { function: { name: string; description: string; parameters: object } };
            anthropicToolList.push({
                name: multiDef.function.name,
                description: multiDef.function.description,
                input_schema: multiDef.function.parameters,
            });
        }
    }
    if (anthropicToolList.length > 0) {
        body.tools = anthropicToolList;
    }
    // Allow the model to freely call ask_image again in this round
    if (hasLocalImages) {
        body.tool_choice = { type: "auto" };
    }

    const normalizedUrl = params.baseUrl.replace(/\/+$/, "");
    const url = normalizedUrl.endsWith("/v1")
        ? `${normalizedUrl}/messages`
        : `${normalizedUrl}/v1/messages`;

    const response = await executeWithRetry(async () => {
        const res = await params.dispatchFetch(url, {
            method: "POST",
            headers: params.requestHeaders,
            body: JSON.stringify(body),
            signal: roundAbortController.signal,
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`);
        }
        return res;
    }, params.retryConfig);

    if (response.body) {
        await api.processStreamingResponse(response.body, params.trackingProgress, params.token);
    }
}

/** OpenAI 格式：assistant tool_call + tool result。 */
async function runOpenAIRound(
    params: VisionRoundParams,
    api: CommonApi<unknown, unknown>,
    currentMessages: Record<string, unknown>[],
    intercepted: NonNullable<CommonApi<unknown, unknown>["interceptedToolCall"]>,
    description: string,
    hasLocalImages: boolean,
    roundAbortController: AbortController
): Promise<void> {
    // Use the reasoning_content captured from the previous round's streaming response.
    // DeepSeek thinking mode requires the original reasoning_content to be echoed back
    // verbatim on every assistant message that follows a tool call — hardcoded strings
    // or empty values cause the model to break (infinite tool loops or 400 errors).
    const prevReasoning = api.capturedReasoningContent ?? "";
    api.capturedReasoningContent = "";
    currentMessages.push({
        role: "assistant" as const,
        reasoning_content: prevReasoning,
        tool_calls: [
            {
                id: intercepted.id,
                type: "function" as const,
                function: {
                    name: intercepted.name,
                    arguments: JSON.stringify(intercepted.args),
                },
            },
        ],
    });
    currentMessages.push({
        role: "tool" as const,
        tool_call_id: intercepted.id,
        content: description,
    });

    const body: Record<string, unknown> = {
        model: params.um?.id ?? params.model.id,
        messages: currentMessages,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (params.um?.temperature !== undefined && params.um.temperature !== null) {
        if (params.um.supportsTemperature !== false) {
            body.temperature = params.um.temperature;
        }
    }
    if (params.um?.top_p !== undefined && params.um.top_p !== null) {
        if (params.um.supportsTemperature !== false) {
            body.top_p = params.um.top_p;
        }
    }
    if (params.um?.max_completion_tokens !== undefined) {
        body.max_completion_tokens = params.um.max_completion_tokens;
    }
    if (params.um?.enable_thinking === false) {
        body.reasoning_effort = "none";
    } else if (params.um?.reasoning_effort !== undefined && params.um.reasoning_effort !== 'adaptive') {
        body.reasoning_effort = params.um.reasoning_effort;
    }
    // ⚠️ AMD TokenFactory 不支持 `thinking` 参数（400）→ 绝不发送。

    // Inject tools (VS Code + ask_image + ask_with_multi_image)
    const openaiToolList: unknown[] = [];
    const toolConfig = convertToolsToOpenAI(params.options);
    if (toolConfig.tools) {
        openaiToolList.push(...toolConfig.tools);
    }
    if (hasLocalImages) {
        openaiToolList.push(ASK_IMAGE_TOOL_DEF);
        if (api.localImages.length >= 2) {
            openaiToolList.push(ASK_WITH_MULTI_IMAGE_TOOL_DEF);
        }
    }
    if (openaiToolList.length > 0) {
        body.tools = openaiToolList;
    }
    // Allow the model to freely call ask_image again in this round
    if (hasLocalImages) {
        body.tool_choice = "auto";
    }

    const url = `${params.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await executeWithRetry(async () => {
        const res = await params.dispatchFetch(url, {
            method: "POST",
            headers: params.requestHeaders,
            body: JSON.stringify(body),
            signal: roundAbortController.signal,
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`);
        }
        return res;
    }, params.retryConfig);

    if (response.body) {
        await api.processStreamingResponse(response.body, params.trackingProgress, params.token);
    }
}
