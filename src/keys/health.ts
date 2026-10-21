import * as vscode from "vscode";
import { getErrorRules, getExhaustedCooldownMin, type ErrorAction, type ErrorRule } from "./config";
import { getTransientExhaustedMap } from "./state";
import { getApiKeyStore, saveApiKeyStore } from "./store";
import type { ApiKeyEntry, KeyDisplayStatus } from "./types";

/**
 * Key 可用性状态：瞬态冷却、轮换错误判定、失效原因提取与状态更新。
 */

/**
 * 从错误消息中提取错误响应体的 `error.code` 字段值（小写）。
 *
 * 错误消息格式（provider 抛出）：`API error: [400] Bad Request\n{...json...}\nURL: ...`，
 * JSON 内含 `"code":"xxx"` 或 `"error":{"code":"xxx"}`。用正则提取第一个
 * `"code":"<value>"` 的值。
 */
function extractErrorCode(message: string): string | undefined {
    const m = message.match(/"code"\s*:\s*"([^"]+)"/);
    return m?.[1]?.toLowerCase();
}

/** 是否处于瞬态冷却中（429），返回剩余秒数 */
export function getTransientExhaustedInfo(keyValue: string): { reason: string; remainingSec: number } | undefined {
    const transientExhausted = getTransientExhaustedMap();
    const entry = transientExhausted.get(keyValue);
    if (!entry) {
        return undefined;
    }
    const cooldownMs = getExhaustedCooldownMin() * 60_000;
    if (cooldownMs <= 0) {
        // 冷却为 0：立即恢复
        transientExhausted.delete(keyValue);
        return undefined;
    }
    const remainingMs = entry.exhaustedAt + cooldownMs - Date.now();
    if (remainingMs <= 0) {
        transientExhausted.delete(keyValue);
        return undefined;
    }
    return { reason: entry.reason, remainingSec: Math.ceil(remainingMs / 1000) };
}

/** 判断 entry 是否可被选中（非冷却中、非持久化不可用） */
export function isApiKeyEligible(entry: ApiKeyEntry): boolean {
    if (entry.available === false) {
        return false;
    }
    return getTransientExhaustedInfo(entry.value) === undefined;
}

/**
 * 是否存在处于瞬态冷却中的 key（429 限流 / 503 服务端繁忙）。
 * 供"全部 key 不可选"时判断是否值得自动重试整轮（平台繁忙通常很快恢复）。
 */
export async function hasTransientExhaustedKey(secrets: vscode.SecretStorage): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    return store.keys.some((entry) => getTransientExhaustedInfo(entry.value) !== undefined);
}

/**
 * 匹配错误分类规则（四元组：code + message + statusCode + action）。
 *
 * **主要匹配错误响应体的 `error.code` 字段**（精确匹配，小写比较）；
 * `message` 仅作可读性说明不参与匹配；`statusCode` 兜底（匹配 `[code]` /
 * `status code` 形式，HTTP 400 被封号和上游中断复用，不能单独作为判据）。
 * 规则按 `errorRules` 数组顺序匹配，首个命中即生效；均未命中返回 undefined
 * （不轮换、不重试，直接抛错）。
 *
 * `action` 与 key 状态一一对应：
 * - `retrySameKey` → 状态不变（不换 key，退避后重试同一个 key）
 * - `rotateCooldown` → 冷却中（换 key，仅内存冷却，到期自动恢复）
 * - `rotatePersist` → 不可用（换 key，持久化 available=false）
 */
export function matchErrorRule(err: unknown): ErrorRule | undefined {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const errorCode = extractErrorCode(message);
    for (const rule of getErrorRules()) {
        // 主要匹配：错误体 error.code 精确匹配
        if (rule.code && errorCode === rule.code.toLowerCase()) {
            return rule;
        }
        // 兜底：HTTP 状态码
        if (
            typeof rule.statusCode === "number" &&
            (message.includes(`[${rule.statusCode}]`) || new RegExp(`\\bstatus ${rule.statusCode}\\b`).test(message))
        ) {
            return rule;
        }
    }
    return undefined;
}

/**
 * 判断错误是否应触发 key 轮换（换 key）。
 * 命中 `rotateCooldown` / `rotatePersist` 规则时换 key；`retrySameKey` 不换。
 */
export function isKeyRotationError(err: unknown): boolean {
    const rule = matchErrorRule(err);
    return rule !== undefined && rule.action !== "retrySameKey";
}

/**
 * 判断错误是否为"瞬态类"（值得整轮自动重试）。
 * 命中 `retrySameKey` / `rotateCooldown` 规则时为瞬态（`rotatePersist` 为确定性）。
 */
export function isTransientRetryError(err: unknown): boolean {
    const rule = matchErrorRule(err);
    return rule !== undefined && rule.action !== "rotatePersist";
}

/**
 * 从错误中提取失效原因（规则的 `message` 说明，供日志/报错展示）。
 * 均未命中返回 undefined。
 */
export function getKeyRotationReason(err: unknown): string | undefined {
    return matchErrorRule(err)?.message;
}

/**
 * 获取 key 当前不可用的机器可读原因（供"全部 key 不可用"报错展示）：
 * - 瞬态冷却中（429/503）→ "rate_limited" / "server_error"
 * - 持久化不可用（available=false）→ "unavailable"
 * - 其他（未检测 / 余额不足 / 封号）→ "balance"
 */
export function getKeyUnavailableReason(entry: ApiKeyEntry): string {
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return transient.reason;
    }
    if (entry.available === false) {
        return "unavailable";
    }
    return "balance";
}

/**
 * 标记 key 为不可用（由 `errorRules` 的 `action` 决定处置）。
 * - `rotateCooldown` → 仅记录内存冷却，不持久化 available=false（冷却到期自动恢复）
 * - `rotatePersist` → 持久化 available=false（重启后仍不可用，需手动重置或自愈）
 *
 * 注意：**处置由 `action` 决定，不再靠 `reason` 字符串推断**——`reason` 现在
 * 是规则的 `message` 说明（如 "限流"），若靠它推断会把 429 误持久化为不可用。
 */
export async function markApiKeyExhausted(
    secrets: vscode.SecretStorage,
    keyValue: string,
    reason: string,
    action: ErrorAction
): Promise<void> {
    if (action === "rotateCooldown") {
        // 瞬态：只冷却，不持久化（冷却到期自动恢复）
        getTransientExhaustedMap().set(keyValue, { exhaustedAt: Date.now(), reason });
        return;
    }
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = false;
    entry.lastCheckedAt = Date.now();
    await saveApiKeyStore(secrets, store);
}

/** 标记 key 为可用（自愈 / 手动检测通过），清瞬态冷却 */
export async function markApiKeyAvailable(secrets: vscode.SecretStorage, keyValue: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = true;
    entry.lastCheckedAt = Date.now();
    getTransientExhaustedMap().delete(keyValue);
    await saveApiKeyStore(secrets, store);
}

/** 通用可用性更新 */
export async function updateKeyAvailability(
    secrets: vscode.SecretStorage,
    keyValue: string,
    available: boolean | null
): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === keyValue);
    if (!entry) {
        return;
    }
    entry.available = available;
    entry.lastCheckedAt = Date.now();
    if (available !== false) {
        getTransientExhaustedMap().delete(keyValue);
    }
    await saveApiKeyStore(secrets, store);
}

/** 清空瞬态冷却；可选将所有持久化不可用标记重置为 null（未检测） */
export async function resetExhaustedKeys(secrets: vscode.SecretStorage, resetPersisted: boolean): Promise<void> {
    getTransientExhaustedMap().clear();
    if (resetPersisted) {
        const store = await getApiKeyStore(secrets);
        let changed = false;
        for (const entry of store.keys) {
            if (entry.available === false) {
                entry.available = null;
                entry.lastCheckedAt = undefined;
                changed = true;
            }
        }
        if (changed) {
            await saveApiKeyStore(secrets, store);
        }
    }
}

/** 获取 key 的展示状态：available / unavailable / unknown / cooldown */
export function getKeyDisplayStatus(entry: ApiKeyEntry): KeyDisplayStatus {
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return "cooldown";
    }
    if (entry.available === true) {
        return "available";
    }
    if (entry.available === false) {
        return "unavailable";
    }
    return "unknown";
}
