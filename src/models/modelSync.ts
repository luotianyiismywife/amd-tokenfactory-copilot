import * as vscode from "vscode";
import { getApiModelIds, isApiFetchSuccessful } from "./apiModelList";
import { ensureModelsDevLoaded } from "./modelsDev";
import { getBuiltInModelIds } from "./models";
import { getPrimaryApiKey } from "../keys/keyManager";
import { logger } from "../core/logger";

/**
 * Startup model sync.
 *
 * On every VS Code window open the extension checks whether the platform
 * API has any new models. To avoid hammering the API, the check runs at most
 * once per day (tracked via globalState). Sync results are reported as a
 * single log line in the extension's Output channel — no
 * file is written to the workspace (a `.copilot/model-sync-log.md` file was
 * previously created there, but that polluted user repositories, see issue #1).
 */

/** globalState key storing the last successful sync date (YYYY-MM-DD, local time). */
const SYNC_DATE_KEY = "amdTokenFactory.lastModelSyncDate";
/** Configuration key that enables/disables the startup sync. */
const SYNC_ENABLED_KEY = "syncModelsOnStartup";

/**
 * Append one sync event as a single line to the extension Output channel.
 * Failures are swallowed — logging must never break the startup flow.
 */
async function logSyncEvent(status: string, detail: string): Promise<void> {
    logger.info("models.sync", { status, detail });
}

/**
 * Check for new models on startup, at most once per day.
 * Safe to call without awaiting (fire-and-forget); all errors are handled
 * internally and never break extension activation.
 */
export async function syncModelsOnStartup(context: vscode.ExtensionContext): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration("amdTokenFactory");
        if (!config.get<boolean>(SYNC_ENABLED_KEY, true)) {
            return;
        }

        // Skip if a successful sync already happened today.
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        if (context.globalState.get<string>(SYNC_DATE_KEY) === today) {
            logger.debug("models.sync.skipped", { reason: "already-synced-today", date: today });
            return;
        }

        // Need an API key to query /v1/models. Use the primary key
        // (any valid key works — /v1/models does not check balance).
        const primaryKey = await getPrimaryApiKey(context.secrets);
        if (!primaryKey) {
            await logSyncEvent("⏭️ 跳过", "未配置 API Key");
            return;
        }

        // Warm the models.dev metadata cache (1h TTL) so auto-discovered
        // models get fresh capabilities.
        await ensureModelsDevLoaded();

        // Fetch the live model list from the API.
        const apiIds = await getApiModelIds(primaryKey.value);
        if (!isApiFetchSuccessful() || apiIds.size === 0) {
            await logSyncEvent("❌ 失败", "API 不可用或返回空列表");
            return;
        }

        // Detect models that are not in the built-in list.
        const builtInIds = getBuiltInModelIds();
        const newModels = [...apiIds].filter((id) => !builtInIds.has(id)).sort();
        const detail =
            newModels.length > 0
                ? `发现 ${newModels.length} 个新模型: ${newModels.join(", ")}`
                : `无新模型（API 共 ${apiIds.size} 个模型）`;

        // Mark today as synced BEFORE logging success: if globalState.update
        // throws, we land in the catch below and only log the ⚠️ line (no
        // duplicate ✅ line). A failed update also means we are NOT marked as
        // synced, so the next startup retries — as intended.
        await context.globalState.update(SYNC_DATE_KEY, today);
        await logSyncEvent("✅ 成功", detail);
    } catch (err) {
        logger.error("models.sync.error", { error: String(err) });
        try {
            await logSyncEvent("⚠️ 出错", `同步异常: ${String(err).slice(0, 200)}`);
        } catch {
            // ignore — logging failure must never break startup
        }
    }
}
