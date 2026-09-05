/**
 * AMD TokenFactory 多 API Key 管理模块。
 *
 * 负责：
 * - SecretStorage 中多 key 的存取（`amdTokenFactory.apiKeys`）
 * - rotation（轮询）/ sticky（固定）两种模式的选择逻辑
 * - key 可用性状态（持久化 `available` + 瞬态冷却）
 * - 轮换错误判定（按状态码 + 错误文本 patterns）
 * - 脱敏显示辅助
 *
 * 与 TokenRhythm 版的差异：免费端点无余额/无 cookie 概念，因此
 * 没有 cookie 绑定、余额预检与 single 模式。
 */
import * as vscode from "vscode";
import { logger } from "./logger";

/** 单个 API Key 条目 */
export interface ApiKeyEntry {
    /** API Key 值（rc-...） */
    value: string;
    /** 可选备注 */
    label?: string;
    /** 可用性：true=可用 / false=不可用(失效) / null=未检测 */
    available?: boolean | null;
    /** 最近一次检测时间戳（ms） */
    lastCheckedAt?: number;
}

/** 完整 store（SecretStorage JSON 结构） */
export interface ApiKeyStore {
    keys: ApiKeyEntry[];
}

const STORE_KEY = "amdTokenFactory.apiKeys";

/** 内存缓存：避免每次读取都访问 SecretStorage */
let storeCache: ApiKeyStore | null = null;

/** 轮询游标：模块级，跨请求共享。rotation 模式选中后前移（顺序轮换）；sticky 模式选中后钉住不前移（固定使用） */
let rotationIndex = 0;

/** 瞬态失效表：429 限流等"可能恢复"的失效，带冷却时间 */
const transientExhausted = new Map<string, { exhaustedAt: number; reason: string }>();

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("amdTokenFactory");
}

/** 读取 key 使用模式（默认 rotation；非法值回退 rotation） */
export function getApiKeyMode(): "rotation" | "sticky" {
    const mode = getConfig().get<string>("apiKeyMode", "rotation");
    return mode === "sticky" ? "sticky" : "rotation";
}

/** 读取当前轮询/粘性游标下标（供 UI 标记 sticky 模式下固定的 key） */
export function getRotationCursorIndex(): number {
    return rotationIndex;
}

/** 读取触发轮换的状态码列表（默认 [401, 429, 500, 502, 503, 504]） */
export function getRotationStatusCodes(): number[] {
    const codes = getConfig().get<number[]>("apiKeyRotationStatusCodes", [401, 429, 500, 502, 503, 504]);
    return Array.isArray(codes) ? codes : [401, 429, 500, 502, 503, 504];
}

/** 读取触发轮换的错误文本 patterns */
export function getRotationErrorPatterns(): string[] {
    const patterns = getConfig().get<string[]>("apiKeyRotationErrorPatterns", [
        "rate limit",
        "rate_limit",
        "concurrency",
        "invalid bearer token",
        "invalid api key",
        "unauthorized",
        "quota",
    ]);
    return Array.isArray(patterns) ? patterns : [];
}

/** 读取触发"瞬态整轮自动重试"的状态码列表（默认 [429, 500, 502, 503, 504]） */
export function getTransientRetryStatusCodes(): number[] {
    const codes = getConfig().get<number[]>("transientRetryStatusCodes", [429, 500, 502, 503, 504]);
    return Array.isArray(codes) ? codes : [429, 500, 502, 503, 504];
}

/** 读取 429 瞬态冷却时长（分钟，默认 5） */
export function getExhaustedCooldownMin(): number {
    const v = getConfig().get<number>("exhaustedCooldownMin", 5);
    return Number.isFinite(v) && v >= 0 ? v : 5;
}

/** 读取瞬态失败整轮自动重试次数（默认 3，夹取 0-10） */
export function getTransientRetryTimes(): number {
    const v = getConfig().get<number>("transientRetryTimes", 3);
    if (!Number.isFinite(v)) {
        return 3;
    }
    return Math.min(10, Math.max(0, Math.floor(v)));
}

// ---------------------------------------------------------------------------
// 存储读写
// ---------------------------------------------------------------------------

/**
 * 读取 API Key store。JSON 损坏时返回空 store。结果缓存到内存。
 */
export async function getApiKeyStore(secrets: vscode.SecretStorage): Promise<ApiKeyStore> {
    if (storeCache) {
        return storeCache;
    }

    let store: ApiKeyStore = { keys: [] };
    const raw = await secrets.get(STORE_KEY);
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as Partial<ApiKeyStore>;
            if (Array.isArray(parsed.keys)) {
                store = {
                    keys: parsed.keys
                        .filter((k) => k && typeof k.value === "string" && k.value.trim().length > 0)
                        .map((k) => ({
                            value: k.value.trim(),
                            label: k.label,
                            available: k.available ?? null,
                            lastCheckedAt: k.lastCheckedAt,
                        })),
                };
            }
        } catch (err) {
            logger.warn("keyManager.store.parse", { error: err instanceof Error ? err.message : String(err) });
        }
    }

    storeCache = store;
    return store;
}

/**
 * 保存 API Key store 到 SecretStorage。
 */
export async function saveApiKeyStore(secrets: vscode.SecretStorage, store: ApiKeyStore): Promise<void> {
    await secrets.store(STORE_KEY, JSON.stringify(store));
    storeCache = store;
}

/** 使内存缓存失效（外部修改 SecretStorage 时调用） */
export function invalidateApiKeyStoreCache(): void {
    storeCache = null;
}

// ---------------------------------------------------------------------------
// 脱敏显示
// ---------------------------------------------------------------------------

/** 脱敏 API Key：`rc-****abcd` */
export function maskApiKey(key: string): string {
    if (key.length <= 8) {
        return `${key.slice(0, 2)}****`;
    }
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 可用性判断
// ---------------------------------------------------------------------------

/** 是否处于瞬态冷却中（429 等），返回剩余秒数 */
export function getTransientExhaustedInfo(keyValue: string): { reason: string; remainingSec: number } | undefined {
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
 * 是否存在处于瞬态冷却中的 key（限流/服务端繁忙）。
 * 供"全部 key 不可选"时判断是否值得自动重试整轮（限流通常很快恢复）。
 */
export async function hasTransientExhaustedKey(secrets: vscode.SecretStorage): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    return store.keys.some((entry) => getTransientExhaustedInfo(entry.value) !== undefined);
}

/**
 * 判断错误是否应触发 key 轮换。
 * 匹配规则：状态码出现在配置列表 `[code]`/`status code`，或错误文本包含任一 patterns。
 */
export function isKeyRotationError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const statusCodes = getRotationStatusCodes();
    const patterns = getRotationErrorPatterns();

    // 状态码匹配：`[401]` / `status 401` 形式
    for (const code of statusCodes) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }
    // 文本匹配（不区分大小写）
    for (const pattern of patterns) {
        if (pattern && message.includes(pattern.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * 判断错误是否为"瞬态类"（限流/服务端繁忙，可能很快恢复 → 值得整轮自动重试）。
 * 匹配 `amdTokenFactory.transientRetryStatusCodes`（默认 [429, 500, 502, 503, 504]）。
 */
export function isTransientRetryError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    for (const code of getTransientRetryStatusCodes()) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// 选择逻辑
// ---------------------------------------------------------------------------

/**
 * 获取主 key（模型列表 / 检测可用性等"任意有效 key 即可"的场景）。
 * 从游标环形扫描第一个可用 key。全部不可用时返回 undefined。
 */
export async function getPrimaryApiKey(secrets: vscode.SecretStorage): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    for (let i = 0; i < store.keys.length; i++) {
        const entry = store.keys[(rotationIndex + i) % store.keys.length];
        if (isApiKeyEligible(entry)) {
            return entry;
        }
    }
    return undefined;
}

/**
 * 选择下一个要使用的 key。
 * - rotation：从游标开始环形扫描第一个可用 key，游标前移一位（每次请求都换 key）
 * - sticky：从游标开始环形扫描第一个可用 key，游标钉住不前移（固定使用该 key，
 *   仅当它失效——401/429/5xx 等——变 ineligible 后下次才会切到下一个并钉住；
 *   原 key 恢复后不自动切回，保持前缀缓存亲和性）
 */
export async function pickNextApiKey(
    secrets: vscode.SecretStorage,
    mode: "rotation" | "sticky"
): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    // 从 rotationIndex 开始顺序查找第一个 eligible 的 key
    for (let i = 0; i < store.keys.length; i++) {
        const idx = (rotationIndex + i) % store.keys.length;
        const entry = store.keys[idx];
        if (isApiKeyEligible(entry)) {
            if (mode === "rotation") {
                rotationIndex = (idx + 1) % store.keys.length; // 游标前移到下一个
            } else {
                rotationIndex = idx; // sticky：钉住当前 key，不前移
            }
            return entry;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 状态更新
// ---------------------------------------------------------------------------

/**
 * 瞬态失效原因：仅做内存冷却，不持久化 available=false。
 * （429 限流 / 5xx 服务端繁忙等"可能很快恢复"的错误——持久化会导致 key 在本会话永久不可用）
 */
const TRANSIENT_REASONS = new Set(["rate_limited", "server_error"]);

/** 是否为瞬态失效原因（429 限流 / 5xx 服务端繁忙） */
export function isTransientExhaustedReason(reason: string): boolean {
    return TRANSIENT_REASONS.has(reason);
}

/**
 * 从轮换错误中提取失效原因。
 * 基于状态码与错误文本（比 patterns 匹配更精确）：
 * - 401 / invalid bearer token → "invalid"
 * - 429 / rate limit / concurrency → "rate_limited"
 * - 5xx → "server_error"
 * - 其他（文本 patterns 命中的轮换错误）→ "api_error"
 */
export function getKeyRotationReason(err: unknown): string {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (message.includes("[401]") || message.includes("status 401") || message.includes("invalid bearer token") || message.includes("invalid api key")) {
        return "invalid";
    }
    if (message.includes("[429]") || message.includes("status 429") || message.includes("rate limit") || message.includes("rate_limit") || message.includes("concurrency")) {
        return "rate_limited";
    }
    if (message.includes("[500]") || message.includes("status 500") || message.includes("[502]") || message.includes("status 502") || message.includes("[503]") || message.includes("status 503") || message.includes("[504]") || message.includes("status 504")) {
        return "server_error";
    }
    return "api_error";
}

/**
 * 获取 key 当前不可用的机器可读原因（供"全部 key 不可用"报错展示）：
 * - 瞬态冷却中（429/5xx）→ "rate_limited" / "server_error"
 * - 持久化不可用（available=false）→ "unavailable"
 * - 其他 → "unknown"
 */
export function getKeyUnavailableReason(entry: ApiKeyEntry): string {
    const transient = getTransientExhaustedInfo(entry.value);
    if (transient) {
        return transient.reason;
    }
    if (entry.available === false) {
        return "unavailable";
    }
    return "unknown";
}

/**
 * 标记 key 为不可用。
 * - 瞬态原因（rate_limited/server_error）→ 仅记录内存冷却，不持久化 available=false
 * - 确定性原因（invalid/api_error）→ 持久化 available=false
 */
export async function markApiKeyExhausted(secrets: vscode.SecretStorage, keyValue: string, reason: string): Promise<void> {
    if (TRANSIENT_REASONS.has(reason)) {
        // 瞬态：只冷却，不持久化（冷却到期自动恢复）
        transientExhausted.set(keyValue, { exhaustedAt: Date.now(), reason });
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
    transientExhausted.delete(keyValue);
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
        transientExhausted.delete(keyValue);
    }
    await saveApiKeyStore(secrets, store);
}

/** 清空瞬态冷却；可选将所有持久化不可用标记重置为 null（未检测） */
export async function resetExhaustedKeys(secrets: vscode.SecretStorage, resetPersisted: boolean): Promise<void> {
    transientExhausted.clear();
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

// ---------------------------------------------------------------------------
// 增删改
// ---------------------------------------------------------------------------

/** 添加 key（校验重复值）；可选附带 label */
export async function addApiKey(secrets: vscode.SecretStorage, entry: ApiKeyEntry): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.some((k) => k.value === entry.value)) {
        return false; // 已存在
    }
    store.keys.push({
        value: entry.value,
        label: entry.label,
        available: entry.available ?? null,
    });
    await saveApiKeyStore(secrets, store);
    return true;
}

/** 批量添加 key（校验重复值），返回 { added, skipped } 计数 */
export async function addApiKeys(
    secrets: vscode.SecretStorage,
    entries: ApiKeyEntry[]
): Promise<{ added: number; skipped: number }> {
    const store = await getApiKeyStore(secrets);
    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
        const value = entry.value.trim();
        if (!value || store.keys.some((k) => k.value === value)) {
            skipped++;
            continue;
        }
        store.keys.push({ value, label: entry.label, available: null });
        added++;
    }
    if (added > 0) {
        await saveApiKeyStore(secrets, store);
    }
    return { added, skipped };
}

/** 更新 key 的备注 */
export async function updateApiKey(
    secrets: vscode.SecretStorage,
    oldValue: string,
    update: { label?: string }
): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const entry = store.keys.find((k) => k.value === oldValue);
    if (!entry) {
        return;
    }
    if (update.label !== undefined) {
        entry.label = update.label || undefined;
    }
    await saveApiKeyStore(secrets, store);
}

/** 删除指定 key（按值匹配），同时清瞬态冷却 */
export async function removeApiKey(secrets: vscode.SecretStorage, keyValue: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const idx = store.keys.findIndex((k) => k.value === keyValue);
    if (idx < 0) {
        return;
    }
    store.keys.splice(idx, 1);
    transientExhausted.delete(keyValue);
    // 游标越界时回绕
    if (rotationIndex >= store.keys.length) {
        rotationIndex = 0;
    }
    await saveApiKeyStore(secrets, store);
}
