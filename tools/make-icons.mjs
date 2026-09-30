#!/usr/bin/env node
/**
 * Icon builder.
 *
 * Reads `build/icon-source.png` (1024×1024 artwork), trims the flat background
 * margin, and writes a multi-resolution Windows icon plus the individual PNGs
 * the application uses at runtime.
 *
 * The PNG and ICO containers are written by hand on top of Node's `zlib`, so
 * the build has no image-library dependency at all. Sizes 16 → 256 are stored
 * as PNG-compressed entries, which Windows Vista and later read natively.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { deflateSync, inflateSync } from 'node:zlib';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const sourcePath = path.join(root, 'build', 'icon-source.png');
const outDir = path.join(root, 'build', 'icons');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZES = [64, 128, 256, 512];

// ---------------------------------------------------------------------------
// PNG decoding (8-bit, non-interlaced: greyscale, RGB, greyscale+alpha, RGBA)
// ---------------------------------------------------------------------------

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('The file is not a PNG image.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }

  if (bitDepth !== 8) throw new Error(`The icon source must be 8 bits per channel (found ${bitDepth}).`);
  if (interlace !== 0) throw new Error('Interlaced PNG files are not supported — save the artwork without interlacing.');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colourType}.`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const priorStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + x];
      const left = x >= channels ? pixels[outStart + x - channels] : 0;
      const up = y > 0 ? pixels[priorStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[priorStart + x - channels] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          restored = value + predictor;
          break;
        }
        default:
          throw new Error(`Unknown PNG filter type ${filter}.`);
      }
      pixels[outStart + x] = restored & 0xff;
    }
  }

  // Normalise every colour type to straight RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const source = i * channels;
    let r;
    let g;
    let b;
    let a = 255;
    if (channels === 1) {
      r = g = b = pixels[source];
    } else if (channels === 2) {
      r = g = b = pixels[source];
      a = pixels[source + 1];
    } else if (channels === 3) {
      r = pixels[source];
      g = pixels[source + 1];
      b = pixels[source + 2];
    } else {
      r = pixels[source];
      g = pixels[source + 1];
      b = pixels[source + 2];
      a = pixels[source + 3];
    }
    const target = i * 4;
    rgba[target] = r;
    rgba[target + 1] = g;
    rgba[target + 2] = b;
    rgba[target + 3] = a;
  }

  return { width, height, pixels: rgba };
}

// ---------------------------------------------------------------------------
// PNG encoding (colour type 6, one filter per row chosen as "none")
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 4; // Paeth filter compresses photographic gradients best.
    const rowStart = y * (stride + 1) + 1;
    const priorStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = pixels[y * stride + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[priorStart + x] : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[priorStart + x - 4] : 0;
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      raw[rowStart + x] = (value - predictor) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Trim the flat background margin so the artwork fills the icon. */
function trimBackground(image, tolerance = 26) {
  const { width, height, pixels } = image;
  const sample = (x, y) => {
    const i = (y * width + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
  };
  const corner = sample(0, 0);
  const differs = (x, y) => {
    const [r, g, b, a] = sample(x, y);
    if (a === 0) return false;
    return (
      Math.abs(r - corner[0]) > tolerance ||
      Math.abs(g - corner[1]) > tolerance ||
      Math.abs(b - corner[2]) > tolerance ||
      Math.abs(a - corner[3]) > tolerance
    );
  };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!differs(x, y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return image; // Nothing to trim — the artwork is a flat colour.

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const side = Math.max(boxWidth, boxHeight);
  const centreX = minX + boxWidth / 2;
  const centreY = minY + boxHeight / 2;
  const startX = Math.round(centreX - side / 2);
  const startY = Math.round(centreY - side / 2);

  const cropped = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const sourceX = startX + x;
      const sourceY = startY + y;
      const inside = sourceX >= 0 && sourceY >= 0 && sourceX < width && sourceY < height;
      const target = (y * side + x) * 4;
      if (!inside) continue;
      const source = (sourceY * width + sourceX) * 4;
      cropped[target] = pixels[source];
      cropped[target + 1] = pixels[source + 1];
      cropped[target + 2] = pixels[source + 2];
      cropped[target + 3] = pixels[source + 3];
    }
  }
  return { width: side, height: side, pixels: cropped };
}

/** Box-filter resize with premultiplied alpha, so edges stay clean. */
function resize(image, size) {
  const { width, height, pixels } = image;
  const out = Buffer.alloc(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * width + sx) * 4;
          const alpha = pixels[i + 3] / 255;
          r += pixels[i] * alpha;
          g += pixels[i + 1] * alpha;
          b += pixels[i + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }
      const target = (y * size + x) * 4;
      if (count === 0 || a === 0) continue;
      out[target] = Math.round(r / a);
      out[target + 1] = Math.round(g / a);
      out[target + 2] = Math.round(b / a);
      out[target + 3] = Math.round((a / count) * 255);
    }
  }
  return { width: size, height: size, pixels: out };
}

/** Round the corners of a square image, matching the Windows tile shape. */
function roundCorners(image, radiusRatio = 0.22) {
  const { width, height, pixels } = image;
  const radius = width * radiusRatio;
  const copy = Buffer.from(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = Math.max(radius - x, x - (width - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (height - 1 - radius), 0);
      if (dx === 0 || dy === 0) continue;
      const distance = Math.hypot(dx, dy);
      if (distance <= radius) continue;
      const feather = Math.max(0, Math.min(1, 1 - (distance - radius)));
      const i = (y * width + x) * 4;
      copy[i + 3] = Math.round(copy[i + 3] * feather);
    }
  }
  return { width, height, pixels: copy };
}

/** Windows ICO container holding PNG-compressed entries. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const start = index * 16;
    directory[start] = entry.size >= 256 ? 0 : entry.size;
    directory[start + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[start + 2] = 0; // palette
    directory[start + 3] = 0; // reserved
    directory.writeUInt16LE(1, start + 4); // colour planes
    directory.writeUInt16LE(32, start + 6); // bits per pixel
    directory.writeUInt32BE(0, start + 8);
    directory.writeUInt32LE(entry.data.length, start + 8);
    directory.writeUInt32LE(offset, start + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

// ---------------------------------------------------------------------------

const source = decodePng(await readFile(sourcePath));
const trimmed = trimBackground(source);
const squared = resize(trimmed, 1024);

await mkdir(outDir, { recursive: true });

const pngBuffers = new Map();
for (const size of [...new Set([...ICO_SIZES, ...PNG_SIZES])]) {
  pngBuffers.set(size, encodePng(resize(squared, size)));
}

const icoEntries = ICO_SIZES.map((size) => ({
  size,
  data: pngBuffers.get(size),
}));
await writeFile(path.join(outDir, 'icon.ico'), buildIco(icoEntries));

for (const size of PNG_SIZES) {
  await writeFile(path.join(outDir, `icon-${size}.png`), pngBuffers.get(size));
}
// The rounded variant is what the installer and the About screen show.
await writeFile(path.join(outDir, 'icon.png'), encodePng(roundCorners(resize(squared, 512))));

const icoSize = (await readFile(path.join(outDir, 'icon.ico'))).length;
console.log(`icons: build/icons/icon.ico written (${ICO_SIZES.join(', ')} px, ${(icoSize / 1024).toFixed(1)} kB)`);
console.log(`icons: build/icons/icon.png and icon-{${PNG_SIZES.join(',')}}.png written`);
if (process.env.DENTIVA_ICON_QUIET) process.exit(0);
