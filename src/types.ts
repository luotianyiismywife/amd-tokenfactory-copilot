/**
 * AMD TokenFactory model entry (metadata consumed from /models + per-request overrides).
 */
export interface AmdModelItem {
    id: string;
    displayName?: string;
    /** Real context window size in tokens (from /models metadata). */
    context_length?: number;
    /** Whether the model accepts image input (image_url parts). */
    vision?: boolean;
    /** Whether the model supports function/tool calling. */
    tools?: boolean;
    /** Whether the model emits reasoning (thinking) content in streaming deltas. */
    reasoning?: boolean;
    /** Whether to include reasoning_content in assistant messages sent back to the API. */
    include_reasoning_in_request?: boolean;
    /** Completion budget sent as max_tokens. Must be explicit: the AMD router's
     * server-side default cap is small and silently truncates answers. */
    max_tokens?: number;
    /** Optional sampling parameter overrides (from settings). */
    temperature?: number | null;
    top_p?: number | null;
}

/**
 * Retry configuration.
 */
export interface RetryConfig {
    enabled: boolean;
    maxAttempts: number;
    intervalMs: number;
    backoffFactor: number;
    maxIntervalMs: number;
    statusCodes: number[];
}

/**
 * Token usage information extracted from streaming response usage chunk.
 */
export interface StreamUsage {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
}

/**
 * Extended model metadata returned by the AMD /models endpoint (subset we consume).
 */
export interface ApiModelMetadata {
    id: string;
    context_length?: number;
    vision?: boolean;
    tools?: boolean;
    reasoning?: boolean;
}
