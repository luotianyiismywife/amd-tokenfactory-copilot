# 重试与 Key 轮换配置指南

> 适用范围：聊天请求、Git 提交消息生成
> 相关代码：`src/provider/rotation.ts`、`src/provider/errors.ts`、`src/keys/config.ts`、`src/keys/health.ts`、`src/core/utils.ts`

本文档说明**请求失败后会发生什么**——是重试同一个 key、换一个 key、还是重跑整轮——以及如何通过设置调整这些行为。

---

## 1. 核心概念：两层重试 + errorRules 判定

请求失败后，扩展按**三个层次**处理，职责严格分离：

```
请求失败
  │
  ├─ ① HTTP 层重试（executeWithRetry，<prefix>.retry.*）
  │     同一请求退避重试，默认 2 次
  │     仅覆盖：网关错误（502/504）+ 网络错误
  │     ⚠️ 不覆盖 429/500/503（交给整轮层，避免两层相乘）
  │
  ├─ ② errorRules 判定（matchErrorRule，<prefix>.errorRules）
  │     四元组：code + message + statusCode + action，按数组顺序首个命中即生效
  │     code（错误体 error.code 精确匹配，主要字段）优先于 statusCode（HTTP 兜底）
  │     action=rotateCooldown → 换 key（仅内存冷却）
  │     action=rotatePersist  → 换 key（持久化 available=false）
  │     action=retrySameKey   → 不换 key，退避后重试同一个 key
  │
  └─ ③ 整轮层重试（tryTransientRetryRound，<prefix>.transientRetryTimes）
        全部 key 均因 rotateCooldown 失败 → 清冷却 + 退避 + 重跑整轮
        默认 3 次
```

### 1.1 关键区分：换 key vs 不换 key

| 错误 | 命中规则 | action | 行为 |
|------|----------|--------|------|
| **402 余额不足** | `code=INSUFFICIENT_BALANCE` / `statusCode=402` | `rotatePersist` | **换 key**（持久化 `available=false`） |
| **401 无效 Key** | `statusCode=401` | `rotatePersist` | **换 key**（持久化 `available=false`） |
| **封号（billing）** | `code=billing` | `rotatePersist` | **换 key**（持久化 `available=false`） |
| **429 限流** | `statusCode=429` | `rotateCooldown` | **换 key**（仅内存冷却，到期自动恢复） |
| **503 服务端繁忙** | `statusCode=503` | `rotateCooldown` | **换 key**（仅内存冷却） |
| **500 内部错误** | `statusCode=500` | `retrySameKey` | **不换 key**——退避后重试**同一个 key** |
| **上游流中断** | `code=upstream_stream_error` / `statusCode=400` | `retrySameKey` | **不换 key**——退避后重试**同一个 key** |
| **502/504 网关错误** | — | — | HTTP 层重试（同一请求） |
| **403 权限** | — | — | 直接报错，不重试不换 key |

> **为什么 500 不换 key**：500 Internal Server Error 是**平台问题**，不是 key 问题。换 key 无意义（所有 key 都会遇到同样的平台故障），只会白白消耗其他 key 的配额。正确做法是退避等待后重试同一个 key；重试次数用尽时抛出 `TransientRetryExhaustedError`（友好文案 + 原始错误后缀）。

> **为什么 429/503 既换 key 又重试**：这两个状态码命中 `rotateCooldown`。命中后标记当前 key 冷却并换下一个；若**所有** key 都因 429/503 失败 → 触发整轮重试（清冷却 + 退避 + 重跑）。

### 1.2 两个独立的重试计数器

轮换循环维护**两个互不干扰**的计数器，避免一种重试消耗另一种的配额：

| 计数器 | 触发场景 | 配置 |
|--------|----------|------|
| `wholeRoundRetryCount` | 全部 key 瞬态失败 / 无可用 key | `<prefix>.transientRetryTimes` |
| `sameKeyRetryCount` | 500 等平台侧错误（同 key 重试） | `<prefix>.transientRetryTimes` |

> 一次 500 重试**不会**消耗 429/503 的整轮重试配额，反之亦然。

---

## 2. 决策流程图

```
┌─────────────────────────────────────────────────────────────────┐
│ 轮换循环（runKeyRotationLoop）                                    │
│                                                                   │
│  while (true):                                                    │
│    if 所有 key 都已失败:                                          │
│        if 存在瞬态失败 且 整轮重试未达上限:                        │
│            → 清空瞬态冷却 + 指数退避 + 重跑整轮                    │
│        else:                                                      │
│            → 报错（列出每个 key 的脱敏 ID + 失败原因）             │
│                                                                   │
│    key = 选下一个可用 key（pickNextApiKey）                       │
│    if 无可用 key:                                                 │
│        single 模式 + 余额不足 → 降级 rotation 选下一个            │
│        仍无 → 存在瞬态冷却 key 且未达上限 → 重跑整轮              │
│              否则 → 报错                                          │
│                                                                   │
│    try:                                                           │
│        执行请求（含 HTTP 层重试）                                 │
│        成功 → 自愈置可用 + 返回                                   │
│    catch err:                                                     │
│        取消/超时 → 抛出                                           │
│                                                                   │
│        rule = matchErrorRule(err)           ← errorRules 四元组   │
│        if rule.action == rotateCooldown / rotatePersist:  ← 换 key│
│            标记 key 失效（冷却 / 持久化）                         │
│            continue（换下一个 key）                               │
│                                                                   │
│        if rule.action == retrySameKey:      ← 不换 key，同 key    │
│            if 同 key 重试未达上限:                                │
│                强制复用同一个 key + 退避 + continue               │
│            否则 → 抛 TransientRetryExhaustedError                 │
│                                                                   │
│        其他错误（403/网络/图片敏感）→ 抛出，不重试不换 key        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 配置项总表

> `<prefix>` 指设置前缀（当前 `amdtokenfactory`，移植时全局替换，见 `PLATFORM_PORTING.md` §1.2）。

### 3.1 错误分类（errorRules）

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.errorRules` | 见下 | 错误分类规则（四元组：code + message + statusCode + action）。按数组顺序匹配，首个命中即生效：`code`（错误体 error.code 精确匹配，**主要匹配字段**）优先于 `statusCode`（HTTP 状态码兜底）；`message` 仅作可读性说明**不参与匹配** |

默认规则（`src/keys/config.ts` 的 `DEFAULT_ERROR_RULES`）分两类，**移植时只需关注第二类**：

#### ① 标准 HTTP 兜底（`statusCode`，通用语义，通常无需改动）

| statusCode | action | 说明 |
|-----------|--------|------|
| `401` | `rotatePersist` | Unauthorized → 无效 key |
| `402` | `rotatePersist` | Payment Required → 余额不足 |
| `429` | `rotateCooldown` | Too Many Requests → 限流 |
| `503` | `rotateCooldown` | Service Unavailable → 服务端繁忙 |
| `400` | `retrySameKey` | Bad Request → 上游中断复用 400 |
| `500` | `retrySameKey` | Internal Server Error → 平台内部错误 |

> 这些是**通用 HTTP 语义**的合理默认映射，任何平台都适用。⚠️ 但"平台实际在什么情况下返回哪个码"仍是平台行为——移植后需按 `.copilot/api-reference.md` 的方法实测验证。

#### ② 平台专属 `code`（示例值，移植必改）

| code | action | 说明 |
|------|--------|------|
| `billing` | `rotatePersist` | 计费账户已被冻结（封号） |
| `upstream_stream_error` | `retrySameKey` | 上游模型流意外中断 |
| `INSUFFICIENT_BALANCE` | `rotatePersist` | 余额不足 |

> ⚠️ 这些 `code` 是**某平台（SenseAudio）实测的错误码**，纯平台行为。移植时按你平台错误响应体的 `error.code` 替换（无对应概念时删除该行）。

### 3.2 key 使用模式相关

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.apiKeyMode` | `sticky` | key 使用模式：`sticky`（固定一个，失效才换）/ `rotation`（轮询）/ `single`（仅当前 key） |
| `<prefix>.singleKeyFallback` | `switch` | `single` 模式下当前 key 不可用时的行为：`switch`（仅命中 `rotatePersist` 时自动切换）/ `error`（直接报错） |
| `<prefix>.apiKeyExhaustedCooldownMin` | `10` | 瞬态失效 key（`rotateCooldown`）的冷却时长（分钟）。0 = 立即恢复 |
| `<prefix>.transientRetryTimes` | `3` | 整轮重试次数（0-10）。指数退避 2s/4s/8s（上限 8s），重试前清空瞬态冷却。0 = 禁用 |

### 3.3 HTTP 层重试相关（同一请求）

| 设置 | 默认 | 说明 |
|------|------|------|
| `<prefix>.retry.enabled` | `true` | 启用 HTTP 层重试 |
| `<prefix>.retry.maxAttempts` | `2` | 每个请求的 HTTP 层重试次数（1-10）。**建议保持较小**——对同时出现在两个列表中的状态码，它会与 `transientRetryTimes` 相乘 |
| `<prefix>.retry.intervalMs` | `1000` | 首次重试前的基础延迟（毫秒）。后续每次翻倍（指数退避，上限 60s） |

> HTTP 层重试状态码**固定为网关错误（502/504）+ 网络错误**，不可配置（`src/core/utils.ts` 的 `RETRYABLE_STATUS_CODES`）。

---

## 4. 常见场景配置示例

### 4.1 默认配置（推荐）

```jsonc
{
  "amdTokenFactory.transientRetryTimes": 3,
  "amdTokenFactory.apiKeyExhaustedCooldownMin": 10,
  "amdTokenFactory.retry.enabled": true,
  "amdTokenFactory.retry.maxAttempts": 2
}
```

行为：`rotatePersist`（401/402/封号）换 key 并持久化失效；`rotateCooldown`（429/503）换 key 并冷却；`retrySameKey`（500/上游中断）不换 key、退避重试同一 key；全部 key 瞬态失败时整轮重试最多 3 次。

### 4.2 平台 500 频繁，希望更激进地重试

```jsonc
{
  "amdTokenFactory.transientRetryTimes": 5,          // 整轮重试 5 次
  "amdTokenFactory.retry.maxAttempts": 1             // HTTP 层不重试（避免相乘）
}
```

### 4.3 平台把 500 也当作 key 问题（罕见）

若你的平台确实用 500 表示"这个 key 有问题"，把它改为换 key：

```jsonc
{
  "amdTokenFactory.errorRules": [
    { "statusCode": 500, "message": "内部错误", "action": "rotatePersist" }
  ]
}
```

> ⚠️ 自定义 `errorRules` 会**整体替换**默认规则，需把需要的规则全部列出。

### 4.4 完全禁用整轮重试（快速失败）

```jsonc
{
  "amdTokenFactory.transientRetryTimes": 0
}
```

### 4.5 禁用 HTTP 层重试

```jsonc
{
  "amdTokenFactory.retry.enabled": false
}
```

### 4.6 自定义限流语义（平台用 403 表示限流）

```jsonc
{
  "amdTokenFactory.errorRules": [
    { "statusCode": 403, "message": "限流", "action": "rotateCooldown" },
    { "statusCode": 401, "message": "无效 key", "action": "rotatePersist" },
    { "statusCode": 402, "message": "余额不足", "action": "rotatePersist" },
    { "statusCode": 429, "message": "限流", "action": "rotateCooldown" },
    { "statusCode": 503, "message": "服务端繁忙", "action": "rotateCooldown" },
    { "statusCode": 500, "message": "内部错误", "action": "retrySameKey" }
  ]
}
```

---

## 5. 两层重试的相乘效应（重要）

HTTP 层重试（`retry.maxAttempts`）与整轮层重试（`transientRetryTimes`）**刻意不重叠**：HTTP 层只覆盖网关错误（502/504）+ 网络错误，整轮层覆盖 `rotateCooldown`（429/503）。因此默认配置下不会相乘。

若某状态码**同时**被两层覆盖（例如你自定义 `errorRules` 把 502 也设为 `rotateCooldown`），实际尝试次数为：

```
maxAttempts × (transientRetryTimes + 1)
```

**建议**：保持 `retry.maxAttempts` 较小（默认 2），并让平台错误（429/500/503）由整轮层处理（可换 key）。

---

## 6. 移植说明

本模块**与平台无关**，直接复用。移植时按新平台的错误语义调整默认值：

1. **错误分类规则**：`src/keys/config.ts` 的 `DEFAULT_ERROR_RULES`——`code` 默认值是示例，按你平台的错误码替换；`statusCode` 兜底为通用 HTTP 语义，通常无需改动
2. **HTTP 层重试状态码**：`src/core/utils.ts` 的 `RETRYABLE_STATUS_CODES`（默认 `[502, 504]`，按设计固定）

> 排查方法见 `.copilot/api-reference.md`——用真实请求触发各类错误，记录状态码与响应体，据此调整上述默认值。

---

## 7. 相关文档

- [`multi-api-key-design.md`](multi-api-key-design.md) — 多 Key 轮换与失效切换的完整设计
- [`plan-usage-design.md`](plan-usage-design.md) — 套餐用量与余额显示
- `PLATFORM_PORTING.md` §2 — 平台行为差异排查清单（含限流特征）
