/**
 * Vision capability resolution for platform models.
 *
 * Some platforms' `/v1/models` endpoint does NOT return any capability flag
 * (e.g. only `id / display_name / mode / protocols / desc / created / owned_by`).
 * In that case there is no `supports_vision`, so a naive
 * `supports_vision: m.supports_vision` always produces `undefined` and every
 * model is treated as text-only.
 *
 * Resolution order (first hit wins):
 *   1. `/v1/models` `supports_vision` — used if the platform returns it.
 *   2. models.dev — `attachment === true` or `modalities.input` contains
 *      "image".
 *   3. Hardcoded fallback — for the platform's own models, which may be absent
 *      from both catalogs. Defaults to `false` (text-only) so an unknown model
 *      goes through the ask_image proxy instead of failing on a real image
 *      request.
 */
import type { ApiModelMetadata } from "./apiModelList";
import type { ModelsDevEntry } from "./modelsDev";

/**
 * Hardcoded vision capability for models absent from models.dev / OpenRouter.
 *
 * AMD TokenFactory 自研/托管模型的视觉能力兜底（`/v1/models` 的
 * `architecture.input_modalities` 是主源，此处仅作兜底）。
 * 与 2026-10-21 /models 实测对齐。
 */
const HARDCODED_VISION: Record<string, boolean> = {
    "DeepSeek-V4.1-Flash": true,
    "DeepSeek-V4-Flash": false,
    "Gemma-4-31B-IT": true,
    "GLM-5.3-Flash": false,
    "MiMo-V2.6-Flash": true,
    "MiniCPM5-2B": false,
    "MiniCPM-V-4.7-1B": true,
    "MiniCPM-V-4.7-35B-A3B": true,
    "Qwen3.8-27B": true,
    "Qwen3.8-Flash-Next": true,
};

/**
 * Resolve whether a model accepts image input.
 *
 * @param modelId Model ID as returned by `/v1/models`.
 * @param apiMeta Cached `/v1/models` metadata for this model (may be undefined).
 * @param devEntry models.dev entry for this model (may be undefined).
 */
export function resolveVisionCapability(
    modelId: string,
    apiMeta: ApiModelMetadata | undefined,
    devEntry: ModelsDevEntry | undefined
): boolean {
    // 1. Platform flag (not currently returned, but honoured if it appears).
    if (apiMeta?.supports_vision !== undefined) {
        return apiMeta.supports_vision;
    }
    // 2. models.dev catalog.
    if (devEntry) {
        if (devEntry.attachment === true) {
            return true;
        }
        if (devEntry.modalities?.input?.includes("image")) {
            return true;
        }
        if (devEntry.attachment === false) {
            return false;
        }
    }
    // 3. Hardcoded fallback (the platform's own models).
    return HARDCODED_VISION[modelId] ?? false;
}
