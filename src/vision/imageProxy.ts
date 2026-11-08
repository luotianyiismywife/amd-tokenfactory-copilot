import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { logger } from "../core/logger";
import { createRetryConfig } from "../core/utils";
import { getModelInfo, toLanguageModelChatInformation, toProviderModelItem } from "../models";
import { executeApiRequest } from "../provider/apiDispatch";
import { DEFAULT_VISION_PROMPT } from "./types";
import type { StoredImage } from "./types";

/**
 * 视觉代理请求上下文 —— 复用对话请求链路（`executeApiRequest`）所需的参数。
 *
 * 视觉代理**不再**走 `vscode.lm.selectChatModels` + `sendRequest()`（嵌套重入），
 * 而是与对话一样直接调用 `executeApiRequest`：
 * - 端点由 `apiMode` 决定（与对话相同，`openai` / `anthropic` 由
 *   `amdTokenFactory.apiMode` 控制）
 * - `reasoning_effort` 由 `amdTokenFactory.visionProxyThinking` 决定，经
 *   `executeApiRequest` 的 `reasoningEffortOverride` 传入
 *
 * 这样视觉代理不再是"单独实现"，视频/音乐等代理只需构造自己的 `um` + `messages`，
 * 同样调用 `executeApiRequest` 即可复用整条请求链路。
 */
export interface VisionProxyContext {
    apiMode: string;
    modelApiKey: string;
    baseUrl: string;
    dispatchFetch: typeof fetch;
    requestHeaders: Record<string, string>;
    retryConfig: ReturnType<typeof createRetryConfig>;
    token: CancellationToken;
}

/**
 * 读取 `amdTokenFactory.visionProxyThinking` 设置，解析为 `reasoning_effort` 值。
 *
 * 设置项是枚举：`auto` / `none` / `low` / `medium` / `high` / `xhigh` / `max`。
 *
 * ⚠️ AMD 平台**没有** `auto` 档位（合法值 none/low/medium/high/xhigh/max/minimal）——
 * `auto` 是给下游平台预留的语义：有 auto 的平台直接透传，没有的按"不发送
 * reasoning_effort"处理（让模型用自己的默认思考行为）。该语义在
 * `apiDispatch.ts` 的 `reasoningEffortOverride` 处理。
 *
 * ⚠️ `none` 对 AMD 的 Qwen3.8 系列（模型固有思考）会抑制思考并直接输出空内容
 * （EOS，HTTP 200 无 error），2026-11-08 实测。默认值 `low` 是安全档位。
 *
 * ⚠️ 档位按模型过滤（2026-11-09 实测）：Qwen3.8 系列**不支持 high/max/minimal**
 * （400 "Unexpected reasoning effort high. Supported types are xhigh (default),
 * medium, and low."），支持 xhigh。若用户选了模型不支持的档位，回退到该模型的
 * 默认档位（Qwen3.8 → xhigh，其余 → high）。
 *
 * 档位来源链：**用户设置 → 内置清单（支持范围过滤 + 默认档位）→ 上游请求体**。
 * 平台 `/v1/models` 与 models.dev 都不返回具体档位列表（只给布尔标记），
 * 因此支持范围与默认档位从内置清单（`models.ts`）读，见 AGENTS.md §5.6。
 */
function resolveVisionReasoningEffort(visionModelId: string): string {
    const configured = vscode.workspace.getConfiguration().get<string>("amdTokenFactory.visionProxyThinking", "low");
    const value = (configured ?? "low").trim().toLowerCase();
    const info = getModelInfo(visionModelId);
    const supported = info?.supportedReasoningEfforts ?? [];
    // 用户选的档位在模型支持列表里 → 直接透传。
    if (supported.includes(value)) {
        return value;
    }
    // 模型不支持该档位 → 回退到模型默认档位（Qwen3.8 → xhigh，其余 → high）。
    if (info?.defaultReasoningEffort) {
        return info.defaultReasoningEffort;
    }
    return "low";
}

/**
 * 发送一条消息给视觉模型，流式转发到 progress，返回完整文本。
 *
 * 复用 `executeApiRequest`（与对话同一条请求链路）：端点由 `ctx.apiMode` 决定，
 * `reasoning_effort` 由 `amdTokenFactory.visionProxyThinking` 决定（经
 * `reasoningEffortOverride` 传入，不经过 `applyReasoningEffort`）。
 *
 * 空答案处理：模型固有思考的部署（Qwen3.8 系列）在思考被抑制时可能只产出 reasoning、
 * `content` 为空。此时优先回退到 reasoning 文本；两者都空则抛错，让上层记录
 * `vision.call-failed` 并把失败原因回传给主模型 —— 绝不能把空串当成"成功答案"，
 * 否则主模型只会说"工具没有返回内容"，用户完全无从排查。
 */
async function sendVisionRequest(
    msg: LanguageModelChatRequestMessage,
    visionModelId: string,
    ctx: VisionProxyContext,
    progress?: {
        onThinking?: (text: string) => void;
        onText?: (text: string) => void;
    }
): Promise<string> {
    const info = getModelInfo(visionModelId);
    if (!info) {
        throw new Error(`Vision model "${visionModelId}" not found. Check the amdTokenFactory.visionProxyModel setting.`);
    }

    // 视觉模型的请求配置（reasoning_effort 由 visionProxyThinking 决定）。
    const um = toProviderModelItem(info);
    const model = toLanguageModelChatInformation(info);

    // 视觉代理不需要工具；构造最小 options 满足类型。
    const options = {
        requestInitiator: "amdtokenfactory.visionProxy",
        toolMode: vscode.LanguageModelChatToolMode.Auto,
    } as unknown as ProvideLanguageModelChatResponseOptions;

    // 收集文本 + 转发 thinking/text 到主模型的 thinking 块。
    const collectedOutputText: string[] = [];
    const visionProgress: Progress<LanguageModelResponsePart> = {
        report: (part) => {
            if (part instanceof vscode.LanguageModelThinkingPart) {
                const text = Array.isArray(part.value) ? part.value.join("") : part.value;
                if (text) {
                    progress?.onThinking?.(text);
                }
            } else if (part instanceof vscode.LanguageModelTextPart) {
                collectedOutputText.push(part.value);
                progress?.onText?.(part.value);
            }
        },
    };

    // 视觉代理自己的超时控制器（主请求的 abortController 已用完）。
    const visionAbort = new AbortController();
    const timeoutMs = vscode.workspace.getConfiguration().get<number>("amdTokenFactory.requestTimeout", 600000);
    const timeoutId = setTimeout(() => visionAbort.abort(), timeoutMs);
    try {
        await executeApiRequest({
            apiMode: ctx.apiMode,
            model,
            um,
            modelConfig: { includeReasoningInRequest: true, vision: true },
            messages: [msg],
            options,
            trackingProgress: visionProgress,
            token: ctx.token,
            apiKey: ctx.modelApiKey,
            baseUrl: ctx.baseUrl,
            requestHeaders: ctx.requestHeaders,
            retryConfig: ctx.retryConfig,
            abortController: visionAbort,
            dispatchFetch: ctx.dispatchFetch,
            timeoutId,
            onUsage: () => {},
            collectedOutputText,
            // 思考等级由 visionProxyThinking 决定；非思考模型不传（不发该参数）。
            reasoningEffortOverride: info.reasoning ? resolveVisionReasoningEffort(visionModelId) : undefined,
        });
    } finally {
        clearTimeout(timeoutId);
    }

    const answer = collectedOutputText.join("").trim();
    if (answer) {
        return answer;
    }

    logger.error("vision.empty-answer", { visionModelId });
    throw new Error(
        `Vision model "${visionModelId}" returned an empty answer (no content, no reasoning). ` +
        `It may not accept image input, or its thinking was suppressed by the request options.`
    );
}

/**
 * Call a vision-capable model to answer a question about a single image.
 * Streams the output via progress if provided.
 * @param query The specific question to ask about the image.
 * @returns The answer text from the vision model.
 */
export async function callVisionModel(
    imageData: Uint8Array,
    mimeType: string,
    visionModelId: string,
    query: string | undefined,
    ctx: VisionProxyContext,
    progress?: {
        onThinking?: (text: string) => void;
        onText?: (text: string) => void;
    }
): Promise<string> {
    const dataPart = new vscode.LanguageModelDataPart(imageData, mimeType);
    const prompt = query ?? DEFAULT_VISION_PROMPT;
    const textPart = new vscode.LanguageModelTextPart(prompt);
    const msg = new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [dataPart, textPart]
    );
    return sendVisionRequest(msg, visionModelId, ctx, progress);
}

/**
 * Call a vision-capable model to answer a question about MULTIPLE images.
 * Sends all images + query in a single message so the model can compare them.
 * Streams the output via progress if provided.
 * @param images Array of { data, mimeType } for each image.
 * @param query The comparison/analysis question.
 * @returns The answer text from the vision model.
 */
export async function callVisionModelMulti(
    images: StoredImage[],
    visionModelId: string,
    query: string | undefined,
    ctx: VisionProxyContext,
    progress?: {
        onThinking?: (text: string) => void;
        onText?: (text: string) => void;
    }
): Promise<string> {
    const prompt = query ?? "Compare and analyze these images. What do you see?";
    const parts: (vscode.LanguageModelDataPart | vscode.LanguageModelTextPart)[] = [];
    for (const img of images) {
        parts.push(new vscode.LanguageModelDataPart(img.data, img.mimeType));
    }
    parts.push(new vscode.LanguageModelTextPart(prompt));
    const msg = new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        parts
    );
    return sendVisionRequest(msg, visionModelId, ctx, progress);
}
