/**
 * 双协议完整测试脚本（AMD TokenFactory）
 *
 * 用法:
 *   node test/api-tests.mjs <API_KEY> [openai|anthropic|all]
 *   PROVIDER_API_KEY=<key> node test/api-tests.mjs
 *
 * 模型 ID 可用环境变量覆盖：
 *   PROVIDER_TEST_MODEL          主测试模型（默认 DeepSeek-V4-Flash）
 *   PROVIDER_TEST_THINKING_MODEL 思考/effort 测试模型（默认 DeepSeek-V4-Flash）
 *   PROVIDER_TEST_VISION_MODEL   图片输入测试模型（默认 DeepSeek-V4-Flash-Vision-Exp）
 *
 * ⚠️ AMD TokenFactory 首字延迟可能长达 2 分钟 → 所有请求超时设为 5 分钟。
 */
const API_KEY = process.argv[2] || process.env.PROVIDER_API_KEY;
const filter = process.argv[3] || "all";
if (!API_KEY) {
    console.error("用法: node test/api-tests.mjs <API_KEY> [openai|anthropic|all]（或设置 PROVIDER_API_KEY）");
    process.exit(1);
}

// AMD TokenFactory 在售模型
const TEST_MODEL = process.env.PROVIDER_TEST_MODEL || "DeepSeek-V4-Flash";
const THINKING_MODEL = process.env.PROVIDER_TEST_THINKING_MODEL || "DeepSeek-V4-Flash";
const VISION_MODEL = process.env.PROVIDER_TEST_VISION_MODEL || "DeepSeek-V4-Flash-Vision-Exp";

const BASE = "https://developer.amd.com.cn/radeon/api/v1";
/** 首字可能长达 2 分钟 → 单请求超时 5 分钟。 */
const REQUEST_TIMEOUT_MS = 300_000;
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
    if (cond) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        failures.push(`${name} ${detail}`);
        console.log(`  ❌ ${name} ${detail}`);
    }
}

/** 请求间隔（ms）：AMD 免费端点有进程并发限制，连发请求易触发 429。 */
const REQUEST_GAP_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 发送请求并完整解析：流式返回 SSE 事件数组，非流式返回 JSON body */
async function api(path, body, headers = {}) {
    // 请求间隔：避免连发触发 429（process_concurrency_rate_limit_exceeded）。
    await sleep(REQUEST_GAP_MS);
    const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed = null;
    if (body.stream === true) {
        // SSE 流式
        parsed = text.split("\n")
            .filter(l => l.startsWith("data:") && l.trim() !== "data: [DONE]")
            .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
            .filter(Boolean);
    } else {
        // 非流式 JSON
        try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    return { ok: res.ok, status: res.status, body: parsed, raw: text.substring(0, 500) };
}

const TOOLS = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "Get weather of a city",
            parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
        },
    },
];

/**
 * Responses 端点要求扁平工具格式（OpenAI 嵌套 function 格式不被接受）:
 *   { type: "function", name, description, parameters }
 * 这是平台 Responses 端点与 OpenAI 端点的差异之一。
 */
/**
 * 生成一个指定尺寸的纯色 PNG base64（浏览器环境下无效，Node 下返回 null）。
 * Node 环境下使用硬编码的 100x100 红色 PNG。
 */
function makePng(width, height) {
    // 1x1 红色 PNG（仅用于验证最小可用性；部分模型要求 >=10x10）
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
}

async function testOpenAI() {
    console.log("\n=== OpenAI 协议 (/chat/completions) ===");

    console.log("--- 1. 非流式对话 ---");
    {
        const r = await api("/chat/completions", { model: TEST_MODEL, messages: [{ role: "user", content: "回复OK" }], stream: false });
        check("HTTP 200", r.ok, `s=${r.status} ${r.raw}`);
        check("content 存在", !!r.body?.choices?.[0]?.message?.content);
        check("usage 存在", !!r.body?.usage);
        // AMD 思考内容在 `reasoning` 字段（`reasoning_content` 恒为 null）
        check("reasoning 字段存在", "reasoning" in (r.body?.choices?.[0]?.message ?? {}));
    }

    console.log("--- 2. 流式对话 ---");
    {
        const r = await api("/chat/completions", { model: TEST_MODEL, messages: [{ role: "user", content: "用一句话介绍你自己" }], stream: true, stream_options: { include_usage: true } });
        check("流式文本增量", r.body.some(e => e.choices?.[0]?.delta?.content));
        // AMD 流式思考在 `delta.reasoning`（`delta.reasoning_content` 恒为 null）
        check("流式推理增量", r.body.some(e => e.choices?.[0]?.delta?.reasoning));
        check("流式 usage chunk", r.body.some(e => e.usage));
    }

    console.log("--- 3. 流式工具调用 ---");
    {
        const r = await api("/chat/completions", { model: TEST_MODEL, messages: [{ role: "user", content: "请使用 get_weather 工具查询北京的天气" }], stream: true, tools: TOOLS, tool_choice: "auto" });
        const tcs = r.body.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []);
        check("收到 tool_calls", tcs.length > 0, `n=${tcs.length}`);
        const name = tcs.find(t => t.function?.name)?.function?.name;
        check("工具名正确", name === "get_weather", `n=${name}`);
    }

    console.log("--- 4. 多轮工具回填 ---");
    {
        const r = await api("/chat/completions", {
            model: TEST_MODEL,
            messages: [
                { role: "user", content: "查询北京天气" },
                { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }] },
                { role: "tool", tool_call_id: "call_1", content: "晴天 25度" },
            ],
            stream: false, tools: TOOLS,
        });
        check("多轮回填成功", r.ok && !!r.body?.choices?.[0]?.message?.content, `s=${r.status} ${r.raw}`);
    }

    console.log("--- 5. reasoning_effort 参数（AMD 用 reasoning_effort，不支持 thinking）---");
    {
        // AMD 实测：thinking 参数 → 400；reasoning_effort 被接受（none/low/medium/high）。
        const r0 = await api("/chat/completions", { model: TEST_MODEL, messages: [{ role: "user", content: "回复OK" }], stream: false, thinking: { type: "enabled" } });
        check("thinking 参数被拒绝（400）", !r0.ok && r0.status === 400, `s=${r0.status}`);
        for (const eff of ["none", "low", "medium", "high"]) {
            const r = await api("/chat/completions", { model: TEST_MODEL, messages: [{ role: "user", content: "回复OK" }], stream: false, reasoning_effort: eff });
            check(`reasoning_effort=${eff}`, r.ok, `s=${r.status} ${r.raw}`);
        }
        // 思考内容在 `reasoning` 字段（非 reasoning_content）
        const rq = await api("/chat/completions", { model: THINKING_MODEL, messages: [{ role: "user", content: "一个三位数，各位数字之和是 15，百位比十位大 2，个位是十位的 2 倍。求这个数。一步步推理。" }], stream: false, max_tokens: 8192, reasoning_effort: "high" });
        const msg = rq.body?.choices?.[0]?.message ?? {};
        check(`${THINKING_MODEL} 返回 reasoning 字段`, typeof msg.reasoning === "string" && msg.reasoning.length > 0, `reasoning=${msg.reasoning ? `len=${msg.reasoning.length}` : "absent"}`);
    }
}

async function testAnthropic() {
    console.log("\n=== Anthropic 协议 (/v1/messages) ===");
    const ANTH = { "anthropic-version": "2023-06-01" };

    console.log("--- 6. 非流式对话 ---");
    {
        const r = await api("/messages", { model: TEST_MODEL, max_tokens: 512, messages: [{ role: "user", content: "回复OK" }] }, ANTH);
        check("HTTP 200", r.ok, `s=${r.status} ${r.raw}`);
        check("type=message", r.body?.type === "message");
        check("有文本块", r.body?.content?.some(b => b.type === "text" && b.text));
        check("有 thinking 块", r.body?.content?.some(b => b.type === "thinking"));
        check("usage 存在", !!r.body?.usage);
    }

    console.log("--- 7. 流式对话 ---");
    {
        const r = await api("/messages", { model: TEST_MODEL, max_tokens: 256, stream: true, messages: [{ role: "user", content: "say OK" }] }, ANTH);
        const types = new Set(r.body.map(e => e.type));
        check("message_start", types.has("message_start"));
        check("content_block_delta", types.has("content_block_delta"));
        check("text_delta", r.body.some(e => e.delta?.type === "text_delta"));
        check("thinking_delta", r.body.some(e => e.delta?.type === "thinking_delta"));
        check("message_stop", types.has("message_stop"));
    }

    console.log("--- 8. 流式工具调用 ---");
    {
        const r = await api("/messages", {
            model: TEST_MODEL, max_tokens: 512, stream: true,
            messages: [{ role: "user", content: "必须使用 get_weather 工具查询北京的天气" }],
            tools: [{ name: "get_weather", description: "Get weather of a city", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
            tool_choice: { type: "any" },
        }, ANTH);
        const tu = r.body.find(e => e.content_block?.type === "tool_use");
        check("收到 tool_use 块", !!tu, `n=${tu?.content_block?.name} ${r.raw}`);
        check("input_json_delta", r.body.some(e => e.delta?.type === "input_json_delta"));
    }

    console.log("--- 9. reasoning_effort 参数（AMD 用 reasoning_effort，不支持 thinking）---");
    {
        // AMD 实测：Anthropic 端点 thinking:{type:enabled}（无 budget_tokens）被忽略返回 200；
        // 带 budget_tokens 才 400（"thinking" is not supported for this model）。
        const r0 = await api("/messages", { model: TEST_MODEL, max_tokens: 256, messages: [{ role: "user", content: "回复OK" }], thinking: { type: "enabled", budget_tokens: 4096 } }, ANTH);
        check("thinking+budget_tokens 被拒绝（400）", !r0.ok && r0.status === 400, `s=${r0.status}`);
        for (const eff of ["none", "low", "medium", "high"]) {
            const r = await api("/messages", { model: TEST_MODEL, max_tokens: 256, messages: [{ role: "user", content: "回复OK" }], reasoning_effort: eff }, ANTH);
            check(`reasoning_effort=${eff}`, r.ok, `s=${r.status} ${r.raw}`);
        }
    }

    console.log("--- 9b. temperature/top_p 与 reasoning_effort 组合 ---");
    {
        // AMD 不发送 thinking，temperature/top_p 始终可发。
        const r1 = await api("/messages", { model: TEST_MODEL, max_tokens: 256, messages: [{ role: "user", content: "回复OK" }], reasoning_effort: "high", temperature: 0 }, ANTH);
        check("effort=high + temp → 200", r1.ok, `s=${r1.status} ${r1.raw}`);
        const r2 = await api("/messages", { model: TEST_MODEL, max_tokens: 256, messages: [{ role: "user", content: "回复OK" }], reasoning_effort: "none", temperature: 0, top_p: 1 }, ANTH);
        check("effort=none + temp + top_p → 200", r2.ok, `s=${r2.status} ${r2.raw}`);
    }
}

async function testErrors() {
    console.log("\n=== 公共: 错误处理 ===");

    console.log("--- 16. 无效模型 ID ---");
    {
        const r = await api("/chat/completions", { model: "nonexistent-model-xyz", messages: [{ role: "user", content: "hi" }], stream: false });
        check("无效模型返回 4xx", r.status >= 400 && r.status < 500, `s=${r.status}`);
        // AMD 错误体：{"detail":{"error":{"message":"Model X is not available",...}}}
        check("错误含 message", !!r.body?.error?.message || !!r.body?.message || !!r.body?.detail?.error?.message, r.raw);
    }
}

async function main() {
    console.log(`Provider API 测试 (filter=${filter})`);
    console.log(`测试模型: 主=${TEST_MODEL} 思考=${THINKING_MODEL} 视觉=${VISION_MODEL}`);

    if (filter === "all" || filter === "openai") await testOpenAI();
    if (filter === "all" || filter === "anthropic") await testAnthropic();
    if (filter === "all") await testErrors();

    console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
    if (failures.length) {
        console.log("失败项:");
        failures.forEach(f => console.log(`  - ${f}`));
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("测试执行异常:", e); process.exit(1); });
