// 品牌图标生成 (零依赖): 由 assets/logo.png 派生扩展图标与页面 logo
//
// 背景: Chrome MV3 的 manifest 只接受位图, 且需要 16/32/48/128 四种尺寸, 无法直接引用
// 一张 logo.png。这里在构建期用内置的 PNG 解码 / Lanczos3 重采样 / PNG 编码把 logo.png
// 缩放成各尺寸图标, 仓库里因此只需保留唯一一份品牌图 assets/logo.png。
//
// 用法:
//   node scripts/icon.mjs [outDir]     # 默认 dist/icons + dist/logo.png
// 作为模块: vite.config.mts 在构建/开发时调用 buildBrandAssets()。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

/** manifest.json / action.default_icon 需要的尺寸 */
export const ICON_SIZES = [16, 32, 48, 128];

// ---------------- PNG 解码 ----------------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 解码 8bit 非隔行 PNG 为 RGBA 像素 (支持灰度 / RGB / 调色板 / 带 alpha 四种色型) */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`仅支持 8bit PNG (当前 ${data[8]}bit)`);
      if (data[12] !== 0) throw new Error('不支持隔行 (Adam7) PNG');
      colorType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`不支持的 PNG 色型: ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const pixels = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(0);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev.length ? prev[i] : 0;
      const c = i >= ch && prev.length ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const est = a + b - c;
        const pa = Math.abs(est - a);
        const pb = Math.abs(est - b);
        const pc = Math.abs(est - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }

  // 统一成 RGBA
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * ch;
    const d = i * 4;
    if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
      rgba[d + 3] = 255;
    } else if (colorType === 2) {
      rgba[d] = pixels[s];
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s + 2];
      rgba[d + 3] = 255;
    } else if (colorType === 3) {
      const idx = pixels[s];
      rgba[d] = palette[idx * 3];
      rgba[d + 1] = palette[idx * 3 + 1];
      rgba[d + 2] = palette[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
      rgba[d + 3] = pixels[s + 1];
    } else {
      rgba[d] = pixels[s];
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s + 2];
      rgba[d + 3] = pixels[s + 3];
    }
  }
  return { width, height, data: rgba };
}

// ---------------- PNG 编码 ----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** 编码 RGBA 像素为 PNG (逐行自适应滤波, deflate 最高压缩) */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const candidate = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < height; y += 1) {
    const line = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const out = candidate[f];
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= 4 ? line[i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const c = i >= 4 && prev ? prev[i - 4] : 0;
        let v = line[i];
        if (f === 1) v -= a;
        else if (f === 2) v -= b;
        else if (f === 3) v -= (a + b) >> 1;
        else if (f === 4) {
          const est = a + b - c;
          const pa = Math.abs(est - a);
          const pb = Math.abs(est - b);
          const pc = Math.abs(est - c);
          v -= pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        out[i] = v & 0xff;
        score += out[i] < 128 ? out[i] : 256 - out[i];
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    candidate[best].copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- Lanczos3 重采样 ----------------

const lanczos3 = (x) => {
  const a = 3;
  const ax = Math.abs(x);
  if (ax === 0) return 1;
  if (ax >= a) return 0;
  const px = Math.PI * ax;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
};

/** 每个目标像素在源轴上采样哪些点 (含归一化权重), 缩小时按比例放宽核半径以抗锯齿 */
const taps = (srcSize, dstSize) => {
  const scale = srcSize / dstSize;
  const filterScale = Math.max(1, scale);
  const radius = 3 * filterScale;
  const result = [];
  for (let i = 0; i < dstSize; i += 1) {
    const center = (i + 0.5) * scale - 0.5;
    const list = [];
    let sum = 0;
    for (let j = Math.ceil(center - radius); j <= Math.floor(center + radius); j += 1) {
      if (j < 0 || j >= srcSize) continue;
      const w = lanczos3((j - center) / filterScale);
      if (w === 0) continue;
      list.push([j, w]);
      sum += w;
    }
    result.push(list.map(([j, w]) => [j, w / sum]));
  }
  return result;
};

/** 缩放 RGBA 图像 (alpha 预乘后插值, 避免透明边缘发黑) */
export function resize({ width, height, data }, dstWidth, dstHeight) {
  const src = new Float64Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const a = data[i * 4 + 3] / 255;
    src[i * 4] = data[i * 4] * a;
    src[i * 4 + 1] = data[i * 4 + 1] * a;
    src[i * 4 + 2] = data[i * 4 + 2] * a;
    src[i * 4 + 3] = data[i * 4 + 3];
  }

  const xTaps = taps(width, dstWidth);
  const yTaps = taps(height, dstHeight);
  const mid = new Float64Array(dstWidth * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < dstWidth; x += 1) {
      const out = (y * dstWidth + x) * 4;
      for (const [sx, w] of xTaps[x]) {
        const i = (y * width + sx) * 4;
        mid[out] += src[i] * w;
        mid[out + 1] += src[i + 1] * w;
        mid[out + 2] += src[i + 2] * w;
        mid[out + 3] += src[i + 3] * w;
      }
    }
  }

  const out = new Uint8Array(dstWidth * dstHeight * 4);
  for (let y = 0; y < dstHeight; y += 1) {
    for (let x = 0; x < dstWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sy, w] of yTaps[y]) {
        const i = (sy * dstWidth + x) * 4;
        r += mid[i] * w;
        g += mid[i + 1] * w;
        b += mid[i + 2] * w;
        a += mid[i + 3] * w;
      }
      const o = (y * dstWidth + x) * 4;
      const alpha = Math.max(0, Math.min(255, a));
      const k = alpha > 0 ? 255 / alpha : 0;
      out[o] = Math.max(0, Math.min(255, Math.round(r * k)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g * k)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b * k)));
      out[o + 3] = Math.round(alpha);
    }
  }
  return { width: dstWidth, height: dstHeight, data: out };
}

// ---------------- 对外接口 ----------------

/**
 * 由品牌图生成构建期产物: logo.png (原样) + icons/icon<size>.png (各尺寸)
 * @returns {Map<string, Buffer>} 相对扩展根目录的文件名 → 内容
 */
export function buildBrandAssets(logoFile, sizes = ICON_SIZES) {
  const logo = readFileSync(logoFile);
  const image = decodePng(logo);
  const assets = new Map([['logo.png', logo]]);
  for (const size of sizes) {
    // key 用 / 分隔, 既是扩展内的相对路径也便于开发服务器按 URL 匹配
    assets.set(`icons/icon${size}.png`, encodePng(resize(image, size, size)));
  }
  return assets;
}

/** 把产物写到磁盘 (构建结束时调用) */
export function writeBrandAssets(outDir, logoFile, sizes = ICON_SIZES) {
  for (const [name, content] of buildBrandAssets(logoFile, sizes)) {
    const file = join(outDir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// 直接执行: node scripts/icon.mjs [outDir]
const invokedPath = process.argv[1] ? resolve(process.argv[1]).replace(/\\/g, '/') : '';
if (invokedPath.endsWith('/scripts/icon.mjs')) {
  const outDir = resolve(process.argv[2] ?? 'dist');
  const logoFile = resolve('assets/logo.png');
  writeBrandAssets(outDir, logoFile);
  for (const size of ICON_SIZES) console.log(`icons/icon${size}.png`);
  console.log(`logo.png  →  ${outDir}`);
}
