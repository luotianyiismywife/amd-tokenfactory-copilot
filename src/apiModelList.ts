/**
 * API model list fetcher.
 *
 * Fetches the list of available model IDs from the AMD TokenFactory API
 * (/models) and caches it with a 5-minute TTL.
 * Falls back to stale cache or an empty list on failure (silent degradation).
 *
 * The endpoint follows the OpenAI /v1/models format (verified 2026-09-06):
 *   [{ id, name, description, family, architecture: {input_modalities,...},
 *      context_length, supported_parameters: [...], providers: [{streaming,
 *      vision, tools, reasoning,...}] }]
 * Note: the response is a bare JSON array (no {"object":"list","data":[...]} wrapper).
 */
import { logger } from "./logger";
import type { ApiModelMetadata } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Module-level cache ──
let cachedModelIds: string[] | null = null;
let cachedModelMetadata: ApiModelMetadata[] | null = null;
let cacheTimestamp = 0;
let lastFetchSuccess = false;
/** In-flight fetch promise — deduplicates concurrent calls. */
let inFlightFetch: Promise<void> | null = null;

/**
 * Normalize one raw /models entry into our ApiModelMetadata subset.
 */
function normalizeModelEntry(raw: Record<string, unknown>): ApiModelMetadata | undefined {
    const id = raw.id;
    if (typeof id !== "string" || !id) {
        return undefined;
    }

    const architecture = raw.architecture as Record<string, unknown> | undefined;
    const inputModalities = Array.isArray(architecture?.input_modalities)
        ? (architecture!.input_modalities as unknown[]).filter((m): m is string => typeof m === "string")
        : [];

    // providers[0] carries capability flags (streaming/vision/tools/reasoning)
    const providers = Array.isArray(raw.providers) ? (raw.providers as Record<string, unknown>[]) : [];
    const provider0 = providers[0] ?? {};

    const supportedParams = Array.isArray(raw.supported_parameters)
        ? (raw.supported_parameters as unknown[]).filter((p): p is string => typeof p === "string")
        : [];

    return {
        id,
        context_length: typeof raw.context_length === "number" ? raw.context_length : undefined,
        vision: inputModalities.includes("image") || provider0.vision === true,
        tools: supportedParams.includes("tools") || provider0.tools === true,
        reasoning: provider0.reasoning === true || supportedParams.includes("reasoning"),
    };
}

/**
 * Fetch the model list from the API's /models endpoint.
 * The response is a bare JSON array of model entries.
 */
async function fetchApiModelList(baseUrl: string, apiKey: string): Promise<ApiModelMetadata[]> {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        throw new Error(`API model list error: [${response.status}] ${response.statusText}`);
    }

    const body = (await response.json()) as unknown;
    const list = Array.isArray(body)
        ? body
        : Array.isArray((body as { data?: unknown[] })?.data)
            ? ((body as { data: unknown[] }).data)
            : [];

    const out: ApiModelMetadata[] = [];
    for (const item of list) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const normalized = normalizeModelEntry(item as Record<string, unknown>);
        if (normalized) {
            out.push(normalized);
        }
    }
    return out;
}

/**
 * Ensure the module-level model cache is populated (5-minute TTL, silent fallback).
 */
async function ensureApiModelCache(baseUrl: string, apiKey: string | undefined): Promise<void> {
    const now = Date.now();

    // Use cached result if still fresh
    if (cachedModelMetadata !== null && now - cacheTimestamp < CACHE_TTL_MS) {
        return;
    }

    if (!apiKey) {
        // No API key — keep stale cache or leave empty
        return;
    }

    // Deduplicate concurrent fetches
    if (inFlightFetch) {
        return inFlightFetch;
    }

    inFlightFetch = (async () => {
        try {
            const models = await fetchApiModelList(baseUrl, apiKey);
            cachedModelIds = models.map((m) => m.id);
            cachedModelMetadata = models;
            cacheTimestamp = Date.now();
            lastFetchSuccess = true;
            logger.info("apiModelList.fetched", { count: models.length, models: cachedModelIds });
        } catch (err) {
            // API call failed — keep stale cache if available
            lastFetchSuccess = false;
            logger.warn("apiModelList.fetch.failed", {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    })().finally(() => {
        inFlightFetch = null;
    });

    return inFlightFetch;
}

/**
 * Get the list of model IDs available via the AMD TokenFactory API.
 * Returns an empty set on failure (silent degradation).
 */
export async function getApiModelIds(baseUrl: string, apiKey: string | undefined): Promise<Set<string>> {
    await ensureApiModelCache(baseUrl, apiKey);
    return new Set(cachedModelIds ?? []);
}

/**
 * Get the full metadata list (context_length / vision / tools / reasoning)
 * from the cached /models response. Returns an empty list on failure.
 */
export async function getApiModelMetadataList(baseUrl: string, apiKey: string | undefined): Promise<ApiModelMetadata[]> {
    await ensureApiModelCache(baseUrl, apiKey);
    return cachedModelMetadata ?? [];
}

/**
 * Returns true if the most recent API model list fetch was successful.
 */
export function isApiFetchSuccessful(): boolean {
    return lastFetchSuccess;
}

/**
 * Clear the cached API model list (for manual refresh).
 */
export function clearApiModelCache(): void {
    cachedModelIds = null;
    cachedModelMetadata = null;
    cacheTimestamp = 0;
    lastFetchSuccess = false;
}
