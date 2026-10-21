/**
 * package-vsix.mjs — VSIX 打包脚本（npm run build）
 *
 * 输出名固定为 `<name>-<version>.vsix`（`<name>` 取自 package.json 的 `name` 字段），
 * 与 GitHub Release 附件命名规范及历史发布产物保持一致。
 * 不使用 vsce 默认的 extension.vsix。
 *
 * 用法：npm run build
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const outFile = `${pkg.name}-${pkg.version}.vsix`;

console.log(`[package-vsix] packaging ${pkg.name} v${pkg.version} → ${outFile}`);
execSync(`npx @vscode/vsce package -o ${outFile}`, { stdio: "inherit" });
