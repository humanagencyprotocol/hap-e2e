/**
 * Shared fixtures for Playwright browser e2e tests.
 *
 * Starts SP + gateway (MCP server + control plane) as child processes.
 * Provides authenticated browser pages for SP and gateway UIs.
 */

import { test as base, type Browser, type Page, type APIRequestContext } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Paths ───────────────────────────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..');
const SP_DIR = join(ROOT, 'hap-sp');
const GW_DIR = join(ROOT, 'hap-gateway');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

// ─── Ports ───────────────────────────────────────────────────────────────────

export const SP_PORT = 19100;
export const GW_CP_PORT = 19402;  // Control plane (serves UI)
export const GW_MCP_PORT = 19430; // MCP server

export const SP_URL = `http://localhost:${SP_PORT}`;
export const GW_URL = `http://localhost:${GW_CP_PORT}`;
export const GW_MCP_URL = `http://localhost:${GW_MCP_PORT}`;

// ─── Process management ──────────────────────────────────────────────────────

const processes: ChildProcess[] = [];
let dataDir: string | null = null;
let serversStarted = false;

function getDataDir(): string {
  if (!dataDir) {
    dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-browser-'));
  }
  return dataDir;
}

function pipeOutput(proc: ChildProcess, tag: string): void {
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

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Health check timed out: ${url}`);
}

export async function startServers(): Promise<void> {
  if (serversStarted) return;

  // Build gateway
  console.error('[E2E] Building gateway...');
  execSync('pnpm build', { cwd: GW_DIR, stdio: 'pipe', timeout: 60_000 });
  console.error('[E2E] Gateway build complete.');

  // Start SP
  console.error(`[E2E] Starting SP on port ${SP_PORT}...`);
  const sp = spawn('npx', ['next', 'dev', '-p', String(SP_PORT)], {
    cwd: SP_DIR,
    env: {
      ...process.env,
      ALLOW_REGISTRATION: 'true',
      SP_KV_REST_API_URL: '',
      SP_KV_REST_API_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(sp);
  pipeOutput(sp, 'SP');
  await waitForHealth(`${SP_URL}/api/sp/pubkey`, 60_000);
  console.error(`[E2E] SP ready.`);

  const dd = getDataDir();

  // Start gateway MCP server
  console.error(`[E2E] Starting gateway MCP on port ${GW_MCP_PORT}...`);
  const mcp = spawn('node', ['apps/mcp-server/dist/http.mjs'], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      HAP_MCP_PORT: String(GW_MCP_PORT),
      HAP_SP_URL: SP_URL,
      HAP_PROFILES_DIR: PROFILES_DIR,
      HAP_DATA_DIR: dd,
      HAP_MODE: 'personal',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(mcp);
  pipeOutput(mcp, 'MCP');
  await waitForHealth(`${GW_MCP_URL}/health`, 30_000);
  console.error(`[E2E] Gateway MCP ready.`);

  // Start gateway control plane
  console.error(`[E2E] Starting gateway control plane on port ${GW_CP_PORT}...`);
  const cp = spawn('node', ['apps/control-plane/dist/index.mjs'], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      HAP_CP_PORT: String(GW_CP_PORT),
      HAP_SP_URL: SP_URL,
      HAP_MCP_INTERNAL_URL: GW_MCP_URL,
      HAP_UI_DIST: join(GW_DIR, 'apps/ui/dist'),
      HAP_DATA_DIR: dd,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(cp);
  pipeOutput(cp, 'CP');
  await waitForHealth(`${GW_URL}/health`, 15_000);
  console.error(`[E2E] Gateway control plane ready.`);

  serversStarted = true;
}

export async function stopServers(): Promise<void> {
  for (const proc of processes) {
    if (proc.exitCode != null) continue;
    proc.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(r => proc.on('exit', () => r())),
      new Promise(r => setTimeout(r, 3000)),
    ]);
    if (proc.exitCode == null) proc.kill('SIGKILL');
  }
  processes.length = 0;

  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    dataDir = null;
  }
  serversStarted = false;
}

// ─── Auth helpers ────────────────────────────────────────────────────────────

/**
 * Register a user on the SP via API. Returns API key.
 */
export async function registerUser(
  request: APIRequestContext,
  name: string,
  email: string,
): Promise<{ id: string; apiKey: string; did: string }> {
  const res = await request.post(`${SP_URL}/api/auth/register`, {
    data: { name, email },
  });
  if (!res.ok()) throw new Error(`Register failed: ${res.status()}`);
  const data = await res.json();
  return { id: data.user.id, apiKey: data.apiKey, did: data.user.did ?? `did:hap:${data.user.id}` };
}

/**
 * Login to the SP and get a session cookie.
 */
export async function loginSP(request: APIRequestContext, apiKey: string): Promise<string> {
  const res = await request.post(`${SP_URL}/api/auth/session`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok()) throw new Error(`SP login failed: ${res.status()}`);
  const setCookie = res.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/hap-session=([^;]+)/);
  if (!match) throw new Error('No hap-session cookie');
  return match[1];
}

/**
 * Create an authenticated browser page for the gateway UI.
 */
export async function gatewayPage(browser: Browser, apiKey: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: GW_URL });
  const page = await context.newPage();

  // Login via gateway's auth endpoint
  const res = await page.request.post(`${GW_URL}/auth/login`, {
    data: { apiKey },
  });

  if (res.ok()) {
    const setCookie = res.headers()['set-cookie'] ?? '';
    const match = setCookie.match(/hap-session=([^;]+)/);
    if (match) {
      await context.addCookies([{
        name: 'hap-session',
        value: match[1],
        domain: 'localhost',
        path: '/',
      }]);
    }
  }

  return page;
}

/**
 * Create an authenticated browser page for the SP dashboard.
 */
export async function spPage(browser: Browser, apiKey: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: SP_URL });
  const page = await context.newPage();

  const res = await page.request.post(`${SP_URL}/api/auth/session`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok()) throw new Error(`SP login failed: ${res.status()}`);

  const setCookie = res.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/hap-session=([^;]+)/);
  if (match) {
    await context.addCookies([{
      name: 'hap-session',
      value: match[1],
      domain: 'localhost',
      path: '/',
    }]);
  }

  return page;
}

// ─── Test setup ──────────────────────────────────────────────────────────────

export const test = base.extend({});
export { expect } from '@playwright/test';
