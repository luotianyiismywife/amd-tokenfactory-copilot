/**
 * 云同步 payload 去重测试（纯函数，无 vscode 依赖）。
 *
 * 覆盖 `syncPayloadHasChanged` 的空值 / 版本 / 长度 / 逐字段（value/label）
 * / 顺序分支，以及 `undefined` 与 `""` 等价、`updatedAt` 不参与比较。
 *
 * 运行前需 `npm run compile`（依赖 out/ 编译产物）。
 */

import assert from "node:assert/strict";
import { syncPayloadHasChanged } from "../out/cloud/syncPayload.js";

// 测试夹具：全部使用明显假的 key 值，避免任何真实凭据形态。
const mk = (keys, updatedAt = "2026-10-07T00:00:00.000Z") => ({ version: 1, updatedAt, keys });

const base = mk([
    { value: "sk_test_1", label: "alpha" },
    { value: "sk_test_2", label: "beta" },
]);

let passed = 0;
const check = (name, actual, expected) => {
    assert.equal(actual, expected, name);
    passed++;
    console.log(`  ok  ${name}`);
};

console.log("syncPayloadHasChanged");

// --- 空值分支 ---
check("remote 缺失 → 需要推送", syncPayloadHasChanged(base, undefined), true);
check("local 缺失 → 需要推送", syncPayloadHasChanged(undefined, base), true);
check("两者都缺失 → 需要推送", syncPayloadHasChanged(undefined, undefined), true);

// --- 相同 / 仅时间戳不同 ---
check("完全相同 → 不推送", syncPayloadHasChanged(base, mk(base.keys)), false);
check(
    "仅 updatedAt 不同 → 不推送（时间戳不参与比较）",
    syncPayloadHasChanged(base, mk(base.keys, "2026-10-07T09:99:00.000Z")),
    false,
);
check("两侧都是空 keys → 不推送", syncPayloadHasChanged(mk([]), mk([])), false);

// --- 版本 / 长度 ---
check("version 不同 → 推送", syncPayloadHasChanged(base, { ...mk(base.keys), version: 2 }), true);
check("local 比 remote 多一条 → 推送", syncPayloadHasChanged(base, mk([base.keys[0]])), true);
check("remote 比 local 多一条 → 推送", syncPayloadHasChanged(mk([base.keys[0]]), base), true);

// --- 逐字段差异 ---
check(
    "value 变化 → 推送",
    syncPayloadHasChanged(base, mk([{ ...base.keys[0], value: "sk_test_1b" }, base.keys[1]])),
    true,
);
check(
    "label 变化 → 推送",
    syncPayloadHasChanged(base, mk([base.keys[0], { ...base.keys[1], label: "beta-v2" }])),
    true,
);

// --- undefined 与空串等价（与 normalizeEntries 口径一致）---
check(
    'label undefined vs "" → 不推送',
    syncPayloadHasChanged(
        mk([{ value: "sk_test_1" }]),
        mk([{ value: "sk_test_1", label: "" }]),
    ),
    false,
);
check(
    "label 从有到无 → 推送",
    syncPayloadHasChanged(mk([{ value: "sk_test_1", label: "alpha" }]), mk([{ value: "sk_test_1" }])),
    true,
);

// --- 顺序敏感（轮换顺序有意义）---
check("顺序调换 → 推送", syncPayloadHasChanged(base, mk([base.keys[1], base.keys[0]])), true);

console.log(`\ncloud sync auto-push payload diff: ${passed} checks passed`);
