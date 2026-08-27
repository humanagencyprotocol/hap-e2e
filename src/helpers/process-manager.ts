import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// src/helpers/ → src → hap-e2e → HAP repo root
const ROOT = join(import.meta.dirname, '..', '..', '..');

interface ManagedProcess {
  name: string;
  proc: ChildProcess;
}

export class ProcessManager {
  private processes: ManagedProcess[] = [];
  private dataDir: string | null = null;

  /** Temporary data directory for the gateway (cleaned up in killAll). */
  getDataDir(): string {
    if (!this.dataDir) {
      this.dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-'));
    }
    return this.dataDir;
  }

  /**
   * Build the gateway workspace (pnpm build).
   * Run once before starting the gateway.
   */
  buildGateway(): void {
    // Built once per run by the vitest globalSetup. Nineteen suites call this;
    // rebuilding identical output nineteen times bought no isolation and was
    // the single biggest cost in CI. Kept as a call site so suites read the
    // same, and so a suite run outside the harness still builds.
    if (process.env.HAP_E2E_PREBUILT === '1') return;

    console.error('[E2E] Building Suveren gateway...');
    execSync('pnpm build', {
      cwd: join(ROOT, 'suveren-gateway'),
      stdio: 'pipe',
      timeout: 180_000,
    });
    console.error('[E2E] Gateway build complete.');
  }

  /**
   * Start the Authority Server.
   * Method name kept as `startSP` for caller compatibility; the service is the
   * Suveren Authority Server (formerly "SP").
   *
   * Runs the production server against the build made once in globalSetup.
   * `next dev` was compiling every route on first request, in every one of the
   * 27 suites — ~9s to boot plus a stall on each new endpoint, against ~1s to
   * boot here. Behaviour is unchanged: the same routes, the same in-memory
   * store, a fresh process (and so a fresh store) per suite.
   */
  async startSP(port: number): Promise<ChildProcess> {
    console.error(`[E2E] Starting Authority Server on port ${port}...`);
    const proc = spawn('npx', ['next', 'start', '-p', String(port)], {
      cwd: join(ROOT, 'suveren-as'),
      // Own process group, so stopProcess/killAll can signal the whole tree.
      // `npx` spawns the real server as a child; signalling only the wrapper
      // leaves that child serving (and orphaned at job teardown).
      detached: true,
      env: {
        ...process.env,
        ALLOW_REGISTRATION: 'true',
        SUVEREN_TEST_DIRECT_REGISTER: 'true',
        // Seed local-admin (key 'local-dev-key') is an operator → can verify
        // identities (v0.6 Identity Assurance e2e).
        ADMIN_USER_IDS: 'local-admin',
        PORT: String(port),
        // No Redis env vars → in-memory storage. The fail-closed guard in
        // redis.ts/keys.ts only trips in production; the dev escape hatch
        // makes the intent explicit and keeps CI green regardless of NODE_ENV.
        SP_KV_REST_API_URL: '',
        SP_KV_REST_API_TOKEN: '',
        SUVEREN_ALLOW_EPHEMERAL: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.push({ name: 'as', proc });
    this.pipeOutput(proc, 'AS');

    await this.waitForHealth(`http://localhost:${port}/api/as/pubkey`, 60_000);
    console.error(`[E2E] Authority Server ready on port ${port}.`);
    return proc;
  }

  /**
   * Start the gateway (Express HTTP server).
   */
  async startGateway(opts: {
    port: number;
    spUrl: string;
    spApiKey: string;
    profilesDir: string;
    mode?: 'personal' | 'team';
  }): Promise<ChildProcess> {
    const dataDir = this.getDataDir();
    console.error(`[E2E] Starting gateway on port ${opts.port}...`);

    const proc = spawn(
      'node',
      ['apps/mcp-server/dist/http.mjs'],
      {
        cwd: join(ROOT, 'suveren-gateway'),
        env: {
          ...process.env,
          SUVEREN_MCP_PORT: String(opts.port),
          SUVEREN_AS_URL: opts.spUrl,
          SUVEREN_AS_API_KEY: opts.spApiKey,
          SUVEREN_PROFILES_DIR: opts.profilesDir,
          // Read-only manifest source. Runtime npm installs go to a SEPARATE
          // dir (SUVEREN_INTEGRATIONS_DIR) — the two must never be the same.
          SUVEREN_MANIFESTS_DIR: join(ROOT, 'suveren-gateway', 'content', 'integrations'),
          SUVEREN_INTEGRATIONS_DIR: join(dataDir, 'integrations'),
          SUVEREN_DATA_DIR: dataDir,
          // opts.mode is retained for caller compatibility; the mcp-server no
          // longer reads a MODE env var (group type is set via the AS).
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.processes.push({ name: 'gateway', proc });
    this.pipeOutput(proc, 'GW');

    await this.waitForHealth(`http://localhost:${opts.port}/health`, 30_000);
    console.error(`[E2E] Gateway ready on port ${opts.port}.`);
    return proc;
  }

  /**
   * Poll a URL until it returns 200 (or timeout).
   */
  async waitForHealth(url: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const interval = 1_000;
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(url);
        if (res.ok) return;
      } catch {
        // not ready yet
      }
      await sleep(interval);
    }
    throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}`);
  }

  /**
   * Stop one managed process by name and wait for it to actually exit.
   *
   * Exists for the fail-closed test: "no receipt, no execution" can only be
   * proven by taking the Authority Server away from a running gateway and
   * watching the next call refuse. Waiting for the exit matters — a test that
   * continued while the port was still bound would be asserting against a
   * server that had not gone yet.
   */
  async stopProcess(name: string, opts: { confirmDownUrl?: string } = {}): Promise<void> {
    const entry = this.processes.find(p => p.name === name);
    if (!entry) throw new Error(`No managed process named "${name}"`);
    const { proc } = entry;
    console.error(`[E2E] Stopping ${name} (pid ${proc.pid})...`);

    // Kill the process GROUP, not just the process we spawned. The Authority
    // Server runs as `npx next start`: npx is a wrapper that spawns the real
    // server as a child, and a SIGTERM delivered to the wrapper does not
    // reach it. The wrapper exits, the server keeps serving, and a test that
    // believed the service was down would quietly assert nothing — which is
    // exactly what happened on CI while passing locally.
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, sig);
      } catch {
        try { proc.kill(sig); } catch { /* already gone */ }
      }
    };

    if (proc.exitCode == null) {
      signalGroup('SIGTERM');
      await Promise.race([
        new Promise<void>(resolve => proc.on('exit', () => resolve())),
        sleep(5_000),
      ]);
      if (proc.exitCode == null) signalGroup('SIGKILL');
      await Promise.race([
        new Promise<void>(resolve => proc.on('exit', () => resolve())),
        sleep(2_000),
      ]);
    }

    // The authoritative check: the process table is a proxy, the port is the
    // thing under test. Poll until the service actually stops answering.
    if (opts.confirmDownUrl) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          await fetch(opts.confirmDownUrl, { signal: AbortSignal.timeout(1_000) });
        } catch {
          break; // refused/timed out — genuinely down
        }
        if (Date.now() > deadline) {
          throw new Error(
            `${name} still answering ${opts.confirmDownUrl} after kill — a test that continued ` +
            'here would assert against a service that never went away.',
          );
        }
        await sleep(250);
      }
    }

    console.error(`[E2E] ${name} is down.`);
    this.processes = this.processes.filter(p => p !== entry);
  }

  /**
   * Kill all managed processes and clean up temp dir.
   */
  async killAll(): Promise<void> {
    for (const { name, proc } of this.processes) {
      if (proc.exitCode != null) continue;
      console.error(`[E2E] Stopping ${name} (pid ${proc.pid})...`);
      // Signal the group where we have one (see stopProcess): killing only the
      // `npx` wrapper left the real server running, which is what produced the
      // "Terminate orphan process" lines at job teardown.
      const sig = (s: NodeJS.Signals) => {
        try {
          if (proc.pid) process.kill(-proc.pid, s);
        } catch {
          try { proc.kill(s); } catch { /* already gone */ }
        }
      };
      sig('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => proc.on('exit', () => resolve())),
        sleep(3_000),
      ]);
      if (proc.exitCode == null) {
        console.error(`[E2E] Force-killing ${name}...`);
        sig('SIGKILL');
      }
    }
    this.processes = [];

    if (this.dataDir) {
      try {
        rmSync(this.dataDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      this.dataDir = null;
    }
  }

  private pipeOutput(proc: ChildProcess, tag: string): void {
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        console.error(`[${tag}] ${line}`);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        console.error(`[${tag}] ${line}`);
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
