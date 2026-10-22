import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { ProviderModelItem } from "../core/types";
import { createRetryConfig, executeWithRetry } from "../core/utils";
import { logger } from "../core/logger";
import { OpenaiApi } from "../api/openai/openaiApi";
import { AnthropicApi } from "../api/anthropic/anthropicApi";
import type { AnthropicRequestBody } from "../api/anthropic/anthropicTypes";
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
        const anthropicApi = new AnthropicApi(model.id);
        anthropicApi.onUsage = onUsage;
        const anthropicMessages = anthropicApi.convertMessages(messages, modelConfig);

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
                throw new Error(
                    `Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
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
        await handleInterceptedToolCall(visionParams(anthropicApi));
    } else {
        // OpenAI Chat Completions API mode
        const openaiApi = new OpenaiApi(model.id);
        openaiApi.onUsage = onUsage;
        const openaiMessages = openaiApi.convertMessages(messages, modelConfig);

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
                throw new Error(
                    `API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
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
        await handleInterceptedToolCall(visionParams(openaiApi));
    }
}
