// 核对 package.json 声明的设置项与代码中实际读取的设置项是否一致。
//
// 代码里有三种读取形式：
//   1. getConfiguration().get("<prefix>.xxx")        —— 带前缀
//   2. getConfiguration("<prefix>").get("xxx")       —— 无前缀（同文件内）
//   3. const XXX_KEY = "xxx"; ... .get(XXX_KEY)      —— 常量键
// 本脚本三种都识别。
//
// 前缀（<prefix>）从 package.json 的设置键动态推导，移植改名后无需改本脚本。
//
// 用法：
//   node scripts/dev/check-settings.mjs              # 有漂移则退出码 1（挂到 npm run compile）
//   node scripts/dev/check-settings.mjs --warn-only  # 仅警告，始终退出码 0
import fs from "node:fs";
import path from "node:path";

const warnOnly = process.argv.includes("--warn-only");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const settingKeys = Object.keys(pkg.contributes.configuration.properties);
// 从第一个设置键推导前缀（如 "amdTokenFactory.commitLanguage" → "amdtokenfactory"）
const PREFIX = settingKeys[0]?.split(".")[0] ?? "";
const prefixRe = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const declared = new Set(
    settingKeys.map((k) => k.replace(new RegExp(`^${prefixRe}\\.`), "")),
);

/** globalState / secrets 的键不是设置项，需排除 */
const NON_SETTING_KEYS = new Set([
    "loginToken",
    "apiKeys",
    "apiKey",
    "cloudSyncGistId",
    "lastCloudSyncAt",
    "lastModelSyncDate",
]);

const used = new Set();
function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) {
            const text = fs.readFileSync(p, "utf8");
            // 形式 1：带前缀
            for (const m of text.matchAll(new RegExp(`get(?:<[^>]*>)?\\(\\s*"${prefixRe}\\.([A-Za-z0-9_.]+)"`, "g"))) {
                used.add(m[1]);
            }
            // 形式 2 / 3：getConfiguration("<prefix>") 或嵌套节 getConfiguration("<prefix>.retry")
            for (const m of text.matchAll(new RegExp(`getConfiguration\\(\\s*"${prefixRe}(\\.[A-Za-z0-9_.]+)?"\\s*\\)`, "g"))) {
                const section = m[1] ? m[1].slice(1) : ""; // 去掉前导点
                const prefix = section ? `${section}.` : "";
                // 收集该节内的无前缀 .get("xxx")
                for (const g of text.matchAll(/\.get(?:<[^>]*>)?\(\s*"([A-Za-z0-9_]+)"/g)) {
                    used.add(prefix + g[1]);
                }
                // 常量键 —— const XXX_KEY = "someKey"; 然后 .get(XXX_KEY)
                const constKeys = new Map();
                for (const g of text.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*"([A-Za-z0-9_]+)"/g)) {
                    constKeys.set(g[1], g[2]);
                }
                for (const g of text.matchAll(/\.get(?:<[^>]*>)?\(\s*([A-Za-z0-9_]+)\s*[,)]/g)) {
                    const resolved = constKeys.get(g[1]);
                    if (resolved) used.add(prefix + resolved);
                }
            }
        }
    }
}
walk("src");

for (const k of NON_SETTING_KEYS) used.delete(k);

const usedNotDeclared = [...used].filter((k) => !declared.has(k)).sort();
const declaredNotUsed = [...declared].filter((k) => !used.has(k)).sort();

console.log(`[check-settings] declared: ${declared.size}, used: ${used.size}`);
if (usedNotDeclared.length > 0) {
    console.log(`[check-settings] ⚠️  used but NOT declared (${usedNotDeclared.length}) — 用户无法在设置界面看到/修改：`);
    for (const k of usedNotDeclared) console.log(`[check-settings]      ${PREFIX}.${k}`);
}
if (declaredNotUsed.length > 0) {
    console.log(`[check-settings] ⚠️  declared but NOT used (${declaredNotUsed.length}) — 空操作设置项：`);
    for (const k of declaredNotUsed) console.log(`[check-settings]      ${PREFIX}.${k}`);
}

const drift = usedNotDeclared.length + declaredNotUsed.length;
if (drift === 0) {
    console.log("[check-settings] ✅ settings in sync");
    process.exit(0);
}
if (warnOnly) {
    console.log("[check-settings] (warn-only mode: not failing the build)");
    process.exit(0);
}
console.log("[check-settings] ❌ settings drift detected — fix package.json / code, or run with --warn-only");
process.exit(1);

