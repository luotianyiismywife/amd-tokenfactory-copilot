import type { ApiKeyEntry } from "./types";
import { getApiModelIds } from "../models/apiModelList";
import { API_BASE_URL, FALLBACK_TEST_MODEL_ID } from "../platform/platformConfig";

/**
 * Key 可用性手动检测（通用能力，与平台无关）。
 *
 * 判据是**最小真实聊天请求**（`say ok` + `max_tokens=8`）——返回不报错即模型可用。
 * 余额不足由 API 返回 402 判定（不消耗 token）。
 */

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Pick a test model for the minimal chat request: prefer the first model
 * from the cached /v1/models list (always current), fall back to a hardcoded
 * ID (FALLBACK_TEST_MODEL_ID in platformConfig) when the list is unavailable.
 */
async function pickTestModelId(): Promise<string> {
    const ids = await getApiModelIds(undefined);
    return ids.values().next().value ?? FALLBACK_TEST_MODEL_ID;
}

/**
 * 手动检测 key 可用性：最小真实聊天请求。
 *
 * 判定：
 * - 聊天请求 200 → { ok: true }
 * - 聊天请求 402 / INSUFFICIENT_BALANCE / "余额不足" → { ok: false, reason: "balance" }
 * - 聊天请求 401 → { ok: false, reason: "invalid" }
 * - 网络错误 / 超时 / 其他 → { ok: null, reason: "network" }（无法确定，保留原状态）
 *
 * @returns reason: "balance" | "invalid" | "network" | undefined
 */
export async function testKeyAvailability(
    entry: ApiKeyEntry,
    baseUrl?: string
): Promise<{ ok: boolean | null; reason?: "balance" | "invalid" | "network" }> {
    try {
        const normalized = (baseUrl ?? API_BASE_URL).replace(/\/+$/, "");
        const url = normalized.endsWith("/v1")
            ? `${normalized}/chat/completions`
            : `${normalized}/v1/chat/completions`;
        const testModelId = await pickTestModelId();
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
            return { ok: null, reason: "network" };
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return { ok: null, reason: "network" };
    }
}
