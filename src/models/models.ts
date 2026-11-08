import * as vscode from "vscode";

/**
 * Built-in model definition (see BUILT_IN_MODELS below).
 *
 * 这是**唯一**需要手工维护的模型表：上下文窗口、输出上限、视觉能力、思考档位、
 * 额外请求体参数都写在这里。
 *
 * ⚠️ 它只是**离线兜底**：`registry.ts` 仅在 `/v1/models` 获取失败（或未配置 key /
 * 关闭自动发现）时整份采用本清单；API 成功时模型信息完全来自平台 + models.dev，
 * 本清单的旧值不覆盖、不补写任何字段。
 */
export interface BuiltInModelDef {
    /** Base model ID sent to the API (e.g., "example-model") */
    baseId: string;
    /** User-friendly display name (e.g., "Example Model") */
    displayName: string;
    /** Whether the model supports image input */
    vision: boolean;
    /** Thinking mode: "switchable" = user can toggle, "always" = thinking forced on, "adaptive" = only disabled/adaptive */
    thinkingMode: "switchable" | "always" | "adaptive";
    /** Default reasoning effort when thinking is enabled */
    defaultReasoningEffort?: string;
    /** Supported reasoning effort levels for the model picker UI */
    supportedReasoningEfforts?: string[];
    /** Whether to include reasoning_content in assistant messages */
    includeReasoningInRequest?: boolean;
    /** Whether the model supports setting temperature/top_p. Default true. */
    supportsTemperature?: boolean;
    /** Optional fixed top_p value the model accepts (e.g. a model that only allows 0.95). */
    fixedTopP?: number;
    /** Default context length */
    contextLength?: number;
    /** Default max output tokens */
    maxTokens?: number;
    /** Extra body parameters to include in API requests */
    extra?: Record<string, unknown>;
    /** API mode: "openai" (default) or "anthropic" */
    apiMode?: "openai" | "anthropic";
}

export const EXTENSION_LABEL = "AMD TokenFactory";
export const DEFAULT_CONTEXT_LENGTH = 128000;
export const DEFAULT_MAX_TOKENS = 32768;

/**
 * Default ratio of the real context window to declare as `maxInputTokens`.
 * Overridable via the `amdTokenFactory.maxInputTokensRatio` setting.
 *
 * VS Code triggers agent auto-compaction (chat.summarizeAgentConversationHistory.enabled)
 * at ~90% of the declared maxInputTokens. Declaring the full context length
 * (e.g. 1M tokens) means compaction would only fire at 900K tokens — effectively
 * never for typical conversations. A lower ratio (e.g. 0.8) makes compaction
 * fire at ~72% of the real window, leaving headroom.
 */
const DEFAULT_MAX_INPUT_TOKENS_RATIO = 1.0;
/** Lower bound for maxInputTokensRatio — prevents declaring a tiny context that
 * triggers compaction far too early. */
const MIN_MAX_INPUT_TOKENS_RATIO = 0.1;
/** Upper bound — 1.0 means declaring the full context window. */
const MAX_MAX_INPUT_TOKENS_RATIO = 1.0;

/**
 * Read the configurable maxInputTokens ratio from the `amdTokenFactory.maxInputTokensRatio`
 * setting and clamp it into the valid range [0.1, 1.0]. Falls back to the default
 * (1.0) when the setting is missing or invalid.
 */
export function getMaxInputTokensRatio(): number {
    const configured = vscode.workspace.getConfiguration("amdTokenFactory").get<number>("maxInputTokensRatio", DEFAULT_MAX_INPUT_TOKENS_RATIO);
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
        return DEFAULT_MAX_INPUT_TOKENS_RATIO;
    }
    return Math.min(MAX_MAX_INPUT_TOKENS_RATIO, Math.max(MIN_MAX_INPUT_TOKENS_RATIO, configured));
}

/**
 * Built-in model definitions.
 *
 * AMD TokenFactory 内置模型清单（`/v1/models` 不可用时的兜底列表；自动模型发现
 * 默认开启，正常情况下以 API 实时列表为准）。
 *
 * 与 2026-10-21 /models 实测对齐（10 个 chat 模型，全部支持工具调用）。
 * 非 chat 端点（Clef / d3 / MinerU2.5-Pro / OmniVoice 等）已过滤。
 * DeepSeek-V4-Flash-Vision-Exp 已于 2026-10-23 退役，已移除。
 * Qwen3.8-Flash-Next 将于 2026-11-11 退役。
 *
 * 思考档位：AMD 用 `reasoning_effort`（none/low/medium/high/xhigh/max/minimal）控制深度，
 * **不支持 `thinking` 参数**。思考行为按模型不同（2026-11-09 实测）：
 * 大部分模型可控制（none 不思考 / 高档位思考），仅 GLM-5.3 恒思考（none 也产 reasoning）。
 * 档位支持范围按模型不同（Qwen3.8 仅 low/medium/xhigh，high 会 400），
 * 支持范围与默认档位见下方各模型定义；实测记录见 .copilot/api-reference.md。
 */
export const BUILT_IN_MODELS: BuiltInModelDef[] = [
    { baseId: "DeepSeek-V4.1-Flash", displayName: "DeepSeek-V4.1-Flash", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "minimal"], defaultReasoningEffort: "high", contextLength: 1048576, maxTokens: 32768 },
    { baseId: "DeepSeek-V4-Flash", displayName: "DeepSeek-V4-Flash", vision: false, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "minimal"], defaultReasoningEffort: "high", contextLength: 1048576, maxTokens: 32768 },
    { baseId: "Gemma-4-31B-IT", displayName: "Gemma 4 31B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "minimal"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "GLM-5.3-Flash", displayName: "GLM-5.3-Flash", vision: false, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "MiMo-V2.6-Flash", displayName: "MiMo-V2.6-Flash", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "minimal"], defaultReasoningEffort: "high", contextLength: 1048576, maxTokens: 32768 },
    { baseId: "MiniCPM5-2B", displayName: "MiniCPM5-2B", vision: false, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 131072, maxTokens: 32768 },
    { baseId: "MiniCPM-V-4.7-1B", displayName: "MiniCPM-V-4.7-1B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "MiniCPM-V-4.7-35B-A3B", displayName: "MiniCPM-V-4.7-35B-A3B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "Qwen3.8-27B", displayName: "Qwen3.8-27B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "xhigh"], defaultReasoningEffort: "xhigh", contextLength: 262144, maxTokens: 32768 },
    { baseId: "Qwen3.8-Flash-Next", displayName: "Qwen3.8-Flash-Next", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "xhigh"], defaultReasoningEffort: "xhigh", contextLength: 262144, maxTokens: 32768 },
];

/**
 * Get the set of built-in model base IDs.
 * Used by the startup model sync (src/modelSync.ts) to detect new models
 * returned by the API that are not yet in the built-in list.
 */
export function getBuiltInModelIds(): Set<string> {
    return new Set(BUILT_IN_MODELS.map((m) => m.baseId));
}

/**
 * Look up a built-in model definition by its bare model ID.
 *
 * This is the OFFLINE fallback catalog — the only place where per-model
 * defaults (context window, output cap, vision, thinking mode, extra body
 * params) are declared by hand. `registry.ts` uses it **only** when
 * `/v1/models` cannot be fetched, so no other module keeps its own model table.
 */
export function getBuiltInModelDef(modelId: string): BuiltInModelDef | undefined {
    return BUILT_IN_MODELS.find((m) => m.baseId === modelId);
}

/**
 * All built-in model definitions, in declaration order.
 */
export function getBuiltInModelDefs(): readonly BuiltInModelDef[] {
    return BUILT_IN_MODELS;
}
