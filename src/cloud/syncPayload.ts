/**
 * 云同步负载（Gist 文件内容）的纯函数模块。
 *
 * 单独成文件的原因：`syncPayloadHasChanged` 不依赖 `vscode` 运行时，
 * 可在 Node 离线测试中直接导入（见 `test/test-cloud-sync-auto-push.mjs`），
 * 同时被 `cloudSync.ts` 的自动推送去重逻辑复用。
 */

/** Gist 中存储的单个 key 条目（仅同步 value/label，可用性状态为本地数据不同步）。 */
export interface SyncedKeyEntry {
    value: string;
    label?: string;
}

/** Gist 文件负载结构。 */
export interface SyncPayload {
    version: 1;
    updatedAt: string;
    keys: SyncedKeyEntry[];
}

/**
 * 比较本地与云端 Gist 负载是否不同（决定是否需要推送）。
 *
 * 比较 `version`、条目数量以及每个条目的 `value` / `label`；
 * `updatedAt` 不参与比较（时间戳变化不代表内容变化）。`undefined` 与 `""`
 * 视为等价（与 `normalizeEntries` 的口径一致）。
 *
 * @returns true 表示内容有差异、需要推送；false 表示内容一致、可短路。
 */
export function syncPayloadHasChanged(local: SyncPayload | undefined, remote: SyncPayload | undefined): boolean {
    if (!remote) {
        return true;
    }
    if (!local) {
        return true;
    }
    if (local.version !== remote.version) {
        return true;
    }
    if (local.keys.length !== remote.keys.length) {
        return true;
    }
    return local.keys.some((entry, index) => {
        const other = remote.keys[index];
        return (
            !other ||
            entry.value !== other.value ||
            (entry.label ?? "") !== (other.label ?? "")
        );
    });
}
