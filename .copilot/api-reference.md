# AMD TokenFactory API 参考记录

> ⚠️ **遇到 AMD TokenFactory API 集成问题（参数 400、错误解析、能力标记、思考机制等）时，优先查看本文档**，以 curl 实测为基准对比插件请求体差异。
>
> 本文档记录 AMD TokenFactory 平台的 API 实测信息，供扩展开发与调试参考。
> 最后更新：2026-10-21（全部为 curl / Node fetch 实测结果）

---

## 1. 相关地址

| 项目 | 地址 |
|------|------|
| TokenFactory 页面（获取 API Key / 查看实时容量） | <https://developer.amd.com.cn/radeon/tokenfactory> |
| API 基础地址 | `https://developer.amd.com.cn/radeon/api/v1` |

---

## 2. 认证

- **Bearer API Key**：`Authorization: Bearer rc-...`，仅此一种。
- **无 cookie / 无 CSRF / 无余额概念**（免费端点）。
- 无效 key 统一返回 **401 `{"detail":"Invalid bearer token"}`**。

---

## 3. 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/models` | `GET` | 模型列表（**需鉴权**；响应为 `{"data":[...]}` 包装） |
| `/chat/completions` | `POST` | OpenAI 兼容对话（SSE 流式） |
| `/messages` | `POST` | Anthropic 兼容对话（SSE 流式，需 `anthropic-version` 头） |

> **不支持** `/responses`（OpenAI Responses 协议未实现）。

---

## 4. `/models` 响应结构（实测 2026-10-21：`{"data":[...]}` 包装）

```jsonc
{ "data": [
  {
    "id": "Qwen3.8-27B",
    "name": "Qwen3.8-27B",
    "description": "Dynamic sglang-router service managed by Model Ops",
    "family": "custom",
    "architecture": {
      "input_modalities": ["text", "image"],   // ← vision 判定依据
      "output_modalities": ["text"],
      "tokenizer": "GPT"
    },
    "providers": [{
      "providerId": "self-dploy",
      "streaming": true,
      "vision": true,           // ← 与 input_modalities 一致
      "tools": true,
      "reasoning": true,        // ← 思考能力（模型固有）
      "parallelToolCalls": false,
      "stability": "experimental",
      "ocr": false
    }],
    "context_length": 262144,   // ← 上下文窗口
    "supported_parameters": ["temperature", "max_tokens", "top_p", "stream", "response_format", "tools", "tool_choice"],
    "stability": "experimental"
  }
] }
```

插件解析要点（`src/models/apiModelList.ts` → `normalizeModelEntry`）：`vision` = `input_modalities` 含 `image` 或 `providers[0].vision`；`tools` = `supported_parameters` 含 `tools` 或 `providers[0].tools`；`reasoning` = `providers[0].reasoning`。非聊天端点直接跳过：`output_modalities` 不含 `text` 或 `context_length <= 0`（如 OCR / decision / audio 服务）不进入模型列表。

> ⚠️ `supported_parameters` **不含 `reasoning_effort`**，但 `providers[0].reasoning=true` 表示模型支持思考——思考能力以 `providers[0].reasoning` 为准。

### 实测模型清单（2026-10-21：`/models` 返回 16 条，其中 11 个 chat 模型）

| 模型 | context_length | vision | tools | reasoning | 备注 |
|------|---------------|--------|-------|-----------|------|
| `DeepSeek-V4.1-Flash` | 1,048,576 | ✅ | ✅ | ✅ | 实测 rt=0（不产思考） |
| `DeepSeek-V4-Flash` | 1,048,576 | ❌ | ✅ | ✅ | 实测 rt=0（不产思考） |
| `DeepSeek-V4-Flash-Vision-Exp` | 1,048,576 | ✅ | ✅ | ✅ | **2026-10-23 退役** |
| `Gemma-4-31B-IT` | 262,144 | ✅ | ✅ | ✅ | |
| `GLM-5.3-Flash` | 262,144 | ❌ | ✅ | ✅ | |
| `MiMo-V2.6-Flash` | 1,048,576 | ✅ | ✅ | ✅ | |
| `MiniCPM5-2B` | 131,072 | ❌ | ✅ | ✅ | |
| `MiniCPM-V-4.7-1B` | 262,144 | ✅ | ✅ | ✅ | |
| `MiniCPM-V-4.7-35B-A3B` | 262,144 | ✅ | ✅ | ✅ | |
| `Qwen3.8-27B` | 262,144 | ✅ | ✅ | ✅ | 实测 rt≈150-800（恒思考） |
| `Qwen3.8-Flash-Next` | 262,144 | ✅ | ✅ | ✅ | 实测 rt≈120+（恒思考） |

**非 chat 端点**（`output_modalities` 非 `text` 或 `context_length=0`，插件过滤不显示）：

| 模型 | output_modalities | 说明 |
|------|-------------------|------|
| `Clef` | `decision` | Cloudflare 27B 决策模型 |
| `d3` | `decision` | vLLM-SR 27B 决策模型 |
| `d3-flash` | `decision` | vLLM-SR 9B 决策模型 |
| `MinerU2.5-Pro` | `ocr` | OCR 专用 |
| `OmniVoice` | `audio` | TTS 专用 |

全部由 sglang/vllm-router 动态路由（"Dynamic router service managed by Model Ops"），模型清单可能随平台调整——插件以内置清单兜底 + `/models` 自动发现。

> ⚠️ `/models` **必须携带有效 Bearer key**（无 key / 假 key 均 401）。key 被插件标记为持久化不可用（`available=false`）时，`getPrimaryApiKey()` 返回空 → `/models` 完全不再尝试 → picker 落到内置兜底清单。

---

## 5. `/chat/completions` 行为（实测 2026-10-21）

- 请求体为标准 OpenAI Chat Completions 格式；SSE 流式 `data: {...}` 行 + `data: [DONE]` 收尾。
- **思考内容在 `delta.reasoning` 字段**（字符串，逐块输出）；`delta.reasoning_content` **恒为 `null`**（保留兼容）。
- 非流式响应：`choices[0].message.reasoning`（字符串）；`message.reasoning_content` 恒为 `null`。
- usage 含 `reasoning_tokens`（思考 token 数，可作思考是否发生的判据）。
- 支持参数（以 `supported_parameters` 为准）：`temperature`、`max_tokens`、`top_p`、`stream`、`response_format`、`tools`、`tool_choice`。

### 5.1 ⭐ 思考（深度思考）机制 —— **与标准 OpenAI/DeepSeek 不同**

| 维度 | 标准 OpenAI/DeepSeek | AMD TokenFactory |
|------|---------------------|------------------|
| 开关参数 | `thinking: {type: enabled/disabled}` | ❌ **不支持** → 400 `unsupported_parameter` |
| 深度控制 | `reasoning_effort` | ✅ `reasoning_effort`：`none`/`low`/`medium`/`high`（`max`/`minimal` 也接受） |
| 思考内容字段 | `reasoning_content` | ✅ **`reasoning`**（`reasoning_content` 恒为 `null`） |
| 是否可关 | 可关 | ❌ **模型固有**：Qwen3.8 系列恒思考、DeepSeek-V4 系列恒不思考 |

**400 报错原文**（发 `thinking` 时）：
```json
{"error":{"message":"\"thinking\" is not supported on /v1/chat/completions and was not applied. Use \"reasoning_effort\" (or \"reasoning.effort\") to control thinking.","type":"invalid_request_error","param":"thinking","code":"unsupported_parameter"}}
```

**实测 `reasoning_effort` 对 Qwen3.8-27B 的影响**（同一难题，非确定性）：

| reasoning_effort | reasoning_tokens | reasoning 长度 |
|------------------|------------------|----------------|
| `none` | 91 | 248 |
| `low` | 268 | 810 |
| `medium` | 275 | 904 |
| `high` | 316 | 1012 |

> ⚠️ 思考深度**非确定性**：同参数重复请求 rt 波动明显（实测 `none` 三次 = 461/797/531，`high` 三次 = 547/1195/483），且可能受平台负载影响（偶发 `high` 返回 rt=0）。

**插件实现**：`OpenaiApi.prepareRequestBody` / `AnthropicApi.prepareRequestBody` **只发 `reasoning_effort`，绝不发 `thinking`**。用户选「禁用思考」→ 发 `reasoning_effort: "none"`。

---

## 5.5 `/messages`（Anthropic 兼容）行为（实测 2026-10-21）

- 需 `anthropic-version: 2023-06-01` 头。
- **`thinking` 参数行为**（实测）：
  - `thinking: {type: "enabled"}`（**无** `budget_tokens`）→ **200（被忽略）**
  - `thinking: {type: "enabled", budget_tokens: N}` → **400** `invalid_request_error`：
    ```json
    {"type":"error","error":{"type":"invalid_request_error","message":"\"thinking\" is not supported for this model. Remove the \"thinking\" parameter or use a model that supports extended thinking."}}
    ```
  - `thinking: {type: "disabled"}` / `{type: "adaptive"}` → 200（被忽略）
- **不传 `thinking` 时，模型仍会原生返回 `thinking` 内容块**（Qwen3.8 系列 `blocks=[thinking,text]`，thinking 长度可达 1600+）。
- `reasoning_effort` 被接受（200，合法取值 `none`/`low`/`medium`/`high`）。
- 流式事件：`message_start` / `content_block_start(type=thinking|text|tool_use)` / `content_block_delta(thinking_delta|text_delta|input_json_delta)` / `message_stop`。

---

## 6. 错误格式（⭐ 关键差异：FastAPI 风格，多种形态并存）

| 场景 | HTTP | 响应体 |
|------|------|--------|
| 无效 key（/models 与 /chat 均同） | 401 | `{"detail":"Invalid bearer token"}` |
| 并发限流 | 429 | `{"detail":{"error":{"message":"Model API rate limit exceeded; please retry later","type":"rate_limit_error","code":"process_concurrency_rate_limit_exceeded"}}}` |
| 模型级并发打满 | 429 | `{"detail":{"error":{"message":"Model 'X' is at its concurrency limit (N)","type":"rate_limit_error"}}}` |
| 不支持的参数（如 `thinking`） | 400 | `{"error":{"message":"...","type":"invalid_request_error","param":"thinking","code":"unsupported_parameter"}}` |
| 请求体 JSON 损坏 | 400 | `{"error":{"message":"Malformed JSON in request body","type":"invalid_request_error","param":null,"code":null}}` |

**限流特征**：错误码 `process_concurrency_rate_limit_exceeded`（进程并发限制）——免费端点多用户共享，**429 属常态**，这正是多 key 轮询的必要性；插件已把 429 归为瞬态错误（冷却 + 整轮重试）。另有模型级限流：`model_concurrency_rate_limit_exceeded`，报错文本含该模型并发上限（如 "at its concurrency limit (16)"）。

**插件错误分类**（`src/keys/config.ts` → `DEFAULT_ERROR_RULES`）：

| statusCode | action | 说明 |
|-----------|--------|------|
| 401 | `rotatePersist` | 无效 key → 持久化不可用 |
| 402 | `rotatePersist` | 余额不足 → 持久化不可用 |
| 429 | `rotateCooldown` | 限流 → 内存冷却 |
| 502/503/504 | `rotateCooldown` | 网关/繁忙 → 内存冷却 |
| 500 | `retrySameKey` | 平台内部错误 → 不换 key，退避重试 |

---

## 6.5 门户实时容量（2026-10-21）

TokenFactory 门户页（/radeon/tokenfactory）展示每模型 **Live capacity**（Idle/Busy/At capacity + 百分比），数据源为门户内部接口：

| 端点 | 返回 | 备注 |
|------|------|------|
| `/radeon/api/tokenfactory/load` | `{"models":{"<API模型ID>":{"state":"full\|busy\|idle","label":"At capacity\|Busy\|Idle","utilization":100.0}},"scope":"fleet"}` | key 即 /v1 的模型 ID |

**❌ 插件内纯调用不可行**：该路径有 **TLS 客户端指纹级 WAF**——浏览器同源 fetch 200 秒回；curl/Node(undici) 带 Chrome 全套请求头仍全部超时。对照同域 `/v1/models` 裸 curl 0.36s 200——WAF 仅针对门户路径，公开 API 不受影响。负载指示器方案放弃；如需负载信号只能从实际请求的 `model_concurrency_rate_limit_exceeded` 429 被动推断。

**门户展示名 ≠ API ID**：门户卡片 `DeepSeek-V4-Flash-0731` 的后台模型 ID 就是 `DeepSeek-V4-Flash`；`DeepSeek-V4.1-Flash-1017` 对应 `DeepSeek-V4.1-Flash`。带日期后缀的 ID 直接调用会 404。

---

## 7. 代码中的引用位置

| 文件 | 常量 / 位置 |
|------|-------------|
| `src/platform/platformConfig.ts` | `API_BASE_URL`（chat/completions、/models 拼接） |
| `src/models/apiModelList.ts` | `/models` 拉取与解析 |
| `src/keys/availability.ts` | `testKeyAvailability()`（key 检测直接打 chat/completions） |
| `src/api/openai/openaiApi.ts` | `prepareRequestBody`（只发 reasoning_effort） |
| `src/api/anthropic/anthropicApi.ts` | `prepareRequestBody`（同上） |

---

## 8. 调试方法备忘（PowerShell）

```powershell
# 请求体含中文/复杂 JSON 时，-d 内联转义在 pwsh 下不可靠（会 400 Malformed JSON），
# 必须写临时文件再 --data-binary：
Set-Content -Path "$env:TEMP\amd_test.json" -Value '{"model":"...","messages":[...]}' -Encoding UTF8 -NoNewline
curl.exe -sS -m 90 -w "`nHTTP_CODE:%{http_code}`n" "https://developer.amd.com.cn/radeon/api/v1/chat/completions" `
  -H "Authorization: Bearer rc-..." -H "Content-Type: application/json" --data-binary "@$env:TEMP\amd_test.json"
```

> ⚠️ **首字延迟可能长达 2 分钟**（尤其思考模型）→ 所有请求超时至少设 300000ms（5 分钟）。
