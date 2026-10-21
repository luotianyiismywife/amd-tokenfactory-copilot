/**
 * apiKeyDisplay.ts — API Key 管理界面的**展示辅助**（纯函数，无副作用）。
 *
 * 从 `apiKeyManagerUi.ts` 拆出：key 详情行构建、key 列表 QuickPick 项构建。
 * 主界面 / key 选择界面 / 检测二级界面共用，保证展示逻辑只写一处。
 */
import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import {
    getApiKeyMode,
    getKeyDisplayStatus,
    getTransientExhaustedInfo,
    maskApiKey,
    type ApiKeyEntry,
    type ApiKeyStore,
} from "../keys/keyManager";

/**
 * 构建单个 key 的详情行（与主页 render() 一致的展示）。
 *
 * 包含：可用性状态（可用/不可用/冷却倒计时/未检测）、
 * 当前使用（★ Current，仅 single 模式）、固定使用（$(pinned)，仅 sticky 模式）、
 * 凭据绑定状态。删除/设为当前/编辑/绑定/清除凭据等 key 选择界面共用。
 */
export function buildKeyDetailLine(
    entry: ApiKeyEntry,
    options: { isActive?: boolean; isPinned?: boolean } = {},
): string {
    const status = getKeyDisplayStatus(entry);
    const transient = getTransientExhaustedInfo(entry.value);
    let statusIcon = "$(question)";
    let statusText = l10n("Not checked");
    if (status === "available") {
        statusIcon = "$(check)";
        statusText = l10n("Available");
    } else if (status === "unavailable") {
        statusIcon = "$(error)";
        statusText = l10n("Unavailable");
    } else if (status === "cooldown" && transient) {
        statusIcon = "$(clock)";
        statusText = l10nFormat("Cooldown ({0}s)", String(transient.remainingSec));
    } else if (status === "cooldown") {
        statusIcon = "$(clock)";
        statusText = l10n("Cooldown");
    }
    return [
        `${statusIcon} ${statusText}`,
        options.isActive ? `$(star) ${l10n("Current")}` : "",
        options.isPinned ? `$(pinned) ${l10n("Pinned")}` : "",
    ]
        .filter(Boolean)
        .join("  ·  ");
}

/**
 * 构建 key 列表的 QuickPick 项（label + 详情行），供主界面 `render()`、
 * key 选择界面 `pickKey()`、检测二级界面 `showCheckMenu()` 共用。
 */
export async function buildKeyQuickPickItems(
    store: ApiKeyStore,
    action: string,
): Promise<(vscode.QuickPickItem & { action?: string; index?: number; entry?: ApiKeyEntry })[]> {
    // Current/pinned markers follow the same mode rules as the main interface.
    // Both single and sticky modes pin the key at `activeIndex` (persisted).
    const keyMode = getApiKeyMode();
    const isSingleMode = keyMode === "single";
    const isStickyMode = keyMode === "sticky";
    return store.keys.map((entry, i) => ({
        label: `${maskApiKey(entry.value)}${entry.label ? ` (${entry.label})` : ""}`,
        description: buildKeyDetailLine(entry, {
            isActive: isSingleMode && i === store.activeIndex,
            isPinned: isStickyMode && i === store.activeIndex,
        }),
        action,
        index: i,
        entry,
    }));
}
