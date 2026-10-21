import * as vscode from "vscode";
import { getApiKeyMode } from "./config";
import type { ErrorRule } from "./config";
import { isApiKeyEligible } from "./health";
import { getRotationIndex, setRotationIndex } from "./state";
import { getApiKeyStore, saveApiKeyStore } from "./store";
import type { ApiKeyEntry, ApiKeyMode } from "./types";

/**
 * Key 选择逻辑：主 key 获取、轮询/粘性选择、single 模式 fallback 判定。
 */

/**
 * 获取主 key（模型列表 / 启动同步等"任意有效 key 即可"的场景）。
 * - single → active key（跳过瞬态冷却与持久化不可用）
 * - sticky → 当前钉住的 key（activeIndex；不可用时从该位置环形扫描第一个可用 key）
 * - rotation → 第一个可用的 key
 * 全部不可用时返回 undefined。注意：模型列表不校验余额（实测），无需关心 available 余额标记。
 */
export async function getPrimaryApiKey(secrets: vscode.SecretStorage): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    const mode = getApiKeyMode();
    if (mode === "single") {
        const entry = store.keys[store.activeIndex] ?? store.keys[0];
        return isApiKeyEligible(entry) ? entry : undefined;
    }

    if (mode === "sticky") {
        // sticky：优先使用当前钉住的 key（activeIndex），不可用时从该位置环形扫描
        // 第一个可用 key。本函数只读（供模型列表等场景），不修改钉住位置。
        const start = store.activeIndex;
        for (let i = 0; i < store.keys.length; i++) {
            const entry = store.keys[(start + i) % store.keys.length];
            if (isApiKeyEligible(entry)) {
                return entry;
            }
        }
        return undefined;
    }

    // rotation：从游标开始环形扫描
    const rotationIndex = getRotationIndex();
    for (let i = 0; i < store.keys.length; i++) {
        const entry = store.keys[(rotationIndex + i) % store.keys.length];
        if (isApiKeyEligible(entry)) {
            return entry;
        }
    }
    return undefined;
}

/**
 * 选择下一个要使用的 key。
 * - rotation：从游标开始环形扫描第一个可用 key，游标前移一位（每次请求都换 key）
 * - sticky：从当前钉住的 key（activeIndex）开始环形扫描第一个可用 key，命中后钉住
 *   （更新 activeIndex 并持久化）。仅当它失效——余额不足/401/429/503 等——变
 *   ineligible 后下次才会切到下一个并钉住；原 key 恢复后不自动切回，保持前缀缓存亲和性。
 *   用户可在「管理 API Keys」界面手动「设为当前使用」指定钉住的 key。
 * - single：返回 active key（不可用返回 undefined，由调用方按 fallback 决定报错或降级为 rotation）
 */
export async function pickNextApiKey(
    secrets: vscode.SecretStorage,
    mode: ApiKeyMode
): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length === 0) {
        return undefined;
    }

    if (mode === "single") {
        const entry = store.keys[store.activeIndex] ?? store.keys[0];
        return isApiKeyEligible(entry) ? entry : undefined;
    }

    if (mode === "sticky") {
        // sticky：从当前钉住的 key（activeIndex）开始环形扫描第一个可用 key，
        // 命中后钉住（更新 activeIndex 并持久化）。原 key 恢复后不自动切回，
        // 保持前缀缓存亲和性。
        const start = store.activeIndex;
        for (let i = 0; i < store.keys.length; i++) {
            const idx = (start + i) % store.keys.length;
            if (isApiKeyEligible(store.keys[idx])) {
                if (idx !== store.activeIndex) {
                    store.activeIndex = idx;
                    await saveApiKeyStore(secrets, store);
                }
                return store.keys[idx];
            }
        }
        return undefined;
    }

    // rotation：从 rotationIndex 开始顺序查找第一个 eligible 的 key，游标前移
    const rotationIndex = getRotationIndex();
    for (let i = 0; i < store.keys.length; i++) {
        const idx = (rotationIndex + i) % store.keys.length;
        const entry = store.keys[idx];
        if (isApiKeyEligible(entry)) {
            setRotationIndex((idx + 1) % store.keys.length);
            return entry;
        }
    }
    return undefined;
}

/**
 * single 模式（fallback=switch）下是否应因当前 key 不可用而自动切换。
 * 仅当**本轮请求**中当前 active key 命中 `rotatePersist` 规则（确定性失败：
 * 余额不足 / 无效 key / 封号）时返回 true：
 * - `rotatePersist`：确定性失败，换一个可用 key 即可继续 → 切换
 * - `rotateCooldown`（429/503）：瞬态错误，换 key 规避不了平台限流/繁忙，
 *   由瞬态整轮重试兜底 → 不切换
 *
 * 本轮 `failedKeys` 无记录（请求开始时 active key 已因**历史**请求处于不可用/冷却状态）
 * 时不切换：上次切换成功时 activeIndex 已随 `setActiveKeyByValue` 移到新 key，
 * 不会再走到这里；剩余场景（error 模式遗留、上次切换失败）直接报错更符合 single 模式
 * “严格使用当前 key”的语义。
 */
export async function shouldSingleKeyFallbackSwitch(
    secrets: vscode.SecretStorage,
    currentRequestFailures: ReadonlyMap<string, ErrorRule>
): Promise<boolean> {
    const store = await getApiKeyStore(secrets);
    const active = store.keys[store.activeIndex] ?? store.keys[0];
    if (!active) {
        return false;
    }
    // 本轮 active key 命中 `rotatePersist`（确定性失败：余额不足 / 无效 key / 封号）
    // 时切换；`rotateCooldown`（瞬态）由整轮重试兜底，不切换。
    return currentRequestFailures.get(active.value)?.action === "rotatePersist";
}

/**
 * 按 key 值把指定 key 设为 single 模式的当前 key（activeIndex 跟随移动）。
 * 供 single 模式 402 余额不足自动切换后调用——后续请求直接使用新 key，
 * 避免每次请求都重复“fallback 选择 + 弹窗通知”。
 */
export async function setActiveKeyByValue(secrets: vscode.SecretStorage, keyValue: string): Promise<void> {
    const store = await getApiKeyStore(secrets);
    const idx = store.keys.findIndex((k) => k.value === keyValue);
    if (idx < 0 || idx === store.activeIndex) {
        return;
    }
    store.activeIndex = idx;
    await saveApiKeyStore(secrets, store);
}
