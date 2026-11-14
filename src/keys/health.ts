import * as vscode from "vscode";
import { getErrorRules, getExhaustedCooldownMin, type ErrorAction, type ErrorRule } from "./config";
import { getTransientExhaustedMap } from "./state";
import { getApiKeyStore, saveApiKeyStore } from "./store";
import type { ApiKeyEntry, KeyDisplayStatus } from "./types";
import { l10n } from "../core/localize";

/**
 * Key 可用性状态：瞬态冷却、轮换错误判定、失效原因提取与状态更新。
 */

/**
 * 无 `detail` 字段的规则按 HTTP 状态码展示时的文案（l10n key，英文原文）。
 */
const STATUS_REASON_LABELS: Record<number, string> = {
    401: "Key invalid",
    402: "Balance insufficient",
    429: "Rate limited",
    500: "Server error",
    502: "Gateway error",
    503: "Server busy",
    504: "Gateway timeout",
};

/**
 * 获取规则的展示文案（供日志 / "全部 key 不可用"报错 / 失效原因显示）。
 *
 * - 规则带 `detail` → `l10n(detail)`（翻译缺失时原样显示 detail 文本，
 *   如 "invalid bearer token" → 中文环境显示 "无效 key"）
 * - 无 `detail` → 按 `statusCode` 查 `STATUS_REASON_LABELS` 后 `l10n()`
 */
export function getErrorRuleReason(rule: ErrorRule): string {
    if (rule.detail) {
        return l10n(rule.detail);
    }
    return l10n(STATUS_REASON_LABELS[rule.statusCode ?? 0] ?? "API error");
}

/**
 * 从错误消息中提取错误响应体的 `detail` 字段值（小写）。
 *
 * AMD TokenFactory 错误体格式为 `{"detail":"Invalid bearer token"}`（无
 * `error.code`），provider 抛出的错误消息内含原始响应体 JSON，用正则提取
 * 第一个 `"detail":"<value>"` 的值供 `detail` 规则做子串匹配。
 */
function extractErrorDetail(message: string): string | undefined {
    const m = message.match(/"detail"\s*:\s*"([^"]*)"/);
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
 * 匹配错误分类规则（三元组：statusCode + detail + action）。
 *
 * 单条规则内匹配优先级：
 * 1. **`detail`**：错误响应体的 `detail` 字段**子串匹配**（大小写不敏感）——
 *    AMD 错误体格式 `{"detail":"..."}`（无 `error.code`），按错误文本分类
 * 2. **`statusCode`**：HTTP 状态码（匹配 `[code]` / `status code` 形式）
 *
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
    const errorDetail = extractErrorDetail(message);
    // 错误对象上附加的 HTTP 状态码（`withHttpStatus()`，apiDispatch / httpClient 抛错时写入）。
    // 比从消息文本里正则提取更可靠：消息可能被包装/截断，导致 `[401]` 丢失而误落到其它规则。
    const attachedStatus = (err as { status?: unknown } | null | undefined)?.status;
    const statusCode = typeof attachedStatus === "number" ? attachedStatus : undefined;
    for (const rule of getErrorRules()) {
        // 1. 错误体 detail 字段子串匹配（AMD 格式 {"detail":"..."}）
        if (
            rule.detail &&
            errorDetail !== undefined &&
            errorDetail.includes(rule.detail.toLowerCase())
        ) {
            return rule;
        }
        // 2. HTTP 状态码（优先读错误对象上的 status，其次匹配消息文本）
        if (
            typeof rule.statusCode === "number" &&
            (statusCode === rule.statusCode ||
                message.includes(`[${rule.statusCode}]`) ||
                new RegExp(`\\bstatus ${rule.statusCode}\\b`).test(message))
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
 * 获取 key 当前不可用的原因（供"全部 key 不可用"报错展示）：
 * - 瞬态冷却中 → 冷却表里存的展示文案（`getErrorRuleReason()` 的输出，
 *   如 "Rate limited" / "无效 key"，本身是 l10n key）
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
 * 是规则的展示文案（`getErrorRuleReason()` 的输出，如 "无效 key"），若靠它
 * 推断会把 429 误持久化为不可用。
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
    // 持久化失效是确定性结论，必须清掉可能残留的瞬态冷却条目：
    // 否则 `getKeyDisplayStatus()` 会先命中冷却分支，把「不可用」显示成
    // 「冷却中 (Ns)」，冷却到期后才露出真相（用户报的「401 只标成 1 分钟冷却」）。
    getTransientExhaustedMap().delete(keyValue);
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
    // 手动检测是确定性结论（可用 / 不可用 / 未检测），一律清掉陈旧冷却条目：
    // 否则显示层会把「不可用」遮成「冷却中」，或让已恢复的 key 继续被跳过。
    getTransientExhaustedMap().delete(keyValue);
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
    // 持久化不可用（401/402 等确定性失效）优先于瞬态冷却：两者可能同时存在
    // （先 429 冷却、后 401 失效），此时必须显示「不可用」——否则冷却窗口内
    // 会一直显示「冷却中 (Ns)」，看起来像 401 只被标成了短暂冷却。
    if (entry.available === false) {
        return "unavailable";
    }
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return "cooldown";
    }
    if (entry.available === true) {
        return "available";
    }
    return "unknown";
}
