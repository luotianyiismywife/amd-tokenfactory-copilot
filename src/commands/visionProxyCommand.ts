/**
 * visionProxyCommand.ts — `amdtokenfactory.selectVisionProxyModel` 命令。
 *
 * 让用户从**当前可用的视觉模型**中选择 `amdTokenFactory.visionProxyModel`
 * （ask_image 图片代理使用的视觉模型），而不是手写模型 ID。
 *
 * 候选来源与运行时自动兜底**完全同源**：`getVisionModelInfos()`
 * （`/v1/models` 的 `architecture.input_modalities` / `providers[].vision`
 * → models.dev → 内置清单）。命令与设置项改的是同一个配置键，只是两个入口：
 *   - 命令：QuickPick 选择，写入设置（推荐）
 *   - 设置：直接编辑 `amdTokenFactory.visionProxyModel`（留空 = 自动挑选）
 */
import * as vscode from "vscode";
import { l10n, l10nFormat } from "../core/localize";
import { logger } from "../core/logger";
import { getPrimaryApiKey } from "../keys/keyManager";
import { getVisionModelInfos, refreshModelRegistry, type ModelInfo } from "../models";

/** 设置键（不含 section）。 */
const SETTING_KEY = "visionProxyModel";
/** 思考档位设置键（不含 section）。 */
const THINKING_SETTING_KEY = "visionProxyThinking";
/** 设置 section。 */
const SETTING_SECTION = "amdTokenFactory";

/** QuickPick 条目：附带模型 ID 供选择后写回设置。 */
interface VisionModelPickItem extends vscode.QuickPickItem {
    modelId: string;
}

/**
 * 读取视觉模型候选。
 *
 * 每次都刷新注册表：命令是用户主动发起的，应该看到平台**当前**的模型列表，
 * 而不是扩展激活时的快照。刷新失败时 `refreshModelRegistry` 内部降级为内置
 * 清单，不会抛错。
 *
 * @param secrets - 扩展 SecretStorage（`/v1/models` 需要主 API Key）。
 */
async function collectVisionModels(secrets: vscode.SecretStorage): Promise<ModelInfo[]> {
    const primaryKey = await getPrimaryApiKey(secrets);
    await refreshModelRegistry(primaryKey?.value, true);
    return getVisionModelInfos();
}

/**
 * 解析应当写入的设置作用域。
 *
 * 设置可能已在工作区/工作区文件夹级别定义，此时写用户级（Global）会被覆盖，
 * 表现为"选了但没生效"。优先更新已定义的最具体作用域，否则写用户级。
 */
function resolveUpdateTarget(config: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget {
    const inspected = config.inspect<string>(SETTING_KEY);
    if (inspected?.workspaceFolderValue !== undefined) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspected?.workspaceValue !== undefined) {
        return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
}

/**
 * `amdtokenfactory.selectVisionProxyModel` 命令实现。
 *
 * 从 `/v1/models` 实时加载模型列表并经 models.dev 判定视觉能力，弹出 QuickPick
 * 让用户选择视觉代理模型，选择后写入 `amdTokenFactory.visionProxyModel`。
 *
 * @param secrets - 扩展 SecretStorage（读取主 API Key）。
 */
export async function selectVisionProxyModel(secrets: vscode.SecretStorage): Promise<void> {
    const config = vscode.workspace.getConfiguration(SETTING_SECTION);
    const current = (config.get<string>(SETTING_KEY, "") ?? "").trim();

    const candidates = await collectVisionModels(secrets);
    if (candidates.length === 0) {
        logger.warn("vision.proxyModelPicker.empty", { current });
        vscode.window.showWarningMessage(
            l10n("No vision-capable models found. Make sure an API key is configured and the model list is reachable.")
        );
        return;
    }

    const items: VisionModelPickItem[] = candidates.map((candidate) => ({
        label: candidate.displayName,
        description: candidate.id === current
            ? `${candidate.id} — ${l10n("Current")}`
            : candidate.id,
        detail: candidate.description,
        modelId: candidate.id,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: l10n("Select Vision Proxy Model"),
        placeHolder: current
            ? l10nFormat("Vision model used by ask_image when the selected model does not support images (current: {0})", current)
            : l10n("Vision model used by ask_image when the selected model does not support images (empty = auto)"),
        ignoreFocusOut: true,
    });
    if (!picked) {
        return; // canceled
    }

    const target = resolveUpdateTarget(config);
    await config.update(SETTING_KEY, picked.modelId, target);
    logger.info("vision.proxyModelPicker.selected", { from: current, to: picked.modelId, target });

    // 选完视觉模型后，动态加载该模型的思考档位让用户选（数据源：内置清单
    // supportedReasoningEfforts，见 AGENTS.md §4.6）。平台 /v1/models 与 models.dev
    // 都不返回档位列表，因此这里按模型从内置清单读。
    const pickedInfo = candidates.find((c) => c.id === picked.modelId);
    const supported = pickedInfo?.supportedReasoningEfforts ?? [];
    // ⚠️ 兼容旧版布尔值残留（2.0.2 及之前 visionProxyThinking 是 boolean）。
    const rawEffort = config.get<unknown>(THINKING_SETTING_KEY, "");
    const currentEffort = typeof rawEffort === "string" ? rawEffort.trim() : "";
    const effortItems: vscode.QuickPickItem[] = [
        {
            label: l10n("Auto (model default)"),
            description: currentEffort === "" || currentEffort === "auto" ? l10n("Current") : undefined,
            picked: currentEffort === "" || currentEffort === "auto",
        },
        ...supported.map((effort) => ({
            label: effort,
            description: currentEffort === effort ? l10n("Current") : undefined,
            picked: currentEffort === effort,
        })),
    ];
    const effortPick = await vscode.window.showQuickPick(effortItems, {
        title: l10nFormat("Vision proxy thinking for {0}", picked.modelId),
        placeHolder: l10n("Pick the reasoning effort for this vision model (empty = model default)"),
        ignoreFocusOut: true,
    });
    if (effortPick) {
        const effortValue = effortPick.label === l10n("Auto (model default)") ? "" : effortPick.label;
        await config.update(THINKING_SETTING_KEY, effortValue, target);
        logger.info("vision.proxyThinkingPicker.selected", { modelId: picked.modelId, effort: effortValue, target });
    }

    vscode.window.showInformationMessage(l10nFormat("Vision proxy model set to {0}", picked.modelId));
}
