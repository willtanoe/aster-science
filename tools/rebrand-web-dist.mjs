#!/usr/bin/env node
// Brand the extracted web UI that the daemon serves.
//
// The daemon unpacks an asset archive (assets.tar.gz) embedded in the
// executable into <data_dir>/runtime/<version>-release/. That tree contains
// web-dist/, a prebuilt SPA whose title, favicon, PWA icons and JS strings
// still say "Claude Science". Those bytes are compressed inside the
// executable, so the byte patches in patch-aster-science.mjs cannot reach
// them; this tool rewrites the extracted copy instead.
//
// It is version-agnostic: it scans runtime/*-release/web-dist, so a new
// upstream version (and a new runtime dir) is picked up automatically.
// Re-extraction after an upgrade overwrites the tree; running this again
// (the launcher does) restores the brand.
//
// Usage:
//   node tools/rebrand-web-dist.mjs [--data-dir <path>] [--quiet]
//   node tools/rebrand-web-dist.mjs --watch [--timeout 120]
//
// --watch waits for the first web-dist to appear (fresh install or upgrade),
// brands it once extraction is complete, then exits. Without --watch it
// brands whatever exists and exits immediately.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const quiet = has('--quiet');
const watch = has('--watch');
const dryRun = has('--dry-run');
const timeoutMs = Math.max(0, Number(valueOf('--timeout', '120'))) * 1000;

const repo = process.cwd();
const OLD_BRAND = 'Claude Science';
const NEW_BRAND = 'Aster  Science'; // same byte length as OLD_BRAND
const SVG_SOURCE = path.join(repo, 'assets', 'source', 'aster.svg');
const PNG_SOURCE = path.join(repo, 'assets', 'source', 'aster.png');
const MARKER = '.aster-brand.json';

function log(...a) {
  if (!quiet) console.log('[rebrand]', ...a);
}

function dataDir() {
  const explicit = valueOf('--data-dir', '');
  if (explicit) return path.resolve(explicit);
  const cfg = path.join(repo, 'config.toml');
  if (fs.existsSync(cfg)) {
    const m = fs.readFileSync(cfg, 'utf8').match(/^\s*data_dir\s*=\s*'([^']+)'/m);
    if (m) return m[1];
  }
  return path.join(repo, 'claude-science-data');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function brotli(buf) {
  return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

function writeIfChanged(file, buf) {
  let current = null;
  try {
    current = fs.readFileSync(file);
  } catch {
    /* absent */
  }
  if (current && current.equals(buf)) return false;
  if (!dryRun) fs.writeFileSync(file, buf);
  return true;
}

// The daemon serves the .br sibling when the client accepts brotli, so a
// patched .js must ship a matching .br or the browser keeps the old brand.
function refreshBrotli(file) {
  const br = `${file}.br`;
  if (!fs.existsSync(br)) return false;
  return writeIfChanged(br, brotli(fs.readFileSync(file)));
}

function patchText(file, from, to) {
  const current = fs.readFileSync(file, 'utf8');
  if (!current.includes(from)) return false;
  if (dryRun) return true;
  fs.writeFileSync(file, current.split(from).join(to));
  refreshBrotli(file);
  return true;
}

function patchManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return patchText(file, OLD_BRAND, NEW_BRAND.replace(/\s+/g, ' '));
  }
  let changed = false;
  if (json.name === 'Claude Science') {
    json.name = 'Aster Science';
    changed = true;
  }
  if (json.short_name === 'Claude') {
    json.short_name = 'Aster';
    changed = true;
  }
  if (!changed) return false;
  if (!dryRun) {
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    refreshBrotli(file);
  }
  return true;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function patchScripts(webDist) {
  let changed = 0;
  for (const file of walk(path.join(webDist, 'assets'))) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    if (patchText(file, OLD_BRAND, NEW_BRAND)) changed++;
  }
  return changed;
}

function psEscape(file) {
  return file.replace(/'/g, "''");
}

// PWA icons are 192/512 px; the repo only ships up to 256 px, so rasterize
// the 2048 px source with System.Drawing. Non-Windows or a failure falls
// back to the largest PNG in the repo (still Aster, just upscaled).
function generateIcons(webDist) {
  const targets = [
    { name: 'icon-192.png', size: 192 },
    { name: 'icon-512.png', size: 512 },
    { name: 'icon-maskable-512.png', size: 512 },
  ];
  if (process.platform === 'win32' && fs.existsSync(PNG_SOURCE)) {
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      `$src = [System.Drawing.Image]::FromFile('${psEscape(PNG_SOURCE)}')`,
      'foreach ($item in @(' + targets.map((t) => `@('${psEscape(path.join(webDist, t.name))}',${t.size})`).join(',') + ')) {',
      '  $bmp = New-Object System.Drawing.Bitmap($item[1], $item[1])',
      '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
      '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
      '  $g.DrawImage($src, 0, 0, $item[1], $item[1])',
      '  $g.Dispose()',
      '  $bmp.Save($item[0], [System.Drawing.Imaging.ImageFormat]::Png)',
      '  $bmp.Dispose()',
      '}',
      '$src.Dispose()',
    ].join('; ');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status === 0) return true;
    log(`icon rasterization failed: ${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}`);
  }
  const fallback = path.join(repo, 'assets', 'icon-256.png');
  if (!fs.existsSync(fallback)) {
    log('no icon source; keeping the existing PWA icons');
    return false;
  }
  const bytes = fs.readFileSync(fallback);
  for (const t of targets) writeIfChanged(path.join(webDist, t.name), bytes);
  return true;
}

function brand(webDist) {
  const source = fs.existsSync(SVG_SOURCE) ? sha256(SVG_SOURCE) : 'none';
  const png = fs.existsSync(PNG_SOURCE) ? sha256(PNG_SOURCE) : 'none';
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(webDist, MARKER), 'utf8'));
  } catch {
    /* not branded yet */
  }
  const index = path.join(webDist, 'index.html');
  const favicon = path.join(webDist, 'favicon.svg');
  let indexText = '';
  try {
    indexText = fs.readFileSync(index, 'utf8');
  } catch {
    return 0; // extraction still in flight
  }
  const iconsReady = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'].every((n) =>
    fs.existsSync(path.join(webDist, n)),
  );

  if (
    marker &&
    marker.source === `${source}:${png}` &&
    marker.brand === NEW_BRAND &&
    iconsReady &&
    !indexText.includes(OLD_BRAND)
  ) {
    return 0;
  }

  const before = Date.now();
  let changes = 0;

  // Title and any brand prose in the document.
  if (patchText(index, OLD_BRAND, NEW_BRAND.replace(/\s+/g, ' '))) changes++;
  changes += patchManifest(path.join(webDist, 'manifest.webmanifest')) ? 1 : 0;

  // Browser tab + PWA icons.
  if (fs.existsSync(SVG_SOURCE)) {
    if (writeIfChanged(favicon, fs.readFileSync(SVG_SOURCE))) {
      changes++;
      refreshBrotli(favicon);
    }
  }
  if (!iconsReady || !marker || marker.source !== `${source}:${png}`) {
    generateIcons(webDist);
  }

  // Visible strings, including the brand constant used by the header.
  changes += patchScripts(webDist);

  if (!dryRun) {
    fs.writeFileSync(
      path.join(webDist, MARKER),
      JSON.stringify({ brand: NEW_BRAND, source: `${source}:${png}`, patched_at: new Date().toISOString() }, null, 2) + '\n',
    );
  }
  if (changes === 0) return 0;
  log(`${webDist}: ${changes} file(s) rebranded in ${Date.now() - before}ms`);
  return changes;
}

function candidates(ddir) {
  const base = path.join(ddir, 'runtime');
  if (!fs.existsSync(base)) return [];
  const dirs = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const webDist = path.join(base, entry.name, 'web-dist');
    if (fs.existsSync(path.join(webDist, 'index.html'))) dirs.push(webDist);
  }
  return dirs;
}

// The daemon writes <version>-release/.ok after the asset tree is complete.
// Some builds may not; fall back to a stable index.html for a moment.
const seen = new Map();
function ready(webDist) {
  if (fs.existsSync(path.join(path.dirname(webDist), '.ok'))) return true;
  let mtime = 0;
  try {
    mtime = fs.statSync(path.join(webDist, 'index.html')).mtimeMs;
  } catch {
    return false;
  }
  const last = seen.get(webDist);
  seen.set(webDist, mtime);
  return last !== undefined && last === mtime;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dir = dataDir();
  const deadline = Date.now() + timeoutMs;
  if (!fs.existsSync(path.join(dir, 'runtime'))) {
    log(`no runtime assets under ${dir} yet`);
    if (!watch) return;
  }
  for (;;) {
    const dirs = candidates(dir);
    if (dirs.length) {
      const pending = dirs.filter((d) => !ready(d));
      for (const d of dirs) {
        if (pending.includes(d)) continue;
        try {
          brand(d);
        } catch (e) {
          log(`${d}: ${e && e.message ? e.message : e}`);
        }
      }
      if (!pending.length) return;
      if (!watch && Date.now() >= deadline) return;
    }
    if (Date.now() >= deadline) {
      if (dirs.length) log(`timed out waiting for extraction: ${dirs.join(', ')}`);
      return;
    }
    if (!watch && dirs.length) return;
    await sleep(300);
  }
}

main().catch((e) => {
  console.error('[rebrand] failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
