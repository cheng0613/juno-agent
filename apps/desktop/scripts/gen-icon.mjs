/**
 * 生成应用图标（纯 Node，不依赖 Electron / sharp）。
 *
 * 做法：直接逐像素画位图，再手写 PNG 和 ICO 编码。
 * 图标很简单（圆角方块 + J 字形 + 红点），不需要 SVG 渲染器。
 *
 * 为什么不用 Electron 的 nativeImage：实测 app.whenReady 在无窗口脚本里
 * 会挂住不退出，跑一次要手动杀进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 位图 → PNG */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10,11,12 = compression/filter/interlace = 0

  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 画图 ---------------- */

/** 在 (x,y) 处画圆角矩形的填充判断 */
function insideRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点到线段的距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/**
 * 渲染一张 size×size 的图标。
 *
 * 坐标系统一用 0..64 的逻辑坐标，再按比例放大 —— 这样小尺寸和大尺寸
 * 的形状完全一致，只是精度不同。
 */
function render(size) {
  const S = size / 64;
  const buf = Buffer.alloc(size * size * 4);

  // 背景渐变：顶部 #3C3F43 → 底部 #22252A
  const top = [0x3c, 0x3f, 0x43];
  const bottom = [0x22, 0x25, 0x2a];

  // J 字形：竖笔 + 底部左钩（三段线）
  const strokes = [
    [36, 15, 36, 39],
    [36, 39, 33, 47],
    [33, 47, 26, 50],
    [26, 50, 19, 47],
    [19, 47, 16, 41],
  ];
  const strokeW = 3.2; // 逻辑单位，半宽

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const lx = (x + 0.5) / S;
      const ly = (y + 0.5) / S;
      const i = (y * size + x) * 4;

      // 圆角方块外透明
      if (!insideRoundRect(lx, ly, 0, 0, 64, 64, 14)) {
        buf[i + 3] = 0;
        continue;
      }

      // 背景渐变
      const t = ly / 64;
      buf[i] = Math.round(top[0] + (bottom[0] - top[0]) * t);
      buf[i + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t);
      buf[i + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t);

      /*
       * J 白字用有符号距离场（SDF）画：
       *   先求到笔画中心线的最近距离，
       *   再减去笔画半宽 —— 结果就是「离字形边缘还有多远」。
       * 这样段与段的接头天然是圆角，抗锯齿也只依赖一个数值，
       * 不会出现分段画法那种接头断裂、边缘发虚。
       */
      let d = Infinity;
      for (const [x1, y1, x2, y2] of strokes) {
        d = Math.min(d, distToSegment(lx, ly, x1, y1, x2, y2));
      }
      const sd = d - strokeW; // < 0 在字形内
      // 1 个逻辑单位的过渡带做抗锯齿
      if (sd < 1) {
        const a = sd <= 0 ? 1 : 1 - sd;
        buf[i] = Math.round(buf[i] * (1 - a) + 255 * a);
        buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + 255 * a);
        buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + 255 * a);
      }

      // 右上角红点（同样用 SDF 做抗锯齿）
      const dc = Math.hypot(lx - 47, ly - 16) - 4;
      if (dc < 1) {
        const a = dc <= 0 ? 1 : 1 - dc;
        buf[i] = Math.round(buf[i] * (1 - a) + 0xe5 * a);
        buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + 0x48 * a);
        buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + 0x4d * a);
      }

      buf[i + 3] = 255;
    }
  }
  return buf;
}

/* ---------------- 输出 ---------------- */

const outDir = path.resolve('build');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const pngs = sizes.map((size) => {
  const png = encodePng(size, size, render(size));
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  return { size, png };
});
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs.find((p) => p.size === 512).png);

// ICO 容器：6 字节头 + N×16 字节目录 + 各图 PNG（Vista 后允许直接放 PNG）
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const dir = Buffer.alloc(16 * pngs.length);
let offset = 6 + 16 * pngs.length;
pngs.forEach((p, i) => {
  const b = i * 16;
  dir.writeUInt8(p.size >= 256 ? 0 : p.size, b);
  dir.writeUInt8(p.size >= 256 ? 0 : p.size, b + 1);
  dir.writeUInt16LE(1, b + 4);
  dir.writeUInt16LE(32, b + 6);
  dir.writeUInt32LE(p.png.length, b + 8);
  dir.writeUInt32LE(offset, b + 12);
  offset += p.png.length;
});
const ico = Buffer.concat([header, dir, ...pngs.map((p) => p.png)]);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

console.log(`✓ 图标已生成（${pngs.length} 个尺寸）`);
console.log(`  build/icon.ico  ${(ico.length / 1024).toFixed(1)} KB`);
console.log(`  build/icon.png  512×512`);
