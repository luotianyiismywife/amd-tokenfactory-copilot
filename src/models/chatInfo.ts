/**
 * chatInfo.ts — `ModelInfo` 的适配器层。
 *
 * `registry.ts` 只产出与平台无关的归一化模型信息；本模块负责把它翻译成两个
 * 消费方需要的形状：
 *   - `toLanguageModelChatInformation()` → VS Code 模型选择器条目
 *   - `toProviderModelItem()`            → 请求体构造用的可变配置
 *
 * 这两段转换原先在 `models.ts` 与 `provideModel.ts` 各写了一份（思考档位枚举、
 * 上下文比例、输出上限兜底），现在只有一份。
 */
import type { LanguageModelChatInformation } from "vscode";
import type { ProviderModelItem } from "../core/types";
import { l10n } from "../core/localize";
import { EXTENSION_LABEL, getMaxInputTokensRatio } from "./models";
import type { ModelInfo } from "./registry";

/** 思考档位 → 本地化标签。 */
function effortLabel(effort: string): string {
    switch (effort) {
        case "disabled": return l10n("Disabled");
        case "adaptive": return l10n("Adaptive");
        case "enabled": return l10n("Thinking");
        case "low": return l10n("Low");
        case "medium": return l10n("Medium");
        case "high": return l10n("High");
        case "xhigh": return l10n("Xhigh");
        case "max": return l10n("Maximum");
        case "minimal": return l10n("Minimal");
        default: return effort.charAt(0).toUpperCase() + effort.slice(1);
    }
}

/** 思考档位 → 本地化说明。 */
function effortDescription(effort: string): string {
    switch (effort) {
        case "disabled": return l10n("Do not enable thinking");
        case "adaptive": return l10n("Automatically decide when to think");
        case "enabled": return l10n("Enable thinking");
        case "low": return l10n("Reduce thinking, faster response");
        case "medium": return l10n("Balance thinking and speed");
        case "high": return l10n("Deeper thinking, slower response");
        case "xhigh": return l10n("Extra deep thinking, very slow response");
        case "max": return l10n("Maximum thinking depth, slowest response");
        case "minimal": return l10n("Minimal thinking, fastest response");
        default: return effort;
    }
}

/**
 * 由模型的思考能力推导选择器里的档位枚举。
 * - switchable + 有档位：disabled / low / medium / high
 * - switchable + 无档位：disabled / enabled
 * - adaptive：disabled / adaptive
 * - always：enabled（或仅档位列表）
 */
function buildEffortEnum(info: ModelInfo): string[] {
    const efforts = info.supportedReasoningEfforts ?? [];
    if (efforts.length > 0) {
        return info.thinkingMode === "switchable" ? ["disabled", ...efforts] : [...efforts];
    }
    if (info.thinkingMode === "switchable") {
        return ["disabled", "enabled"];
    }
    if (info.thinkingMode === "adaptive") {
        return ["disabled", "adaptive"];
    }
    return ["enabled"];
}

/** 归一化模型信息 → VS Code 模型选择器条目。 */
export function toLanguageModelChatInformation(info: ModelInfo): LanguageModelChatInformation {
    const enumValues = buildEffortEnum(info);
    const defaultEffort =
        info.defaultReasoningEffort && enumValues.includes(info.defaultReasoningEffort)
            ? info.defaultReasoningEffort
            : enumValues[enumValues.length - 1];

    return {
        id: info.id,
        name: info.displayName,
        detail: EXTENSION_LABEL,
        tooltip: info.description ?? EXTENSION_LABEL,
        family: EXTENSION_LABEL,
        version: "1.0.0",
        // Declare maxInputTokens as a configurable ratio of the real context
        // window so VS Code's agent auto-compaction (~90% of maxInputTokens)
        // fires before the context actually fills up.
        maxInputTokens: Math.floor(info.contextLength * getMaxInputTokensRatio()),
        maxOutputTokens: info.maxOutputTokens,
        isUserSelectable: true,
        capabilities: {
            toolCalling: info.toolCalling,
            // Always declare imageInput=true so VS Code passes image data through.
            // Non-vision models handle images via the ask_image tool proxy internally.
            imageInput: true,
        },
        configurationSchema: {
            properties: {
                reasoningEffort: {
                    type: "string",
                    title: l10n("Reasoning Effort"),
                    enum: enumValues,
                    enumItemLabels: enumValues.map(effortLabel),
                    enumDescriptions: enumValues.map(effortDescription),
                    default: defaultEffort,
                    group: "navigation",
                },
            },
        },
    } satisfies LanguageModelChatInformation;
}

/**
 * 归一化模型信息 → 请求体配置。
 *
 * 每次调用返回**新的可变对象**：provider.ts 会按请求改写
 * `enable_thinking` / `reasoning_effort` / `temperature` 等字段，
 * 共享同一份对象会让上一轮的设置泄漏到下一轮。
 */
export function toProviderModelItem(info: ModelInfo): ProviderModelItem {
    const item: ProviderModelItem = {
        id: info.id,
        owned_by: "provider",
        displayName: info.displayName,
        vision: info.vision,
        supportsTemperature: info.supportsTemperature,
        context_length: info.contextLength,
        apiMode: info.apiMode,
        enable_thinking: true,
        include_reasoning_in_request: info.includeReasoningInRequest,
        thinkingMode: info.thinkingMode,
    };

    if (info.fixedTopP !== undefined) {
        item.fixedTopP = info.fixedTopP;
    }
    // Only send an output cap when a data source actually knows it. A wrong
    // default (4096/32768) let reasoning models burn the whole budget on
    // thinking before writing any answer text.
    if (info.maxOutputTokensSource !== "default") {
        item.max_completion_tokens = info.maxOutputTokens;
    }
    if (info.defaultReasoningEffort) {
        item.reasoning_effort = info.defaultReasoningEffort;
    }
    if (info.extra) {
        item.extra = { ...info.extra };
    }

    return item;
}
