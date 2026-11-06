// 把 dist/ 打包成可上传到 Chrome 应用商店 (或分发给他人加载) 的 zip
//
// 不依赖第三方库: 用 zlib 的 deflateRawSync + 手写 ZIP 目录结构,
// 产物: release/magic-tools-chrome-v<version>.zip
//
// 用法: npm run package   (= vite build && node scripts/package.mjs)

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ROOT = process.cwd();
const DIST = resolve(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const OUT_DIR = resolve(ROOT, 'release');
const OUT = resolve(OUT_DIR, `magic-tools-chrome-v${pkg.version}.zip`);

if (!existsSync(DIST)) {
  console.error('dist/ 不存在, 请先执行 npm run build');
  process.exit(1);
}

// ---------------- CRC32 (ZIP 校验) ----------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 递归收集 dist/ 下所有文件 (相对路径用 / 分隔) */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1; // 2024-01-01

const files = walk(DIST);
const localParts = [];
const centralParts = [];
let offset = 0;

for (const file of files) {
  const name = relative(DIST, file).split(/\\/).join('/');
  const data = readFileSync(file);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
  local.writeUInt16LE(20, 4);         // version needed
  local.writeUInt16LE(0x0800, 6);     // flags: UTF-8 文件名
  local.writeUInt16LE(8, 8);          // 压缩方式: deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);  // 中央目录签名
  central.writeUInt16LE(20, 4);          // version made by
  central.writeUInt16LE(20, 6);          // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);          // extra
  central.writeUInt16LE(0, 32);          // comment
  central.writeUInt16LE(0, 34);          // disk
  central.writeUInt16LE(0, 36);          // internal attr
  central.writeUInt32LE(0, 38);          // external attr
  central.writeUInt32LE(offset, 42);     // 本地头偏移
  centralParts.push(central, nameBuf);

  offset += local.length + nameBuf.length + compressed.length;
}

const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

mkdirSync(OUT_DIR, { recursive: true });
const ws = createWriteStream(OUT);
for (const part of [ ...localParts, ...centralParts, end ]) ws.write(part);
ws.end(() => {
  console.log(`已打包 ${files.length} 个文件 -> ${relative(ROOT, OUT)}`);
});
