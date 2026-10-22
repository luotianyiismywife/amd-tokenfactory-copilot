# AMD TokenFactory Copilot Provider — AGENTS.md

> **所有更改必须通过 `npm run compile` / `npx tsc --noEmit` 编译检查无错误通过。**
> **每次更改后，必须同步更新本文档 (`AGENTS.md`) 以反映代码变更。**

---

## 目录

1. [项目详细介绍](#1-项目详细介绍)
2. [详细逻辑架构](#2-详细逻辑架构)
3. [程序文件索引](#3-程序文件索引)
4. [平台对接点](#4-平台对接点)
5. [函数定义大全](#5-函数定义大全)
6. [编译与构建](#6-编译与构建)
7. [开发规范](#7-开发规范)

---

## 1. 项目详细介绍

### 1.1 概述

**AMD TokenFactory Copilot Provider** 是一个 **VS Code 扩展**，把 **AMD TokenFactory（Radeon AI 免费端点）** 接入 GitHub Copilot Chat 作为语言模型提供商。

架构基于 [any2copilot](https://github.com/luotianyiismywife/any2copilot) 脚手架，剥离平台无关的通用层（协议适配器、key 轮换、分词器、视觉代理、云同步），并按 AMD 平台特性裁剪：

- **仅支持两种协议**：OpenAI 兼容（`/chat/completions`）+ Anthropic（`/v1/messages`）。AMD **不支持** OpenAI Responses 协议（脚手架中的 `src/api/responses/` 已移除）。
- **无余额/用量模块**：AMD 每个账号每天固定 **$1 额度**，东八区（UTC+8）0 点刷新，额度耗尽即当日不可用。该平台主要用于**多账号轮询**（多 key 分摊每日额度），余额无记录意义 → 脚手架中的 `balance/` 目录、`ui/statusBar.ts`、`checkUsage` 命令、`credential` 字段**全部移除**。额度耗尽由 API 返回 402/429 触发 key 轮换。

### 1.2 核心能力

| 能力 | 说明 |
|------|------|
| **Chat 模型提供商** | 实现 `LanguageModelChatProvider`，vendor = `amdtokenfactory` |
| **双协议支持** | OpenAI 兼容（`/chat/completions`）+ Anthropic（`/v1/messages`），可按模型切换或经设置强制 |
| **多 API Key 轮询** | SecretStorage 加密存储（`amdTokenFactory.apiKeys`），三种模式：`sticky`（默认，固定一个 key）/ `rotation`（轮询）/ `single`（仅用当前 key）。被动失效检测（`errorRules` 四元组）+ 瞬态整轮重试 + 手动可用性检测 |
| **云同步（GitHub Gist）** | key/备注 二元组跨机器同步，使用 VS Code 内置 GitHub 登录（无需 PAT）。手动推送/拉取 + 启动自动拉取 + 可选自动推送 |
| **自动模型发现** | 从 `/v1/models` 拉取实时模型列表，过滤非 chat 端点，隐藏不可用模型 |
| **流式 + 思考** | SSE 流式、推理内容（**`reasoning` 字段**）、XML ` thinking` 块解析 |
| **工具调用** | 支持 VS Code `LanguageModelToolCallPart` |
| **图片代理（ask_image）** | 非视觉模型可向视觉模型提问图片，含跨轮历史持久化 |
| **Token 计数** | `o200k_base` tiktoken，原生 Token 指示器 |
| **Git 提交消息生成** | 从 SCM 面板生成 Conventional Commit |
| **国际化** | 简体中文 + 英文 |

> **注**：命令 id 前缀为 `amdtokenfactory.`（小写），设置键前缀为 `amdTokenFactory.`（驼峰）。

### 1.3 模型清单

内置模型清单（`src/models/models.ts` 的 `BUILT_IN_MODELS`）与 **2026-10-21 `/v1/models` 实测对齐**（10 个 chat 模型，全部支持工具调用）：

| 模型 ID | 视觉 | 上下文 | 思考 |
|---------|------|--------|------|
| `DeepSeek-V4.1-Flash` | ✅ | 1M | 模型固有（实测 rt=0） |
| `DeepSeek-V4-Flash` | ❌ | 1M | 模型固有（实测 rt=0） |
| `Gemma-4-31B-IT` | ✅ | 256K | 模型固有 |
| `GLM-5.3-Flash` | ❌ | 256K | 模型固有 |
| `MiMo-V2.6-Flash` | ✅ | 1M | 模型固有 |
| `MiniCPM5-2B` | ❌ | 128K | 模型固有 |
| `MiniCPM-V-4.7-1B` | ✅ | 256K | 模型固有 |
| `MiniCPM-V-4.7-35B-A3B` | ✅ | 256K | 模型固有 |
| `Qwen3.8-27B` | ✅ | 256K | 模型固有（实测 rt≈150-800） |
| `Qwen3.8-Flash-Next` | ✅ | 256K | 模型固有 |

> **已退役**：`DeepSeek-V4-Flash-Vision-Exp`（2026-10-23 退役，已从清单移除）。
> **非 chat 端点**（`Clef` / `d3` / `d3-flash` / `MinerU2.5-Pro` / `OmniVoice`）由 `apiModelList.ts` 过滤。

### 1.4 思考（深度思考）机制 —— **与标准 OpenAI/DeepSeek 不同**

| 维度 | 标准 OpenAI/DeepSeek | AMD TokenFactory |
|------|---------------------|------------------|
| 开关参数 | `thinking: {type: enabled/disabled}` | ❌ **不支持**（OpenAI 端点任何形式均 400；Anthropic 端点带 `budget_tokens` 时 400，不带则被忽略） |
| 深度控制 | `reasoning_effort` | ✅ `reasoning_effort`：`none`/`low`/`medium`/`high`（`max`/`minimal` 也接受） |
| 思考内容字段（OpenAI） | `reasoning_content` | ✅ **`reasoning`**（`reasoning_content` 恒为 `null`） |
| 思考内容字段（Anthropic） | `thinking` 块 | ✅ 原生返回 `thinking` 内容块（`blocks=[thinking,text]`） |
| 是否可关 | 可关 | ❌ **模型固有**：Qwen3.8 系列恒思考、DeepSeek-V4 系列恒不思考 |

**实现要点**：
- `OpenaiApi.prepareRequestBody` / `AnthropicApi.prepareRequestBody` **只发 `reasoning_effort`，绝不发 `thinking`**。
- 用户选「禁用思考」→ 发 `reasoning_effort: "none"`（平台接受，不报错）。
- 思考深度**非确定性**（同参数重复 rt 波动），且可能受平台负载影响。

---

## 2. 详细逻辑架构

### 2.1 总体数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VS Code Copilot Chat                         │
│  用户发送消息 → LanguageModelChatProvider                            │
│                    ↓                                                │
│  ChatModelProvider (provider/provider.ts)                           │
│   1. 获取模型配置 (getBuiltInModelConfig / getAutoDiscoveredModelConfig) │
│   2. 应用推理强度 (applyReasoningEffort) + temperature (applyTemperature) │
│   3. 确定 API 模式 (resolveApiMode)                                  │
│   4. 估算输入 token (estimateInputTokens)                            │
│   5. 多 Key 轮换循环 (runKeyRotationLoop)                            │
│   6. 协议分发 (executeApiRequest)                                    │
│      ├─ apiMode="openai"     → OpenaiApi                            │
│      └─ apiMode="anthropic"  → AnthropicApi                         │
│   7. 流式解析 → Progress<LanguageModelResponsePart2>                 │
│      ├─ LanguageModelTextPart     (文本)                             │
│      ├─ LanguageModelThinkingPart (推理过程)                         │
│      └─ LanguageModelToolCallPart (工具调用)                         │
│   8. 图片代理多轮 (handleInterceptedToolCall)                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 扩展激活流程

```
activate(context)
  ├── logger.init()                         ← 创建 LogOutputChannel
  ├── VersionManager.initialize(context)    ← 捕获真实扩展 ID
  ├── TokenizerManager.initialize()         ← 加载 o200k_base.tiktoken
  ├── new ChatModelProvider(context.secrets)
  ├── vscode.lm.registerLanguageModelChatProvider("amdtokenfactory", provider)
  ├── registerCommands(context, provider)   ← 委托 src/commands/registerCommands.ts
  │   ├── onDidChangeConfiguration 监听       ← apiMode / enableAutoModelDiscovery 变化时刷新模型列表
  │   └── 注册命令（manageApiKeys / openSettings / generateGitCommitMessage /
  │       abortGitCommitMessage / syncPush / syncPull）
  ├── syncModelsOnStartup(context)          ← 启动模型同步（每日最多一次）
  ├── autoPullOnStartup(context)            ← 启动云同步自动拉取（静默）
  ├── registerCloudSyncAutoPush(context)    ← 注册 key store 变更监听（去抖自动推送）
  └── 注册 dispose 清理（flushPendingAutoPush + logger.dispose）
```

### 2.3 聊天请求处理流程

```
provideLanguageModelChatResponse(model, messages, options, progress, token)
  ├── 1. 解析模型 ID → getBuiltInModelConfig(model.id)（失败回退 getAutoDiscoveredModelConfig）
  ├── 2. applyReasoningEffort（disabled/enabled/adaptive/high…）
  ├── 2b. applyTemperature（模型预设或自定义）
  ├── 3. resolveApiMode（用户设置优先；auto → openai 兜底）
  ├── 4. estimateInputTokens（API 未返回 usage 时的 fallback）
  ├── 5. 创建请求超时 AbortController + 连接 VS Code 取消令牌
  ├── 6. 创建 undici fetch（自定义 bodyTimeout）
  ├── 7. **多 Key 轮换循环**（runKeyRotationLoop）:
  │       ├── pickNextApiKey(secrets, apiKeyMode)
  │       ├── 用当前 key 构造 requestHeaders → executeApiRequest()
  │       ├── 成功 → break；曾不可用 → 自愈置可用
  │       └── 失败: matchErrorRule(err)（errorRules 四元组）
  │           ├── rotateCooldown → 内存冷却 + 换 key
  │           ├── rotatePersist → 持久化 available=false + 换 key
  │           ├── retrySameKey → 不换 key，退避后重试同一个 key
  │           ├── VisionRoundError → 直接抛出，不轮换
  │           ├── hasEmittedOutput() → 直接抛出，不轮换
  │           └── 全部失败 → 报错；含 rotateCooldown → 清冷却 + 退避 + 重试整轮
  ├── 8. 协议分发（executeApiRequest）:
  │     ├── OpenAI: convertMessages → prepareRequestBody → POST /chat/completions
  │     └── Anthropic: convertMessages → prepareRequestBody → POST /v1/messages
  ├── 9. 图片代理拦截处理（handleInterceptedToolCall，最多 visionMaxRounds 轮）
  └── 10. 错误处理 + finally 清理定时器
```

### 2.4 Thinking/推理内容处理

```
推理内容来源 (OpenAI 模式):
  ├── delta.reasoning          ← AMD 实际字段（字符串，逐块）
  ├── delta.reasoning_content  ← AMD 恒为 null（保留兼容）
  ├── delta.thinking / choice.thinking
  └── reasoning_details[]      ← OpenRouter 格式

处理机制:
  1. bufferThinkingContent(text) → 积累到 _thinkingBuffer
  2. 每 100ms 定时刷新 → LanguageModelThinkingPart
  3. XML think 块 ( thinking...</think>) → processXmlThinkBlocks()
  4. 文本内容出现时 → reportEndThinking()

Anthropic 模式:
  - content_block_start(type=thinking) / content_block_delta(thinking_delta)
  - 由 processAnthropicChunk 解析为 LanguageModelThinkingPart
```

### 2.5 工具调用处理

```
工具调用流 (OpenAI 模式):
  delta.tool_calls[]
    ├── index: 工具调用索引
    ├── id: 调用 ID
    ├── function.name: 函数名
    └── function.arguments: JSON 参数 (可能分片)

处理机制:
  1. _toolCallBuffers Map<key, {id, name, args}>（key = id / index / auto）
  2. _indexToId 把仅带 index 的 args 碎片解析回同 tool_call 的 id 桶
  3. stream 分片拼接 args
  4. tryEmitBufferedToolCall() → **严格 tryParseJSONObject** 校验，仅完整 JSON 参数提前发射；
     空/未完成参数（`arguments:""` 首个 chunk）不发射，发射延迟到 finish 时 flush
  5. flushToolCallBuffers() → finish_reason 时用宽容 parseToolCallArguments 强制发射剩余
  6. adjustReadFileParameters() → 自动扩增 read_file 行数
  ask_image 拦截: 不在 tryEmit/flush 中发出，改为设置 interceptedToolCall
```

> ⚠️ **空参数过早发射坑（2026-10-22 修复）**：`tryEmitBufferedToolCall` 必须用严格
> `tryParseJSONObject`（而非宽容 `parseToolCallArguments`）。宽容解析对空串返回 `{}`
> （truthy），会把 AMD 流式 tool_calls 首个带 name 的空 `arguments:""` chunk 过早发射成
> 空参数工具调用并标 completed，后续 index 分片被 skip、重开桶产出 `unknown_tool`。
> 与 senseaudio `2973b46` 一致（上游 any2copilot 未修，issue #1）。
```

### 2.6 图片代理（ask_image Tool）流程

```
非视觉模型收到含图片的消息:
  ├── 1. convertMessages()：图片替换为文本引用，原图存入 _localImages
  ├── 2. prepareRequestBody()：注入 ask_image 工具定义
  ├── 3. 第一次 API 请求
  ├── 4. 流式处理拦截 ask_image → interceptedToolCall
  └── 5. handleInterceptedToolCall() 循环（最多 visionMaxRounds 次，夹取 [1,20]）
         ├── 递归守卫：visionProxyModel 指向非视觉模型 → 提示并返回
         ├── 调用视觉模型（流式转发到 thinking 块）
         ├── 输出跨轮视觉历史 DataPart
         ├── 构建 assistant tool_call + tool result 消息并再次请求
         └── 轮次失败 → VisionRoundError（轮换循环直接抛出，不换 key）
```

### 2.7 Git 提交消息生成流程

```
generateCommitMsg(secrets, scm?)
  ├── 检测 Git 扩展和仓库
  ├── 获取 Git Diff (gitUtils.getGitDiff)
  ├── 多仓库处理（0/1/多仓库分别处理）
  ├── 构建 Prompt（系统提示词 + 最近提交风格 + 语言检测 + 用户输入 + diff）
  ├── 调用 API（多 key 轮换循环）
  └── 清理: 移除 ``` 标记和  thinking 标签
```

---

## 3. 程序文件索引

### 3.1 目录结构

```
src/
├── extension.ts                          # 扩展入口（仅编排）
├── platform/
│   └── platformConfig.ts                 # ★ 平台配置单一事实来源
├── api/                                  # 协议适配层
│   ├── commonApi.ts                      # API 抽象基类
│   ├── sse.ts                            # 共享 SSE 流解析
│   ├── httpClient.ts                     # 共享 HTTP 请求样板（postJson）
│   ├── openai/
│   │   ├── openaiApi.ts                  # OpenAI 兼容 API 实现
│   │   └── openaiTypes.ts                # OpenAI 类型定义
│   └── anthropic/
│       ├── anthropicApi.ts               # Anthropic API 实现
│       └── anthropicTypes.ts             # Anthropic 类型定义
├── provider/                             # Chat Provider 实现
│   ├── provider.ts                       # ChatModelProvider（VS Code 接口 + 请求编排）
│   ├── requestOptions.ts                 # 推理强度 / temperature / apiMode 决策
│   ├── rotation.ts                       # 多 key 轮换循环（瞬态整轮重试）
│   ├── apiDispatch.ts                    # 双协议分发与流式处理
│   ├── visionRounds.ts                   # ask_image 图片代理多轮
│   └── errors.ts                         # 错误文案、瞬态重试、原生 token 指示器、零正文检测
├── keys/                                 # 多 API Key 管理
│   ├── keyManager.ts                     # barrel（统一导出）
│   ├── types.ts                          # ApiKeyEntry / ApiKeyStore / ApiKeyMode / SingleKeyFallback
│   ├── config.ts                         # 模式、errorRules、冷却与重试次数配置
│   ├── state.ts                          # 模块级可变状态
│   ├── store.ts                          # SecretStorage 读写、旧版单 key 迁移、增删改
│   ├── selection.ts                      # 主 key 获取、轮询/粘性选择、single fallback 判定
│   ├── health.ts                         # 瞬态冷却、轮换错误判定、失效原因、状态更新
│   ├── availability.ts                   # key 可用性手动检测（最小真实聊天请求）
│   └── mask.ts                           # 脱敏显示辅助
├── models/                               # 模型定义与发现
│   ├── models.ts                         # 内置模型定义清单
│   ├── modelsDev.ts                      # models.dev 元数据拉取与查询
│   ├── apiModelList.ts                   # API 模型列表获取（/v1/models）
│   ├── visionModels.ts                   # 视觉能力判定
│   ├── modelSync.ts                      # 启动模型同步（每日一次，一行日志）
│   └── provideModel.ts                   # 模型信息提供函数（含自动发现）
├── commands/                             # 命令与 QuickPick UI
│   ├── registerCommands.ts               # 全部命令注册 + 配置变更监听
│   ├── apiKeyManagerUi.ts                # manageApiKeys 主入口
│   ├── apiKeyDisplay.ts                  # key 展示辅助
│   └── apiKeyFlows.ts                    # key 管理交互流程
├── core/                                 # 基础设施
│   ├── logger.ts                         # 日志系统
│   ├── localize.ts                       # 国际化/本地化
│   ├── types.ts                          # TypeScript 类型定义
│   ├── utils.ts                          # 通用工具函数
│   └── versionManager.ts                 # 版本信息管理
├── cloud/
│   ├── cloudSync.ts                      # 云同步（GitHub Gist）
│   └── syncPayload.ts                    # 纯函数：Gist payload 对比
├── gitCommit/
│   ├── commitMessageGenerator.ts         # Git 提交消息生成
│   └── gitUtils.ts                       # Git 工具函数
├── tokenizer/
│   ├── tokenizerManager.ts               # Tokenizer 管理 (o200k_base)
│   ├── provideToken.ts                   # Token 计数函数 + estimateInputTokens
│   └── imageUtils.ts                     # 图片尺寸解析
├── vision/
│   ├── types.ts                          # Vision proxy 类型定义
│   ├── historyCodec.ts                   # 跨轮视觉历史编解码
│   ├── historyPart.ts                    # 跨轮视觉历史 DataPart 创建/解析
│   └── imageProxy.ts                     # 图片代理核心 (ask_image)
└── typings/                              # VS Code proposed API 类型声明（仅编译期）

resources/walkthrough/                    # 安装欢迎页文档
scripts/build/                            # 构建（clean / build-info / package-vsix / copy-tokenizer）
scripts/dev/                              # 开发调试（check-new-models / check-settings / port / audit-all）
test/                                     # 测试脚本（运行前需 npm run compile）
docs/                                     # 设计文档
.copilot/                                 # api-reference.md（平台 API 实测参考）+ build-log.md
```

### 3.2 文件详细说明

| 文件 | 聊天请求处理流程 | 备注 |
|------|------|------|
| `extension.ts` | 扩展激活/停用。**仅编排** | 仅编排 |
| `platform/platformConfig.ts` | ★ **平台配置单一事实来源**：API 根地址、兜底值 | 仅配置 |
| `api/commonApi.ts` | `CommonApi<TMessage,TRequestBody>` 抽象基类 | 通用 API |
| `api/sse.ts` | 共享 SSE 流解析（`iterateSseEvents` / `consumeSseStream`） | 流式处理 |
| `api/httpClient.ts` | 共享 HTTP 请求样板（`postJson`） | HTTP 请求 |
| `api/openai/openaiApi.ts` | OpenAI 格式 API 实现 | OpenAI 兼容 |
| `api/anthropic/anthropicApi.ts` | Anthropic 格式 API 实现（含连续工具结果合并） | Anthropic 兼容 |
| `provider/provider.ts` | `ChatModelProvider`：VS Code 接口实现 + 请求编排 | 核心逻辑 |
| `provider/requestOptions.ts` | `applyReasoningEffort` / `applyTemperature` / `resolveApiMode` | 推理强度 / temperature / apiMode 决策 |
| `provider/rotation.ts` | `runKeyRotationLoop()`：多 key 轮换循环 | 多 key 轮换 |
| `provider/apiDispatch.ts` | `executeApiRequest()`：双协议分发、流式处理、零正文检测 | 协议分发 |
| `provider/visionRounds.ts` | `handleInterceptedToolCall()`：ask_image 图片代理多轮 | 图片代理 |
| `provider/errors.ts` | `VisionRoundError` / `TransientRetryExhaustedError` / `REASON_TEXT` / `buildAllKeysUnavailableDetail` / `tryTransientRetryRound` / `checkZeroAnswerBudgetExhausted` / `reportNativeUsage` / `getRequestedReasoningEffort` | 错误处理 |
| `keys/keyManager.ts` | barrel：统一导出 `keys/` 下全部 API | 多 key 管理 |
| `keys/store.ts` | SecretStorage 读写与旧版单 key 迁移、增删改 | 多 key 存储 |
| `keys/selection.ts` | `getPrimaryApiKey` / `pickNextApiKey` / `shouldSingleKeyFallbackSwitch` / `setActiveKeyByValue` | key 选择 |
| `keys/health.ts` | 瞬态冷却、`matchErrorRule`、失效原因、状态更新 | key 健康 |
| `keys/availability.ts` | `testKeyAvailability`（最小真实聊天请求） | key 可用性 |
| `models/models.ts` | 内置模型定义清单 + 模型配置查询 | 模型定义 |
| `models/apiModelList.ts` | API 模型列表获取（`/v1/models`），5 分钟缓存，静默降级 | 模型列表 |
| `models/visionModels.ts` | 视觉能力判定（API 标记 → models.dev → 硬编码兜底） | 视觉能力 |
| `models/modelSync.ts` | 启动模型同步（每日一次，一行日志） | 模型同步 |
| `models/provideModel.ts` | 模型信息提供函数（含自动发现） | 模型信息 |
| `commands/registerCommands.ts` | 注册全部命令 + `onDidChangeConfiguration` 监听 | 命令注册 |
| `commands/apiKeyManagerUi.ts` | `showApiKeyManager()` 主入口 | key 管理 UI |
| `commands/apiKeyDisplay.ts` | key 展示辅助（纯函数） | key 展示 |
| `commands/apiKeyFlows.ts` | key 管理交互流程 | key 管理 |
| `core/logger.ts` | 日志输出 (LogOutputChannel) | 日志系统 |
| `core/localize.ts` | 中英文国际化 | 国际化 |
| `core/utils.ts` | 工具函数（重试、角色映射、工具转换、JSON 修复等） | 工具函数 |
| `cloud/cloudSync.ts` | 云同步（GitHub Gist） | 云同步 |
| `cloud/syncPayload.ts` | 纯函数 `syncPayloadHasChanged` | 云同步对比 |
| `gitCommit/commitMessageGenerator.ts` | Git 提交消息生成逻辑 | Git 提交 |
| `gitCommit/gitUtils.ts` | Git 命令封装 | Git 工具 |
| `tokenizer/tokenizerManager.ts` | o200k_base 分词器管理 (含 LRU 缓存) | 分词器 |
| `tokenizer/provideToken.ts` | Token 用量计算 + `estimateInputTokens` | Token 计数 |
| `tokenizer/imageUtils.ts` | 图片尺寸解析 (PNG/GIF/JPEG/WebP) | 图片尺寸 |
| `vision/types.ts` | Vision proxy 类型定义 + 非视觉图片引用工厂 | Vision proxy |
| `vision/historyCodec.ts` | 跨轮视觉历史编解码 | 跨轮历史 |
| `vision/historyPart.ts` | 跨轮视觉历史 DataPart 创建/解析 | 跨轮历史 DataPart |
| `vision/imageProxy.ts` | 图片代理核心：调用视觉模型描述图片 | 图片代理 |

---

## 4. 平台对接点

### 4.1 平台身份

| 位置 | 值 |
|------|-----|
| `src/platform/platformConfig.ts` | `API_BASE_URL` = `https://developer.amd.com.cn/radeon/api/v1/` |
| `package.json` | `name` = `amd-tokenfactory-copilot`，`vendor` = `amdtokenfactory`，命令前缀 `amdtokenfactory.`，设置键前缀 `amdTokenFactory.` |
| `src/core/localize.ts` + `package.nls*.json` | 文案 |
| `src/models/models.ts` | `BUILT_IN_MODELS`（10 个 AMD 模型） |

### 4.2 平台行为对接点

| 位置 | 说明 |
|------|------|
| `src/models/apiModelList.ts` → `normalizeModelEntry()` | `/v1/models` 响应解析（`{data:[...]}` 结构，过滤非 chat 端点） |
| `src/keys/config.ts` → `DEFAULT_ERROR_RULES` | 错误分类规则（401/402 → persist；429/502/503/504 → cooldown；500 → retrySameKey） |
| `src/models/visionModels.ts` → `HARDCODED_VISION` | 视觉能力兜底 |
| `src/api/openai/openaiApi.ts` → `prepareRequestBody` | **只发 `reasoning_effort`，绝不发 `thinking`** |
| `src/api/anthropic/anthropicApi.ts` → `prepareRequestBody` | 同上 |

### 4.3 平台行为差异（实测 2026-10-21）

- [x] `/v1/models` 返回 `{data:[...]}`，含 `architecture.input_modalities` / `output_modalities` / `context_length` / `supported_parameters` / `providers[0].{vision,tools,reasoning}`
- [x] 非 chat 端点（`output_modalities` 非 `text` 或 `context_length=0`）需过滤
- [x] **不支持 Responses 协议**（`/v1/responses` 未实现）
- [x] **不支持 `thinking` 参数**（400）→ 用 `reasoning_effort`
- [x] 思考内容在 **`reasoning`** 字段（OpenAI）/ **`thinking` 块**（Anthropic）
- [x] 思考是**模型固有属性**（Qwen3.8 恒思考、DeepSeek-V4 恒不思考）
- [x] 流式 SSE 标准（`data: {...}` / `[DONE]`）
- [x] 无账号信息端点（余额无意义）
- [x] 限流特征：401（无效 key）/ 402（余额不足）/ 429（限流）/ 500（内部错误）/ 502/503/504（网关）

### 4.4 已移除的脚手架模块

| 模块 | 移除原因 |
|------|----------|
| `balance/` 目录 | AMD 余额无记录意义（每天 $1 额度，东八区 0 点刷新） |
| `ui/statusBar.ts` | 状态栏仅用于套餐用量显示 |
| `commands/checkUsageCommand.ts` | 套餐用量查询命令 |
| `api/responses/` 目录 | AMD 不支持 Responses 协议 |
| `ApiKeyEntry.credential` 字段 | 凭据仅用于余额查询 |
| `package.json` 的 `showUsage` / `usageRefreshInterval` / `minBalanceCny` / `balanceCheckIntervalSec` 设置 | 余额相关 |

---

## 5. 函数定义大全

### 5.1 `src/extension.ts`

- `activate(context: vscode.ExtensionContext): void` — 扩展激活入口（仅编排）
- `deactivate(): void`

### 5.2 `src/platform/platformConfig.ts` ★

| 常量 | 用途 |
|------|------|
| `API_BASE_URL` | OpenAI 兼容 API 根地址 |
| `PLATFORM_USER_SELF_URL` | 账号信息端点（AMD 无 → 空字符串） |
| `PLATFORM_HEADERS` | 用户中心接口必需固定头（AMD 无 → 空对象） |
| `FALLBACK_TEST_MODEL_ID` | 模型列表不可用时的兜底测试模型 ID |

### 5.3 `src/keys/` 模块

> `keys/keyManager.ts` 为 barrel，统一导出以下模块的全部 API。

- `keys/config.ts`：`getApiKeyMode` / `getSingleKeyFallback` / `getErrorRules` / `getExhaustedCooldownMin` / `getTransientRetryTimes`；类型 `ErrorAction` / `ErrorRule`
- `keys/store.ts`：`getApiKeyStore` / `saveApiKeyStore` / `invalidateApiKeyStoreCache` / `addApiKey` / `addApiKeys` / `removeApiKey` / `setActiveKey` / `updateApiKey`
- `keys/state.ts`：`getStoreCache` / `setStoreCache` / `getRotationIndex` / `setRotationIndex` / `getTransientExhaustedMap` / `onApiKeyStoreChanged` / `notifyApiKeyStoreChanged`
- `keys/selection.ts`：`getPrimaryApiKey` / `pickNextApiKey` / `shouldSingleKeyFallbackSwitch` / `setActiveKeyByValue`
- `keys/health.ts`：`getTransientExhaustedInfo` / `isApiKeyEligible` / `hasTransientExhaustedKey` / `matchErrorRule` / `isKeyRotationError` / `isTransientRetryError` / `getKeyRotationReason` / `getKeyUnavailableReason` / `markApiKeyExhausted` / `markApiKeyAvailable` / `updateKeyAvailability` / `resetExhaustedKeys` / `getKeyDisplayStatus`
- `keys/availability.ts`：`testKeyAvailability`（最小真实聊天请求）
- `keys/mask.ts`：`maskApiKey`

### 5.4 `src/provider/` 模块

- `provider.ts`：`ChatModelProvider`（`provideLanguageModelChatInformation` / `provideTokenCount` / `provideLanguageModelChatResponse` / `notifyModelListChanged`）
- `requestOptions.ts`：`applyReasoningEffort` / `applyTemperature` / `resolveApiMode`
- `rotation.ts`：`runKeyRotationLoop(params)`
- `apiDispatch.ts`：`executeApiRequest(params)`
- `visionRounds.ts`：`handleInterceptedToolCall(params)`
- `errors.ts`：`VisionRoundError` / `TransientRetryExhaustedError` / `REASON_TEXT` / `checkZeroAnswerBudgetExhausted` / `buildAllKeysUnavailableDetail` / `tryTransientRetryRound` / `reportNativeUsage` / `getRequestedReasoningEffort`

### 5.5 `src/api/` 模块

- `commonApi.ts`：`CommonApi<TMessage,TRequestBody>` 抽象基类（`convertMessages` / `prepareRequestBody` / `processStreamingResponse` / `tryEmitBufferedToolCall` / `flushToolCallBuffers` / `collectLocalImages` / `applyTemperature` / `mergeExtraParams` / `runSseStream` / `prepareHeaders`）
- `sse.ts`：`iterateSseEvents` / `consumeSseStream`
- `httpClient.ts`：`postJson`
- `openai/openaiApi.ts`：`OpenaiApi`（`convertMessages` / `prepareRequestBody` / `processStreamingResponse` / `createMessage`）
- `anthropic/anthropicApi.ts`：`AnthropicApi`（同上 + 连续工具结果合并 + 图片索引按 part 顺序内联分配 + thinking 块置于 assistant 消息首位）

### 5.6 `src/models/` 模块

- `models.ts`：`BUILT_IN_MODELS` / `getBuiltInModelInfos` / `getBuiltInModelIds` / `getMaxInputTokensRatio` / `getBuiltInModelConfig`
- `apiModelList.ts`：`getApiModelIds` / `getApiModelMetadataList` / `getResponsesSupportedModelIds` / `getAnthropicSupportedModelIds` / `isApiFetchSuccessful`
- `modelsDev.ts`：`ensureModelsDevLoaded` / `lookupModelDevEntry`
- `visionModels.ts`：`resolveVisionCapability`
- `modelSync.ts`：`syncModelsOnStartup`
- `provideModel.ts`：`prepareLanguageModelChatInformation` / `getResponsesModelIds` / `getAnthropicModelIds` / `getAutoDiscoveredModelConfig` / `isVisionCapableModelId`

### 5.7 `src/commands/` 模块

- `registerCommands.ts`：`registerCommands(context, provider)`
- `apiKeyManagerUi.ts`：`showApiKeyManager(context)`
- `apiKeyDisplay.ts`：`buildKeyDetailLine` / `buildKeyQuickPickItems`
- `apiKeyFlows.ts`：`KeyManagerContext` / `addKeyFlow` / `parseBatchImport` / `batchImportFlow` / `deleteKeysFlow` / `pickKey` / `checkAvailabilityFlow` / `checkAllAvailabilityFlow` / `showCheckMenu` / `editKeyFlow`

### 5.8 `src/core/` 模块

- `logger.ts`：`Logger` 类（`init` / `debug` / `info` / `warn` / `error` / `sanitizeHeaders` / `dispose`）+ `logger` 单例
- `localize.ts`：`l10n(key)` / `l10nFormat(template, ...args)`
- `types.ts`：`ProviderModelItem` / `ModelPreset` / `RetryConfig` 等
- `utils.ts`：`mapRole` / `convertToolsToOpenAI` / `createRetryConfig` / `executeWithRetry` / `isRetryableError` / `isImageMimeType` / `createDataUrl` / `arrayBufferToBase64` / `isToolResultPart` / `tryParseJSONObject` / `parseToolCallArguments` / `repairJsonText` / `splitToolCallArguments` / `storeDataUriImages` / `replaceDataUriImages`
- `versionManager.ts`：`VersionManager`（`getVersion` / `getUserAgent` / `getClientInfo`）

### 5.9 `src/cloud/` 模块

- `cloudSync.ts`：`pushToCloud(context, silent?)` / `pullFromCloud(context, silent?)` / `autoPullOnStartup(context)` / `registerCloudSyncAutoPush(context)` / `flushPendingAutoPush()`
- `syncPayload.ts`：`syncPayloadHasChanged(local, remote)` + 类型 `SyncedKeyEntry` / `SyncPayload`

### 5.10 `src/gitCommit/` 模块

- `commitMessageGenerator.ts`：`generateCommitMsg` / `abortCommitGeneration` / `extractCommitMessage` / `removeThinkTags`
- `gitUtils.ts`：`getGitDiff` / `getRecentCommits` / `limitDiffLines` 等

### 5.11 `src/tokenizer/` 模块

- `tokenizerManager.ts`：`TokenizerManager`（`initialize` / `getInstance` / `getTokenizer` / `countTokens`）+ `tokenizerManager` 单例
- `provideToken.ts`：`countMessageTokens` / `textTokenLength` / `countToolTokens` / `estimateInputTokens` / `calculateImageTokenCost` / `calculateNonImageBinaryTokens`
- `imageUtils.ts`：`getImageDimensions` / `getMimeType` / `getPngDimensions` / `getGifDimensions` / `getJpegDimensions` / `getWebPDimensions`

### 5.12 `src/vision/` 模块

- `types.ts`：`StoredImage` / `InterceptedToolCall` / `ASK_IMAGE_TOOL_DEF` / `ASK_WITH_MULTI_IMAGE_TOOL_DEF` / `buildUserImageReference` / `buildToolImageReference`
- `historyCodec.ts`：`VISION_TOOL_HISTORY_MIME` / `serializeVisionToolHistory` / `deserializeVisionToolHistory` / `toOpenAIVisionToolMessages` / `toAnthropicVisionToolMessages`
- `historyPart.ts`：`createVisionToolHistoryPart` / `parseVisionToolHistoryPart`
- `imageProxy.ts`：`findVisionModel` / `callVisionModel` / `callVisionModelMulti`

---

## 6. 编译与构建

### 6.1 编译命令

```bash
# TypeScript 编译（清理 out/ + tsc + 生成编译元信息 + 设置项一致性核对）
npm run compile

# 完整审计（设置漂移 / 未使用导出 / 未使用 l10n / nls 一致性 / 命令声明 / 文档路径 / 测试路径）
npm run audit

# ESLint 检查
npm run lint

# 仅类型检查（无输出）
npx tsc --noEmit

# 持续监视模式
npm run watch

# 离线测试（无需 API Key；先自动 compile）
npm test
npm run test:offline

# 云同步真实端到端测试（需 GitHub gist 权限凭据；无凭据时 SKIP 退出 0）
npm run test:e2e

# 打包 VSIX
npm run build
```

> `npm run compile` 先运行 `scripts/build/clean.mjs` **清空 `out/`**，再 `tsc` 编译，最后自动运行 `build-info.mjs` 与 `check-settings.mjs`。

### 6.2 编译配置 (tsconfig.json)

| 选项 | 值 |
|------|-----|
| `module` | `Node16` |
| `target` | `ES2024` |
| `lib` | `["ES2024", "dom"]` |
| `strict` | `true` |
| `outDir` | `out` |
| `rootDir` | `src` |
| `exclude` | `["scripts", "node_modules", "out"]` |

### 6.3 依赖

| 依赖 | 用途 |
|------|------|
| `@microsoft/tiktokenizer` | o200k_base 分词器 |
| `@types/node` / `@types/vscode` | 类型定义 |
| `eslint` / `typescript-eslint` / `@eslint/js` | 代码检查 |
| `typescript` | TypeScript 编译器 |

### 6.4 vsix 打包（vsce）

- `npm run build` = 编译 + `npx @vscode/vsce package -o <name>-<version>.vsix`
- **vsce 默认自动打包 `dependencies` 声明的运行时依赖 `node_modules`**（自动排除 devDependencies）。**严禁在 `.vscodeignore` 中写 `node_modules/**`** —— 会把运行时依赖（如 `@microsoft/tiktokenizer`）一并排除，导致扩展激活时抛 `Error: Cannot find module '@microsoft/tiktokenizer'` → provider 未注册 → **该 vendor 下所有模型不可用**（表象：`The selected model 'vendor/x' is not available`；真实根因在 `exthost.log` 的 activation failed，与模型/平台无关）。
- 每次打包后必须核对 vsix 文件清单含 `extension/node_modules/@microsoft/tiktokenizer/dist/*.js`（构建输出的 file tree 或 `vsce ls --tree`）。

---

## 7. 开发规范

### 7.1 **编译检查铁律**

> **所有代码更改必须通过 `npm run compile` / `npx tsc --noEmit` 编译检查无错误通过。**

### 7.2 **编译产物清洁铁律**

> **`npm run compile` 必须先清空 `out/`**（`scripts/build/clean.mjs` 作为前置步骤）。

### 7.3 **编译产物元信息铁律**

> **每次编译产物必须包含版本号和编译时间（标注时区）。**
> `npm run compile` 自动生成 `out/build-info.json` 与 `.copilot/build-log.md`。禁止手动编辑。

### 7.4 **AGENTS.md 同步更新铁律**

> **每次代码更改后，必须同步更新 `AGENTS.md`**：函数/类/接口 → §5；文件增删改 → §3；模型定义 → §1.3；核心流程 → §2；平台对接点 → §4；编译配置 → §6；开发规范 → §7。

### 7.5 PR 内容规范

#### PR Title 格式

```
<type>: <brief description>
```

type 取值：`feat` | `fix` | `refactor` | `docs` | `chore` | `improve` 等。

#### PR Body 模板

```markdown
### Changes

**1. <功能/改动标题>**
- <具体变更点 1>
- <具体变更点 2>

### Files Changed

| File | Change |
|------|--------|
| `<file path>` | <一句话说明改了什么> |
```

#### 撰写规范

- Title 首字母小写，用英文撰写
- Body 使用英文，用 **粗体标题** 组织 major change areas
- Changes 部分用项目符号列出每个功能点的具体变更，每点以句号结尾
- Files Changed 表格只列关键文件，说明简洁
- 不包含"如何测试"、"如何回滚"等运维内容，除非用户特别要求
- **从整体上审视**：按功能/模块组织内容，而非按 commit 罗列

### 7.6 更新日志内容规范

```markdown
### <功能/改动类别标题>

- **<具体功能/改动点标题>**：<详细描述，说明改了什么、为什么、影响范围等>
- <无标题的简单变更点直接用一句话描述>
```

#### 撰写规范

- 以 `###` 三级标题组织 major change areas，标题用中文
- 需要强调的变更点使用 `**<标题>**：<描述>` 格式
- 用中文撰写，风格专业、精炼
- 不包含 `Files Changed` 表格或技术实现细节
- **按功能类别而非按 commit 时间组织**

### 7.7 代码风格

- 使用 TypeScript 严格模式 (`strict: true`)
- 遵循 ES2024 标准
- 使用 ESModule 模块系统 (`import`/`export`)
- 所有新的 API 函数需有 JSDoc 注释
- 导出的函数和类必须显式标注类型
- 使用 `satisfies` 操作符确保类型安全

### 7.8 命名约定

| 类别 | 约定 | 示例 |
|------|------|------|
| 类 | PascalCase | `ChatModelProvider` |
| 接口 | PascalCase | `BuiltInModelDef`, `ProviderModelItem` |
| 类型 | PascalCase | `OpenAIChatRole`, `ParsedModelId` |
| 函数 | camelCase | `getBuiltInModelConfig`, `countMessageTokens` |
| 变量 | camelCase | `requestTimeoutMs`, `apiKey` |
| 常量 | UPPER_SNAKE_CASE | `BASE_TOKENS_PER_MESSAGE`, `DEFAULT_CONTEXT_LENGTH` |
| 私有属性 | `_` 前缀 | `_lastRequestTime`, `_toolCallBuffers` |
| 文件 | camelCase | `provider.ts`, `commitMessageGenerator.ts` |

### 7.9 VS Code API 使用约束

- `LanguageModelChatProvider` — 必须实现 `provideLanguageModelChatResponse()` 和 `provideLanguageModelChatInformation()`；可选实现 `onDidChangeLanguageModelChatInformation` 事件（VS Code 1.125+）
- `LanguageModelResponsePart` — 使用 `LanguageModelTextPart`、`LanguageModelThinkingPart`、`LanguageModelToolCallPart`、`LanguageModelDataPart`
- `LanguageModelChatInformation.maxOutputTokens` — 必须填入模型真实输出上限，不能为 0
- `SecretStorage` — 用于安全存储 API Key
- `LogOutputChannel` — 用于结构化日志输出
- `Progress<LanguageModelResponsePart>` — 用于流式报告响应块

### 7.10 不依赖 VS Code Proposed API

- 本扩展不使用任何 `enabledApiProposals`，所有使用的 VS Code API 均为稳定版本（VS Code 1.116+）
- `typings/` 下的类型声明文件仅用于编译期类型补全，不影响运行时行为

### 7.11 错误处理策略

- 网络请求使用 `executeWithRetry()`（HTTP 层，默认 2 次，仅网关错误 502/504 + 网络错误）；平台错误（429/500/503）由整轮层 `tryTransientRetryRound` 处理（默认 3 次）
- 请求超时 → 友好的本地化错误消息
- 流式解析错误 → 记录日志，继续处理（不中断流）
- 所有未捕获错误由 `provider.ts` 的 `catch` 块统一处理

### 7.12 日志规范

所有日志使用 `logger` 单例，标签格式为 `category.subcategory`：
- `request.start/end` — 请求开始/结束
- `request.error/timeout/delay` — 请求错误/超时/延迟
- `models.loaded` — 模型加载
- `commit.start/end/error` — 提交消息生成
- `openai.stream.*` / `anthropic.stream.*` — 流式处理
- `apiKey.missing` — API Key 缺失

### 7.13 **vsix 运行时依赖铁律**

> **vsix 必须包含 `dependencies` 中声明的全部运行时依赖。打包后必须核对 vsix 文件清单含 `extension/node_modules/`。**
>
> 2026-10-22 教训（v2.0.0 首次发布即不可用）：`.vscodeignore` 含 `node_modules/**` → `@microsoft/tiktokenizer` 未打入 vsix → 激活抛 `Cannot find module` → provider 未注册 → 全部模型报 `The selected model '...' is not available`。排查此类报错**先看 `exthost.log` 的 activation 记录**，而非模型/平台侧。
