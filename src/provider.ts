import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatProvider,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress,
} from "vscode";

import * as path from "path";

import type { StreamUsage } from "./types";

import { createRetryConfig, executeWithRetry, extractApiErrorMessage } from "./utils";

import { prepareLanguageModelChatInformation, getModelConfig } from "./provideModel";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import { OpenaiApi } from "./openaiApi";
import {
    getApiKeyMode,
    getApiKeyStore,
    getKeyRotationReason,
    getKeyUnavailableReason,
    getTransientRetryTimes,
    hasTransientExhaustedKey,
    isKeyRotationError,
    isTransientExhaustedReason,
    isTransientRetryError,
    pickNextApiKey,
    markApiKeyExhausted,
    markApiKeyAvailable,
    resetExhaustedKeys,
    addApiKey,
    maskApiKey,
    type ApiKeyEntry,
} from "./keyManager";

/**
 * Human-readable labels for key rotation failure reasons (keys are l10n keys).
 */
export const REASON_TEXT: Record<string, string> = {
    invalid: "Key invalid",
    rate_limited: "Rate limited (429)",
    server_error: "Server error (503)",
    api_error: "API error",
    unavailable: "Unavailable",
    unknown: "API error",
};

/**
 * Detect a stream that exhausted its token budget (finish/stop reason
 * "length" or "max_tokens"). Two flavors:
 * - No answer text at all: reasoning consumed the whole budget (previously
 *   surfaced as "Sorry, no response was returned." with zero explanation).
 * - Partial answer text: the reply was cut off mid-sentence — previously
 *   silent, making it look like "the AI answers one sentence then stops"
 *   and requiring the user to keep typing "continue".
 * Throwing a descriptive error in both cases makes the root cause visible.
 */
function checkZeroAnswerBudgetExhausted(
    api: OpenaiApi,
    collectedOutputText: readonly string[],
    modelId: string
): void {
    const finishReason = api.lastFinishReason;
    if (
        finishReason &&
        (finishReason === "length" || finishReason === "max_tokens")
    ) {
        const hasText = collectedOutputText.join("").trim().length > 0;
        logger.error("request.budgetExhausted", {
            modelId,
            finishReason,
            hasPartialText: hasText,
        });
        if (!hasText) {
            throw new Error(
                l10nFormat(
                    "The model used all available output tokens on reasoning (finish reason: {0}) and produced no answer. Lower the reasoning effort, or turn thinking off and retry.",
                    finishReason
                )
            );
        }
        throw new Error(
            l10nFormat(
                "The response was cut off because the output token budget ran out (finish reason: {0}). Increase amdTokenFactory.maxOutputTokens in settings and retry.",
                finishReason
            )
        );
    }
}

/**
 * 构建"全部 API Key 均不可用"的脱敏原因详情（供报错信息展示）。
 * 遍历 store 中每个 key，用其当前状态（冷却中 / 持久化不可用）
 * 生成 `rc-****abcd: 原因` 列表。
 */
export async function buildAllKeysUnavailableDetail(secrets: vscode.SecretStorage): Promise<string> {
    const store = await getApiKeyStore(secrets);
    return store.keys
        .map((entry) => {
            const reason = getKeyUnavailableReason(entry);
            return `${maskApiKey(entry.value)}: ${l10n(REASON_TEXT[reason] ?? reason)}`;
        })
        .join("; ");
}

/**
 * 瞬态失败（429/5xx）整轮自动重试辅助。
 * 平台繁忙 / 限流导致全部 key 暂时不可用时，等待指数退避（2s/4s/8s，上限 8s）
 * 后重试整轮——**必须清空瞬态冷却**（`resetExhaustedKeys(secrets, false)`），
 * 否则冷却期间 `pickNextApiKey` 会跳过全部 key，重试永远不会真正发生。
 * @param retryCount 已执行的重试次数（0 起）
 * @param maxRetries 允许的最大重试次数
 * @returns 是否执行了重试（已等待退避并清理冷却）；达到上限返回 false
 */
export async function tryTransientRetryRound(
    secrets: vscode.SecretStorage,
    retryCount: number,
    maxRetries: number
): Promise<boolean> {
    if (retryCount >= maxRetries) {
        return false;
    }
    // 清空瞬态冷却（不触碰持久化 unavailable），否则 pickNextApiKey 会跳过全部 key
    await resetExhaustedKeys(secrets, false);
    const delayMs = Math.min(2000 * Math.pow(2, retryCount), 8000);
    logger.warn("key.transientRetry", { count: retryCount + 1, maxRetries, delayMs });
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return true;
}

/**
 * Native Copilot Token Indicator
 *
 * Reports token usage to the Copilot Chat's built-in token indicator by emitting
 * a LanguageModelDataPart with MIME type 'usage'. Copilot Chat intercepts this
 * part and displays it in the native UI element, just like GitHub Copilot's own
 * models do.
 */
function reportNativeUsage(
    usage: StreamUsage,
    progress: Progress<LanguageModelResponsePart>
): void {
    progress.report(
        new vscode.LanguageModelDataPart(
            new TextEncoder().encode(JSON.stringify({
                prompt_tokens: usage.promptTokens,
                completion_tokens: usage.completionTokens,
                total_tokens: usage.promptTokens + usage.completionTokens,
                prompt_tokens_details: {
                    cached_tokens: usage.cacheHitTokens ?? 0,
                },
            })),
            "usage"
        )
    );
}

/**
 * VS Code Chat provider backed by AMD TokenFactory API.
 */
export class AmdChatModelProvider implements LanguageModelChatProvider {
    /** Track last request completion time for delay calculation. */
    private _lastRequestTime: number | null = null;

    /**
     * Emitter for the optional `onDidChangeLanguageModelChatInformation` event.
     * Fired when the model list changes (e.g. manual refresh) so VS Code
     * re-invokes provideLanguageModelChatInformation.
     */
    private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();

    /**
     * An optional event fired when the available set of language models changes.
     */
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    /**
     * Notify VS Code that the model list may have changed.
     * VS Code re-invokes provideLanguageModelChatInformation.
     */
    notifyModelListChanged(): void {
        this._onDidChangeLanguageModelChatInformation.fire();
    }

    /**
     * Create a provider using the given secret storage for the API key.
     */
    constructor(
        private readonly secrets: vscode.SecretStorage
    ) { }

    /**
     * Create an undici fetch function with custom bodyTimeout to prevent premature
     * connection termination during long streaming responses.
     * Falls back to global fetch if undici is unavailable.
     */
    private _createFetchWithTimeout(requestTimeoutMs: number): typeof fetch {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const undici = require(path.join(vscode.env.appRoot, "node_modules", "undici"));
            const agent = new undici.Agent({ bodyTimeout: requestTimeoutMs });
            return (url: RequestInfo | URL, init?: RequestInit) => {
                return undici.fetch(url, { ...init, dispatcher: agent });
            };
        } catch {
            return fetch;
        }
    }

    /**
     * Get the list of available language models contributed by this provider.
     */
    async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // Background model-list revalidation (triggered inside prepare when the
        // cache is stale) fires this callback on real changes so VS Code
        // rebuilds the picker without user interaction.
        return prepareLanguageModelChatInformation(options, _token, this.secrets, getBaseUrl(), () => this.notifyModelListChanged());
    }

    /**
     * Returns the number of tokens for a given text (rough estimate —
     * ~4 characters per token for mixed CJK/English text; the exact value
     * only affects Copilot's client-side context indicator).
     */
    async provideTokenCount(
        _model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        _token: CancellationToken
    ): Promise<number> {
        const asString = typeof text === "string" ? text : JSON.stringify(text);
        return Math.ceil((asString?.length ?? 0) / 4);
    }

    /**
     * Returns the response for a chat request, passing the results to the progress callback.
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration();
        const requestTimeoutMs = config.get<number>("amdTokenFactory.requestTimeout", 300000);
        // Verbose diagnostics: log the request body and the full response text
        // to the output channel. Off by default — bodies can be megabytes and
        // contain conversation content; enable only while debugging.
        const debugLogBody = config.get<boolean>("amdTokenFactory.debugLogBody", false);
        const apiKeyMode = getApiKeyMode();
        const collectedOutputText: string[] = [];
        let collectedThinkingChars = 0;
        let usageReportedDuringStream = false;

        // Per-request rotation state — must be local so concurrent requests
        // never pollute each other's failure records.
        const failedKeys = new Map<string, string>();
        let transientRetryCount = 0;
        const maxTransientRetries = getTransientRetryTimes();

        // Wrap the progress reporter to collect the assistant text for the
        // zero-answer guard and the client-side usage fallback.
        const trackingProgress: Progress<LanguageModelResponsePart> = {
            report: (value: LanguageModelResponsePart) => {
                try {
                    if (value instanceof vscode.LanguageModelTextPart && typeof value.value === "string") {
                        collectedOutputText.push(value.value);
                    } else if (value instanceof vscode.LanguageModelThinkingPart) {
                        const thinkingValue = (value as unknown as { value?: unknown }).value;
                        if (typeof thinkingValue === "string") {
                            collectedThinkingChars += thinkingValue.length;
                        }
                    }
                } catch {
                    // collection is best-effort only
                }
                progress.report(value);
            },
        };

        // Create undici fetch with custom bodyTimeout (extends TCP idle timeout during streaming)
        const dispatchFetch = this._createFetchWithTimeout(requestTimeoutMs);

        // ── Multi-API-Key rotation loop ─────────────────────────────────────
        // Select a key per round; skip keys with transient cooldown (429/5xx)
        // or persisted unavailable marks (401 invalid). Errors that match the
        // rotation config switch to the next key; transient (429/5xx) errors
        // additionally cool the key down instead of persisting unavailability.
        const firstEntry = await this.ensureApiKey();
        if (!firstEntry) {
            logger.warn("apiKey.missing", {});
            const openWebsite = l10n("Open Website");
            const picked = await vscode.window.showErrorMessage(
                l10n("AMD TokenFactory API key not found"),
                openWebsite
            );
            if (picked === openWebsite) {
                vscode.commands.executeCommand("amdtokenfactory.getApiKey");
            }
            throw new Error(l10n("AMD TokenFactory API key not found"));
        }
        const totalKeys = (await getApiKeyStore(this.secrets)).keys.length;

        while (true) {
            // If every key has failed at least one round, stop trying.
            if (totalKeys > 0 && failedKeys.size >= totalKeys) {
                const detail = [...failedKeys.entries()]
                    .map(([key, reason]) => `${maskApiKey(key)}: ${l10n(REASON_TEXT[reason] ?? reason)}`)
                    .join("; ");
                const hasTransient = [...failedKeys.values()].some((r) => r === "rate_limited" || r === "server_error");
                // Platform busy / rate-limited: back off and retry the whole
                // round automatically instead of failing immediately.
                if (hasTransient && (await tryTransientRetryRound(this.secrets, transientRetryCount, maxTransientRetries))) {
                    transientRetryCount++;
                    failedKeys.clear();
                    continue;
                }
                logger.warn("key.allFailed", { detail });
                if (hasTransient) {
                    throw new Error(`${l10n("All API keys are temporarily unavailable")} — ${detail}`);
                }
                throw new Error(`${l10n("All API keys failed:")} ${detail}`);
            }

            const currentEntry = await pickNextApiKey(this.secrets, apiKeyMode);
            if (!currentEntry) {
                // Every key is excluded (persisted unavailable / cooldown).
                // If any key is merely in transient cooldown (429/5xx), back off
                // and retry the whole round.
                if (
                    (await hasTransientExhaustedKey(this.secrets)) &&
                    (await tryTransientRetryRound(this.secrets, transientRetryCount, maxTransientRetries))
                ) {
                    transientRetryCount++;
                    failedKeys.clear();
                    continue;
                }
                const detail = await buildAllKeysUnavailableDetail(this.secrets);
                logger.warn("key.allUnavailable", { detail });
                throw new Error(`${l10n("All API keys failed:")} ${detail}`);
            }

            const abortController = new AbortController();
            let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
                abortController.abort();
            }, requestTimeoutMs);

            try {
                // ── Execute the OpenAI chat completion request for this key ──
                const openaiApi = new OpenaiApi(model.id);
                openaiApi.onUsage = (usage: StreamUsage) => {
                    usageReportedDuringStream = true;
                    reportNativeUsage(usage, trackingProgress);
                };

                const um = getModelConfig(model.id);
                const modelConfig = {
                    includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
                    vision: um?.vision ?? false,
                };
                const openaiMessages = openaiApi.convertMessages(messages, modelConfig);

                let requestBody: Record<string, unknown> = {
                    model: model.id,
                    messages: openaiMessages,
                    stream: true,
                };
                // NOTE: do NOT send stream_options.include_usage — the AMD
                // endpoint already appends usage chunks unconditionally.
                requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

                const baseUrl = getBaseUrl();
                const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
                const bodyJson = JSON.stringify(requestBody);
                const modelOptions = (options.modelOptions ?? {}) as Record<string, unknown>;
                // INFO so it lands in the on-disk channel log: without this a
                // request that dies mid-stream leaves NO trace in the log file.
                logger.info("request.start", {
                    url,
                    key: maskApiKey(currentEntry.value),
                    model: model.id,
                    messages: messages.length,
                    tools: Array.isArray(requestBody.tools) ? requestBody.tools.length : 0,
                    bodyLength: bodyJson.length,
                    reasoningEffort: modelOptions.reasoningEffort ?? null,
                });
                if (debugLogBody) {
                    logger.info("request.body", {
                        length: bodyJson.length,
                        head: bodyJson.slice(0, 4000),
                        truncated: bodyJson.length > 4000,
                    });
                }
                const retryConfig = createRetryConfig();
                const requestHeaders: Record<string, string> = {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${currentEntry.value}`,
                };

                const response = await executeWithRetry(async () => {
                    const res = await dispatchFetch(url, {
                        method: "POST",
                        headers: requestHeaders,
                        body: JSON.stringify(requestBody),
                        signal: abortController.signal,
                    });

                    if (!res.ok) {
                        const errorText = await res.text();
                        const message = extractApiErrorMessage(errorText);
                        throw new Error(
                            `API error: [${res.status}] ${res.statusText}${message ? ` ${message}` : ""}\nURL: ${url}`
                        );
                    }

                    return res;
                }, retryConfig);

                if (!response.body) {
                    throw new Error("No response body from API");
                }

                await openaiApi.processStreamingResponse(response.body, trackingProgress, token);

                // Zero-answer guard: the model finished on "length" (token budget
                // exhausted, e.g. reasoning burned the whole budget) without
                // producing ANY answer text.
                checkZeroAnswerBudgetExhausted(openaiApi, collectedOutputText, model.id);

                // Tail snapshot of the model's ACTUAL output (info level → lands
                // in the on-disk channel log). When the chat UI shows a reply
                // "cut off mid-sentence" despite a clean finishReason=stop, this
                // distinguishes (a) the model really stopped there — tail ends
                // mid-sentence, tiny textLength — from (b) the full text arrived
                // and the chat renderer swallowed part of it — tail shows the
                // intended continuation.
                const fullOutputText = collectedOutputText.join("");
                logger.info("response.summary", {
                    model: model.id,
                    finishReason: openaiApi.lastFinishReason ?? null,
                    textParts: collectedOutputText.length,
                    textLength: fullOutputText.length,
                    thinkingChars: collectedThinkingChars,
                    tail: fullOutputText.slice(debugLogBody ? -2000 : -200),
                });
                if (debugLogBody && fullOutputText) {
                    logger.info("response.text", {
                        length: fullOutputText.length,
                        text: fullOutputText.slice(0, 8000),
                        truncated: fullOutputText.length > 8000,
                    });
                }
            } catch (err) {
                // User cancellation / timeout → re-throw so the outer catch handles them
                if (token.isCancellationRequested) {
                    throw err;
                }
                if (abortController.signal.aborted) {
                    throw new Error(l10n("Request timed out. The generation took too long. You can increase the timeout in settings (amdTokenFactory.requestTimeout)."));
                }
                if (isKeyRotationError(err)) {
                    const rawReason = getKeyRotationReason(err);
                    // Transient errors (platform busy / rate limit) must be kept
                    // cooldown-only (never persisted unavailable) so the
                    // whole-round auto retry can actually re-pick the keys.
                    const reason =
                        isTransientRetryError(err) && !isTransientExhaustedReason(rawReason)
                            ? "server_error"
                            : rawReason;
                    failedKeys.set(currentEntry.value, reason);
                    await markApiKeyExhausted(this.secrets, currentEntry.value, reason);
                    logger.warn("key.rotation", {
                        key: maskApiKey(currentEntry.value),
                        reason,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue; // try next key
                }
                logger.error("request.failed", {
                    model: model.id,
                    key: maskApiKey(currentEntry.value),
                    error: err instanceof Error ? err.message : String(err),
                });
                throw err; // non-rotation error (400/403/network…)
            } finally {
                clearTimeout(timeoutId);
                timeoutId = undefined;
                this._lastRequestTime = Date.now();
            }

            // Success — self-heal if this key was previously marked unavailable
            if (currentEntry.available === false) {
                await markApiKeyAvailable(this.secrets, currentEntry.value);
                logger.info("key.recovered", { key: maskApiKey(currentEntry.value) });
            }

            // Fallback: if API did not return usage data, estimate output tokens
            // (~4 chars/token) for the native indicator.
            if (!usageReportedDuringStream) {
                const outputText = collectedOutputText.join("");
                const estimatedOutputTokens = outputText ? Math.ceil(outputText.length / 4) : 0;
                reportNativeUsage(
                    {
                        promptTokens: 0,
                        completionTokens: estimatedOutputTokens,
                    },
                    progress
                );
            }
            break;
        }
    }

    /**
     * Ensure at least one API key exists. When no key is configured, prompts the
     * user to enter one (saved into the multi-key store). Returns the first key
     * entry if any exists, undefined otherwise.
     */
    private async ensureApiKey(): Promise<ApiKeyEntry | undefined> {
        const store = await getApiKeyStore(this.secrets);
        if (store.keys.length > 0) {
            return store.keys[0];
        }

        const entered = await vscode.window.showInputBox({
            title: l10n("AMD TokenFactory Provider API Key"),
            prompt: l10n("Enter your AMD TokenFactory API key (rc-...)"),
            ignoreFocusOut: true,
            password: true,
        });
        if (entered && entered.trim()) {
            const added = await addApiKey(this.secrets, { value: entered.trim(), available: null });
            if (added) {
                const updated = await getApiKeyStore(this.secrets);
                return updated.keys[0];
            }
        }
        return undefined;
    }
}

/**
 * Read the configured base URL.
 */
function getBaseUrl(): string {
    return vscode.workspace.getConfiguration("amdTokenFactory").get<string>(
        "baseUrl",
        "https://developer.amd.com.cn/radeon/api/v1"
    );
}
