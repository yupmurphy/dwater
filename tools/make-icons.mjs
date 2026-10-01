// Draws the dwater icons: a white drop with a little heart on a pink gradient.
// Pure Node + zlib, so the icons can be regenerated without any toolchain.
//
//   node tools/make-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

// ---------- minimal PNG writer ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10..12: deflate, adaptive filtering, no interlace - all zero already.

  // One filter byte (0 = none) in front of every scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const from = y * width * 4;
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, from, from + width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- the artwork, in 0..1 coordinates ----------

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const PINK_LIGHT = [255, 186, 214];
const PINK_DARK = [238, 74, 129];
const DROP_TOP = [255, 255, 255];
const DROP_BOTTOM = [255, 235, 244];
const HEART = [245, 88, 143];

// A teardrop: a circle below, and above it a tapering neck whose half-width
// follows a quarter sine. That curve flattens exactly where it meets the
// circle's widest point, so the two halves join without a visible kink.
function dropMask(x, y, scale) {
  const cx = 0.5;
  const cy = 0.5 + 0.15 * scale;
  const r = 0.25 * scale;
  const apexY = 0.5 - 0.36 * scale;

  const dx = Math.abs(x - cx);
  if (dx * dx + (y - cy) * (y - cy) <= r * r) return true;
  if (y < apexY || y > cy) return false;

  const t = (y - apexY) / (cy - apexY);
  return dx <= r * Math.sin((Math.PI / 2) * t);
}

function heartMask(x, y, scale) {
  const size = 0.115 * scale;
  const u = (x - 0.5) / size;
  const v = -(y - (0.5 + 0.145 * scale)) / size;
  const q = u * u + v * v - 1;
  return q * q * q - u * u * v * v * v <= 0;
}

// Returns an opaque RGB colour for one sample point.
function sample(x, y, scale) {
  if (dropMask(x, y, scale)) {
    if (heartMask(x, y, scale)) return HEART;
    const t = Math.min(1, Math.max(0, (y - 0.2) / 0.6));
    const base = mix(DROP_TOP, DROP_BOTTOM, t);
    // A soft highlight on the upper left of the bulge.
    const hx = (x - 0.39) / 0.1;
    const hy = (y - 0.52) / 0.14;
    const glow = Math.max(0, 1 - (hx * hx + hy * hy));
    return mix(base, [255, 255, 255], glow * 0.9);
  }
  return mix(PINK_LIGHT, PINK_DARK, Math.min(1, (x + y) / 2));
}

const SAMPLES = 3; // supersampling grid per axis, for smooth edges

function draw(size, scale) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [cr, cg, cb] = sample(
            (px + (sx + 0.5) / SAMPLES) / size,
            (py + (sy + 0.5) / SAMPLES) / size,
            scale,
          );
          r += cr; g += cg; b += cb;
        }
      }
      const n = SAMPLES * SAMPLES;
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(r / n);
      rgba[at + 1] = Math.round(g / n);
      rgba[at + 2] = Math.round(b / n);
      rgba[at + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });

// scale 1 fills the square; maskable icons shrink the art into the safe zone.
const icons = [
  ["icon-192.png", 192, 1],
  ["icon-512.png", 512, 1],
  ["maskable-512.png", 512, 0.62],
  ["apple-touch-icon.png", 180, 1],
];

for (const [name, size, scale] of icons) {
  const png = draw(size, scale);
  writeFileSync(join(OUT, name), png);
  console.log(`${name.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
