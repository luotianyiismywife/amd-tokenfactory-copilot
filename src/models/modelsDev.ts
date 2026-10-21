/**
 * Models.dev metadata fetcher and query engine.
 *
 * Downloads the models.dev catalog (https://models.dev/models.json) and provides
 * fast lookup of model metadata by ID. Used to auto-discover new models that
 * appear in the API model list but are not yet in the hardcoded built-in list.
 *
 * The metadata includes context length, max output tokens, vision support,
 * reasoning capability, tool calling support, temperature support, etc.
 *
 * Cached in memory for 1 hour. Silent degradation on failure.
 */

const MODELS_DEV_URL = "https://models.dev/models.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Types ──

/**
 * A single entry from models.dev/models.json.
 */
export interface ModelsDevEntry {
    id: string;
    name?: string;
    family?: string;
    reasoning?: boolean;
    tool_call?: boolean;
    structured_output?: boolean;
    temperature?: boolean;
    attachment?: boolean;
    modalities?: {
        input?: string[];
        output?: string[];
    };
    limit?: {
        context?: number;
        output?: number;
        input?: number;
    };
}

// ── Module-level cache ──

/** Map from models.dev fully qualified ID to entry. */
let metadataMap: Map<string, ModelsDevEntry> | null = null;
/** Map from short ID (last segment after slash) to entry. */
let shortIdMap: Map<string, ModelsDevEntry> | null = null;
let cacheTimestamp = 0;
/** Timestamp of the last fetch ATTEMPT (success or failure). Used to back off
 *  retries when the catalog is unreachable — without it every model list
 *  refresh would re-hit the endpoint. */
let lastAttemptAt = 0;
/** Minimum delay between fetch attempts when loading fails (60s). */
const RETRY_BACKOFF_MS = 60 * 1000;

// ── Internal helpers ──

/**
 * Fetch the full models.dev catalog JSON.
 */
async function fetchModelsDevCatalog(): Promise<Record<string, ModelsDevEntry>> {
    const response = await fetch(MODELS_DEV_URL);
    if (!response.ok) {
        throw new Error(`models.dev error: [${response.status}] ${response.statusText}`);
    }
    return (await response.json()) as Record<string, ModelsDevEntry>;
}

function rebuildIndex(data: Record<string, ModelsDevEntry>): void {
    metadataMap = new Map();
    shortIdMap = new Map();

    for (const [fullId, entry] of Object.entries(data)) {
        metadataMap.set(fullId, entry);
        // Also index by the short name (last segment after '/')
        const slashIdx = fullId.lastIndexOf("/");
        if (slashIdx >= 0) {
            const shortId = fullId.slice(slashIdx + 1);
            shortIdMap.set(shortId, entry);
        }
    }
}

// ── Public API ──

/**
 * Ensure the models.dev catalog is loaded and cached.
 * Silently degrades on failure — existing cache is preserved.
 */
export async function ensureModelsDevLoaded(): Promise<void> {
    const now = Date.now();

    // Already loaded and fresh
    if (metadataMap !== null && metadataMap.size > 0 && now - cacheTimestamp < CACHE_TTL_MS) {
        return;
    }

    // Use stale cache if recent enough (within 2x TTL) — but only when it
    // actually contains data. An EMPTY map is the product of a failed initial
    // load; bumping its timestamp here would "poison" the cache and pin the
    // empty state for another full TTL window.
    if (metadataMap !== null && metadataMap.size > 0 && now - cacheTimestamp < CACHE_TTL_MS * 2) {
        cacheTimestamp = now; // Bump timestamp to reduce retry frequency
        return;
    }

    // Back off after a recent failed attempt — don't hammer the endpoint on
    // every model list refresh while the network is flaky.
    if (now - lastAttemptAt < RETRY_BACKOFF_MS) {
        return;
    }
    lastAttemptAt = now;

    try {
        const data = await fetchModelsDevCatalog();
        if (Object.keys(data).length > 0) {
            rebuildIndex(data);
            cacheTimestamp = now;
        }
        // A successful fetch with an empty catalog is treated as a failure —
        // keep whatever cache we have and retry after the backoff.
    } catch {
        // Silent degradation — keep existing cache if any. A failed initial
        // load leaves metadataMap null so the next call (after the backoff)
        // retries the fetch instead of serving an empty catalog for an hour.
        if (metadataMap === null) {
            metadataMap = new Map();
            shortIdMap = new Map();
        }
    }
}

/**
 * Look up a model's metadata by its API model ID.
 *
 * Matching strategy (in order):
 * 1. Exact match on the full models.dev ID
 * 2. Short ID match (last segment after '/')
 * 3. Direct match on the API ID itself
 *
 * @param apiModelId - The model ID as returned by the API (e.g. "deepseek-v4-flash")
 * @returns The models.dev entry, or undefined if not found.
 */
export function lookupModelDevEntry(apiModelId: string): ModelsDevEntry | undefined {
    if (!metadataMap) {
        return undefined;
    }

    // 1. Direct match on full ID
    if (metadataMap.has(apiModelId)) {
        return metadataMap.get(apiModelId);
    }

    // 2. Short ID match
    if (shortIdMap?.has(apiModelId)) {
        return shortIdMap.get(apiModelId);
    }

    // 3. Try suffix match: some API IDs might be prefix of the full path
    for (const [fullId, entry] of metadataMap) {
        if (fullId.endsWith(`/${apiModelId}`) || fullId === apiModelId) {
            return entry;
        }
    }

    return undefined;
}
