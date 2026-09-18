import * as vscode from "vscode";
import { AmdChatModelProvider } from "./provider";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import {
    addApiKey,
    addApiKeys,
    getApiKeyMode,
    getApiKeyStore,
    getKeyDisplayStatus,
    getRotationCursorIndex,
    getTransientExhaustedInfo,
    maskApiKey,
    removeApiKey,
    resetExhaustedKeys,
    updateApiKey,
    updateKeyAvailability,
    type ApiKeyEntry,
} from "./keyManager";
import { clearApiModelCache, revalidateApiModelList } from "./apiModelList";
import { clearModelConfigs } from "./provideModel";
import { getPrimaryApiKey } from "./keyManager";

/** 格式化剩余冷却时间（如 "4m32s"） */
function formatRemainingSec(sec: number): string {
    if (sec >= 60) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}m${s}s`;
    }
    return `${sec}s`;
}

/** 格式化"不可用"状态文本：附原因（如 401）。401 无冷却期，保持不可用直到手动重检/重置 */
function formatUnavailableStatus(entry: ApiKeyEntry): string {
    return entry.unavailableReason
        ? `${l10n("unavailable")} (${entry.unavailableReason})`
        : l10n("unavailable");
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.init();

    const provider = new AmdChatModelProvider(context.secrets);

    // Register the AMD TokenFactory provider under the vendor id used in package.json
    vscode.lm.registerLanguageModelChatProvider("amdtokenfactory", provider);

    // 清空模型缓存并让 VS Code 重新查询 provider 重建模型清单。
    // key 从无到有（或删除最后一个 key）会改变 /models 自动发现的前提条件，
    // 因此 key 增删后必须调用，否则模型选择器停留在内置兜底清单。
    const refreshModelList = (): void => {
        clearApiModelCache();
        clearModelConfigs();
        provider.notifyModelListChanged();
    };

    // Refresh the model list when relevant settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            const requestRebuild =
                e.affectsConfiguration("amdTokenFactory.baseUrl")
                || e.affectsConfiguration("amdTokenFactory.enableAutoModelDiscovery")
                || e.affectsConfiguration("amdTokenFactory.maxOutputTokens")
                || e.affectsConfiguration("amdTokenFactory.temperature")
                || e.affectsConfiguration("amdTokenFactory.top_p");
            if (requestRebuild) {
                if (e.affectsConfiguration("amdTokenFactory.baseUrl") || e.affectsConfiguration("amdTokenFactory.enableAutoModelDiscovery")) {
                    clearApiModelCache();
                }
                clearModelConfigs();
                provider.notifyModelListChanged();
            }
        })
    );

    // 启动预热：激活后立即后台拉取一次 /models（有 key 时），让首次打开模型
    // 选择器直接命中缓存、零网络等待；平台上下架模型也会在会话开始前同步。
    // 清单有实际变化时通知 VS Code 重建（无变化不打扰）。失败静默降级为内置清单。
    void (async () => {
        try {
            const baseUrl = vscode.workspace.getConfiguration("amdTokenFactory").get<string>(
                "baseUrl",
                "https://developer.amd.com.cn/radeon/api/v1"
            );
            const primaryKey = await getPrimaryApiKey(context.secrets, { ignoreTransient: true });
            const changed = await revalidateApiModelList(baseUrl, primaryKey?.value);
            if (changed) {
                provider.notifyModelListChanged();
            }
        } catch (err) {
            logger.warn("startup.modelPrefetch.failed", {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    })();

    // Register the refreshModels command: clear caches and re-query the model list
    context.subscriptions.push(
        vscode.commands.registerCommand("amdtokenfactory.refreshModels", async () => {
            refreshModelList();
            vscode.window.showInformationMessage(l10n("Model list refreshed"));
        })
    );

    // Command to open the AMD TokenFactory website
    context.subscriptions.push(
        vscode.commands.registerCommand("amdtokenfactory.getApiKey", () => {
            vscode.env.openExternal(vscode.Uri.parse("https://developer.amd.com.cn/radeon/tokenfactory"));
        })
    );

    // Command to open extension settings
    context.subscriptions.push(
        vscode.commands.registerCommand("amdtokenfactory.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:luotianyiismywife.amd-tokenfactory-copilot");
        })
    );


    // Multi-key management QuickPick
    context.subscriptions.push(
        vscode.commands.registerCommand("amdtokenfactory.manageApiKeys", async () => {
            await showApiKeyManager(context);
        })
    );

    // 检测单个 key 可用性：发一次最小 chat 请求验证（免费端点无余额概念）
    const testKeyAvailability = async (entry: ApiKeyEntry): Promise<{ ok: boolean | null; reason?: string }> => {
        try {
            const baseUrl = vscode.workspace.getConfiguration("amdTokenFactory").get<string>(
                "baseUrl",
                "https://developer.amd.com.cn/radeon/api/v1"
            );
            const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${entry.value}`,
                },
                body: JSON.stringify({
                    model: "DeepSeek-V4-Flash-Vision-Exp",
                    messages: [{ role: "user", content: "ping" }],
                    max_tokens: 1,
                }),
            });
            if (res.ok) {
                return { ok: true };
            }
            const text = await res.text();
            return { ok: false, reason: `[${res.status}] ${text.slice(0, 200)}` };
        } catch (err) {
            return { ok: null, reason: err instanceof Error ? err.message : String(err) };
        }
    };

    /**
     * API Key 管理 QuickPick。
     * 支持：添加 / 批量导入 / 删除 / 重置失效 / 检测可用性。
     * 所有 key 均以脱敏形式展示。
     */
    async function showApiKeyManager(_context: vscode.ExtensionContext): Promise<void> {
        const secrets = _context.secrets;

        const modeLabel = (): string => {
            const mode = getApiKeyMode();
            return mode === "rotation"
                ? l10n("Rotation mode: next key per request")
                : l10n("Sticky mode: keep current key until it fails");
        };

        // ---- Select a key (for edit/delete/check) ----
        const pickKey = async (title: string): Promise<{ index: number; entry: ApiKeyEntry } | undefined> => {
            const store = await getApiKeyStore(secrets);
            if (store.keys.length === 0) {
                vscode.window.showInformationMessage(l10n("No API keys configured."));
                return undefined;
            }
            const cursor = getRotationCursorIndex();
            const isSticky = getApiKeyMode() === "sticky";
            const picked = await vscode.window.showQuickPick(
                store.keys.map((entry, index) => {
                    const detailParts: string[] = [];
                    if (entry.label) {
                        detailParts.push(entry.label);
                    }
                    const status = getKeyDisplayStatus(entry);
                    if (status === "available") {
                        detailParts.push("$(check) " + l10n("available"));
                    } else if (status === "unavailable") {
                        detailParts.push("$(error) " + formatUnavailableStatus(entry));
                    } else if (status === "cooldown") {
                        const transient = getTransientExhaustedInfo(entry.value);
                        detailParts.push(`$(clock) ${l10n("cooling down")}${transient ? " " + formatRemainingSec(transient.remainingSec) : ""}`);
                    } else {
                        detailParts.push("$(question) " + l10n("Not checked"));
                    }
                    if (index === cursor) {
                        detailParts.push(isSticky ? `$(pinned) ${l10n("Pinned")}` : `$(arrow-right) ${l10n("Rotation cursor")}`);
                    }
                    return {
                        label: maskApiKey(entry.value),
                        description: detailParts.join(" · "),
                        entry,
                        index,
                    };
                }),
                { title, placeHolder: title, ignoreFocusOut: true }
            );
            if (!picked) {
                return undefined;
            }
            return { index: picked.index as number, entry: picked.entry as ApiKeyEntry };
        };

        // ---- Edit API key flow (value / label) ----
        const editKeyFlow = async (index: number): Promise<void> => {
            const store = await getApiKeyStore(secrets);
            const entry = store.keys[index];
            if (!entry) {
                return;
            }

            // 1. Key value (editable; conflicts checked on save)
            const newValue = await vscode.window.showInputBox({
                title: l10n("Edit API Key"),
                prompt: l10n("Edit the API key value (leave unchanged to keep)"),
                ignoreFocusOut: true,
                password: true,
                value: entry.value,
            });
            if (newValue === undefined) {
                return;
            }

            // 2. Label
            const newLabel = await vscode.window.showInputBox({
                title: l10n("Edit API Key"),
                prompt: l10n("Edit the label (empty to clear)"),
                ignoreFocusOut: true,
                value: entry.label ?? "",
            });
            if (newLabel === undefined) {
                return;
            }

            const result = await updateApiKey(secrets, entry.value, {
                value: newValue.trim(),
                label: newLabel.trim(),
            });
            if (result.ok) {
                vscode.window.showInformationMessage(l10n("API key updated"));
            } else if (result.conflict) {
                vscode.window.showWarningMessage(l10n("API key value conflicts with another existing key"));
            } else {
                vscode.window.showWarningMessage(l10n("Failed to update API key"));
            }
        };

        const checkAvailabilityFlow = async (entry: ApiKeyEntry): Promise<void> => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: l10n("Checking availability...") },
                async () => {
                    const result = await testKeyAvailability(entry);
                    if (result.ok === true) {
                        await updateKeyAvailability(secrets, entry.value, true);
                        vscode.window.showInformationMessage(l10n("Key is available"));
                    } else if (result.ok === false) {
                        await updateKeyAvailability(secrets, entry.value, false, result.reason);
                        vscode.window.showErrorMessage(l10nFormat("Key is NOT available: {0}", result.reason ?? ""));
                    } else {
                        vscode.window.showWarningMessage(l10n("Key availability unknown"));
                    }
                }
            );
        };

        // ---- Per-key action submenu (opened by clicking a key row) ----
        const keyActionMenu = async (index: number): Promise<void> => {
            const store = await getApiKeyStore(secrets);
            const entry = store.keys[index];
            if (!entry) {
                return;
            }
            const items: (vscode.QuickPickItem & { action?: string })[] = [
                { label: `$(edit) ${l10n("Edit API Key")}`, action: "edit" },
                { label: `$(trash) ${l10n("Delete API Key")}`, action: "delete" },
                { label: `$(test-view-icon) ${l10n("Check This Key")}`, action: "check" },
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: l10nFormat("Key {0}", maskApiKey(entry.value)),
                placeHolder: l10n("Manage API Keys"),
                ignoreFocusOut: true,
            });
            if (!picked?.action) {
                return;
            }
            switch (picked.action) {
                case "edit":
                    await editKeyFlow(index);
                    break;
                case "delete": {
                    const confirm = await vscode.window.showWarningMessage(
                        l10nFormat("Delete key {0}?", maskApiKey(entry.value)),
                        { modal: true },
                        l10n("Delete")
                    );
                    if (confirm === l10n("Delete")) {
                        await removeApiKey(secrets, entry.value);
                        vscode.window.showInformationMessage(l10n("Key deleted."));
                        refreshModelList();
                    }
                    break;
                }
                case "check":
                    await checkAvailabilityFlow(entry);
                    break;
            }
        };

        // ---- Main menu render: keys listed first (with live status), actions below ----
        const renderMainMenu = async (): Promise<(vscode.QuickPickItem & { action?: string; index?: number })[]> => {
            const store = await getApiKeyStore(secrets);
            const cursor = getRotationCursorIndex();
            const isSticky = getApiKeyMode() === "sticky";
            const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [];

            if (store.keys.length === 0) {
                items.push({ label: l10n("No API keys configured."), kind: vscode.QuickPickItemKind.Separator });
            } else {
                store.keys.forEach((entry, index) => {
                    const status = getKeyDisplayStatus(entry);
                    let statusIcon = "$(question)";
                    let statusText = l10n("Not checked");
                    if (status === "available") {
                        statusIcon = "$(check)";
                        statusText = l10n("available");
                    } else if (status === "unavailable") {
                        statusIcon = "$(error)";
                        statusText = formatUnavailableStatus(entry);
                    } else if (status === "cooldown") {
                        statusIcon = "$(clock)";
                        const transient = getTransientExhaustedInfo(entry.value);
                        statusText = transient
                            ? `${l10n("cooling down")} ${formatRemainingSec(transient.remainingSec)}`
                            : l10n("cooling down");
                    }
                    const detailParts = [
                        `${statusIcon} ${statusText}`,
                        index === cursor
                            ? (isSticky ? `$(pinned) ${l10n("Pinned")}` : `$(arrow-right) ${l10n("Rotation cursor")}`)
                            : "",
                        entry.label ? `$(tag) ${entry.label}` : "",
                    ].filter(Boolean);
                    items.push({
                        label: maskApiKey(entry.value),
                        description: detailParts.join("  ·  "),
                        index, // no action → clicking a key row opens the per-key submenu
                    });
                });
            }

            items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
            items.push({ label: `$(add) ${l10n("Add API Key (rc-...)")}`, action: "add" });
            items.push({ label: `$(clippy) ${l10n("Batch Import Keys")}`, action: "import" });
            if (store.keys.length > 0) {
                items.push({ label: `$(edit) ${l10n("Edit API Key")}`, action: "edit" });
                items.push({ label: `$(trash) ${l10n("Delete API Key")}`, action: "delete" });
                items.push({ label: `$(test-view-icon) ${l10n("Check This Key")}`, action: "checkOne" });
                items.push({ label: `$(zap) ${l10n("Check All Keys")}`, action: "checkAll" });
                items.push({ label: `$(debug-restart) ${l10n("Reset Unavailable Keys")}`, action: "reset" });
            }
            items.push({
                label: `$(info) ${l10nFormat("{0} key(s) configured", String(store.keys.length))}`,
                description: modeLabel(),
            });
            return items;
        };

        // ---- Main loop (runs until the user presses Esc) ----
        while (true) {
            const items = await renderMainMenu();
            const picked = await vscode.window.showQuickPick(items, {
                title: l10n("Manage API Keys"),
                placeHolder: l10n("Manage API Keys"),
                ignoreFocusOut: true,
            });
            if (!picked) {
                return; // canceled
            }
            const pickedAction = (picked as { action?: string }).action;
            const pickedIndex = (picked as { index?: number }).index;

            if (!pickedAction && typeof pickedIndex === "number") {
                // Clicked a key row → per-key submenu (edit/delete/check)
                await keyActionMenu(pickedIndex);
                continue;
            }

            switch (pickedAction) {
                case "add": {
                    const keyValue = await vscode.window.showInputBox({
                        title: l10n("Add API Key"),
                        prompt: l10n("Enter your AMD TokenFactory API key (rc-...)"),
                        ignoreFocusOut: true,
                        password: true,
                    });
                    if (keyValue === undefined || !keyValue.trim()) {
                        break;
                    }
                    const label = await vscode.window.showInputBox({
                        title: l10n("Note (optional)"),
                        prompt: l10n("Optional note for this key"),
                        ignoreFocusOut: true,
                    });
                    const added = await addApiKey(secrets, { value: keyValue.trim(), label: label?.trim() || undefined, available: null });
                    if (added) {
                        vscode.window.showInformationMessage(l10n("API key saved."));
                        refreshModelList();
                    } else {
                        vscode.window.showWarningMessage(l10n("Key already exists"));
                    }
                    break;
                }
                case "import": {
                    const text = await vscode.window.showInputBox({
                        title: l10n("Batch Import API Keys"),
                        prompt: l10n("Enter one key per line (optional note after a comma, e.g. rc-xxx,main)"),
                        ignoreFocusOut: true,
                    });
                    if (!text) {
                        break;
                    }
                    const entries: ApiKeyEntry[] = [];
                    for (const line of text.split(/\r?\n/)) {
                        const trimmed = line.trim();
                        if (!trimmed) {
                            continue;
                        }
                        const [value, label] = trimmed.split(",", 2);
                        entries.push({ value: value.trim(), label: label?.trim() || undefined, available: null });
                    }
                    const { added, skipped } = await addApiKeys(secrets, entries);
                    vscode.window.showInformationMessage(l10nFormat("Imported {0} key(s), skipped {1} duplicate(s).", String(added), String(skipped)));
                    if (added > 0) {
                        refreshModelList();
                    }
                    break;
                }
                case "edit": {
                    const keyPick = await pickKey(l10n("Edit API Key"));
                    if (keyPick) {
                        await editKeyFlow(keyPick.index);
                    }
                    break;
                }
                case "delete": {
                    const keyPick = await pickKey(l10n("Delete API Key"));
                    if (!keyPick) {
                        break;
                    }
                    const confirm = await vscode.window.showWarningMessage(
                        l10nFormat("Delete key {0}?", maskApiKey(keyPick.entry.value)),
                        { modal: true },
                        l10n("Delete")
                    );
                    if (confirm === l10n("Delete")) {
                        await removeApiKey(secrets, keyPick.entry.value);
                        vscode.window.showInformationMessage(l10n("Key deleted."));
                        refreshModelList();
                    }
                    break;
                }
                case "reset": {
                    const confirm = await vscode.window.showWarningMessage(
                        l10n("Reset cooldown and unavailable marks for all keys?"),
                        { modal: true },
                        l10n("Reset")
                    );
                    if (confirm === l10n("Reset")) {
                        await resetExhaustedKeys(secrets, true);
                        vscode.window.showInformationMessage(l10n("All key states reset."));
                    }
                    break;
                }
                case "checkOne": {
                    const keyPick = await pickKey(l10n("Check This Key"));
                    if (keyPick) {
                        await checkAvailabilityFlow(keyPick.entry);
                    }
                    break;
                }
                case "checkAll": {
                    const all = (await getApiKeyStore(secrets)).keys;
                    if (all.length === 0) {
                        vscode.window.showInformationMessage(l10n("No API keys configured."));
                        break;
                    }
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: l10n("Checking availability of all keys..."), cancellable: false },
                        async (progress) => {
                            let available = 0;
                            let unavailable = 0;
                            let unknown = 0;
                            for (let i = 0; i < all.length; i++) {
                                const entry = all[i];
                                progress.report({ message: l10nFormat("Checking {0}/{1}: {2}", String(i + 1), String(all.length), maskApiKey(entry.value)) });
                                const result = await testKeyAvailability(entry);
                                if (result.ok === true) {
                                    await updateKeyAvailability(secrets, entry.value, true);
                                    available++;
                                } else if (result.ok === false) {
                                    await updateKeyAvailability(secrets, entry.value, false);
                                    unavailable++;
                                } else {
                                    unknown++;
                                }
                            }
                            vscode.window.showInformationMessage(
                                l10nFormat("Available: {0}, Unavailable: {1}, Unknown: {2}", String(available), String(unavailable), String(unknown))
                            );
                        }
                    );
                    break;
                }
                default:
                    return;
            }
        }
    }
}

export function deactivate() {
    logger.dispose();
}
