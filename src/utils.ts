import * as vscode from "vscode";
import type { RetryConfig } from "./types";
import { OpenAIFunctionToolDef } from "./openaiTypes";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

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
            def.function.parameters = tool.inputSchema as object;
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
 * Extract a human-readable error message from an API error response body.
 *
 * The AMD TokenFactory endpoint (FastAPI-based) returns several shapes:
 * - OpenAI style:  {"error": {"message": "...", "type": "...", "code": "..."}}
 * - FastAPI style: {"detail": "Invalid bearer token"}
 * - Nested style:  {"detail": {"error": {"message": "...", "code": "..."}}}
 */
export function extractApiErrorMessage(errorText: string): string {
    const fallback = errorText?.slice(0, 500) ?? "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(errorText);
    } catch {
        return fallback;
    }
    if (!parsed || typeof parsed !== "object") {
        return fallback;
    }
    const obj = parsed as Record<string, unknown>;

    // {"error": {...}} — OpenAI style
    const error = obj.error;
    if (error && typeof error === "object") {
        const msg = (error as Record<string, unknown>).message;
        if (typeof msg === "string" && msg) {
            const code = (error as Record<string, unknown>).code;
            return typeof code === "string" && code && code !== msg ? `${msg} (${code})` : msg;
        }
    }

    // {"detail": "..."} — FastAPI string style
    const detail = obj.detail;
    if (typeof detail === "string" && detail) {
        return detail;
    }

    // {"detail": {"error": {...}}} — FastAPI nested style
    if (detail && typeof detail === "object") {
        const inner = (detail as Record<string, unknown>).error;
        if (inner && typeof inner === "object") {
            const msg = (inner as Record<string, unknown>).message;
            if (typeof msg === "string" && msg) {
                const code = (inner as Record<string, unknown>).code;
                return typeof code === "string" && code && code !== msg ? `${msg} (${code})` : msg;
            }
        }
        // Fallback: serialize the detail object
        try {
            return JSON.stringify(detail);
        } catch {
            return fallback;
        }
    }

    // {"message": "..."} — generic
    if (typeof obj.message === "string" && obj.message) {
        return obj.message;
    }

    return fallback;
}
