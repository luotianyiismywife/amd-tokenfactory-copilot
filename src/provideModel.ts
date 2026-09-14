/**
 * 模型信息提供：内置默认模型 + /models 自动发现。
 *
 * 内置清单保证"零配置可用"（fetch 失败时也有模型可显示）；
 * 自动发现成功后，以 API 返回的元数据（上下文长度/视觉/工具/思考）
 * 为准刷新模型信息。
 */
import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation, PrepareLanguageModelChatModelOptions } from "vscode";

import { logger } from "./logger";
import { getApiModelIds, getApiModelMetadataList, isApiFetchSuccessful, revalidateApiModelList } from "./apiModelList";
import { getPrimaryApiKey } from "./keyManager";
import type { AmdModelItem, ApiModelMetadata } from "./types";
import { l10n } from "./localize";

const EXTENSION_LABEL = "AMD TokenFactory";
const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 32768;
// ── 内置默认模型清单（兜底，零配置可用）──
const BUILT_IN_MODELS: AmdModelItem[] = [
    {
        id: "DeepSeek-V4-Flash-Vision-Exp",
        displayName: "DeepSeek V4 Flash Vision (Exp)",
        context_length: 1048576,
        vision: true,
        tools: true,
        reasoning: true,
    },
    {
        id: "DeepSeek-V4-Flash",
        displayName: "DeepSeek V4 Flash",
        context_length: 1048576,
        vision: false,
        tools: true,
        reasoning: true,
    },
    {
        id: "Qwen3.8-Flash-Next",
        displayName: "Qwen 3.8 Flash Next",
        context_length: 262144,
        vision: true,
        tools: true,
        reasoning: true,
    },
    // MiniCPM5-1B 已从 API 下架（2026-09-14 实测换成 2B）；兜底清单同步为当前真实状态
    {
        id: "MiniCPM5-2B",
        displayName: "MiniCPM 5 2B",
        context_length: 131072,
        vision: false,
        tools: true,
        reasoning: true,
    },
    {
        id: "Qwen3.8-27B",
        displayName: "Qwen 3.8 27B",
        context_length: 131072,
        vision: false,
        tools: true,
        reasoning: true,
    },
];

// ── 白名单模型（/models 未收录但实测可调用的模型）──
// 门户先行上架、清单接口滞后：DeepSeek-V4.1-Flash 在门户 "Public Free" 区在列
// （ctx 1M、vision/tools/reasoning 全支持），实测 /chat/completions 200，
// 但 /models 端点不返回它（2026-09-14 实测，见 .copilot/api-reference.md §6.5）。
// 注入规则：仅当 /models 未返回该模型时注入；将来 /models 收录后由 API
// 元数据（更新鲜）通过自动发现接管，白名单自动让位不产生重复。
const WHITELISTED_MODELS: AmdModelItem[] = [
    {
        id: "DeepSeek-V4.1-Flash",
        displayName: "DeepSeek V4.1 Flash",
        context_length: 1048576,
        vision: true,
        tools: true,
        reasoning: true,
    },
];

// ── Module-level registry for API model configs ──
// Key: model ID (API ID), Value: AmdModelItem
const _apiModelConfigs = new Map<string, AmdModelItem>();

/**
 * Read the configured input token ratio (controls Copilot auto-compaction timing).
 */
export function getMaxInputTokensRatio(): number {
    const v = vscode.workspace.getConfiguration("amdTokenFactory").get<number>("maxInputTokensRatio", 1.0);
    return Number.isFinite(v) ? Math.min(1.0, Math.max(0.1, v)) : 1.0;
}

/**
 * Read the configured per-request completion budget (sent as max_tokens).
 * MUST be sent explicitly: the AMD router's server-side default cap is small
 * and silently truncates answers after a sentence or two, which makes the
 * Copilot agent loop stop and look like "the AI answers once and quits".
 */
export function getMaxOutputTokens(): number {
    const v = vscode.workspace.getConfiguration("amdTokenFactory").get<number>("maxOutputTokens", DEFAULT_MAX_TOKENS);
    return Number.isFinite(v) && v >= 1024 ? Math.floor(v) : DEFAULT_MAX_TOKENS;
}

/**
 * Read the temperature setting (null = do not send).
 */
function getTemperature(): number | null | undefined {
    const config = vscode.workspace.getConfiguration("amdTokenFactory");
    const hasValue = config.inspect<number | null>("temperature")?.globalValue !== undefined
        || config.inspect<number | null>("temperature")?.workspaceValue !== undefined;
    if (!hasValue) {
        return undefined;
    }
    return config.get<number | null>("temperature", null);
}

/**
 * Read the top_p setting (null = do not send).
 */
function getTopP(): number | null | undefined {
    const config = vscode.workspace.getConfiguration("amdTokenFactory");
    const hasValue = config.inspect<number | null>("top_p")?.globalValue !== undefined
        || config.inspect<number | null>("top_p")?.workspaceValue !== undefined;
    if (!hasValue) {
        return undefined;
    }
    return config.get<number | null>("top_p", null);
}

/**
 * Build a LanguageModelChatInformation entry for a model.
 */
function buildModelInfo(item: AmdModelItem, apiMeta: ApiModelMetadata | undefined): LanguageModelChatInformation {
    const displayName = item.displayName ?? item.id;
    const contextLength = apiMeta?.context_length ?? item.context_length ?? DEFAULT_CONTEXT_LENGTH;

    // reasoning=true → model supports thinking → show toggle (switchable)
    const hasReasoning = apiMeta?.reasoning ?? item.reasoning ?? true;
    let enumValues: string[];
    let enumItemLabels: string[];
    let enumDescriptions: string[];

    if (hasReasoning) {
        enumValues = ["disabled", "enabled"];
        enumItemLabels = [l10n("Disabled"), l10n("Thinking")];
        enumDescriptions = [l10n("Do not enable thinking"), l10n("Enable thinking")];
    } else {
        enumValues = ["enabled"];
        enumItemLabels = [l10n("Thinking")];
        enumDescriptions = [l10n("Enable thinking")];
    }

    const toolCalling = apiMeta?.tools ?? item.tools ?? true;

    return {
        id: item.id,
        name: displayName,
        detail: EXTENSION_LABEL,
        tooltip: EXTENSION_LABEL,
        family: EXTENSION_LABEL,
        version: "1.0.0",
        // Declare maxInputTokens as a configurable ratio (default 100%) of the real
        // context window so VS Code's agent auto-compaction (~90% of maxInputTokens)
        // can fire before the context actually fills up.
        maxInputTokens: Math.floor(contextLength * getMaxInputTokensRatio()),
        maxOutputTokens: getMaxOutputTokens(),
        isUserSelectable: true,
        capabilities: {
            toolCalling: toolCalling,
            imageInput: true,
        },
        configurationSchema: {
            properties: {
                reasoningEffort: {
                    type: "string",
                    title: l10n("Reasoning Effort"),
                    enum: enumValues,
                    enumItemLabels: enumItemLabels,
                    enumDescriptions: enumDescriptions,
                    default: "enabled",
                    group: "navigation",
                },
            },
        },
    } satisfies LanguageModelChatInformation;
}

/**
 * Build and store the AmdModelItem config for a model (per-request overrides).
 */
function storeModelConfig(item: AmdModelItem, apiMeta: ApiModelMetadata | undefined): AmdModelItem {
    const hasReasoning = apiMeta?.reasoning ?? item.reasoning ?? true;
    const config: AmdModelItem = {
        id: item.id,
        displayName: item.displayName ?? item.id,
        context_length: apiMeta?.context_length ?? item.context_length,
        vision: apiMeta?.vision ?? item.vision ?? false,
        tools: apiMeta?.tools ?? item.tools ?? true,
        reasoning: hasReasoning,
        include_reasoning_in_request: hasReasoning,
        max_tokens: getMaxOutputTokens(),
        temperature: getTemperature(),
        top_p: getTopP(),
    };
    _apiModelConfigs.set(item.id, config);
    return config;
}

/**
 * Get model configuration for a previously registered model.
 * Returns undefined if the model ID was not registered (unknown model).
 */
export function getModelConfig(modelId: string): AmdModelItem | undefined {
    const config = _apiModelConfigs.get(modelId);
    if (!config) {
        return undefined;
    }
    // Return a shallow copy — provider.ts mutates the returned object per
    // request (enable_reasoning, temperature, …). Without the copy those
    // mutations would leak into subsequent requests reusing the stored object.
    return { ...config };
}

/**
 * Clear all registered model configs (for manual refresh).
 */
export function clearModelConfigs(): void {
    _apiModelConfigs.clear();
}

/**
 * Get the list of available language models contributed by this provider.
 *
 * When the "amdTokenFactory.enableAutoModelDiscovery" setting is enabled (default),
 * the provider fetches the actual model list from the API /models endpoint and:
 * - Refreshes built-in models with API metadata
 * - Discovers new models from the API that are not in the built-in list
 *
 * Serving strategy (stale-while-revalidate):
 * - First open with no cache: blocking fetch so the real list shows immediately.
 * - Otherwise: the cached list is returned instantly (picker never waits on
 *   the network) and a background revalidation runs; when it brings changes,
 *   `onModelsRefreshed` fires so VS Code rebuilds the picker with fresh data.
 *
 * Falls back to the full built-in list if the API is unreachable or no key exists.
 */
export async function prepareLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    _token: CancellationToken,
    _secrets: vscode.SecretStorage,
    baseUrl: string,
    onModelsRefreshed?: () => void
): Promise<LanguageModelChatInformation[]> {
    // Start with the built-in list (zero-config fallback) + whitelist models
    let items: AmdModelItem[] = [...BUILT_IN_MODELS, ...WHITELISTED_MODELS];

    const enableAutoDiscovery = vscode.workspace.getConfiguration("amdTokenFactory").get<boolean>("enableAutoModelDiscovery", true);
    if (enableAutoDiscovery) {
        // Use the primary key — any valid key works for /models.
        const primaryKey = await getPrimaryApiKey(_secrets);
        const apiKey = primaryKey?.value;
        const apiModelIds = await getApiModelIds(baseUrl, apiKey);

        if (apiModelIds.size > 0 && isApiFetchSuccessful()) {
            const metadataList = await getApiModelMetadataList(baseUrl, apiKey);

            // Step 1: refresh built-in models with API metadata; keep only
            // built-in models that still exist on the API
            const builtInIds = new Set(BUILT_IN_MODELS.map((m) => m.id));
            items = BUILT_IN_MODELS.filter((m) => apiModelIds.has(m.id));

            // Step 2: discover API-only models not in the built-in list
            const discovered: AmdModelItem[] = [];
            for (const meta of metadataList) {
                if (builtInIds.has(meta.id)) {
                    continue;
                }
                discovered.push({
                    id: meta.id,
                    displayName: meta.id,
                    context_length: meta.context_length,
                    vision: meta.vision,
                    tools: meta.tools,
                    reasoning: meta.reasoning,
                });
            }
            if (discovered.length > 0) {
                logger.info("models.discovery", { discovered: discovered.map((m) => m.id) });
            }

            // Step 3: inject whitelist models the /models endpoint still omits.
            // Once /models lists them, the API entry (fresher metadata) wins via
            // discovery above and injection skips them — no duplicates.
            const whitelistedMissing = WHITELISTED_MODELS.filter((m) => !apiModelIds.has(m.id));
            if (whitelistedMissing.length > 0) {
                logger.info("models.whitelist.injected", { injected: whitelistedMissing.map((m) => m.id) });
            }
            items = [...items, ...whitelistedMissing, ...discovered];
        }

        // Background revalidation: keep the picker fresh without ever blocking
        // it on the network. Only notifies when the metadata actually changed,
        // so VS Code's re-query doesn't loop (a fresh cache skips revalidation).
        void revalidateApiModelList(baseUrl, apiKey).then((changed) => {
            if (changed) {
                onModelsRefreshed?.();
            }
        });
    }

    // Build infos + register per-request configs
    const metadataList = await getApiModelMetadataList(baseUrl, undefined);
    const metaById = new Map(metadataList.map((m) => [m.id, m]));
    const infos: LanguageModelChatInformation[] = [];
    for (const item of items) {
        const meta = metaById.get(item.id);
        infos.push(buildModelInfo(item, meta));
        storeModelConfig(item, meta);
    }

    logger.info("models.ready", { count: infos.length, models: infos.map((i) => i.id) });
    return infos;
}
