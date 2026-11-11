#!/usr/bin/env node
// Patch a Claude Science release build into aster-science.
//
// Every edit is byte-for-byte (same length) inside the embedded JS bundle:
//   - display brand "Claude Science" -> "Aster  Science" (collapses in HTML),
//   - CLI name detection and fallback -> aster-science,
//   - build gate: BYOK key accepted without an OAuth token,
//   - /api/auth/status: report the local session as authenticated,
//   - credential resolver: return the ANTHROPIC_API_KEY env credential.
//
// The tool is not tied to one release: with no arguments it picks the newest
// bin/Claude-Science-*.exe, derives the version from its name, and locates
// each patch by the text that carries it. A release that no longer contains
// that text fails loudly (nothing is written) instead of producing a
// half-patched executable.
//
// Usage:
//   node tools/patch-aster-science.mjs [source.exe] [output.exe] [--force]
//
// Exit codes: 0 up to date (or no upstream release present), 10 patched,
// 1 failure.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));
const binDir = path.join(process.cwd(), 'bin');
const defaultOut = path.join(binDir, 'aster-science.exe');
const stat = (p) => fs.statSync(p).mtimeMs;

const source = positional[0] ? path.resolve(positional[0]) : newestUpstream();
const output = positional[1] ? path.resolve(positional[1]) : defaultOut;

if (!source) {
  if (fs.existsSync(output)) {
    console.log('[patch] no bin\\Claude-Science-*.exe found; keeping the existing aster-science.exe');
    process.exit(0);
  }
  console.error('[patch] no upstream release found. Put a Claude-Science-<version>.exe in bin\\ and re-run.');
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`[patch] source not found: ${source}`);
  process.exit(1);
}

if (!force && fs.existsSync(output) && stat(output) >= stat(source)) {
  console.log(`[patch] ${path.basename(output)} is newer than ${path.basename(source)}; up to date`);
  process.exit(0);
}

const version = (path.basename(source).match(/^Claude-Science-(.+)\.exe$/i) || [])[1] || 'unknown';
const bytes = fs.readFileSync(source);
const edits = [];
const missing = [];

// ---- patch locators -------------------------------------------------------

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

// `if(!t)throw new Lw("This build requires signing in ...")` -> `if(0 )throw ...`
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
  edits.push({
    at: start,
    len,
    to: Buffer.from(`if(0${' '.repeat(m[1].length)})`),
    name: 'byok-gate',
  });
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
  const replacement = Buffer.from(
    'return{api_key:process.env.ANTHROPIC_API_KEY||"sk-ant-aster",auth_token:null}',
  );
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

// The sign-in / setup pages embed an inline SVG logo (IFi) and derive the
// data-URI favicon from the same string. Replace its content with a compact
// Aster mark, padded to the original byte length.
function signInLogo() {
  const marker = Buffer.from("var IFi='");
  const at = bytes.indexOf(marker);
  if (at < 0) {
    missing.push('brand-signin-logo (IFi SVG not found)');
    return 0;
  }
  const start = at + marker.length;
  const end = bytes.indexOf(0x27, start);
  if (end < 0) {
    missing.push('brand-signin-logo (unterminated IFi SVG)');
    return 0;
  }
  const slot = end - start;
  const svg = compactLogoSvg();
  const next = Buffer.from(svg, 'utf8');
  if (next.length > slot) {
    missing.push(`brand-signin-logo (${next.length}B does not fit the ${slot}B slot)`);
    return 0;
  }
  edits.push({
    at: start,
    len: slot,
    to: Buffer.concat([next, Buffer.alloc(slot - next.length, 0x20)]),
    name: 'brand-signin-logo',
  });
  return 1;
}

function compactLogoSvg() {
  const file = path.join(process.cwd(), 'assets', 'source', 'aster.svg');
  let svg = fs.readFileSync(file, 'utf8');
  // The circuit overlay is decorative; dropping it keeps the emblem and fits
  // the embedded slot. The original inline logo is 76x76.
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
  console.error(`[patch] ${path.basename(source)} (${version}) does not match the expected shape:`);
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

try {
  fs.writeFileSync(output, out);
} catch (e) {
  console.error(`[patch] cannot write ${output}: ${e.message}`);
  console.error('[patch] Stop the daemon first (stop.cmd) and retry.');
  process.exit(1);
}

console.log(`[patch] ${path.basename(source)} → ${path.basename(output)} (version ${version})`);
for (const [name, n] of counts) console.log(`[patch] ${name}: ${n}`);
console.log(
  `[patch] wrote ${output} (${out.length} bytes, sha256 ${crypto.createHash('sha256').update(out).digest('hex')})`,
);
process.exit(10);

function newestUpstream() {
  if (!fs.existsSync(binDir)) return null;
  const files = fs
    .readdirSync(binDir)
    .filter((f) => /^Claude-Science-.+\.exe$/i.test(f))
    .map((f) => path.join(binDir, f))
    .sort((a, b) => stat(b) - stat(a));
  return files[0] || null;
}
