import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getGitDiff, getRecentCommits } from "./gitUtils";
import { OpenaiApi } from "../api/openai/openaiApi";
import { AnthropicApi } from "../api/anthropic/anthropicApi";
import { getBuiltInModelConfig } from "../models/models";
import { getAnthropicSupportedModelIds } from "../models/apiModelList";
import { logger } from "../core/logger";
import { l10n, l10nFormat } from "../core/localize";
import { API_BASE_URL } from "../platform/platformConfig";
import type { ProviderModelItem } from "../core/types";
import {
    getApiKeyMode,
    getApiKeyStore,
    getSingleKeyFallback,
    getTransientRetryTimes,
    hasTransientExhaustedKey,
    markApiKeyExhausted,
    markApiKeyAvailable,
    maskApiKey,
    matchErrorRule,
    pickNextApiKey,
    setActiveKeyByValue,
    shouldSingleKeyFallbackSwitch,
    type ApiKeyEntry,
    type ErrorRule,
} from "../keys/keyManager";
import { buildAllKeysUnavailableDetail, tryTransientRetryRound } from "../provider/provider";

/**
 * Git commit message generator module.
 */

/**
 * Minimal shape of a VS Code Git extension repository.
 *
 * The Git extension's own types are not part of the public `vscode` API surface
 * (they live in the extension's `api.d.ts`), so we declare the subset we use
 * instead of falling back to `any`.
 */
interface GitRepository {
    rootUri: vscode.Uri;
    inputBox: { value: string };
}

let commitGenerationAbortController: AbortController | undefined;

const DEFAULT_PROMPT = {
    system:
        "You are a helpful assistant that generates concise, informative git commit messages based on git diffs.\n\nGuidelines:\n- By default, use conventional commit format: <type>(<scope>): <description>\n- If reference commits are provided below, match their style and language instead\n- Keep the subject line under 72 characters\n- Use the imperative mood (\"add\" not \"added\" / \"adds\")\n- CRITICAL: Output ONLY the commit message itself — no preamble, no introduction, no explanations, no backticks\n- If the diff is large, focus on the most important changes",
    user: "Notes from developer (ignore if not relevant): {{USER_CURRENT_INPUT}}",
    styleReference: "\n\nRecent commit messages in this repository (match their style):\n{{RECENT_COMMITS}}",
};

export async function generateCommitMsg(secrets: vscode.SecretStorage, scm?: vscode.SourceControl) {
    try {
        const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
        if (!gitExtension) {
            throw new Error(l10n("Git extension not found"));
        }

        const git = gitExtension.getAPI(1);
        if (git.repositories.length === 0) {
            throw new Error(l10n("No Git repositories available"));
        }

        if (scm) {
            const repository = git.getRepository(scm.rootUri);

            if (!repository) {
                throw new Error(l10n("Repository not found for provided SCM"));
            }

            await generateCommitMsgForRepository(secrets, repository);
            return;
        }

        await orchestrateWorkspaceCommitMsgGeneration(secrets, git.repositories);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`${l10n("[Commit Generation Failed]")} ${errorMessage}`);
    }
}

async function orchestrateWorkspaceCommitMsgGeneration(secrets: vscode.SecretStorage, repos: GitRepository[]) {
    const reposWithChanges = await filterForReposWithChanges(repos);

    if (reposWithChanges.length === 0) {
        vscode.window.showInformationMessage(l10n("No changes found in any workspace repositories."));
        return;
    }

    if (reposWithChanges.length === 1) {
        const repo = reposWithChanges[0];
        await generateCommitMsgForRepository(secrets, repo);
        return;
    }

    const selection = await promptRepoSelection(reposWithChanges);

    if (!selection) {
        return;
    }

    if (selection.repo === null) {
        for (const repo of reposWithChanges) {
            try {
                await generateCommitMsgForRepository(secrets, repo);
            } catch (error) {
                console.error(`Failed to generate commit message for ${repo.rootUri.fsPath}:`, error);
            }
        }
    } else {
        await generateCommitMsgForRepository(secrets, selection.repo);
    }
}

async function filterForReposWithChanges(repos: GitRepository[]): Promise<GitRepository[]> {
    const reposWithChanges: GitRepository[] = [];

    for (const repo of repos) {
        try {
            const gitDiff = await getGitDiff(repo.rootUri.fsPath);
            if (gitDiff) {
                reposWithChanges.push(repo);
            }
        } catch {
            // Skip repositories with errors
        }
    }
    return reposWithChanges;
}

async function promptRepoSelection(repos: GitRepository[]) {
    const repoItems: (vscode.QuickPickItem & { repo: GitRepository | null })[] = repos.map((repo) => ({
        label: repo.rootUri.fsPath.split(path.sep).pop() || repo.rootUri.fsPath,
        description: repo.rootUri.fsPath,
        repo: repo,
    }));

    repoItems.unshift({
        label: "$(git-commit) Generate for all repositories with changes",
        description: `Generate commit messages for ${repos.length} repositories`,
        repo: null,
    });

    return await vscode.window.showQuickPick(repoItems, {
        placeHolder: "Select repository for commit message generation",
    });
}

async function generateCommitMsgForRepository(secrets: vscode.SecretStorage, repository: GitRepository) {
    const inputBox = repository.inputBox;
    const repoPath = repository.rootUri.fsPath;
    const gitDiff = await getGitDiff(repoPath);

    if (!gitDiff) {
        throw new Error(`No changes in repository ${repoPath.split(path.sep).pop() || "repository"} for commit message`);
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.SourceControl,
            title: `Generating commit message for ${repoPath.split(path.sep).pop() || "repository"}...`,
            cancellable: true,
        },
        (_, token) => {
            token.onCancellationRequested(() => {
                commitGenerationAbortController?.abort();
            });
            return performCommitMsgGeneration(secrets, gitDiff, inputBox, repoPath);
        }
    );
}

async function ensureApiKeyEntry(secrets: vscode.SecretStorage): Promise<ApiKeyEntry | undefined> {
    const store = await getApiKeyStore(secrets);
    if (store.keys.length > 0) {
        return store.keys[store.activeIndex] ?? store.keys[0];
    }
    // No key configured — return undefined silently (no input prompt).
    // The caller throws the "API key not found" error; keys are added via
    // the Manage API Keys command.
    return undefined;
}

async function performCommitMsgGeneration(secrets: vscode.SecretStorage, gitDiff: string, inputBox: { value: string }, repoPath?: string) {
    const startTime = Date.now();
    let modelId: string | undefined;
    try {
        vscode.commands.executeCommand("setContext", "amdtokenfactory.isGeneratingCommit", true);
        const config = vscode.workspace.getConfiguration();

        const customSystemPrompt = config.get<string>("amdTokenFactory.commitMessagePrompt", "");
        let systemPrompt = customSystemPrompt || DEFAULT_PROMPT.system;

        // Fetch recent commits for style reference
        const recentCommitsCount = config.get<number>("amdTokenFactory.recentCommitsCount", 10);
        const includeCommitDiff = config.get<boolean>("amdTokenFactory.commitIncludeCommitDiff", false);
        if (recentCommitsCount > 0 && repoPath) {
            const recentCommits = await getRecentCommits(repoPath, recentCommitsCount, { includeDiff: includeCommitDiff });
            if (recentCommits) {
                const styleRef = includeCommitDiff
                    ? "\n\nRecent commit messages and their changes in this repository (match their style):\n{{RECENT_COMMITS}}"
                    : DEFAULT_PROMPT.styleReference;
                systemPrompt += styleRef.replace("{{RECENT_COMMITS}}", recentCommits);
            }
        }

        const prompts: string[] = [];

        // Attach AGENTS.md and README.md context
        const attachContextFiles = config.get<boolean>("amdTokenFactory.commitAttachContextFiles", true);
        if (attachContextFiles && repoPath) {
            const contextFiles = ["AGENTS.md", "README.md"];
            for (const fileName of contextFiles) {
                const filePath = path.join(repoPath, fileName);
                try {
                    if (fs.existsSync(filePath)) {
                        const content = fs.readFileSync(filePath, "utf-8").trim();
                        if (content) {
                            const truncated = content.length > 8000
                                ? content.substring(0, 8000) + "\n\n[Content truncated due to size]"
                                : content;
                            prompts.push(`[File: ${fileName}]\n${truncated}`);
                        }
                    }
                } catch {
                    // Skip files that can't be read
                }
            }
        }

        const currentInput = inputBox.value?.trim() || "";
        if (currentInput) {
            prompts.push(DEFAULT_PROMPT.user.replace("{{USER_CURRENT_INPUT}}", currentInput));
        }

        const truncatedDiff =
            gitDiff.length > 5000 ? gitDiff.substring(0, 5000) + "\n\n[Diff truncated due to size]" : gitDiff;
        prompts.push(truncatedDiff);
        const prompt = prompts.join("\n\n");

        // Use model from config or the neutral default (replace with your platform's model)
        const commitModelId = config.get<string>("amdTokenFactory.commitModel", "DeepSeek-V4-Flash");
        // Fetch full model config (apiMode, max_completion_tokens, extra, etc.)
        const selectedModel: ProviderModelItem = getBuiltInModelConfig(commitModelId) ?? { id: commitModelId, owned_by: "provider" };
        // Commit messages are simple tasks — disable thinking to speed up generation.
        selectedModel.enable_thinking = false;
        // Cap max_completion_tokens to avoid proxy 500 errors with oversized values
        if (selectedModel.max_completion_tokens && selectedModel.max_completion_tokens > 8192) {
            selectedModel.max_completion_tokens = 8192;
        }
        modelId = selectedModel.id;
        logger.info("commit.start", { modelId });

        const primaryEntry = await ensureApiKeyEntry(secrets);
        if (!primaryEntry) {
            throw new Error(l10n("API key not found"));
        }

        const baseUrl = selectedModel.baseUrl || API_BASE_URL;
        if (!baseUrl || !baseUrl.startsWith("http")) {
            throw new Error(l10n("Invalid base URL configuration."));
        }

        // Apply language instruction: auto mode lets the model infer from style reference
        const commitLanguage = config.get<string>("amdTokenFactory.commitLanguage", "auto");
        if (commitLanguage !== "auto") {
            systemPrompt += ` Generate commit message in ${commitLanguage}.`;
        }

        const messages = [{ role: "user", content: prompt }];

        // Use the appropriate API based on model config, overridable by user setting.
        // In auto mode, protocol capability is detected dynamically from /v1/models
        // (supports_anthropic) — no model IDs are hardcoded.
        // Priority in auto mode:
        //   1. enableAnthropicApi (default false) + model supports_anthropic=true → anthropic
        //   2. otherwise → openai
        // (AMD does not support the OpenAI Responses protocol.)
        const apiModeSetting = config.get<string>("amdTokenFactory.apiMode", "auto");
        const enableAnthropicApi = config.get<boolean>("amdTokenFactory.enableAnthropicApi", false);
        let apiMode: string;
        if (apiModeSetting === "openai" || apiModeSetting === "anthropic") {
            apiMode = apiModeSetting;
        } else {
            const anthropicModelIds = await getAnthropicSupportedModelIds(primaryEntry.value);
            if (enableAnthropicApi && anthropicModelIds.has(commitModelId)) {
                apiMode = "anthropic";
            } else {
                apiMode = "openai";
            }
        }
        // Reflect the effective apiMode on the model so createMessage() builds
        // the correct headers (x-api-key for anthropic, Bearer for openai).
        selectedModel.apiMode = apiMode;

        // ── Multi-API-Key rotation loop for commit generation ──────────────────
        const apiKeyMode = getApiKeyMode();
        const singleFallback = getSingleKeyFallback();
        let response = "";
        // Track per-key failure rules so the "all keys exhausted" error can
        // show which key failed and why (masked), and distinguish transient
        // failures (rotateCooldown — retry later) from permanent ones
        // (rotatePersist — check).
        const failedKeys = new Map<string, ErrorRule>();
        const totalKeys = (await getApiKeyStore(secrets)).keys.length;
        // Transient (429/503) whole-round auto-retry: when every key is busy or
        // rate-limited, wait with backoff and retry the whole round instead of
        // failing immediately (platform congestion usually clears within seconds).
        const maxTransientRetries = getTransientRetryTimes();
        // Per-scenario retry counters (mirrors provider/rotation.ts): a 500
        // same-key retry must not consume the 429/503 whole-round quota.
        let wholeRoundRetryCount = 0;
        let sameKeyRetryCount = 0;
        // Platform-side transient error (e.g. 500) retry: force re-use of the
        // SAME key on the next round. Without this, rotation mode's cursor has
        // already advanced and pickNextApiKey would silently switch to the next
        // key — contradicting "500 is a platform problem, do not rotate keys"
        // (mirrors the forceKey mechanism in provider/rotation.ts).
        let forceKey: ApiKeyEntry | undefined;

        while (true) {
            // If every key has failed at least one round, stop trying.
            if (totalKeys > 0 && failedKeys.size >= totalKeys) {
                const detail = [...failedKeys.entries()]
                    .map(([key, rule]) => `${maskApiKey(key)}: ${rule.message ?? rule.code ?? ""}`)
                    .join("; ");
                const hasTransient = [...failedKeys.values()].some((r) => r.action === "rotateCooldown");
                // Platform busy / rate-limited: back off and retry the whole
                // round automatically instead of failing immediately.
                if (hasTransient && (await tryTransientRetryRound(secrets, wholeRoundRetryCount, maxTransientRetries))) {
                    wholeRoundRetryCount++;
                    failedKeys.clear();
                    continue;
                }
                logger.warn("commit.key.allUnavailable", { detail });
                if (hasTransient) {
                    throw new Error(l10nFormat("All API keys are temporarily unavailable ({0}). Please retry later.", detail));
                }
                throw new Error(l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability, or reset exhausted states to recover keys that may have been marked unavailable by mistake.", detail));
            }

            let entry = forceKey ?? (await pickNextApiKey(secrets, apiKeyMode));
            forceKey = undefined;
            if (!entry) {
                // single mode + fallback=switch → switch ONLY when the current key
                // is balance-exhausted (402 / balance pre-check failed this round);
                // the new key also becomes the "current" key. Other rotation errors
                // (401 invalid key, 429/503 transient) do NOT switch — they fail
                // below (the transient whole-round retry still applies for 429/503).
                if (
                    apiKeyMode === "single" &&
                    singleFallback === "switch" &&
                    (await shouldSingleKeyFallbackSwitch(secrets, failedKeys))
                ) {
                    entry = await pickNextApiKey(secrets, "rotation");
                    if (entry) {
                        await setActiveKeyByValue(secrets, entry.value);
                        logger.info("commit.key.singleSwitch", { key: maskApiKey(entry.value) });
                    }
                }
                if (!entry) {
                    // Every key is excluded (persisted unavailable / cooldown /
                    // insufficient balance). If any key is merely in transient
                    // cooldown (429/503), back off and retry the whole round.
                    if (
                        (await hasTransientExhaustedKey(secrets)) &&
                        (await tryTransientRetryRound(secrets, wholeRoundRetryCount, maxTransientRetries))
                    ) {
                        wholeRoundRetryCount++;
                        failedKeys.clear();
                        continue;
                    }
                    // Show why each key can't be used. In single mode only the
                    // current key (plus any switched-to keys) were tried — use a
                    // dedicated message instead of "all keys unavailable".
                    const detail = await buildAllKeysUnavailableDetail(secrets);
                    logger.warn("commit.key.allUnavailable", { detail });
                    if (apiKeyMode === "single") {
                        throw new Error(
                            l10nFormat(
                                "Current API key is unavailable ({0}). Single mode only switches keys on insufficient balance (402); retry later or check via the Manage API Keys command.",
                                detail
                            )
                        );
                    }
                    throw new Error(
                        l10nFormat("All API keys are unavailable ({0}). Use the Manage API Keys command to check availability, or reset exhausted states to recover keys that may have been marked unavailable by mistake.", detail)
                    );
                }
            }

            const apiInstance = apiMode === "anthropic"
                ? new AnthropicApi(modelId)
                : new OpenaiApi(modelId);

            commitGenerationAbortController = new AbortController();
            try {
                const stream = apiInstance.createMessage(selectedModel, systemPrompt, messages, baseUrl, entry.value, commitGenerationAbortController.signal);

                response = "";
                for await (const chunk of stream) {
                    commitGenerationAbortController.signal.throwIfAborted();
                    if (chunk.type === "text") {
                        response += chunk.text;
                        inputBox.value = extractCommitMessage(response);
                    }
                }
                // Success — self-heal if this key was previously marked unavailable
                // (mirrors the chat rotation loop in provider/rotation.ts).
                if (entry.available === false) {
                    await markApiKeyAvailable(secrets, entry.value);
                    logger.info("commit.key.recovered", { key: maskApiKey(entry.value) });
                }
                break; // success
            } catch (err) {
                // User cancellation → stop immediately
                if (commitGenerationAbortController.signal.aborted) {
                    throw err;
                }
                // If partial output already written to the InputBox, do NOT switch
                // keys (avoid overwriting half-written content) — just fail.
                if (response.length > 0) {
                    throw err;
                }
                // 错误分类（errorRules 四元组：code + message + statusCode + action）
                const rule = matchErrorRule(err);
                if (rule?.action === "rotateCooldown" || rule?.action === "rotatePersist") {
                    // 换 key（冷却或持久化失效，由 action 决定）
                    const reason = rule.message ?? rule.code ?? "";
                    failedKeys.set(entry.value, rule);
                    await markApiKeyExhausted(secrets, entry.value, reason, rule.action);
                    logger.warn("commit.key.rotation", {
                        key: entry.value.slice(0, 6) + "****",
                        reason,
                        action: rule.action,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue; // try next key
                }

                if (rule?.action === "retrySameKey") {
                    // 不换 key，退避后重试同一个 key（平台侧/客户端侧瞬态问题）
                    if (await tryTransientRetryRound(secrets, sameKeyRetryCount, maxTransientRetries)) {
                        sameKeyRetryCount++;
                        failedKeys.clear();
                        // Force the SAME key on the next round: the error is a
                        // platform/client-side problem, not a key problem.
                        forceKey = entry;
                        logger.warn("commit.key.transientRetrySameKey", {
                            key: entry.value.slice(0, 6) + "****",
                            attempt: sameKeyRetryCount,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        continue; // retry the whole round with the same key
                    }
                    logger.warn("commit.key.transientRetryExhausted", {
                        key: entry.value.slice(0, 6) + "****",
                        attempts: sameKeyRetryCount,
                    });
                }

                throw err; // 未命中任何规则
            }
        }

        inputBox.value = removeThinkTags(inputBox.value);

        if (!inputBox.value) {
            throw new Error(l10n("empty API response"));
        }

        logger.info("commit.end", { modelId, durationMs: Date.now() - startTime });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("commit.error", { modelId: modelId ?? "unknown", error: errorMessage });
        vscode.window.showErrorMessage(`${l10n("Failed to generate commit message:")} ${errorMessage}`);
    } finally {
        vscode.commands.executeCommand("setContext", "amdtokenfactory.isGeneratingCommit", false);
    }
}

export function abortCommitGeneration() {
    commitGenerationAbortController?.abort();
    vscode.commands.executeCommand("setContext", "amdtokenfactory.isGeneratingCommit", false);
}

function extractCommitMessage(str: string): string {
    return str
        .trim()
        .replace(/^```[^\n]*\n?|```$/g, "")
        .trim();
}

function removeThinkTags(text: string): string {
    const regex = /<think>.*?<\/think>/gs;
    return text.replace(regex, "").trim();
}
