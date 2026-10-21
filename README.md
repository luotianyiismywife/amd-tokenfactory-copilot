# AMD TokenFactory Provider for Copilot

[English](#english) | [中文](#中文)

<a id="english"></a>

## English

A VS Code extension that integrates the **AMD TokenFactory** (Radeon AI Developer, free endpoint) models into **GitHub Copilot Chat**.

Architecture based on [any2copilot](https://github.com/luotianyiismywife/any2copilot) (AGPL-3.0), which itself is based on [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (MIT) and [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) (MIT).

### Features

| Capability | Description |
|------------|-------------|
| **Chat model provider** | Implements `LanguageModelChatProvider`, registers as the `amdtokenfactory` vendor |
| **Two API protocols** | OpenAI-compatible (`/chat/completions`) + Anthropic (`/v1/messages`) — switchable per model or forced via a setting. AMD does **not** support the OpenAI Responses protocol |
| **Multi API key management** | Encrypted SecretStorage store, three modes (`sticky` / `rotation` / `single`), passive failure detection + rotation, transient whole-round retry, manual availability check |
| **Cloud sync (GitHub Gist)** | Sync key/label pairs across machines via VS Code's built-in GitHub sign-in (no PAT). Manual push/pull, startup auto-pull, and optional debounced auto-push |
| **Auto model discovery** | Fetch the live model list from `/v1/models`, hide non-chat endpoints, discover new ones |
| **Streaming + thinking** | SSE streaming, reasoning content (the **`reasoning`** field), XML ` thinking` block parsing |
| **Tool calling** | VS Code `LanguageModelToolCallPart` support |
| **Vision proxy (`ask_image`)** | Text-only models can ask a vision model about images, with cross-turn history persistence |
| **Token counting** | `o200k_base` tiktoken, native token indicator |
| **Git commit messages** | Conventional-commit generation from the SCM panel |
| **i18n** | Simplified Chinese + English |

> **No balance / usage module**: AMD gives each account a fixed **$1/day** quota (resets at 00:00 UTC+8). The platform is meant for **multi-account rotation** (spreading the daily quota across keys), so balance tracking is meaningless — the extension does **not** implement balance queries, plan usage, or a usage status bar. Quota exhaustion surfaces as HTTP 402/429 and triggers key rotation.

### Thinking (deep reasoning) — different from standard OpenAI/DeepSeek

| Aspect | Standard OpenAI/DeepSeek | AMD TokenFactory |
|--------|--------------------------|------------------|
| Toggle parameter | `thinking: {type: enabled/disabled}` | ❌ **Not supported** (400) |
| Depth control | `reasoning_effort` | ✅ `reasoning_effort`: `none`/`low`/`medium`/`high` |
| Reasoning field (OpenAI) | `reasoning_content` | ✅ **`reasoning`** (`reasoning_content` is always `null`) |
| Reasoning field (Anthropic) | `thinking` block | ✅ native `thinking` content block |
| Can it be turned off? | Yes | ❌ **Model-intrinsic**: Qwen3.8 always thinks, DeepSeek-V4 never does |

### Get an API Key

Sign in at <https://developer.amd.com.cn/radeon/tokenfactory> and create an API key (format `rc-...`).

### Usage

1. Install the extension and run the command `AMD TokenFactory: Manage API Keys` (or click the provider in the Copilot Chat model picker — it opens the key manager).
2. Add at least one key.
3. Open the Copilot Chat model picker and choose a model under the **AMD TokenFactory** vendor.

### Extension Settings

| Setting | Default | Description |
|---|---|---|
| `amdTokenFactory.apiMode` | `auto` | `auto` / `openai` / `anthropic` |
| `amdTokenFactory.apiKeyMode` | `sticky` | `sticky` (pin one key) / `rotation` (next key per request) / `single` (current key only) |
| `amdTokenFactory.singleKeyFallback` | `switch` | In `single` mode: `switch` (auto-switch on 402) or `error` |
| `amdTokenFactory.errorRules` | 401/402 → persist; 429/502/503/504 → cooldown; 500 → retrySameKey | Error classification rules (code + message + statusCode + action) |
| `amdTokenFactory.apiKeyExhaustedCooldownMin` | `10` | Cooldown minutes for rate-limited keys |
| `amdTokenFactory.transientRetryTimes` | `3` | Whole-round automatic retries when all keys are cooling down |
| `amdTokenFactory.requestTimeout` | `600000` | Request timeout (ms). First token may take up to 2 minutes |
| `amdTokenFactory.enableAutoModelDiscovery` | `true` | Discover the model list from `/v1/models` |
| `amdTokenFactory.maxInputTokensRatio` | `1.0` | Declared input window ratio (controls Copilot auto-compaction) |
| `amdTokenFactory.temperature` / `amdTokenFactory.top_p` | `1` / `0.5` | Sampling params |
| `amdTokenFactory.modelPreset` / `amdTokenFactory.modelPresets` | `custom` | Temperature/top_p presets |
| `amdTokenFactory.visionProxyModel` | `Qwen3.8-27B` | Vision model used by the `ask_image` proxy |
| `amdTokenFactory.visionMaxRounds` | `5` | Max `ask_image` rounds per request |
| `amdTokenFactory.cloudSyncAutoPull` / `cloudSyncAutoPush` | `true` / `false` | Cloud sync automation |
| `amdTokenFactory.commit*` | — | Git commit message generation settings |
| `amdTokenFactory.retry.*` | enabled / 2 / 1000 | Per-request HTTP-layer retry |

### Build

```bash
npm install
npm run compile    # clean out/ + tsc + build-info + settings check
npm run audit      # 7-item audit
npm run test:offline
npm run build      # package as amd-tokenfactory-copilot-<version>.vsix
```

### License

MIT. Architecture based on [any2copilot](https://github.com/luotianyiismywife/any2copilot) (AGPL-3.0), based on [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (MIT) and [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) (MIT).

---

<a id="中文"></a>

## 中文

把 **AMD TokenFactory**（Radeon AI 开发者平台，免费端点）的模型接入 **GitHub Copilot Chat** 的 VS Code 扩展。

架构基于 [any2copilot](https://github.com/luotianyiismywife/any2copilot)（AGPL-3.0），后者基于 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)（MIT）与 [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot)（MIT）。

### 功能

| 能力 | 说明 |
|------|------|
| **Chat 模型提供商** | 实现 `LanguageModelChatProvider`，注册为 `amdtokenfactory` 厂商 |
| **双协议支持** | OpenAI 兼容（`/chat/completions`）+ Anthropic（`/v1/messages`）——可按模型切换或经设置强制。AMD **不支持** OpenAI Responses 协议 |
| **多 API Key 管理** | SecretStorage 加密存储，三种模式（`sticky` / `rotation` / `single`），被动失效检测 + 轮换、瞬态整轮重试、手动可用性检测 |
| **云同步（GitHub Gist）** | key/备注 二元组跨机器同步，使用 VS Code 内置 GitHub 登录（无需 PAT）。手动推送/拉取 + 启动自动拉取 + 可选自动推送 |
| **自动模型发现** | 从 `/v1/models` 拉取实时模型列表，过滤非 chat 端点，发现新模型 |
| **流式 + 思考** | SSE 流式、推理内容（**`reasoning`** 字段）、XML ` thinking` 块解析 |
| **工具调用** | 支持 VS Code `LanguageModelToolCallPart` |
| **视觉代理（`ask_image`）** | 纯文本模型可向视觉模型提问图片，含跨轮历史持久化 |
| **Token 计数** | `o200k_base` tiktoken，原生 Token 指示器 |
| **Git 提交消息** | 从 SCM 面板生成 Conventional Commit |
| **国际化** | 简体中文 + 英文 |

> **无余额/用量模块**：AMD 每个账号每天固定 **$1 额度**（东八区 0 点刷新）。该平台主要用于**多账号轮询**（多 key 分摊每日额度），余额无记录意义——本扩展**不实现**余额查询、套餐用量、用量状态栏。额度耗尽由 API 返回 402/429 触发 key 轮换。

### 思考（深度思考）—— 与标准 OpenAI/DeepSeek 不同

| 维度 | 标准 OpenAI/DeepSeek | AMD TokenFactory |
|------|---------------------|------------------|
| 开关参数 | `thinking: {type: enabled/disabled}` | ❌ **不支持**（400） |
| 深度控制 | `reasoning_effort` | ✅ `reasoning_effort`：`none`/`low`/`medium`/`high` |
| 思考字段（OpenAI） | `reasoning_content` | ✅ **`reasoning`**（`reasoning_content` 恒为 `null`） |
| 思考字段（Anthropic） | `thinking` 块 | ✅ 原生 `thinking` 内容块 |
| 是否可关 | 可关 | ❌ **模型固有**：Qwen3.8 恒思考、DeepSeek-V4 恒不思考 |

### 获取 API Key

登录 <https://developer.amd.com.cn/radeon/tokenfactory> 创建 API Key（格式 `rc-...`）。

### 使用

1. 安装扩展，运行命令 `AMD TokenFactory: 管理 API Keys`（或在 Copilot Chat 模型选择器中点击该厂商——会打开密钥管理界面）。
2. 添加至少一个 key。
3. 打开 Copilot Chat 模型选择器，选择 **AMD TokenFactory** 厂商下的模型。

### 扩展设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `amdTokenFactory.apiMode` | `auto` | `auto` / `openai` / `anthropic` |
| `amdTokenFactory.apiKeyMode` | `sticky` | `sticky`（固定一个 key）/ `rotation`（每次请求换 key）/ `single`（仅用当前 key） |
| `amdTokenFactory.singleKeyFallback` | `switch` | `single` 模式下：`switch`（402 时自动切换）或 `error` |
| `amdTokenFactory.errorRules` | 401/402 → persist；429/502/503/504 → cooldown；500 → retrySameKey | 错误分类规则（code + message + statusCode + action） |
| `amdTokenFactory.apiKeyExhaustedCooldownMin` | `10` | 限流 key 的冷却分钟数 |
| `amdTokenFactory.transientRetryTimes` | `3` | 全部 key 冷却时的整轮自动重试次数 |
| `amdTokenFactory.requestTimeout` | `600000` | 请求超时（ms）。首字可能长达 2 分钟 |
| `amdTokenFactory.enableAutoModelDiscovery` | `true` | 从 `/v1/models` 自动发现模型 |
| `amdTokenFactory.maxInputTokensRatio` | `1.0` | 声明的输入窗口比例（控制 Copilot 自动压缩） |
| `amdTokenFactory.temperature` / `amdTokenFactory.top_p` | `1` / `0.5` | 采样参数 |
| `amdTokenFactory.modelPreset` / `amdTokenFactory.modelPresets` | `custom` | temperature/top_p 预设 |
| `amdTokenFactory.visionProxyModel` | `Qwen3.8-27B` | `ask_image` 代理使用的视觉模型 |
| `amdTokenFactory.visionMaxRounds` | `5` | 每次请求最多 `ask_image` 轮数 |
| `amdTokenFactory.cloudSyncAutoPull` / `cloudSyncAutoPush` | `true` / `false` | 云同步自动化 |
| `amdTokenFactory.commit*` | — | Git 提交消息生成设置 |
| `amdTokenFactory.retry.*` | enabled / 2 / 1000 | 单请求 HTTP 层重试 |

### 构建

```bash
npm install
npm run compile    # 清理 out/ + tsc + 编译元信息 + 设置项核对
npm run audit      # 7 项审计
npm run test:offline
npm run build      # 打包 amd-tokenfactory-copilot-<version>.vsix
```

### 许可

MIT。架构基于 [any2copilot](https://github.com/luotianyiismywife/any2copilot)（AGPL-3.0），后者基于 [opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot)（MIT）与 [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot)（MIT）。
