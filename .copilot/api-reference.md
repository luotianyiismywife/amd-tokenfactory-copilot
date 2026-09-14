# AMD TokenFactory API 参考记录

> ⚠️ **遇到 AMD TokenFactory API 集成问题（参数 400、错误解析、能力标记等）时，优先查看本文档**，以 curl 实测为基准对比插件请求体差异。
>
> 本文档记录 AMD TokenFactory 平台的 API 实测信息，供扩展开发与调试参考。
> 最后更新：2026-09-06（全部为 curl 实测结果）

---

## 1. 相关地址

| 项目 | 地址 |
|------|------|
| TokenFactory 页面（获取 API Key） | <https://developer.amd.com.cn/radeon/tokenfactory> |
| API 基础地址 | `https://developer.amd.com.cn/radeon/api/v1` |

---

## 2. 认证

- **Bearer API Key**：`Authorization: Bearer rc-...`，仅此一种。
- **无 cookie / 无 CSRF / 无余额概念**（免费端点）——与 TokenRhythm 平台（`tr_session` + `/api/*` 用户中心两套体系）完全不同。
- 无效 key 统一返回 **401 `{"detail":"Invalid bearer token"}`**。

---

## 3. 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/models` | `GET` | 模型列表（**需鉴权**；2026-09-14 实测响应为 `{"data":[...]}` 包装，≤2026-09-06 曾为裸 JSON 数组——解析需兼容两种形态） |
| `/chat/completions` | `POST` | OpenAI 兼容对话（SSE 流式） |

---

## 4. `/models` 响应结构（实测 2026-09-14：响应为 `{"data":[...]}` 包装；≤2026-09-06 曾为裸数组）

```jsonc
{ "data": [
  {
    "id": "DeepSeek-V4-Flash-Vision-Exp",
    "name": "DeepSeek-V4-Flash-Vision-Exp",
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
      "reasoning": true,        // ← 思考能力
      "parallelToolCalls": false,
      "stability": "experimental",
      "ocr": false
    }],
    "context_length": 1048576,  // ← 上下文窗口
    "supported_parameters": ["temperature", "max_tokens", "top_p", "stream", "response_format", "tools", "tool_choice"],
    "stability": "experimental"
  }
] }
```

插件解析要点（`src/apiModelList.ts`）：`vision` = `input_modalities` 含 `image` 或 `providers[0].vision`；`tools` = `supported_parameters` 含 `tools` 或 `providers[0].tools`；`reasoning` = `providers[0].reasoning`。非聊天端点直接跳过：`output_modalities` 不含 `text` 或 `context_length <= 0`（如 OCR 服务）不进入模型列表。

### 实测模型清单（2026-09-14：6 个，全部 `stability: experimental`）

| 模型 | context_length | vision | tools | reasoning | 备注 |
|------|---------------|--------|-------|-----------|------|
| `DeepSeek-V4-Flash` | 1,048,576 | ❌ | ✅ | ✅ | 已开始计费（prompt 1.4e-7 / completion 2.8e-7） |
| `DeepSeek-V4-Flash-Vision-Exp` | 1,048,576 | ✅ | ✅ | ✅ | |
| `Qwen3.8-Flash-Next` | 262,144 | ✅ | ✅ | ✅ | |
| `MiniCPM5-2B` | 131,072 | ❌ | ✅ | ✅ | `MiniCPM5-1B` 已下架 |
| `Qwen3.8-27B` | 131,072 | ❌ | ✅ | ✅ | `free: true`，pricing 全 0 |
| `MinerU2.5-Pro` | 0 | ❌ | ❌ | ❌ | OCR 专用（`streaming: false`、无 tools），插件过滤不显示 |

全部由 sglang/vllm-router 动态路由（"Dynamic router service managed by Model Ops"），模型清单可能随平台调整——插件以内置清单兜底 + `/models` 自动发现。响应新增字段：`aliases` / `pricing` / `free` / `output`（暂未消费）。

---

## 5. `/chat/completions` 行为（实测 2026-09-06）

- 请求体为标准 OpenAI Chat Completions 格式；SSE 流式 `data: {...}` 行 + `event: done` + `data: [DONE]` 收尾（每行还带 `id: N` 注释行，解析无影响）。
- delta 含 `reasoning_content` 字段（**思考内容逐块输出；非思考 chunk 里为 `null`**——解析时注意判空，`content` 同理）。
- 收尾有**两个** usage chunk：`choices:[]` 携带 `usage` 的 chunk + 一个汇总 chunk（含 `cost`/`metadata.log_id`），随后才是 `[DONE]`。
- **不要发 `stream_options: {include_usage: true}`**——usage 本来就自动附加，实测无必要。
- 支持参数（以 `supported_parameters` 为准）：`temperature`、`max_tokens`、`top_p`、`stream`、`response_format`、`tools`、`tool_choice`。

---

## 6. 错误格式（⭐ 关键差异：FastAPI 风格，三种形态并存）

| 场景 | HTTP | 响应体 |
|------|------|--------|
| 无效 key（/models 与 /chat 均同） | 401 | `{"detail":"Invalid bearer token"}` |
| 并发限流 | 429 | `{"detail":{"error":{"message":"Model API rate limit exceeded; please retry later","type":"rate_limit_error","code":"process_concurrency_rate_limit_exceeded"}}}` |
| 请求体 JSON 损坏 | 400 | `{"error":{"message":"Malformed JSON in request body","type":"invalid_request_error","param":null,"code":null}}` |

插件解析（`src/utils.ts` `extractApiErrorMessage`）按 `error.message` → `detail`(字符串) → `detail.error.message` → `message` 顺序提取，兜底截断原文前 500 字符。

**限流特征**：错误码 `process_concurrency_rate_limit_exceeded`（进程并发限制）——免费端点多用户共享，**429 属常态**，这正是多 key 轮询的必要性；插件已把 429 归为瞬态错误（冷却 + 整轮重试）。另有模型级限流：`model_concurrency_rate_limit_exceeded`，报错文本含该模型并发上限（如 "at its concurrency limit (48)"），表示该模型机房并发打满（2026-09-14 DeepSeek-V4-Flash 实测）。

---

## 6.5 门户内部接口侦察（2026-09-14，底栏负载指示器调研结论）

TokenFactory 门户页（/radeon/tokenfactory）展示每模型 **Live capacity**（Idle/Busy/At capacity + 百分比），数据源为门户内部接口：

| 端点 | 返回 | 备注 |
|------|------|------|
| `/radeon/api/tokenfactory/load` | `{"models":{"<API模型ID>":{"state":"full\|busy\|idle","label":"At capacity\|Busy\|Idle","utilization":100.0}},"scope":"fleet"}` | key 即 /v1 的模型 ID，无鉴权字段 |
| `/radeon/api/tokenfactory/model?id=model_gateway%3A<名>` | 模型完整详情（display_config/pricing/access 等） | |

**❌ 插件内纯调用不可行**：该路径有 **TLS 客户端指纹级 WAF**——浏览器同源 fetch 200 秒回；curl/Node(undici) 带 Chrome 全套请求头（UA/Origin/Referer/Sec-Fetch-*/sec-ch-ua，h1.1）仍全部超时。对照同域 `/v1/models` 裸 curl 0.36s 200——WAF 仅针对门户路径，公开 API 不受影响。负载指示器方案放弃；如需负载信号只能从实际请求的 `model_concurrency_rate_limit_exceeded` 429 被动推断。

**门户与 /models 清单不同步**（同日实测）：门户"Public Free"区 7 个模型，`/models` 只返回 6 个。差异：
- `DeepSeek-V4.1-Flash`：门户在列（ctx 1M、vision/tools/reasoning 全支持、enabled=true），**实际可调用**（实测 200/2.6s）但 `/models` 不返回——门户先行上架、清单接口滞后。**已加白名单特判**（`src/provideModel.ts` `WHITELISTED_MODELS`）：仅在 `/models` 未返回时注入选择器；将来 `/models` 收录后由 API 元数据接管，白名单自动让位
- 门户卡片 `DeepSeek-V4-Flash-0731` 的**后台模型 ID 就是 `DeepSeek-V4-Flash`**（门户展示名 ≠ API ID）
- 门户 "Dedicated Model APIs" 区（MiniCPM-v46 等）为专用部署实例，与共享端点无关

---

## 7. 代码中的引用位置

| 文件 | 常量 / 位置 |
|------|-------------|
| `package.json` | `amdTokenFactory.baseUrl` 默认值 |
| `src/provider.ts` | `getBaseUrl()`（chat/completions 拼接） |
| `src/apiModelList.ts` | baseUrl 参数传入（/models 拼接） |
| `src/extension.ts` | `testKeyAvailability()`（key 检测直接打 chat/completions） |

---

## 8. 调试方法备忘（PowerShell）

```powershell
# 请求体含中文/复杂 JSON 时，-d 内联转义在 pwsh 下不可靠（会 400 Malformed JSON），
# 必须写临时文件再 --data-binary：
Set-Content -Path "$env:TEMP\amd_test.json" -Value '{"model":"...","messages":[...]}' -Encoding UTF8 -NoNewline
curl.exe -sS -m 90 -w "`nHTTP_CODE:%{http_code}`n" "https://developer.amd.com.cn/radeon/api/v1/chat/completions" `
  -H "Authorization: Bearer rc-..." -H "Content-Type: application/json" --data-binary "@$env:TEMP\amd_test.json"
```
