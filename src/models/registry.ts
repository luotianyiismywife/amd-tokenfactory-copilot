/**
 * registry.ts — 模型信息归一化注册表（`src/models` 的单一事实来源）。
 *
 * 数据源（**互斥，不叠加**）：
 *   1. `apiModelList.ts` — `/v1/models` 实时列表（平台真值）
 *   2. `modelsDev.ts`    — models.dev 目录（仅补 `/v1/models` 缺的字段）
 *   3. `models.ts`       — 内置清单（**仅当 `/v1/models` 获取失败时**才生效）
 *
 * 字段级合并优先级（高 → 低）：
 *   `/v1/models`  >  models.dev  >  代码默认值
 *
 * 内置清单是**离线兜底**，不是叠加层：只要 `/v1/models` 成功返回，模型信息就
 * 完全来自平台 + models.dev，内置清单里的旧值（上下文、视觉、思考档位等）
 * 不会覆盖或补写任何字段 —— 否则平台下架/调整模型后，内置清单的陈旧数据会
 * 让插件继续按旧能力发请求。
 *
 * 插件其他模块（provider / visionRounds / commands / gitCommit）**只从这里取模型信息**，
 * 不再各自拼装、不再各自维护模型表。
 *
 * 本模块不依赖 `vscode` 的 UI 能力，只依赖数据源与日志，便于单测。
 */
import { logger } from "../core/logger";
import { getApiModelIds, getApiModelMetadataList, isApiFetchSuccessful, type ApiModelMetadata } from "./apiModelList";
import { ensureModelsDevLoaded, lookupModelDevEntry, type ModelsDevEntry } from "./modelsDev";
import {
    DEFAULT_CONTEXT_LENGTH,
    DEFAULT_MAX_TOKENS,
    getBuiltInModelDef,
    getBuiltInModelDefs,
    type BuiltInModelDef,
} from "./models";
import { resolveVisionCapability } from "./visionModels";

/**
 * 归一化后的模型信息 —— 插件内部唯一的模型描述结构。
 *
 * 所有数据源（内置清单 / `/v1/models` / models.dev）的差异都在本模块被抹平，
 * 消费方不需要知道某个字段来自哪个源，也不需要再做 `??` 兜底链。
 */
export interface ModelInfo {
    /** 裸模型 ID（不带 vendor 前缀），即请求体里的 `model` 值。 */
    id: string;
    /** 展示名（模型选择器）。 */
    displayName: string;
    /** 模型描述（选择器 tooltip / QuickPick detail）。 */
    description?: string;
    /** 是否接受图片输入。 */
    vision: boolean;
    /** 是否支持工具调用。 */
    toolCalling: boolean;
    /** 是否支持思考（`reasoning_effort`）。 */
    reasoning: boolean;
    /** 思考开关形态：可切换 / 恒开 / 仅自动。 */
    thinkingMode: "switchable" | "always" | "adaptive";
    /** 可选思考档位（不含 `disabled`）。 */
    supportedReasoningEfforts?: string[];
    /** 默认思考档位。 */
    defaultReasoningEffort?: string;
    /** 是否在 assistant 消息里回传思考内容。 */
    includeReasoningInRequest: boolean;
    /** 是否接受 temperature / top_p。 */
    supportsTemperature: boolean;
    /** 模型只接受的固定 top_p（如 0.95）。 */
    fixedTopP?: number;
    /** 上下文窗口（token）。 */
    contextLength: number;
    /** 输出上限（token）。 */
    maxOutputTokens: number;
    /**
     * `maxOutputTokens` 的来源。`"default"` 表示两个数据源都不知道真实上限 ——
     * 此时请求体**不应**发送上限，交给服务端默认值，避免推理模型把预算全烧在思考上。
     */
    maxOutputTokensSource: "api" | "builtin" | "modelsdev" | "default";
    /** 该模型使用的 API 协议。 */
    apiMode: "openai" | "anthropic";
    /** 平台是否支持该模型的 Anthropic Messages 协议。 */
    supportsAnthropic: boolean;
    /** 额外请求体参数。 */
    extra?: Record<string, unknown>;
    /** 信息来源：内置清单兜底 / `/v1/models` 实时列表。 */
    source: "builtin" | "api";
}

// ── Module-level registry ──
let _registry = new Map<string, ModelInfo>();
let _anthropicModelIds = new Set<string>();

/**
 * 去掉 vendor 前缀，得到裸模型 ID。
 * 设置项里可能写成 `amdtokenfactory/Qwen3.8-27B`，能力查询与比较统一用裸 ID。
 */
export function bareModelId(modelId: string): string {
    const trimmed = modelId.trim();
    const slashIdx = trimmed.lastIndexOf("/");
    return slashIdx === -1 ? trimmed : trimmed.slice(slashIdx + 1);
}

/** 由内置清单条目构造 `ModelInfo`（离线兜底路径）。 */
function fromBuiltIn(def: BuiltInModelDef): ModelInfo {
    return {
        id: def.baseId,
        displayName: def.displayName,
        vision: def.vision,
        toolCalling: true,
        reasoning: true,
        thinkingMode: def.thinkingMode,
        supportedReasoningEfforts: def.supportedReasoningEfforts,
        defaultReasoningEffort: def.defaultReasoningEffort,
        includeReasoningInRequest: def.includeReasoningInRequest ?? true,
        supportsTemperature: def.supportsTemperature ?? true,
        fixedTopP: def.fixedTopP,
        contextLength: def.contextLength ?? DEFAULT_CONTEXT_LENGTH,
        maxOutputTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
        maxOutputTokensSource: def.maxTokens !== undefined ? "builtin" : "default",
        apiMode: def.apiMode ?? "openai",
        supportsAnthropic: true,
        extra: def.extra,
        source: "builtin",
    };
}

/**
 * 合并单个模型的两方信息（`/v1/models` + models.dev）。
 *
 * 内置清单**不参与**：它只在 `/v1/models` 获取失败时作为整份列表的兜底
 * （见 `builtInInfos()`），不用于补写 API 已返回模型的字段。
 */
function mergeModel(
    modelId: string,
    apiMeta: ApiModelMetadata | undefined,
    devEntry: ModelsDevEntry | undefined
): ModelInfo {
    const apiMaxOutput = apiMeta?.max_completion_tokens;
    const devMaxOutput = devEntry?.limit?.output;
    const maxOutputTokens = apiMaxOutput ?? devMaxOutput ?? DEFAULT_MAX_TOKENS;
    const maxOutputTokensSource: ModelInfo["maxOutputTokensSource"] =
        apiMaxOutput !== undefined ? "api" : devMaxOutput !== undefined ? "modelsdev" : "default";

    // 思考能力：平台标记优先，models.dev 兜底。
    const reasoning = apiMeta?.supports_reasoning ?? devEntry?.reasoning ?? false;

    // 思考档位按模型区分（2026-11-09 实测）：
    //   Qwen3.8 系列（Qwen3.8-27B / Qwen3.8-Flash-Next）：支持 none/low/medium/xhigh，
    //     **不支持 high/max/minimal**（400 "Unexpected reasoning effort high. Supported
    //     types are xhigh (default), medium, and low."）→ 默认档位 xhigh。
    //   其余模型（DeepSeek-V4 / GLM-5.3 等）：支持 none/low/medium/high/xhigh/max/minimal
    //     → 默认档位 high。
    //
    // ⚠️ 平台 `/v1/models` **没有**返回具体档位列表（`supported_parameters` 只含
    // `reasoning_effort` 布尔标记，见 apiModelList.ts）。因此这里按模型 ID 兜底。
    // 若平台将来返回 `supported_reasoning_efforts` 字段，应优先读它（改这里 + chatInfo
    // 的枚举构建），模型 ID 判断降级为兜底。
    const qwen38 = modelId.startsWith("Qwen3.8");
    const supportedReasoningEfforts = reasoning ? (qwen38 ? ["low", "medium", "xhigh"] : ["low", "medium", "high"]) : undefined;
    const defaultReasoningEffort = reasoning ? (qwen38 ? "xhigh" : "high") : undefined;

    return {
        id: modelId,
        displayName: apiMeta?.display_name ?? devEntry?.name ?? modelId,
        description: apiMeta?.desc,
        vision: resolveVisionCapability(apiMeta, devEntry),
        toolCalling: apiMeta?.supports_tools ?? devEntry?.tool_call ?? true,
        reasoning,
        thinkingMode: reasoning ? "switchable" : "always",
        supportedReasoningEfforts,
        defaultReasoningEffort,
        includeReasoningInRequest: reasoning,
        supportsTemperature: devEntry?.temperature ?? true,
        contextLength: apiMeta?.context_length ?? devEntry?.limit?.context ?? DEFAULT_CONTEXT_LENGTH,
        maxOutputTokens,
        maxOutputTokensSource,
        apiMode: "openai",
        supportsAnthropic: apiMeta?.supports_anthropic ?? true,
        source: "api",
    };
}

/** 用内置清单构造完整列表。 */
function builtInInfos(): ModelInfo[] {
    return getBuiltInModelDefs().map(fromBuiltIn);
}

/** 原子替换注册表内容。 */
function commit(infos: ModelInfo[]): void {
    _registry = new Map(infos.map((info) => [info.id, info]));
    _anthropicModelIds = new Set(infos.filter((info) => info.supportsAnthropic).map((info) => info.id));
}

/**
 * 刷新注册表：拉取 `/v1/models` + models.dev。
 *
 * 失败/未配置 key/关闭自动发现时静默降级为内置清单（不抛错），
 * 保证模型选择器与请求链路始终有可用数据。
 *
 * @param apiKey - 主 API Key（`/v1/models` 需要鉴权）。
 * @param autoDiscoveryEnabled - 是否启用自动模型发现。
 * @returns 本次生效的完整模型列表。
 */
export async function refreshModelRegistry(
    apiKey: string | undefined,
    autoDiscoveryEnabled: boolean
): Promise<ModelInfo[]> {
    if (!autoDiscoveryEnabled || !apiKey) {
        const infos = builtInInfos();
        commit(infos);
        logger.info("models.registry", {
            source: "builtin",
            reason: autoDiscoveryEnabled ? "no_api_key" : "disabled_by_setting",
            count: infos.length,
        });
        return infos;
    }

    const apiModelIds = await getApiModelIds(apiKey);
    if (apiModelIds.size === 0 || !isApiFetchSuccessful()) {
        const infos = builtInInfos();
        commit(infos);
        logger.info("models.registry", {
            source: "builtin",
            reason: "api_empty_or_failed",
            count: infos.length,
        });
        return infos;
    }

    // models.dev 仅作 API 缺字段时的补充，加载失败不影响主流程。
    await ensureModelsDevLoaded();

    const apiMetaList = await getApiModelMetadataList(apiKey);
    const apiMetaMap = new Map<string, ApiModelMetadata>(apiMetaList.map((meta) => [meta.id, meta]));

    const infos = [...apiModelIds].map((modelId) =>
        mergeModel(modelId, apiMetaMap.get(modelId), lookupModelDevEntry(modelId))
    );
    commit(infos);

    logger.info("models.registry", {
        source: "api",
        count: infos.length,
        vision: infos.filter((info) => info.vision).length,
        anthropic: _anthropicModelIds.size,
    });
    return infos;
}

/**
 * 确保注册表已填充（供非模型列表路径使用，如提交消息生成）。
 * 已填充时直接返回，不重复请求。
 */
export async function ensureModelRegistry(apiKey: string | undefined): Promise<ModelInfo[]> {
    if (_registry.size > 0) {
        return getModelInfos();
    }
    return refreshModelRegistry(apiKey, true);
}

/**
 * 当前生效的全部模型（同步）。
 * 注册表尚未刷新时返回内置清单，保证任何调用点都有数据。
 */
export function getModelInfos(): ModelInfo[] {
    return _registry.size > 0 ? [..._registry.values()] : builtInInfos();
}

/**
 * 按模型 ID 查询归一化信息（同步）。
 * 接受裸 ID 或 `vendor/model-id`。
 *
 * 注册表尚未刷新时回退内置清单（离线兜底）；注册表已由 `/v1/models` 填充时
 * 只认平台返回的模型 —— 平台下架的模型不应继续被当作可用。
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
    const bare = bareModelId(modelId);
    const cached = _registry.get(bare);
    if (cached) {
        return cached;
    }
    if (_registry.size > 0) {
        return undefined;
    }
    const def = getBuiltInModelDef(bare);
    return def ? fromBuiltIn(def) : undefined;
}

/** 支持视觉输入的模型（同步）。 */
export function getVisionModelInfos(): ModelInfo[] {
    return getModelInfos().filter((info) => info.vision);
}

/**
 * 模型是否支持视觉输入（同步）。
 * 未知模型返回 `undefined` —— 调用方不应据此阻断请求。
 */
export function isVisionCapableModelId(modelId: string): boolean | undefined {
    return getModelInfo(modelId)?.vision;
}

/**
 * 支持 Anthropic Messages 协议的模型 ID 集合（同步）。
 * 注册表尚未刷新时为空集 —— 调用方按 OpenAI 兼容协议兜底。
 */
export function getAnthropicModelIds(): Set<string> {
    return _anthropicModelIds;
}
