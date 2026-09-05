import * as vscode from "vscode";
import { AmdChatModelProvider } from "./provider";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import {
    addApiKey,
    addApiKeys,
    getApiKeyMode,
    getApiKeyStore,
    getRotationCursorIndex,
    getTransientExhaustedInfo,
    maskApiKey,
    removeApiKey,
    resetExhaustedKeys,
    updateKeyAvailability,
    type ApiKeyEntry,
} from "./keyManager";
import { clearApiModelCache } from "./apiModelList";
import { clearModelConfigs } from "./provideModel";

/** 格式化剩余冷却时间（如 "4m32s"） */
function formatRemainingSec(sec: number): string {
    if (sec >= 60) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}m${s}s`;
    }
    return `${sec}s`;
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.init();

    const provider = new AmdChatModelProvider(context.secrets);

    // Register the AMD TokenFactory provider under the vendor id used in package.json
    vscode.lm.registerLanguageModelChatProvider("amdtokenfactory", provider);

    // Refresh the model list when relevant settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("amdTokenFactory.baseUrl") || e.affectsConfiguration("amdTokenFactory.enableAutoModelDiscovery")) {
                clearApiModelCache();
                clearModelConfigs();
                provider.notifyModelListChanged();
            }
        })
    );

    // Register the refreshModels command: clear caches and re-query the model list
    context.subscriptions.push(
        vscode.commands.registerCommand("amdtokenfactory.refreshModels", async () => {
            clearApiModelCache();
            clearModelConfigs();
            provider.notifyModelListChanged();
            vscode.window.showInformationMessage(l10n("Model list refreshed"));
        })
    );

    // Legacy single-key flow: writes into the multi-key store as a single-element list
    context.subscriptions.push(
        vscode.commands.registerCommand("amdtokenfactory.setApiKey", async () => {
            const store = await getApiKeyStore(context.secrets);
            const existing = store.keys.length > 0 ? store.keys[0]?.value : undefined;
            const apiKey = await vscode.window.showInputBox({
                title: l10n("AMD TokenFactory Provider API Key"),
                prompt: existing ? l10n("Update your AMD TokenFactory API key (rc-...)") : l10n("Enter your AMD TokenFactory API key (rc-...)"),
                ignoreFocusOut: true,
                password: true,
                value: existing ?? "",
            });
            if (apiKey === undefined) {
                return; // user canceled
            }
            if (!apiKey.trim()) {
                // Clear all keys
                await context.secrets.store("amdTokenFactory.apiKeys", JSON.stringify({ keys: [] }));
                vscode.window.showInformationMessage(l10n("API keys cleared."));
                return;
            }
            const replaced = store.keys.filter((k) => k.value !== apiKey.trim());
            await context.secrets.store(
                "amdTokenFactory.apiKeys",
                JSON.stringify({ keys: [...replaced, { value: apiKey.trim(), available: null }] })
            );
            vscode.window.showInformationMessage(l10n("API key saved."));
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

        const render = (): string => {
            const mode = getApiKeyMode();
            const modeLabel = mode === "rotation"
                ? l10n("Rotation mode: next key per request")
                : l10n("Sticky mode: keep current key until it fails");
            return modeLabel;
        };

        const pickKey = async (title: string): Promise<ApiKeyEntry | undefined> => {
            const store = await getApiKeyStore(secrets);
            if (store.keys.length === 0) {
                vscode.window.showInformationMessage(l10n("No API keys configured."));
                return undefined;
            }
            const cursor = getRotationCursorIndex();
            const items = store.keys.map((entry, index) => {
                const detailParts: string[] = [];
                if (entry.label) {
                    detailParts.push(entry.label);
                }
                if (entry.available === true) {
                    detailParts.push("$(check) " + l10n("available"));
                } else if (entry.available === false) {
                    detailParts.push("$(error) " + l10n("unavailable"));
                }
                const transient = getTransientExhaustedInfo(entry.value);
                if (transient) {
                    detailParts.push(`$(clock) ${l10n("cooling down")} ${formatRemainingSec(transient.remainingSec)}`);
                }
                if (index === cursor) {
                    detailParts.push(`$(arrow-right) ${l10n("Rotation cursor")}`);
                }
                return {
                    label: `${maskApiKey(entry.value)}${index === cursor ? " $(arrow-right)" : ""}`,
                    description: detailParts.join(" · "),
                    entry,
                    index,
                };
            });
            const picked = await vscode.window.showQuickPick(items, { title, placeHolder: title });
            return picked?.entry;
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
                        await updateKeyAvailability(secrets, entry.value, false);
                        vscode.window.showErrorMessage(l10nFormat("Key is NOT available: {0}", result.reason ?? ""));
                    } else {
                        vscode.window.showWarningMessage(l10n("Key availability unknown"));
                    }
                }
            );
        };

        const mainMenu = async (): Promise<void> => {
            const store = await getApiKeyStore(secrets);
            const items: (vscode.QuickPickItem & { action?: string })[] = [
                { label: `$(add) ${l10n("Add API Key (rc-...)")}`, action: "add" },
                { label: `$(clippy) ${l10n("Batch Import Keys")}`, action: "import" },
                { label: `$(trash) ${l10n("Delete API Key")}`, action: "delete" },
                { label: `$(debug-restart) ${l10n("Reset Unavailable Keys")}`, action: "reset" },
                { label: `$(test-view-icon) ${l10n("Check All Keys")}`, action: "checkAll" },
                { label: `$(zap) ${l10n("Check This Key")}`, action: "checkOne" },
                { label: `$(info) ${l10nFormat("{0} key(s) configured", String(store.keys.length))}`, action: undefined, description: render() },
            ];
            const picked = await vscode.window.showQuickPick(items, { title: l10n("Manage API Keys") });
            if (!picked?.action) {
                return;
            }

            switch (picked.action) {
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
                    break;
                }
                case "delete": {
                    const keyPick = await pickKey(l10n("Delete API Key"));
                    if (!keyPick) {
                        break;
                    }
                    const confirm = await vscode.window.showWarningMessage(
                        l10nFormat("Delete key {0}?", maskApiKey(keyPick.value)),
                        { modal: true },
                        l10n("Delete")
                    );
                    if (confirm === l10n("Delete")) {
                        await removeApiKey(secrets, keyPick.value);
                        vscode.window.showInformationMessage(l10n("Key deleted."));
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
                    if (!keyPick) {
                        break;
                    }
                    await checkAvailabilityFlow(keyPick);
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
            }

            // Loop back into the menu
            await showApiKeyManager(_context);
        };

        await mainMenu();
    }
}

export function deactivate() {
    logger.dispose();
}
