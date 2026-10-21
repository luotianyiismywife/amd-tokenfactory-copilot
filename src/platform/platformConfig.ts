/**
 * platformConfig.ts — 平台配置单一事实来源。
 *
 * AMD TokenFactory（Radeon AI）平台配置：
 * - `API_BASE_URL`           — OpenAI 兼容 API 根地址（/v1），聊天/模型列表共用
 * - `PLATFORM_USER_SELF_URL` — 账号信息端点（AMD 无公开端点，留空）
 * - `PLATFORM_HEADERS`       — 用户中心接口必需固定头（AMD 无域校验，留空）
 * - `FALLBACK_TEST_MODEL_ID` — 模型列表不可用时的兜底测试模型 ID
 *
 * **关于账号/余额**：AMD TokenFactory 有账号体系，但**余额无记录意义**——
 * 每个账号每天固定 $1 额度，东八区（UTC+8）0 点刷新，额度耗尽即当日不可用。
 * 该平台主要用于**多账号轮询**（多 key 分摊每日额度），因此本扩展**不实现**
 * 余额查询 / 套餐用量 / 状态栏用量显示（脚手架中的 `src/balance/` 与
 * `src/ui/statusBar.ts` 已移除）。额度耗尽由 API 返回 402/429 触发 key 轮换。
 *
 * 命令前缀（`amdtokenfactory.`）与 languageModelChatProviders 的 `vendor` 是
 * VS Code 静态声明（package.json contributes），无法运行时改。
 */

// ── API 域 ──────────────────────────────────────────────────────────────

/** OpenAI 兼容 API 根地址（以 / 结尾，子路径直接拼接） */
export const API_BASE_URL = "https://developer.amd.com.cn/radeon/api/v1/";

// ── 平台外围地址 ────────────────────────────────────────────────────────

/**
 * 用户中心账号信息端点（套餐用量 / 余额查询）。
 * AMD TokenFactory 无公开账号信息端点 → 留空字符串。
 * （即便有，余额也无记录意义——见文件头说明。）
 */
export const PLATFORM_USER_SELF_URL = "";

// ── 用户中心接口固定头 ──────────────────────────────────────────────────

/** AMD 无域校验要求 → 空对象。 */
export const PLATFORM_HEADERS: Record<string, string> = {};

// ── 兜底值 ──────────────────────────────────────────────────────────────

/**
 * 模型列表不可用时的兜底测试模型 ID（key 可用性检测用）。
 * 优先用 /v1/models 实时列表。
 */
export const FALLBACK_TEST_MODEL_ID = "DeepSeek-V4-Flash";
