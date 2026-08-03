#!/usr/bin/env node
/**
 * Verify an email@0.5 receipt against the message that was actually DELIVERED.
 *
 * This is the check the receipt exists to support: rebuild the bound object
 * from what the recipient holds, hash it, compare to the signed contentHash.
 * It deliberately uses NO hap-core import — it reimplements the v2 rules, so a
 * match is cross-implementation evidence and not the library agreeing with
 * itself.
 *
 * Usage:
 *   node verify-email-receipt.mjs <receipt-id-or-url> <delivered.json>
 *
 * delivered.json — exactly what arrived, footer and all:
 *   { "to": ["a@x.com"], "cc": [], "subject": "…", "body": "…" }
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const AS = process.env.SUVEREN_AS_URL ?? 'https://www.suveren.ai';
const FOOTER_RE = /\n*(?:—|--) (?:Sent|Published) by (?:an AI agent|[^\n]+?'s AI agent)[\s\S]*$/;

const canonText = (s) =>
  s.normalize('NFC').replace(/\r\n?/g, '\n')
   .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');

const jcs = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
};

function boundObject(delivered, fields) {
  const out = {};
  for (const f of fields) {
    const raw = delivered[f];
    if (typeof raw === 'string') {
      const t = canonText(raw.replace(FOOTER_RE, ''));
      if (t !== '') out[f] = t;
    } else if (Array.isArray(raw)) {
      const items = raw.map((x) => canonText(String(x))).filter((x) => x !== '');
      if (items.length) out[f] = items;
    }
  }
  return out;
}

const [ref, file] = process.argv.slice(2);
if (!ref || !file) {
  console.error('usage: node verify-email-receipt.mjs <receipt-id-or-url> <delivered.json>');
  process.exit(2);
}
const id = ref.replace(/^.*\/r\//, '').replace(/^.*\/public-receipt\//, '');
const res = await fetch(`${AS}/api/as/public-receipt/${id}`);
if (!res.ok) { console.error(`receipt ${id}: HTTP ${res.status}`); process.exit(1); }
const receipt = await res.json();

const binding = receipt.contentBinding ?? {};
const fields = binding.fields;
console.log('signature valid :', receipt.signatureValid);
console.log('binding         :', JSON.stringify(binding));
if (!fields) {
  console.error('\nThis receipt has no `fields` — it is a v1 binding, not email@0.5.');
  process.exit(1);
}

const delivered = JSON.parse(readFileSync(file, 'utf-8'));
const bound = boundObject(delivered, fields);
const bytes = jcs(bound);
const hash = 'sha256:' + createHash('sha256').update(bytes, 'utf8').digest('hex');

console.log('bound fields    :', fields.join(', '));
console.log('canonical bytes :', bytes);
console.log('recomputed      :', hash);
console.log('signed          :', receipt.contentHash);
console.log(hash === receipt.contentHash
  ? '\n✓ MATCH — this exact content, to these exact recipients, was authorized.'
  : '\n✗ NO MATCH — see canonical bytes above; check that every bound field is filled in exactly as delivered.');
process.exit(hash === receipt.contentHash ? 0 : 1);
