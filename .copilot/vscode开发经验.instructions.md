---
description: "Use when: 需要操作浏览器（市场上传/审核、GitHub Release 创建等网页操作）、配置或排查 VS Code MCP（Model Context Protocol）、以及文档需随现实变化同步更新时参考"
---

# VS Code 开发经验 · 通用手册（amd-tokenfactory-copilot）

> **用途**：记录 VS Code 开发环境的通用经验，包括**浏览器自动化操作**（市场上传、GitHub Release 等）、**MCP 配置与排障**、以及**文档同步更新约定**。
> **来源**：从 [tokenrhythm-copilot](https://github.com/luotianyiismywife/tokenrhythm-copilot) 的 `.copilot/vscode开发经验.instructions.md` 移植（2026-09-06），发布产物名已适配本扩展。
> **更新原则**：现实环境变化（VS Code 升级、市场审核流程变化、MCP 服务器新增/删除等）后，必须同步修改本文档。

---

## 一、浏览器自动化操作经验（Copilot 内置浏览器工具）

> Copilot 在 VS Code 中有内置浏览器（`open_browser_page` / `click_element` / `type_in_page` / `run_playwright_code` 等工具），可用于登录第三方网站、上传扩展、创建 Release 等操作。

### 1.1 通用操作要点

| 要点 | 说明 |
|------|------|
| **登录页需用户手动** | 涉及账号密码（GitHub / Microsoft）的登录**必须由用户亲自完成**，Copilot 不能代输密码（安全红线）。Copilot 打开页面后，提示用户登录，登录完再继续 |
| **登录态不跨页面共享** | 每次 `open_browser_page` 新开的浏览器页**不保留**之前的登录 cookie。**例外（已验证）**：同一浏览器会话内 GitHub 与市场登录态**共享**——市场登录页点「使用 GitHub 登录」即可免密登录（流程见 1.2）。切换新页面/新会话需重新登录 |
| **复用已登录页面跳转（推荐）** | 需要打开同站点新 URL 时，**不要 `open_browser_page` 新开页**（会丢登录态），直接对用户已共享的已登录页用 `navigate_page`（type=url）跳转，登录态保留。**已验证**：把已登录的 GitHub 页面直接重定向到 `releases/new?tag=vX.Y.Z`，免登录完成 Release 创建 |
| **⚠️ 不要丢弃已登录页面** | 发布流程中用户手动登录后，**绝对不要用 `open_browser_page` 新开页**（新页无登录态，会导致重新走完整登录流程）。**始终复用当前已登录的页面**，用 `navigate_page` 跳转到目标 URL。**教训**：GitHub Release 创建后用 `open_browser_page` 新开市场上传页，丢失了 GitHub 登录态，市场「使用 GitHub 登录」按钮点击无效，用户被迫重新手动登录。正确做法：直接在已登录页面 `navigate_page` 到市场管理页 |
| **⚠️⚠️ pageId 与页面可能映射错乱** | 用户同时开 GitHub + 市场两个页面时，**附件快照里登记的 (pageId → 标题/URL) 可能与浏览器实际标签不一致**。**必须每次以 `read_page` 返回的 `Page Title` + `URL` 为准**，确认该 pageId 当前到底对应哪个页面后再操作。**教训**：在两个页面同时打开时，绝不可凭附件快照的登记信息选择 pageId 做 `navigate_page`，否则会覆盖掉另一个已登录页面；若某 pageId 的 `read_page` 结果与登记不一致，停下来向用户确认，不要盲目导航 |
| **元素点击超时** | 微软/谷歌系页面（marketplace、reCAPTCHA）的按钮常因动画/iframe 导致 `click_element` 超时。**解决方案**：用 `run_playwright_code` + `page.evaluate(() => btn.click())` 强制触发 JS 点击 |
| **iframe 内元素** | reCAPTCHA 验证框、部分对话框在 iframe 内，快照里可见但需用户手动交互（如"选择包含小轿车的图片"） |
| **文件上传** | 优先用 `page.setInputFiles('input[type=file]', '绝对路径')` 直接设文件（如市场上传 VSIX）。GitHub Release 附件用 `waitForEvent('filechooser')` + `chooser.setFiles()` |
| **上传后状态** | 市场上传后显示 `Verifying <版本>`，需等待审核（通常数小时）；reCAPTCHA 验证通过后上传自动继续 |
| **reCAPTCHA 依赖 google.com 可达性** | 市场上传的 reCAPTCHA 验证需要访问 `www.google.com/recaptcha/...`。**中国大陆网络无法直接访问 google.com**，会报 `无法连接到 reCAPTCHA 服务` / `net::ERR_ABORTED` / `ERR_BLOCKED_BY_ORB`。此时**内置浏览器刷新无效**，需：① 开代理后重试，或 ② 直接用外部浏览器（Chrome/Edge，已配代理插件）手动上传 |

### 1.2 VS Code 市场（Marketplace）上传流程

1. 打开 `https://marketplace.visualstudio.com/manage/publishers/luotianyiismywife` → 用户登录（推荐点「使用 GitHub 登录」按钮免密登录，见下方 ✅ 已验证说明）
2. 在扩展列表行点 **More Actions...**（`button[aria-label="More Actions..."]`）→ **Update**（首次发布走 **New Extension** 上传 vsix）
3. 上传对话框出现：`page.setInputFiles('#file-upload', 'amd-tokenfactory-copilot-<version>.vsix')`
4. 点击 **Upload** → 出现 reCAPTCHA 验证（**需用户手动完成**）→ 验证后自动上传
5. 列表显示 `Verifying <新版本>` → 等待审核通过

> ✅ **已验证：市场登录页点「使用 GitHub 登录」可免密登录**——Microsoft 登录页（`login.microsoftonline.com`，URL 带 `githubsi=true`）有「使用 GitHub 登录」按钮。**注意**：① `githubsi=true` 参数**不会**自动跳 GitHub 授权，必须**手动点击**该按钮；② 该按钮是 JS 事件绑定，**`click_element` 会超时/失败，必须用 `run_playwright_code` + `page.evaluate(() => btn.click())` 强制触发**；③ **该按钮不是 `<button>` 元素，而是 Knockout 绑定的 `div[role=button][aria-label="使用 GitHub 登录"]`**——`querySelectorAll('button')` 找不到它（会误报 not found），必须用 `document.querySelector('div[aria-label="使用 GitHub 登录"]')` 精准选择（2026-09-06 v1.1.0 发布实测）。完整流程：JS 点击按钮 → 跳 `github.com/login/oauth/authorize`（GitHub 已登录则自动回跳）→ `login.live.com/HandleGithubResponse.srf` → 「保持登录状态?」确认页 → 点「是」→ 进入市场管理页。GitHub 与市场登录态在同一浏览器会话内**共享**；但**新开浏览器页/新会话仍要求重新登录**。

> ⚠️ **教训**：市场上传的 reCAPTCHA 验证在**内置浏览器中无法完成**（2026-09-14 v1.2.0 深度排查定论）。直接改用**外部浏览器（Chrome/Edge，配代理插件）手动上传**。
>
> **根因（对照实验定论，修正早前"网络层+CSP 双层阻断"的误判）**：
> - ❌ 网络层**不是**问题：内置浏览器**顶层导航** google.com 成功（api.js、anchor 页面均加载出真实内容）；curl/Node 显式走代理也通。Chromium 代理解析完全正常——配 `http.proxy` 也没用。
> - ❌ 市场 CSP 只拦 `connect-src`（不含 google.com，杀掉 recaptcha 脚本内部的 fetch `api2/clr`）；但 `frame-src` 是 `*` 通配，**不拦 iframe**。
> - ✅ **真正病灶：内置浏览器对跨站 iframe 嵌入静默挂起**。决定性对照（在无 CSP 的 example.com 上注入 iframe）：google recaptcha anchor 与 microsoft.com 均"无 load 事件、无网络错误"地挂死；而 bing/github 的 iframe 是响应到达后被对方 `X-Frame-Options`/`frame-ancestors` 拒绝（反证网络通）。这是 Electron 会话层的第三方 iframe 策略。
> - reCAPTCHA 验证必须跑在跨站 iframe 里 → 当前引擎无解。文件选择不受影响（`setInputFiles('#file-upload')` 正常、Upload 按钮可用），卡的只是验证环节。
> - **版本相关性（重要）**：此行为**随 VS Code 更新而变**——09-06（v1.1.0 发布日）reCAPTCHA iframe 在内置浏览器里正常弹出并完成验证；09-10 VS Code 自动更新到 1.137.0（Electron/Chromium 更换）；09-14 起同流程 iframe 全部静默挂死。**每次 VS Code 升级后值得重测一次**：若新引擎恢复了 iframe，可回到内置浏览器流程；上传前先在 example.com 上注入一个 google iframe 测 30 秒能否 load 即可判定。
>
> ✅ **已验证：2026-09-18（v1.2.1 发布）内置浏览器上传流程恢复可用**——reCAPTCHA iframe 重新渲染（badge 显示"超出免费配额"提示），点 Upload 后走**无感验证**直接通过，无需人工交互。控制台会刷 `api2/clr` 被 CSP 拦截 + `reCAPTCHA Timeout (g)` 报错，但那只是遥测上报，**不影响验证与上传**（列表随即显示 `Verifying <新版本>`）。判定要点：Upload 后若对话框变为 "Uploading file ..." 且几十秒内列表出现 Verifying 即成功；若卡在验证挑战 iframe 无响应才是 09-14 式挂死。
> ⚠️ **关键教训**：vsix 打包必须**包含 dependencies**！用 `npx vsce package`（**不要加 `--no-dependencies`**），否则插件装不上 node_modules，用户激活直接崩溃（报"命令未找到"）。本扩展当前无运行时 dependencies（纯 VS Code API），但仍保持默认打包行为。打包后务必 `npx vsce ls` 确认 `out/` 齐全。

### 1.3 GitHub Release 创建流程

1. 打开 `https://github.com/luotianyiismywife/amd-tokenfactory-copilot/releases/new?tag=vX.Y.Z&title=vX.Y.Z` → 用户登录 GitHub
2. 填好 tag / 标题 / 描述（URL 参数可预填）
3. 二进制附件上传（vsix 等）：
   ```js
   const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
   // 点击 "Attach binaries by dropping them here or selecting them" 按钮
   const chooser = await chooserPromise;
   await chooser.setFiles('绝对路径\\amd-tokenfactory-copilot-<version>.vsix');
   ```
   > ⚠️ **注意**：vsix 不能拖进正文编辑器（GitHub 不支持该类型作为正文附件），必须走**二进制附件区**（页面底部）。
   > ✅ **已验证流程（2026-09-06 v1.1.0）**：①「Attach binaries」按钮 `getByRole().click()` 会超时，需 JS 强制点击；② 点击后若改用 `page.setInputFiles('input[type=file]', ...)` 会命中**正文编辑器**的隐藏 input，报 422 "We don't support that file type"——必须用 `waitForEvent('filechooser')` + `chooser.setFiles()` 走 filechooser 事件；③ 上传成功后附件区显示文件名 + `(0.05 MB)`，同时页面自动存草稿（"A draft of this release has been saved!"），此时再点 Publish release。
4. 点击 **Publish release**

### 1.4 版本号与发布命名规则（重要）

> **历史教训**：曾打包为 `extension.vsix`（vsce 默认输出名），但正确的发布产物命名必须是 **`<扩展名>-<版本号>.vsix`**（如 `amd-tokenfactory-copilot-1.0.0.vsix`），否则与历史 release 下载链接的附件名不一致。

| 项目 | 规则 |
|------|------|
| **打包输出名** | 固定为 **`<name>-<version>.vsix`**（如 `amd-tokenfactory-copilot-1.0.0.vsix`）：`npx vsce package -o amd-tokenfactory-copilot-<version>.vsix`。**不要用 vsce 默认的 `extension.vsix`** |
| **name/version 来源** | `package.json` 的 `name` 字段（`amd-tokenfactory-copilot`）+ `version` 字段（如 `1.0.0`） |
| **GitHub Release 附件** | 上传 `<name>-<version>.vsix`，下载链接即 `.../releases/download/<tag>/<name>-<version>.vsix` |
| **tag 格式** | `vX.Y.Z`（如 `v1.0.0`），指向对应版本提交 |
| **版本号语义** | 现有功能调整 / 修 bug → 只升 z（patch）；新增功能 → 升 y（minor）；完全重构（不向后兼容）→ 升 x（major） |
| **版本号占用检查** | 打包/发布前必须确认：`git tag -l "v*"` 看最新 tag，**不能在已发布的 tag 上重复发布同版本**（市场拒绝同版本重复上传；GitHub Release 可覆盖但不应依赖） |
| **发布后产物位置** | 本地根目录 `<name>-<version>.vsix`（`.gitignore` 已忽略，不入库）；release 附件由浏览器流程上传 |

### 1.4b 发布检查清单（每次发布前）

```powershell
# 0. 同步仓库（必须先做！）：提交并推送所有源码/文档改动，避免 tag/release 指向不完整代码
git status --short            # 确认无未提交改动
git add <改动的文件> && git commit -m "..." && git push origin main
# 1. 确认版本号未被占用（对比 package.json version 与最新 tag）
git tag -l "v*" | Sort-Object -Descending | Select-Object -First 3
# 2. 检查远端是否已有同名 tag（本地可能滞后）
git ls-remote --tags origin | Select-String "<version>"
# 3. 打包并验证内容（输出名必须为 <name>-<version>.vsix；先删 out/ 避免 tsc 孤儿文件残留）
Remove-Item -Recurse -Force out
npm run compile
npx vsce package -o amd-tokenfactory-copilot-<version>.vsix
npx vsce ls   # 确认 out/ 齐全、无 src/ 泄漏
# 4. 打 tag 并推送（确保 tag 指向含完整实现的提交）
git tag v<version> && git push origin v<version>
# 5. 发布（浏览器流程）
#    - GitHub: releases/new?tag=vX.Y.Z，附件用 amd-tokenfactory-copilot-<version>.vsix
#    - 市场: 上传 amd-tokenfactory-copilot-<version>.vsix
```

> ⚠️ **教训**：曾只提交 `package.json`+`CHANGELOG.md` 就 push tag，导致 tag 指向不含实现源码的提交（`src/` 多个文件漏提交）。**必须先 `git status` 确认所有源码已提交**，再打 tag 发布。

> ⚠️ **本扩展专属教训（2026-09-06）**：tsc **不会自动清理 out/ 孤儿产物**——删除源码模块（如 gitCommit/、tokenizer/）后，out/ 里仍残留旧 js 文件并被 vsce 打进包。**每次打包前先 `Remove-Item -Recurse -Force out` 再 compile**。

### 1.5 常见问题排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 点击无反应/超时 | 微软系页面按钮事件绑定在 React 上 | `page.evaluate(() => 元素.click())` |
| 找不到元素 | 快照 ref 过期（页面已变） | 重新 `read_page` 获取新 ref |
| reCAPTCHA 卡住 | 反机器人验证必须真人操作 | 提示用户在 iframe 中完成图片验证 |
| 上传失败 | vsix 缺依赖 / 版本号冲突 / 附件名不符合规则 | 检查 `vsce ls`；市场不能重复上传同版本；附件名必须是 `<name>-<version>.vsix`（见 1.4） |

---

## 二、VS Code MCP（Model Context Protocol）

> MCP 让 VS Code / Copilot 通过标准协议接入外部工具服务器（GitHub、数据库、文件系统等）。

### 2.1 MCP 配置文件位置

| 级别 | 位置 | 说明 |
|------|------|------|
| 用户级 | `%APPDATA%\Code\User\mcp.json` | 全用户生效（一般各机器独立配置） |
| 工作区级 | `<项目>/.vscode/mcp.json` | 仅当前工作区生效（随仓库同步，多机器一致） |
| 设置项 | `chat.mcp.gallery.enabled` | VS Code 设置中的 MCP 市场开关（按需开启） |

### 2.2 MCP 配置格式（参考）

```jsonc
// .vscode/mcp.json 或 用户 mcp.json
{
  "servers": {
    "my-server": {
      "type": "stdio",                 // stdio | sse | http
      "command": "npx",                // 启动命令
      "args": ["-y", "@some/mcp-server"],
      "env": { "KEY": "value" }        // 可选环境变量
    }
  }
}
```

### 2.3 排障要点

1. **配置了但 Copilot 不识别**：检查文件是否在正确位置（`.vscode/mcp.json`），VS Code 可能需要重载窗口（`Developer: Reload Window`）
2. **stdio 服务器启动失败**：在终端手动运行 `command args` 看报错；确认 `npx` / `node` 在 PATH 中
3. **环境变量不生效**：`env` 里不要放敏感信息（API key 等）到共享文件；确认变量名大小写
4. **MCP 工具未出现在工具列表**：确认 VS Code 版本支持（1.100+ 完善支持），检查输出面板的 MCP 日志
5. **本项目（amd-tokenfactory-copilot）**：默认未配置任何 MCP 服务器；若某台机器新增，需在**本节登记**，多机器间保持一致

---

## 三、文档同步更新约定（重要）

> **现实环境变化后，必须同步修改本文档及相关文件**，保持文档与真实环境一致。

### 触发时机

- VS Code 大版本升级（如 1.131 → 1.132）
- 市场上传/审核结果变化（新版本通过/被拒）
- MCP 服务器新增/删除/迁移
- AMD 端点行为变化（错误格式、模型清单、限流规则——同步到 `api-reference.md`）
- 依赖升级（`@types/vscode`、`typescript` 等）
- 浏览器自动化流程变化（marketplace 改版等）

### 需要同步更新的文件

| 文件 | 更新内容 |
|------|---------|
| 本文档（`vscode开发经验.instructions.md`） | 浏览器流程、MCP、文档同步约定、本表 |
| `api-reference.md` | AMD 端点行为、模型清单、错误格式、踩坑记录 |
| `README.md` | 功能/设置项/模型清单变化 |

### 流程

1. 现实变化发生 → 立即记录到本文档对应小节
2. 涉及端点行为 → 同步更新 `api-reference.md`
3. 更新后告知用户"文档已同步"
