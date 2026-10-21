/**
 * API model list fetcher.
 *
 * Fetches the list of available model IDs from the platform API
 * (/v1/models) and caches it with a 5-minute TTL.
 * Falls back to stale cache or an empty list on failure (silent degradation).
 */

import { API_BASE_URL } from "../platform/platformConfig";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extended model metadata returned by /v1/models (subset we consume).
 */
export interface ApiModelMetadata {
    id: string;
    /** Friendly display name from /v1/models (display_name field). */
    display_name?: string;
    /** Model description from /v1/models (desc field) — used as picker tooltip. */
    desc?: string;
    supports_anthropic?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    supports_tools?: boolean;
    context_length?: number;
    max_completion_tokens?: number;
}

/**
 * Raw model entry returned by the AMD TokenFactory /v1/models.
 *
 * The endpoint returns `{ data: [...] }` (verified 2026-10-21) of model entries:
 *   [{ id, name, description, family,
 *      architecture: { input_modalities, output_modalities },
 *      context_length, supported_parameters: [...],
 *      providers: [{ streaming, vision, tools, reasoning, ... }] }]
 *
 * Non-chat endpoints (e.g. OCR / decision / audio services with
 * output_modalities=["ocr"|"decision"|"audio"] and context_length=0) must be
 * filtered out.
 */
interface ApiModelEntry {
    id?: string;
    name?: string;
    description?: string;
    family?: string;
    architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
    };
    context_length?: number;
    supported_parameters?: string[];
    providers?: Array<{ streaming?: boolean; vision?: boolean; tools?: boolean; reasoning?: boolean }>;
}

// ── Module-level cache ──
let cachedModelIds: string[] | null = null;
let cachedModelMetadata: ApiModelMetadata[] | null = null;
let cacheTimestamp = 0;
let lastFetchSuccess = false;
/** In-flight fetch promise — deduplicates concurrent calls (e.g. startup model
 * sync + model list request racing) so the API is only hit once. */
let inFlightFetch: Promise<void> | null = null;

/**
 * Normalize one raw /v1/models entry into our ApiModelMetadata subset.
 * Returns undefined for non-chat endpoints (no text output / zero context).
 */
function normalizeModelEntry(raw: ApiModelEntry): ApiModelMetadata | undefined {
    const id = raw.id;
    if (typeof id !== "string" || !id) {
        return undefined;
    }

    const inputModalities = raw.architecture?.input_modalities ?? [];
    const outputModalities = raw.architecture?.output_modalities ?? [];
    const contextLength = typeof raw.context_length === "number" ? raw.context_length : undefined;

    // Skip non-chat endpoints: e.g. OCR services (output_modalities=["ocr"],
    // context_length=0). Advertising them would offer a "chat model" with a
    // zero-token context window that can neither stream nor call tools.
    if (!outputModalities.includes("text") || (contextLength !== undefined && contextLength <= 0)) {
        return undefined;
    }

    const provider0 = raw.providers?.[0] ?? {};
    const supportedParams = raw.supported_parameters ?? [];

    return {
        id,
        display_name: raw.name,
        desc: raw.description,
        // AMD TokenFactory supports the Anthropic Messages protocol platform-wide
        // (the /v1/models response carries no per-model protocol flag).
        supports_anthropic: true,
        supports_vision: inputModalities.includes("image") || provider0.vision === true,
        supports_tools: supportedParams.includes("tools") || provider0.tools === true,
        supports_reasoning: provider0.reasoning === true || supportedParams.includes("reasoning"),
        context_length: contextLength,
    };
}

/**
 * Fetch the model list from the API's /models endpoint.
 * The response is `{ data: [...] }` (a bare array is also tolerated).
 */
async function fetchApiModelList(apiKey: string): Promise<ApiModelMetadata[]> {
    const url = `${API_BASE_URL.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        throw new Error(`API model list error: [${response.status}] ${response.statusText}`);
    }

    const body = (await response.json()) as unknown;
    const list: ApiModelEntry[] = Array.isArray(body)
        ? (body as ApiModelEntry[])
        : ((body as { data?: ApiModelEntry[] })?.data ?? []);
    return list
        .map(normalizeModelEntry)
        .filter((m): m is ApiModelMetadata => m !== undefined);
}

/**
 * Get the list of model IDs available via the platform API.
 *
 * @param apiKey - The API key for authentication.
 * @returns A set of model ID strings available on the API server.
 *          Returns an empty set on failure (silent degradation).
 */
export async function getApiModelIds(apiKey: string | undefined): Promise<Set<string>> {
    await ensureApiModelCache(apiKey);
    return new Set(cachedModelIds ?? []);
}

/**
 * Get the full metadata list (context_length, max_completion_tokens and the
 * supports_* capability flags) from the cached /v1/models response.
 * Returns an empty list on failure (silent degradation).
 *
 * Used by model discovery as the PRIMARY spec source for auto-discovered
 * models — the platform's own metadata is more accurate and fresher than
 * models.dev, whose catalog may lag or lack platform-specific entries
 * (fetch failures previously degraded specs to 128K context / 4096 output).
 */
export async function getApiModelMetadataList(apiKey: string | undefined): Promise<ApiModelMetadata[]> {
    await ensureApiModelCache(apiKey);
    return cachedModelMetadata ?? [];
}

/**
 * Get the set of model IDs whose /v1/models entry reports supports_anthropic=true.
 * These models can use the Anthropic Messages API protocol (POST /v1/messages).
 *
 * @param apiKey - The API key for authentication.
 * @returns A set of model IDs supporting the Anthropic protocol.
 */
export async function getAnthropicSupportedModelIds(apiKey: string | undefined): Promise<Set<string>> {
    await ensureApiModelCache(apiKey);
    return new Set((cachedModelMetadata ?? []).filter((m) => m.supports_anthropic === true).map((m) => m.id));
}

/**
 * Ensure the module-level model cache is populated (5-minute TTL, silent fallback).
 */
async function ensureApiModelCache(apiKey: string | undefined): Promise<void> {
    const now = Date.now();

    // Use cached result if still fresh
    if (cachedModelMetadata !== null && now - cacheTimestamp < CACHE_TTL_MS) {
        return;
    }

    if (!apiKey) {
        // No API key — keep stale cache or leave empty
        return;
    }

    // Deduplicate concurrent fetches: if a fetch is already in flight (e.g.
    // startup model sync and the model list request running at the same time),
    // reuse its promise instead of issuing a second request.
    if (inFlightFetch) {
        return inFlightFetch;
    }

    inFlightFetch = (async () => {
        try {
            const models = await fetchApiModelList(apiKey);
            cachedModelIds = models.map((m) => m.id);
            cachedModelMetadata = models;
            cacheTimestamp = Date.now();
            lastFetchSuccess = true;
        } catch {
            // API call failed — keep stale cache if available
            lastFetchSuccess = false;
        }
    })().finally(() => {
        inFlightFetch = null;
    });

    return inFlightFetch;
}

/**
 * Returns true if the most recent API model list fetch was successful.
 * Used by the model provider to decide whether to apply API-based filtering.
 */
export function isApiFetchSuccessful(): boolean {
    return lastFetchSuccess;
}
