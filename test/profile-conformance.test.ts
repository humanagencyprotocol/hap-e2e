/**
 * Published profiles must declare what the enforcement layer needs.
 *
 * Two declarations, both required to make a limit bind by construction rather
 * than by naming discipline:
 *
 *   • `boundsSchema.actionTypes` — the closed set of action types valid at
 *     receipt time (protocol.md → Bounds Schema, a v0.5+ MUST). Without it a
 *     typo'd action type (`"wrote"` for `"write"`) opens a fresh cumulative
 *     bucket that no bound governs, and the daily limit silently stops
 *     applying.
 *
 *   • `appliesTo` on every `cumulative_count` bound — which action types that
 *     bound governs. Without it, both enforcement points fall back to
 *     inferring it from the field name, which the spec forbids ("never by
 *     field-name correlation"). The fallback happens to work today only
 *     because the names were chosen to line up; the first profile whose names
 *     do not is a silently unenforced limit.
 *
 * This is a cross-repo check by nature — it reads hap-profiles, and neither
 * that repo's CI nor the products' can see the pairing. Pure filesystem: no
 * servers, no network.
 *
 * Scope: the LATEST version of each profile. Older versions are frozen by the
 * immutability rule and are deliberately not held to a rule written after
 * them.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hap-profiles');

/**
 * Profiles knowingly left behind, with the reason. An entry here is a debt
 * that must be visible, not a way to make the test quiet.
 */
const EXEMPT: Record<string, string> = {
  // Empty. charge was the last entry, cleared 2026-08-27 once its registry
  // could be declared without loosening a live limit. Adding an entry here is
  // recording a debt, not silencing a failure — every exemption is pinned
  // below, so it fails the moment it stops being true.
};

/** Sorts "0.10" after "0.9" — plain string sort does not. */
function latestVersion(versions: string[]): string {
  return versions.slice().sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }).pop()!;
}

function profileDirs(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR).filter(
    f => !f.startsWith('.') && f !== 'test-results' && statSync(join(PROFILES_DIR, f)).isDirectory(),
  );
}

const dirs = profileDirs();

describe('published profiles declare their enforcement contract', () => {
  it('finds the hap-profiles checkout (otherwise this suite proves nothing)', () => {
    expect(dirs.length, `no profile directories under ${PROFILES_DIR}`).toBeGreaterThan(0);
  });

  for (const name of dirs) {
    const versions = readdirSync(join(PROFILES_DIR, name))
      .filter(f => f.endsWith('.profile.json'))
      .map(f => f.replace('.profile.json', ''));
    if (versions.length === 0) continue;

    const latest = latestVersion(versions);
    const profile = JSON.parse(
      readFileSync(join(PROFILES_DIR, name, `${latest}.profile.json`), 'utf8'),
    );
    const exemptReason = EXEMPT[name];
    const label = `${name}@${latest}`;

    it(`${label} declares actionTypes${exemptReason ? ' (exempt)' : ''}`, () => {
      const declared = profile.boundsSchema?.actionTypes;
      if (exemptReason) {
        // Pin the exemption: when it is finally fixed this flips and the entry
        // must be removed, so the list cannot rot into permanent silence.
        expect(declared, `${label} is exempt but now declares actionTypes — remove it from EXEMPT`).toBeUndefined();
        return;
      }
      expect(Array.isArray(declared), `${label} has no boundsSchema.actionTypes (v0.5+ MUST)`).toBe(true);
      expect(declared.length, `${label} declares an empty actionTypes registry`).toBeGreaterThan(0);
    });

    it(`${label} pairs every cumulative_count bound to its action types`, () => {
      const fields = profile.boundsSchema?.fields ?? {};
      const counts = Object.entries(fields).filter(
        ([, f]: [string, any]) => f?.boundType?.kind === 'cumulative_count',
      );
      if (exemptReason || counts.length === 0) return;

      for (const [field, def] of counts as Array<[string, any]>) {
        expect(
          Array.isArray(def.appliesTo),
          `${label} bound "${field}" has no appliesTo — enforcement would fall back to ` +
            `inferring the action type from the field name, which the spec forbids`,
        ).toBe(true);

        // Every named action type must exist in the registry, or the bound
        // governs something that can never be requested.
        for (const at of def.appliesTo) {
          expect(
            profile.boundsSchema.actionTypes,
            `${label} bound "${field}" applies to "${at}", which is not in the actionTypes registry`,
          ).toContain(at);
        }
      }
    });
  }
});
