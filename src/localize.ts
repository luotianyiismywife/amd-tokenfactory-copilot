import * as vscode from "vscode";

const zhCN: Record<string, string> = {
    // statusBar
    "Token Count": "Token 计数",
    "Current model token usage": "当前模型 token 使用量",
    "Ready": "就绪",

    // extension.ts - API key prompts
    "AMD TokenFactory Provider API Key": "AMD TokenFactory 提供商 API 密钥",
    "Enter your AMD TokenFactory API key (rc-...)": "输入您的 AMD TokenFactory API 密钥（rc-...）",
    "API key saved.": "API 密钥已保存。",
    "API keys cleared.": "API 密钥已清空。",
    "Add API Key": "添加 API Key",
    "Batch Import API Keys": "批量导入 API Keys",
    "Enter one key per line (optional note after a comma, e.g. rc-xxx,main)": "每行一个 Key（可在逗号后附备注，如 rc-xxx,主力）",
    "Imported {0} key(s), skipped {1} duplicate(s).": "已导入 {0} 个 Key，跳过 {1} 个重复。",
    "Manage API Keys": "管理 API Keys",
    "Add API Key (rc-...)": "添加 API Key（rc-...）",
    "Batch Import Keys": "批量导入 Keys",
    "Delete API Key": "删除 API Key",
    "Reset Unavailable Keys": "重置失效 Key",
    "Check All Keys": "检测全部 Key 可用性",
    "Check This Key": "检测此 Key 可用性",
    "Optional note for this key": "为此 Key 添加备注（可选）",
    "Note (optional)": "备注（可选）",
    "Delete key {0}?": "删除 Key {0}？",
    "Cancel": "取消",
    "Delete": "删除",
    "Key deleted.": "Key 已删除。",
    "Reset cooldown and unavailable marks for all keys?": "重置全部 Key 的冷却与失效标记？",
    "Reset": "重置",
    "All key states reset.": "已重置全部 Key 状态。",
    "No API keys configured.": "尚未配置任何 API Key。",
    "Key is available": "Key 可用",
    "Key is NOT available: {0}": "Key 不可用：{0}",
    "Key availability unknown": "Key 可用性未知",
    "Key already exists": "该 Key 已存在",
    "available": "可用",
    "unavailable": "不可用",
    "cooling down": "冷却中",
    "Not checked": "未检测",
    "Pinned": "固定中",
    "Rotation cursor": "轮询游标",
    "Edit API Key": "编辑 API Key",
    "Edit the API key value (leave unchanged to keep)": "编辑 API Key 值（保持不变则原样保留）",
    "Edit the label (empty to clear)": "编辑备注（留空清除）",
    "API key updated": "API Key 已更新",
    "API key value conflicts with another existing key": "该 Key 值与已有 Key 冲突",
    "Failed to update API key": "API Key 更新失败",
    "Key {0}": "Key {0}",
    "Rotation mode: next key per request": "轮询模式：每次请求换下一个 Key",
    "Sticky mode: keep current key until it fails": "固定模式：一直使用当前 Key，失效后才切换",
    "{0} key(s) configured": "已配置 {0} 个 Key",
    "All API keys are temporarily unavailable": "全部 API Key 暂时不可用（限流/平台繁忙），请稍后重试",
    "Update your AMD TokenFactory API key (rc-...)": "更新您的 AMD TokenFactory API 密钥（rc-...）",

    // provider.ts
    "AMD TokenFactory API key not found": "未找到 AMD TokenFactory API 密钥",
    "Open AMD TokenFactory to get an API key?": "是否打开 AMD TokenFactory 页面获取 API Key？",
    "Open Website": "打开官网",
    "Invalid base URL configuration.": "无效的 Base URL 配置。",
    "All API keys failed:": "全部 API Key 均失败：",
    "Request timed out. The generation took too long. You can increase the timeout in settings (amdTokenFactory.requestTimeout).":
        "请求超时，生成耗时过长。您可以在设置中增加超时时间（amdTokenFactory.requestTimeout）。",
    "The connection was closed by the server. The generation took too long. Please try again or request shorter content.":
        "服务端关闭了连接，生成耗时过长。请重试或缩短请求内容。",

    // key rotation reasons
    "Balance insufficient": "余额不足",
    "Key invalid": "Key 无效",
    "Rate limited (429)": "限流（429）",
    "Server error (503)": "服务器错误（503）",
    "API error": "API 错误",
    "Unavailable": "不可用",

    // reasoning effort labels
    "Disabled": "禁用思考",
    "Thinking": "思考",
    "Do not enable thinking": "不启用思考",
    "Enable thinking": "启用思考",
    "Reasoning Effort": "推理强度",

    // zero-answer budget exhaustion
    "The model used all available output tokens on reasoning (finish reason: {0}) and produced no answer. Lower the reasoning effort, or turn thinking off and retry.":
        "模型将全部输出 token 预算耗在了思考上（结束原因：{0}），没有生成任何回答。请降低推理强度或关闭思考后重试。",
    "The response was cut off because the output token budget ran out (finish reason: {0}). Increase amdTokenFactory.maxOutputTokens in settings and retry.":
        "回答因输出 token 预算耗尽被截断（结束原因：{0}）。请在设置中调大 amdTokenFactory.maxOutputTokens 后重试。",

    // statusBar
    "({0} cached, {1}%)": "(已缓存 {0}，命中率 {1}%)",
};

/**
 * Get the localized string for the given key.
 * Falls back to the key itself if no translation is available.
 */
export function l10n(key: string): string {
    const language = vscode.env.language;
    if (language.toLowerCase() === "zh-cn" || language.toLowerCase().startsWith("zh")) {
        if (zhCN[key]) {
            return zhCN[key];
        }
    }
    return key;
}

/**
 * Format a localized string with replacements.
 * Usage: l10nFormat("Token Usage: {0} / {1}", "12.5K", "1M")
 */
export function l10nFormat(key: string, ...args: (string | number)[]): string {
    let text = l10n(key);
    args.forEach((arg, i) => {
        text = text.replace(new RegExp(`\\{${i}\\}`, "g"), String(arg));
    });
    return text;
}
