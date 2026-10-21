import * as vscode from "vscode";

/**
 * 扩展版本 / 客户端信息管理。
 *
 * ⚠️ **不硬编码扩展 ID**：扩展 ID（`<publisher>.<name>`）由 `package.json` 决定，
 * 移植时会被替换。本类在 `activate()` 时通过 `initialize(context)` 捕获真实 ID，
 * 避免改名后 `getVersion()` 返回 "unknown" 或 User-Agent 带错名字。
 */
export class VersionManager {
    private static _version: string | null = null;
    private static _extensionId: string | null = null;
    private static _extensionName: string | null = null;
    private static _publisher: string | null = null;

    /**
     * 初始化：从扩展上下文捕获真实 ID / 名称 / publisher。
     * 必须在 `activate()` 中调用（早于任何 `getVersion()` / `getUserAgent()`）。
     */
    static initialize(context: vscode.ExtensionContext): void {
        this._extensionId = context.extension.id;
        const pkg = context.extension.packageJSON as { name?: string; publisher?: string; version?: string };
        this._extensionName = pkg.name ?? context.extension.id.split(".").pop() ?? "unknown";
        this._publisher = pkg.publisher ?? context.extension.id.split(".")[0] ?? "unknown";
        this._version = pkg.version ?? "unknown";
    }

    /**
     * Get the current extension version
     */
    static getVersion(): string {
        if (this._version === null) {
            // 未 initialize 时的兜底：按已知 ID 查找（移植后应始终走 initialize）
            const extension = this._extensionId ? vscode.extensions.getExtension(this._extensionId) : undefined;
            this._version = extension?.packageJSON?.version ?? "unknown";
        }
        return this._version!;
    }

    /**
     * Build a descriptive User-Agent to help quantify API usage
     */
    static getUserAgent(): string {
        const vscodeVersion = vscode.version;
        const name = this._extensionName ?? "copilot-provider";
        return `${name}/${this.getVersion()} VSCode/${vscodeVersion}`;
    }

    /**
     * Get the current extension information
     */
    static getClientInfo(): { name: string; version: string; author: string } {
        return {
            name: this._extensionName ?? "copilot-provider",
            version: this.getVersion(),
            author: this._publisher ?? "unknown",
        };
    }
}
