#!/usr/bin/env node

/**
 * Check for new models available on the API that are not yet hardcoded.
 *
 * Extracts hardcoded model IDs from src/models/models.ts (BUILT_IN_MODELS),
 * then compares against the API model list from /v1/models.
 *
 * Outputs JSON result that can be consumed by a GitHub Action.
 *
 * Usage:
 *   node scripts/dev/check-new-models.mjs [--api-key <key>]
 *
 * Exit codes:
 *   0 — no new models found (or API unreachable)
 *   1 — new models found
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ⚠️ 移植对接点：API 根地址与 models.ts 路径。
// 地址应与 src/platform/platformConfig.ts 的 API_BASE_URL 一致。
const API_BASE_URL = "https://api.example.com/v1/";
const MODELS_TS_PATH = fileURLToPath(new URL("../../src/models/models.ts", import.meta.url));
const API_KEY_ENV = "PROVIDER_API_KEY";

// ── Helpers ──

function extractModelsFromBuiltIn(fileContent) {
    const ids = [];
    // Match: { baseId: "xxx", ... }
    const regex = /\{\s*baseId:\s*"([^"]+)"/g;
    let match;
    while ((match = regex.exec(fileContent)) !== null) {
        ids.push(match[1]);
    }
    return [...new Set(ids)].sort();
}

async function fetchApiModelIds(apiKey) {
    const url = `${API_BASE_URL.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!response.ok) {
        throw new Error(`API error: [${response.status}] ${response.statusText}`);
    }
    const body = await response.json();
    return (body.data ?? []).map((m) => m.id).sort();
}

async function fetchModelsDevEntry(apiModelId) {
    // Try downloading the full catalog for lookup
    const url = "https://models.dev/models.json";
    const response = await fetch(url);
    if (!response.ok) return null;
    const catalog = await response.json();
    // Direct match
    if (catalog[apiModelId]) return catalog[apiModelId];
    // Short ID match (last segment after /)
    for (const [fullId, entry] of Object.entries(catalog)) {
        if (fullId.endsWith(`/${apiModelId}`) || fullId === apiModelId) {
            return entry;
        }
    }
    return null;
}

/**
 * Probe a model to detect if it supports thinking (reasoning) toggling.
 * Sends a minimal request with thinking: { type: "enabled" } and checks the response.
 *
 * @returns "switchable" if thinking is supported, "always" if not, "unknown" if probe failed
 */
async function probeThinkingSupport(apiKey, modelId, apiMode = "openai") {
    if (!apiKey) return "unknown";

    const baseUrl = API_BASE_URL.replace(/\/+$/, "");
    let url, body;

    if (apiMode === "anthropic") {
        // Anthropic format
        url = baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
        body = {
            model: modelId,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
            stream: true,
            thinking: { type: "enabled" },
        };
    } else {
        // OpenAI format (default)
        url = `${baseUrl}/chat/completions`;
        body = {
            model: modelId,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
            stream: true,
            thinking: { type: "enabled" },
        };
    }

    // Abort quickly — we only need the first response
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const headers = apiMode === "anthropic"
            ? { "x-api-key": apiKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }
            : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
            // Request accepted — model supports thinking parameter
            // Drain the stream to avoid resource leaks, then return
            const reader = response.body.getReader();
            reader.cancel().catch(() => {});
            return "switchable";
        }

        if (response.status === 400) {
            const text = await response.text().catch(() => "");
            const lowerText = text.toLowerCase();
            // Check if the error mentions thinking/reasoning not being supported
            if (lowerText.includes("thinking") || lowerText.includes("reasoning")) {
                return "always";
            }
            // If model not found or other 400, can't determine
            return "unknown";
        }

        // Other status codes — can't determine
        return "unknown";
    } catch (err) {
        clearTimeout(timeout);
        // Timeout or network error — can't determine
        return "unknown";
    }
}

// ── Main ──

async function main() {
    const args = process.argv.slice(2);
    const apiKeyIndex = args.indexOf("--api-key");
    const apiKey = apiKeyIndex >= 0 ? args[apiKeyIndex + 1] : process.env[API_KEY_ENV];

    // 1. Read hardcoded IDs
    const modelsTs = readFileSync(MODELS_TS_PATH, "utf-8");

    const builtInIds = extractModelsFromBuiltIn(modelsTs);
    const allHardcodedIds = [...new Set(builtInIds)].sort();

    console.error(`[check] Built-in models: ${builtInIds.length} IDs`);
    console.error(`[check] Total hardcoded: ${allHardcodedIds.length} IDs`);

    // 2. Fetch API model list (no authentication required for model listing)
    let apiModelIds = [];
    let fetchSuccessful = false;
    try {
        apiModelIds = await fetchApiModelIds(apiKey);
        fetchSuccessful = true;
        console.error(`[check] API models: ${apiModelIds.length} IDs`);
    } catch (err) {
        console.error(`[check] Failed to fetch API model list: ${err.message}`);
    }

    // 3. Compare
    const result = {
        fetchSuccessful,
        apiModelIds,
        builtInIds,
        newModelIds: [],
        newModelDetails: [],
        summary: "",
    };

    if (fetchSuccessful && apiModelIds.length > 0) {
        const hardcodedSet = new Set(allHardcodedIds);
        result.newModelIds = apiModelIds.filter((id) => !hardcodedSet.has(id));

        if (result.newModelIds.length > 0) {
            // Fetch details from models.dev for each new model
            for (const modelId of result.newModelIds.slice(0, 30)) {
                try {
                    const entry = await fetchModelsDevEntry(modelId);
                    if (entry) {
                        // Determine thinking mode from models.dev reasoning field
                        let thinkingMode;
                        if (entry.reasoning === true) {
                            thinkingMode = "switchable";
                        } else if (entry.reasoning === false) {
                            thinkingMode = "always";
                        } else {
                            thinkingMode = "unknown";
                        }

                        result.newModelDetails.push({
                            id: modelId,
                            name: entry.name ?? modelId,
                            context: entry.limit?.context,
                            output: entry.limit?.output,
                            vision: entry.attachment === true || (entry.modalities?.input ?? []).includes("image"),
                            reasoning: entry.reasoning,
                            tool_call: entry.tool_call,
                            detectedThinkingMode: thinkingMode,
                        });
                    } else {
                        result.newModelDetails.push({ id: modelId, detectedThinkingMode: "unknown" });
                    }
                } catch {
                    result.newModelDetails.push({ id: modelId, detectedThinkingMode: "unknown" });
                }
            }

            // Probe thinking support via API if API key is available
            // This verifies/corrects the models.dev inference
            if (apiKey && result.newModelDetails.length > 0) {
                console.error(`[check] Probing thinking support for ${result.newModelDetails.length} model(s)...`);
                for (const detail of result.newModelDetails) {
                    // Skip probing if models.dev already says no thinking
                    if (detail.detectedThinkingMode === "always") {
                        continue;
                    }
                    console.error(`[check]   probing: ${detail.id}...`);
                    const probed = await probeThinkingSupport(apiKey, detail.id);
                    if (probed !== "unknown") {
                        detail.detectedThinkingMode = probed;
                        detail.thinkingProbed = true;
                    }
                    console.error(`[check]     → ${probed}`);
                }
            }

            result.summary = `Found ${result.newModelIds.length} new model(s) on API not yet in hardcoded list.`;
            console.error(`[check] ${result.summary}`);
            for (const m of result.newModelIds) {
                console.error(`[check]   - ${m}`);
            }
        } else {
            result.summary = "All API models are covered by the hardcoded list.";
            console.error(`[check] ${result.summary}`);
        }
    } else {
        result.summary = "API fetch failed or skipped — cannot compare.";
        console.error(`[check] ${result.summary}`);
    }

    // 4. Output JSON for GitHub Action consumption
    console.log(JSON.stringify(result));

    // Exit code: 1 if new models found, 0 otherwise
    if (result.newModelIds.length > 0) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    // Output empty result on error so the action can handle it gracefully
    console.log(JSON.stringify({
        fetchSuccessful: false,
        apiModelIds: [],
        builtInIds: [],
        newModelIds: [],
        newModelDetails: [],
        summary: `Script error: ${err.message}`,
    }));
    process.exit(0);
});
