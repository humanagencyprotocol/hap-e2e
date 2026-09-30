/**
 * `resolveAsDir` picks the Authority Server's app directory: the repo root
 * (today's standalone Next.js app) or `apps/as/` (a planned npm-workspaces
 * monorepo layout). Both cases are exercised against a real temporary
 * directory tree — no mocks, no dependency on either checkout actually
 * existing in this run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAsDir } from '../src/helpers/as-dir';

const dirs: string[] = [];

function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'hap-e2e-as-dir-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe('resolveAsDir', () => {
  it("today's layout: suveren-as/package.json at the repo root", () => {
    const root = tempRoot();
    const asRoot = join(root, 'suveren-as');
    mkdirSync(asRoot, { recursive: true });
    writeFileSync(join(asRoot, 'package.json'), JSON.stringify({ name: 'suveren-as' }));

    expect(resolveAsDir(root)).toBe(asRoot);
  });

  it("monorepo layout: suveren-as/apps/as/package.json, no root package.json", () => {
    const root = tempRoot();
    const nested = join(root, 'suveren-as', 'apps', 'as');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: '@suveren/as' }));

    expect(resolveAsDir(root)).toBe(nested);
  });

  it('prefers the nested app when BOTH a root and a nested package.json exist', () => {
    // A monorepo root commonly still has its own package.json (workspaces
    // declaration, shared devDependencies) — that must not be mistaken for
    // the app itself.
    const root = tempRoot();
    const asRoot = join(root, 'suveren-as');
    const nested = join(asRoot, 'apps', 'as');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(asRoot, 'package.json'), JSON.stringify({ name: 'suveren-as', workspaces: ['apps/*'] }));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: '@suveren/as' }));

    expect(resolveAsDir(root)).toBe(nested);
  });

  it('neither layout present: falls back to the repo-root path (still fails loudly downstream)', () => {
    const root = tempRoot();
    // No suveren-as directory at all.
    expect(resolveAsDir(root)).toBe(join(root, 'suveren-as'));
  });
});
