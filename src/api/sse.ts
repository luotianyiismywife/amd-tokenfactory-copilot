import * as vscode from "vscode";
import type { CancellationToken } from "vscode";
import { logger } from "../core/logger";

/**
 * 共享的 SSE（Server-Sent Events）流解析工具。
 *
 * 两个协议适配器（OpenAI / Anthropic）此前各自复制了一份
 * 「reader + TextDecoder + buffer 切行 + data: 前缀 + [DONE] + JSON.parse
 * + 取消回调注册 + finally 清理」的循环，本模块将其统一。
 *
 * 两种消费方式：
 * - `consumeSseStream()`：回调式，用于 `processStreamingResponse`。
 * - `iterateSseEvents()`：异步生成器，用于 `createMessage`（需要 yield）。
 */

/** 单条 SSE 事件。 */
export interface SseEvent {
    /** 解析后的 JSON 负载；`done === true` 时为 undefined。 */
    parsed?: unknown;
    /** 原始 data 字符串（已去掉 `data:` 前缀并 trim）。 */
    raw: string;
    /** 是否为 `[DONE]` 哨兵事件。 */
    done: boolean;
}

export interface SseStreamOptions {
    /** 日志标签前缀，如 `"openai"` → `openai.stream.chunk.error`。 */
    tag: string;
    /** 模型 ID，仅用于日志。 */
    modelId: string;
    /** VS Code 取消令牌（流式响应场景）。 */
    token?: CancellationToken;
    /** AbortSignal（非流式生成器场景）。 */
    signal?: AbortSignal;
    /** 是否逐条打印 chunk 调试日志（默认 false）。 */
    debugChunks?: boolean;
}

/**
 * 逐条产出 SSE 事件。负责 reader 生命周期、取消注册与 finally 清理。
 * 解析失败的 chunk 会记录日志并跳过（不中断流）。
 */
export async function* iterateSseEvents(
    responseBody: ReadableStream<Uint8Array>,
    options: SseStreamOptions,
): AsyncGenerator<SseEvent> {
    const { tag, modelId, token, signal, debugChunks } = options;
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let cancelDisposable: vscode.Disposable | undefined;

    // 用户取消时立即中断流，避免 reader.read() 长时间挂起
    if (token?.onCancellationRequested) {
        cancelDisposable = token.onCancellationRequested(() => {
            reader.cancel().catch(() => {});
        });
    }
    const abortHandler = () => {
        reader.cancel().catch(() => {});
    };
    if (signal) {
        if (signal.aborted) {
            abortHandler();
        } else {
            signal.addEventListener("abort", abortHandler);
        }
    }

    try {
        while (true) {
            if (token?.isCancellationRequested) {
                break;
            }
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            // SSE 规范：同一事件的多行 `data:` 以 `\n` 拼接成一个事件。
            // 三家 API 均为单行 JSON，实际无影响，但按规范实现以兼容未来。
            const events: string[] = [];
            let pending = "";
            for (const line of lines) {
                if (line.startsWith("data:")) {
                    const data = line.slice(5).trim();
                    if (data === "[DONE]") {
                        if (pending) { events.push(pending); pending = ""; }
                        events.push("[DONE]");
                    } else if (pending) {
                        pending += "\n" + data;
                    } else {
                        pending = data;
                    }
                } else if (!line.trim() && pending) {
                    // 空行 = 事件边界
                    events.push(pending);
                    pending = "";
                }
            }
            if (pending) {
                events.push(pending);
            }

            for (const data of events) {
                if (debugChunks) {
                    logger.debug(`${tag}.stream.chunk`, { modelId, data });
                }
                if (data === "[DONE]") {
                    yield { raw: data, done: true };
                    continue;
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    console.error(`[Copilot Provider] Failed to parse ${tag} SSE chunk:`, e, "data:", data);
                    logger.error(`${tag}.stream.chunk.error`, {
                        modelId,
                        error: e instanceof Error ? e.message : String(e),
                        data,
                    });
                    continue;
                }
                yield { raw: data, done: false, parsed };
            }
        }
    } finally {
        cancelDisposable?.dispose();
        if (signal) {
            signal.removeEventListener("abort", abortHandler);
        }
        reader.releaseLock();
    }
}

export interface ConsumeSseOptions extends SseStreamOptions {
    /** 每条事件回调（`[DONE]` 不会触发）。 */
    onEvent: (parsed: unknown, raw: string) => void | Promise<void>;
    /** 收到 `[DONE]` 时回调。 */
    onDone?: () => void | Promise<void>;
    /** finally 阶段的额外清理（如 `reportEndThinking`）。 */
    onFinally?: () => void;
}

/**
 * 回调式消费 SSE 流。统一处理开始/结束/错误日志与 finally 清理。
 */
export async function consumeSseStream(
    responseBody: ReadableStream<Uint8Array>,
    options: ConsumeSseOptions,
): Promise<void> {
    const { tag, modelId, onEvent, onDone, onFinally } = options;
    logger.debug(`${tag}.stream.start`, { modelId });
    let doneCalled = false;
    try {
        for await (const event of iterateSseEvents(responseBody, options)) {
            if (event.done) {
                await onDone?.();
                doneCalled = true;
                continue;
            }
            await onEvent(event.parsed, event.raw);
        }
        // Stream ended WITHOUT a `[DONE]` sentinel (connection closed cleanly,
        // or a provider that never sends it). Still flush the end-of-stream
        // work (e.g. buffered tool calls) — otherwise tool calls are silently
        // dropped. `onDone` is idempotent (flushToolCallBuffers returns early
        // when empty), so calling it here is safe even if `[DONE]` was seen.
        if (!doneCalled) {
            await onDone?.();
        }
        logger.debug(`${tag}.stream.done`, { modelId });
    } catch (e) {
        console.error(`[Copilot Provider] ${tag} streaming error:`, e);
        logger.error(`${tag}.stream.error`, {
            modelId,
            error: e instanceof Error ? e.message : String(e),
        });
        throw e;
    } finally {
        onFinally?.();
    }
}
