import * as vscode from "vscode";
import { LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { tokenizerManager } from "./tokenizerManager";
import { getImageDimensions } from "./imageUtils";
import { createDataUrl } from "../core/utils";

export const BaseTokensPerMessage = 3;
export const BaseTokensPerName = 1;

export async function countMessageTokens(
    text: string | LanguageModelChatRequestMessage,
    modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
    if (typeof text === "string") {
        return textTokenLength(text);
    } else {
        let totalTokens = BaseTokensPerMessage + BaseTokensPerName;

        for (const part of text.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                totalTokens += await textTokenLength(part.value);
            } else if (part instanceof vscode.LanguageModelDataPart) {
                if (part.mimeType.startsWith("image/")) {
                    totalTokens += calculateImageTokenCost(createDataUrl(part));
                } else if (part.mimeType === "cache_control") {
                    /* ignore */
                } else {
                    totalTokens += calculateNonImageBinaryTokens(part.data.byteLength);
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                totalTokens += BaseTokensPerName;
                totalTokens += await textTokenLength(JSON.stringify(part.input));
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                totalTokens += await textTokenLength(JSON.stringify(part.content));
            } else if (part instanceof vscode.LanguageModelThinkingPart) {
                if (modelConfig.includeReasoningInRequest) {
                    const thinkingText = Array.isArray(part.value) ? part.value.join("") : part.value;
                    totalTokens += await textTokenLength(thinkingText);
                }
            } else {
                console.warn(`Unknown part type: ${JSON.stringify(part)}`);
            }
        }
        return totalTokens;
    }
}

export async function textTokenLength(text: string): Promise<number> {
    try {
        return tokenizerManager.countTokens(text);
    } catch {
        return 0;
    }
}

export async function countToolTokens(tools: readonly LanguageModelChatTool[]): Promise<number> {
    const baseToolTokens = 16;
    let numTokens = 0;
    if (tools.length) {
        numTokens += baseToolTokens;
    }

    const baseTokensPerTool = 8;
    for (const tool of tools) {
        numTokens += baseTokensPerTool;
        numTokens += await textTokenLength(JSON.stringify(tool));
    }

    return numTokens;
}

/**
 * 估算一次请求的输入 token 总量（消息 + 工具定义）。
 *
 * 供 provider 在 API 未返回 usage 时做 fallback 的原生 token 指示器上报。
 * 原先位于 `ui/statusBar.ts`（该模块已随套餐用量/余额功能一并移除）。
 */
export async function estimateInputTokens(
    messages: readonly LanguageModelChatRequestMessage[],
    tools: readonly LanguageModelChatTool[] | undefined,
    modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
    try {
        let totalTokens = 0;
        for (const message of messages) {
            totalTokens += await countMessageTokens(message, modelConfig);
        }
        if (tools && tools.length > 0) {
            totalTokens += await countToolTokens(tools);
        }
        return totalTokens;
    } catch {
        return 0;
    }
}

/**
 * Calculate token cost for an image based on its dimensions.
 */
export function calculateImageTokenCost(dataUrl: string): number {
    try {
        const { width, height } = getImageDimensions(dataUrl);

        // Default: 170 tokens per 512px tile
        const tileSize = 512;
        const tilesX = Math.ceil(width / tileSize);
        const tilesY = Math.ceil(height / tileSize);
        const totalTiles = tilesX * tilesY;

        // Base cost: 85 tokens, plus 170 per tile
        return 85 + 170 * totalTiles;
    } catch {
        // Fallback: estimate based on base64 length
        const base64Length = dataUrl.length;
        return Math.ceil(base64Length / 100);
    }
}

/**
 * Calculate token cost for non-image binary data.
 */
export function calculateNonImageBinaryTokens(byteLength: number): number {
    // Rough estimate: ~0.75 tokens per byte for binary data
    return Math.ceil(byteLength * 0.75);
}
