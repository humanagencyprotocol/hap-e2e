import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Build everything the suite needs, once.
 *
 * Why this exists: the suite used to rebuild the world per test file — 19 of
 * the 27 suites called `pnpm build` on the whole gateway monorepo, and every
 * suite started the Authority Server with `next dev`, which then compiled each
 * route on first request. Identical work, repeated ~20 times, for no isolation
 * benefit: a build is a pure function of the source, and the source does not
 * change mid-run.
 *
 * On a developer machine that was merely slow. On a 2-core CI runner it was
 * fatal — suites that take ~10s locally took ~200s, and the run was killed
 * partway through, which is why the nightly reported nothing at all from
 * 2026-08-17 onward.
 *
 * Per-suite isolation is unaffected. Each suite still starts its own Authority
 * Server process with its own in-memory store; only the *compilation* is
 * shared, and compiled output is read-only at runtime.
 *
 * Set HAP_E2E_SKIP_BUILD=1 to reuse existing build output when iterating
 * locally on a single suite. Never set it in CI — a stale build would test
 * code that is not the code under review.
 */
export default async function setup(): Promise<void> {
  if (process.env.HAP_E2E_SKIP_BUILD === '1') {
    console.error('[E2E] HAP_E2E_SKIP_BUILD=1 — reusing existing build output.');
    process.env.HAP_E2E_PREBUILT = '1';
    return;
  }

  const started = Date.now();

  console.error('[E2E] Building Suveren gateway (once for the whole run)...');
  execSync('pnpm build', {
    cwd: join(ROOT, 'suveren-gateway'),
    stdio: 'pipe',
    timeout: 300_000,
  });

  // A production build, so suites can start the AS with `next start`. `next
  // dev` re-compiles every route on first request in every suite, which is
  // where the bulk of the CI time went.
  console.error('[E2E] Building Authority Server (once for the whole run)...');
  execSync('npm run build', {
    cwd: join(ROOT, 'suveren-as'),
    stdio: 'pipe',
    timeout: 300_000,
    env: {
      ...process.env,
      // The build must not trip the production fail-closed guards for Redis
      // and signing keys; it never signs or stores anything.
      SUVEREN_ALLOW_EPHEMERAL: '1',
    },
  });

  // Read by ProcessManager.buildGateway(), which the suites still call. Vitest
  // forks its workers after this hook, so they inherit the flag.
  process.env.HAP_E2E_PREBUILT = '1';

  console.error(`[E2E] Builds complete in ${Math.round((Date.now() - started) / 1000)}s.`);
}
