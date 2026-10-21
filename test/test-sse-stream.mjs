import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Verifies consumeSseStream() flushes end-of-stream work (onDone) even when the
// stream ends WITHOUT a `[DONE]` sentinel. Regression: onDone (which flushes
// buffered tool calls) only ran on `[DONE]`, so a connection that closed
// cleanly mid-stream silently dropped any buffered tool calls.

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const vscodeShim = {
	window: {
		createOutputChannel: () => ({
			debug() {},
			info() {},
			warn() {},
			error() {},
			dispose() {},
		}),
	},
	workspace: {
		getConfiguration: () => ({ get: (_k, f) => f }),
	},
};
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeShim;
	}
	return originalLoad.call(this, request, parent, isMain);
};

let passed = 0;
async function check(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

/** Build a ReadableStream that emits the given chunks then closes. */
function streamOf(chunks) {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(encoder.encode(chunks[i++]));
			} else {
				controller.close();
			}
		},
	});
}

try {
	const { logger } = require("../out/core/logger.js");
	logger.init();
	const { consumeSseStream } = require("../out/api/sse.js");

	await check("收到 [DONE] 时 onDone 触发一次", async () => {
		let doneCount = 0;
		const events = [];
		await consumeSseStream(streamOf(['data: {"a":1}\n\n', "data: [DONE]\n\n"]), {
			tag: "test",
			modelId: "m",
			onEvent: (p) => events.push(p),
			onDone: () => {
				doneCount++;
			},
		});
		assert.equal(events.length, 1);
		assert.equal(doneCount, 1);
	});

	await check("无 [DONE] 哨兵（流自然结束）时 onDone 仍触发一次", async () => {
		let doneCount = 0;
		const events = [];
		await consumeSseStream(streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']), {
			tag: "test",
			modelId: "m",
			onEvent: (p) => events.push(p),
			onDone: () => {
				doneCount++;
			},
		});
		assert.equal(events.length, 2);
		assert.equal(doneCount, 1, "无 [DONE] 时也必须刷新缓冲（否则工具调用被丢弃）");
	});

	await check("onFinally 始终触发", async () => {
		let finallyCount = 0;
		await consumeSseStream(streamOf(['data: {"a":1}\n\n']), {
			tag: "test",
			modelId: "m",
			onEvent: () => {},
			onFinally: () => {
				finallyCount++;
			},
		});
		assert.equal(finallyCount, 1);
	});
} finally {
	Module._load = originalLoad;
}

console.log(`\nsse stream: ${passed} checks passed`);
