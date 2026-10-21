import * as vscode from "vscode";
import { logger } from "../core/logger";
import { l10n, l10nFormat } from "../core/localize";
import { getApiKeyStore, saveApiKeyStore, invalidateApiKeyStoreCache, type ApiKeyEntry } from "../keys/keyManager";
import { onApiKeyStoreChanged } from "../keys/state";
import { syncPayloadHasChanged, type SyncPayload, type SyncedKeyEntry } from "./syncPayload";

/**
 * 云同步（GitHub Gist）：
 * 使用 VS Code 内置的 GitHub 登录（vscode.authentication.getSession）获取 token，
 * 将 key/credential/备注 三元组存储到一个私密 Gist 中，实现跨机器同步。
 *
 * - 推送（amdtokenfactory.syncPush）：本地 store → Gist（手动触发）
 * - 拉取（amdtokenfactory.syncPull）：Gist → 本地 store（手动触发）
 * - 启动自动拉取（amdTokenFactory.cloudSyncAutoPull，默认开启）：静默检查云端
 *   updatedAt 是否比本地上次同步时间新，是则拉取覆盖本地并弹窗提示。
 * - 自动推送（amdTokenFactory.cloudSyncAutoPush，默认关闭）：key 管理操作后
 *   去抖静默推送本地变更到 Gist（本地与云端一致时短路，不写 Gist）。
 *
 * Gist 定位：优先使用 globalState 缓存的 gist id；缺失时按 description
 * 标记（GIST_DESCRIPTION）遍历用户 Gist 列表查找；均无则创建新 Gist。
 * Gist 为 secret（public: false），文件名固定 GIST_FILE_NAME。
 */

const GIST_DESCRIPTION = "copilot-provider key sync (do not edit manually)";
const GIST_FILE_NAME = "copilot-provider-keys.json";
const GIST_API_BASE = "https://api.github.com/gists";

const GLOBAL_STATE_GIST_ID = "amdTokenFactory.cloudSyncGistId";
const GLOBAL_STATE_LAST_SYNC_AT = "amdTokenFactory.lastCloudSyncAt";
const GLOBAL_STATE_LOCK_UNTIL = "amdTokenFactory.cloudSyncLockUntil";

// push/pull 互斥：两者都是"读 store → 网络等待 → 写 store"，并发重叠时
// pull 会用旧 store 快照覆盖 push 的结果（last-writer-wins），push 期间
// 新增的本地 key 可能被 pull 的合并删掉。模块级互斥标志防止重叠。
let syncInFlight = false;
// 自动推送：pull 触发的本地写入需抑制自动推送（否则形成 pull→push 回环）。
let suppressAutoPush = false;
let pendingAutoPushTimer: NodeJS.Timeout | undefined;
const AUTO_PUSH_DEBOUNCE_MS = 2500;

/**
 * 获取 VS Code 内置 GitHub 登录会话。
 * @param createIfNone true 时未登录会弹出 GitHub 登录界面；false 时静默返回 undefined。
 */
async function getGitHubSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
    // 会话可能被用户登出而失效，每次都向 VS Code 请求（VS Code 自身有缓存）
    try {
        return await vscode.authentication.getSession("github", ["gist"], { createIfNone });
    } catch (err) {
        logger.warn("cloudSync.auth", { error: String(err) });
        return undefined;
    }
}

/** 带 GitHub 认证的 fetch，非 2xx 抛出含状态码的错误。 */
async function gistFetch(session: vscode.AuthenticationSession, url: string, init?: RequestInit): Promise<Response> {
    const resp = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "copilot-provider",
            ...(init?.headers ?? {}),
        },
    });
    if (!resp.ok) {
        throw new Error(`GitHub Gist API ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    }
    return resp;
}

interface GistSummary {
    id: string;
    description: string | null;
    public: boolean;
    files: Record<string, { filename?: string } | null>;
}

/** 按描述标记在用户 Gist 列表中查找同步 Gist（前 3 页）。 */
async function findSyncGist(session: vscode.AuthenticationSession): Promise<GistSummary | undefined> {
    for (let page = 1; page <= 3; page++) {
        const resp = await gistFetch(session, `${GIST_API_BASE}?per_page=100&page=${page}`);
        const gists = (await resp.json()) as GistSummary[];
        if (!Array.isArray(gists) || gists.length === 0) {
            break;
        }
        const found = gists.find(
            (g) => g.description === GIST_DESCRIPTION && Object.keys(g.files ?? {}).includes(GIST_FILE_NAME),
        );
        if (found) {
            return found;
        }
        if (gists.length < 100) {
            break;
        }
    }
    return undefined;
}

/** 读取 Gist 文件内容并解析为负载；损坏时返回 undefined。 */
async function fetchSyncPayload(
    session: vscode.AuthenticationSession,
    gistId: string,
): Promise<SyncPayload | undefined> {
    const resp = await gistFetch(session, `${GIST_API_BASE}/${gistId}`);
    const gist = (await resp.json()) as {
        updated_at?: string;
        files?: Record<string, { content?: string } | null>;
    };
    const content = gist.files?.[GIST_FILE_NAME]?.content;
    if (!content) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(content) as SyncPayload;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.keys)) {
            // 优先使用 GitHub 服务端时间戳（消除客户端时钟偏差导致的漏拉）
            if (gist.updated_at) {
                parsed.updatedAt = gist.updated_at;
            }
            return parsed;
        }
    } catch (err) {
        logger.warn("cloudSync.parse", { error: String(err) });
    }
    return undefined;
}

/**
 * 从 Gist API 响应中读取服务端 `updated_at`。
 *
 * 用于记录 `lastCloudSyncAt`：pull 侧（`fetchSyncPayload`）用服务端时间覆盖
 * `updatedAt`，push 侧若记录客户端时间，两者会差几秒，导致 push 后下一次启动
 * 必然多拉一次（拉到无变化后自愈）。统一用服务端时间消除该偏差。
 */
async function readGistUpdatedAt(resp: Response): Promise<string | undefined> {
    try {
        const gist = (await resp.json()) as { updated_at?: string };
        return gist.updated_at;
    } catch {
        return undefined;
    }
}

/** 规范化同步条目：过滤空值，label 去空白。 */
function normalizeEntries(keys: SyncedKeyEntry[]): SyncedKeyEntry[] {
    return keys
        .map((k) => ({
            value: typeof k.value === "string" ? k.value.trim() : "",
            label: typeof k.label === "string" && k.label.trim() ? k.label.trim() : undefined,
        }))
        .filter((k) => k.value);
}

/** 将本地 store 序列化为同步负载。 */
function buildPayload(keys: ApiKeyEntry[]): SyncPayload {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        keys: normalizeEntries(keys.map((k) => ({ value: k.value, label: k.label }))),
    };
}

/**
 * 推送本地 key/credential/备注 到云端 Gist（amdtokenfactory.syncPush 命令）。
 * 未登录 GitHub 时（非 silent 模式）弹出登录界面。成功后记录 globalState 同步时间。
 *
 * @param silent true 时静默推送（自动推送用）：不弹登录界面、不弹提示、失败仅记日志。
 */
export async function pushToCloud(context: vscode.ExtensionContext, silent = false): Promise<void> {
    if (syncInFlight) {
        if (!silent) {
            vscode.window.showWarningMessage(l10n("Cloud sync is already in progress"));
        }
        return;
    }
    // 跨窗口锁：避免两个窗口同时写 Gist（另一个窗口刚推送过则跳过）
    const lockUntil = context.globalState.get<number>(GLOBAL_STATE_LOCK_UNTIL, 0) ?? 0;
    if (Date.now() < lockUntil) {
        logger.info("cloudSync.push.locked", { lockUntil, silent });
        return;
    }

    const session = await getGitHubSession(!silent);
    if (!session) {
        return; // 用户取消登录
    }
    syncInFlight = true;
    try {
        await pushToCloudInner(context, session, silent);
    } finally {
        syncInFlight = false;
    }
}

async function pushToCloudInner(
    context: vscode.ExtensionContext,
    session: vscode.AuthenticationSession,
    silent: boolean,
): Promise<void> {
    const store = await getApiKeyStore(context.secrets);
    if (store.keys.length === 0) {
        if (!silent) {
            vscode.window.showWarningMessage(l10n("No API keys configured"));
        }
        return;
    }

    const payload = buildPayload(store.keys);
    let gistId = context.globalState.get<string>(GLOBAL_STATE_GIST_ID);
    let remotePayload: SyncPayload | undefined;

    // 无变更短路：先读取云端负载，本地与云端一致则不写 Gist、不更新时间戳，
    // 避免自动推送在无实际变更时反复写 Gist。
    if (gistId) {
        try {
            remotePayload = await fetchSyncPayload(session, gistId);
        } catch {
            gistId = undefined;
            remotePayload = undefined;
        }
    }
    if (!gistId) {
        const found = await findSyncGist(session);
        if (found) {
            gistId = found.id;
            await context.globalState.update(GLOBAL_STATE_GIST_ID, gistId);
            remotePayload = await fetchSyncPayload(session, gistId).catch(() => undefined);
        }
    }
    if (!syncPayloadHasChanged(payload, remotePayload)) {
        logger.info("cloudSync.push.noChange", { count: payload.keys.length });
        return;
    }

    const fileBody = { filename: GIST_FILE_NAME, content: JSON.stringify(payload, null, 2) };
    const lockUntil = Date.now() + 30_000;
    await context.globalState.update(GLOBAL_STATE_LOCK_UNTIL, lockUntil);

    try {
        const serverUpdatedAt = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: silent ? "" : l10n("Pushing keys to cloud..."),
            },
            async (): Promise<string | undefined> => {
                let updatedAt: string | undefined;
                // 优先使用缓存的 gist id，失效（404）时回退查找/创建
                if (gistId) {
                    try {
                        const resp = await gistFetch(session, `${GIST_API_BASE}/${gistId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ files: { [GIST_FILE_NAME]: fileBody } }),
                        });
                        updatedAt = await readGistUpdatedAt(resp);
                    } catch {
                        gistId = undefined; // 缓存的 gist 已不存在，回退
                    }
                }
                if (!gistId) {
                    const found = await findSyncGist(session);
                    if (found) {
                        gistId = found.id;
                        const resp = await gistFetch(session, `${GIST_API_BASE}/${gistId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ files: { [GIST_FILE_NAME]: fileBody } }),
                        });
                        updatedAt = await readGistUpdatedAt(resp);
                    } else {
                        const resp = await gistFetch(session, GIST_API_BASE, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                description: GIST_DESCRIPTION,
                                public: false,
                                files: { [GIST_FILE_NAME]: fileBody },
                            }),
                        });
                        const created = (await resp.json()) as { id?: string; updated_at?: string };
                        gistId = created.id;
                        if (!gistId) {
                            // POST 响应解析不出 id：什么都没推送，抛错走 catch
                            // 分支（不更新时间戳、不报成功），避免"假成功"。
                            throw new Error("Gist creation response missing id");
                        }
                        updatedAt = created.updated_at;
                    }
                }
                if (gistId) {
                    await context.globalState.update(GLOBAL_STATE_GIST_ID, gistId);
                }
                return updatedAt;
            },
        );

        // 记录服务端时间戳（与 pull 侧口径一致）；响应缺失时回退到本地时间。
        await context.globalState.update(GLOBAL_STATE_LAST_SYNC_AT, serverUpdatedAt ?? payload.updatedAt);
        logger.info("cloudSync.push", { count: payload.keys.length, silent });
        if (!silent) {
            vscode.window.showInformationMessage(
                l10nFormat("Pushed {0} keys to cloud Gist", String(payload.keys.length)),
            );
        }
    } catch (err) {
        logger.error("cloudSync.push", { error: String(err), silent });
        if (!silent) {
            vscode.window.showErrorMessage(l10nFormat("Failed to push to cloud: {0}", String(err)));
        }
    } finally {
        await context.globalState.update(GLOBAL_STATE_LOCK_UNTIL, 0);
    }
}

/**
 * 从云端 Gist 拉取 key/credential/备注 覆盖本地（amdtokenfactory.syncPull 命令）。
 * 合并策略：云端为源——按 key 值对齐，云端条目覆盖本地 credential/label，
 * 云端有本地无的条目追加，本地有云端无的条目删除；可用性状态（available/
 * lastCheckedAt）为本地数据，按 key 值保留。
 */
export async function pullFromCloud(context: vscode.ExtensionContext, silent = false): Promise<boolean> {
    if (syncInFlight) {
        if (!silent) {
            vscode.window.showWarningMessage(l10n("Cloud sync is already in progress"));
        }
        return false;
    }
    const session = await getGitHubSession(false);
    if (!session) {
        if (!silent) {
            vscode.window.showWarningMessage(l10n("GitHub sign-in required for cloud sync"));
        }
        return false;
    }
    syncInFlight = true;
    try {
        return await pullFromCloudInner(context, session, silent);
    } finally {
        syncInFlight = false;
    }
}

async function pullFromCloudInner(
    context: vscode.ExtensionContext,
    session: vscode.AuthenticationSession,
    silent: boolean,
): Promise<boolean> {
    try {
        // 定位 Gist：缓存 id → 按描述查找 → 静默模式下无 Gist 视为无更新。
        // 缓存 id 失效（Gist 在其他机器被删除重建）时回退重新查找，避免
        // 自动拉取从此每次启动都静默失败。
        let gistId = context.globalState.get<string>(GLOBAL_STATE_GIST_ID);
        let payload: SyncPayload | undefined;
        if (gistId) {
            try {
                payload = await fetchSyncPayload(session, gistId);
            } catch (err) {
                // 缓存的 gist 已不存在（404 等）→ 清缓存回退查找
                logger.warn("cloudSync.pull.cachedGistFailed", { gistId, error: String(err) });
                gistId = undefined;
            }
        }
        if (!payload) {
            const found = await findSyncGist(session);
            if (!found) {
                if (!silent) {
                    vscode.window.showWarningMessage(l10n("No cloud sync Gist found. Use push first."));
                }
                return false;
            }
            gistId = found.id;
            await context.globalState.update(GLOBAL_STATE_GIST_ID, gistId);
            payload = await fetchSyncPayload(session, gistId);
        }
        if (!payload) {
            if (!silent) {
                vscode.window.showWarningMessage(l10n("Cloud sync data is empty or corrupted"));
            }
            return false;
        }

        // 启动自动拉取：云端 updatedAt 不比本地上次同步新则跳过
        const lastSyncAt = context.globalState.get<string>(GLOBAL_STATE_LAST_SYNC_AT);
        if (silent && lastSyncAt && payload.updatedAt <= lastSyncAt) {
            return false;
        }

        const store = await getApiKeyStore(context.secrets);
        // pull 触发的本地写入需抑制自动推送，否则形成 pull→push 回环。
        suppressAutoPush = true;
        try {
            const localByKey = new Map(store.keys.map((k) => [k.value, k]));
            const cloudEntries = normalizeEntries(payload.keys);
            const merged: ApiKeyEntry[] = cloudEntries.map((entry) => {
                const local = localByKey.get(entry.value);
                return {
                    value: entry.value,
                    label: entry.label,
                    // 可用性状态为本地数据：按 key 值保留本地检测结果
                    available: local?.available ?? null,
                    lastCheckedAt: local?.lastCheckedAt,
                };
            });
            const changed =
                merged.length !== store.keys.length ||
                merged.some((m, i) => {
                    const old = store.keys[i];
                    return (
                        !old ||
                        old.value !== m.value ||
                        (old.label ?? "") !== (m.label ?? "")
                    );
                });
            if (!changed) {
                await context.globalState.update(GLOBAL_STATE_LAST_SYNC_AT, payload.updatedAt);
                return false;
            }

            const activeValue = store.keys[store.activeIndex]?.value;
            const newStore = {
                keys: merged,
                activeIndex: Math.max(
                    0,
                    merged.findIndex((k) => k.value === activeValue),
                ),
            };
            await saveApiKeyStore(context.secrets, newStore);
            invalidateApiKeyStoreCache();
            await context.globalState.update(GLOBAL_STATE_LAST_SYNC_AT, payload.updatedAt);
            logger.info("cloudSync.pull", { count: merged.length });
            if (!silent) {
                vscode.window.showInformationMessage(
                    l10nFormat("Pulled {0} keys from cloud Gist", String(merged.length)),
                );
            }
            return true;
        } finally {
            suppressAutoPush = false;
        }
    } catch (err) {
        logger.error("cloudSync.pull", { error: String(err) });
        if (!silent) {
            vscode.window.showErrorMessage(l10nFormat("Failed to pull from cloud: {0}", String(err)));
        }
        return false;
    }
}

/**
 * 注册 API Key store 变更监听：key 管理操作写入 SecretStorage 后，去抖
 * （2.5s）静默推送本地变更到云端 Gist。
 *
 * - 跳过 `suppressAutoPush`（pull 触发的本地写入）以避免 pull→push 回环。
 * - 读取 `amdTokenFactory.cloudSyncAutoPush` 配置（默认关闭）；关闭时直接返回。
 * - 推送失败仅记日志，不弹窗（silent 模式）。
 */
export function registerCloudSyncAutoPush(context: vscode.ExtensionContext): void {
    const onChanged = () => {
        if (suppressAutoPush) {
            return;
        }

        if (pendingAutoPushTimer) {
            clearTimeout(pendingAutoPushTimer);
        }

        const enabled = vscode.workspace.getConfiguration().get<boolean>("amdTokenFactory.cloudSyncAutoPush", false);
        if (!enabled) {
            return;
        }

        pendingAutoPushTimer = setTimeout(() => {
            pendingAutoPushTimer = undefined;
            void pushToCloud(context, true);
        }, AUTO_PUSH_DEBOUNCE_MS);
    };

    const unsubscribe = onApiKeyStoreChanged(onChanged);
    context.subscriptions.push({ dispose: unsubscribe });
    context.subscriptions.push({
        dispose: () => {
            if (pendingAutoPushTimer) {
                clearTimeout(pendingAutoPushTimer);
                pendingAutoPushTimer = undefined;
            }
        },
    });
}

/** 清理未执行的自动推送定时器（扩展停用前调用）。 */
export function flushPendingAutoPush(): void {
    if (pendingAutoPushTimer) {
        clearTimeout(pendingAutoPushTimer);
        pendingAutoPushTimer = undefined;
    }
}

/**
 * 启动自动拉取（fire-and-forget，不阻塞激活）。
 * 读取 amdTokenFactory.cloudSyncAutoPull 配置（默认开启）；未登录 GitHub 时静默跳过，
 * 不弹登录界面；云端无更新时静默跳过。
 */
export function autoPullOnStartup(context: vscode.ExtensionContext): void {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("amdTokenFactory.cloudSyncAutoPull", true);
    if (!enabled) {
        return;
    }
    void pullFromCloud(context, true);
}
