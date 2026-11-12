import * as vscode from "vscode";
import type { ApiKeyMode, SingleKeyFallback } from "./types";

/**
 * API Key 相关配置读取。
 */

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("amdTokenFactory");
}

/** 读取 key 使用模式（默认 sticky；非法值回退 sticky） */
export function getApiKeyMode(): ApiKeyMode {
    const mode = getConfig().get<string>("apiKeyMode", "sticky");
    if (mode === "rotation" || mode === "single" || mode === "sticky") {
        return mode;
    }
    return "sticky";
}

/** 读取 single 模式不可用时的行为（默认 switch；非法值回退 switch） */
export function getSingleKeyFallback(): SingleKeyFallback {
    const fallback = getConfig().get<string>("singleKeyFallback", "switch");
    return fallback === "error" ? "error" : "switch";
}

/** 错误处置动作（与 key 状态一一对应） */
export type ErrorAction = "retrySameKey" | "rotateCooldown" | "rotatePersist";

/**
 * 单条错误分类规则（三元组：statusCode + detail + action）。
 *
 * - `statusCode`：HTTP 状态码（匹配错误消息中的 `[code]` / `status code` 形式）
 * - `detail`：错误响应体的 `detail` 字段（**子串匹配**，大小写不敏感，优先于
 *   `statusCode`）。AMD TokenFactory 错误体格式为
 *   `{"detail":"Invalid bearer token"}`（无 `error.code`），此字段用于按错误
 *   文本内容细分同状态码的不同错误（如区分"无效 key"与"账号封禁"——两者
 *   HTTP 状态码相同但文本不同）。**同时用作展示文案**：经 `l10n()` 翻译后
 *   显示（翻译缺失时原样显示 detail 文本）
 * - `action`：处置动作，与 key 状态一一对应：
 *   - `retrySameKey` → 状态不变（不换 key，退避后重试同一个 key）
 *   - `rotateCooldown` → 冷却中（换 key，仅内存冷却，到期自动恢复）
 *   - `rotatePersist` → 不可用（换 key，持久化 available=false）
 *
 * 规则按数组顺序匹配，单条规则内匹配优先级：`detail` → `statusCode`，
 * 首个命中即生效。
 */
export interface ErrorRule {
    detail?: string;
    statusCode?: number;
    action: ErrorAction;
}

/**
 * 默认错误分类规则。
 *
 * AMD TokenFactory 实测错误特征（错误体格式 `{"detail":"..."}`，无 `error.code`）：
 * - 401 无效 key（`detail: "Invalid bearer token"`；封号 key 同样返回 401 + 该文本，
 *   API 层与无效 key 不可区分）
 * - 429 限流（`rate limit` / `rate_limit` / `concurrency`）
 * - 500 平台内部错误（与 key 无关，不换 key）
 * - 502/503/504 网关/繁忙（换 key 冷却）
 *
 * 401 规则带 `detail` 子串匹配（AMD 实测签名）作主要判据，statusCode 兜底
 * （错误体无 `detail` 字段时仍按状态码命中）。
 */
const DEFAULT_ERROR_RULES: ErrorRule[] = [
    // 401：detail 子串匹配（AMD 实测签名）优先，statusCode 兜底
    // （错误体无 detail 字段时仍按状态码命中）
    { detail: "invalid bearer token", statusCode: 401, action: "rotatePersist" },
    { statusCode: 402, action: "rotatePersist" },
    { statusCode: 429, action: "rotateCooldown" },
    { statusCode: 502, action: "rotateCooldown" },
    { statusCode: 503, action: "rotateCooldown" },
    { statusCode: 504, action: "rotateCooldown" },
    { statusCode: 500, action: "retrySameKey" },
];

/**
 * 读取错误分类规则（三元组：statusCode + detail + action）。
 *
 * **只配置这一处**即可覆盖所有错误分类：单条规则内 `detail`（错误体 detail
 * 字段子串匹配，大小写不敏感，AMD 错误体格式 `{"detail":"..."}`）优先于
 * `statusCode`（HTTP 状态码）；处置由 `action` 决定，与 key 状态一一对应
 * （`retrySameKey` 状态不变 / `rotateCooldown` 冷却中 / `rotatePersist` 不可用）。
 * 规则按数组顺序匹配，首个命中即生效。
 */
export function getErrorRules(): ErrorRule[] {
    const raw = getConfig().get<ErrorRule[]>("errorRules", DEFAULT_ERROR_RULES);
    if (!Array.isArray(raw) || raw.length === 0) {
        return DEFAULT_ERROR_RULES;
    }
    return raw.filter(
        (r): r is ErrorRule =>
            r &&
            typeof r === "object" &&
            typeof r.action === "string" &&
            (typeof r.detail === "string" || typeof r.statusCode === "number")
    );
}

/** 读取 429 瞬态冷却时长（分钟，默认 10） */
export function getExhaustedCooldownMin(): number {
    const v = getConfig().get<number>("apiKeyExhaustedCooldownMin", 10);
    return Number.isFinite(v) && v >= 0 ? v : 10;
}

/** 读取瞬态失败（429/500/503）整轮自动重试次数（默认 3，夹取 0-10） */
export function getTransientRetryTimes(): number {
    const v = getConfig().get<number>("transientRetryTimes", 3);
    if (!Number.isFinite(v)) {
        return 3;
    }
    return Math.min(10, Math.max(0, Math.floor(v)));
}
