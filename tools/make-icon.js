/* 生成 Toy 图标（512×512 PNG，无第三方依赖）：node tools/make-icon.js
 * 暖白纸底 + 鼠尾草圆 + 白色麦克风，和页面配色一致。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;      // 输出尺寸
const SS = 2;       // 超采样倍数
const N = S * SS;

const CREAM = [0xF7, 0xF4, 0xED];
const SAGE = [0x8F, 0xAE, 0x8B];
const WHITE = [0xFF, 0xFF, 0xFF];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

// 覆盖率：0..1，用于简单抗锯齿
function circleCov(x, y, cx, cy, r, soft) {
  const d = Math.hypot(x - cx, y - cy);
  return Math.max(0, Math.min(1, (r + soft - d) / (soft * 2)));
}
function roundRectCov(x, y, x0, y0, w, h, r, soft) {
  const cx = x0 + w / 2, cy = y0 + h / 2;
  const qx = Math.abs(x - cx) - (w / 2 - r);
  const qy = Math.abs(y - cy) - (h / 2 - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.max(0, Math.min(1, -d / soft));
}
function ringCov(x, y, cx, cy, r, w, aFrom, aTo, soft) {
  const d = Math.hypot(x - cx, y - cy);
  const ring = Math.max(0, Math.min(1, (w / 2 + soft - Math.abs(d - r)) / (soft * 2)));
  if (ring <= 0) return 0;
  let a = Math.atan2(y - cy, x - cx);
  const norm = (v) => (v + Math.PI * 2) % (Math.PI * 2);
  a = norm(a);
  return (a >= aFrom && a <= aTo) ? ring : 0;
}

const buf = new Float32Array(N * N * 3);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let c = CREAM;
    const bg = circleCov(x, y, N / 2, N / 2, N * 0.34, 1.2);
    c = mix(c, SAGE, bg);

    // 麦克风主体
    const body = roundRectCov(x, y, N * 0.44, N * 0.30, N * 0.12, N * 0.22, N * 0.06, 1.2);
    // 下方半圆环
    const ring = ringCov(x, y, N / 2, N * 0.50, N * 0.115, N * 0.026, 0.06, Math.PI - 0.06, 1.2);
    // 支杆
    const stem = roundRectCov(x, y, N * 0.488, N * 0.62, N * 0.024, N * 0.10, N * 0.012, 1.2);

    const cover = Math.max(body, ring, stem);
    c = mix(c, WHITE, cover);

    const i = (y * N + x) * 3;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
  }
}

// 降采样
const out = Buffer.alloc(S * S * 3);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * N + (x * SS + dx)) * 3;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      }
    }
    const k = SS * SS;
    const o = (y * S + x) * 3;
    out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k;
  }
}

/* ---- PNG 编码 ---- */
const table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // color type: RGB

const raw = Buffer.alloc((S * 3 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 3 + 1)] = 0;
  out.copy(raw, y * (S * 3 + 1) + 1, y * S * 3, (y + 1) * S * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const dir = path.resolve(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'icon.png');
fs.writeFileSync(file, png);
console.log('icon.png ' + (png.length / 1024).toFixed(1) + ' KB -> ' + file);
