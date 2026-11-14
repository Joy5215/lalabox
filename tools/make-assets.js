/* 生成 Toy 图标与封面（纯 Node，无依赖）：node tools/make-assets.js
 * 输出 assets/icon.png (512×512) 与 assets/poster.png (1200×675)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CREAM = [0xF7, 0xF4, 0xED];
const SAGE = [0x8F, 0xAE, 0x8B];
const SAND = [0xE4, 0xD2, 0xB4];
const CLAY = [0xD9, 0x9C, 0x8A];
const WHITE = [0xFF, 0xFF, 0xFF];

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t)
];

function circle(x, y, cx, cy, r) {
  return Math.max(0, Math.min(1, (r - Math.hypot(x - cx, y - cy)) + 0.5));
}
function roundRect(x, y, x0, y0, w, h, r) {
  const cx = x0 + w / 2, cy = y0 + h / 2;
  const qx = Math.abs(x - cx) - (w / 2 - r);
  const qy = Math.abs(y - cy) - (h / 2 - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.max(0, Math.min(1, -d + 0.5));
}
function arcRing(x, y, cx, cy, r, w, from, to) {
  const d = Math.hypot(x - cx, y - cy);
  const ring = Math.max(0, Math.min(1, (w / 2) - Math.abs(d - r) + 0.5));
  if (ring <= 0) return 0;
  let a = Math.atan2(y - cy, x - cx);
  if (a < 0) a += Math.PI * 2;
  return (a >= from && a <= to) ? ring : 0;
}

function drawScene(x, y, W, H, opts) {
  const s = Math.min(W, H);
  let c = CREAM;

  // 背景柔光
  const bgA = circle(x, y, W * 0.14, H * 0.06, W * 0.55);
  c = mix(c, [0xF4, 0xEA, 0xD9], bgA * 0.55);
  const bgB = circle(x, y, W * 0.92, H * 0.94, W * 0.45);
  c = mix(c, [0xE9, 0xF0, 0xE7], bgB * 0.5);

  const cx = opts.cx * W;
  const cy = opts.cy * H;
  const r = opts.r * s;

  // 主圆
  c = mix(c, SAGE, circle(x, y, cx, cy, r));

  // 麦克风：机身 + 半环 + 支杆（相对圆尺寸）
  const bw = r * 0.34, bh = r * 0.62;
  const bx = cx - bw / 2, by = cy - r * 0.52;
  const body = roundRect(x, y, bx, by, bw, bh, bw * 0.48);
  const ring = arcRing(x, y, cx, cy + r * 0.05, r * 0.40, r * 0.085, 0.15, Math.PI - 0.15);
  const stem = roundRect(x, y, cx - r * 0.045, cy + r * 0.42, r * 0.09, r * 0.30, r * 0.045);
  c = mix(c, WHITE, Math.max(body, ring, stem));

  // 左侧波形装饰
  if (opts.bars) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const bx0 = W * 0.10 + i * W * 0.036;
      const hh = (opts.bars[i] || 0.3) * H * 0.5;
      const bar = roundRect(x, y, bx0, H * 0.5 - hh / 2, W * 0.016, hh, W * 0.008);
      c = mix(c, i % 2 ? SAND : CLAY, bar * 0.9);
    }
  }
  return c;
}

function render(W, H, opts) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = drawScene(x, y, W, H, opts);
      const o = (y * W + x) * 3;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
    }
  }
  return encodePNG(buf, W, H);
}

/* ---- PNG ---- */
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
function encodePNG(rgb, W, H) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const dir = path.resolve(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });

const icon = render(512, 512, { cx: 0.5, cy: 0.5, r: 0.345 });
fs.writeFileSync(path.join(dir, 'icon.png'), icon);

const poster = render(1200, 675, {
  cx: 0.72, cy: 0.5, r: 0.36,
  bars: [0.42, 0.68, 0.9, 0.6, 0.34]
});
fs.writeFileSync(path.join(dir, 'poster.png'), poster);

console.log('icon.png    ' + (icon.length / 1024).toFixed(1) + ' KB');
console.log('poster.png  ' + (poster.length / 1024).toFixed(1) + ' KB');
