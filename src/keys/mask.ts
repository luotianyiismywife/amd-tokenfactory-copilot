/**
 * API Key 脱敏显示辅助。
 */

/** 脱敏 API Key：`sk_****abcd`（长度 ≤ 8 时只保留头 2 字符） */
export function maskApiKey(key: string): string {
    if (key.length <= 8) {
        return `${key.slice(0, 2)}****`;
    }
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}
