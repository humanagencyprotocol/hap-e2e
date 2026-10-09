/**
 * v0.7 profile ids + `profile_hash` lookup, shared by every suite that
 * submits a mandate.
 *
 * v0.7 added `profile_hash` (protocol.md → *Profile hash*): the AS refuses a
 * mandate request whose `profile_hash` does not match the bytes it has
 * provisioned for that `profile_id` (PROFILE_HASH_MISMATCH). It also runs
 * `validateProfile` (hap-core) against the resolved profile, which a v0.7+
 * profile version must pass — older versions (the ones still on `main` of
 * hap-profiles, e.g. `charge@0.4`) do not declare `appliesTo`/`scopeSchema`
 * and fail that validation (PROFILE_INVALID). That is why every live suite
 * here now points the AS at the LOCAL hap-profiles checkout
 * (`local-profiles.ts`, `SUVEREN_PROFILE_SOURCE=bundled`) and uses the ids
 * below, not the `@0.4`/`@0.5` ids a pre-v0.7 suite used against GitHub
 * `main`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeProfileHash } from './crypto.js';

/** The newest (v0.7-wire) version of each profile, as of hap-profiles
 *  `feat/v07-profiles` (draft PR #9). Keep in sync with that branch's
 *  index.json — `profileHashFor` below will throw a clear error if a listed
 *  id's file goes missing, so drift here is never silent. */
export const PROFILE_V07 = {
  charge: 'github.com/humanagencyprotocol/hap-profiles/charge@0.6',
  purchase: 'github.com/humanagencyprotocol/hap-profiles/purchase@0.7',
  email: 'github.com/humanagencyprotocol/hap-profiles/email@0.8',
  customers: 'github.com/humanagencyprotocol/hap-profiles/customers@0.9',
  calendar: 'github.com/humanagencyprotocol/hap-profiles/calendar@0.6',
  publish: 'github.com/humanagencyprotocol/hap-profiles/publish@0.6',
  records: 'github.com/humanagencyprotocol/hap-profiles/records@0.6',
  deploy: 'github.com/humanagencyprotocol/hap-profiles/deploy@0.11',
  sales: 'github.com/humanagencyprotocol/hap-profiles/sales@0.4',
  reporting: 'github.com/humanagencyprotocol/hap-profiles/reporting@0.3',
  delegation: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.3',
} as const;

interface ProfilesIndex {
  profiles: Record<string, string>;
}

const indexCache = new Map<string, ProfilesIndex>();
const parsedCache = new Map<string, Record<string, unknown>>();

function loadIndex(profilesDir: string): ProfilesIndex {
  let idx = indexCache.get(profilesDir);
  if (!idx) {
    idx = JSON.parse(readFileSync(join(profilesDir, 'index.json'), 'utf8')) as ProfilesIndex;
    indexCache.set(profilesDir, idx);
  }
  return idx;
}

/** Parsed profile JSON for `profileId`, read from `profilesDir` (the local
 *  hap-profiles checkout — same bytes `localProfilesForAs` serves the AS). */
export function loadProfile(profileId: string, profilesDir: string): Record<string, unknown> {
  const cacheKey = `${profilesDir}::${profileId}`;
  let parsed = parsedCache.get(cacheKey);
  if (!parsed) {
    const idx = loadIndex(profilesDir);
    const rel = idx.profiles[profileId];
    if (!rel) {
      throw new Error(`profileId ${JSON.stringify(profileId)} is not in ${profilesDir}/index.json`);
    }
    parsed = JSON.parse(readFileSync(join(profilesDir, rel), 'utf8')) as Record<string, unknown>;
    parsedCache.set(cacheKey, parsed);
  }
  return parsed;
}

/** `profile_hash` for `profileId`, computed over the SAME bytes the local
 *  AS was started with (local-profiles.ts) — pass the same `profilesDir`. */
export function profileHashFor(profileId: string, profilesDir: string): string {
  return computeProfileHash(loadProfile(profileId, profilesDir));
}
