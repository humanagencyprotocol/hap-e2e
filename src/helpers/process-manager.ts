import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { AS_DIR, resolveNextBin } from './as-dir';

// src/helpers/ → src → hap-e2e → HAP repo root
const ROOT = join(import.meta.dirname, '..', '..', '..');

interface ManagedProcess {
  name: string;
  proc: ChildProcess;
}

export class ProcessManager {
  private processes: ManagedProcess[] = [];
  private dataDir: string | null = null;
  /**
   * Throwaway Postgres databases this instance created (Redis → Postgres
   * move) — one per startSP call, so a suite that runs two Authority Servers,
   * or restarts one as a DIFFERENT server, gives each its own store, as the
   * in-memory AS used to. All dropped in killAll().
   */
  private asDbs: Array<{ name: string; adminUrl: string }> = [];

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
   * boot here.
   *
   * Storage (work-plan step 3: Redis → Postgres): the Authority Server has no
   * in-memory fallback anymore — it requires SUVEREN_DB_URL unconditionally.
   * Dual-mode, and deliberately with no silent fallback of our own:
   *   - SUVEREN_DB_URL set in THIS process's env (the caller's Postgres) →
   *     create a throwaway per-suite database on that same server (same
   *     host/user/credentials, a fresh random database name) and point the
   *     spawned AS at it, so "a fresh process (and so a fresh store) per
   *     suite" still holds — 27 suites sharing one database would cross-
   *     contaminate the very isolation this comment used to get from separate
   *     in-memory processes. Dropped again in killAll().
   *   - SUVEREN_DB_URL not set → nothing Postgres-related is passed through,
   *     and the spawned AS fails its OWN startup with a clear "SUVEREN_DB_URL
   *     is not set" message (lib/db.ts) — the same fail-closed behaviour a
   *     real deployment gets, not a suite-specific workaround.
   *
   * AS_DIR resolves to `suveren-as/` or, in an npm-workspaces monorepo layout,
   * `suveren-as/apps/as/` (see src/helpers/as-dir.ts). We run the `next` CLI
   * directly (resolved via Node's own module resolution, which finds a
   * hoisted `next` just as well as a local one) rather than through `npx`, so
   * there is no wrapper process between us and the server — see
   * resolveNextBin's doc comment and stopProcess below for why that matters.
   */
  async startSP(
    port: number,
    opts: {
      /** Process name for stopProcess — distinct names let a suite run two AS instances. */
      name?: string;
      /** Extra env, e.g. SP_PRIVATE_KEY/SP_PUBLIC_KEY to pin the signing key. */
      env?: Record<string, string>;
    } = {},
  ): Promise<ChildProcess> {
    console.error(`[E2E] Starting Authority Server on port ${port}...`);

    const storageEnv = await this.provisionAsStorage();

    const nextBin = resolveNextBin(AS_DIR);
    const proc = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
      cwd: AS_DIR,
      // Own process group, so stopProcess/killAll can signal the whole tree
      // (Next may itself fork a worker; signalling only the top process could
      // leave that behind).
      detached: true,
      env: {
        ...process.env,
        ALLOW_REGISTRATION: 'true',
        SUVEREN_TEST_DIRECT_REGISTER: 'true',
        // Seed local-admin (key 'local-dev-key') is an operator → can verify
        // identities (v0.6 Identity Assurance e2e). Its own flag, deliberately
        // NOT SUVEREN_ALLOW_EPHEMERAL: that one means "ephemeral SIGNING KEY"
        // only — seeding writes a PUBLIC, hardcoded credential into whatever
        // durable store SUVEREN_DB_URL points at (fine for the throwaway
        // per-suite database provisionAsStorage creates below, never fine for
        // a persistent one), so the AS gates it separately (lib/config.ts
        // refuses SUVEREN_SEED_DEV_USERS=1 outright under
        // SUVEREN_EDITION=self-hosted).
        ADMIN_USER_IDS: 'local-admin',
        SUVEREN_SEED_DEV_USERS: '1',
        PORT: String(port),
        // The signing-key escape hatch (unrelated to storage) — no
        // SP_PRIVATE_KEY/SP_PUBLIC_KEY is supplied, so the AS generates an
        // ephemeral Ed25519 keypair. Still needed with Postgres.
        SUVEREN_ALLOW_EPHEMERAL: '1',
        ...storageEnv,
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.push({ name: opts.name ?? 'as', proc });
    this.pipeOutput(proc, 'AS');

    await this.waitForHealth(`http://localhost:${port}/api/as/pubkey`, 60_000);
    console.error(`[E2E] Authority Server ready on port ${port}.`);
    return proc;
  }

  /**
   * Provision this suite's AS storage. Returns the env vars to overlay onto
   * the spawned process — never mutates process.env, and never invents a
   * fallback: if the caller gave us no SUVEREN_DB_URL, we hand back {} and
   * the child fails closed on its own (see startSP's doc comment).
   */
  private async provisionAsStorage(): Promise<Record<string, string>> {
    const callerUrl = process.env.SUVEREN_DB_URL;
    if (!callerUrl) return {};

    const admin = new URL(callerUrl);
    const dbName = `hap_e2e_${randomBytes(6).toString('hex')}`;

    const adminClient = new Client({ connectionString: admin.toString() });
    await adminClient.connect();
    await adminClient.query(`create database ${dbName}`);
    await adminClient.end();

    const suiteUrl = new URL(callerUrl);
    suiteUrl.pathname = `/${dbName}`;

    this.asDbs.push({ name: dbName, adminUrl: admin.toString() });

    console.error(`[E2E] Created throwaway AS database ${dbName} (Redis → Postgres move).`);
    return { SUVEREN_DB_URL: suiteUrl.toString() };
  }

  /** Drops every throwaway AS database provisionAsStorage created. */
  private async dropAsStorage(): Promise<void> {
    const dbs = this.asDbs;
    this.asDbs = [];
    for (const { name: dbName, adminUrl } of dbs) {
      try {
        const adminClient = new Client({ connectionString: adminUrl });
        await adminClient.connect();
        await adminClient.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [dbName],
        );
        await adminClient.query(`drop database if exists ${dbName}`);
        await adminClient.end();
      } catch (err) {
        console.error(`[E2E] Failed to drop throwaway AS database ${dbName} (best-effort):`, err);
      }
    }
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
   * Start an arbitrary long-running process under this manager — for suites
   * that need a shape `startGateway` does not give them (the control plane,
   * the npm CLI, a restart of one half of the gateway). The caller owns the
   * whole environment: nothing from `startGateway`'s defaults is applied.
   *
   * Spawned as its own process group so stopProcess/killAll reach anything
   * it forks (the CLI re-execs itself and spawns two children).
   */
  async startManaged(
    name: string,
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; healthUrl?: string; timeoutMs?: number },
  ): Promise<ChildProcess> {
    console.error(`[E2E] Starting ${name}: ${command} ${args.join(' ')}`);
    const proc = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.processes.push({ name, proc });
    this.pipeOutput(proc, name.toUpperCase());
    if (opts.healthUrl) {
      await Promise.race([
        this.waitForHealth(opts.healthUrl, opts.timeoutMs ?? 30_000),
        new Promise<never>((_, reject) =>
          proc.once('exit', (code) => reject(new Error(`${name} exited (code ${code}) before ${opts.healthUrl} answered`))),
        ),
      ]);
      console.error(`[E2E] ${name} ready.`);
    }
    return proc;
  }

  /**
   * Poll until a URL stops answering at all (connection refused / timeout).
   */
  async waitForDown(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(1_000) });
      } catch {
        return;
      }
      if (Date.now() > deadline) throw new Error(`Still answering after ${timeoutMs}ms: ${url}`);
      await sleep(250);
    }
  }

  /**
   * Signal ONLY the managed process itself, not its process group — to test
   * that a process relays signals to its own children.
   */
  signalOnly(name: string, sig: NodeJS.Signals): void {
    const entry = this.processes.find(p => p.name === name);
    if (!entry) throw new Error(`No managed process named "${name}"`);
    entry.proc.kill(sig);
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

    // Kill the process GROUP, not just the process we spawned. We run the
    // `next` CLI directly (see startSP), but Next itself can fork a worker;
    // signalling only the top process could leave that worker serving, and a
    // test that believed the service was down would quietly assert nothing —
    // which is exactly what happened on CI while passing locally, back when
    // this ran through an `npx` wrapper that had the same failure mode.
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
      // Signal the group where we have one (see stopProcess) so a forked
      // worker can't outlive the process we thought we killed.
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

    await this.dropAsStorage();
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
