import * as vscode from "vscode";
import type { RetryConfig } from "./types";
import type { StoredImage } from "../vision/types";
import { OpenAIFunctionToolDef } from "../api/openai/openaiTypes";

const RETRY_MAX_ATTEMPTS = 2;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger an HTTP-layer retry.
//
// Deliberately limited to **gateway** errors (502/504) — a quick retry often
// clears a transient gateway blip. Platform errors that the whole-round retry
// already handles (429/500/503, see `amdTokenFactory.transientRetryTimes`) are
// intentionally ABSENT: retrying them here first would multiply the two retry
// layers (maxAttempts × (transientRetryTimes + 1) attempts) and delay
// failover to another key. Network errors are retried separately via
// `networkErrorPatterns` below.
const RETRYABLE_STATUS_CODES = [502, 504];

// Network error patterns to retry
const networkErrorPatterns = [
    "fetch failed",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "ECONNREFUSED",
    "timeout",
    "TIMEOUT",
    "network error",
    "NetworkError",
];

/**
 * Map VS Code message role to OpenAI message role string.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
    const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
    const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
    const r = message.role as unknown as number;
    if (r === USER) {
        return "user";
    }
    if (r === ASSISTANT) {
        return "assistant";
    }
    return "system";
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 */
export function convertToolsToOpenAI(
    options?: vscode.ProvideLanguageModelChatResponseOptions
): { tools?: OpenAIFunctionToolDef[]; tool_choice?: string } {
    if (!options?.tools || options.tools.length === 0) {
        return {};
    }

    const tools: OpenAIFunctionToolDef[] = options.tools.map((tool) => {
        const def: OpenAIFunctionToolDef = {
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
            },
        };
        // Use the tool's inputSchema as parameters if available
        if (tool.inputSchema) {
            def.function.parameters = tool.inputSchema;
        } else {
            def.function.parameters = { type: "object", properties: {} };
        }
        return def;
    });

    // Determine tool_choice mode
    const toolMode = (options?.modelOptions as Record<string, unknown> | undefined)
        ?.toolMode as string | undefined;

    let toolChoice: string | undefined;
    if (toolMode === "required") {
        toolChoice = "required";
    } else if (toolMode === "none") {
        toolChoice = "none";
    } else if (toolMode === "auto") {
        toolChoice = "auto";
    }

    return { tools, tool_choice: toolChoice };
}

/**
 * Create retry configuration from VS Code settings.
 *
 * This is the **HTTP layer** retry (same request, immediate backoff). It is
 * distinct from the **whole-round** retry in `provider/rotation.ts`
 * (`amdTokenFactory.transientRetry*`), which re-runs the entire key-rotation loop
 * and can therefore also handle platform-side errors without switching keys.
 *
 * The two layers multiply: a request that fails with a status code present in
 * BOTH lists is attempted `maxAttempts × (transientRetryTimes + 1)` times.
 * Keep `maxAttempts` small (default 2) to avoid long hangs.
 */
export function createRetryConfig(): RetryConfig {
    const config = vscode.workspace.getConfiguration("amdTokenFactory.retry");
    const enabled = config.get<boolean>("enabled", true);
    const maxAttempts = config.get<number>("maxAttempts", RETRY_MAX_ATTEMPTS);
    const intervalMs = config.get<number>("intervalMs", RETRY_INTERVAL_MS);

    return {
        enabled,
        maxAttempts,
        intervalMs,
        backoffFactor: RETRY_BACKOFF_FACTOR,
        maxIntervalMs: RETRY_MAX_INTERVAL_MS,
        statusCodes: RETRYABLE_STATUS_CODES,
    };
}

/**
 * Execute an async function with retry logic.
 */
export async function executeWithRetry<T>(
    fn: () => Promise<T>,
    retryConfig: RetryConfig
): Promise<T> {
    if (!retryConfig.enabled) {
        return fn();
    }

    let lastError: Error | undefined;
    let delay = retryConfig.intervalMs;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            if (attempt === retryConfig.maxAttempts) {
                break;
            }

            // Check if error is retryable
            const isRetryable = isRetryableError(lastError, retryConfig.statusCodes);
            if (!isRetryable) {
                break;
            }

            // Wait before retrying
            await new Promise<void>((resolve) => setTimeout(resolve, delay));

            // Exponential backoff
            delay = Math.min(delay * retryConfig.backoffFactor, retryConfig.maxIntervalMs);
        }
    }

    throw lastError;
}

function isRetryableError(error: Error, retryableStatusCodes: number[]): boolean {
    const message = error.message.toLowerCase();

    // Check network error patterns
    for (const pattern of networkErrorPatterns) {
        if (message.includes(pattern.toLowerCase())) {
            return true;
        }
    }

    // Check HTTP status codes in error message
    for (const code of retryableStatusCodes) {
        if (message.includes(`[${code}]`) || message.includes(`status ${code}`)) {
            return true;
        }
    }

    return false;
}

/**
 * Check if a mime type is an image type.
 */
export function isImageMimeType(mimeType: string): boolean {
    return mimeType.startsWith("image/");
}

/**
 * Regex pattern to match data URI encoded images in text.
 * Matches: data:image/{format};base64,{base64_data}
 */
const DATA_URI_IMAGE_RE = /data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)/g;

/**
 * Detect base64-encoded data URI images in text, decode and store them.
 * Used during the image storage pass in convertMessages.
 * @returns The number of data URI images found and stored.
 */
export function storeDataUriImages(text: string, imagesToStore: StoredImage[]): number {
    let count = 0;
    DATA_URI_IMAGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DATA_URI_IMAGE_RE.exec(text)) !== null) {
        const fullMatch = match[0];
        const base64Data = match[1];
        count++;

        let mimeType = "image/png";
        if (fullMatch.startsWith("data:image/jpeg")) mimeType = "image/jpeg";
        else if (fullMatch.startsWith("data:image/gif")) mimeType = "image/gif";
        else if (fullMatch.startsWith("data:image/webp")) mimeType = "image/webp";
        else if (fullMatch.startsWith("data:image/bmp")) mimeType = "image/bmp";

        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        imagesToStore.push({ data: bytes, mimeType });
    }
    return count;
}

/**
 * Replace base64-encoded data URI images in text with image index references.
 * Does NOT store images (they should already be stored by the storage pass).
 * @param text The text to scan.
 * @param startIndex The starting imageIndex to assign.
 * @returns { text: string; count: number } The modified text and number of replacements.
 */
export function replaceDataUriImages(text: string, startIndex: number): { text: string; count: number } {
    let result = text;
    let offset = 0;
    let count = 0;
    let idx = startIndex;

    DATA_URI_IMAGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DATA_URI_IMAGE_RE.exec(text)) !== null) {
        const fullMatch = match[0];
        count++;
        const before = result.slice(0, match.index + offset);
        const after = result.slice(match.index + offset + fullMatch.length);
        const replacement = `\n[Image data from tool call (imageIndex=${idx}). I am a text-only model and CANNOT see images directly. I MUST call the ask_image tool to learn about it.\n\nRecommended strategy:\n1. First call ask_image for a brief description to get an overview of the image.\n2. Then call ask_image again with specific questions about details you need (e.g., colors, text content, UI elements, error messages, or any other visible information).\n]`;
        result = before + replacement + after;
        offset += replacement.length - fullMatch.length;
        idx++;
    }

    return { text: result, count };
}

/**
 * Create a data URL from a LanguageModelDataPart.
 */
export function createDataUrl(part: vscode.LanguageModelDataPart): string {
    const base64 = arrayBufferToBase64(part.data);
    return `data:${part.mimeType};base64,${base64}`;
}

function arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Check if a part is a tool result part.
 */
export function isToolResultPart(
    part: unknown
): part is vscode.LanguageModelToolResultPart {
    return part instanceof vscode.LanguageModelToolResultPart;
}

/**
 * Safely try to parse a JSON object from a string.
 * Returns { ok: true, value } or { ok: false }.
 */
export function tryParseJSONObject(
    text: string
): { ok: true; value: Record<string, unknown> } | { ok: false } {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return { ok: true, value: parsed as Record<string, unknown> };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}

/**
 * Tolerant parse of a streamed tool-call arguments string (some OpenAI-compatible
 * endpoints occasionally emit unclean arguments).
 *
 * Processing order:
 *  1. trim;
 *  2. strip markdown code fences (```json ... ```);
 *  3. strip leading/trailing non-JSON junk (text before the first `{` / after
 *     the last `}`);
 *  4. empty/undefined → `{}`;
 *  5. strict parse; on failure fall back to `repairJsonText` (smart quotes →
 *     straight quotes, trailing commas, single-quoted strings, unclosed
 *     brackets/quotes completion — stream truncation) and retry.
 *
 * Returns `undefined` when everything fails (caller decides whether to throw or
 * skip). Shared by all three protocol adapters.
 */
export function parseToolCallArguments(raw: string | undefined): Record<string, unknown> | undefined {
    if (raw === undefined) {
        return {};
    }
    let text = raw.trim();
    if (!text) {
        return {};
    }
    // Strip markdown code fences.
    const fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
    if (fence) {
        text = fence[1].trim();
    }
    // Strip leading/trailing non-JSON junk.
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.slice(firstBrace, lastBrace + 1);
    }
    if (!text) {
        return {};
    }
    const strict = tryParseJSONObject(text);
    if (strict.ok) {
        return strict.value;
    }
    const repaired = tryParseJSONObject(repairJsonText(text));
    if (repaired.ok) {
        return repaired.value;
    }
    return undefined;
}

/**
 * Best-effort repair of common JSON defects in streamed tool-call arguments.
 * Only used as a fallback when strict parsing fails.
 */
export function repairJsonText(text: string): string {
    let out = text;
    // Smart quotes → straight quotes.
    out = out.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
    // Trailing commas before } or ].
    out = out.replace(/,\s*([}\]])/g, "$1");
    // Single-quoted strings → double-quoted (naive: only when no double quotes present).
    if (!out.includes('"') && out.includes("'")) {
        out = out.replace(/'/g, '"');
    }
    // Complete unclosed brackets/quotes (stream truncation).
    let depthBrace = 0;
    let depthBracket = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < out.length; i++) {
        const ch = out[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === "{") {
            depthBrace++;
        } else if (ch === "}") {
            depthBrace--;
        } else if (ch === "[") {
            depthBracket++;
        } else if (ch === "]") {
            depthBracket--;
        }
    }
    if (inString) {
        out += '"';
    }
    while (depthBracket > 0) {
        out += "]";
        depthBracket--;
    }
    while (depthBrace > 0) {
        out += "}";
        depthBrace--;
    }
    return out;
}

/**
 * Split a concatenated sequence of top-level JSON objects, e.g.
 * `{"tool":"a"}{"tool":"b"}` → [`{"tool":"a"}`, `{"tool":"b"}`].
 *
 * Used as a fallback when parallel tool calls share the same stream `index`
 * and their argument fragments got merged into a single buffer (the collision
 * guard in `processDelta` tries to prevent). Keeps only fragments that parse
 * as complete JSON objects; drops the rest.
 *
 * Returns an empty array when nothing splits off cleanly.
 */
export function splitToolCallArguments(raw: string): Record<string, unknown>[] {
    let text = raw.trim();
    if (!text) {
        return [];
    }
    // Strip markdown code fences first.
    const fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
    if (fence) {
        text = fence[1].trim();
    }

    const results: Record<string, unknown>[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === "{") {
            if (depth === 0) {
                start = i;
            }
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0 && start !== -1) {
                const frag = text.slice(start, i + 1).trim();
                const parsed = parseToolCallArguments(frag);
                if (parsed) {
                    results.push(parsed);
                }
                start = -1;
            }
        }
    }
    return results;
}
