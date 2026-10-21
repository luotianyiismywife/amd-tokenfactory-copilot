import * as vscode from "vscode";

const zhCN: Record<string, string> = {
	// extension.ts - API key prompts
	"Enter your API key": "输入您的 API 密钥",

	// provider.ts
	"API key not found": "未找到 API 密钥",
	"Invalid base URL configuration.": "无效的 Base URL 配置。",

	"No changes found in any workspace repositories.": "在任何工作区仓库中均未发现更改。",
	"Git extension not found": "未找到 Git 扩展",
	"No Git repositories available": "没有可用的 Git 仓库",
	"Repository not found for provided SCM": "未找到指定 SCM 对应的仓库",
"Failed to generate commit message:": "生成提交消息失败：",
	"[Commit Generation Failed]": "[提交生成失败]",
	"empty API response": "API 返回为空",

	// Timeout error
	"Request timed out. The generation took too long. You can increase the timeout in settings (amdTokenFactory.requestTimeout).":
		"请求超时，生成内容过长。您可以在设置中增加超时时间（amdTokenFactory.requestTimeout）。",
	"The connection was closed by the server. The generation took too long. Please try again or request shorter content.":
		"服务端连接被关闭，生成内容过长时间过长。请重试或请求较短的内容。",

	// zero-answer budget exhaustion
	"The model used all available output tokens on reasoning ({0}, finish reason: {1}) and produced no answer. Lower the reasoning effort, or turn thinking off and retry.":
		"模型（{0}）将全部输出 token 预算耗在了思考上（结束原因：{1}），没有生成任何回答。请降低推理强度或关闭思考后重试。",

	// transient retry exhausted (retrySameKey)
	"The server is busy or rate-limited. Retried {0} time(s) automatically without success. Please try again later.\n\nOriginal error: {1}":
		"服务端繁忙或限流，已自动重试 {0} 次仍未成功，请稍后重试。\n\n原始错误：{1}",

	// reasoning effort labels (keys are English fallback text)
	"Disabled": "禁用思考",
	"Adaptive": "自动",
	"Thinking": "思考",
	"Low": "低",
	"Medium": "中",
	"High": "高",
	"Maximum": "极高",

	// reasoning effort descriptions (keys are English fallback text)
	"Do not enable thinking": "不启用思考",
	"Automatically decide when to think": "自动决定何时思考",
	"Enable thinking": "启用思考",
	"Reduce thinking, faster response": "减少思考，响应更快",
	"Balance thinking and speed": "平衡思考与速度",
	"Deeper thinking, slower response": "更深入的思考，但速度较慢",
	"Maximum thinking depth, slowest response": "最大思考深度，速度最慢",

	// reasoning effort title (key is English fallback text)
	"Reasoning Effort": "推理强度",

	// vision proxy
	"Querying vision model: \"{0}\"": "正在根据图片提问：{0}",
	"The configured vision model ({0}) does not support image input. Set amdTokenFactory.visionProxyModel to a vision-capable model.": "配置的视觉模型（{0}）不支持图片输入。请将 amdTokenFactory.visionProxyModel 设为支持视觉的模型。",
	"The image you sent was flagged as sensitive by the content moderation system. Please try a different image.": "您发送的图片被内容审核系统判定为敏感，请尝试更换图片。",

	// keyManager.ts - API Key management
	"Available": "可用",
	"Unavailable": "不可用",
	"Not checked": "未检测",
	"Cooldown ({0}s)": "冷却中 ({0} 秒)",
	"Cooldown": "冷却中",
	"Back": "返回",
	"Select a key to check, or check all": "选择要检测的 Key，或检测全部",
	"Current": "当前使用",
	"Pinned": "当前固定",
	"Add API Key": "添加 API Key",
	"Import API Keys (batch)": "批量导入 API Keys",
	"Format: key---label;key---label; (leave the label empty if unused)": "格式：key---备注;key---备注;（备注留空即可）",
	"No valid entries found": "未解析出有效条目",
	"Import {0} API key(s)?": "确认导入 {0} 个 API Key？",
	"Imported {0} API keys": "已导入 {0} 个 API Key",
	"No changes (keys already exist)": "无变更（key 已存在）",
	"Delete API Key": "删除 API Key",
	"Select one or more keys to delete (Esc to go back)": "勾选要删除的 Key（可多选，Esc 返回）",
	"Confirm delete {0} API key(s)?": "确认删除 {0} 个 API Key？",
	"Deleted {0} API key(s)": "已删除 {0} 个 API Key",
	"Edit API Key": "编辑 API Key",
	"Edit the API key value (leave unchanged to keep)": "编辑 API Key 值（保持不变则不修改）",
	"Edit the label (empty to clear)": "编辑备注（留空清除）",
	"API key updated": "API Key 已更新",
	"API key value conflicts with another existing key": "API Key 值与另一个已存在的 key 冲突",
	"Failed to update API key": "更新 API Key 失败",
	"Set as Current": "设为当前使用",
	"Reset Exhausted States": "重置失效状态",
	"Check Availability": "检测可用性",
	"Check All Availability": "全部检测可用性",
	"Checking availability of all keys...": "正在检测全部 Key 的可用性...",
	"Checking {0}/{1}: {2}": "正在检测 {0}/{1}：{2}",
	"Availability check done: {0} available, {1} unavailable, {2} unknown": "检测完成：{0} 可用，{1} 不可用，{2} 无法确定",
	"Enter an optional label for this key": "为该 key 输入可选备注（可留空）",
	"API key already exists": "该 API Key 已存在",
	"API key added": "API Key 已添加",
	"Select an API key to manage": "选择要管理的 API Key",
	"Set as current API key": "已设为当前 API Key",
	"Set as Current is only valid in single/sticky mode (apiKeyMode=single or sticky)": "「设为当前使用」仅在 single/sticky 模式下有效（apiKeyMode=single 或 sticky）",
	"Reset exhausted key states": "已重置失效状态",
	"Checking availability...": "正在检测可用性...",
	"Key is available": "检测通过：Key 可用",
	"Key is invalid (401)": "Key 无效（401），标记为不可用",
	"Unable to determine availability, please retry later": "无法确定可用性，请稍后重试",
	"All API keys are temporarily unavailable ({0}). Please retry later.": "所有 API Key 暂时不可用（{0}），请稍后重试。",
	"All API keys are unavailable ({0}). Use the Manage API Keys command to check availability, or reset exhausted states to recover keys that may have been marked unavailable by mistake.": "所有 API Key 均不可用（{0}）。请使用「管理 API Keys」命令检测可用性，或尝试「重置失效状态」恢复可能被误标记的 Key。",
	"Balance insufficient": "余额不足",
	"Key invalid": "Key 无效",
	"Rate limited (429)": "限流 (429)",
	"Server error (503)": "服务端繁忙 (503)",
	"API error": "API 错误",
	"Current API key is out of balance, switched to {0} and set it as the current key": "当前 API Key 余额不足，已切换到 {0} 并设为当前使用",
	"Current API key is unavailable ({0}). Single mode only switches keys on insufficient balance (402); retry later or check via the Manage API Keys command.":
		"当前 API Key 不可用（{0}）。single 模式仅在余额不足（402）时才自动切换 key；请稍后重试，或使用「管理 API Keys」命令检测/切换。",
	"No API keys configured": "未配置 API Key",

	// cloudSync.ts - 云同步（GitHub Gist）
	"Pushing keys to cloud...": "正在推送 Keys 到云端...",
	"Pushed {0} keys to cloud Gist": "已推送 {0} 个 Key 到云端 Gist",
	"Failed to push to cloud: {0}": "推送到云端失败：{0}",
	"GitHub sign-in required for cloud sync": "云同步需要登录 GitHub",
	"No cloud sync Gist found. Use push first.": "未找到云端同步 Gist，请先执行推送",
	"Cloud sync data is empty or corrupted": "云端同步数据为空或已损坏",
	"Pulled {0} keys from cloud Gist": "已从云端 Gist 拉取 {0} 个 Key",
	"Failed to pull from cloud: {0}": "从云端拉取失败：{0}",
	"Cloud sync is already in progress": "云同步正在进行中，请稍后再试",

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
export function l10nFormat(template: string, ...args: (string | number)[]): string {
	let str = l10n(template);
	for (let i = 0; i < args.length; i++) {
		str = str.replace(`{${i}}`, String(args[i]));
	}
	return str;
}
