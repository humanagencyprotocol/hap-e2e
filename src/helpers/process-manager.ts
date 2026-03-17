import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// src/helpers/ → src → hap-e2e → HumanAgencyProtocol
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
    console.error('[E2E] Building gateway...');
    execSync('pnpm build', {
      cwd: join(ROOT, 'hap-gateway'),
      stdio: 'pipe',
      timeout: 60_000,
    });
    console.error('[E2E] Gateway build complete.');
  }

  /**
   * Start the SP (Next.js dev server).
   */
  async startSP(port: number): Promise<ChildProcess> {
    console.error(`[E2E] Starting SP on port ${port}...`);
    const proc = spawn('npx', ['next', 'dev', '-p', String(port)], {
      cwd: join(ROOT, 'hap-sp'),
      env: {
        ...process.env,
        ALLOW_REGISTRATION: 'true',
        PORT: String(port),
        // No Redis env vars → in-memory storage
        SP_KV_REST_API_URL: '',
        SP_KV_REST_API_TOKEN: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.push({ name: 'sp', proc });
    this.pipeOutput(proc, 'SP');

    await this.waitForHealth(`http://localhost:${port}/api/sp/pubkey`, 60_000);
    console.error(`[E2E] SP ready on port ${port}.`);
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
  }): Promise<ChildProcess> {
    const dataDir = this.getDataDir();
    console.error(`[E2E] Starting gateway on port ${opts.port}...`);

    const proc = spawn(
      'node',
      ['apps/mcp-server/dist/http.mjs'],
      {
        cwd: join(ROOT, 'hap-gateway'),
        env: {
          ...process.env,
          HAP_MCP_PORT: String(opts.port),
          HAP_SP_URL: opts.spUrl,
          HAP_SP_API_KEY: opts.spApiKey,
          HAP_PROFILES_DIR: opts.profilesDir,
          HAP_DATA_DIR: dataDir,
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
   * Kill all managed processes and clean up temp dir.
   */
  async killAll(): Promise<void> {
    for (const { name, proc } of this.processes) {
      if (proc.exitCode != null) continue;
      console.error(`[E2E] Stopping ${name} (pid ${proc.pid})...`);
      proc.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => proc.on('exit', () => resolve())),
        sleep(3_000),
      ]);
      if (proc.exitCode == null) {
        console.error(`[E2E] Force-killing ${name}...`);
        proc.kill('SIGKILL');
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
