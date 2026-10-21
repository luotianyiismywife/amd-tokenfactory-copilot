/**
 * httpClient.ts — 双协议 `createMessage`（Git 提交生成）共用的 HTTP 请求样板。
 *
 * 原先 openai / anthropic 两个适配器各自重复「fetch + 非 2xx 抛错」
 * 约 20 行。此模块统一为 `postJson`，错误消息格式一致（含状态码、状态文本、
 * 响应体与 URL），便于排查。
 */

/**
 * 发送 JSON POST 请求并校验响应状态。
 *
 * @param url 完整请求 URL。
 * @param headers 请求头（由 `CommonApi.prepareHeaders` 生成）。
 * @param body 请求体（内部 `JSON.stringify`）。
 * @param signal 取消信号。
 * @param errorPrefix 错误消息前缀（如 `"API error"` / `"Anthropic API request failed"`）。
 * @returns 原始 `Response`（调用方自行读取 body / json）。
 * @throws 非 2xx 时抛出含状态码、状态文本、响应体与 URL 的错误。
 */
export async function postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal | undefined,
    errorPrefix: string
): Promise<Response> {
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `${errorPrefix}: [${response.status}] ${response.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
        );
    }

    return response;
}
