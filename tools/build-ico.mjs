#!/usr/bin/env node
// Package assets/icon-<size>.png (16,24,32,48,64,128,256) into assets/aster.ico.
// PNG-compressed ICO frames; Vista and later read these directly.

import fs from 'node:fs';

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const frames = SIZES.map((size) => {
  const file = `assets/icon-${size}.png`;
  const data = fs.readFileSync(file);
  const sig = data.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') throw new Error(`${file} is not a PNG`);
  return { size, data };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);

let offset = 6 + 16 * frames.length;
const dirs = [];
for (const f of frames) {
  const d = Buffer.alloc(16);
  d[0] = f.size === 256 ? 0 : f.size;
  d[1] = f.size === 256 ? 0 : f.size;
  d[2] = 0;
  d[3] = 0;
  d.writeUInt16LE(1, 4);
  d.writeUInt16LE(32, 6);
  d.writeUInt32LE(f.data.length, 8);
  d.writeUInt32LE(offset, 12);
  offset += f.data.length;
  dirs.push(d);
}

const ico = Buffer.concat([header, ...dirs, ...frames.map((f) => f.data)]);
fs.writeFileSync('assets/aster.ico', ico);
console.log(`[ico] ${frames.length} frames, ${ico.length} bytes → assets/aster.ico`);
