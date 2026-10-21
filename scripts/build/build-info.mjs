/**
 * Build metadata generator.
 *
 * Runs automatically after `tsc -p ./` via `npm run compile`. Produces:
 *   1. `out/build-info.json`  — version + build time (with timezone) of the build
 *   2. `.copilot/build-log.md` — appends one table row per compile (build log)
 *
 * The build time always includes the timezone: IANA id (e.g. Asia/Shanghai)
 * plus the UTC offset (e.g. UTC+08:00), so builds are traceable across
 * machines in different timezones.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PKG_PATH = join(ROOT, "package.json");
const OUT_DIR = join(ROOT, "out");
const LOG_DIR = join(ROOT, ".copilot");
const LOG_PATH = join(LOG_DIR, "build-log.md");
const LOG_HEADER = `# 编译日志

> 每次执行 \`npm run compile\` 时由 \`scripts/build/build-info.mjs\` 自动追加。
> 编译时间均标注时区（本地时间 + IANA 时区 + UTC 偏移），方便跨机器追溯产物来源。

| 编译时间 | 版本号 | 时区 (UTC 偏移) | 触发方式 |
| -------- | ------ | --------------- | -------- |
`;

/** IANA timezone id, e.g. "Asia/Shanghai". */
function getTimezoneId() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
    } catch {
        return "Unknown";
    }
}

/** UTC offset string, e.g. "+08:00" / "-05:00". */
function getUtcOffset(now) {
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${sign}${hh}:${mm}`;
}

const now = new Date();
const timezone = getTimezoneId();
const offset = getUtcOffset(now);
const local = now.toLocaleString("zh-CN", { hour12: false });
const display = `${local} (${timezone} UTC${offset})`;

const info = {
    version: JSON.parse(readFileSync(PKG_PATH, "utf8")).version,
    buildTime: now.toISOString(), // UTC (ISO 8601)
    buildTimeLocal: local, // local wall-clock time
    timezone, // IANA timezone id
    timezoneOffset: `UTC${offset}`, // UTC offset
    buildTimeDisplay: display, // human-readable, timezone-annotated
};

// 1) out/build-info.json — ships inside the extension package (out/ is packed).
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "build-info.json"), JSON.stringify(info, null, 2) + "\n");

// 2) .copilot/build-log.md — developer-side build history.
mkdirSync(LOG_DIR, { recursive: true });
let content = "";
if (existsSync(LOG_PATH)) {
    content = readFileSync(LOG_PATH, "utf8");
}
if (!content.includes("# 编译日志")) {
    content = LOG_HEADER;
}
if (!content.endsWith("\n")) {
    content += "\n";
}
content += `| ${local} | ${info.version} | ${timezone} (UTC${offset}) | npm run compile |\n`;
writeFileSync(LOG_PATH, content);

console.log(`[build-info] v${info.version} @ ${display}`);
console.log(`[build-info] wrote out/build-info.json`);
console.log(`[build-info] appended .copilot/build-log.md`);
