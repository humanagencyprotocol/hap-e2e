/**
 * `suveren-gateway start --as-url / --ca-file`, through the real npm CLI.
 *
 * The flag exists only in the CLI (bundle/bin/suveren-gateway.js), and the CA
 * file only takes effect through bundle/server.js re-executing itself with
 * NODE_EXTRA_CA_CERTS — so this suite assembles the npm bundle and drives the
 * CLI exactly as a user (or the login service) would, rather than starting the
 * apps directly.
 *
 * Precedence, highest first: flag > env SUVEREN_AS_URL > saved config >
 * default. Both halves (control plane AND MCP server) must resolve the same
 * URL — they resolve independently at their own start.
 *
 * The CA test puts a real Authority Server behind a local HTTPS proxy whose
 * certificate is issued by a throwaway CA generated here with openssl. Without
 * --ca-file sign-in cannot reach the server; with it, sign-in succeeds and pins
 * the key served over that TLS connection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../src/helpers/process-manager';
import {
  GW_DIR, ROOT, SEED_API_KEY, ControlPlaneClient, asKeyEnv, ed25519Keypair, readPairingFile, sleep,
} from '../src/helpers/gateway-stack';

const CP_PORT = 18130;
const MCP_PORT = 18139;
const AS_PORT = 18140;
const TLS_PORT = 18141;
const TLS_URL = `https://localhost:${TLS_PORT}`;

const CLI = join(GW_DIR, 'bundle', 'dist', 'bin', 'suveren-gateway.js');
const pm = new ProcessManager();
const cp = new ControlPlaneClient(`http://localhost:${CP_PORT}`);
const tmpDirs: string[] = [];

function freshDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hap-e2e-cli-'));
  tmpDirs.push(d);
  return d;
}

/** The caller's shell, minus anything that would decide the outcome for us. */
function cliEnv(dataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['SUVEREN_AS_URL', 'SUVEREN_AS_API_KEY', 'NODE_EXTRA_CA_CERTS', 'SUVEREN_INTERNAL_SECRET',
    'SUVEREN_MCP_INTERNAL_URL', 'SUVEREN_CP_INTERNAL_URL', 'SUVEREN_PROFILES_DIR', 'SUVEREN_MANIFESTS_DIR',
    'SUVEREN_INTEGRATIONS_DIR', 'HAP_UI_DIST']) delete env[k];
  return { ...env, SUVEREN_DATA_DIR: dataDir, SUVEREN_CP_PORT: String(CP_PORT), SUVEREN_MCP_PORT: String(MCP_PORT), ...extra };
}

let runSeq = 0;
/** `suveren-gateway start [args]` in the foreground, until both halves answer. */
async function startCli(dataDir: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const name = `cli-${++runSeq}`;
  await pm.startManaged(name, process.execPath, [CLI, 'start', ...args], {
    cwd: GW_DIR,
    env: cliEnv(dataDir, extraEnv),
    healthUrl: `http://localhost:${CP_PORT}/health`,
    timeoutMs: 45_000,
  });
  await pm.waitForHealth(`http://localhost:${MCP_PORT}/health`, 30_000);
  return name;
}

async function stopCli(name: string): Promise<void> {
  await pm.stopProcess(name, { confirmDownUrl: `http://localhost:${CP_PORT}/health` });
  await pm.waitForDown(`http://localhost:${MCP_PORT}/health`, 20_000);
}

async function resolvedUrls(): Promise<{ cp: string; mcp: string }> {
  const cpHealth = await cp.health();
  const mcpHealth = (await (await fetch(`http://localhost:${MCP_PORT}/health`)).json()) as { sp: string };
  return { cp: cpHealth.spUrl, mcp: mcpHealth.sp };
}

function cliRun(dataDir: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: cliEnv(dataDir, extraEnv), encoding: 'utf-8', timeout: 60_000 });
}

beforeAll(() => {
  pm.buildGateway();
  // Assemble the npm bundle from the build output (no network when its
  // node_modules already exist; the assembler installs them otherwise).
  execSync('node bundle/build.mjs', {
    cwd: GW_DIR,
    stdio: 'pipe',
    timeout: 300_000,
    env: { ...process.env, HAP_PROFILES_SRC: join(ROOT, 'hap-profiles') },
  });
}, 360_000);

afterAll(async () => {
  await pm.killAll();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}, 30_000);

describe('AS URL precedence: flag > env > saved > default', () => {
  const dataDir = freshDataDir();
  const SAVED = 'http://127.0.0.1:18131';
  const ENV = 'http://127.0.0.1:18132';
  const FLAG = 'http://127.0.0.1:18133';

  it('with nothing set, both halves use the default', async () => {
    const run = await startCli(dataDir, []);
    try {
      expect(await resolvedUrls()).toEqual({ cp: 'https://www.suveren.ai', mcp: 'https://www.suveren.ai' });
    } finally { await stopCli(run); }
  }, 90_000);

  it('a saved as-url is used when nothing overrides it', async () => {
    const set = cliRun(dataDir, ['config', 'set', 'as-url', `${SAVED}/`]);
    expect(set.status, set.stderr).toBe(0);
    const run = await startCli(dataDir, []);
    try {
      expect(await resolvedUrls()).toEqual({ cp: SAVED, mcp: SAVED });
    } finally { await stopCli(run); }
  }, 90_000);

  it('env SUVEREN_AS_URL overrides the saved value', async () => {
    const run = await startCli(dataDir, [], { SUVEREN_AS_URL: ENV });
    try {
      expect(await resolvedUrls()).toEqual({ cp: ENV, mcp: ENV });
    } finally { await stopCli(run); }
  }, 90_000);

  it('the --as-url flag overrides env, and is saved for the next start', async () => {
    const run = await startCli(dataDir, ['--as-url', FLAG], { SUVEREN_AS_URL: ENV });
    try {
      expect(await resolvedUrls()).toEqual({ cp: FLAG, mcp: FLAG });
    } finally { await stopCli(run); }
    const get = cliRun(dataDir, ['config', 'get', 'as-url']);
    expect(get.stdout.trim()).toBe(FLAG);
  }, 90_000);

  it('refuses an invalid --as-url and leaves the saved value alone', () => {
    const run = cliRun(dataDir, ['start', '--as-url', 'http://as.example.com']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/https/);
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8')).asUrl).toBe(FLAG);
  });

  it('refuses to start on an invalid explicit SUVEREN_AS_URL instead of falling back', async () => {
    const name = `cli-bad-env-${++runSeq}`;
    const proc = await pm.startManaged(name, process.execPath, [CLI, 'start'], {
      cwd: GW_DIR,
      env: cliEnv(dataDir, { SUVEREN_AS_URL: 'http://as.example.com' }),
    });
    const code = await new Promise<number | null>((resolve) => {
      if (proc.exitCode != null) resolve(proc.exitCode);
      proc.once('exit', (c) => resolve(c));
      setTimeout(() => resolve(null), 30_000);
    });
    expect(code, 'gateway kept running on an invalid explicit AS URL').not.toBeNull();
    expect(code).not.toBe(0);
    await expect(fetch(`http://localhost:${CP_PORT}/health`)).rejects.toThrow();
  }, 60_000);
});

describe('--ca-file: an Authority Server behind an internal CA', () => {
  const certDir = freshDataDir();
  const asKey = ed25519Keypair();
  let tls: Server;

  beforeAll(async () => {
    const o = (args: string[]) => execFileSync('openssl', args, { cwd: certDir, stdio: 'pipe' });
    o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2',
      '-subj', '/CN=hap-e2e throwaway CA', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost']);
    writeFileSync(join(certDir, 'leaf.ext'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' +
      'keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    o(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext']);

    await pm.startSP(AS_PORT, { env: asKeyEnv(asKey) });

    // TLS in front of the real AS — a plain forwarding proxy, nothing rewritten.
    tls = createHttpsServer(
      { key: readFileSync(join(certDir, 'leaf.key')), cert: readFileSync(join(certDir, 'leaf.pem')) },
      (req, res) => {
        const up = httpRequest(
          { host: '127.0.0.1', port: AS_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${AS_PORT}` } },
          (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); },
        );
        up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
        req.pipe(up);
      },
    );
    await new Promise<void>((r) => tls.listen(TLS_PORT, '127.0.0.1', () => r()));
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => (tls ? tls.close(() => r()) : r()));
  });

  it('without --ca-file, sign-in cannot reach the server and nothing is pinned', async () => {
    const dataDir = freshDataDir();
    const run = await startCli(dataDir, ['--as-url', TLS_URL]);
    try {
      expect((await cp.health()).spUrl).toBe(TLS_URL);
      const login = await cp.login(SEED_API_KEY);
      expect(login.status).not.toBe(200);
      expect(readPairingFile(dataDir)).toBeNull();
      expect((await cp.health()).vaultUnlocked).toBe(false);
    } finally { await stopCli(run); }
  }, 90_000);

  it('with --ca-file, sign-in succeeds over TLS and pins the key served there', async () => {
    const dataDir = freshDataDir();
    const run = await startCli(dataDir, ['--as-url', TLS_URL, '--ca-file', join(certDir, 'ca.pem')]);
    try {
      const login = await cp.login(SEED_API_KEY);
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(readPairingFile(dataDir)).toMatchObject({ asUrl: TLS_URL, publicKeyHex: asKey.publicKeyHex });
    } finally { await stopCli(run); }
  }, 90_000);

  it('a SIGTERM to the CLI alone stops the whole re-executed tree', async () => {
    const dataDir = freshDataDir();
    const run = await startCli(dataDir, ['--as-url', TLS_URL, '--ca-file', join(certDir, 'ca.pem')]);
    // Signal ONLY the top process (not its group), as a terminal or service
    // manager would: the re-exec parent must relay it down.
    pm.signalOnly(run, 'SIGTERM');
    await pm.waitForDown(`http://localhost:${CP_PORT}/health`, 20_000);
    await pm.waitForDown(`http://localhost:${MCP_PORT}/health`, 20_000);
    await pm.stopProcess(run);
    await sleep(100);
  }, 90_000);
});
