#!/usr/bin/env node
// Patch a Claude Science 0.1.72 release build into aster-science.
//
// Every edit is byte-for-byte (same length) inside the embedded JS bundle:
//   - display brand "Claude Science" → "Aster  Science" (collapses in HTML),
//   - CLI name fallback → "aster-science",
//   - build gate: BYOK key accepted without an OAuth token,
//   - /api/auth/status: report the local session as authenticated,
//   - credential resolver: return the ANTHROPIC_API_KEY env credential.
//
// Usage: node tools/patch-aster-science.mjs <Claude-Science-0.1.72.exe> <aster-science.exe>

import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , src, dst] = process.argv;
if (!src || !dst) {
  console.error('usage: node tools/patch-aster-science.mjs <source.exe> <output.exe>');
  process.exit(2);
}

const PATCHES = [
  {
    // Display brand in UI, help text and messages. Two spaces keep the byte
    // length; HTML/JSX collapses them, so the rendered brand is "Aster Science".
    name: 'brand-display',
    old: Buffer.from('Claude Science'),
    replacement: 'Aster  Science',
    all: true,
  },
  {
    // `mt` accepts only known argv0 basenames; Bun rewrites argv0 to the
    // embedded name (claude-science), which would bypass the fallback. Make
    // the known-name comparison miss so the patched fallback is used.
    name: 'brand-cli-detect',
    old: Buffer.from('t==="claude-science"'),
    replacement: 't==="aster-science "',
    all: true,
  },
  {
    // CLI name fallback in the `mt` detection IIFE (three bundled copies).
    // "aster-science" is one byte shorter, so the closing space keeps length.
    name: 'brand-cli-name',
    old: Buffer.from('return"claude-science"})()'),
    replacement: 'return"aster-science" })()',
    all: true,
  },
  {
    name: 'byok-gate',
    old: Buffer.from('if(!t)throw new Lw("This build requires signing in with your Claude account. API keys are not supported.")'),
    replacement: 'if(0 )throw new Lw("This build requires signing in with your Claude account. API keys are not supported.")',
  },
  {
    // /api/auth/status early-return when no OAuth token exists: report the
    // local session as authenticated so the web UI does not force the Claude
    // sign-in screen. Account/subscription fields stay null.
    name: 'status-authenticated',
    old: Buffer.from('if(!c)return{authenticated:!1,subscription_type:null'),
    replacement: 'if(!c)return{authenticated:!0,subscription_type:null',
  },
  {
    name: 'env-credential',
    old: Buffer.from('throw Error("No credentials available for Anthropic API. Please sign in with your Claude account.")'),
    replacement: 'return{api_key:process.env.ANTHROPIC_API_KEY||"sk-ant-aster",auth_token:null}',
  },
];

const bytes = fs.readFileSync(src);

for (const p of PATCHES) {
  const count = countOccurrences(bytes, p.old);
  const expected = p.all === undefined ? 1 : 'at least 1';
  if ((p.all === undefined && count !== 1) || (p.all && count === 0)) {
    console.error(`[patch] ${p.name}: expected ${expected} occurrence(s), found ${count} — refusing`);
    process.exit(1);
  }
  const next = Buffer.from(p.replacement);
  if (next.length > p.old.length) {
    console.error(`[patch] ${p.name}: replacement ${next.length}B exceeds original ${p.old.length}B`);
    process.exit(1);
  }
  p.buf = Buffer.concat([next, Buffer.alloc(p.old.length - next.length, 0x20)]);
  if (p.buf.length !== p.old.length) throw new Error('internal: length mismatch');
  p.offsets = [];
  let at = 0;
  for (;;) {
    const i = bytes.indexOf(p.old, at);
    if (i === -1) break;
    p.offsets.push(i);
    at = i + p.old.length;
  }
}

const out = Buffer.from(bytes);
for (const p of PATCHES) {
  for (const offset of p.offsets) {
    p.buf.copy(out, offset);
    console.log(`[patch] ${p.name}: ${p.old.length}B at file offset ${offset}`);
  }
}

fs.writeFileSync(dst, out);
console.log(`[patch] wrote ${dst} (${out.length} bytes, sha256 ${crypto.createHash('sha256').update(out).digest('hex')})`);

function countOccurrences(haystack, needle) {
  let count = 0;
  let at = 0;
  for (;;) {
    const i = haystack.indexOf(needle, at);
    if (i === -1) return count;
    count++;
    at = i + 1;
  }
}
