# Changelog

本文件记录 amd-tokenfactory-copilot 的用户可感知变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循语义化版本(新功能升 y,修 bug/调整升 z)。

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
