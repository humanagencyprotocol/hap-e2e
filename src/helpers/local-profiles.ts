/**
 * Serve the spawned Authority Server the profiles of the LOCAL hap-profiles
 * checkout instead of GitHub main.
 *
 * By default the AS fetches profiles from github.com/humanagencyprotocol/
 * hap-profiles at `main` (profile-fetcher.ts). A suite that tests a profile
 * version which is still on a branch — or that must test exactly the profiles
 * the gateway under test loads (it reads PROFILES_DIR) — needs the AS to read
 * the same files. The AS's own offline mode does that:
 * `SUVEREN_PROFILE_SOURCE=bundled` reads `<cwd>/bundled-profiles/`.
 *
 * Nothing in the AS checkout is touched: the server runs from a throwaway
 * working directory holding a copy of the local profiles (index.json and the
 * files it lists, as scripts/sync-bundled-profiles.ts lays them out) and a link
 * to the AS's `migrations/` (also read from the cwd), while `next start` is
 * pointed at the AS app directory itself.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AS_DIR } from './as-dir';

export interface LocalProfilesAs {
  /** Working directory for `next start <AS_DIR>`. */
  cwd: string;
  env: Record<string, string>;
}

export function localProfilesForAs(profilesDir: string): LocalProfilesAs {
  const cwd = mkdtempSync(join(tmpdir(), 'hap-e2e-as-cwd-'));
  const target = join(cwd, 'bundled-profiles');
  const index = JSON.parse(readFileSync(join(profilesDir, 'index.json'), 'utf8')) as { profiles: Record<string, string> };
  mkdirSync(target, { recursive: true });
  cpSync(join(profilesDir, 'index.json'), join(target, 'index.json'));
  for (const rel of Object.values(index.profiles)) {
    const src = join(profilesDir, rel);
    if (!existsSync(src)) throw new Error(`hap-profiles index.json lists ${rel}, which does not exist in ${profilesDir}`);
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    cpSync(src, join(target, rel));
  }
  symlinkSync(join(AS_DIR, 'migrations'), join(cwd, 'migrations'), 'dir');
  return { cwd, env: { SUVEREN_PROFILE_SOURCE: 'bundled' } };
}
