import * as vscode from "vscode";
import type { CancellationToken } from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import { CommonApi } from "../api/commonApi";
import {
    getApiKeyMode,
    getApiKeyStore,
    getSingleKeyFallback,
    getTransientRetryTimes,
    hasTransientExhaustedKey,
    markApiKeyAvailable,
    markApiKeyExhausted,
    maskApiKey,
    matchErrorRule,
    pickNextApiKey,
    setActiveKeyByValue,
    shouldSingleKeyFallbackSwitch,
    type ApiKeyEntry,
    type ErrorRule,
} from "../keys/keyManager";
import { buildAllKeysUnavailableDetail, TransientRetryExhaustedError, tryTransientRetryRound, VisionRoundError } from "./errors";

/**
 * 多 API Key 轮换循环。
 *
 * 每轮选一个 key，跳过余额不足（cookie 主动预检）或返回轮换错误
 * （401/402/429/503，状态码与文本 patterns 可配置）的 key。
 * 全部 key 用尽时列出脱敏 key + 失败原因；若失败均为瞬态（429/503）
 * 则按 `amdTokenFactory.transientRetryTimes` 指数退避重试整轮。
 *
 * **平台侧瞬态错误（如 500）不换 key**：500 是平台内部错误，与 key 无关，
 * 换 key 无意义。这类错误命中 `errorRules` 的 `retrySameKey` 动作（而非
 * `rotateCooldown` / `rotatePersist`）时，仅退避后重试同一个 key（key 不标记失效）。
 *
 * 从 `provider.ts` 抽出，使 Provider 类只负责 VS Code 接口与编排。
 */

export interface RotationLoopParams {
    secrets: vscode.SecretStorage;
    token: CancellationToken;
    abortController: AbortController;
    /** 用选中的 key 执行一次完整请求（协议分发 + 视觉代理）。 */
    execute: (apiKey: string, requestHeaders: Record<string, string>) => Promise<void>;
    /** 模型自定义请求头（来自模型配置）。 */
    customHeaders?: Record<string, string>;
    /** 协议模式，用于构造请求头（anthropic 用 x-api-key）。 */
    apiMode: string;
    /**
     * 是否已向用户输出过内容（文本/推理/工具调用）。若为 true，则**不再换 key
     * 重跑**——重跑会把已显示的答案再输出一遍。由 provider.ts 的 progress 包装
     * 维护。
     */
    hasEmittedOutput?: () => boolean;
    /** 成功使用 fallback key 后的通知回调（single 模式余额不足自动切换）。 */
    onFallbackSwitch?: (entry: ApiKeyEntry) => void;
}

/**
 * 运行轮换循环直到成功、用户取消、超时或全部 key 失败。
 * 失败时抛出带脱敏详情的错误。
 */
export async function runKeyRotationLoop(params: RotationLoopParams): Promise<void> {
    const { secrets, token, abortController, execute, customHeaders, apiMode } = params;

    const apiKeyMode = getApiKeyMode();
    const singleFallback = getSingleKeyFallback();
    let currentEntry: ApiKeyEntry | undefined;
    let usedFallbackKey = false; // single mode performed a balance-triggered switch
    // Platform-side transient error (e.g. 500) retry: force re-use of the
    // SAME key on the next round. Without this, rotation mode's cursor has
    // already advanced and pickNextApiKey would silently switch to the next
    // key — contradicting "500 is a platform problem, do not rotate keys".
    let forceKey: ApiKeyEntry | undefined;
    // Track per-key failure rules so the "all keys exhausted" error can
    // show which key failed and why (masked), and distinguish transient
    // failures (rotateCooldown — retry later) from permanent ones
    // (rotatePersist — check).
    const failedKeys = new Map<string, ErrorRule>();
    // Transient (429/503) whole-round auto-retry: when every key is busy or
    // rate-limited, wait with backoff and retry the whole round instead of
    // failing immediately (platform congestion usually clears within seconds).
    const maxTransientRetries = getTransientRetryTimes();
    // Per-scenario retry counters: a 500 same-key retry must not consume the
    // 429/503 whole-round retry quota (and vice versa) — otherwise a few 500s
    // could exhaust the quota and give up on a recoverable rate-limit burst.
    let wholeRoundRetryCount = 0; // all keys transient-failed / none eligible
    let sameKeyRetryCount = 0; // platform-side error, retry same key

    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        logger.warn("apiKey.missing", {});
        throw new Error(l10n("API key not found"));
    }
    const totalKeys = store.keys.length;

    while (true) {
        // If every key has failed at least one round, stop trying.
        if (totalKeys > 0 && failedKeys.size >= totalKeys) {
            const detail = [...failedKeys.entries()]
                .map(([key, rule]) => `${maskApiKey(key)}: ${rule.message ?? rule.code ?? ""}`)
                .join("; ");
            const hasTransient = [...failedKeys.values()].some((r) => r.action === "rotateCooldown");
            // Platform busy / rate-limited: back off and retry the whole
            // round automatically instead of failing immediately.
            if (hasTransient && (await tryTransientRetryRound(secrets, wholeRoundRetryCount, maxTransientRetries))) {
                wholeRoundRetryCount++;
                failedKeys.clear();
                continue;
            }
            logger.warn("key.allUnavailable", { detail });
            if (hasTransient) {
                throw new Error(l10nFormat("All API keys are temporarily unavailable ({0}). Please retry later.", detail));
            }
            throw new Error(l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability, or reset exhausted states to recover keys that may have been marked unavailable by mistake.", detail));
        }

        // 1. Pick the next candidate key (forced re-use after a platform-side
        // transient error — the key itself is fine, do not rotate)
        currentEntry = forceKey ?? (await pickNextApiKey(secrets, apiKeyMode));
        forceKey = undefined;
        if (!currentEntry) {
            // single mode + fallback=switch → switch ONLY when the current
            // key is balance-exhausted (402 / balance pre-check failed this
            // round). Other rotation errors (401 invalid key, 429/503
            // transient) do NOT switch — they fail below (the transient
            // whole-round retry still applies for 429/503). On a balance
            // switch the new key also becomes the "current" key so later
            // requests use it directly (no repeated fallback+notification).
            if (
                apiKeyMode === "single" &&
                singleFallback === "switch" &&
                (await shouldSingleKeyFallbackSwitch(secrets, failedKeys))
            ) {
                usedFallbackKey = true;
                currentEntry = await pickNextApiKey(secrets, "rotation");
                if (currentEntry) {
                    await setActiveKeyByValue(secrets, currentEntry.value);
                    logger.info("key.singleSwitch", { key: maskApiKey(currentEntry.value) });
                }
            }
            if (!currentEntry) {
                // Every key is excluded (persisted unavailable / cooldown /
                // insufficient balance). If any key is merely in transient
                // cooldown (429/503), back off and retry the whole round.
                if (
                    (await hasTransientExhaustedKey(secrets)) &&
                    (await tryTransientRetryRound(secrets, wholeRoundRetryCount, maxTransientRetries))
                ) {
                    wholeRoundRetryCount++;
                    failedKeys.clear();
                    continue;
                }
                // Show why each key can't be used. In single mode only the
                // current key (plus any switched-to keys) were tried — use
                // a dedicated message instead of "all keys unavailable".
                const detail = await buildAllKeysUnavailableDetail(secrets);
                logger.warn("key.allUnavailable", { detail });
                if (apiKeyMode === "single") {
                    throw new Error(
                        l10nFormat(
                            "Current API key is unavailable ({0}). Single mode only switches keys on insufficient balance (402); retry later or check via the Manage API Keys command.",
                            detail
                        )
                    );
                }
                throw new Error(
                    l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability, or reset exhausted states to recover keys that may have been marked unavailable by mistake.", detail)
                );
            }
        }

        // 2. Prepare headers with the selected key
        const requestHeaders = CommonApi.prepareHeaders(currentEntry.value, apiMode, customHeaders);
        logger.debug("request.headers", {
            key: maskApiKey(currentEntry.value),
            headers: logger.sanitizeHeaders(requestHeaders as Record<string, string>),
        });

        // 3. Execute the full API request (protocol dispatch + vision proxy)
        try {
            await execute(currentEntry.value, requestHeaders);

            // Success — self-heal if this key was previously marked unavailable
            if (currentEntry.available === false) {
                await markApiKeyAvailable(secrets, currentEntry.value);
                logger.info("key.recovered", { key: maskApiKey(currentEntry.value) });
            }
            if (usedFallbackKey) {
                params.onFallbackSwitch?.(currentEntry);
            }
            return;
        } catch (err) {
            // User cancellation / timeout → re-throw so the outer catch handles them
            if (token.isCancellationRequested) {
                throw err;
            }
            if (abortController.signal.aborted) {
                throw err; // timeout (outer catch shows friendly message)
            }
            // 视觉代理轮内失败：主请求已成功、tool 上下文已建立，换 key 重跑整个
            // 请求会导致主回答重复输出。直接抛出，不轮换 key（由用户重试整个请求）。
            if (err instanceof VisionRoundError) {
                logger.warn("key.visionRoundFailed", {
                    key: maskApiKey(currentEntry.value),
                    error: err.message,
                });
                throw err;
            }
            // 已向用户输出过内容（流中途失败）：换 key 重跑会把已显示的答案再输出
            // 一遍。直接抛出，不轮换（与 commitMessageGenerator 的 response.length
            // 保护一致）。
            if (params.hasEmittedOutput?.()) {
                logger.warn("key.rotationSkippedAfterOutput", {
                    key: maskApiKey(currentEntry.value),
                    error: err instanceof Error ? err.message : String(err),
                });
                throw err;
            }
            // 错误分类（errorRules 四元组：code + message + statusCode + action）
            const rule = matchErrorRule(err);
            if (rule?.action === "rotateCooldown" || rule?.action === "rotatePersist") {
                // 换 key（冷却或持久化失效，由 action 决定）
                const reason = rule.message ?? rule.code ?? "";
                failedKeys.set(currentEntry.value, rule);
                await markApiKeyExhausted(secrets, currentEntry.value, reason, rule.action);
                logger.warn("key.rotation", {
                    key: maskApiKey(currentEntry.value),
                    reason,
                    action: rule.action,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue; // try next key
            }

            if (rule?.action === "retrySameKey") {
                // 不换 key，退避后重试同一个 key（平台侧/客户端侧瞬态问题）
                if (await tryTransientRetryRound(secrets, sameKeyRetryCount, maxTransientRetries)) {
                    sameKeyRetryCount++;
                    failedKeys.clear();
                    // Force the SAME key on the next round: the error is a
                    // platform/client-side problem, not a key problem.
                    forceKey = currentEntry;
                    logger.warn("key.transientRetrySameKey", {
                        key: maskApiKey(currentEntry.value),
                        attempt: sameKeyRetryCount,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue; // retry the whole round with the same key
                }
                logger.warn("key.transientRetryExhausted", {
                    key: maskApiKey(currentEntry.value),
                    attempts: sameKeyRetryCount,
                });
                // 重试次数用尽：包装为友好错误（原始 500/429 报错对用户过于原始）
                throw new TransientRetryExhaustedError(err, sameKeyRetryCount);
            }

            throw err; // 未命中任何规则（403/网络/IMAGE_SENSITIVE…）
        }
    }
}
