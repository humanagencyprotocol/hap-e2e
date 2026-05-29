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
const SP_DIR = join(ROOT, 'suveren-as');
const GW_DIR = join(ROOT, 'suveren-gateway');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

// ─── Ports ───────────────────────────────────────────────────────────────────

export const SP_PORT = 19100;
export const GW_CP_PORT = 19402;
export const GW_MCP_PORT = 19430;

export const SP_URL = `http://localhost:${SP_PORT}`;
export const GW_URL = `http://localhost:${GW_CP_PORT}`;
export const GW_MCP_URL = `http://localhost:${GW_MCP_PORT}`;

// Shared CP↔MCP internal secret so the control plane and MCP server trust each
// other's /internal/* calls (both must agree on the value).
const INTERNAL_SECRET = 'e2e-internal-secret';

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
  'github.com/humanagencyprotocol/hap-profiles/calendar@0.4',
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
  execSync('pnpm build', { cwd: GW_DIR, stdio: 'pipe', timeout: 180_000 });
  console.error('[E2E] Build complete.');

  // Start the Authority Server (formerly "SP")
  const sp = spawn('npx', ['next', 'dev', '-p', String(SP_PORT)], {
    cwd: SP_DIR,
    env: {
      ...process.env,
      ALLOW_REGISTRATION: 'true',
      SUVEREN_TEST_DIRECT_REGISTER: 'true',
      SP_KV_REST_API_URL: '',
      SP_KV_REST_API_TOKEN: '',
      SUVEREN_ALLOW_EPHEMERAL: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(sp);
  pipe(sp, 'AS');
  await waitFor(`${SP_URL}/api/as/pubkey`, 60_000);
  console.error('[E2E] Authority Server ready.');

  dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-'));

  // Start gateway MCP server
  const mcp = spawn('node', ['apps/mcp-server/dist/http.mjs'], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      SUVEREN_MCP_PORT: String(GW_MCP_PORT),
      SUVEREN_AS_URL: SP_URL,
      SUVEREN_PROFILES_DIR: PROFILES_DIR,
      // Read-only manifest source; runtime installs go to a separate dir.
      SUVEREN_MANIFESTS_DIR: join(GW_DIR, 'content', 'integrations'),
      SUVEREN_INTEGRATIONS_DIR: join(dataDir, 'integrations'),
      SUVEREN_DATA_DIR: dataDir,
      SUVEREN_INTERNAL_SECRET: INTERNAL_SECRET,
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
      SUVEREN_CP_PORT: String(GW_CP_PORT),
      SUVEREN_AS_URL: SP_URL,
      SUVEREN_MCP_INTERNAL_URL: `http://127.0.0.1:${GW_MCP_PORT}`,
      SUVEREN_DATA_DIR: dataDir,
      SUVEREN_INTERNAL_SECRET: INTERNAL_SECRET,
      HAP_UI_DIST: join(GW_DIR, 'apps/ui/dist'), // still HAP_-prefixed in v0.4
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
 * Waits for the URL to leave /login rather than checking .sidebar (hidden on mobile).
 */
export async function signInToGateway(page: Page, apiKey: string): Promise<void> {
  await page.goto(`${GW_URL}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input[type="password"]').fill(apiKey);
  await page.locator('button:has-text("Sign In")').click();

  try {
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 10_000 });
  } catch {
    console.error('[E2E] Gateway login slow, retrying...');
    await page.goto(`${GW_URL}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(apiKey);
    await page.locator('button:has-text("Sign In")').click();
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30_000 });
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
 * Skips activation if the integration is already running (e.g. personalDefault
 * integrations auto-register on gateway startup).
 */
export async function activateIntegration(page: Page, integrationName: string): Promise<void> {
  await page.click('.sidebar-item:has-text("Integrations")');
  await page.waitForSelector('.card', { timeout: 10_000 });

  const card = page.locator('.card', { has: page.locator(`text=${integrationName}`) }).first();
  await card.scrollIntoViewIfNeeded();

  // If already running, nothing to do.
  if (await card.locator('text=Running').isVisible()) {
    return;
  }

  const activateBtn = card.locator('button:has-text("Activate")');
  await activateBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await activateBtn.click();
  await card.locator('text=Running').waitFor({ state: 'visible', timeout: 60_000 });
}

/**
 * Register a new user via the SP API (HAP_TEST_DIRECT_REGISTER mode).
 * Returns the plain API key.
 */
export async function registerOnSP(page: Page, name: string): Promise<string> {
  const email = `${name.toLowerCase().replace(/\s/g, '')}-${Date.now()}@test.com`;
  const res = await page.request.post(`${SP_URL}/api/auth/register`, {
    data: { name, email },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok()) throw new Error(`Registration failed: ${res.status()}`);
  const data = await res.json();
  if (!data.apiKey) throw new Error('No API key in registration response');
  return data.apiKey as string;
}

/**
 * Navigate through the gate wizard and create an authorization.
 * Page must be logged into the gateway with integrations running.
 */
export async function createAuthorization(
  page: Page,
  opts: {
    profileName: string;
    bounds: Record<string, string>;
    intent: string;
    title: string;
    commitMode: 'now' | 'per-action';
  },
): Promise<void> {
  // Open the authorize picker from the Authorizations page (the dedicated
  // "Authorize" nav item was removed in v0.4).
  await page.click('.sidebar-item:has-text("Authorizations")');
  await page.click('button:has-text("New authorization")');
  await page.waitForSelector('.profile-grid', { timeout: 10_000 });

  // Click the Authorize button on the matching profile card
  const profileCard = page.locator('.card', { has: page.locator(`text=${opts.profileName}`) }).first();
  await profileCard.locator('button:has-text("Authorize")').click();

  // Wait for /agent/gate (bounds step)
  await page.waitForURL(url => url.toString().includes('/agent/gate'), { timeout: 10_000 });

  // Bounds step: click stepper + buttons to set values
  for (const [, value] of Object.entries(opts.bounds)) {
    const numValue = parseInt(value, 10);
    const plusBtn = page.locator('.stepper-btn').last();
    for (let i = 0; i < numValue; i++) {
      await plusBtn.click();
    }
  }
  await page.locator('button:has-text("Next")').click();

  // Intent step
  await page.waitForSelector('textarea', { timeout: 5_000 });
  await page.fill('textarea', opts.intent);
  await page.locator('button:has-text("Continue to Review")').click();

  // Wait for /agent/review
  await page.waitForURL(url => url.toString().includes('/agent/review'), { timeout: 10_000 });

  // Review: choose commitment mode
  if (opts.commitMode === 'per-action') {
    await page.locator('button', { hasText: 'Review Each Action' }).click();
  } else {
    await page.locator('button', { hasText: 'Automatic' }).click();
  }

  // Fill title
  await page.locator('input[placeholder*="e.g."]').fill(opts.title);

  // Click Authorize button
  const authorizeBtns = page.locator('button', { hasText: /^Authorize/ });
  await authorizeBtns.last().click();

  // Wait for success
  await page.locator('text=Authorization Created').or(page.locator('text=Attestation Committed')).first().waitFor({ state: 'visible', timeout: 15_000 });
}

// ─── SP API helpers ──────────────────────────────────────────────────────────

export async function spApiAttest(
  request: APIRequestContext,
  apiKey: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request.post(`${SP_URL}/api/as/attest`, {
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
  const res = await request.post(`${SP_URL}/api/as/receipt`, {
    headers: { 'x-api-key': apiKey },
    data,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body };
}

export const test = base;
export { expect };
