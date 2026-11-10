#!/usr/bin/env node
// Patch a Claude Science 0.1.72 release build into aster-science.
//
// Two byte-for-byte (same length) edits in the embedded JS bundle:
//   1. Build gate: "if(!t)" in the credential/client gate is replaced with
//      "if(0 )" so a BYOK API key is accepted without a Claude OAuth token.
//   2. Credential resolver: the terminal auth throw in
//      CredentialResolver.resolve() is replaced by a return of the
//      ANTHROPIC_API_KEY environment credential.
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
  if (count !== 1) {
    console.error(`[patch] ${p.name}: expected exactly 1 occurrence, found ${count} — refusing`);
    process.exit(1);
  }
  const next = Buffer.from(p.replacement);
  if (next.length > p.old.length) {
    console.error(`[patch] ${p.name}: replacement ${next.length}B exceeds original ${p.old.length}B`);
    process.exit(1);
  }
  p.offset = bytes.indexOf(p.old);
  p.buf = Buffer.concat([next, Buffer.alloc(p.old.length - next.length, 0x20)]);
  if (p.buf.length !== p.old.length) throw new Error('internal: length mismatch');
}

const out = Buffer.from(bytes);
for (const p of PATCHES) {
  p.buf.copy(out, p.offset);
  console.log(`[patch] ${p.name}: ${p.old.length}B at file offset ${p.offset}`);
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
