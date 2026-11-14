import type { ApiKeyEntry } from "./types";
import { getApiModelIds } from "../models/apiModelList";
import { API_BASE_URL, FALLBACK_TEST_MODEL_ID } from "../platform/platformConfig";

/**
 * Key 可用性手动检测（通用能力，与平台无关）。
 *
 * 判据是**最小真实聊天请求**（`say ok` + `max_tokens=8`）——返回不报错即模型可用。
 * 余额不足由 API 返回 402 判定（不消耗 token）。
 *
 * 判定规则（明确、可预期）：
 * - 2xx            → 可用
 * - 401            → 不可用（key 无效 / 封号，API 层不可区分）
 * - 402 / 余额不足  → 不可用（当日额度耗尽）
 * - 429            → 可用（鉴权已通过，只是模型并发/限流；key 本身有效）
 * - 400 / 404 / 5xx → 测试模型选错或平台侧异常，换下一个候选模型重试
 * - 网络错误 / 全部候选超时 → 无法确认
 *
 * ⚠️ 测试模型不能只取 `/v1/models` 的第一个：列表第一个通常是平台最热门的模型
 * （如 `DeepSeek-V4.1-Flash`），长期处于并发上限返回 429，会让检测永远落到
 * "无法确认"。2026-11-14 实测：可用 key 打 `DeepSeek-V4.1-Flash` 恒 429
 * （`at its concurrency limit (192)`），打 `DeepSeek-V4-Flash` / `GLM-5.3-Flash` /
 * `Qwen3.8-27B` / `Gemma-4-31B-IT` / `MiMo-V2.6-Flash` 均 200。
 * 因此按候选列表依次尝试，遇到"模型不支持/不存在"类错误换下一个。
 *
 * ⚠️ 单个候选超时也必须换下一个（不能直接判无法确认）：`Gemma-4-31B-IT` 实测
 * 首次请求 28.3s，而其他模型 1-7s。超时只说明该模型慢，不代表 key 无效。
 */

/** 单个候选模型的请求超时（毫秒）。`Gemma-4-31B-IT` 实测首次 28.3s，需留余量。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 全部候选尝试的总时间预算（毫秒）——避免慢模型把检测拖成分钟级。 */
const TOTAL_BUDGET_MS = 60_000;
/** 最多尝试多少个候选测试模型（模型不支持/不存在时换下一个）。 */
const MAX_TEST_MODELS = 5;

/** 检测结论原因。 */
export type AvailabilityReason = "balance" | "invalid" | "rateLimited" | "network";

/**
 * 候选测试模型 ID（按优先级，去重）。
 *
 * 1. `/v1/models` 缓存里的 chat 模型（已过滤非 chat 端点）
 * 2. 缓存为空时用**被测 key** 拉一次列表（否则只剩单个兜底模型，
 *    一旦它限流/超时就无候选可换，可用 key 会被误判为"无法确认"）
 * 3. 拉取也失败 → 兜底模型 ID
 */
async function pickTestModelIds(apiKey: string): Promise<string[]> {
    const ids = [...(await getApiModelIds(apiKey))];
    if (ids.length === 0) {
        return [FALLBACK_TEST_MODEL_ID];
    }
    // 去重（缓存理论上已唯一，但兜底模型可能也在列表里）
    return [...new Set(ids)].slice(0, MAX_TEST_MODELS);
}

/**
 * 手动检测 key 可用性：最小真实聊天请求。
 *
 * 判定：
 * - 聊天请求 2xx → { ok: true }
 * - 聊天请求 402 / INSUFFICIENT_BALANCE / "余额不足" → { ok: false, reason: "balance" }
 * - 聊天请求 401 → { ok: false, reason: "invalid" }
 * - 聊天请求 429 → 鉴权已通过（key 有效），换下一个候选模型再试；
 *   全部候选都 429 时返回 { ok: true, reason: "rateLimited" }
 * - 单个候选超时 → 换下一个候选（慢模型不代表 key 无效）
 * - 网络错误 / 全部候选超时 → { ok: null, reason: "network" }（无法确定，保留原状态）
 *
 * @returns reason: "balance" | "invalid" | "rateLimited" | "network" | undefined
 */
export async function testKeyAvailability(
    entry: ApiKeyEntry,
    baseUrl?: string
): Promise<{ ok: boolean | null; reason?: AvailabilityReason }> {
    const normalized = (baseUrl ?? API_BASE_URL).replace(/\/+$/, "");
    const url = normalized.endsWith("/v1")
        ? `${normalized}/chat/completions`
        : `${normalized}/v1/chat/completions`;

    const candidates = await pickTestModelIds(entry.value);
    const startedAt = Date.now();
    let sawRateLimit = false;

    for (const testModelId of candidates) {
        // 总预算耗尽：不再尝试剩余候选（避免慢模型把检测拖成分钟级）
        if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
            break;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${entry.value}`,
                },
                body: JSON.stringify({
                    model: testModelId,
                    messages: [{ role: "user", content: "say ok" }],
                    stream: false,
                    max_tokens: 8,
                }),
                signal: controller.signal,
            });

            if (response.ok) {
                return { ok: true };
            }
            const text = await response.text();
            if (response.status === 402 || text.includes("INSUFFICIENT_BALANCE") || text.includes("余额不足")) {
                return { ok: false, reason: "balance" };
            }
            if (response.status === 401) {
                return { ok: false, reason: "invalid" };
            }
            if (response.status === 429) {
                // 429 = 鉴权已通过，只是该模型并发/限流 → key 本身有效。
                // 换下一个候选模型再试（拿到真正的 200 更准确）；全部 429 时按可用处理。
                sawRateLimit = true;
                continue;
            }
            // 400 "model not supported" / 404 / 5xx：测试模型选错或平台侧异常，
            // 换下一个候选模型再试。
        } catch {
            if (controller.signal.aborted) {
                // 本次请求超时：只说明该模型慢（如 Gemma-4-31B-IT 实测 28s），
                // 不代表 key 无效 → 换下一个候选模型继续。
                continue;
            }
            // 网络错误：换模型也一样，直接判无法确认。
            return { ok: null, reason: "network" };
        } finally {
            clearTimeout(timer);
        }
    }

    if (sawRateLimit) {
        // 所有候选模型都限流：鉴权已通过（无效 key 会返回 401），key 有效。
        return { ok: true, reason: "rateLimited" };
    }
    return { ok: null, reason: "network" };
}
