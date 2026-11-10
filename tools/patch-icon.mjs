#!/usr/bin/env node
// Replace the icon resources of a PE image in place.
//
// The resource section is never resized: each RT_ICON payload is overwritten
// only when the new PNG fits the original slot, and both the data-entry Size
// and the RT_GROUP_ICON dwBytesInRes are updated. Section offsets, RVAs and
// the resource directory layout stay untouched.
//
// Usage: node tools/patch-icon.mjs <target.exe> [icons-dir]

import fs from 'node:fs';
import path from 'node:path';

const [, , target, iconsArg] = process.argv;
if (!target) {
  console.error('usage: node tools/patch-icon.mjs <target.exe> [icons-dir]');
  process.exit(2);
}
const iconsDir = iconsArg || 'assets';
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const buf = fs.readFileSync(target);
const u16 = (o) => buf.readUInt16LE(o);
const u32 = (o) => buf.readUInt32LE(o);
const w16 = (o, v) => buf.writeUInt16LE(v, o);
const w32 = (o, v) => buf.writeUInt32LE(v, o);

const pe = u32(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') fail('not a PE image');
const numSections = u16(pe + 6);
const optSize = u16(pe + 20);
const opt = pe + 24;
const magic = u16(opt);
const ddOff = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : fail('unknown optional header magic'));
const resRva = u32(ddOff + 2 * 8);
const resSize = u32(ddOff + 2 * 8 + 4);
if (!resRva) fail('no resource directory');

const sections = [];
for (let i = 0; i < numSections; i++) {
  const s = opt + optSize + i * 40;
  sections.push({
    name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''),
    vsize: u32(s + 8),
    va: u32(s + 12),
    rawSize: u32(s + 16),
    rawPtr: u32(s + 20),
  });
}

function rvaToOff(rva) {
  for (const s of sections) {
    const size = Math.max(s.vsize, s.rawSize);
    if (rva >= s.va && rva < s.va + size) return rva - s.va + s.rawPtr;
  }
  fail(`RVA 0x${rva.toString(16)} is not in any section`);
}

const base = rvaToOff(resRva);

function dirEntries(rel) {
  const off = base + rel;
  const named = u16(off + 12);
  const ids = u16(off + 14);
  const out = [];
  for (let i = 0; i < named + ids; i++) {
    const e = off + 16 + i * 8;
    out.push({ name: u32(e), data: u32(e + 4) });
  }
  return out;
}
const isDir = (v) => (v & 0x80000000) !== 0;
const dirOff = (v) => v & 0x7fffffff;

function dataEntry(rel) {
  const off = base + rel;
  return { off, rva: u32(off), size: u32(off + 4) };
}

const root = dirEntries(0);
const byType = (id) => root.find((e) => e.name === id);
const iconType = byType(3);
const groupType = byType(14);
if (!iconType || !groupType) fail('missing RT_ICON or RT_GROUP_ICON');

const iconEntries = dirEntries(dirOff(iconType.data)).map((nameEntry) => {
  const langs = dirEntries(dirOff(nameEntry.data));
  const first = langs[0] ?? fail('icon has no language entry');
  return { id: nameEntry.name, entry: dataEntry(first.data) };
});

const groupEntry = dirEntries(dirOff(groupType.data))[0] ?? fail('no icon group');
const groupData = dataEntry(dirEntries(dirOff(groupEntry.data))[0].data);
const groupOff = rvaToOff(groupData.rva);
const groupCount = u16(groupOff + 4);
if (u16(groupOff) !== 0 || u16(groupOff + 2) !== 1) fail('unexpected RT_GROUP_ICON header');

const report = [];
for (let i = 0; i < groupCount; i++) {
  const e = groupOff + 6 + i * 14;
  const width = buf[e];
  const height = buf[e + 1];
  const bytesInRes = u32(e + 8);
  const id = u16(e + 12);
  const size = width === 0 ? 256 : width;
  if (!SIZES.includes(size) || size !== (height === 0 ? 256 : height)) {
    fail(`group entry ${i} has unsupported dimensions ${width}x${height}`);
  }

  const icon = iconEntries.find((x) => x.id === id) ?? fail(`RT_ICON id ${id} not found`);
  const pngPath = path.join(iconsDir, `icon-${size}.png`);
  if (!fs.existsSync(pngPath)) fail(`missing ${pngPath}`);
  const png = fs.readFileSync(pngPath);
  if (png.length > icon.entry.size) {
    fail(`${size}px icon is ${png.length}B, original slot is ${icon.entry.size}B`);
  }

  const payloadOff = rvaToOff(icon.entry.rva);
  png.copy(buf, payloadOff);
  buf.fill(0, payloadOff + png.length, payloadOff + icon.entry.size);
  w32(icon.entry.off + 4, png.length);
  w32(e + 8, png.length);

  report.push(`${size}x${size}: ${png.length}B (slot ${icon.entry.size}B, id ${id}, width field ${bytesInRes}B before)`);
}

fs.writeFileSync(target, buf);
for (const line of report) console.log(`[icon] ${line}`);
console.log(`[icon] wrote ${target}`);

function fail(msg) {
  console.error(`[icon] ${msg}`);
  process.exit(1);
}
