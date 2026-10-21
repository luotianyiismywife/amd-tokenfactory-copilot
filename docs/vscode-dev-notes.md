---
description: "Use when: 需要操作浏览器（市场上传/审核、GitHub Release 创建等网页操作）、配置或排查 VS Code MCP（Model Context Protocol）、查看开发环境约定（VS Code 版本/Profile 架构/常用命令），以及文档需随现实变化同步更新时参考"
---

# VS Code 开发经验 · 通用手册

> **用途**：记录 VS Code 开发环境的通用经验，包括**浏览器自动化操作**（市场上传、GitHub Release 等）、**MCP 配置与排障**、以及**文档同步更新约定**。本项目可能同时在多台机器上开发，本文档内容应保持**机器无关**，不要写入具体机器相关的路径/版本。
> **更新原则**：现实环境变化（VS Code 升级、市场审核流程变化、MCP 服务器新增/删除、Profile 结构变化等）后，必须同步修改本文档。

---

## 一、浏览器自动化操作经验（Copilot 内置浏览器工具）

> Copilot 在 VS Code 中有内置浏览器（`open_browser_page` / `click_element` / `type_in_page` / `run_playwright_code` 等工具），可用于登录第三方网站、上传扩展、创建 Release 等操作。

### 1.1 通用操作要点

| 要点 | 说明 |
|------|------|
| **登录页需用户手动** | 涉及账号密码（GitHub / Microsoft）的登录**必须由用户亲自完成**，Copilot 不能代输密码（安全红线）。Copilot 打开页面后，提示用户登录，登录完再继续 |
| **登录态不跨页面共享** | 每次 `open_browser_page` 新开的浏览器页**不保留**之前的登录 cookie。**例外（已验证 2026-08-09 / 2026-08-14）**：同一浏览器会话内 GitHub 与市场登录态**共享**——市场登录页点「使用 GitHub 登录」即可免密登录（流程见 1.2）。切换新页面/新会话需重新登录 |
| **复用已登录页面跳转（推荐）** | 需要打开同站点新 URL 时，**不要 `open_browser_page` 新开页**（会丢登录态），直接对用户已共享的已登录页用 `navigate_page`（type=url）跳转，登录态保留。**已验证（2026-08-18 v1.10.0 发布）**：把已登录的 GitHub issue 页直接重定向到 `releases/new?tag=v1.10.0`，免登录完成 Release 创建 |
| **⚠️ 不要丢弃已登录页面** | 发布流程中用户手动登录后，**绝对不要用 `open_browser_page` 新开页**（新页无登录态，会导致重新走完整登录流程）。**始终复用当前已登录的页面**，用 `navigate_page` 跳转到目标 URL。**教训（2026-08-24 v1.11.0 发布）**：GitHub Release 创建后用 `open_browser_page` 新开市场上传页，丢失了 GitHub 登录态，市场「使用 GitHub 登录」按钮点击无效，用户被迫重新手动登录。正确做法：直接在已登录页面 `navigate_page` 到市场管理页 |
| **⚠️⚠️ pageId 与页面可能映射错乱（2026-08-25 v1.11.1 发布教训）** | 用户同时开 GitHub + 市场两个页面时，**附件快照里登记的 (pageId → 标题/URL) 可能与浏览器实际标签不一致**：本次 `0b2e1835` 登记为市场页但 `read_page` 一直返回 GitHub v1.11.0 Release 内容，`b4cac6fe` 登记为 GitHub Release 页但实际是市场页（我在上面完成了市场上传）。**必须每次以 `read_page` 返回的 `Page Title` + `URL` 为准**，确认该 pageId 当前到底对应哪个页面后再操作。**教训**：我在 `b4cac6fe`（实际是市场页）上用 `navigate_page` 导航到 issue #3，直接覆盖了市场页，用户被迫点回退恢复——**在两个页面同时打开时，绝不可凭附件快照的登记信息选择 pageId 做 `navigate_page`**，否则会覆盖掉另一个已登录页面；若某 pageId 的 `read_page` 结果与登记不一致，停下来向用户确认，不要盲目导航 |
| **元素点击超时** | 微软/谷歌系页面（marketplace、reCAPTCHA）的按钮常因动画/iframe 导致 `click_element` 超时。**解决方案**：用 `run_playwright_code` + `page.evaluate(() => btn.click())` 强制触发 JS 点击 |
| **iframe 内元素** | reCAPTCHA 验证框、部分对话框在 iframe 内，快照里可见但需用户手动交互（如"选择包含小轿车的图片"） |
| **文件上传** | 优先用 `page.setInputFiles('input[type=file]', '绝对路径')` 直接设文件（如市场上传 VSIX）。GitHub Release 附件用 `waitForEvent('filechooser')` + `chooser.setFiles()` |
| **上传后状态** | 市场上传后显示 `Verifying <版本>`，需等待审核（通常数小时）；reCAPTCHA 验证通过后上传自动继续 |
| **reCAPTCHA 依赖 google.com 可达性** | 市场上传的 reCAPTCHA 验证需要访问 `www.google.com/recaptcha/...`。**中国大陆网络无法直接访问 google.com**，会报 `无法连接到 reCAPTCHA 服务` / `net::ERR_ABORTED` / `ERR_BLOCKED_BY_ORB`（console 另见 CSP `connect-src` 拦截，均指向 google.com 不可达）。此时**内置浏览器刷新无效**，需：① 开代理后重试，或 ② 直接用外部浏览器（Chrome/Edge，已配代理插件）手动上传 |

### 1.2 VS Code 市场（Marketplace）上传流程

1. 打开 `https://marketplace.visualstudio.com/manage/publishers/<publisherId>` → 用户登录（推荐点「使用 GitHub 登录」按钮免密登录，见下方 ✅ 已验证说明）
2. 在扩展列表行点 **More Actions...**（`button[aria-label="More Actions..."]`）→ **Update**
3. 上传对话框出现：`page.setInputFiles('#file-upload', 'xxx.vsix')`
4. 点击 **Upload** → 出现 reCAPTCHA 验证（**需用户手动完成**）→ 验证后自动上传
5. 列表显示 `Verifying <新版本>` → 等待审核通过

> ✅ **已验证（2026-08-09 / 2026-08-14）：市场登录页点「使用 GitHub 登录」可免密登录**——Microsoft 登录页（`login.microsoftonline.com`，URL 带 `githubsi=true`）有「使用 GitHub 登录」按钮。**注意**：① `githubsi=true` 参数**不会**自动跳 GitHub 授权，必须**手动点击**该按钮；② 该按钮是 JS 事件绑定（`click: $fedCredButtonsControl.fedCredButton_onClick`），**`click_element` 会超时/失败，必须用 `run_playwright_code` + `page.evaluate(() => btn.click())` 强制触发**。完整流程：JS 点击按钮 → 跳 `github.com/login/oauth/authorize`（GitHub 已登录则自动回跳）→ `login.live.com/HandleGithubResponse.srf` → 「保持登录状态?」确认页（显示绑定的 Microsoft 账号，如 `azhe-hjm@outlook.com`）→ 点「是」→ 进入市场管理页（账号显示「天依 洛 (azhe-hjm@outlook.com)」）。GitHub 与市场登录态在同一浏览器会话内**共享**，GitHub 登录后市场无需再次登录；但**新开浏览器页/新会话仍要求重新登录**。

> ⚠️ **教训（2026-08-10 v1.6.3）**：市场上传的 reCAPTCHA 验证**必须能访问 google.com**。中国大陆网络下内置浏览器会报"无法连接到 reCAPTCHA 服务"（`google.com/recaptcha/api2/clr` 被 CSP `connect-src` 拦截 + `ERR_ABORTED`/`ERR_BLOCKED_BY_ORB`），**刷新无效**。此时应**改用外部浏览器（Chrome/Edge，配代理插件）手动上传**，或开代理后重试内置浏览器。

> ⚠️⚠️ **VS Code 1.138 内置浏览器无法上传市场（2026-09-21 v1.0.0 发布实测）**：即使代理可达 google.com，内置浏览器仍无法完成市场上传，**双重限制**：
> 1. **页面级 CSP 拦截**：marketplace 页面的 CSP `connect-src` 白名单无 google.com，reCAPTCHA 回调（`api2/clr`）被浏览器 CSP 硬拦。**可绕过**：CDP `Page.setBypassCSP`（`const cdp = await page.context().newCDPSession(page); await cdp.send('Page.setBypassCSP', { enabled: true });`）——验证有效，fetch google.com 不再被拦；但 **reload 后需重新设置**（CDP session 失效）。
> 2. **reCAPTCHA iframe 网络层**：绕过 CSP 后 `api2/anchor`（widget 加载）仍持续 `ERR_ABORTED`——reCAPTCHA iframe 根本不渲染（页面无 google.com iframe），手动 `grecaptcha.render()` 能建 widget 但 `execute()` 拿不到 token（iframe 内部网络栈不受页面级 CDP 控制）。**此层无法绕过**。
> 3. **结论**：内置浏览器上传市场这条路在 1.138 已死（此前版本可行，疑似 VS Code 更新引入更严格的 iframe 隔离）。**替代方案：Firefox Nightly + Marionette MCP**（见 1.2b）。

> ✅ **内置浏览器恢复可用（2026-09-27 v1.2.0 发布实测，推翻上述"已死"结论）**：同一环境再次发布时，内置浏览器**完整走通了市场上传**——reCAPTCHA iframe 这次正常渲染（显示"此网站已超出 reCAPTCHA Enterprise 免费配额"提示但**未阻塞**上传），`api2/clr` 仍被 CSP 拦截（console 报错）但**不影响上传流程**。Upload 点击后直接完成，列表显示 `Verifying <版本>`。**根因确认（2026-09-27 溯源）**：VS Code 于 **9/26 从 1.138.x 更新到 1.139.1**（安装目录 `04c0d99f4f` 时间戳 9/26 10:43-15:30；9-26 15:30 会话日志引用旧版本目录 `7debcd` 被拒加载，证实更新发生在该时段）——**1.138 的 iframe 隔离限制在 1.139.1 已放宽**，内置浏览器上传市场恢复可用。**结论修正**：内置浏览器上传市场**应先尝试**（流程：More Actions... → Update → `page.setInputFiles('#file-upload', ...)` → Upload），失败再回退 Firefox Nightly 方案。
> **上传流程要点（Update 已有扩展）**：① 必须用扩展行的 **More Actions... → Update**（"New extension" 流程会报 "extension already exists"）；② `#file-upload` 隐藏但 `page.setInputFiles` 可直接注入；③ GitHub Release 附件上传用 `waitForEvent('filechooser')` + `chooser.setFiles()`，**发布时附件可能未传完**（点 Publish 后附件丢失）——需进编辑页补传并 Update release；④ GitHub Release 的 `#releases-upload` input 上 `setInputFiles` 可能静默失败（files.length=0），需用 filechooser 事件路径。

### 1.2b Firefox Nightly + Marionette MCP 上传市场（✅ 已验证 2026-09-22 v1.0.0）

> VS Code 内置浏览器无法上传市场时的替代方案。Firefox Nightly（`C:\Program Files\Firefox Nightly\firefox.exe`，157.0a1）无 CSP 限制，且可被 firefox-devtools MCP 控制。

1. **以 Marionette 模式启动**（MCP 需要）：
   ```powershell
   Start-Process "C:\Program Files\Firefox Nightly\firefox.exe" -ArgumentList "--marionette", "--remote-debugging-port", "9222", "--new-window", "https://marketplace.visualstudio.com/manage/publishers/<publisherId>"
   ```
   注意：普通 Firefox 在运行时 MCP 会连错（`No Marionette listener on 127.0.0.1:2828`）——必须启动 Nightly 并带 `--marionette` 标志。
2. **MCP 连接**：`list_pages` 确认连接，`evaluate_script` 检查登录态（`document.body.innerHTML.includes('azhe-hjm')`）。
3. **上传流程**（全部用 `evaluate_script` JS 点击，微软系按钮事件绑定 JS click 会超时）：
   - 点 New extension（直接可见时）或 More commands（窗口窄时折叠，`aria-label="More commands"`）→ 菜单弹出 → 点 New extension → 子菜单点 Visual Studio Code
   - 上传对话框出现（`[role=dialog]` + `#file-upload`）
   - **文件注入是死路**：`#file-upload` 隐藏（`offsetParent=null`），MCP 无 setInputFiles 等价物；显示它（改 style）后用户手动选择也不可靠
   - **最终由用户手动完成文件选择 + reCAPTCHA + Upload**（Firefox 无 CSP 限制，reCAPTCHA 正常显示）
4. **验证成功**：列表行出现 `<扩展名> Verifying 1.0.0 just now Public`。

> ⚠️ **关键教训**：vsix 打包必须**包含 dependencies**！用 `npx vsce package`（**不要加 `--no-dependencies`**），否则插件装不上 node_modules，用户激活直接崩溃（报"命令未找到"）。打包后务必 `npx vsce ls` 确认 `node_modules/` 在包内。

### 1.3 GitHub Release 创建流程

1. 打开 `https://github.com/<owner>/<repo>/releases/new?tag=vX.Y.Z&title=vX.Y.Z` → 用户登录 GitHub
2. 填好 tag / 标题 / 描述（URL 参数可预填）
3. 二进制附件上传（vsix 等）：
   ```js
   const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
   // 点击 "Attach binaries by dropping them here or selecting them" 按钮
   const chooser = await chooserPromise;
   await chooser.setFiles('绝对路径\\xxx.vsix');
   ```
   > ⚠️ **注意**：vsix 不能拖进正文编辑器（GitHub 不支持该类型作为正文附件），必须走**二进制附件区**。
4. 点击 **Publish release**

### 1.4 版本号与发布命名规则（重要）

> **历史教训（2026-08-09）**：曾打包为 `extension.vsix`（vsce 默认输出名），但正确的发布产物命名必须是 **`<扩展名>-<版本号>.vsix`**（如 `my-ext-1.6.0.vsix`），否则与历史 release 下载链接的附件名不一致。

| 项目 | 规则 |
|------|------|
| **打包输出名** | 固定为 **`<name>-<version>.vsix`**（如 `my-ext-1.6.0.vsix`）：`npx vsce package -o <name>-<version>.vsix`。**不要用 vsce 默认的 `extension.vsix`** |
| **name/version 来源** | `package.json` 的 `name` 字段（如 `my-ext`）+ `version` 字段（如 `1.6.0`） |
| **GitHub Release 附件** | 上传 `<name>-<version>.vsix`，下载链接即 `.../releases/download/<tag>/<name>-<version>.vsix` |
| **tag 格式** | `vX.Y.Z`（如 `v1.6.0`），指向对应版本提交 |
| **版本号语义** | 现有功能调整 / 修 bug → 只升 z（patch，如 1.5.0 → 1.5.1）；新增功能 → 升 y（minor，如 1.5.0 → 1.6.0）；完全重构（不向后兼容）→ 升 x（major，如 1.5.0 → 2.0.0） |
| **版本号占用检查** | 打包/发布前必须确认：`git tag -l "v*"` 看最新 tag，**不能在已发布的 tag 上重复发布同版本**（市场拒绝同版本重复上传；GitHub Release 可覆盖但不应依赖） |
| **发布后产物位置** | 本地根目录 `<name>-<version>.vsix`（`.gitignore` 已忽略，不入库）；release 附件由浏览器流程上传 |

### 1.4b 发布检查清单（每次发布前）

```bash
# 0. 同步仓库（必须先做！）：提交并推送所有源码/文档改动，避免 tag/release 指向不完整代码
git status --short            # 确认无未提交改动（.copilot/build-log.md 例外，脚本自动生成不入库）
git add <改动的文件> && git commit -m "..." && git push origin main
# 1. 确认版本号未被占用（对比 package.json version 与最新 tag）
git tag -l "v*" | Sort-Object -Descending | Select-Object -First 3
# 2. 检查远端是否已有同名 tag（本地可能滞后）
git ls-remote --tags origin | Select-String "<version>"
# 3. 打包并验证内容（输出名必须为 <name>-<version>.vsix）
npm run compile
npx vsce package -o <name>-<version>.vsix
npx vsce ls   # 确认 node_modules/ 与 out/ 齐全
# 4. 打 tag 并推送（确保 tag 指向含完整实现的提交）
git tag v<version> && git push origin v<version>
# 5. 发布（浏览器流程）
#    - GitHub: releases/new?tag=vX.Y.Z，附件用 <name>-<version>.vsix
#    - 市场: 上传 <name>-<version>.vsix
```

> ⚠️ **教训（2026-08-09 v1.6.1）**：曾只提交 `package.json`+`CHANGELOG.md` 就 push tag，导致 tag 指向不含实现源码的提交（`src/extension.ts` 等 6 个文件漏提交）。**必须先 `git status` 确认所有源码已提交**，再打 tag 发布。

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
5. **本项目（inherit-profile-plus）**：默认未配置任何 MCP 服务器；若某台机器新增，需在**本节登记**并同步更新依赖清单（`.copilot/instructions/Dependencies of the plugin.instructions.md`），多机器间保持一致

---

## 三、文档同步更新约定（重要）

> **现实环境变化后，必须同步修改本文档及相关指令文件**，保持文档与真实环境一致。

### 触发时机

- VS Code 大版本升级（如 1.131 → 1.132）
- 市场上传/审核结果变化（新版本通过/被拒）
- MCP 服务器新增/删除/迁移
- Profile 结构变化（新增/删除 profile、扩展增减）
- 依赖升级（`@types/vscode`、`sql.js` 等）
- 浏览器自动化流程变化（marketplace 改版等）

### 需要同步更新的文件

| 文件 | 更新内容 |
|------|---------|
| 本文档（`vscode开发经验.instructions.md`） | 浏览器流程、MCP、文档同步约定、本表 |
| `Dependencies of the plugin.instructions.md` | 依赖清单、检查记录表追加 |
| `结构.instructions.md` | 源码结构变更后同步 |
| `vscode-dependency-check.instructions.md` | 检查流程变化时 |

### 流程

1. 现实变化发生 → 立即记录到本文档对应小节
2. 涉及源码/依赖 → 同步更新其他指令文件
3. Profile 变化 → 更新 `vscode配置文件及其配置明细(开发者自用).md`（项目根目录，若存在）
4. 更新后告知用户"文档已同步"
