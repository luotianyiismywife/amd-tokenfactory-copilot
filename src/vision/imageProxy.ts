import * as vscode from "vscode";
import { DEFAULT_VISION_PROMPT } from "./types";
import type { StoredImage } from "./types";

/**
 * Vendor id this extension registers its language models under.
 * ⚠️ 必须与 `package.json` 的 `contributes.languageModelChatProviders[0].vendor`
 * 及 `extension.ts` 的 `registerLanguageModelChatProvider(<vendor>, ...)` 一致。
 */
const PROVIDER_VENDOR = "amdtokenfactory";

/**
 * Build a standard set of request options for vision model calls.
 */
function buildVisionOptions(): vscode.LanguageModelChatRequestOptions {
    const options: vscode.LanguageModelChatRequestOptions = {};
    const visionThinking = vscode.workspace.getConfiguration().get<boolean>("amdTokenFactory.visionProxyThinking", false);
    if (visionThinking) {
        options.modelOptions = { reasoning_effort: "high" };
    } else {
        // reasoning_effort="disabled" is REJECTED by the API (400 "field ReasoningEffort
        // invalid, should be one of: low, medium, high, xhigh, none", 2026-09-19 tested);
        // the correct value is "none". thinking:{type:"disabled"} alone is also sufficient.
        options.modelOptions = {
            reasoning_effort: "none",
            thinking: { type: "disabled" },
        };
    }
    return options;
}

/**
 * Find a vision-capable language model from THIS provider.
 *
 * The vision proxy always uses a model registered by this extension — the same
 * vendor as the main chat model — so a bare model id (e.g. "my-model") must be
 * matched against the vendor-qualified `LanguageModelChat.id`
 * (`<vendor>/my-model`); a plain `selectChatModels({ id })` would miss it.
 * We never fall back to other vendors' models with the same bare id, since that
 * could route image requests to a different platform (different auth/pricing).
 *
 * Accepts both a bare id ("my-model") and a vendor-qualified id
 * ("<vendor>/my-model") as the configured value.
 */
async function findVisionModel(visionModelId: string): Promise<vscode.LanguageModelChat | undefined> {
    const raw = visionModelId.trim();
    if (!raw) {
        return undefined;
    }

    // Strip a vendor prefix if the user configured a qualified id.
    let bareId = raw;
    const slashIdx = raw.indexOf("/");
    if (slashIdx !== -1) {
        bareId = raw.substring(slashIdx + 1);
    }

    // 1) Our vendor + bare id — precise and cheap.
    const ownExact = await vscode.lm.selectChatModels({ vendor: PROVIDER_VENDOR, id: bareId });
    if (ownExact.length > 0) {
        return ownExact[0];
    }

    // 2) Scan our vendor's models, matching by full id, bare-id suffix, or name.
    const ownAll = await vscode.lm.selectChatModels({ vendor: PROVIDER_VENDOR });
    return ownAll.find(
        m => m.id === raw || m.id === bareId || m.id.endsWith(`/${bareId}`) || m.name === raw || m.name === bareId
    );
}

/**
 * Send a message to a vision model, stream output via progress, and return the full text.
 * progress.onThinking is called for thinking/reasoning chunks, progress.onText for text chunks.
 */
async function sendToVisionModel(
    msg: vscode.LanguageModelChatMessage,
    visionModelId: string,
    token: vscode.CancellationToken,
    progress?: {
        onThinking?: (text: string) => void;
        onText?: (text: string) => void;
    }
): Promise<string> {
    const visionModel = await findVisionModel(visionModelId);
    if (!visionModel) {
        throw new Error(`Vision model "${visionModelId}" not found. Check the amdTokenFactory.visionProxyModel setting.`);
    }
    const response = await visionModel.sendRequest([msg], buildVisionOptions(), token);
    let result = "";
    for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelThinkingPart) {
            const text = Array.isArray(chunk.value) ? chunk.value.join("") : chunk.value;
            if (text) {
                progress?.onThinking?.(text);
            }
        } else if (chunk instanceof vscode.LanguageModelTextPart) {
            result += chunk.value;
            progress?.onText?.(chunk.value);
        }
    }
    return result.trim();
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
    token: vscode.CancellationToken,
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
    return sendToVisionModel(msg, visionModelId, token, progress);
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
    token: vscode.CancellationToken,
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
    return sendToVisionModel(msg, visionModelId, token, progress);
}
