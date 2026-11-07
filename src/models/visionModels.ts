/**
 * Vision capability resolution for models returned by `/v1/models`.
 *
 * Some platforms' `/v1/models` endpoint does NOT return any capability flag
 * (e.g. only `id / display_name / mode / protocols / desc / created / owned_by`).
 * In that case there is no `supports_vision`, so a naive
 * `supports_vision: m.supports_vision` always produces `undefined` and every
 * model is treated as text-only.
 *
 * Resolution order (first hit wins):
 *   1. `/v1/models` — `architecture.input_modalities` / `providers[].vision`
 *      (tri-state: `undefined` means the platform said nothing).
 *   2. models.dev — `attachment === true` or `modalities.input` contains
 *      "image".
 *   3. `false` — unknown model: treat as text-only so it goes through the
 *      ask_image proxy instead of failing on a real image request.
 *
 * The built-in catalog is deliberately NOT consulted here: it is an offline
 * fallback for when `/v1/models` fails, not an overlay on top of live platform
 * data (see `registry.ts`).
 */
import type { ApiModelMetadata } from "./apiModelList";
import type { ModelsDevEntry } from "./modelsDev";

/**
 * Resolve whether a model accepts image input.
 *
 * @param apiMeta Cached `/v1/models` metadata for this model (may be undefined).
 * @param devEntry models.dev entry for this model (may be undefined).
 */
export function resolveVisionCapability(
    apiMeta: ApiModelMetadata | undefined,
    devEntry: ModelsDevEntry | undefined
): boolean {
    // 1. Platform flag — authoritative when present.
    if (apiMeta?.supports_vision !== undefined) {
        return apiMeta.supports_vision;
    }
    // 2. models.dev catalog.
    //    `modalities.input` is the PRECISE signal — prefer it whenever present.
    //    `attachment` only means "accepts file uploads" (could be PDF-only), so
    //    it is a coarse fallback used when the modalities list is missing.
    if (devEntry) {
        const inputs = devEntry.modalities?.input;
        if (inputs && inputs.length > 0) {
            return inputs.includes("image");
        }
        if (devEntry.attachment === true) {
            return true;
        }
        if (devEntry.attachment === false) {
            return false;
        }
    }
    // 3. Unknown → text-only (routes through the ask_image proxy).
    return false;
}
