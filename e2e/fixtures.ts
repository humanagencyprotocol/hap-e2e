/**
 * Shared fixtures for Playwright e2e tests.
 *
 * Global setup starts SP + gateway. Tests use ALICE/BOB (registered on first use)
 * and helpers for common operations.
 */

import { test as base, expect, type Page, type Browser, type APIRequestContext } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');
const SP_DIR = join(ROOT, 'hap-sp');
const GW_DIR = join(ROOT, 'hap-gateway');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

// ─── Ports ───────────────────────────────────────────────────────────────────

export const SP_PORT = 19100;
export const GW_CP_PORT = 19402;
export const GW_MCP_PORT = 19430;

export const SP_URL = `http://localhost:${SP_PORT}`;
export const GW_URL = `http://localhost:${GW_CP_PORT}`;
export const GW_MCP_URL = `http://localhost:${GW_MCP_PORT}`;

// ─── Test users ──────────────────────────────────────────────────────────────

export const ALICE = { name: 'Alice', apiKey: '', id: '', did: '', email: '' };
export const BOB = { name: 'Bob', apiKey: '', id: '', did: '', email: '' };

// In global setup: register users and write to file.
// In test workers: load from file.
export async function ensureUsersRegistered(): Promise<void> {
  if (ALICE.apiKey) return;

  // Try loading from file first (test worker)
  try {
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(readFileSync(join(__dirname, '.test-users.json'), 'utf-8'));
    Object.assign(ALICE, data.alice);
    Object.assign(BOB, data.bob);
    if (ALICE.apiKey) return;
  } catch { /* not saved yet — register */ }

  // Register (global setup process)
  for (const user of [ALICE, BOB]) {
    const res = await fetch(`${SP_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: user.name, email: `${user.name.toLowerCase()}-${Date.now()}@test.com` }),
    });
    if (!res.ok) throw new Error(`Failed to register ${user.name}: ${res.status}`);
    const data = await res.json() as { apiKey: string; user: { id: string; did: string; email: string } };
    user.apiKey = data.apiKey;
    user.id = data.user.id;
    user.did = data.user.did;
    user.email = data.user.email;
  }
}

// Auto-load users when imported in test workers
try {
  const data = JSON.parse(readFileSync(join(__dirname, '.test-users.json'), 'utf-8'));
  Object.assign(ALICE, data.alice);
  Object.assign(BOB, data.bob);
} catch { /* global setup hasn't run yet */ }

// ─── Profile IDs ─────────────────────────────────────────────────────────────

export const PROFILE_IDS = [
  'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
  'github.com/humanagencyprotocol/hap-profiles/purchase@0.4',
  'github.com/humanagencyprotocol/hap-profiles/email@0.4',
  'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
  'github.com/humanagencyprotocol/hap-profiles/schedule@0.4',
  'github.com/humanagencyprotocol/hap-profiles/publish@0.4',
  'github.com/humanagencyprotocol/hap-profiles/records@0.4',
] as const;

// ─── Process management ──────────────────────────────────────────────────────

const processes: ChildProcess[] = [];
let dataDir: string | null = null;
let serversReady = false;

function pipe(proc: ChildProcess, tag: string): void {
  proc.stdout?.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => console.error(`[${tag}] ${l}`)));
  proc.stderr?.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => console.error(`[${tag}] ${l}`)));
}

async function waitFor(url: string, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

export async function startServers(): Promise<void> {
  if (serversReady) return;

  console.error('[E2E] Building gateway...');
  execSync('pnpm build', { cwd: GW_DIR, stdio: 'pipe', timeout: 90_000 });
  console.error('[E2E] Build complete.');

  // Start SP
  const sp = spawn('npx', ['next', 'dev', '-p', String(SP_PORT)], {
    cwd: SP_DIR,
    env: {
      ...process.env,
      ALLOW_REGISTRATION: 'true',
      HAP_TEST_DIRECT_REGISTER: 'true',
      SP_KV_REST_API_URL: '',
      SP_KV_REST_API_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(sp);
  pipe(sp, 'SP');
  await waitFor(`${SP_URL}/api/sp/pubkey`, 60_000);
  console.error('[E2E] SP ready.');

  dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-'));

  // Start gateway MCP server
  const mcp = spawn('node', ['apps/mcp-server/dist/http.mjs'], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      HAP_MCP_PORT: String(GW_MCP_PORT),
      HAP_SP_URL: SP_URL,
      HAP_PROFILES_DIR: PROFILES_DIR,
      HAP_INTEGRATIONS_DIR: join(GW_DIR, 'content', 'integrations'),
      HAP_DATA_DIR: dataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(mcp);
  pipe(mcp, 'MCP');
  await waitFor(`${GW_MCP_URL}/health`, 30_000);
  console.error('[E2E] MCP ready.');

  // Start gateway control plane
  const cp = spawn('node', ['apps/control-plane/dist/index.mjs'], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      HAP_CP_PORT: String(GW_CP_PORT),
      HAP_SP_URL: SP_URL,
      HAP_MCP_INTERNAL_URL: `http://127.0.0.1:${GW_MCP_PORT}`,
      HAP_UI_DIST: join(GW_DIR, 'apps/ui/dist'),
      HAP_DATA_DIR: dataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(cp);
  pipe(cp, 'CP');
  await waitFor(`${GW_URL}/health`, 15_000);
  console.error('[E2E] Control plane ready.');

  // Register test users
  await ensureUsersRegistered();
  console.error('[E2E] Test users registered.');

  serversReady = true;
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
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ } dataDir = null; }
  serversReady = false;
}

// ─── Browser helpers ─────────────────────────────────────────────────────────

/**
 * Create an authenticated page — logs in via SP API session endpoint,
 * sets the session cookie, and returns the page.
 */
export async function authenticatedPage(browser: Browser, apiKey: string, baseURL?: string): Promise<Page> {
  const url = baseURL ?? SP_URL;
  const context = await browser.newContext({ baseURL: url });
  const page = await context.newPage();

  // Create session via API — if 401, re-register with fresh email
  // (Next.js dev recompilation may reset in-memory store)
  let res = await page.request.post(`${url}/api/auth/session`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!res.ok()) {
    console.error(`[E2E] Session 401 for key ${apiKey.slice(0,8)}..., re-registering...`);
    // Find which user this key belongs to and re-register with fresh email
    const user = apiKey === ALICE.apiKey ? ALICE : BOB;
    const regRes = await fetch(`${SP_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: user.name, email: `${user.name.toLowerCase()}-${Date.now()}@test.com` }),
    });
    if (regRes.ok) {
      const data = await regRes.json() as { apiKey: string; user: { id: string; did: string; email: string } };
      user.apiKey = data.apiKey;
      user.id = data.user.id;
      user.did = data.user.did;
      user.email = data.user.email;
      writeFileSync(join(__dirname, '.test-users.json'), JSON.stringify({ alice: ALICE, bob: BOB }));
    }
    // Retry with new key
    res = await page.request.post(`${url}/api/auth/session`, {
      headers: { 'X-API-Key': user.apiKey },
    });
    if (!res.ok()) throw new Error(`Login failed after re-register: ${res.status()}`);
  }

  // Extract session cookie from response headers
  const cookies = res.headers()['set-cookie'];
  if (cookies) {
    const match = cookies.match(/hap-session=([^;]+)/);
    if (match) {
      await context.addCookies([{
        name: 'hap-session',
        value: match[1],
        domain: new URL(url).hostname,
        path: '/',
      }]);
    }
  }

  return page;
}

/**
 * Sign in to the gateway through the browser login form.
 */
export async function signInToGateway(page: Page, apiKey: string): Promise<void> {
  await page.goto(`${GW_URL}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').fill(apiKey);
  await page.locator('button:has-text("Sign In")').click();

  try {
    await page.locator('.sidebar').first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    console.error('[E2E] Gateway login slow, retrying...');
    await page.goto(`${GW_URL}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(apiKey);
    await page.locator('button:has-text("Sign In")').click();
    await page.locator('.sidebar').first().waitFor({ state: 'visible', timeout: 30_000 });
  }
}

/**
 * Sign in to the SP dashboard through the browser login form.
 */
export async function signInToSP(page: Page, apiKey: string): Promise<void> {
  await page.goto(`${SP_URL}/login`);
  await page.waitForSelector('input#apiKey', { timeout: 10_000 });
  await page.fill('input#apiKey', apiKey);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(url => url.toString().includes('/dashboard'), { timeout: 15_000 });
}

export async function handleOnboarding(page: Page): Promise<void> {
  if (page.url().includes('/onboarding')) {
    await page.waitForURL(url => !url.toString().includes('/onboarding'), { timeout: 10_000 });
  }
}

/**
 * Activate an integration through the browser UI.
 */
export async function activateIntegration(page: Page, integrationName: string): Promise<void> {
  await page.click('.sidebar-item:has-text("Integrations")');
  await page.waitForSelector('.card', { timeout: 10_000 });

  const card = page.locator('.card', { has: page.locator(`text=${integrationName}`) }).first();
  await card.scrollIntoViewIfNeeded();

  const activateBtn = card.locator('button:has-text("Activate")');
  await activateBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await activateBtn.click();
  await card.locator('text=Running').waitFor({ state: 'visible', timeout: 60_000 });
}

// ─── SP API helpers ──────────────────────────────────────────────────────────

export async function spApiAttest(
  request: APIRequestContext,
  apiKey: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post(`${SP_URL}/api/sp/attest`, {
    headers: { 'x-api-key': apiKey },
    data,
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Attest failed: ${res.status()} ${JSON.stringify(body)}`);
  }
  return res.json();
}

export async function spApiReceipt(
  request: APIRequestContext,
  apiKey: string,
  data: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request.post(`${SP_URL}/api/sp/receipt`, {
    headers: { 'x-api-key': apiKey },
    data,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body };
}

export const test = base;
export { expect };
