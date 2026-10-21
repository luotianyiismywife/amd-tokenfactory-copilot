/**
 * 云同步真实端到端测试（真实 GitHub Gist API + 生产代码）。
 *
 * 与 `test-cloud-sync-flow.mjs`（mock fetch）互补：本脚本用**真实网络**驱动
 * 生产 `pushToCloud` / `pullFromCloud`，验证 mock 无法覆盖的部分——
 * 真实 Gist API 的请求体格式、响应结构、`updated_at` 字段、内容往返。
 *
 * 安全设计：
 * - 创建一个**专用测试 Gist**（描述带随机后缀），并把它的 id 预置到
 *   `globalState`，使生产代码只读写该测试 Gist，**绝不触碰用户真实的同步 Gist**。
 * - 运行前校验测试 Gist 可读；结束后（含失败）在 finally 中删除测试 Gist。
 *
 * 凭据：从 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量读取，或回退 `gh auth token`。
 * 无凭据时打印 SKIP 并以 0 退出（不视为失败）。
 *
 * 运行前需 `npm run compile`。
 */

import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

function getToken() {
    if (process.env.GITHUB_TOKEN) {
        return process.env.GITHUB_TOKEN;
    }
    if (process.env.GH_TOKEN) {
        return process.env.GH_TOKEN;
    }
    try {
        return execSync("gh auth token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return undefined;
    }
}

const token = getToken();
if (!token) {
    console.log("SKIP: no GitHub token (set GITHUB_TOKEN / GH_TOKEN, or run `gh auth login`)");
    process.exit(0);
}

// ---------------------------------------------------------------------------
// vscode mock（真实 fetch，真实 token）
// ---------------------------------------------------------------------------

const uiCalls = { warnings: [], infos: [], errors: [] };
const noopChannel = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} };

const vscodeMock = {
    ProgressLocation: { Notification: 15 },
    authentication: {
        async getSession() {
            return { accessToken: token };
        },
    },
    window: {
        createOutputChannel() {
            return noopChannel;
        },
        async showWarningMessage(msg) {
            uiCalls.warnings.push(msg);
        },
        async showInformationMessage(msg) {
            uiCalls.infos.push(msg);
        },
        async showErrorMessage(msg) {
            uiCalls.errors.push(msg);
        },
        async withProgress(_options, task) {
            return task();
        },
    },
    workspace: {
        getConfiguration() {
            return { get: (_key, def) => def };
        },
    },
    env: { language: "en" },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { pushToCloud, pullFromCloud } = require("../out/cloud/cloudSync.js");
const { invalidateApiKeyStoreCache } = require("../out/keys/keyManager.js");
const { logger } = require("../out/core/logger.js");
logger.init();

// ---------------------------------------------------------------------------
// 真实 Gist API 辅助
// ---------------------------------------------------------------------------

const API = "https://api.github.com/gists";
const FILE = "copilot-provider-keys.json";
const TEST_DESC = `copilot-provider E2E test (safe to delete) ${Date.now()}`;

async function gh(url, init) {
    const resp = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "copilot-provider-e2e",
            ...(init?.headers ?? {}),
        },
    });
    if (!resp.ok) {
        throw new Error(`GitHub ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    }
    return resp;
}

const readGist = async (id) => (await gh(`${API}/${id}`)).json();

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let passed = 0;
const check = (name, actual, expected) => {
    assert.equal(actual, expected, name);
    passed++;
    console.log(`  ok  ${name}`);
};

const STORE_KEY = "amdTokenFactory.apiKeys";
const GIST_ID_KEY = "amdTokenFactory.cloudSyncGistId";
const LAST_SYNC_KEY = "amdTokenFactory.lastCloudSyncAt";

function makeContext(initialKeys = [], initialGlobal = {}) {
    const secretsData = new Map();
    if (initialKeys.length) {
        secretsData.set(STORE_KEY, JSON.stringify({ keys: initialKeys, activeIndex: 0 }));
    }
    const globalData = new Map(Object.entries(initialGlobal));
    return {
        secrets: {
            async get(k) {
                return secretsData.get(k);
            },
            async store(k, v) {
                secretsData.set(k, v);
            },
            async delete(k) {
                secretsData.delete(k);
            },
        },
        globalState: {
            get(k, def) {
                return globalData.has(k) ? globalData.get(k) : def;
            },
            async update(k, v) {
                globalData.set(k, v);
            },
        },
        _secretsData: secretsData,
        _globalData: globalData,
    };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log("cloud sync E2E (real GitHub Gist)");

// 1. 创建专用测试 Gist（空 keys）
const createResp = await gh(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        description: TEST_DESC,
        public: false,
        files: { [FILE]: { content: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), keys: [] }) } },
    }),
});
const created = await createResp.json();
const testGistId = created.id;
if (!testGistId) {
    throw new Error("failed to create test gist");
}
console.log(`  (test gist: ${testGistId})`);

try {
    // 2. 校验测试 Gist 可读（确保生产代码不会回退到 findSyncGist 触碰真实 Gist）
    const probe = await readGist(testGistId);
    check("测试 Gist 可读且含目标文件", Boolean(probe.files?.[FILE]), true);

    // 3. 生产 pushToCloud：预置测试 Gist id，写入 2 个 key 三元组
    invalidateApiKeyStoreCache();
    const pushCtx = makeContext(
        [
            { value: "sk_e2e_alpha", credential: "credential_alpha", label: "Alpha", available: null },
            { value: "sk_e2e_beta", credential: "credential_beta", label: "Beta", available: null },
        ],
        { [GIST_ID_KEY]: testGistId },
    );
    await pushToCloud(pushCtx, true);

    const afterPush = await readGist(testGistId);
    const pushedContent = JSON.parse(afterPush.files[FILE].content);
    check("push：云端写入 2 个 key", pushedContent.keys.length, 2);
    check("push：value 往返正确", pushedContent.keys[0].value, "sk_e2e_alpha");
    check("push：credential 往返正确", pushedContent.keys[0].credential, "credential_alpha");
    check("push：label 往返正确", pushedContent.keys[1].label, "Beta");
    check("push：version 正确", pushedContent.version, 1);
    check("push：lastCloudSyncAt 等于服务端 updated_at", pushCtx._globalData.get(LAST_SYNC_KEY), afterPush.updated_at);

    // 4. 无变更再 push → 短路，服务端 updated_at 不变
    const beforeNoop = (await readGist(testGistId)).updated_at;
    await new Promise((r) => setTimeout(r, 1200)); // 确保若真写入，updated_at 会变
    invalidateApiKeyStoreCache();
    const noopCtx = makeContext(
        [
            { value: "sk_e2e_alpha", credential: "credential_alpha", label: "Alpha", available: null },
            { value: "sk_e2e_beta", credential: "credential_beta", label: "Beta", available: null },
        ],
        { [GIST_ID_KEY]: testGistId },
    );
    await pushToCloud(noopCtx, true);
    const afterNoop = (await readGist(testGistId)).updated_at;
    check("无变更 push：服务端 updated_at 不变（短路生效）", afterNoop, beforeNoop);

    // 5. 外部修改云端（模拟另一台机器），生产 pullFromCloud 合并到本地
    const remotePayload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        keys: [
            { value: "sk_e2e_alpha", credential: "credential_alpha_v2", label: "Alpha2" },
            { value: "sk_e2e_gamma", credential: "credential_gamma", label: "Gamma" },
        ],
    };
    await gh(`${API}/${testGistId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(remotePayload, null, 2) } } }),
    });

    invalidateApiKeyStoreCache();
    const pullCtx = makeContext(
        [
            { value: "sk_e2e_alpha", credential: "credential_alpha", label: "Alpha", available: true, lastCheckedAt: 999 },
            { value: "sk_e2e_beta", credential: "credential_beta", label: "Beta", available: null },
        ],
        { [GIST_ID_KEY]: testGistId },
    );
    const changed = await pullFromCloud(pullCtx, false);
    const pulled = JSON.parse(pullCtx._secretsData.get(STORE_KEY));
    check("pull：返回 true", changed, true);
    check("pull：云端 credential 覆盖本地", pulled.keys[0].credential, "credential_alpha_v2");
    check("pull：云端 label 覆盖本地", pulled.keys[0].label, "Alpha2");
    check("pull：本地可用性状态保留", pulled.keys[0].available, true);
    check("pull：本地 lastCheckedAt 保留", pulled.keys[0].lastCheckedAt, 999);
    check("pull：本地独有 key 被删除（云端为源）", pulled.keys.some((k) => k.value === "sk_e2e_beta"), false);
    check("pull：云端新增 key 被追加", pulled.keys.some((k) => k.value === "sk_e2e_gamma"), true);
    check("pull：key 总数正确", pulled.keys.length, 2);
} finally {
    // 6. 清理：删除测试 Gist
    try {
        await gh(`${API}/${testGistId}`, { method: "DELETE" });
        console.log(`  (test gist ${testGistId} deleted)`);
    } catch (err) {
        console.log(`  WARN: failed to delete test gist ${testGistId}: ${err}`);
    }
    Module._load = originalLoad;
}

console.log(`\ncloud sync E2E: ${passed} checks passed`);
