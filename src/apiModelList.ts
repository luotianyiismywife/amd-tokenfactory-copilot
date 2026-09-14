/**
 * API model list fetcher.
 *
 * Fetches the list of available model IDs from the AMD TokenFactory API
 * (/models) and caches it, following a stale-while-revalidate strategy:
 * - Blocking fetch only when no cache exists yet (first picker open after startup)
 *   — so the very first model list is real data, not the built-in fallback.
 * - Otherwise the cached list is served instantly; a background revalidation
 *   (revalidateApiModelList) refreshes it, and the caller notifies VS Code to
 *   rebuild the picker when the metadata actually changed.
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

/** Background revalidation gate: re-fetch at most this often on picker opens. */
const REVALIDATE_INTERVAL_MS = 60 * 1000;
/** Hard timeout for the /models fetch so a hanging network never stalls prepare(). */
const FETCH_TIMEOUT_MS = 10 * 1000;
/** After a failed fetch, don't block picker opens on a retry this soon (serve fallback). */
const FAILURE_BACKOFF_MS = 30 * 1000;

// ── Module-level cache ──
let cachedModelIds: string[] | null = null;
let cachedModelMetadata: ApiModelMetadata[] | null = null;
let cacheTimestamp = 0;
let lastFetchSuccess = false;
let lastFailureAt = 0;
/** In-flight fetch promise — deduplicates concurrent calls; resolves to "metadata changed". */
let inFlightFetch: Promise<boolean> | null = null;

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
    const outputModalities = Array.isArray(architecture?.output_modalities)
        ? (architecture!.output_modalities as unknown[]).filter((m): m is string => typeof m === "string")
        : [];

    // Skip non-chat endpoints: e.g. MinerU2.5-Pro is an OCR service
    // (output_modalities=["ocr"], context_length=0, no streaming/tools).
    // Advertising it in the picker would offer a "chat model" with a
    // zero-token context window that can neither stream nor call tools.
    const contextLength = typeof raw.context_length === "number" ? raw.context_length : undefined;
    if (!outputModalities.includes("text") || (contextLength !== undefined && contextLength <= 0)) {
        return undefined;
    }

    // providers[0] carries capability flags (streaming/vision/tools/reasoning)
    const providers = Array.isArray(raw.providers) ? (raw.providers as Record<string, unknown>[]) : [];
    const provider0 = providers[0] ?? {};

    const supportedParams = Array.isArray(raw.supported_parameters)
        ? (raw.supported_parameters as unknown[]).filter((p): p is string => typeof p === "string")
        : [];

    return {
        id,
        context_length: contextLength,
        vision: inputModalities.includes("image") || provider0.vision === true,
        tools: supportedParams.includes("tools") || provider0.tools === true,
        reasoning: provider0.reasoning === true || supportedParams.includes("reasoning"),
    };
}

/**
 * Fetch the model list from the API's /models endpoint.
 * The response is a bare JSON array of model entries.
 * Bounded by FETCH_TIMEOUT_MS so a hung connection can't stall prepare().
 */
async function fetchApiModelList(baseUrl: string, apiKey: string): Promise<ApiModelMetadata[]> {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
 * Stable signature of the model metadata list (order-independent), used to
 * detect real changes so background refreshes don't spam rebuild events when
 * the API merely shuffles entry order.
 */
function metadataSignature(list: ApiModelMetadata[] | null): string {
    return JSON.stringify([...(list ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
}

/**
 * Run one fetch and update the module-level cache.
 * Resolves to true when the fetched metadata differs from the cached one.
 * Never throws — failures degrade silently (log + keep stale cache).
 */
async function runFetch(baseUrl: string, apiKey: string): Promise<boolean> {
    try {
        const models = await fetchApiModelList(baseUrl, apiKey);
        const ids = models.map((m) => m.id);
        const changed = metadataSignature(models) !== metadataSignature(cachedModelMetadata);
        cachedModelIds = ids;
        cachedModelMetadata = models;
        cacheTimestamp = Date.now();
        lastFetchSuccess = true;
        logger.info("apiModelList.fetched", { count: models.length, changed, models: ids });
        return changed;
    } catch (err) {
        // API call failed — keep stale cache if available
        lastFetchSuccess = false;
        lastFailureAt = Date.now();
        logger.warn("apiModelList.fetch.failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}

/**
 * Ensure the module-level model cache is populated for immediate use.
 * Blocking fetch happens only when there is no cache at all (first picker
 * open / after a manual cache clear). With a cache present this returns
 * instantly — freshness is maintained by revalidateApiModelList instead.
 */
async function ensureApiModelCache(baseUrl: string, apiKey: string | undefined): Promise<void> {
    // Deduplicate concurrent calls (a background revalidation also counts)
    if (inFlightFetch) {
        await inFlightFetch;
        return;
    }

    if (!apiKey) {
        // No API key — keep stale cache or leave empty
        return;
    }

    if (cachedModelMetadata !== null) {
        // Have cache — serve it; background revalidation keeps it fresh
        return;
    }

    // Recent failure and still nothing cached — don't block picker opens on
    // a doomed retry; serve the built-in fallback for now.
    if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
        return;
    }

    inFlightFetch = runFetch(baseUrl, apiKey).finally(() => {
        inFlightFetch = null;
    });
    await inFlightFetch;
}

/**
 * Background revalidation of the model cache (stale-while-revalidate).
 * Fire-and-forget from prepare()/activation: refreshes the list when the
 * cache is older than REVALIDATE_INTERVAL_MS. Resolves to true when the
 * fetch succeeded AND the metadata changed — the caller should then notify
 * VS Code to rebuild the model list. Never throws.
 */
export async function revalidateApiModelList(baseUrl: string, apiKey: string | undefined): Promise<boolean> {
    if (!apiKey) {
        return false;
    }

    // Deduplicate: piggyback on an in-flight fetch
    if (inFlightFetch) {
        return inFlightFetch;
    }

    // Fresh enough — skip
    if (Date.now() - cacheTimestamp < REVALIDATE_INTERVAL_MS) {
        return false;
    }

    inFlightFetch = runFetch(baseUrl, apiKey).finally(() => {
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
    lastFailureAt = 0;
}
