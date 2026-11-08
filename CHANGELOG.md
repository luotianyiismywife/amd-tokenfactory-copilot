# Changelog

本文件记录 amd-tokenfactory-copilot 的用户可感知变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循语义化版本(新功能升 y,修 bug/调整升 z)。

## [2.0.3] - 2026-11-08

### 修复

- **视觉代理静默返回空答案（ask_image 完全失效）**：旧实现默认给视觉模型发 `reasoning_effort: "none"`（想省掉思考、加快图片描述）。但 AMD 的 **Qwen3.8 系列在 `none` 下出现空答案**——HTTP 200、无 error、`content` 为空、耗时仅约 400ms（2026-11-08 实测；2026-11-09 用新 key 重测显示 Qwen3.8 的 `none` 实际可控、正常回答，空答案可能受当时 key/平台状态影响，归因存疑）。日志实测（06:55 会话）：三轮 `vision.intercepted` 对应的嵌套 `Qwen3.8-27B` 请求分别 393 / 461 / 410 ms 完成，全部无 `vision.call-failed`，主模型只能回复"图片识别工具暂时没有返回内容"，用户完全无从排查。现改为：视觉代理**复用对话的请求链路**（`executeApiRequest`），`reasoning_effort` 由 `amdTokenFactory.visionProxyThinking` 决定（默认空 = 模型默认，不再硬编码 `none`）。同时 `sendVisionRequest()` 在 `content` 为空时抛错（`vision.empty-answer`），失败原因会写进 tool result（`[Image query failed: …]`）而不是笼统的 `[Image query unavailable]`，空串兜底为 `[Image query returned no text from <model>]` —— 绝不让空串冒充成功答案。
- **`thinking` 参数是死代码**：旧 `buildVisionOptions()` 里的 `thinking: { type: "disabled" }` 从未被转发到上游（`prepareRequestBody` 只读 `modelOptions.stop`，AMD 该参数本身 400），`getRequestedReasoningEffort` 也只认 `thinking.type === false` 这个布尔值，字符串 `"disabled"` 不匹配。已随重构删除，避免误导。
- **旧版布尔值残留导致视觉代理崩溃**：`visionProxyThinking` 在 2.0.2 及之前是 boolean（`true`=high / `false`=low），2.0.3 改为自由字符串后，用户设置里残留的 `true`/`false` 让 `resolveVisionReasoningEffort` 的 `configured.trim()` 抛 `(configured ?? "low").trim is not a function` → `vision.call-failed` → 视觉代理完全失效（日志实测：GLM-5.3-Flash 三轮 ask_image 全部失败）。修复：`resolveVisionReasoningEffort` 与命令的 `currentEffort` 读取都改为 `typeof configured === "string" ? configured.trim() : ""`——布尔残留按"留空 = 模型默认"处理，不再崩溃。
- **`supports_reasoning` 解析修正**：平台 `/v1/models` 的 `supported_parameters` 返回的是 `reasoning_effort`（不是 `reasoning`），原 `supportedParams.includes("reasoning")` 永远匹配不到（死代码），实际靠 `providers[0].reasoning`。现改为读真实参数标记。

### 重构

- **视觉代理复用对话请求链路**：`vision/imageProxy.ts` 不再走 `vscode.lm.selectChatModels` + `sendRequest()`（嵌套重入），改为直接调用 `executeApiRequest`（`provider/apiDispatch.ts`）——与对话同一条请求链路。端点由 `apiMode` 决定（与对话相同），`reasoning_effort` 由 `amdTokenFactory.visionProxyThinking` 决定，经 `executeApiRequest` 新增的可选参数 `reasoningEffortOverride` 传入（**不经过** `applyReasoningEffort`，主对话请求不受影响）。这样视觉代理不再是"单独实现"，后续视频/音乐等代理只需构造自己的 `um` + `messages` 即可复用整条链路。
- **主模型续跑也复用 `executeApiRequest`（三链路共用标准接口）**：`visionRounds.ts` 的 `runOpenAIRound` / `runAnthropicRound` 不再自己拼 body + fetch（约 150 行重复的 temperature / top_p / max_completion_tokens / reasoning_effort / tools / tool_choice / system 拼装逻辑），改为构造 assistant tool_call + tool result 消息后调用 `executeApiRequest`，通过三个新可选参数控制：`apiInstance`（复用外层 api 实例，保留 `_hasImages`/`_systemContent`/`capturedReasoningContent`）、`apiMessagesOverride`（跳过 `convertMessages`，原样重放已转换消息 + 追加 tool 轮）、`skipVisionRounds`（防内层递归）。现在主对话 / 视觉代理 / 主模型续跑**三条链路共用一份请求拼装逻辑**（`convertMessages` + `prepareRequestBody` + `processStreamingResponse` + `checkZeroAnswerBudgetExhausted`），后续新增代理（视频/音乐）只需构造 `um` + `messages` 即可复用。
- **`visionProxyThinking` 改为自由字符串 + 命令动态加载档位**：设置项从布尔值改为自由字符串（默认空 = 模型默认），设置 UI 不再显示写死的枚举（VS Code 静态配置无法按模型动态枚举）。档位选择挪到 `选择视觉代理模型` 命令：选完视觉模型后，从该模型的 `supportedReasoningEfforts`（内置清单）动态加载档位列表供选择（如 Qwen3.8-27B → `low/medium/xhigh`）。全量值 `auto/none/low/medium/high/xhigh/max` 只写在注释里，供"平台不返回思考等级时用测试脚本探测各档位支持情况后写入 `models.ts`"作参考。
- **`reasoning_effort` 支持范围按模型区分（2026-11-09 实测）**：Qwen3.8 系列（`Qwen3.8-27B` / `Qwen3.8-Flash-Next`）**不支持 `high`/`max`/`minimal`**（400 `Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.`），支持 `xhigh`（默认）/`medium`/`low`；DeepSeek-V4 / GLM-5.3 等全支持。档位列表**只从内置清单读**（平台 `/v1/models` 与 models.dev 都不返回具体档位列表，只给布尔标记——档位是平台部署级知识，只能实测 + 手写进 `models.ts`，见 AGENTS.md §4.6）。视觉代理发送时按模型过滤（用户选模型不支持的档位 → 回退模型默认，避免 400）。
- **新增档位探测脚本 `scripts/dev/probe-reasoning-efforts.mjs`**：对每个 chat 模型 × 每个档位发最小请求（看 200/400），输出支持矩阵与 `models.ts` 更新建议。2026-11-09 实测：DeepSeek-V4-Flash / DeepSeek-V4.1-Flash / Gemma-4-31B-IT / MiMo-V2.6-Flash **全支持**（none/low/medium/high/xhigh/max/minimal），已更新 `models.ts`；GLM-5.3-Flash 支持到 max（minimal 未确认）；MiniCPM5-2B 仅 `low`/`medium`/`high`（none/xhigh/max/minimal → 400）；MiniCPM-V 两个模型响应超时未测全（单请求 300s 无返回，模型当前不可用或排队极慢）。

## [2.0.2] - 2026-11-08

### 修复

- **`选择视觉代理模型` 命令缺失**：`amdTokenFactory.visionProxyModel` 的设置说明中提示"请用命令 `选择视觉代理模型` 从当前可用的视觉模型中选择"，但该命令此前从未在 `package.json` 中声明、也未在 `registerCommands.ts` 中注册，命令面板里根本找不到，用户只能手写模型 ID。现补齐 `amdtokenfactory.selectVisionProxyModel` 命令（`src/commands/visionProxyCommand.ts`）：从 `/v1/models` 实时列表经 `resolveVisionCapability`（平台标记 → models.dev → 内置清单）筛选视觉模型，API 不可用/未配置 key/未识别出视觉模型时回退内置清单中 `vision === true` 的模型，选中后写入 `amdTokenFactory.visionProxyModel`（已定义于工作区/工作区文件夹时写入该作用域，否则用户级），并标注当前生效项。
- **设置项说明与实际能力不符**：`amdTokenFactory.visionProxyModel` 本身是自由文本字符串（VS Code 设置无法动态枚举远端模型），说明文案已改为明确指向该命令，README 与欢迎页（walkthrough）同步补充命令入口。
- **视觉代理模型留空即自动选择**：`visionProxyModel` 默认值改为空字符串。留空时运行时自动从当前视觉模型列表中挑一个（排除主模型，避免递归），设置项因此变成"可选覆盖"而非"必填"。

### 重构

- **模型信息归一化收敛到 `src/models`**：新增 `registry.ts`（三源合并为 `ModelInfo`，单一事实来源）与 `chatInfo.ts`（`ModelInfo` → VS Code 条目 / 请求体配置），`index.ts` 作为统一出口。此前 `models.ts` 与 `provideModel.ts` 各写了一份思考档位枚举、上下文比例、输出上限兜底逻辑，`provider.ts` 还要自己做 `getBuiltInModelConfig ?? getAutoDiscoveredModelConfig` 的两级回退；现在全部只有一份实现，其他模块统一 `import { … } from "../models"`。
- **视觉能力兜底表去重**：`visionModels.ts` 里的 `HARDCODED_VISION` 与 `models.ts` 的 `BUILT_IN_MODELS[].vision` 是同一份数据，已删除前者。`resolveVisionCapability(apiMeta, devEntry)` 现在是纯解析器（平台标记 → models.dev → 未知按纯文本处理），不再持有模型表。
- **models.dev 补充层此前实际从未生效**：models.dev 的键全小写（`z-ai/glm-4.5`、`deepseek/deepseek-chat`），而平台模型 ID 首字母大写（`GLM-5.3-Flash`、`DeepSeek-V4-Flash`），原查找是大小写敏感的精确匹配 + 后缀匹配，因此**永远查不到**，所有模型都直接落到"未知 → 纯文本"。现改为大小写不敏感索引（全 ID / 短 ID 双份小写表），并删除 O(n) 的模糊后缀匹配——模糊匹配一旦命中错误条目，会把纯文本模型误判为视觉模型，导致图片直发被平台 400 拒绝。
- **视觉判定误判代价不对称**：把纯文本模型（如 `GLM-5.3-Flash`）误判为视觉 → 图片直接进请求体 → 平台硬失败；把视觉模型误判为纯文本 → 图片走 `ask_image` 代理 → 仍能正常回答。因此判定链一律"宁可漏判"，未知模型按纯文本处理。
- **`providers` 存在但缺 `vision` 字段不再被当成"明确不支持视觉"**：原实现用 `providers.length > 0` 判断有无信号，`providers: [{ streaming: true }]` 这类条目会被折叠成 `supports_vision: false`，从而覆盖 models.dev 的正确信息。现改为只有 `typeof providers[0].vision === "boolean"` 才算平台表态，否则返回 `undefined` 继续下探。
- **models.dev 的 `modalities.input` 优先于 `attachment`**：`attachment: true` 只表示"接受文件上传"（可能仅 PDF），不能推出图片输入；现在先看 `modalities.input` 是否含 `image`，只有该字段缺失时才用 `attachment` 兜底。
- **内置清单降级为纯离线兜底**：此前 `/v1/models` 成功时，内置清单仍会参与字段合并（思考档位、`extra`、上下文、输出上限等），平台下架或调整模型后旧值会继续生效。现在内置清单**只在 `/v1/models` 获取失败时**整份接管列表；API 成功时模型信息完全来自平台 + models.dev，字段级优先级为 `/v1/models` > models.dev > 代码默认值。`getModelInfo()` 在注册表已由 API 填充时，对平台未返回的模型 ID 返回 `undefined`（不再回落到内置清单）。
- **`/v1/models` 视觉标记改为三态**：`architecture.input_modalities` / `providers[].vision` 缺失时不再折叠成 `false`，而是返回 `undefined` 让判定链继续下探 models.dev，避免"平台没给标记 → 全部模型被当成纯文本"。
- **提交消息生成复用注册表**：不再单独 `await getAnthropicSupportedModelIds()` 探测协议，改为 `ensureModelRegistry()` + 同步 `getAnthropicModelIds()`；模型配置也走 `getModelInfo` / `toProviderModelItem`，自动发现的模型同样可用。

### 已知限制

- **models.dev 描述的是上游模型，不是本平台部署**：同一上游模型在不同平台/不同量化版本上的多模态能力可能被裁剪，因此 models.dev 只作补充、不覆盖 `/v1/models`。实测反例：`GLM-5.3-Flash` 在 models.dev 中 `modalities.input=["text","image","video","pdf"]`，而 AMD `/v1/models` 返回 `input_modalities=["text"]`（平台裁剪了视觉能力）。判定链以平台为准，结果正确。
- **平台完全不给视觉信号时仍可能误判**：若 `/v1/models` 既无 `architecture.input_modalities` 也无 `providers[].vision`，而 models.dev 说支持视觉、实际却不支持，则图片会直发并被平台 400 拒绝。当前**无自愈**——`DEFAULT_ERROR_RULES` 不覆盖 400，`rotation.ts` 会直接抛出原始错误，下次仍会重犯。AMD 平台不属于此情形（10 个模型全部有 `input_modalities` 表态），故暂不实现补强。若移植到不返回能力标记的平台，可考虑：① 错误驱动学习（识别"图片不被支持"类 400，记入会话级 negative cache 并降级为 `ask_image` 代理，零额外配额，推荐）；② `supported_parameters` 含 `vision`/`image`/`image_url` 也算平台表态；③ 主动探测（1×1 PNG 最小请求，权威但花配额，AMD 每天仅 $1 额度，不建议）。详见 `AGENTS.md` §4.5。

## [2.0.1] - 2026-10-22

### 修复

- **流式工具调用被拆成两个**（v2.0.0 回归）：AMD 流式 `tool_calls` 首个带 `name` 的空 `arguments: ""` chunk 被宽容解析 `parseToolCallArguments` 当成 `{}` 过早发射（空参数工具调用），并标记 buffer 完成，导致后续仅带 `index` 的参数分片被跳过、重开桶产出 `unknown_tool`（名字与参数分离）。改用严格 `tryParseJSONObject` 校验，空/未完成参数不触发提前发射，统一延迟到 `finish_reason` 时解析，名字与参数正确合并为单个工具调用。
- **命令面板分类与标题**：`commandCategory` 从脚手架遗留的 `Copilot Provider` 改为 `AMD TokenFactory`，`Open Settings` 改为 `Open Extension Settings`。
- **内部日志前缀统一**：8 处 `[Copilot Provider]` 脚手架遗留标签改为 `[AMD TokenFactory]`。

## [2.0.0] - 2026-10-21

### 重构

- **架构对齐 [any2copilot](https://github.com/luotianyiismywife/any2copilot) 脚手架**：`src/` 按职责重组为子目录（`api/` `provider/` `keys/` `models/` `commands/` `core/` `cloud/` `gitCommit/` `tokenizer/` `vision/` `platform/` `typings/`），协议适配器、key 轮换、分词器、视觉代理、云同步全部重写为脚手架实现。
- **新增 Anthropic 协议支持**：除 OpenAI 兼容端点外，新增 `/v1/messages`（Anthropic）协议，可按模型切换或经 `amdTokenFactory.apiMode` 强制。AMD 不支持 OpenAI Responses 协议，故未移植。

### 新增

- **云同步（GitHub Gist）**：key/备注 二元组跨机器同步，使用 VS Code 内置 GitHub 登录（无需 PAT）。支持手动推送/拉取、启动自动拉取、可选去抖自动推送。
- **思考档位选择**：模型选择器新增推理强度档位（禁用思考 / 低 / 中 / 高），映射到 `reasoning_effort`。
- **`errorRules` 四元组配置**：错误分类规则（code + message + statusCode + action）集中一处配置，支持 `retrySameKey`（不换 key）/ `rotateCooldown`（冷却）/ `rotatePersist`（持久化不可用）三种处置。
- **`single` key 模式**：仅使用当前 key，402 余额不足时可自动切换。
- **图片代理多轮上限**：`amdTokenFactory.visionMaxRounds` 控制 `ask_image` 最大轮数。

### 变更

- **思考机制适配 AMD 平台**：AMD **不支持 `thinking` 参数**（400），思考深度改用 `reasoning_effort`（`none`/`low`/`medium`/`high`）；思考内容在 **`reasoning`** 字段（OpenAI）/ **`thinking` 块**（Anthropic），`reasoning_content` 恒为 `null`。思考是模型固有属性（Qwen3.8 恒思考、DeepSeek-V4 恒不思考）。
- **模型清单更新**（2026-10-21 `/v1/models` 实测）：10 个 chat 模型，新增 `DeepSeek-V4.1-Flash` / `Gemma-4-31B-IT` / `MiMo-V2.6-Flash` / `MiniCPM-V-4.7-1B` / `MiniCPM-V-4.7-35B-A3B` / `Qwen3.8-27B`；移除退役的 `DeepSeek-V4-Flash-Vision-Exp`（2026-10-23 退役）。
- **请求超时默认值提升至 10 分钟**（`requestTimeout` 600000ms）：AMD 首字延迟可能长达 2 分钟。
- **批量导入格式简化为 `key---备注`**（原 `key---凭据---备注`）。

### 移除

- **余额 / 套餐用量模块**：AMD 每个账号每天固定 $1 额度（东八区 0 点刷新），余额无记录意义（平台用于多账号轮询）。移除 `balance/` 目录、状态栏用量显示、`checkUsage` 命令、`credential` 字段及相关设置（`showUsage` / `usageRefreshInterval` / `minBalanceCny` / `balanceCheckIntervalSec`）。
- **OpenAI Responses 协议**：AMD 未实现 `/v1/responses`。

### 修复

- **重新打包：vsix 缺少 `@microsoft/tiktokenizer` 运行时依赖**：首个发布包的 `.vscodeignore` 误含 `node_modules/**`，导致分词器依赖未打入 vsix，扩展激活抛 `Cannot find module`、provider 未注册，全部模型报 `The selected model '...' is not available`（2026-10-21 发布后由用户反馈发现）。已移除该排除规则并重新打包，Release 附件已替换（tag 前移至 `167effb`）。

## [1.3.1] - 2026-09-19

### 移除

- **移除 `DeepSeek-V4.1-Flash` 白名单特判**:`/models` 已正式收录该模型,自动发现完全接管元数据,白名单注入机制不再需要

## [1.3.0] - 2026-09-18

### 新增

- **API Key 跨机器同步**:新增 `amdTokenFactory.syncApiKeys` 设置(默认开启),通过 VS Code 设置同步(Settings Sync)把 key store 随登录账户同步到其他机器;同步到达时自动刷新内存缓存与模型选择器,无需重启。关闭设置项即把 key store 移出同步。仅在用户全局开启 Settings Sync 时生效,Key 以加密形式存放

## [1.2.1] - 2026-09-18

### 修复

- **去除无 key 弹窗**:未配置 key 时发起对话不再弹出输入框,也不再弹带"打开官网"按钮的错误框——聊天中内联报错 "未找到 AMD TokenFactory API 密钥",添加/管理 key 一律走命令面板的 "管理 API Keys"

### 改进

- Key 轮换冷却分级:429 限流冷却 2 小时(`exhaustedCooldownMin`,日额度型限流冷却过短会白打请求);其他瞬态错误(5xx/未知轮换错误如日额度耗尽)冷却 2 分钟(新增 `otherErrorCooldownMin`);401 直接标记不可用(状态码原样展示,如 "不可用 (401)"),无冷却期
- 未知轮换错误(如日额度耗尽,错误码未知)不再持久化砖死 key——改为瞬态冷却,到期自愈
- 429 冷却中的 key 不再阻断模型列表获取:`/models` 拉取忽略瞬态冷却
- 内置兜底清单同步平台现状(2026-09-18):移除已下架的 `Qwen3.8-27B`,新增 `GLM-5.3-Flash`

## [1.2.0] - 2026-09-14

### 新增

- **模型列表自动获取机制全面升级(stale-while-revalidate)**:
  - 启动预热:扩展激活后立即后台拉取 `/models`,首次打开模型选择器零网络等待
  - 打开选择器秒开:有缓存时立即返回,后台静默刷新(60 秒节流);清单有实际变化时自动重建选择器,无需手动刷新
  - `/models` 请求加 10 秒超时,网络挂起不再拖死选择器;失败 30 秒退避,连续失败时秒开内置兜底清单
- **白名单模型特判**:`/models` 未收录但实测可用的模型自动注入(当前仅 `DeepSeek-V4.1-Flash`,门户已上架而清单接口滞后);API 收录后由新鲜元数据接管,白名单自动让位
- Key 增删(添加/批量导入/删除)后自动刷新模型列表,无需手动 Refresh Models

### 修复

- 过滤非聊天端点:OCR 专用模型(如 `MinerU2.5-Pro`,`context_length=0`、无 streaming/tools)不再作为"0 token 上下文的聊天模型"出现在选择器
- 内置兜底清单同步平台现状:`MiniCPM5-1B` 已下架,替换为 `MiniCPM5-2B`;新增 `Qwen3.8-27B`
- 兼容 `/models` 响应格式变更(裸数组 → `{"data":[...]}` 包装,解析器本已兼容,文档已同步)

## [1.1.2] - 2026-09-12

### 改进

- 请求/响应诊断日志增强(便于排查流式异常)

## [1.1.1] - 2026-09-11

### 修复

- 流可观测性:earlyEnd 检测;请求/流错误落盘日志

## [1.1.0] - 2026-09-06

### 新增

- 多 Key 轮询/固定模式、瞬态冷却 + 整轮指数退避重试、Key 管理 QuickPick(添加/批量导入/删除/重置/可用性检测)
- 思考内容(`reasoning_content`)接入 Copilot 思考 UI;token 用量上报原生指示器
- `/models` 自动发现 + 内置兜底清单
