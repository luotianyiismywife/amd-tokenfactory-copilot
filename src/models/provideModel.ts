import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation, PrepareLanguageModelChatModelOptions } from "vscode";

import { logger } from "../core/logger";
import { getPrimaryApiKey } from "../keys/keyManager";
import { toLanguageModelChatInformation } from "./chatInfo";
import { getAnthropicModelIds, refreshModelRegistry } from "./registry";

/**
 * VS Code 模型提供商入口：把 `registry.ts` 的归一化模型信息翻译成
 * `LanguageModelChatInformation[]`，并按 `apiMode` 设置做协议过滤。
 *
 * 本文件只做「VS Code 接口适配」——不含模型数据、不含能力判定、
 * 不含字段兜底链（这些都在 `src/models` 的其它模块里，且只有一份）。
 */

/**
 * Get the list of available language models contributed by this provider.
 *
 * The model list is FULLY DYNAMIC — driven by the API's /v1/models response
 * (non-chat entries already filtered in apiModelList.ts):
 * - API reachable → the returned list IS the model list (display names,
 *   descriptions and capability flags all come from the API)
 * - API unreachable → fall back to the built-in list
 *
 * All merging / capability resolution happens in `registry.ts`; this function
 * only adapts the result to the VS Code contract.
 */
export async function prepareLanguageModelChatInformation(
    _options: PrepareLanguageModelChatModelOptions,
    _token: CancellationToken,
    secrets: vscode.SecretStorage
): Promise<LanguageModelChatInformation[]> {
    const config = vscode.workspace.getConfiguration();

    // ── Auto model discovery toggle ──
    // When disabled, always use the built-in list (no /v1/models call, no
    // models.dev lookup). Default on.
    const autoDiscoveryEnabled = config.get<boolean>("amdTokenFactory.enableAutoModelDiscovery", true);

    // Use the primary key — any valid key works for /v1/models (no balance check).
    const primaryKey = autoDiscoveryEnabled ? await getPrimaryApiKey(secrets) : undefined;
    const models = await refreshModelRegistry(primaryKey?.value, autoDiscoveryEnabled);

    let infos: LanguageModelChatInformation[] = models.map(toLanguageModelChatInformation);

    // ── Filter by apiMode: only list models supported by the selected protocol ──
    // "auto" / "openai" → all models (every model supports the OpenAI-compatible format)
    // "anthropic"       → only models with supports_anthropic=true (from /v1/models)
    // If the capability set is empty (API probe failed / not fetched yet), keep all
    // models rather than showing an empty list — the user can retry on next reload.
    const apiModeSetting = config.get<string>("amdTokenFactory.apiMode", "auto");
    if (apiModeSetting === "anthropic") {
        const anthropicModelIds = getAnthropicModelIds();
        if (anthropicModelIds.size > 0) {
            infos = infos.filter((info) => anthropicModelIds.has(info.id));
        }
    }

    logger.info("models.loaded", { count: infos.length, source: "total" });
    return infos;
}
