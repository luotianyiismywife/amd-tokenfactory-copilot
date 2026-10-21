/**
 * 云同步集成测试（mock fetch + mock vscode）。
 *
 * 覆盖 `pushToCloud` / `pullFromCloud` 的真实流程（非纯函数）：
 * - push 新建 Gist / PATCH 已有 Gist / 无变更短路 / 空 store 警告
 * - push 记录**服务端** updated_at（回归：曾记录客户端时间导致 push 后必然多拉一次）
 * - pull 合并云端到本地（label 覆盖、可用性保留、追加新 key）
 * - pull 静默跳过（云端不新）/ 缓存 gist 失效回退查找
 *
 * 运行前需 `npm run compile`（依赖 out/ 编译产物）。
 * 纯 Node 环境：通过 Module._load 钩子注入 vscode mock，不加载真实 VS Code 运行时。
 */

import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// vscode mock
// ---------------------------------------------------------------------------

const uiCalls = { warnings: [], infos: [], errors: [] };
const noopChannel = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} };

const vscodeMock = {
    ProgressLocation: { Notification: 15 },
    authentication: {
        async getSession() {
            return { accessToken: "fake-token" };
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
// fetch mock
// ---------------------------------------------------------------------------

const GIST_FILE = "copilot-provider-keys.json";
const GIST_DESC = "copilot-provider key sync (do not edit manually)";

let fetchLog = [];
let fetchHandler = null;

globalThis.fetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    fetchLog.push({ method, url: String(url) });
    if (!fetchHandler) {
        throw new Error(`unexpected fetch (no handler): ${method} ${url}`);
    }
    return fetchHandler(String(url), method, init);
};

const jsonResponse = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    async json() {
        return obj;
    },
    async text() {
        return JSON.stringify(obj);
    },
});

const gistFileResponse = (payload, updatedAt) =>
    jsonResponse({
        updated_at: updatedAt,
        files: { [GIST_FILE]: { content: JSON.stringify(payload) } },
    });

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

const reset = () => {
    invalidateApiKeyStoreCache();
    fetchLog = [];
    fetchHandler = null;
    uiCalls.warnings.length = 0;
    uiCalls.infos.length = 0;
    uiCalls.errors.length = 0;
};

// ---------------------------------------------------------------------------
// push 流程
// ---------------------------------------------------------------------------

console.log("pushToCloud");

// A. 无缓存 gist id、无既有 gist → 新建 Gist，记录服务端时间戳
{
    reset();
    const ctx = makeContext([{ value: "sk_a", label: "A", available: null }]);
    fetchHandler = (url, method) => {
        if (method === "GET" && url.includes("/gists?")) {
            return jsonResponse([]);
        }
        if (method === "POST" && url.endsWith("/gists")) {
            return jsonResponse({ id: "gist_new", updated_at: "2026-10-07T12:00:00Z" });
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    await pushToCloud(ctx, true);
    check("新建 Gist：缓存 gist id", ctx._globalData.get(GIST_ID_KEY), "gist_new");
    check(
        "新建 Gist：lastCloudSyncAt 用服务端时间（非客户端）",
        ctx._globalData.get(LAST_SYNC_KEY),
        "2026-10-07T12:00:00Z",
    );
    check("新建 Gist：发出 POST", fetchLog.some((f) => f.method === "POST"), true);
}

// B. 有缓存 gist id、内容有变更 → PATCH，记录服务端时间戳
{
    reset();
    const ctx = makeContext([{ value: "sk_a", label: "A", available: null }], { [GIST_ID_KEY]: "gist_x" });
    const remote = { version: 1, updatedAt: "2026-10-01T00:00:00Z", keys: [{ value: "sk_old" }] };
    fetchHandler = (url, method) => {
        if (method === "GET" && url.endsWith("/gists/gist_x")) {
            return gistFileResponse(remote, "2026-10-01T00:00:00Z");
        }
        if (method === "PATCH" && url.endsWith("/gists/gist_x")) {
            return jsonResponse({ updated_at: "2026-10-07T13:30:00Z" });
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    await pushToCloud(ctx, true);
    check("PATCH 已有 Gist：发出 PATCH", fetchLog.some((f) => f.method === "PATCH"), true);
    check("PATCH 已有 Gist：lastCloudSyncAt 用服务端时间", ctx._globalData.get(LAST_SYNC_KEY), "2026-10-07T13:30:00Z");
}

// C. 本地与云端一致 → 短路，不写 Gist、不更新时间戳
{
    reset();
    const ctx = makeContext([{ value: "sk_a", label: "A", available: null }], {
        [GIST_ID_KEY]: "gist_x",
        [LAST_SYNC_KEY]: "2026-10-01T00:00:00Z",
    });
    const remote = {
        version: 1,
        updatedAt: "2026-10-07T00:00:00Z",
        keys: [{ value: "sk_a", label: "A" }],
    };
    fetchHandler = (url, method) => {
        if (method === "GET" && url.endsWith("/gists/gist_x")) {
            return gistFileResponse(remote, "2026-10-07T00:00:00Z");
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    await pushToCloud(ctx, true);
    check("无变更：不发出写请求", fetchLog.filter((f) => f.method !== "GET").length, 0);
    check("无变更：lastCloudSyncAt 不变", ctx._globalData.get(LAST_SYNC_KEY), "2026-10-01T00:00:00Z");
}

// D. 空 store → 警告返回，不发网络请求
{
    reset();
    const ctx = makeContext([]);
    fetchHandler = () => {
        throw new Error("should not fetch");
    };
    await pushToCloud(ctx, false);
    check("空 store：不发网络请求", fetchLog.length, 0);
    check("空 store：弹出警告", uiCalls.warnings.length, 1);
}

// ---------------------------------------------------------------------------
// pull 流程
// ---------------------------------------------------------------------------

console.log("pullFromCloud");

// E. 云端为源：label 覆盖、可用性保留、追加新 key
{
    reset();
    const ctx = makeContext(
        [{ value: "sk_local", label: "L", available: true, lastCheckedAt: 111 }],
        { [GIST_ID_KEY]: "gist_x" },
    );
    const remote = {
        version: 1,
        updatedAt: "2026-10-07T10:00:00Z",
        keys: [{ value: "sk_local", label: "C" }, { value: "sk_new" }],
    };
    fetchHandler = (url, method) => {
        if (method === "GET" && url.endsWith("/gists/gist_x")) {
            return gistFileResponse(remote, "2026-10-07T10:00:00Z");
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    const changed = await pullFromCloud(ctx, false);
    const saved = JSON.parse(ctx._secretsData.get(STORE_KEY));
    check("合并：返回 true", changed, true);
    check("合并：云端 label 覆盖本地", saved.keys[0].label, "C");
    check("合并：本地可用性状态保留", saved.keys[0].available, true);
    check("合并：本地 lastCheckedAt 保留", saved.keys[0].lastCheckedAt, 111);
    check("合并：追加云端新增 key", saved.keys.length, 2);
    check("合并：lastCloudSyncAt 更新", ctx._globalData.get(LAST_SYNC_KEY), "2026-10-07T10:00:00Z");
}

// F. 静默模式：云端不新 → 跳过，不写 store
{
    reset();
    const ctx = makeContext([{ value: "sk_local", available: null }], {
        [GIST_ID_KEY]: "gist_x",
        [LAST_SYNC_KEY]: "2026-10-07T10:00:00Z",
    });
    const remote = { version: 1, updatedAt: "2026-10-07T09:00:00Z", keys: [{ value: "sk_other" }] };
    fetchHandler = (url, method) => {
        if (method === "GET" && url.endsWith("/gists/gist_x")) {
            return gistFileResponse(remote, "2026-10-07T09:00:00Z");
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    const changed = await pullFromCloud(ctx, true);
    check("静默：云端不新 → 返回 false", changed, false);
    check("静默：不写 store", ctx._secretsData.get(STORE_KEY).includes("sk_other"), false);
}

// G. 缓存 gist id 失效（404）→ 回退按描述查找并拉取
{
    reset();
    const ctx = makeContext([{ value: "sk_local", available: null }], { [GIST_ID_KEY]: "gist_stale" });
    const remote = { version: 1, updatedAt: "2026-10-07T11:00:00Z", keys: [{ value: "sk_cloud" }] };
    fetchHandler = (url, method) => {
        if (method === "GET" && url.endsWith("/gists/gist_stale")) {
            return jsonResponse({ message: "Not Found" }, 404);
        }
        if (method === "GET" && url.includes("/gists?")) {
            return jsonResponse([
                {
                    id: "gist_found",
                    description: GIST_DESC,
                    public: false,
                    files: { [GIST_FILE]: {} },
                },
            ]);
        }
        if (method === "GET" && url.endsWith("/gists/gist_found")) {
            return gistFileResponse(remote, "2026-10-07T11:00:00Z");
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    const changed = await pullFromCloud(ctx, false);
    check("缓存失效：回退查找并拉取成功", changed, true);
    check("缓存失效：更新缓存 gist id", ctx._globalData.get(GIST_ID_KEY), "gist_found");
}

// H. 云端无 Gist → 非静默模式警告返回
{
    reset();
    const ctx = makeContext([{ value: "sk_local", available: null }]);
    fetchHandler = (url, method) => {
        if (method === "GET" && url.includes("/gists?")) {
            return jsonResponse([]);
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    const changed = await pullFromCloud(ctx, false);
    check("无云端 Gist：返回 false", changed, false);
    check("无云端 Gist：弹出警告", uiCalls.warnings.length, 1);
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

Module._load = originalLoad;

console.log(`\ncloud sync flow: ${passed} checks passed`);
