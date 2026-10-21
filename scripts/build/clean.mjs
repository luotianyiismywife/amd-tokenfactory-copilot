/**
 * clean.mjs — 清理编译产物目录（`npm run compile` 前置步骤）。
 *
 * `tsc` 不会清理 `outDir`：源文件被删除/移动后，旧的 `.js` 会残留在 `out/`
 * 并被 `vsce package` 打进 VSIX（曾出现已删除的 `legacyCookieApi.js` 等
 * 24 个陈旧产物随包发布）。此脚本在每次编译前清空 `out/`，保证产物与源码一致。
 *
 * 用法：node scripts/build/clean.mjs
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../../out", import.meta.url));
rmSync(outDir, { recursive: true, force: true });
console.log("[clean] removed out/");
