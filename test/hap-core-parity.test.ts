/**
 * The Authority Server and the gateway must agree on `hap-core`.
 *
 * Product versions are deliberately NOT kept in lockstep: the AS has exactly
 * one live version while many gateway versions run in the wild at once, so
 * matching numbers cannot express compatibility and would only manufacture
 * confidence. Compatibility lives in the protocol version and in this shared
 * library.
 *
 * `hap-core` is the one place where "same version" genuinely matters. It owns
 * canonicalization, hashing and the wire types — so two implementations on
 * different versions can disagree about *bytes* while both look healthy. That
 * failure surfaces as a hash mismatch far from its cause, which is exactly the
 * kind of drift a cross-repo suite exists to catch and neither repo's own CI
 * can see.
 *
 * Pure filesystem checks: no servers, no network.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = '@humanagencyp/hap-core';

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Declared range, e.g. "^0.9.0" — present without installing anything. */
function declaredRange(pkgPath: string): string | null {
  const pkg = readJson(pkgPath);
  return pkg?.dependencies?.[CORE] ?? null;
}

/** Resolved version, e.g. "0.9.0" — only after an install. */
function resolvedVersion(nodeModulesRoot: string): string | null {
  return readJson(join(nodeModulesRoot, 'node_modules', CORE, 'package.json'))?.version ?? null;
}

const AS_PKG = join(ROOT, 'suveren-as', 'package.json');
// The gateway apps depend on the thin workspace wrapper, which is what pins
// the published package — and what the npm bundle reads to build its alias.
const GW_WRAPPER_PKG = join(ROOT, 'suveren-gateway', 'packages', 'hap-core', 'package.json');

describe('hap-core parity — the AS and the gateway share one wire contract', () => {
  it('both repos are present (otherwise this check proves nothing)', () => {
    expect(existsSync(AS_PKG), `missing ${AS_PKG}`).toBe(true);
    expect(existsSync(GW_WRAPPER_PKG), `missing ${GW_WRAPPER_PKG}`).toBe(true);
  });

  it('declares the SAME hap-core range in both repos', () => {
    const as = declaredRange(AS_PKG);
    const gw = declaredRange(GW_WRAPPER_PKG);

    expect(as, `${CORE} not declared in suveren-as`).toBeTruthy();
    expect(gw, `${CORE} not declared in the gateway's hap-core wrapper`).toBeTruthy();
    expect(
      gw,
      `hap-core drift: suveren-as declares ${as}, gateway wrapper declares ${gw}. ` +
        'These two must move together — a mismatch lets the AS and the Gatekeeper ' +
        'disagree about canonical bytes (hashes, signatures) while both appear healthy. ' +
        'Bump both, or neither.',
    ).toBe(as);
  });

  it('resolves to the same installed version where both are installed', () => {
    const as = resolvedVersion(join(ROOT, 'suveren-as'));
    // pnpm puts the wrapper's dependency under the wrapper package itself.
    const gw = resolvedVersion(join(ROOT, 'suveren-gateway', 'packages', 'hap-core'));

    if (!as || !gw) {
      // Not installed in this checkout — the declared-range test above still
      // ran, and it is the one that catches an intentional bump of one side.
      expect(true).toBe(true);
      return;
    }

    expect(
      gw,
      `hap-core resolved drift: suveren-as has ${as}, gateway has ${gw}. ` +
        'Run an install in both repos; if it persists, a lockfile is pinning an old copy.',
    ).toBe(as);
  });
});
