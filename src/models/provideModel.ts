import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation, PrepareLanguageModelChatModelOptions } from "vscode";

import { logger } from "../core/logger";
import { getBuiltInModelInfos, getBuiltInModelConfig, getMaxInputTokensRatio } from "./models";
import { getApiModelIds, getApiModelMetadataList, getAnthropicSupportedModelIds, isApiFetchSuccessful, type ApiModelMetadata } from "./apiModelList";
import { ensureModelsDevLoaded, lookupModelDevEntry, type ModelsDevEntry } from "./modelsDev";
import { resolveVisionCapability } from "./visionModels";
import { getPrimaryApiKey } from "../keys/keyManager";
import type { ProviderModelItem } from "../core/types";
import { l10n } from "../core/localize";

const EXTENSION_LABEL = "AMD TokenFactory";
const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 32768;

// ── Module-level registry for auto-discovered model configs ──
// Key: model ID (API ID), Value: ProviderModelItem
const _autoDiscoveredConfigs = new Map<string, ProviderModelItem>();

/**
 * Module-level set of model IDs that report supports_anthropic=true on /v1/models.
 * Populated at startup (model list refresh) so provider.ts can decide the API
 * protocol dynamically without hardcoding specific model IDs.
 */
let _anthropicModelIds = new Set<string>();

/**
 * Get the current set of Anthropic-protocol-capable model IDs (supports_anthropic=true),
 * as detected from /v1/models at the last model list refresh.
 * Synchronous — callers do not block; returns an empty set if not yet fetched.
 */
export function getAnthropicModelIds(): Set<string> {
    return _anthropicModelIds;
}

/**
 * Build a LanguageModelChatInformation entry for an auto-discovered model.
 * All auto-discovered models default to thinkingMode="always" (no thinking toggle).
 */
function buildAutoDiscoveredInfo(
    modelId: string,
    apiMeta: ApiModelMetadata | undefined,
    entry: ModelsDevEntry | undefined
): LanguageModelChatInformation | undefined {
    // Determine display name: /v1/models display_name is the primary source
    // (platform truth); models.dev carries friendly names as fallback.
    const displayName = apiMeta?.display_name ?? entry?.name ?? modelId;

    // Tooltip: /v1/models desc (model description) when available.
    const tooltip = apiMeta?.desc ?? EXTENSION_LABEL;

    // Determine context length and max output tokens.
    // /v1/models metadata is the PRIMARY source (platform truth); models.dev is
    // the fallback when the API entry lacks the fields. The hardcoded defaults
    // are a last resort — a wrong 4096 output cap let reasoning models burn the
    // whole budget in thinking before writing any answer text, which surfaced
    // in Copilot Chat as "Sorry, no response was returned.".
    const contextLength = apiMeta?.context_length ?? entry?.limit?.context ?? DEFAULT_CONTEXT_LENGTH;
    const maxOutputTokens = apiMeta?.max_completion_tokens ?? entry?.limit?.output ?? DEFAULT_MAX_TOKENS;

    // Determine tool calling support
    const toolCalling = apiMeta?.supports_tools ?? (entry?.tool_call ?? true);

    // Determine thinking mode: /v1/models supports_reasoning is primary,
    // models.dev reasoning is the fallback.
    // reasoning=true → model supports thinking → show effort levels (switchable)
    // reasoning=false/undefined → no thinking capability → always (no toggle)
    //
    // AMD TokenFactory 用 `reasoning_effort`（none/low/medium/high）控制思考深度，
    // **不支持 `thinking` 参数**。思考是模型固有属性，档位只影响深度。
    const hasReasoning = apiMeta?.supports_reasoning ?? (entry?.reasoning === true);
    let enumValues: string[];
    let enumItemLabels: string[];
    let enumDescriptions: string[];

    if (hasReasoning) {
        // switchable: user can turn thinking off or pick an effort level
        enumValues = ["disabled", "low", "medium", "high"];
        enumItemLabels = [l10n("Disabled"), l10n("Low"), l10n("Medium"), l10n("High")];
        enumDescriptions = [
            l10n("Do not enable thinking"),
            l10n("Reduce thinking, faster response"),
            l10n("Balance thinking and speed"),
            l10n("Deeper thinking, slower response"),
        ];
    } else {
        // always: thinking not supported, no toggle
        enumValues = ["enabled"];
        enumItemLabels = [l10n("Thinking")];
        enumDescriptions = [l10n("Enable thinking")];
    }

    // Create the entry
    const info: LanguageModelChatInformation = {
        id: modelId,
        name: displayName,
        detail: EXTENSION_LABEL,
        tooltip: tooltip,
        family: EXTENSION_LABEL,
        version: "1.0.0",
        // Declare maxInputTokens as a configurable ratio (default 80%) of the real
        // context window so VS Code's agent auto-compaction (~90% of maxInputTokens)
        // can fire before the context actually fills up.
        maxInputTokens: Math.floor(contextLength * getMaxInputTokensRatio()),
        maxOutputTokens: maxOutputTokens,
        isUserSelectable: true,
        capabilities: {
            toolCalling: toolCalling,
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
                    enumItemLabels: enumItemLabels,
                    enumDescriptions: enumDescriptions,
                    default: hasReasoning ? "high" : "enabled",
                    group: "navigation",
                },
            },
        },
    } satisfies LanguageModelChatInformation;

    return info;
}

/**
 * Build and store a ProviderModelItem config for an auto-discovered model.
 * @param apiMode - Effective API protocol for the model ("openai" | "responses").
 */
function storeAutoDiscoveredConfig(
    modelId: string,
    apiMeta: ApiModelMetadata | undefined,
    entry: ModelsDevEntry | undefined,
    apiMode: string = "openai"
): ProviderModelItem {
    // Vision capability: /v1/models flag → models.dev → hardcoded fallback.
    // Shared with the vision-proxy picker so both agree on the same model set.
    const vision = resolveVisionCapability(modelId, apiMeta, entry);
    const hasReasoning = apiMeta?.supports_reasoning ?? (entry?.reasoning === true);

    // Known output limit from /v1/models (primary) or models.dev (fallback).
    // When NEITHER source knows the limit, leave max_completion_tokens UNSET
    // so the request body sends no cap at all (server-side default) instead of
    // a wrong 4096 cap that reasoning models can exhaust before any answer text.
    const knownMaxCompletion = apiMeta?.max_completion_tokens ?? entry?.limit?.output;

    const config: ProviderModelItem = {
        id: modelId,
        owned_by: "provider",
        displayName: apiMeta?.display_name ?? entry?.name ?? modelId,
        vision: vision,
        supportsTemperature: entry?.temperature ?? true,
        context_length: apiMeta?.context_length ?? (entry?.limit?.context ?? DEFAULT_CONTEXT_LENGTH),
        ...(knownMaxCompletion !== undefined ? { max_completion_tokens: knownMaxCompletion } : {}),
        apiMode: apiMode,
        enable_thinking: hasReasoning,
        include_reasoning_in_request: hasReasoning,
        thinkingMode: hasReasoning ? "switchable" : "always",
    };

    // Keep the entry reference for reference
    _autoDiscoveredConfigs.set(modelId, config);
    return config;
}

/**
 * Get model configuration for a previously auto-discovered model.
 * Returns undefined if the model ID was not auto-discovered.
 */
export function getAutoDiscoveredModelConfig(modelId: string): ProviderModelItem | undefined {
    const config = _autoDiscoveredConfigs.get(modelId);
    if (!config) {
        return undefined;
    }
    // Return a shallow copy — provider.ts mutates the returned object per
    // request (enable_thinking, temperature, reasoning_effort, …). Without the
    // copy those mutations would leak into subsequent requests reusing the
    // stored object (e.g. a stale reasoning_effort from a previous turn).
    return { ...config };
}

/**
 * Best-effort check whether a model ID is vision-capable, using the built-in
 * definitions and the auto-discovered configs.
 *
 * Used to guard the vision proxy against a misconfigured `visionProxyModel`:
 * pointing it at a NON-vision model would make the vision request itself trigger
 * the ask_image proxy again → recursion. Returns `undefined` when the model is
 * unknown (caller should not block on an unknown model).
 *
 * Accepts a bare ID or a vendor-qualified ID (`vendor/model-id`).
 */
export function isVisionCapableModelId(modelId: string): boolean | undefined {
    const bare = modelId.includes("/") ? modelId.substring(modelId.lastIndexOf("/") + 1) : modelId;
    const cfg = getBuiltInModelConfig(bare) ?? getAutoDiscoveredModelConfig(bare);
    return cfg?.vision;
}

/**
 * Get the list of available language models contributed by this provider.
 *
 * The model list is FULLY DYNAMIC — driven by the API's /v1/models response
 * (mode=llm entries, already filtered in apiModelList.ts):
 * - API reachable → the returned list IS the model list (display names,
 *   descriptions and capability flags all come from the API)
 * - API unreachable → fall back to the hardcoded built-in list
 */
export async function prepareLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    _token: CancellationToken,
    _secrets: vscode.SecretStorage
): Promise<LanguageModelChatInformation[]> {
    const config = vscode.workspace.getConfiguration();
    let infos: LanguageModelChatInformation[] = [];

    // ── Auto model discovery toggle ──
    // When disabled, always use the built-in list (no /v1/models call, no
    // models.dev lookup). Default on.
    const autoDiscoveryEnabled = config.get<boolean>("amdTokenFactory.enableAutoModelDiscovery", true);

    // ── Dynamic model list from /v1/models ──
    // Use the primary key — any valid key works for /v1/models (no balance check).
    const primaryKey = autoDiscoveryEnabled ? await getPrimaryApiKey(_secrets) : undefined;
    const apiKey = primaryKey?.value;
    const apiModelIds = autoDiscoveryEnabled ? await getApiModelIds(apiKey) : new Set<string>();

    if (apiModelIds.size > 0 && isApiFetchSuccessful()) {
        // Step 0: Fetch Anthropic-protocol-capable model IDs (supports_anthropic=true)
        // Cached for provider.ts to query synchronously when routing requests in auto mode.
        const anthropicModelIds = await getAnthropicSupportedModelIds(apiKey);
        _anthropicModelIds = anthropicModelIds;
        if (anthropicModelIds.size > 0) {
            logger.info("models.discovery", {
                action: "anthropic_capable",
                models: [...anthropicModelIds],
            });
        }

        // Step 1: Build the model list from the API response — the API list IS
        // the model list. Load models.dev metadata only as a fallback for
        // specs the API entry lacks (context length / output limit).
        await ensureModelsDevLoaded();

        // Full /v1/models metadata — the platform's own spec for context
        // length, output limit, display name and capability flags.
        const apiMetaList = await getApiModelMetadataList(apiKey);
        const apiMetaMap = new Map<string, ApiModelMetadata>(apiMetaList.map((m) => [m.id, m]));

        for (const modelId of apiModelIds) {
            const apiMeta = apiMetaMap.get(modelId);
            const entry = lookupModelDevEntry(modelId);
            const newInfo = buildAutoDiscoveredInfo(modelId, apiMeta, entry);
            if (newInfo) {
                infos.push(newInfo);
                // Store config for later lookup by provider.ts.
                storeAutoDiscoveredConfig(modelId, apiMeta, entry, "openai");
            }
        }

        logger.info("models.discovery", {
            action: "api_list",
            count: infos.length,
        });
    } else {
        // API fetch failed, returned no models, or discovery is disabled —
        // fall back to the built-in list
        infos = getBuiltInModelInfos();
        logger.info("models.discovery", {
            action: "fallback",
            reason: !autoDiscoveryEnabled
                ? "disabled_by_setting"
                : apiModelIds.size === 0
                    ? "api_empty_or_failed"
                    : "not_successful",
            count: infos.length,
        });
    }

    // ── Filter by apiMode: only list models supported by the selected protocol ──
    // "auto" / "openai" → all models (every model supports the OpenAI-compatible format)
    // "anthropic"       → only models with supports_anthropic=true (from /v1/models)
    // If the capability set is empty (API probe failed / not fetched yet), keep all
    // models rather than showing an empty list — the user can retry on next reload.
    const apiModeSetting = config.get<string>("amdTokenFactory.apiMode", "auto");
    if (apiModeSetting === "anthropic" && _anthropicModelIds.size > 0) {
        infos = infos.filter((info) => _anthropicModelIds.has(info.id));
    }

    logger.info("models.loaded", { count: infos.length, source: "total" });
    return infos;
}
