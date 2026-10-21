import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import type { ProviderModelItem } from "../core/types";
import { l10n } from "../core/localize";

/**
 * Built-in model definition (see BUILT_IN_MODELS below).
 */
interface BuiltInModelDef {
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

const EXTENSION_LABEL = "AMD TokenFactory";
const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 32768;

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
 * DeepSeek-V4-Flash-Vision-Exp 将于 2026-10-23 退役，已移除。
 *
 * 思考档位：AMD 用 `reasoning_effort`（none/low/medium/high）控制深度，
 * **不支持 `thinking` 参数**。思考是模型固有属性——Qwen3.8 系列恒产出思考、
 * DeepSeek-V4 系列恒不产出，档位只影响深度且非确定性。
 */
const BUILT_IN_MODELS: BuiltInModelDef[] = [
    { baseId: "DeepSeek-V4.1-Flash", displayName: "DeepSeek-V4.1-Flash", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 1048576, maxTokens: 32768 },
    { baseId: "DeepSeek-V4-Flash", displayName: "DeepSeek-V4-Flash", vision: false, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 1048576, maxTokens: 32768 },
    { baseId: "Gemma-4-31B-IT", displayName: "Gemma 4 31B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "GLM-5.3-Flash", displayName: "GLM-5.3-Flash", vision: false, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "MiMo-V2.6-Flash", displayName: "MiMo-V2.6-Flash", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 1048576, maxTokens: 32768 },
    { baseId: "MiniCPM5-2B", displayName: "MiniCPM5-2B", vision: false, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 131072, maxTokens: 32768 },
    { baseId: "MiniCPM-V-4.7-1B", displayName: "MiniCPM-V-4.7-1B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "MiniCPM-V-4.7-35B-A3B", displayName: "MiniCPM-V-4.7-35B-A3B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "Qwen3.8-27B", displayName: "Qwen3.8-27B", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
    { baseId: "Qwen3.8-Flash-Next", displayName: "Qwen3.8-Flash-Next", vision: true, thinkingMode: "switchable", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", contextLength: 262144, maxTokens: 32768 },
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
 * Get the built-in model list as LanguageModelChatInformation[].
 * Each model registers one entry with a configurationSchema for reasoning effort selection.
 * - switchable models: include "禁用思考" option so user can turn off thinking
 * - always models: no "禁用思考" option, thinking always on
 * All labels and descriptions use l10n() for i18n.
 */
export function getBuiltInModelInfos(): LanguageModelChatInformation[] {
    const infos: LanguageModelChatInformation[] = [];

    for (const def of BUILT_IN_MODELS) {
        // Declare maxInputTokens as a configurable ratio (default 80%) of the real
        // context window so VS Code's agent auto-compaction (~90% of maxInputTokens)
        // fires before the context actually fills up.
        const maxInput = Math.floor((def.contextLength ?? DEFAULT_CONTEXT_LENGTH) * getMaxInputTokensRatio());

        const info: LanguageModelChatInformation = {
            id: def.baseId,
            name: def.displayName,
            detail: EXTENSION_LABEL,
            tooltip: EXTENSION_LABEL,
            family: EXTENSION_LABEL,
            version: "1.0.0",
            maxInputTokens: maxInput,
            maxOutputTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
            isUserSelectable: true,
            capabilities: {
                toolCalling: true,
                // Always declare imageInput=true so VS Code passes image data through.
                // Non-vision models handle images via the ask_image tool proxy internally.
                imageInput: true,
            },
        };

        // Build enum values based on thinking mode
        // - "switchable" + hasEfforts: disabled / [effort levels]             (e.g. disabled/high/max)
        // - "switchable" + no efforts: disabled / enabled
        // - "adaptive"               : disabled / adaptive                    (only two: off or auto-decide)
        // - "always"    + hasEfforts: [effort levels]
        // - "always"    + no efforts: enabled
        const hasEfforts = def.supportedReasoningEfforts && def.supportedReasoningEfforts.length > 0;
        let enumValues: string[];
        if (hasEfforts) {
            if (def.thinkingMode === "switchable") {
                enumValues = ["disabled", ...def.supportedReasoningEfforts!];
            } else {
                enumValues = [...def.supportedReasoningEfforts!];
            }
        } else {
            if (def.thinkingMode === "switchable") {
                enumValues = ["disabled", "enabled"];
            } else if (def.thinkingMode === "adaptive") {
                enumValues = ["disabled", "adaptive"];
            } else {
                enumValues = ["enabled"];
            }
        }

        // Map effort values to localized labels and descriptions
        // Keys are English strings that serve as fallback for non-Chinese locales
        const getLabel = (e: string): string => {
            switch (e) {
                case 'disabled': return l10n("Disabled");
                case 'adaptive': return l10n("Adaptive");
                case 'enabled': return l10n("Thinking");
                case 'low': return l10n("Low");
                case 'medium': return l10n("Medium");
                case 'high': return l10n("High");
                case 'max': return l10n("Maximum");
                default: return e.charAt(0).toUpperCase() + e.slice(1);
            }
        };
        const getDesc = (e: string): string => {
            switch (e) {
                case 'disabled': return l10n("Do not enable thinking");
                case 'adaptive': return l10n("Automatically decide when to think");
                case 'enabled': return l10n("Enable thinking");
                case 'low': return l10n("Reduce thinking, faster response");
                case 'medium': return l10n("Balance thinking and speed");
                case 'high': return l10n("Deeper thinking, slower response");
                case 'max': return l10n("Maximum thinking depth, slowest response");
                default: return e;
            }
        };

        const enumItemLabels = enumValues.map(getLabel);
        const enumDescriptions = enumValues.map(getDesc);

        // Determine default: for switchable with efforts, use defaultReasoningEffort or last item;
        // for others, use the last enum value (enabled/highest effort)
        const defaultEffort = (hasEfforts && def.defaultReasoningEffort)
            ? def.defaultReasoningEffort
            : enumValues[enumValues.length - 1];

        infos.push({
            ...info,
            configurationSchema: {
                properties: {
                    reasoningEffort: {
                        type: 'string',
                        title: l10n("Reasoning Effort"),
                        enum: enumValues,
                        enumItemLabels: enumItemLabels,
                        enumDescriptions: enumDescriptions,
                        default: defaultEffort,
                        group: 'navigation',
                    },
                },
            },
        } satisfies LanguageModelChatInformation);
    }

    return infos;
}

/**
 * Find a built-in model definition by model ID.
 * Returns the model properties including thinking mode, API mode, and extra parameters.
 * Thinking state (enable_thinking) is initially set to true and will be adjusted
 * by provider.ts based on the user's reasoning effort selection.
 */
export function getBuiltInModelConfig(modelId: string): ProviderModelItem | undefined {
    const def = BUILT_IN_MODELS.find((m) => m.baseId === modelId);
    if (!def) {
        return undefined;
    }

    const model: ProviderModelItem = {
        id: def.baseId,
        owned_by: "provider",
        displayName: def.displayName,
        vision: def.vision,
        supportsTemperature: def.supportsTemperature ?? true,
        fixedTopP: def.fixedTopP,
        context_length: def.contextLength ?? DEFAULT_CONTEXT_LENGTH,
        max_completion_tokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
        apiMode: def.apiMode ?? "openai",
        enable_thinking: true,
        include_reasoning_in_request: true,
        thinkingMode: def.thinkingMode,
    };

    // Set default reasoning effort if configured
    if (def.defaultReasoningEffort) {
        model.reasoning_effort = def.defaultReasoningEffort;
    }

    // Pass through extra body parameters
    if (def.extra) {
        model.extra = { ...def.extra };
    }

    return model;
}
