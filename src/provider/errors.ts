import * as vscode from "vscode";
import type { LanguageModelResponsePart, Progress, ProvideLanguageModelChatResponseOptions } from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import type { CommonApi, StreamUsage } from "../api/commonApi";
import { getApiKeyStore, getKeyUnavailableReason, maskApiKey, resetExhaustedKeys } from "../keys/keyManager";

/**
 * 视觉代理轮内失败标记错误。
 *
 * 主请求已成功、tool 上下文已建立，此时换 key 重跑整个请求会导致**主回答重复输出**
 * 并浪费 token。轮换循环（`rotation.ts`）识别此类型后**直接抛出、不轮换 key**，
 * 由用户重试整个请求。
 */
export class VisionRoundError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "VisionRoundError";
    }
}

/**
 * 瞬态错误（500/429/503）同 key 重试次数用尽后的友好错误。
 *
 * 原始错误（如 "API error: [500] Internal Server Error {...}"）对用户过于原始，
 * 包装为友好文案并保留原始错误信息作为后缀。`rotation.ts` 在
 * `retrySameKey` 分支重试耗尽时抛出此错误。
 */
export class TransientRetryExhaustedError extends Error {
    constructor(originalError: unknown, attempts: number) {
        const raw = originalError instanceof Error ? originalError.message : String(originalError);
        super(
            l10nFormat(
                "The server is busy or rate-limited. Retried {0} time(s) automatically without success. Please try again later.\n\nOriginal error: {1}",
                attempts,
                raw
            )
        );
        this.name = "TransientRetryExhaustedError";
    }
}

/**
 * Human-readable labels for key rotation failure reasons (keys are l10n keys).
 */
export const REASON_TEXT: Record<string, string> = {
    balance: "Balance insufficient",
    invalid: "Key invalid",
    rate_limited: "Rate limited (429)",
    server_error: "Server error (503)",
    api_error: "API error",
    unavailable: "Unavailable",
    banned: "Account banned (billing frozen)",
};

/**
 * Detect a finished stream that exhausted its token budget (finish/stop reason
 * "length" or "max_tokens") without producing any answer text. This happens
 * with reasoning models when thinking consumes the whole max_tokens budget
 * (historically auto-discovered models declared a 4096 cap as fallback), and
 * previously surfaced in Copilot Chat as "Sorry, no response was returned."
 * with zero explanation. Throwing a descriptive error makes the root cause
 * visible to the user and excludes this silent-empty path from the request logs.
 */
export function checkZeroAnswerBudgetExhausted(
    api: CommonApi<unknown, unknown>,
    collectedOutputText: readonly string[],
    modelId: string
): void {
    const finishReason = api.lastFinishReason;
    if (
        finishReason &&
        (finishReason === "length" || finishReason === "max_tokens") &&
        collectedOutputText.join("").trim().length === 0
    ) {
        logger.error("request.zeroAnswer", {
            modelId,
            finishReason,
        });
        throw new Error(
            l10nFormat(
                "The model used all available output tokens on reasoning ({0}, finish reason: {1}) and produced no answer. Lower the reasoning effort, or turn thinking off and retry.",
                modelId,
                finishReason
            )
        );
    }
}

/**
 * 构建"全部 API Key 均不可用"的脱敏原因详情（供报错信息展示）。
 * 遍历 store 中每个 key，用其当前状态（冷却中 / 持久化不可用 / 余额不足）
 * 生成 `sk_****abcd: 原因` 列表。
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
 * 瞬态失败（429/500/503）整轮自动重试辅助。
 *
 * 平台繁忙 / 限流 / 内部错误导致请求失败时，等待指数退避（2s/4s/8s，上限 8s）
 * 后重试整轮——**必须清空瞬态冷却**（`resetExhaustedKeys(secrets, false)`），
 * 否则冷却期间 `pickNextApiKey` 会跳过全部 key，重试永远不会真正发生。
 *
 * 两种调用场景：
 * 1. **全部 key 均因瞬态错误失败**（429/503）→ 清冷却后重试整轮，让 key 重新可选
 * 2. **平台侧错误但 key 无问题**（如 500）→ 不标记 key，仅退避后重试同一个 key
 *
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
 *
 * This is always active.
 */
export function reportNativeUsage(
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
            'usage'
        )
    );
}

/**
 * 从 VS Code 请求选项中解析用户选择的推理强度。
 * 依次检查 `modelConfiguration.reasoningEffort`、`modelOptions.thinking.type`、
 * `modelOptions.reasoning_effort` / `reasoningEffort`。
 */
export function getRequestedReasoningEffort(options: ProvideLanguageModelChatResponseOptions): string | undefined {
    const modelConfigurationEffort = options.modelConfiguration?.reasoningEffort;
    if (typeof modelConfigurationEffort === "string") {
        return modelConfigurationEffort;
    }

    const modelOptions = (options as unknown as { modelOptions?: Record<string, unknown> }).modelOptions;
    const modelOptionsThinking = modelOptions?.thinking as { type?: unknown } | undefined;
    if (modelOptionsThinking?.type === false) {
        return "disabled";
    }

    const modelOptionsEffort = modelOptions?.reasoning_effort ?? modelOptions?.reasoningEffort;
    return typeof modelOptionsEffort === "string" ? modelOptionsEffort : undefined;
}
