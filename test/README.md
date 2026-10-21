# 测试脚本

> 所有测试运行前需先 `npm run compile`（除 `api-tests.mjs` 外，其余测试从 `out/` 加载编译产物）。
>
> **凭据一律从命令行参数或环境变量读取，不写入仓库**：
> `PROVIDER_API_KEY`（联网测试用真实 API Key）
>
> ⚠️ **AMD TokenFactory 首字延迟可能长达 2 分钟** → 联网测试的请求超时已设为 5 分钟（`api-tests.mjs` 的 `REQUEST_TIMEOUT_MS`）。

## 测试清单

| 脚本 | 类型 | 说明 |
|------|------|------|
| `api-tests.mjs` | 联网 | **双协议完整测试**（OpenAI / Anthropic），需真实 API Key。覆盖非流式/流式对话、工具调用、多轮回填、`reasoning_effort`（含 `thinking` 被拒 400 的回归）、`reasoning` 字段 |
| `test-transient-retry.mjs` | 离线 | **错误分类规则**（14 项断言）：401/402 → rotatePersist、429/502/503/504 → rotateCooldown、500 → retrySameKey、403 不命中、code 优先于 statusCode、规则可配置、`markApiKeyExhausted` 由 action 决定处置 |
| `test-keys.mjs` | 离线 | **Key 选择与状态**（18 项断言）：rotation 游标前移 / sticky 钉住 / single active、跳过不可用与冷却 key、single fallback 判定、store 增删改（冲突校验）、旧版单 key 迁移 |
| `test-rotation.mjs` | 离线 | **轮换循环**（7 项断言）：成功路径、402 换 key（持久化）、429 换 key（仅冷却）、500 不换 key（同 key 重试）、全部失败报错（脱敏）、取消立即抛出、single 余额不足降级 rotation |
| `test-banned-rotation.mjs` | 离线 | **Key 失效与轮换**（11 项断言）：401/402 命中轮换 + reason、500 不轮换、403 不命中、持久化 available=false、失效 key 被跳过、`REASON_TEXT`、自定义 errorRules |
| `test-vision-history.mjs` | 离线 | 跨轮视觉历史编解码 + 双 API 转换器闭环（含空 reasoning_content 回归） |
| `test-anthropic-tool-result-merge.mjs` | 离线 | Anthropic 连续工具结果合并（3 个并行 tool_use 结果合并为单条 user 消息） |
| `test-anthropic-image-index.mjs` | 离线 | Anthropic 图片索引按 part 顺序内联分配 |
| `test-anthropic-vision-order.mjs` | 离线 | Anthropic thinking 块置于 assistant 消息首位 |
| `test-image-dimensions.mjs` | 离线 | 图片尺寸解析（PNG/GIF/JPEG/WebP） |
| `test-sse-stream.mjs` | 离线 | 共享 SSE 流解析（`iterateSseEvents` / `consumeSseStream`） |
| `test-split-tool-call-args.mjs` | 离线 | 工具调用参数拼接/拆分/修复（18 项断言） |
| `test-batch-import.mjs` | 离线 | **批量导入解析器**（12 项断言）：`key---备注;` 格式、空字段、备注含分隔符、容错 |
| `test-cloud-sync-auto-push.mjs` | 离线 | **云同步 payload 去重**（14 项断言）：`syncPayloadHasChanged` 的空值/版本/长度/逐字段（value/label）/顺序分支，`undefined` 与 `""` 等价、`updatedAt` 不参与比较 |
| `test-cloud-sync-flow.mjs` | 离线 | **云同步 push/pull 集成**（21 项断言）：mock fetch + mock vscode 驱动真实 `pushToCloud`/`pullFromCloud`——push 新建/PATCH/无变更短路/空 store 警告、**push 记录服务端 `updated_at`**、pull 合并（label 覆盖 + 可用性保留 + 追加新 key）、静默跳过、缓存 gist 失效回退 |
| `test-cloud-sync-e2e.mjs` | 联网 | **云同步真实端到端**（`npm run test:e2e`）：真实 GitHub Gist API 驱动生产代码，验证请求体格式/响应结构/`updated_at`/内容往返。创建**专用测试 Gist**（描述带随机后缀）并在 finally 删除，**绝不触碰用户真实同步 Gist**；凭据从 `GITHUB_TOKEN`/`GH_TOKEN` 或 `gh auth token` 读取，无凭据时 SKIP 退出 0 |
| `test-model-diff.mjs` | 联网 | 内置清单 vs `/v1/models` 差异（内置清单从编译产物读取，不会脱节） |
| `test-vision-check.mjs` | 联网 | 视觉能力检查（生成合法 PNG 测图片输入） |

> **离线测试**与平台无关，应保持全绿。
> **联网测试**含平台专属假设（模型 ID、端点、错误语义），需真实 API Key。

## 运行

```bash
npm run compile

# 离线测试（无需 API Key）
npm run test:offline
# 或逐个运行
node test/test-transient-retry.mjs
node test/test-keys.mjs
node test/test-rotation.mjs
node test/test-banned-rotation.mjs
node test/test-vision-history.mjs
node test/test-anthropic-tool-result-merge.mjs
node test/test-anthropic-image-index.mjs
node test/test-anthropic-vision-order.mjs
node test/test-image-dimensions.mjs
node test/test-sse-stream.mjs
node test/test-split-tool-call-args.mjs
node test/test-batch-import.mjs
node test/test-cloud-sync-auto-push.mjs
node test/test-cloud-sync-flow.mjs

# 联网测试（需 API Key，从参数或环境变量读取）
node test/api-tests.mjs <API_KEY> [openai|anthropic|all]
PROVIDER_API_KEY=<key> node test/api-tests.mjs
PROVIDER_API_KEY=<key> node test/test-model-diff.mjs
PROVIDER_API_KEY=<key> node test/test-vision-check.mjs [MODEL_ID]
```

### 联网测试的模型覆盖

`api-tests.mjs` 的测试模型可用环境变量覆盖（默认值见脚本头部）：

| 环境变量 | 默认值 | 用途 |
|----------|--------|------|
| `PROVIDER_TEST_MODEL` | `DeepSeek-V4-Flash` | 主测试模型 |
| `PROVIDER_TEST_THINKING_MODEL` | `DeepSeek-V4-Flash` | 思考/effort 测试模型（建议用 `Qwen3.8-27B`，它恒产思考） |
| `PROVIDER_TEST_VISION_MODEL` | `DeepSeek-V4-Flash-Vision-Exp` | 图片输入测试模型（该模型 2026-10-23 退役，建议改用 `Qwen3.8-27B`） |

## 关键发现（平台差异，插件已适配）

> 详见 [`.copilot/api-reference.md`](../.copilot/api-reference.md)。

1. **思考机制与标准 OpenAI/DeepSeek 不同**：
   - `thinking` 参数**不被支持** → 400 `unsupported_parameter`（OpenAI）/ `invalid_request_error`（Anthropic）
   - 深度控制用 `reasoning_effort`（`none`/`low`/`medium`/`high`）
   - 思考内容在 **`reasoning`** 字段（OpenAI）/ **`thinking` 块**（Anthropic），`reasoning_content` 恒为 `null`
   - 思考是**模型固有属性**（Qwen3.8 恒思考、DeepSeek-V4 恒不思考），且深度**非确定性**

2. **不支持 Responses 协议**（`/v1/responses` 未实现）。

3. **`/models` 返回 `{data:[...]}` 包装**，非 chat 端点（`output_modalities` 非 `text` 或 `context_length=0`）需过滤。

4. **首字延迟可能长达 2 分钟** → 请求超时至少 5 分钟。

5. **429 属常态**（免费端点多用户共享并发）→ 多 key 轮询 + 瞬态整轮重试是必要的。
