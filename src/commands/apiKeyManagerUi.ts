/**
 * apiKeyManagerUi.ts — API Key 管理 QuickPick 主入口。
 *
 * 支持：添加 / 批量导入 / 删除 / 设为当前使用 / 编辑 / 重置失效状态 /
 * 绑定或清除平台登录凭据 / 检测可用性 / 查询余额。所有 key 与凭据均以脱敏形式展示。
 *
 * 本文件只负责**渲染主菜单 + 分发动作**；展示辅助见 `apiKeyDisplay.ts`，
 * 各交互流程见 `apiKeyFlows.ts`。
 */
import * as vscode from "vscode";
import { l10n } from "../core/localize";
import {
    getApiKeyMode,
    getApiKeyStore,
    resetExhaustedKeys,
    setActiveKey,
} from "../keys/keyManager";
import { buildKeyQuickPickItems } from "./apiKeyDisplay";
import {
    addKeyFlow,
    batchImportFlow,
    deleteKeysFlow,
    editKeyFlow,
    pickKey,
    showCheckMenu,
    type KeyManagerContext,
} from "./apiKeyFlows";

/**
 * API Key 管理 QuickPick 主流程（`amdtokenfactory.manageApiKeys` 命令）。
 *
 * 循环渲染 key 列表与动作项，直到用户取消。动作分发到 `apiKeyFlows.ts` 中的
 * 各流程函数。
 */
export async function showApiKeyManager(context: vscode.ExtensionContext): Promise<void> {
    const ctx: KeyManagerContext = {
        secrets: context.secrets,
    };

    const render = async (): Promise<vscode.QuickPickItem[] | undefined> => {
        const store = await getApiKeyStore(ctx.secrets);
        // "Set as Current" pins the key used in single mode (active key) and
        // sticky mode (pinned key). In rotation mode the round-robin cursor is
        // used, so the action is hidden entirely.
        const mode = getApiKeyMode();
        const canSetCurrent = mode === "single" || mode === "sticky";
        const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

        if (store.keys.length === 0) {
            items.push({ label: l10n("No API keys configured"), kind: vscode.QuickPickItemKind.Separator });
        } else {
            items.push(...(await buildKeyQuickPickItems(store, "select")));
        }

        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(plus) ${l10n("Add API Key")}`, action: "add" });
        items.push({ label: `$(import) ${l10n("Import API Keys (batch)")}`, action: "import" });
        if (store.keys.length > 0) {
            items.push({ label: `$(trash) ${l10n("Delete API Key")}`, action: "delete" });
            // "Set as Current" pins the key used in single/sticky mode — hide it
            // entirely in rotation mode (round-robin by design).
            if (canSetCurrent) {
                items.push({ label: `$(star) ${l10n("Set as Current")}`, action: "setActive" });
            }
            items.push({ label: `$(edit) ${l10n("Edit API Key")}`, action: "edit" });
            items.push({ label: `$(refresh) ${l10n("Reset Exhausted States")}`, action: "reset" });
            items.push({ label: `$(beaker) ${l10n("Check Availability")}`, action: "check" });
        }
        return items;
    };

    // ---- Main loop ----
    while (true) {
        const items = await render();
        if (!items) {
            return;
        }
        const picked = await vscode.window.showQuickPick(items, {
            title: l10n("Select an API key to manage"),
            placeHolder: l10n("Select an API key to manage"),
            ignoreFocusOut: true,
        });
        if (!picked) {
            return; // canceled
        }
        const pickedAction = (picked as { action?: string }).action;
        if (!pickedAction) {
            // Clicking a key entry itself (action "select") has no dedicated
            // view — stay in the menu instead of silently closing it.
            continue;
        }

        switch (pickedAction) {
            case "add": {
                await addKeyFlow(ctx);
                break;
            }
            case "import": {
                await batchImportFlow(ctx);
                break;
            }
            case "delete": {
                await deleteKeysFlow(ctx);
                break;
            }
            case "setActive": {
                // "Set as Current" pins the key used in single mode (active key)
                // and sticky mode (pinned key); in rotation mode the round-robin
                // cursor is used, so the action is not offered.
                if (getApiKeyMode() === "rotation") {
                    vscode.window.showInformationMessage(l10n("Set as Current is only valid in single/sticky mode (apiKeyMode=single or sticky)"));
                    break;
                }
                const keyPick = await pickKey(ctx, l10n("Set as Current"));
                if (!keyPick) {
                    break;
                }
                await setActiveKey(ctx.secrets, keyPick.index);
                vscode.window.showInformationMessage(l10n("Set as current API key"));
                break;
            }
            case "edit": {
                const keyPick = await pickKey(ctx, l10n("Edit API Key"));
                if (!keyPick) {
                    break;
                }
                await editKeyFlow(ctx, keyPick.index);
                break;
            }
            case "reset": {
                await resetExhaustedKeys(ctx.secrets, true);
                vscode.window.showInformationMessage(l10n("Reset exhausted key states"));
                break;
            }
            case "check": {
                await showCheckMenu(ctx);
                break;
            }
            default:
                return;
        }
    }
}
