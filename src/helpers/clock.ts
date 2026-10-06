/**
 * Shifted clocks for spawned processes — see clock-offset.cjs for why.
 *
 *   const clock = shiftedClock();          // offset 0
 *   env: { ...clock.env }                  // for the AS / gateway processes
 *   await clock.set(-3 * 86_400);          // those processes now live 3 days ago
 *   await clock.set(0);                    // back to the real clock
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRELOAD = join(import.meta.dirname, 'clock-offset.cjs');

export interface ShiftedClock {
  file: string;
  /** Env to merge into a spawned process: preload + offset file. */
  env: Record<string, string>;
  /** Set the offset in seconds; resolves once every process has re-read it. */
  set(seconds: number): Promise<void>;
}

export function shiftedClock(initialSeconds = 0): ShiftedClock {
  const file = join(mkdtempSync(join(tmpdir(), 'hap-e2e-clock-')), 'offset');
  writeFileSync(file, String(initialSeconds));
  const nodeOptions = [process.env.NODE_OPTIONS ?? '', `--require ${JSON.stringify(PRELOAD)}`].join(' ').trim();
  return {
    file,
    env: { NODE_OPTIONS: nodeOptions, HAP_E2E_CLOCK_FILE: file },
    async set(seconds: number) {
      writeFileSync(file, String(seconds));
      // The preload re-reads at most every 200 ms.
      await new Promise((r) => setTimeout(r, 600));
    },
  };
}
