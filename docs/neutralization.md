# 中性化占位符与批量移植

> 适用范围：把脚手架移植到具体平台时的**批量文本替换**
> 相关脚本：`scripts/dev/port.mjs`
> 相关文档：[`PLATFORM_PORTING.md`](../PLATFORM_PORTING.md)（分步移植指南）

脚手架使用**中性占位符**（`amdtokenfactory` / `example.com` / `example-model`），不含任何真实平台信息。移植时把这些占位符一次性替换为你平台的值即可。

本文档列出**全部占位符**及其出现位置，并提供**一键批量替换脚本**。

---

## 1. 占位符总表

| 类别 | 占位符 | 替换为 | 主要出现位置 |
|------|--------|--------|--------------|
| **扩展包名** | `amdtokenfactory` | 你的包名（如 `myplatform-copilot`） | `package.json` → `name` |
| **显示名** | `Copilot Provider Scaffold` | 你的显示名（如 `MyPlatform Provider`） | `package.json` → `displayName`；`package.nls*.json` → `providerDisplayName` / `config.title` / `walkthrough.title` |
| **vendor / 前缀** | `amdtokenfactory` | 你的平台标识（如 `myplatform`） | `package.json` → `vendor` / 命令 ID / 设置键；全部 `src/**/*.ts`；`resources/walkthrough/*.md` |
| **API 根地址** | `https://api.example.com/v1/` | 你的 OpenAI 兼容 API 根地址 | `src/platform/platformConfig.ts` → `API_BASE_URL` |
| **用户中心端点** | `https://platform.example.com/api/user/self` | 你的账号信息端点（无则留空） | `src/platform/platformConfig.ts` → `PLATFORM_USER_SELF_URL` |
| **官网域名** | `https://example.com` | 你的官网 | `src/platform/platformConfig.ts` → `LOGIN_TOKEN_SOURCE_HINT`；`resources/walkthrough/*.md`（获取密钥链接） |
| **平台固定头** | `x-product: Example` | 你的域校验头（无则删） | `src/platform/platformConfig.ts` → `PLATFORM_HEADERS` |
| **环境变量前缀** | `PROVIDER_` | 你的前缀（如 `MYPLATFORM_`） | `test/*.mjs` |
| **示例模型 ID** | `example-model` | 你的模型 ID | `src/models/models.ts`；`package.json` 默认值；`src/platform/platformConfig.ts` → `FALLBACK_TEST_MODEL_ID`；`test/*.mjs` |

> **注意**：`amdtokenfactory` 同时充当**包名**、**vendor id**、**命令前缀**、**设置键前缀**。移植时通常全部替换为同一个平台标识（如 `myplatform`），但包名可以是更长的 `myplatform-copilot`。若两者不同，先替换包名再替换前缀。

---

## 2. 一键批量替换（推荐）

`scripts/dev/port.mjs` 按上表做全局文本替换（**只改文本，不改逻辑**）：

```bash
node scripts/dev/port.mjs \
  --vendor   myplatform \
  --name     myplatform-copilot \
  --display  "MyPlatform Provider" \
  --api-base "https://api.myplatform.com/v1/" \
  --home     "https://myplatform.com" \
  --user-self "https://platform.myplatform.com/api/user/self" \
  --model    my-model
```

| 参数 | 说明 | 必填 |
|------|------|:---:|
| `--vendor` | 平台标识（vendor id / 命令前缀 / 设置键前缀） | ✅ |
| `--name` | 扩展包名（`package.json` 的 `name`） | ✅ |
| `--display` | 显示名 | ✅ |
| `--api-base` | OpenAI 兼容 API 根地址（以 `/` 结尾） | ✅ |
| `--home` | 官网地址 | ✅ |
| `--user-self` | 用户中心端点（无则传 `""`） | ✅ |
| `--model` | 示例模型 ID（替换 `example-model`） | ❌ |
| `--dry-run` | 只打印将修改的文件，不写入 | ❌ |

**建议先 `--dry-run` 预览**，确认无误后再正式执行：

```bash
node scripts/dev/port.mjs --vendor myplatform ... --dry-run
```

执行后：

```bash
npm run compile   # 编译 + 设置项一致性核对
npm run audit     # 7 项审计
```

---

## 3. 手动替换（脚本不覆盖的部分）

脚本只处理上表的占位符。以下内容需**手动**按平台调整：

| 内容 | 位置 | 说明 |
|------|------|------|
| **内置模型清单** | `src/models/models.ts` → `BUILT_IN_MODELS` | 替换为你的模型（`baseId` / `displayName` / `vision` / `thinkingMode` / `contextLength` / `maxTokens`） |
| **视觉能力兜底** | `src/models/visionModels.ts` → `HARDCODED_VISION` | 填入你平台自研模型的视觉能力（可留空） |
| **错误分类规则** | `src/keys/config.ts` → `DEFAULT_ERROR_RULES` | 四元组（code + message + statusCode + action）。`code` 默认值是平台专属示例，按你平台错误响应体的 `error.code` 替换；`statusCode` 兜底为通用 HTTP 语义，通常无需改动（见 [`retry-and-key-rotation.md`](retry-and-key-rotation.md) §3.1） |
| **欢迎页文案** | `resources/walkthrough/*.md` | 平台名与说明 |
| **本地化文案** | `src/core/localize.ts` + `package.nls*.json` | 平台专属文案 |

---

## 4. 有意保留的示例（不替换）

以下文件**故意保留示例内容**，供移植时参考，**不参与批量替换**：

| 文件 | 说明 |
|------|------|
| `.copilot/api-reference.md` | 平台 API 实测参考的**示例**（演示如何探测新平台：端点、字段、错误语义）。移植时按同样方法生成你平台的参考 |
| `docs/*.md` | 设计文档中的示例说明（如单位换算教训） |
| `test/README.md` | 联网测试的平台差异说明（示例） |

> `scripts/dev/port.mjs` 的 `EXCLUDE` 规则会跳过 `.copilot/`、`node_modules/`、`out/`、`.git/`。

---

## 5. 替换后自检清单

- [ ] `npm run compile` 通过（含设置项一致性核对）
- [ ] `npm run audit` 无问题（设置漂移 / 未使用导出 / 命令声明 / 文档路径等）
- [ ] `npm run test:offline` 全绿（离线测试与平台无关）
- [ ] 全局搜索确认无残留占位符：`amdtokenfactory` / `example.com` / `example-model` / `Copilot Provider Scaffold`
- [ ] `package.json` 的 `vendor` 与 `src/extension.ts` 的 `registerLanguageModelChatProvider(<vendor>, ...)` 一致
- [ ] `src/vision/imageProxy.ts` 的 `PROVIDER_VENDOR` 与上述 vendor 一致
- [ ] 按 [`PLATFORM_PORTING.md`](../PLATFORM_PORTING.md) §2 逐项实测平台行为差异

---

## 6. 相关文档

- [`PLATFORM_PORTING.md`](../PLATFORM_PORTING.md) — 分步移植指南（必改项 / 差异排查 / 可裁剪模块）
- [`retry-and-key-rotation.md`](retry-and-key-rotation.md) — 重试与 Key 轮换配置
- [`multi-api-key-design.md`](multi-api-key-design.md) — 多 Key 轮换设计
- [`plan-usage-design.md`](plan-usage-design.md) — 套餐用量与余额显示
