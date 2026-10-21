// 一次性完整审计：把此前零散发现的问题类型全部纳入，一次跑完。
//
// 检查项：
//   1. 设置项漂移（声明 vs 使用，含嵌套配置节）
//   2. 未使用的导出（排除同文件内使用）
//   3. 未使用的 l10n 键（排除动态查找）
//   4. package.nls.json / package.nls.zh-cn.json 键集合是否一致
//   5. package.json 命令声明 vs 代码注册
//   6. 文档中引用的文件路径是否存在
//   7. 测试脚本引用的 out/ 路径是否存在
//
// 用法：node scripts/dev/audit-all.mjs
import fs from "node:fs";
import path from "node:path";

const problems = [];
const note = (msg) => problems.push(msg);

// ── 收集源文件 ──
const srcFiles = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) srcFiles.push(p);
    }
})("src");
const srcText = new Map(srcFiles.map((f) => [f, fs.readFileSync(f, "utf8")]));

// ── 1. 设置项漂移 ──
{
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const settingKeys = Object.keys(pkg.contributes.configuration.properties);
    // 从第一个设置键推导前缀（移植改名后无需改本脚本）
    const PREFIX = settingKeys[0]?.split(".")[0] ?? "";
    const prefixRe = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declared = new Set(settingKeys.map((k) => k.replace(new RegExp(`^${prefixRe}\\.`), "")));
    const NON_SETTING = new Set([
        "loginToken", "apiKeys", "apiKey", "cloudSyncGistId", "lastCloudSyncAt", "lastModelSyncDate",
    ]);
    const used = new Set();
    for (const text of srcText.values()) {
        for (const m of text.matchAll(new RegExp(`get(?:<[^>]*>)?\\(\\s*"${prefixRe}\\.([A-Za-z0-9_.]+)"`, "g"))) used.add(m[1]);
        for (const m of text.matchAll(new RegExp(`getConfiguration\\(\\s*"${prefixRe}(\\.[A-Za-z0-9_.]+)?"\\s*\\)`, "g"))) {
            const prefix = m[1] ? m[1].slice(1) + "." : "";
            for (const g of text.matchAll(/\.get(?:<[^>]*>)?\(\s*"([A-Za-z0-9_]+)"/g)) used.add(prefix + g[1]);
            const constKeys = new Map();
            for (const g of text.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*"([A-Za-z0-9_]+)"/g)) constKeys.set(g[1], g[2]);
            for (const g of text.matchAll(/\.get(?:<[^>]*>)?\(\s*([A-Za-z0-9_]+)\s*[,)]/g)) {
                const r = constKeys.get(g[1]);
                if (r) used.add(prefix + r);
            }
        }
    }
    for (const k of NON_SETTING) used.delete(k);
    for (const k of used) if (!declared.has(k)) note(`[settings] used but NOT declared: ${PREFIX}.${k}`);
    for (const k of declared) if (!used.has(k)) note(`[settings] declared but NOT used: ${PREFIX}.${k}`);
}

// ── 2. 未使用的导出 ──
{
    const all = [...srcText.entries()];
    // Barrel 文件（仅做 `export { ... } from "./x"` 重导出）不算"使用"——
    // 否则重导出行本身会被计为一次引用，导致「文档有、代码无」或真正无人
    // 使用的导出被漏报（假阴性）。
    const isBarrel = (text) => {
        const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
        return lines.length > 0 && lines.every((l) => /^export\s*(\{[^}]*\}|\*)\s*from\s*"/.test(l.trim()));
    };
    const barrels = new Set(all.filter(([, t]) => isBarrel(t)).map(([f]) => f));
    for (const [f, text] of all) {
        const names = new Set();
        for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/gm)) names.add(m[1]);
        for (const m of text.matchAll(/^export\s*\{([^}]+)\}/gm)) {
            for (const part of m[1].split(",")) {
                const n = part.trim().split(/\s+as\s+/).pop().trim().replace(/^type\s+/, "");
                if (n) names.add(n);
            }
        }
        for (const name of names) {
            let total = 0;
            for (const [g, gt] of all) {
                // Barrel 重导出行不计入使用
                if (barrels.has(g)) continue;
                for (const line of gt.split("\n")) {
                    // 只跳过「该名字自身的声明行」，不要跳过所有 export 行
                    // （否则 `export interface X extends Y` / `export type Z = A | B`
                    //  这类引用会被误判为未使用）
                    if (g === f && new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|class|interface|type)\\s+${name}\\b`).test(line)) {
                        continue;
                    }
                    if (new RegExp(`\\b${name}\\b`).test(line)) total++;
                }
            }
            if (total === 0) note(`[unused-export] ${f.replace(/\\/g, "/")} → ${name}`);
        }
    }
}

// ── 3. 未使用的 l10n 键 ──
{
    const loc = srcText.get(path.join("src", "core", "localize.ts"));
    const keys = [...loc.matchAll(/^\t"((?:[^"\\]|\\.)+)":/gm)].map((m) => m[1]);
    const others = [...srcText.entries()].filter(([f]) => !f.endsWith("localize.ts")).map(([, t]) => t).join("\n");
    const pkgText = ["package.json", "package.nls.json", "package.nls.zh-cn.json"]
        .map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const k of keys) {
        const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`"${esc}"`).test(others)) continue;
        if (new RegExp(`"${esc}"`).test(pkgText)) continue; // 动态查找
        note(`[unused-l10n] ${k}`);
    }
}

// ── 4. nls 键集合一致性 ──
{
    const read = (f) => new Set([...fs.readFileSync(f, "utf8").matchAll(/^\t"((?:[^"\\]|\\.)+)":/gm)].map((m) => m[1]));
    const en = read("package.nls.json");
    const zh = read("package.nls.zh-cn.json");
    for (const k of en) if (!zh.has(k)) note(`[nls] missing in zh-cn: ${k}`);
    for (const k of zh) if (!en.has(k)) note(`[nls] missing in en: ${k}`);
}

// ── 5. 命令声明 vs 注册 ──
{
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    const registered = new Set();
    for (const text of srcText.values()) {
        for (const m of text.matchAll(/registerCommand\(\s*"([^"]+)"/g)) registered.add(m[1]);
    }
    for (const c of declared) if (!registered.has(c)) note(`[command] declared but NOT registered: ${c}`);
    for (const c of registered) if (!declared.has(c)) note(`[command] registered but NOT declared: ${c}`);
}

// ── 6. 文档引用的文件路径 ──
{
    for (const doc of ["AGENTS.md", "README.md", "docs/plan-usage-design.md", "docs/multi-api-key-design.md", "docs/retry-and-key-rotation.md", "docs/neutralization.md", "test/README.md"]) {
        if (!fs.existsSync(doc)) continue;
        const text = fs.readFileSync(doc, "utf8");
        for (const m of text.matchAll(/`(src\/[A-Za-z0-9_./-]+\.ts|scripts\/[A-Za-z0-9_./-]+\.(?:mjs|js)|test\/[A-Za-z0-9_./-]+\.mjs)`/g)) {
            if (!fs.existsSync(m[1])) note(`[doc] ${doc} references missing file: ${m[1]}`);
        }
    }
}

// ── 7. 测试脚本引用的 out/ 路径 ──
{
    const testDir = "test";
    for (const f of fs.readdirSync(testDir).filter((n) => n.endsWith(".mjs"))) {
        const text = fs.readFileSync(path.join(testDir, f), "utf8");
        for (const m of text.matchAll(/["'](\.\.\/out\/[A-Za-z0-9_./-]+\.js)["']/g)) {
            const rel = m[1].replace("../", "");
            if (!fs.existsSync(rel)) note(`[test] ${f} requires missing build output: ${m[1]}`);
        }
    }
}

// ── 输出 ──
if (problems.length === 0) {
    console.log("[audit] ✅ no problems found");
    process.exit(0);
}
console.log(`[audit] ❌ ${problems.length} problem(s):\n`);
for (const p of problems) console.log(`  ${p}`);
process.exit(1);
