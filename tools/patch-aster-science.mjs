#!/usr/bin/env node
// Patch a Claude Science macOS release build into aster-science.
//
// The macOS DMG ships an .app whose daemon
// (Contents/Resources/bin/claude-science, Bun-compiled arm64) embeds the same
// JavaScript bundle as the Windows build. Every edit here is byte-for-byte
// (same length) inside that bundle:
//   - display brand "Claude Science" -> "Aster  Science" (collapses in HTML),
//   - CLI name detection and fallback -> aster-science,
//   - build gate: BYOK key accepted without an OAuth token,
//   - /api/auth/status: report the local session as authenticated,
//   - credential resolver: return the ANTHROPIC_API_KEY env credential,
//   - sign-in / setup inline SVG logo (76x76 slot) -> Aster mark.
//
// Unlike the Windows build the result must be re-signed: macOS refuses to
// exec a modified Mach-O. An ad-hoc signature that keeps the upstream
// entitlements is enough because the daemon has no signature self-check.
//
// Usage:
//   node tools/patch-aster-science.mjs [--force] [source.dmg|--app <.app>]
//
// With no arguments the newest source/*.dmg is mounted read-only. The
// tool writes bin/claude-science and keeps the extracted upstream copy as
// bin/Claude-Science-<version>.
//
// Exit codes: 0 up to date (or no upstream release present), 10 patched,
// 1 failure.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));
const root = process.cwd();
const binDir = path.join(root, 'bin');
const sourceDir = path.join(root, 'source');
const output = path.join(binDir, 'claude-science');
const entitlements = path.join(root, 'assets', 'entitlements.plist');
const stat = (p) => fs.statSync(p).mtimeMs;

// ---- locate and extract the upstream daemon -------------------------------

function newestDmg() {
  if (!fs.existsSync(sourceDir)) return null;
  const files = fs
    .readdirSync(sourceDir)
    .filter((f) => /\.dmg$/i.test(f))
    .map((f) => path.join(sourceDir, f))
    .sort((a, b) => stat(b) - stat(a));
  return files[0] || null;
}

// `--app <path>` may point at the mounted "Claude Science.app" bundle.
const appIndex = args.indexOf('--app');
const explicitApp = appIndex >= 0 ? args[appIndex + 1] : null;

let upstreamBinary = null; // path to an already-extracted daemon
let version = 'unknown';
let sourceStamp = 0;
let dmgPath = null;
let mountPoint = null;

if (explicitApp) {
  upstreamBinary = path.join(explicitApp, 'Contents', 'Resources', 'bin', 'claude-science');
  version = readVersion(path.join(explicitApp, 'Contents', 'Info.plist'));
  sourceStamp = stat(upstreamBinary);
} else if (positional[0]) {
  dmgPath = path.resolve(positional[0]);
} else {
  dmgPath = newestDmg();
}

function readVersion(infoPlist) {
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function mountDmg(dmg) {
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-science-dmg-'));
  execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mnt, dmg], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  mountPoint = mnt;
  return mnt;
}

function unmount() {
  if (!mountPoint) return;
  try {
    execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' });
  } catch {
    /* already detached */
  }
  try {
    fs.rmdirSync(mountPoint);
  } catch {
    /* noop */
  }
  mountPoint = null;
}

if (!upstreamBinary && dmgPath) {
  if (!fs.existsSync(dmgPath)) {
    console.error(`[patch] source not found: ${dmgPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  sourceStamp = stat(dmgPath);
  let mnt;
  try {
    mnt = mountDmg(dmgPath);
  } catch (e) {
    console.error(`[patch] cannot mount ${path.basename(dmgPath)}: ${(e.stderr || e.message).toString().trim()}`);
    process.exit(1);
  }
  const app = fs
    .readdirSync(mnt)
    .filter((n) => n.endsWith('.app'))
    .map((n) => path.join(mnt, n))[0];
  if (!app) {
    unmount();
    console.error(`[patch] no .app inside ${path.basename(dmgPath)}`);
    process.exit(1);
  }
  version = readVersion(path.join(app, 'Contents', 'Info.plist'));
  const inside = path.join(app, 'Contents', 'Resources', 'bin', 'claude-science');
  if (!fs.existsSync(inside)) {
    unmount();
    console.error('[patch] daemon binary not found inside the app bundle');
    process.exit(1);
  }
  const cached = path.join(binDir, `Claude-Science-${version}`);
  if (!fs.existsSync(cached) || stat(cached) < sourceStamp) {
    fs.copyFileSync(inside, cached);
    fs.chmodSync(cached, 0o755);
  }
  upstreamBinary = cached;
  unmount();
}

if (!upstreamBinary || !fs.existsSync(upstreamBinary)) {
  if (fs.existsSync(output)) {
    console.log('[patch] no source/*.dmg found; keeping the existing bin/claude-science');
    process.exit(0);
  }
  console.error('[patch] no upstream release found. Put a Claude-Science-<version>.dmg in source/ and re-run.');
  process.exit(1);
}

if (!force && fs.existsSync(output) && stat(output) >= sourceStamp) {
  console.log(`[patch] ${path.basename(output)} is newer than ${path.basename(upstreamBinary)}; up to date`);
  process.exit(0);
}

// ---- patch locators -------------------------------------------------------

const bytes = fs.readFileSync(upstreamBinary);
const edits = [];
const missing = [];

function occurrences(buf, needle) {
  const hits = [];
  const n = Buffer.isBuffer(needle) ? needle : Buffer.from(needle);
  for (let at = 0; ; ) {
    const i = buf.indexOf(n, at);
    if (i < 0) return hits;
    hits.push(i);
    at = i + 1;
  }
}

function literal(name, from, to, { all = true } = {}) {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error(`internal: ${name} replacement is not length-preserving`);
  }
  const hits = occurrences(bytes, from);
  if ((!all && hits.length !== 1) || (all && hits.length === 0)) {
    missing.push(`${name} (${all ? 'at least 1' : 'exactly 1'}, found ${hits.length})`);
    return 0;
  }
  for (const at of hits) edits.push({ at, len: Buffer.byteLength(from), to: Buffer.from(to), name });
  return hits.length;
}

// `if(!t)throw new Dw("This build requires ...")` -> `if(0 )throw ...`
function byokGate() {
  const message = 'This build requires signing in with your Claude account. API keys are not supported.';
  const at = bytes.indexOf(Buffer.from(message));
  if (at < 0) {
    missing.push('byok-gate (gate message not found)');
    return 0;
  }
  const start = bytes.lastIndexOf(Buffer.from('if(!'), at);
  if (start < 0 || at - start > 400) {
    missing.push('byok-gate (condition not found before the gate message)');
    return 0;
  }
  const head = bytes.subarray(start, at).toString('latin1');
  const m = head.match(/^if\(!([A-Za-z_$][A-Za-z0-9_$]*)\)throw new [A-Za-z_$][A-Za-z0-9_$]*\("$/);
  if (!m) {
    missing.push('byok-gate (unexpected condition shape)');
    return 0;
  }
  const len = 4 + m[1].length + 1; // if(!ident)
  edits.push({ at: start, len, to: Buffer.from(`if(0${' '.repeat(m[1].length)})`), name: 'byok-gate' });
  return 1;
}

// `if(!c)return{authenticated:!1,subscription_type:null,...}` -> `!0`
function statusAuthenticated() {
  const marker = bytes.indexOf(Buffer.from('subscription_type:null'));
  if (marker < 0) {
    missing.push('status-authenticated (subscription_type:null not found)');
    return 0;
  }
  const auth = bytes.lastIndexOf(Buffer.from('authenticated:!1'), marker);
  if (auth < 0 || marker - auth > 400) {
    missing.push('status-authenticated (authenticated:!1 not found near the status object)');
    return 0;
  }
  edits.push({
    at: auth + 'authenticated:'.length,
    len: 2,
    to: Buffer.from('!0'),
    name: 'status-authenticated',
  });
  return 1;
}

// `throw Error("No credentials available ...")` -> env credential object
function envCredential() {
  const message = 'No credentials available for Anthropic API.';
  const at = bytes.indexOf(Buffer.from(message));
  if (at < 0) {
    missing.push('env-credential (credential error message not found)');
    return 0;
  }
  const open = bytes.lastIndexOf(Buffer.from('throw Error("'), at);
  const close = bytes.indexOf(Buffer.from('")'), at);
  const prefix = Buffer.byteLength('throw Error("');
  if (open < 0 || close < 0 || open + prefix !== at) {
    missing.push('env-credential (unexpected throw expression shape)');
    return 0;
  }
  const end = close + 2;
  const replacement = Buffer.from('return{api_key:process.env.ANTHROPIC_API_KEY||"sk-ant-aster",auth_token:null}');
  if (replacement.length > end - open) {
    missing.push('env-credential (replacement no longer fits the expression)');
    return 0;
  }
  edits.push({
    at: open,
    len: end - open,
    to: Buffer.concat([replacement, Buffer.alloc(end - open - replacement.length, 0x20)]),
    name: 'env-credential',
  });
  return 1;
}

// The sign-in / setup pages embed an inline SVG logo (76x76, viewBox 270x270)
// and derive their data-URI favicon from it. Locate it by its viewBox so the
// minifier's variable name does not matter, then replace its content with a
// compact Aster mark padded to the original byte length.
function signInLogo() {
  const marker = Buffer.from('<svg width="76" height="76" viewBox="0 0 270 270"');
  const at = bytes.indexOf(marker);
  if (at < 0) {
    missing.push('brand-signin-logo (76x76 inline SVG not found)');
    return 0;
  }
  // Walk back to the opening quote of the JS string literal.
  let start = at;
  while (start > 0 && bytes[start - 1] !== 0x27 && bytes[start - 1] !== 0x22) start--;
  if (start === 0) {
    missing.push('brand-signin-logo (no string literal before the SVG)');
    return 0;
  }
  const quote = bytes[start - 1];
  start -= 1;
  const end = bytes.indexOf(quote, at);
  if (end < 0) {
    missing.push('brand-signin-logo (unterminated SVG literal)');
    return 0;
  }
  const slot = end - start - 1;
  const svg = compactLogoSvg();
  const next = Buffer.from(svg, 'utf8');
  if (next.length > slot) {
    missing.push(`brand-signin-logo (${next.length}B does not fit the ${slot}B slot)`);
    return 0;
  }
  edits.push({
    at: start + 1,
    len: slot,
    to: Buffer.concat([next, Buffer.alloc(slot - next.length, 0x20)]),
    name: 'brand-signin-logo',
  });
  return 1;
}

function compactLogoSvg() {
  const file = path.join(root, 'assets', 'source', 'aster.svg');
  let svg = fs.readFileSync(file, 'utf8');
  svg = svg.replace(
    /<!--\s*Circuit traces\s*-->[\s\S]*?<!--\s*Circuit nodes\s*-->[\s\S]*?<\/g>\s*<\/g>/,
    '',
  );
  svg = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\/>/g, '/>')
    .trim()
    .replace(/width="1024" height="1024"/, 'width="76" height="76"');
  return svg;
}

// ---- patch plan -----------------------------------------------------------

const counts = new Map();
const count = (name, n) => counts.set(name, (counts.get(name) || 0) + n);

count('brand-display', literal('brand-display', 'Claude Science', 'Aster  Science'));
count('brand-cli-detect', literal('brand-cli-detect', '==="claude-science"', '==="aster-science "'));
count('brand-cli-name', literal('brand-cli-name', '"claude-science"})()', '"aster-science" })()'));
count('byok-gate', byokGate());
count('status-authenticated', statusAuthenticated());
count('env-credential', envCredential());
count('brand-signin-logo', signInLogo());

if (missing.length) {
  console.error(`[patch] ${path.basename(upstreamBinary)} (${version}) does not match the expected shape:`);
  for (const m of missing) console.error(`[patch]   ${m}`);
  console.error('[patch] Nothing was written. Re-derive the failing patch against the new bundle;');
  console.error('[patch] do not relax the checks without reading the new source.');
  process.exit(1);
}

edits.sort((a, b) => a.at - b.at);
for (let i = 1; i < edits.length; i++) {
  if (edits[i - 1].at + edits[i - 1].len > edits[i].at) {
    console.error(`[patch] internal: overlapping edits at ${edits[i - 1].at} and ${edits[i].at}`);
    process.exit(1);
  }
}

const out = Buffer.from(bytes);
for (const edit of edits) edit.to.copy(out, edit.at);

const tmp = `${output}.tmp`;
fs.writeFileSync(tmp, out, { mode: 0o755 });
fs.renameSync(tmp, output);

// ---- ad-hoc re-sign -------------------------------------------------------

if (process.platform === 'darwin') {
  if (!fs.existsSync(entitlements)) {
    console.error(`[patch] missing ${path.relative(root, entitlements)}; cannot sign the patched binary`);
    process.exit(1);
  }
  try {
    execFileSync(
      'codesign',
      [
        '--force',
        '--sign',
        '-',
        '--identifier',
        'com.anthropic.operon.cli',
        '--options',
        'runtime',
        '--entitlements',
        entitlements,
        output,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    execFileSync('codesign', ['--verify', '--strict', output], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.error(`[patch] codesign failed: ${(e.stderr || e.message).toString().trim()}`);
    process.exit(1);
  }
  try {
    execFileSync('xattr', ['-c', output], { stdio: 'ignore' });
  } catch {
    /* no attributes */
  }
}

console.log(`[patch] ${path.basename(upstreamBinary)} → ${path.basename(output)} (version ${version})`);
for (const [name, n] of counts) console.log(`[patch] ${name}: ${n}`);
console.log(
  `[patch] wrote ${output} (${out.length} bytes, sha256 ${crypto.createHash('sha256').update(out).digest('hex')})`,
);
process.exit(10);
