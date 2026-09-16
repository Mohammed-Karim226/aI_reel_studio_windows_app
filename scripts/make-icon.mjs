import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const RADIUS = 180;
const OUTPUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/app-icon.png");

let crcTable;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function roundedRectAlpha(x, y) {
  const cx = Math.min(x, SIZE - 1 - x);
  const cy = Math.min(y, SIZE - 1 - y);
  if (cx >= RADIUS || cy >= RADIUS) {
    return 255;
  }
  const dx = RADIUS - cx;
  const dy = RADIUS - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS ? 255 : 0;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[offset] = 0;
  offset += 1;
  for (let x = 0; x < SIZE; x += 1) {
    const t = y / (SIZE - 1);
    const u = x / (SIZE - 1);
    raw[offset] = Math.round(24 + 36 * u + 22 * t);
    raw[offset + 1] = Math.round(28 + 82 * t + 18 * u);
    raw[offset + 2] = Math.round(66 + 58 * (1 - t) + 34 * u);
    raw[offset + 3] = roundedRectAlpha(x, y);
    offset += 4;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, png);
console.log(`Wrote ${OUTPUT_PATH} (${png.length} bytes)`);
