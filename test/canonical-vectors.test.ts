/**
 * The suite's own canonicalizer against the spec's answer key.
 *
 * `src/helpers/crypto.ts` computes the bounds_hash / context_hash an E2E test
 * signs; the Authority Server recomputes both with hap-core and refuses a
 * mismatch. The helper deliberately does NOT import hap-core — a suite that
 * borrows the implementation's canonicalizer agrees with it by construction and
 * proves nothing about the bytes. The cost of that independence is that the
 * copy can drift, so it is checked against the third party both must match:
 * content/0.7/vectors/canonical-bounds-and-scope.json (protocol.md → *Bounds &
 * Scope Canonicalization*) — 10 cases and 2 refusals.
 *
 * This is a pure unit test: no server, no build, so it runs even when the
 * stack does not.
 *
 * Vocabulary note: the vector file is v0.7, which renamed "context" to
 * "scope". The wire is still v0.6, so `kind: "scope"` cases run through
 * computeContextHash and SCOPE_INVALID_VALUE is asserted as
 * CONTEXT_INVALID_VALUE. The bytes and hashes the vectors pin are unaffected.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  canonicalRecords,
  computeBoundsHash,
  computeContextHash,
  CanonicalValueError,
} from '../src/helpers/crypto';

/** The spec repo is the parent in a local checkout, a sibling in CI. */
const VECTOR_REL = 'content/0.7/vectors/canonical-bounds-and-scope.json';
const CANDIDATES = [
  fileURLToPath(new URL(`../../${VECTOR_REL}`, import.meta.url)),
  fileURLToPath(new URL(`../../hap-protocol/${VECTOR_REL}`, import.meta.url)),
];
const VECTORS_PATH = CANDIDATES.find(p => existsSync(p));

interface VectorCase {
  id: string;
  note?: string;
  kind: 'bounds' | 'scope';
  key_order: string[];
  values: Record<string, string | number>;
  canonical?: string;
  hash?: string;
  expected_error?: string;
}

interface VectorFile {
  spec_version: string;
  cases: VectorCase[];
  must_refuse: VectorCase[];
}

/** v0.7 vector code → the code this (v0.6-wire) helper throws. */
function expectedCode(vc: VectorCase): string {
  return vc.expected_error === 'SCOPE_INVALID_VALUE'
    ? 'CONTEXT_INVALID_VALUE'
    : String(vc.expected_error);
}

if (!VECTORS_PATH) {
  console.warn(
    '\n' + '='.repeat(78) +
    '\n!! CONFORMANCE VECTORS NOT FOUND — this suite\'s canonicalizer is UNVERIFIED.' +
    `\n!! Looked in:\n!!   ${CANDIDATES.join('\n!!   ')}` +
    '\n!! Without them nothing checks that the hashes these tests sign are the hashes' +
    '\n!! the Authority Server computes. Restore the spec checkout before trusting a' +
    '\n!! green suite.\n' + '='.repeat(78) + '\n',
  );
}

describe.skipIf(!VECTORS_PATH)('canonical bounds & scope — spec conformance vectors', () => {
  const vectors: VectorFile = VECTORS_PATH
    ? JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))
    : { spec_version: '', cases: [], must_refuse: [] };

  it('loaded a vector set with cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    expect(vectors.must_refuse.length).toBeGreaterThan(0);
  });

  describe('canonical string + hash', () => {
    for (const vc of vectors.cases) {
      it(`${vc.id} (${vc.kind})`, () => {
        const code = vc.kind === 'bounds' ? 'BOUNDS_INVALID_VALUE' : 'CONTEXT_INVALID_VALUE';
        expect(canonicalRecords(vc.values, vc.key_order, code)).toBe(vc.canonical);

        const hash = vc.kind === 'bounds'
          ? computeBoundsHash(vc.values, vc.key_order)
          : computeContextHash(vc.values, vc.key_order);
        expect(hash).toBe(vc.hash);
      });
    }
  });

  describe('must_refuse', () => {
    for (const vc of vectors.must_refuse) {
      it(`${vc.id} → ${vc.expected_error}`, () => {
        // A refusal, not an encoding case: a hash over silently-stripped input
        // does not represent what was authorized.
        let thrown: unknown;
        try {
          if (vc.kind === 'bounds') computeBoundsHash(vc.values, vc.key_order);
          else computeContextHash(vc.values, vc.key_order);
        } catch (err) {
          thrown = err;
        }

        expect(thrown, 'canonicalization should have refused this value').toBeInstanceOf(
          CanonicalValueError,
        );
        expect((thrown as CanonicalValueError).code).toBe(expectedCode(vc));
      });
    }
  });
});

describe('the rule that changes existing hashes', () => {
  // Kept outside the vector block so it runs even without the spec checkout:
  // this is the one behaviour change that can silently invalidate grants the
  // suite creates (sparse bounds — an email template leaves read bounds unset).
  it('omits an absent optional key instead of hashing the string "undefined"', () => {
    const keyOrder = ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max'];
    const canonical = canonicalRecords(
      { profile: 'email@0.6', recipient_max: 5, send_daily_max: 20 },
      keyOrder,
      'BOUNDS_INVALID_VALUE',
    );

    expect(canonical).toBe('profile=email@0.6\nrecipient_max=5\nsend_daily_max=20');
    expect(canonical).not.toContain('undefined');
  });

  it('keeps an empty string distinct from an absent key', () => {
    expect(canonicalRecords({ a: '' }, ['a'], 'CONTEXT_INVALID_VALUE')).toBe('a=');
    expect(canonicalRecords({}, ['a'], 'CONTEXT_INVALID_VALUE')).toBe('');
  });
});
