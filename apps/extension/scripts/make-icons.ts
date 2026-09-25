// Draws the extension icons (a blue tile with three bars) as PNG files in public/icons.
// Run with `pnpm --filter @cfa/extension icons`. No image libraries needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const BLUE = [15, 108, 189];
const WHITE = [255, 255, 255];
// Bars as fractions of the tile: [x, y, width, height].
const BARS = [
  [0.2, 0.24, 0.6, 0.12],
  [0.2, 0.44, 0.36, 0.12],
  [0.2, 0.64, 0.48, 0.12],
];

function inRoundedRect(x: number, y: number, radius: number): boolean {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** Bars are capsules: every point within half the bar height of its centre line. */
function inBar(x: number, y: number): boolean {
  return BARS.some(([bx = 0, by = 0, bw = 0, bh = 0]) => {
    const r = bh / 2;
    const cx = Math.min(Math.max(x, bx + r), bx + bw - r);
    return (x - cx) ** 2 + (y - (by + r)) ** 2 <= r ** 2;
  });
}

function pixel(size: number, px: number, py: number): number[] {
  const samples = 4;
  let tile = 0;
  let bar = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const x = (px + (sx + 0.5) / samples) / size;
      const y = (py + (sy + 0.5) / samples) / size;
      if (inRoundedRect(x, y, 0.22)) {
        tile++;
        if (inBar(x, y)) bar++;
      }
    }
  }
  const total = samples * samples;
  if (tile === 0) return [0, 0, 0, 0];
  const mix = bar / tile;
  const rgb = BLUE.map((c, i) => Math.round(c + ((WHITE[i] ?? 255) - c) * mix));
  return [...rgb, Math.round((tile / total) * 255)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0); // no filter
    for (let x = 0; x < size; x++) rows.push(...pixel(size, x, y));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = resolve(import.meta.dirname, '../public/icons');
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) writeFileSync(resolve(outDir, `icon-${size}.png`), png(size));
console.log(`Wrote ${SIZES.length} icons to ${outDir}`);
