import { defineConfig } from 'vitest/config';

/**
 * The offline layer: the suites that need no Authority Server, no gateway, and
 * no credentials — the published conformance vectors, the profile contract, and
 * the MUST map.
 *
 * It exists as a separate config for one reason: `vitest.config.ts` declares a
 * `globalSetup` that builds the gateway and the Authority Server for the whole
 * run. That is right for the live suites and wrong here — these tests spawn
 * nothing, and on a runner with neither pnpm nor the private Authority Server
 * checkout the build is not merely wasted, it fails before a single test runs.
 * That is exactly what happened to the `offline` CI job on its first outing.
 *
 * So: no globalSetup, no build, no sibling repositories beyond the public ones
 * the three suites read from disk. If a suite added here starts needing a
 * server, it belongs in the other config.
 */
export default defineConfig({
  test: {
    include: [
      'test/canonical-vectors.test.ts',
      'test/profile-conformance.test.ts',
      'test/conformance-map.test.ts',
    ],
    testTimeout: 30_000,
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
