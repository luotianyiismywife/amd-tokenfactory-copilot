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
 * - 其他（400/404/5xx/网络/超时）→ 无法确认
 *
 * ⚠️ 测试模型不能只取 `/v1/models` 的第一个：列表第一个通常是平台最热门的模型
 * （如 `DeepSeek-V4.1-Flash`），长期处于并发上限返回 429，会让检测永远落到
 * "无法确认"。2026-11-14 实测：可用 key 打 `DeepSeek-V4.1-Flash` 恒 429
 * （`at its concurrency limit (192)`），打 `DeepSeek-V4-Flash` / `GLM-5.3-Flash` /
 * `Qwen3.8-27B` / `Gemma-4-31B-IT` / `MiMo-V2.6-Flash` 均 200。
 * 因此按候选列表依次尝试，遇到"模型不支持/不存在"类错误换下一个。
 */

const REQUEST_TIMEOUT_MS = 20_000;
/** 最多尝试多少个候选测试模型（模型不支持/不存在时换下一个）。 */
const MAX_TEST_MODELS = 5;

/** 检测结论原因。 */
export type AvailabilityReason = "balance" | "invalid" | "rateLimited" | "network";

/**
 * 候选测试模型 ID（按优先级，去重）。
 *
 * 1. `/v1/models` 缓存里的 chat 模型（已过滤非 chat 端点）
 * 2. 兜底模型 ID（缓存为空时）
 */
async function pickTestModelIds(): Promise<string[]> {
    const ids = [...(await getApiModelIds(undefined))];
    if (ids.length === 0) {
        return [FALLBACK_TEST_MODEL_ID];
    }
    return ids.slice(0, MAX_TEST_MODELS);
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
 * - 网络错误 / 超时 / 其他 → { ok: null, reason: "network" }（无法确定，保留原状态）
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

    const candidates = await pickTestModelIds();
    let sawRateLimit = false;

    for (const testModelId of candidates) {
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
            // 网络错误 / 超时：换模型也一样，直接判无法确认。
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
