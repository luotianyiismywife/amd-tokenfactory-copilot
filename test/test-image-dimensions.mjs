import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Verifies getImageDimensions() parses PNG / GIF / JPEG / WebP dimensions.
// Regression: getMimeType() checked the PNG signature against the base64
// STRING's char codes (base64 'i' = 0x69) instead of the DECODED bytes, so
// every PNG returned "unknown" -> getImageDimensions threw -> image token
// counting silently fell back to a length-based estimate.

const require = createRequire(import.meta.url);
const { getImageDimensions } = require("../out/tokenizer/imageUtils.js");

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// 1x1 fixtures (base64, no data-URI prefix).
const PNG_1x1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1x1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const JPEG_1x1 =
	"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const WEBP_1x1 = "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";

check("PNG 尺寸解析（回归：曾因签名检测错误返回 unknown）", () => {
	const dims = getImageDimensions(`data:image/png;base64,${PNG_1x1}`);
	assert.deepEqual(dims, { width: 1, height: 1 });
});

check("GIF 尺寸解析", () => {
	const dims = getImageDimensions(`data:image/gif;base64,${GIF_1x1}`);
	assert.deepEqual(dims, { width: 1, height: 1 });
});

check("JPEG 尺寸解析", () => {
	const dims = getImageDimensions(`data:image/jpeg;base64,${JPEG_1x1}`);
	assert.deepEqual(dims, { width: 1, height: 1 });
});

check("WebP 尺寸解析", () => {
	const dims = getImageDimensions(`data:image/webp;base64,${WEBP_1x1}`);
	assert.deepEqual(dims, { width: 1, height: 1 });
});

check("非 data-URI 抛错", () => {
	assert.throws(() => getImageDimensions("not-a-data-uri"));
});

console.log(`\nimage dimensions: ${passed} checks passed`);
