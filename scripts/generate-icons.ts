// sidebarmobile — 图标生成脚本（scripts）
// 2026-09-29 | Kimi(speckit-implement) | 初始版本：生成纯色圆角方块占位图标（PNG）

/**
 * [DONE] 生成扩展图标占位 PNG（16/32/48/128）。
 *
 * 背景：清单声明了 icons，缺文件会导致扩展无法加载。正式图标属设计交付物，
 * 此处按 design-system 主色生成纯色圆角方块，保证构建产物可加载。
 * 依赖为零：直接用 node:zlib 手写 PNG（无第三方图像库，符合 YAGNI）。
 *
 * 使用：node --experimental-strip-types scripts/generate-icons.ts
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'src', 'icons');
const ICON_SIZES = [16, 32, 48, 128];

/** 主色（取自 design-system/MASTER.md 的 chrome-day primary） */
const BRAND_RGB: readonly [number, number, number] = [11, 87, 208];

/** PNG CRC32 表 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    const tableIndex = (crc ^ byte) & 0xff;
    crc = (CRC_TABLE[tableIndex] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk（长度 + 类型 + 数据 + CRC） */
function createChunk(type: string, data: Buffer): Buffer {
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

/** 生成圆角方块图标：主色填充，四角透明 */
function createIconPng(size: number): Buffer {
  const cornerRadius = Math.max(2, Math.round(size * 0.22));
  const rows: Buffer[] = [];

  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // 过滤类型：None
    for (let x = 0; x < size; x += 1) {
      const offset = 1 + x * 4;
      const isInsideCorner =
        (x < cornerRadius || x >= size - cornerRadius) && (y < cornerRadius || y >= size - cornerRadius);
      const nearestX = x < cornerRadius ? cornerRadius - 1 : size - cornerRadius;
      const nearestY = y < cornerRadius ? cornerRadius - 1 : size - cornerRadius;
      const distanceFromCorner = Math.hypot(x - nearestX, y - nearestY);
      const isOutsideRoundedCorner = isInsideCorner && distanceFromCorner > cornerRadius;
      row[offset] = BRAND_RGB[0];
      row[offset + 1] = BRAND_RGB[1];
      row[offset + 2] = BRAND_RGB[2];
      row[offset + 3] = isOutsideRoundedCorner ? 0 : 255;
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 位深
  header[9] = 6; // 颜色类型：RGBA
  header[10] = 0; // 压缩方法
  header[11] = 0; // 过滤方法
  header[12] = 0; // 隔行扫描

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    createChunk('IHDR', header),
    createChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    createChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const size of ICON_SIZES) {
    const filePath = path.join(OUTPUT_DIR, `icon-${size}.png`);
    await writeFile(filePath, createIconPng(size));
    console.log(`[icons] 已生成 ${path.relative(PROJECT_ROOT, filePath)}`);
  }
}

main().catch((error: unknown) => {
  console.error(`[icons] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
