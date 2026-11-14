import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { ProviderModelItem } from "../core/types";
import { createRetryConfig, executeWithRetry, withHttpStatus } from "../core/utils";
import { logger } from "../core/logger";
import { OpenaiApi } from "../api/openai/openaiApi";
import { AnthropicApi } from "../api/anthropic/anthropicApi";
import type { AnthropicMessage, AnthropicRequestBody } from "../api/anthropic/anthropicTypes";
import type { OpenAIChatMessage } from "../api/openai/openaiTypes";
import type { CommonApi, StreamUsage } from "../api/commonApi";
import { checkZeroAnswerBudgetExhausted } from "./errors";
import { handleInterceptedToolCall } from "./visionRounds";

/**
 * 单次 API 请求执行：协议分发（openai / anthropic）、流式处理、
 * 以及 ask_image 视觉代理的后续轮次。轮换循环内每个 key 调用一次。
 * 错误直接抛出，由调用方（轮换循环）决定是否换 key。
 */

export interface ApiRequestParams {
    apiMode: string;
    model: LanguageModelChatInformation;
    um: ProviderModelItem | undefined;
    modelConfig: { includeReasoningInRequest: boolean; vision: boolean };
    messages: readonly LanguageModelChatRequestMessage[];
    options: ProvideLanguageModelChatResponseOptions;
    trackingProgress: Progress<LanguageModelResponsePart>;
    token: CancellationToken;
    apiKey: string;
    baseUrl: string;
    requestHeaders: Record<string, string>;
    retryConfig: ReturnType<typeof createRetryConfig>;
    abortController: AbortController;
    dispatchFetch: typeof fetch;
    timeoutId: ReturnType<typeof setTimeout> | undefined;
    onUsage: (usage: StreamUsage) => void;
    /** Accumulated answer text (from trackingProgress) for zero-answer detection. */
    collectedOutputText: readonly string[];
    /**
     * 思考等级覆盖（供视觉代理等**代理请求**使用，主对话请求不传）。
     *
     * 代理请求不经过 `provider.ts` 的 `applyReasoningEffort`（那里读的是 VS Code
     * 的 `modelConfiguration.reasoningEffort`），因此由调用方直接指定
     * `reasoning_effort` 值，在 `prepareRequestBody` 前应用到 `um`。
     *
     * 取值（AMD 平台合法值，见 `package.json` 的 `amdTokenFactory.visionProxyThinking`）：
     * - `"auto"`   → 不发送 `reasoning_effort`，让模型用自己的默认思考行为。
     *   ⚠️ AMD 平台**没有** auto 档位（合法值 none/low/medium/high/max/minimal），
     *   auto 是给下游平台预留的语义：有 auto 的平台直接透传，没有的按"不发送"处理。
     * - `"none"`   → 发 `reasoning_effort: "none"`。⚠️ AMD 的 Qwen3.8 系列是
     *   模型固有思考，none 会抑制思考并直接输出空内容（EOS），慎用。
     * - `"low"` / `"medium"` / `"high"` / `"max"` → 直接透传。
     */
    reasoningEffortOverride?: string;
    /**
     * 复用的 API 实例（主模型续跑链路传外层实例）。
     *
     * 保留 `_localImages` / `_hasImages` / `_originalApiMessages` /
     * `capturedReasoningContent` / `_systemContent` 状态，使 `prepareRequestBody`
     * 能继续注入 ask_image 工具、`processStreamingResponse` 能继续拦截 ask_image。
     * 不传时内部 new 一个新实例（主对话 / 视觉代理路径）。
     */
    apiInstance?: CommonApi<unknown, unknown>;
    /**
     * 已转换的 API 消息（跳过 convertMessages）。
     *
     * 供主模型续跑链路使用：它需要原样重放原始消息 + 追加 tool_call/tool_result，
     * `convertMessages` 无法表达这种"已转换消息的追加"（图片引用替换会重复执行）。
     * 不传时走 `convertMessages`（主对话 / 视觉代理路径）。
     */
    apiMessagesOverride?: unknown[];
    /**
     * 跳过视觉代理拦截（handleInterceptedToolCall）。
     *
     * 主模型续跑链路传 true：它本身就在视觉代理循环内，内层不能再进入
     * `handleInterceptedToolCall`（否则无限递归）；模型再次调用 ask_image 时
     * `interceptedToolCall` 仍会被 `processStreamingResponse` 设置，由外层循环处理。
     */
    skipVisionRounds?: boolean;
}

export async function executeApiRequest(params: ApiRequestParams): Promise<void> {
    const {
        apiMode,
        model,
        um,
        modelConfig,
        messages,
        options,
        trackingProgress,
        token,
        apiKey,
        baseUrl: BASE_URL,
        requestHeaders,
        retryConfig,
        abortController,
        dispatchFetch,
        timeoutId,
        onUsage,
        collectedOutputText,
    } = params;

    // 代理请求（视觉代理等）的思考等级覆盖：在 prepareRequestBody 前应用到 um。
    // 主对话请求不传此字段，不受影响。
    if (params.reasoningEffortOverride && um) {
        if (params.reasoningEffortOverride === "auto") {
            // ⚠️ AMD 平台没有 auto 档位（合法值 none/low/medium/high/xhigh/max/minimal）。
            // auto 是给下游平台预留的语义：有 auto 的平台直接透传，没有的按
            // "不发送 reasoning_effort" 处理，让模型用自己的默认思考行为。
            um.reasoning_effort = undefined;
        } else {
            um.reasoning_effort = params.reasoningEffortOverride;
        }
        um.enable_thinking = true;
        um.include_reasoning_in_request = true;
    }

    /** 视觉代理后续轮次的公共参数。 */
    const visionParams = (api: CommonApi<unknown, unknown>) => ({
        api,
        apiMode,
        model,
        um,
        modelApiKey: apiKey,
        baseUrl: BASE_URL,
        dispatchFetch,
        requestHeaders,
        retryConfig,
        abortController,
        trackingProgress,
        token,
        options,
    });

    if (apiMode === "anthropic") {
        // Anthropic API mode
        // 复用外层 api 实例（主模型续跑）或新建（主对话 / 视觉代理）。
        const anthropicApi = (params.apiInstance as AnthropicApi | undefined) ?? new AnthropicApi(model.id);
        anthropicApi.onUsage = onUsage;
        const anthropicMessages = params.apiMessagesOverride
            ? (params.apiMessagesOverride as AnthropicMessage[])
            : anthropicApi.convertMessages(messages, modelConfig);

        // requestBody
        let requestBody: AnthropicRequestBody = {
            model: um?.id ?? model.id,
            messages: anthropicMessages,
            stream: true,
        };
        requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);

        // Build Anthropic messages endpoint URL
        const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
        const url = normalizedBaseUrl.endsWith("/v1")
            ? `${normalizedBaseUrl}/messages`
            : `${normalizedBaseUrl}/v1/messages`;
        logger.debug("request.body", { url, requestBody });
        const response = await executeWithRetry(async () => {
            const res = await dispatchFetch(url, {
                method: "POST",
                headers: requestHeaders,
                body: JSON.stringify(requestBody),
                signal: abortController.signal,
            });

            if (!res.ok) {
                const errorText = await res.text();
                console.error("[Anthropic Provider] Anthropic API error response", errorText);
                // Detect content moderation rejection for images — skip retries, this won't recover
                if (errorText.includes("image is sensitive")) {
                    throw new Error(`IMAGE_SENSITIVE: ${errorText}`);
                }
                throw withHttpStatus(
                    new Error(
                        `Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
                    ),
                    res.status
                );
            }

            return res;
        }, retryConfig);

        if (!response.body) {
            throw new Error("No response body from Anthropic API");
        }
        await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);

        // Zero-answer guard: budget exhausted with no answer text (see OpenAI branch)
        checkZeroAnswerBudgetExhausted(anthropicApi, collectedOutputText, model.id);
        // --- Second round: handle ask_image tool call interception ---
        // Clear the first-round timeout before starting the second round
        clearTimeout(timeoutId);
        if (!params.skipVisionRounds) {
            await handleInterceptedToolCall(visionParams(anthropicApi));
        }
    } else {
        // OpenAI Chat Completions API mode
        // 复用外层 api 实例（主模型续跑）或新建（主对话 / 视觉代理）。
        const openaiApi = (params.apiInstance as OpenaiApi | undefined) ?? new OpenaiApi(model.id);
        openaiApi.onUsage = onUsage;
        const openaiMessages = params.apiMessagesOverride
            ? (params.apiMessagesOverride as OpenAIChatMessage[])
            : openaiApi.convertMessages(messages, modelConfig);

        // requestBody
        let requestBody: Record<string, unknown> = {
            model: um?.id ?? model.id,
            messages: openaiMessages,
            stream: true,
            stream_options: { include_usage: true },
        };

        requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

        // Send chat request with retry
        const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
        logger.debug("request.body", { url, requestBody });
        const response = await executeWithRetry(async () => {
            const res = await dispatchFetch(url, {
                method: "POST",
                headers: requestHeaders,
                body: JSON.stringify(requestBody),
                signal: abortController.signal,
            });

            if (!res.ok) {
                const errorText = await res.text();
                console.error("[AMD TokenFactory] API error response", errorText);
                // Detect content moderation rejection for images — skip retries, this won't recover
                if (errorText.includes("image is sensitive")) {
                    throw new Error(`IMAGE_SENSITIVE: ${errorText}`);
                }
                throw withHttpStatus(
                    new Error(
                        `API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
                    ),
                    res.status
                );
            }

            return res;
        }, retryConfig);

        if (!response.body) {
            throw new Error("No response body from API");
        }

        await openaiApi.processStreamingResponse(response.body, trackingProgress, token);

        // Zero-answer guard: the model finished on "length" (token budget
        // exhausted, e.g. reasoning burned the whole max_completion_tokens)
        // without producing ANY answer text. Copilot Chat would otherwise
        // show "Sorry, no response was returned." with no hint why.
        checkZeroAnswerBudgetExhausted(openaiApi, collectedOutputText, model.id);

        // --- Second round: handle ask_image tool call interception ---
        // Clear the first-round timeout before starting the second round
        clearTimeout(timeoutId);
        if (!params.skipVisionRounds) {
            await handleInterceptedToolCall(visionParams(openaiApi));
        }
    }
}
