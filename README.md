# AMD TokenFactory Provider for Copilot

[English](#english) | [中文](#中文)

<a id="english"></a>

## English

A VS Code extension that integrates the **AMD TokenFactory** (Radeon AI Developer, free endpoint) models into **GitHub Copilot Chat**.

Architecture based on [tokenrhythm-copilot](https://github.com/luotianyiismywife/tokenrhythm-copilot) (AGPL-3.0), which itself is based on [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (MIT) and [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) (MIT).

### Features

Two features only — nothing else:

1. **OpenAI-compatible endpoint** (`https://developer.amd.com.cn/radeon/api/v1`)
   - Standard Chat Completions protocol with SSE streaming
   - Reasoning/thinking content (`reasoning_content`) shown in Copilot's thinking UI
   - Vision input (image_url) for vision-capable models
   - Tool calling passthrough
   - Automatic model discovery from the `/models` endpoint (with a built-in fallback list): prefetched at startup, instantly served from cache, and silently revalidated in the background (changes rebuild the picker automatically)
   - Whitelisted models the `/models` endpoint omits but actually work (e.g. `DeepSeek-V4.1-Flash`) are injected automatically; once listed by the API, fresh metadata takes over
   - Non-chat endpoints (OCR services) are filtered out of the model list
   - Token usage reported to Copilot's native token indicator
2. **Multi-key rotation**
   - Configure any number of `rc-...` API keys; every request picks the next available key (rotation) or sticks to one key until it fails (sticky)
   - Keys failing with rotation errors (401 / 429 / 5xx, configurable status codes and text patterns) are skipped and the request retries with the next key
   - Transient failures (429 / 5xx) cool the key down for a configurable period instead of disabling it permanently, plus a whole-round exponential-backoff retry
   - Key management UI: add / batch import / delete / reset / availability check (masked display)

### Get an API Key

Sign in at <https://developer.amd.com.cn/radeon/tokenfactory> and create an API key (format `rc-...`).

### Usage

1. Install the extension and run the command `AMD TokenFactory: Manage API Keys (multi-key rotation)` (or click the provider in the Copilot Chat model picker — it opens the key manager).
2. Add at least one key.
3. Open the Copilot Chat model picker and choose a model under the **AMD TokenFactory** vendor.

### Extension Settings

| Setting | Default | Description |
|---|---|---|
| `amdTokenFactory.baseUrl` | `https://developer.amd.com.cn/radeon/api/v1` | API base URL |
| `amdTokenFactory.apiKeyMode` | `rotation` | `rotation` (next key per request) or `sticky` (keep current key until it fails) |
| `amdTokenFactory.syncApiKeys` | `true` | Sync the API key store via VS Code Settings Sync (only effective when Settings Sync is on) |
| `amdTokenFactory.apiKeyRotationStatusCodes` | `[401,429,500,502,503,504]` | HTTP status codes that trigger switching to the next key |
| `amdTokenFactory.apiKeyRotationErrorPatterns` | rate limit / concurrency / invalid bearer token … | Error text patterns that trigger switching to the next key |
| `amdTokenFactory.transientRetryStatusCodes` | `[429,500,502,503,504]` | Status codes treated as transient (cooldown + whole-round retry) |
| `amdTokenFactory.exhaustedCooldownMin` | `120` | Cooldown minutes for 429 rate-limited keys (daily-quota style) |
| `amdTokenFactory.otherErrorCooldownMin` | `2` | Cooldown minutes for other transient errors (5xx / unknown); 401 marks unavailable with no cooldown |
| `amdTokenFactory.transientRetryTimes` | `3` | Whole-round automatic retries when all keys are cooling down |
| `amdTokenFactory.requestTimeout` | `300000` | Request timeout (ms) |
| `amdTokenFactory.enableAutoModelDiscovery` | `true` | Discover the model list from `/models` |
| `amdTokenFactory.maxInputTokensRatio` | `1.0` | Declared input window ratio (controls Copilot auto-compaction) |
| `amdTokenFactory.temperature` / `amdTokenFactory.top_p` | `null` | Sampling params (null = not sent) |
| `amdTokenFactory.retry.*` | enabled / 3 / 1000 | Per-request retry (network + retryable status codes) |

### Build

```bash
npm install
npm run compile
npm run build      # package as amd-tokenfactory-copilot-<version>.vsix
```

### License

MIT. Architecture based on [tokenrhythm-copilot](https://github.com/luotianyiismywife/tokenrhythm-copilot) (AGPL-3.0), based on [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (MIT) and [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) (MIT).

---

<a id="中文"></a>

## 中文

把 **AMD TokenFactory**（Radeon AI 开发者平台，免费端点）的模型接入 **GitHub Copilot Chat** 的 VS Code 扩展。

### 功能

只有两个功能，没有别的：

1. **OpenAI 兼容端点**（`https://developer.amd.com.cn/radeon/api/v1`）
   - 标准 Chat Completions 协议 + SSE 流式输出
   - 思考内容（`reasoning_content`）显示在 Copilot 的思考 UI 里
   - 视觉模型支持图片输入（image_url）
   - 工具调用透传
   - 自动从 `/models` 端点发现模型列表（带内置兜底清单）：启动时预热、打开选择器秒开缓存、后台静默刷新（清单变化自动重建选择器）
   - 白名单特判：`/models` 未收录但实测可用的模型（如 `DeepSeek-V4.1-Flash`）自动注入；API 收录后由新鲜元数据接管
   - 非聊天端点（OCR 服务等）自动过滤，不进入模型列表
   - token 用量上报到 Copilot 原生 token 指示器
2. **多 Key 轮询**
   - 配置任意数量的 `rc-...` API Key；每次请求取下一个可用 Key（轮询模式），或固定用一个 Key 直到失效再切换（固定模式）
   - Key 遇到轮换错误（401 / 429 / 5xx，状态码与文本 patterns 可配置）时跳过该 Key 换下一个重试
   - 瞬态故障（429 / 5xx）只做冷却不永久禁用，外加整轮指数退避自动重试
   - Key 管理界面：添加 / 批量导入 / 删除 / 重置失效 / 可用性检测（全部脱敏显示）

### 获取 API Key

在 <https://developer.amd.com.cn/radeon/tokenfactory> 登录并创建 API Key（格式 `rc-...`）。

### 使用

1. 安装扩展，运行命令 `AMD TokenFactory: 管理 API Keys（多 Key 轮询）`（或在 Copilot Chat 模型选择器里点本提供商，会直接打开 Key 管理界面）。
2. 添加至少一个 Key。
3. 打开 Copilot Chat 的模型选择器，选择 **AMD TokenFactory** 下的模型。

### 编译

```bash
npm install
npm run compile
npm run build      # 打包为 amd-tokenfactory-copilot-<version>.vsix
```

### 许可

MIT。架构基于 [tokenrhythm-copilot](https://github.com/luotianyiismywife/tokenrhythm-copilot)（AGPL-3.0），其基于 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)（MIT）与 [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot)（MIT）。
