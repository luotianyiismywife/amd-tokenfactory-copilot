#!/usr/bin/env node

/**
 * port.mjs — 脚手架批量移植脚本。
 *
 * 把脚手架的中性占位符一次性替换为你平台的值（扩展名 / vendor / 命令前缀 /
 * 设置键前缀 / URL / 示例模型 ID）。**只做文本替换，不改逻辑**。
 *
 * 用法：
 *   node scripts/dev/port.mjs \
 *     --vendor   myplatform \
 *     --name     myplatform-copilot \
 *     --display  "MyPlatform Provider" \
 *     --api-base "https://api.myplatform.com/v1/" \
 *     --home     "https://myplatform.com" \
 *     --user-self "https://platform.myplatform.com/api/user/self" \
 *     [--model my-model] [--dry-run]
 *
 * 参数：
 *   --vendor    平台标识（同时用作 vendor id、命令前缀、设置键前缀）  [必填]
 *   --name      扩展包名（package.json 的 name）                      [必填]
 *   --display   显示名（displayName / providerDisplayName）           [必填]
 *   --api-base  OpenAI 兼容 API 根地址（以 / 结尾）                   [必填]
 *   --home      平台官网地址（获取密钥页面的域名）                    [必填]
 *   --user-self 用户中心账号信息端点（无则传空串 ""）                 [必填]
 *   --model     示例模型 ID（替换 example-model）                     [可选]
 *   --dry-run   只打印将要修改的文件，不写入                          [可选]
 *
 * 替换规则见 docs/neutralization.md。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── 解析参数 ──
const args = process.argv.slice(2);
const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");

const vendor = opt("vendor");
const name = opt("name");
const display = opt("display");
const apiBase = opt("api-base");
const home = opt("home");
const userSelf = opt("user-self");
const model = opt("model");

const missing = ["vendor", "name", "display", "api-base", "home", "user-self"].filter((k) => opt(k) === undefined);
if (missing.length > 0) {
    console.error(`[port] 缺少必填参数: ${missing.map((m) => "--" + m).join(", ")}`);
    console.error("[port] 用法见文件头部注释。");
    process.exit(1);
}

// ── 替换规则（顺序敏感：具体 URL 先于兜底域名）──
const rules = [
    // URL（具体优先）
    ["https://api.example.com/v1/", apiBase],
    ["https://platform.example.com/api/user/self", userSelf],
    ["https://example.com", home],
    // 显示名
    ["Copilot Provider Scaffold", display],
    // 前缀 / vendor / 包名（amdtokenfactory 同时是 vendor、命令前缀、设置键前缀）
    ["amdtokenfactory", vendor],
    // 环境变量前缀
    ["PROVIDER_", `${vendor.toUpperCase()}_`],
];
if (model) {
    rules.push(["example-model", model]);
}

// ── 遍历文件 ──
const EXCLUDE = /(^|[\\/])(node_modules|out|\.git|\.copilot)([\\/]|$)/;
const EXTS = new Set([".ts", ".mjs", ".js", ".json", ".md"]);
const NAMES = new Set([".gitignore", ".vscodeignore"]);

const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (EXCLUDE.test(p)) continue;
        if (e.isDirectory()) walk(p);
        else if (EXTS.has(path.extname(e.name)) || NAMES.has(e.name)) files.push(p);
    }
})(ROOT);

let changed = 0;
for (const f of files) {
    const orig = fs.readFileSync(f, "utf8");
    let text = orig;
    for (const [from, to] of rules) text = text.split(from).join(to);
    if (text !== orig) {
        changed++;
        console.log(`${dryRun ? "[dry-run] would change" : "changed"}: ${path.relative(ROOT, f)}`);
        if (!dryRun) fs.writeFileSync(f, text, "utf8");
    }
}
console.log(`[port] ${dryRun ? "would change" : "changed"} ${changed} file(s).`);
if (!dryRun) {
    console.log("[port] 下一步：npm run compile && npm run audit");
}
