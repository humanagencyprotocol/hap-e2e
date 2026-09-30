import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the Authority Server app lives, resolved at runtime so this suite
 * works against either checkout layout without a flag.
 *
 * Today: `suveren-as/` is a standalone Next.js app — its `package.json` sits
 * at the repo root.
 *
 * Soon: `suveren-as` becomes an npm-workspaces monorepo and the app moves to
 * `suveren-as/apps/as/` (its own `package.json`; `next` may be hoisted up to
 * `suveren-as/node_modules`). Node's own module resolution already climbs
 * parent directories looking for `node_modules`, which is why `resolveNextBin`
 * below works unchanged either way — only the directory we resolve from has
 * to be right.
 */
export function resolveAsDir(root: string): string {
  const nested = join(root, 'suveren-as', 'apps', 'as');
  return existsSync(join(nested, 'package.json')) ? nested : join(root, 'suveren-as');
}

// src/helpers/ -> src -> hap-e2e -> HAP workspace root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Absolute path to the Authority Server app directory (either layout). */
export const AS_DIR = resolveAsDir(ROOT);

/**
 * Resolve the `next` CLI script for a given Authority Server app directory.
 *
 * Deliberately not `npx next start`: npx spawns the real server as a further
 * child process, so a SIGTERM delivered to the npx wrapper does not reach it
 * — the wrapper exits, the server keeps serving, and a test that believed the
 * service was down would quietly assert nothing (see ProcessManager.stopProcess).
 * Resolving the CLI script ourselves and running it directly under
 * `process.execPath` removes that extra hop, and — because Node's resolution
 * climbs parent `node_modules` directories — finds a hoisted `next` in the
 * monorepo layout just as reliably as a local one in today's.
 */
export function resolveNextBin(asDir: string): string {
  return createRequire(import.meta.url).resolve('next/dist/bin/next', { paths: [asDir] });
}
