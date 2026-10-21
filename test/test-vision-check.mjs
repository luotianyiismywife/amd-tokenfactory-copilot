// 生成合法 32x32 PNG 并测试视觉模型输入
// 用法：node test/test-vision-check.mjs <API_KEY> [MODEL_ID]
//      或设置环境变量 PROVIDER_API_KEY
import { writeFileSync } from 'node:fs';

// 最小合法 PNG：1x1 红色像素（标准 PNG 头）
// 使用 zlib 生成合法 IDAT
import { deflateSync } from 'node:zlib';

function makePng(width, height) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    function chunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const typeBuf = Buffer.from(type, 'ascii');
        const crcInput = Buffer.concat([typeBuf, data]);
        // CRC32
        let crc = 0xffffffff;
        for (const byte of crcInput) {
            crc ^= byte;
            for (let i = 0; i < 8; i++) {
                crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
            }
        }
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([len, typeBuf, data, crcBuf]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: RGB
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) {
        raw[y * (1 + width * 3)] = 0; // filter none
        for (let x = 0; x < width; x++) {
            const off = y * (1 + width * 3) + 1 + x * 3;
            raw[off] = 0xff; raw[off + 1] = 0x00; raw[off + 2] = 0x00; // red
        }
    }
    const idat = deflateSync(raw);
    return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const png = makePng(32, 32);
const b64 = png.toString('base64');
const KEY = process.argv[2] || process.env.PROVIDER_API_KEY;
if (!KEY) {
    console.error('用法：node test/test-vision-check.mjs <API_KEY> [MODEL_ID]');
    process.exit(1);
}
// 默认用当前平台的视觉模型（2026-09-29 实测支持图片输入）
const MODEL = process.argv[3] || 'example-model';

const r = await fetch('https://api.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }, { type: 'text', text: 'what color' }] }],
        stream: false,
        max_tokens: 16,
    }),
});
const t = await r.text();
console.log(`${MODEL} vision (32x32 valid PNG):`, r.status);
console.log(t.slice(0, 300));
