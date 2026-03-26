/**
 * Shared fixtures for Playwright browser e2e tests.
 *
 * Starts SP + gateway (MCP server + control plane) as child processes.
 * All auth happens through browser forms — no API shortcuts.
 */

import { test as base, expect, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

  // Build gateway
  console.error('[E2E] Building gateway...');
  execSync('pnpm build', { cwd: GW_DIR, stdio: 'pipe', timeout: 90_000 });
  console.error('[E2E] Build complete.');

  // Start SP
  const sp = spawn('npx', ['next', 'dev', '-p', String(SP_PORT)], {
    cwd: SP_DIR,
    env: { ...process.env, ALLOW_REGISTRATION: 'true', SP_KV_REST_API_URL: '', SP_KV_REST_API_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processes.push(sp);
  pipe(sp, 'SP');
  await waitFor(`${SP_URL}/api/sp/pubkey`, 60_000);
  console.error('[E2E] SP ready.');

  // Temp data dir
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
      HAP_MODE: 'personal',
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
 * Register a new user through the SP browser UI.
 * Returns the API key displayed on the get-started page.
 */
export async function registerOnSP(page: Page, name: string): Promise<string> {
  const email = `${name.toLowerCase().replace(/\s/g, '')}-${Date.now()}@test.com`;

  // Intercept registration API response to capture the real (unmasked) API key
  let capturedApiKey = '';
  const responseHandler = async (response: import('@playwright/test').Response) => {
    if (response.url().includes('/api/auth/register') && response.status() === 201) {
      try {
        const data = await response.json();
        if (data.apiKey) capturedApiKey = data.apiKey;
      } catch { /* ignore */ }
    }
  };
  page.on('response', responseHandler);

  await page.goto(`${SP_URL}/get-started`);
  await page.waitForSelector('input#name', { timeout: 10_000 });
  await page.fill('input#name', name);
  await page.fill('input#email', email);
  await page.click('button:has-text("Create Account")');

  // Wait for get-started flow to load (logged in state)
  await page.waitForSelector('text=Personal', { timeout: 15_000 });

  // Click Personal mode to reveal Docker command
  await page.click('button:has-text("Personal")');
  await page.waitForSelector('pre code', { timeout: 10_000 });

  page.off('response', responseHandler);

  if (!capturedApiKey) throw new Error('Could not capture API key from registration response');
  return capturedApiKey;
}

/**
 * Sign in to the gateway through the browser login form.
 */
export async function signInToGateway(page: Page, apiKey: string): Promise<void> {
  await page.goto(`${GW_URL}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').fill(apiKey);
  await page.locator('button:has-text("Sign In")').click();

  // Wait for sidebar or onboarding. If login hangs, retry once.
  try {
    await page.locator('.sidebar').or(page.locator('text=Single Domain')).first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    // Login may have hung — reload and try again
    console.error('[E2E] Gateway login slow, retrying...');
    await page.goto(`${GW_URL}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(apiKey);
    await page.locator('button:has-text("Sign In")').click();
    await page.locator('.sidebar').or(page.locator('text=Single Domain')).first().waitFor({ state: 'visible', timeout: 20_000 });
  }
}

/**
 * Handle onboarding if shown (select Single Domain for personal use).
 */
export async function handleOnboarding(page: Page): Promise<void> {
  if (page.url().includes('/onboarding')) {
    await page.click('text=Single Domain');
    await page.waitForURL(url => !url.toString().includes('/onboarding'), { timeout: 10_000 });
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

/**
 * Navigate through the gate wizard and create an authorization.
 * Assumes the page is already on the gateway and logged in.
 */
export async function createAuthorization(
  page: Page,
  opts: {
    pathButtonText: string;       // e.g. "records-write"
    bounds: Record<string, string>; // field label → value
    problem: string;
    objective: string;
    tradeoffs: string;
    commitMode: 'now' | 'per-action';
  },
): Promise<void> {
  // Navigate to Authorize Agents via sidebar (preserves SPA state)
  await page.click('.sidebar-item:has-text("Authorize Agents")');
  await page.waitForSelector('.card', { timeout: 10_000 });

  // Click path button
  await page.click(`button:has-text("${opts.pathButtonText}")`);
  await page.waitForSelector('button:has-text("Create Authorization")', { timeout: 5_000 });
  await page.click('button:has-text("Create Authorization")');

  // Step 1: Bounds — click + button to set value
  for (const [, value] of Object.entries(opts.bounds)) {
    const numValue = parseInt(value, 10);
    const plusBtn = page.locator('.stepper-btn').last(); // + button is the last stepper-btn
    for (let i = 0; i < numValue; i++) {
      await plusBtn.click();
    }
  }
  // Click "Next: Problem Statement" or similar
  await page.click('button:has-text("Next")');

  // Step 2: Problem
  await page.waitForSelector('textarea', { timeout: 5_000 });
  await page.fill('textarea', opts.problem);
  await page.click('button:has-text("Continue")');

  // Step 3: Objective
  await page.waitForSelector('textarea', { timeout: 5_000 });
  await page.fill('textarea', opts.objective);
  await page.click('button:has-text("Continue")');

  // Step 4: Tradeoffs
  await page.waitForSelector('textarea', { timeout: 5_000 });
  await page.fill('textarea', opts.tradeoffs);
  await page.click('button:has-text("Continue")');

  // Step 5: Review — wait for commitment section, choose mode
  await page.waitForSelector('text=Commitment', { timeout: 5_000 });
  if (opts.commitMode === 'per-action') {
    await page.locator('button', { hasText: 'Commit Per Action' }).click();
  }

  // Click Authorize button (the btn-primary btn-lg, not the commitment cards)
  await page.locator('button.btn-primary.btn-lg').click();

  // Wait for success or error
  const result = await Promise.race([
    page.waitForSelector('text=Attestation Committed', { timeout: 15_000 }).then(() => 'success'),
    page.waitForSelector('.error-message', { timeout: 15_000 }).then(async (el) => {
      const text = await el.textContent();
      return `error: ${text}`;
    }),
  ]);

  if (result.startsWith('error')) {
    throw new Error(`Authorization failed: ${result}`);
  }
}

export const test = base;
export { expect };
