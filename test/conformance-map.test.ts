/**
 * The conformance map must stay true.
 *
 * A map that drifts is worse than none: it asserts coverage that has since
 * been renamed away. This checks the claims mechanically —
 *
 *   • every entry resolves to real test files, or names where the gap is
 *     recorded (never neither, never both);
 *   • every referenced test file exists;
 *   • every ledger reference points at a file that exists and actually
 *     mentions the thing it claims to record;
 *   • ids are unique and the enforcement core is covered.
 *
 * It cannot check that a test *proves* its requirement — no checker can. What
 * it removes is the failure that actually happened here: a MUST with no test
 * and nobody aware of it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_MUSTS, TEST_ROOTS, type CoreMust } from '../conformance/core-musts';

const E2E_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(E2E_ROOT, '..');

function resolveTest(rel: string): string | null {
  for (const root of TEST_ROOTS) {
    const p = join(E2E_ROOT, root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * "content/0.6/review.md → Register 2 → …" — resolve the part before the first
 * arrow. The spec repo is the parent directory in a local checkout and a
 * sibling (`hap-protocol/`) in CI, so both layouts are tried.
 */
const LEDGER_ROOTS = [REPO_ROOT, join(REPO_ROOT, 'hap-protocol')];

function ledgerFile(ref: string): string | null {
  const rel = ref.split('→')[0].trim();
  for (const root of LEDGER_ROOTS) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

describe('conformance map — the enforcement core of protocol.md v0.6', () => {
  it('covers all three core sections', () => {
    const sections = new Set(CORE_MUSTS.map(m => m.section));
    expect(sections).toEqual(
      new Set(['Receipt Issuance', 'Gatekeeper & Executor', 'Read Authorization']),
    );
    expect(CORE_MUSTS.length).toBeGreaterThanOrEqual(25);
  });

  it('uses unique ids', () => {
    const ids = CORE_MUSTS.map(m => m.id);
    expect(new Set(ids).size, `duplicate id in the map: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('resolves every requirement to either tests or a recorded gap — never neither, never both', () => {
    for (const m of CORE_MUSTS) {
      const hasTests = Array.isArray(m.tests) && m.tests.length > 0;
      const hasLedger = typeof m.ledgered === 'string' && m.ledgered.length > 0;
      expect(
        hasTests || hasLedger,
        `${m.id} is unmapped. Either point it at a test, or record the gap in the ledger and reference it here — ` +
          'an unmapped MUST is exactly the state this map exists to make impossible.',
      ).toBe(true);
      expect(
        hasTests && hasLedger,
        `${m.id} claims both tests and a recorded gap. Pick one: a tested requirement is not a gap.`,
      ).toBe(false);
    }
  });

  it.each(CORE_MUSTS.filter(m => m.tests?.length).map(m => [m.id, m] as [string, CoreMust]))(
    '%s — its test files exist',
    (_id, m) => {
      for (const rel of m.tests!) {
        expect(
          resolveTest(rel),
          `${m.id} references ${rel}, which does not exist under any of: ${TEST_ROOTS.join(', ')}. ` +
            'Either the test was renamed (update the map) or deleted (the requirement is now unmapped).',
        ).not.toBeNull();
      }
    },
  );

  it.each(CORE_MUSTS.filter(m => m.ledgered).map(m => [m.id, m] as [string, CoreMust]))(
    '%s — its ledger reference is real',
    (_id, m) => {
      const file = ledgerFile(m.ledgered!);
      expect(
        file,
        `${m.id} references a ledger file that exists in none of: ${LEDGER_ROOTS.join(', ')}`,
      ).not.toBeNull();

      // The reference must actually be recorded, not merely pointed at. Take
      // the last arrow-separated part as the phrase that should appear.
      const phrase = m.ledgered!.split('→').pop()!.trim().replace(/^"|"$/g, '');
      const body = readFileSync(file!, 'utf8');
      expect(
        body.toLowerCase().includes(phrase.toLowerCase()),
        `${m.id} claims to be recorded as "${phrase}" in ${file}, but that text is not there. ` +
          'A gap that is not actually written down is an untested MUST wearing a ledger reference.',
      ).toBe(true);
    },
  );
});
