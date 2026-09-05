/**
 * Token usage information extracted from streaming response usage chunk.
 * (Kept as a standalone module so statusBar / gitCommit imports stay
 * identical to the upstream TokenRhythm implementation.)
 */
export interface StreamUsage {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
}
