/**
 * API Key 相关类型定义。
 */

/** 单个 API Key 条目 */
export interface ApiKeyEntry {
    /** API Key 值 */
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
    /** single 模式下的"当前使用" key 下标 */
    activeIndex: number;
}

/** key 使用模式 */
export type ApiKeyMode = "rotation" | "single" | "sticky";

/**
 * single 模式当前 key 不可用时的行为：
 * - error：任何错误都直接报错，不切换
 * - switch：仅在当前 key **余额不足**（402 / 余额预检不足）时自动切换到下一个可用 key
 *   并设为当前使用；其他轮换错误（401 无效 Key / 429 限流 / 503 繁忙）不切换——
 *   401 属配置问题应报错交由用户处理，429/503 属瞬态错误由瞬态整轮重试兜底
 */
export type SingleKeyFallback = "error" | "switch";

/** 供 UI 展示的 key 状态 */
export type KeyDisplayStatus = "available" | "unavailable" | "unknown" | "cooldown";
