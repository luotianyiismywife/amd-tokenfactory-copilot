/**
 * Key 选择与状态测试（`src/keys/selection.ts` + `src/keys/health.ts` + `src/keys/store.ts`）。
 *
 * 覆盖：
 *  1. pickNextApiKey：rotation 游标前移 / sticky 游标钉住 / single 返回 active
 *  2. 跳过不可用 key（available=false）与瞬态冷却 key
 *  3. getPrimaryApiKey：single / rotation / sticky 三种模式
 *  4. shouldSingleKeyFallbackSwitch：仅 balance 原因才切换
 *  5. setActiveKeyByValue：按值移动 activeIndex
 *  6. store 增删改：addApiKey / addApiKeys / removeApiKey / updateApiKey（冲突校验）
 *  7. 旧版单 key 迁移
 *
 * 运行前需 `npm run compile`。
 * 用法：node test/test-keys.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── VS Code 运行时 shim ──
const Module = require("node:module");
const originalLoad = Module._load;

/** 可配置的 settings（测试内按需覆盖） */
let settings = {};
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => (key in settings ? settings[key] : fallback),
        }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

/** 内存版 SecretStorage */
function makeSecrets(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get: async (k) => map.get(k),
        store: async (k, v) => void map.set(k, v),
        delete: async (k) => void map.delete(k),
        _map: map,
    };
}

const { pickNextApiKey, getPrimaryApiKey, shouldSingleKeyFallbackSwitch, setActiveKeyByValue } =
    require("../out/keys/selection.js");
const { getApiKeyStore, saveApiKeyStore, invalidateApiKeyStoreCache, addApiKey, addApiKeys, removeApiKey, updateApiKey } =
    require("../out/keys/store.js");
const { markApiKeyExhausted, markApiKeyAvailable, resetExhaustedKeys } = require("../out/keys/health.js");
const { setRotationIndex } = require("../out/keys/state.js");

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}
async function checkAsync(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
}

/** 每个测试前重置模块级状态（缓存 / 游标 / 冷却） */
async function reset(secrets, keys, activeIndex = 0) {
    invalidateApiKeyStoreCache();
    setRotationIndex(0);
    await resetExhaustedKeys(secrets, true);
    await saveApiKeyStore(secrets, { keys, activeIndex });
}

const K = (value, extra = {}) => ({ value, available: null, ...extra });

// ---------------------------------------------------------------------------
// 1. pickNextApiKey — rotation 游标前移
// ---------------------------------------------------------------------------
console.log("pickNextApiKey — rotation");

await checkAsync("rotation：每次选中后游标前移（顺序轮换）", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b"), K("c")]);
    const first = await pickNextApiKey(secrets, "rotation");
    const second = await pickNextApiKey(secrets, "rotation");
    const third = await pickNextApiKey(secrets, "rotation");
    const fourth = await pickNextApiKey(secrets, "rotation");
    assert.equal(first.value, "a");
    assert.equal(second.value, "b");
    assert.equal(third.value, "c");
    assert.equal(fourth.value, "a"); // 环形回到起点
});

await checkAsync("rotation：跳过 available=false 的 key", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a", { available: false }), K("b"), K("c")]);
    const picked = await pickNextApiKey(secrets, "rotation");
    assert.equal(picked.value, "b");
});

// ---------------------------------------------------------------------------
// 2. pickNextApiKey — sticky 游标钉住
// ---------------------------------------------------------------------------
console.log("pickNextApiKey — sticky");

await checkAsync("sticky：连续选中同一个 key（游标不前移）", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b"), K("c")]);
    const first = await pickNextApiKey(secrets, "sticky");
    const second = await pickNextApiKey(secrets, "sticky");
    assert.equal(first.value, "a");
    assert.equal(second.value, "a"); // 钉住
});

await checkAsync("sticky：当前 key 失效后切到下一个并钉住", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b"), K("c")]);
    await pickNextApiKey(secrets, "sticky"); // 钉住 a
    // a 失效（持久化不可用）
    await markApiKeyExhausted(secrets, "a", "无效 key", "rotatePersist");
    const next = await pickNextApiKey(secrets, "sticky");
    assert.equal(next.value, "b");
    const again = await pickNextApiKey(secrets, "sticky");
    assert.equal(again.value, "b"); // 钉住 b
});

// ---------------------------------------------------------------------------
// 3. pickNextApiKey — single
// ---------------------------------------------------------------------------
console.log("pickNextApiKey — single");

await checkAsync("single：返回 active key", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b"), K("c")], 1);
    const picked = await pickNextApiKey(secrets, "single");
    assert.equal(picked.value, "b");
});

await checkAsync("single：active key 不可用时返回 undefined", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a", { available: false }), K("b")], 0);
    const picked = await pickNextApiKey(secrets, "single");
    assert.equal(picked, undefined);
});

// ---------------------------------------------------------------------------
// 4. 瞬态冷却跳过
// ---------------------------------------------------------------------------
console.log("瞬态冷却");

await checkAsync("冷却中的 key 被跳过（429 仅内存冷却）", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "限流", "rotateCooldown"); // 瞬态 → 仅冷却
    const picked = await pickNextApiKey(secrets, "rotation");
    assert.equal(picked.value, "b");
});

await checkAsync("markApiKeyAvailable 清除冷却", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    await markApiKeyExhausted(secrets, "a", "限流", "rotateCooldown");
    await markApiKeyAvailable(secrets, "a");
    const picked = await pickNextApiKey(secrets, "rotation");
    assert.equal(picked.value, "a");
});

// ---------------------------------------------------------------------------
// 5. getPrimaryApiKey
// ---------------------------------------------------------------------------
console.log("getPrimaryApiKey");

await checkAsync("single 模式返回 active key", async () => {
    settings = { apiKeyMode: "single" };
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")], 1);
    const primary = await getPrimaryApiKey(secrets);
    assert.equal(primary.value, "b");
    settings = {};
});

await checkAsync("空 store 返回 undefined", async () => {
    const secrets = makeSecrets();
    await reset(secrets, []);
    const primary = await getPrimaryApiKey(secrets);
    assert.equal(primary, undefined);
});

// ---------------------------------------------------------------------------
// 6. shouldSingleKeyFallbackSwitch
// ---------------------------------------------------------------------------
console.log("shouldSingleKeyFallbackSwitch");

await checkAsync("仅 rotatePersist 原因返回 true", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")], 0);
    assert.equal(
        await shouldSingleKeyFallbackSwitch(secrets, new Map([["a", { action: "rotatePersist" }]])),
        true,
    );
    assert.equal(
        await shouldSingleKeyFallbackSwitch(secrets, new Map([["a", { action: "rotateCooldown" }]])),
        false,
    );
    assert.equal(
        await shouldSingleKeyFallbackSwitch(secrets, new Map([["a", { action: "retrySameKey" }]])),
        false,
    );
    assert.equal(await shouldSingleKeyFallbackSwitch(secrets, new Map()), false);
});

// ---------------------------------------------------------------------------
// 7. setActiveKeyByValue
// ---------------------------------------------------------------------------
console.log("setActiveKeyByValue");

await checkAsync("按值移动 activeIndex", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b"), K("c")], 0);
    await setActiveKeyByValue(secrets, "c");
    const store = await getApiKeyStore(secrets);
    assert.equal(store.activeIndex, 2);
});

await checkAsync("值不存在时不改动", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")], 0);
    await setActiveKeyByValue(secrets, "zzz");
    const store = await getApiKeyStore(secrets);
    assert.equal(store.activeIndex, 0);
});

// ---------------------------------------------------------------------------
// 8. store 增删改
// ---------------------------------------------------------------------------
console.log("store 增删改");

await checkAsync("addApiKey 拒绝重复值", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a")]);
    assert.equal(await addApiKey(secrets, K("a")), false);
    assert.equal(await addApiKey(secrets, K("b")), true);
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.length, 2);
});

await checkAsync("addApiKeys：已存在 key 不重复添加", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a")]);
    const result = await addApiKeys(secrets, [
        { value: "a", label: "dup" },
        { value: "b", label: "new" },
    ]);
    assert.equal(result.added, 1);
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.length, 2);
});

await checkAsync("removeApiKey 修正 activeIndex", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b"), K("c")], 2);
    await removeApiKey(secrets, 2);
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.length, 2);
    assert.equal(store.activeIndex, 1); // 越界修正为最后一个
});

await checkAsync("updateApiKey 值冲突校验", async () => {
    const secrets = makeSecrets();
    await reset(secrets, [K("a"), K("b")]);
    const conflict = await updateApiKey(secrets, 0, { value: "b" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    const ok = await updateApiKey(secrets, 0, { value: "a2", label: "L" });
    assert.equal(ok.ok, true);
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys[0].value, "a2");
    assert.equal(store.keys[0].label, "L");
});

// ---------------------------------------------------------------------------
// 9. 旧版单 key 迁移
// ---------------------------------------------------------------------------
console.log("旧版单 key 迁移");

await checkAsync("从 amdTokenFactory.apiKey 迁移到新格式", async () => {
    const secrets = makeSecrets({ "amdTokenFactory.apiKey": "legacy-key" });
    invalidateApiKeyStoreCache();
    const store = await getApiKeyStore(secrets);
    assert.equal(store.keys.length, 1);
    assert.equal(store.keys[0].value, "legacy-key");
    // 迁移后旧 key 被删除
    assert.equal(await secrets.get("amdTokenFactory.apiKey"), undefined);
});

Module._load = originalLoad;
console.log(`\nkeys: ${passed} checks passed`);
