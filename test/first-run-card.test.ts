/**
 * The dashboard's first-run card on the real stack (real AS, the gateway's control
 * plane serving the built UI, the MCP server, simulation mode, a real browser).
 *
 * A person who opens the gateway for the first time is led through three steps,
 * each drawn from backend truth:
 *   1. connect your AI — open until an MCP client completes a handshake; then
 *      "<client name> connected"; the address to give the AI is the MCP server's
 *      own port (reported by the gateway, never guessed from the UI's port);
 *   2. give the Delegation mandate — the button opens that mandate directly;
 *   3. ask your AI — done once a proposal from the Delegation mandate arrives,
 *      and then the card gives way to the normal dashboard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { chromium, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';
import { ControlPlaneClient, PROFILES_DIR, newSecret, startControlPlane, startMcpServer, type StackOptions } from '../src/helpers/gateway-stack.js';
import { localProfilesForAs } from '../src/helpers/local-profiles.js';

const AS_PORT = 19700;
const CP_PORT = 19701;
const MCP_PORT = 19702;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const DELEGATION = 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1';
const available = existsSync(join(PROFILES_DIR, 'delegation', '0.1.profile.json'));
/** Screenshots for a person to look at; set HAP_E2E_SHOTS to a folder to keep them. */
const SHOTS = process.env.HAP_E2E_SHOTS;

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-first-run-'));
const secret = newSecret();
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret, asUrl: AS_URL,
  extraEnv: { SUVEREN_SIMULATION: '1', SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, secret);

let browser: Browser;
let page: Page;
let user: Awaited<ReturnType<SPClient['register']>>;
let groupId: string;

async function shot(name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(2_500);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** Back to the dashboard inside the app (a full page load drops the in-memory API key):
 *  away to Mandates and back, so the dashboard fetches fresh state. */
async function dashboard() {
  // dispatchEvent: the click itself is what React Router listens to; the sidebar
  // sits under a constantly re-measured banner stack, which Playwright never calls "stable".
  await page.locator('.sidebar a[href="/mandates"]').first().dispatchEvent('click');
  await page.waitForURL(/\/mandates/);
  await page.locator('.sidebar a[href="/"]').first().dispatchEvent('click');
  await page.waitForURL((u) => new URL(u.toString()).pathname === '/');
  try {
    await page.getByText('Get started', { exact: true }).or(page.getByText('Needs your attention', { exact: true })).first().waitFor({ timeout: 20_000 });
  } catch (err) {
    throw new Error(`dashboard did not settle at ${page.url()}:\n${(await page.locator('body').innerText()).slice(0, 1500)}\n${err}`);
  }
}

async function connectAgent(name: string): Promise<Client> {
  const c = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await c.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  return c;
}

describe.skipIf(!available)('first-run card (real AS + gateway UI + simulation mode + browser)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    browser = await chromium.launch({ headless: true });
    const profiles = localProfilesForAs(PROFILES_DIR);
    await pm.startSP(AS_PORT, { cwd: profiles.cwd, env: profiles.env });
    user = await sp.register('First Run E2E', `first-run-${Date.now()}@test.local`);
    groupId = await sp.getPersonalGroupId(user.apiKey);
    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    expect((await cp.login(user.apiKey)).status).toBe(200);

    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${CP_URL}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(user.apiKey);
    await page.locator('button:has-text("Sign In")').click();
    await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 45_000 });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('1. nothing done: step 1 open, with the MCP server\'s real address in the sentence to copy', async () => {
    await dashboard();
    await page.getByText('Get started', { exact: true }).waitFor({ timeout: 10_000 });
    await page.locator('text=Ask your AI to connect to Suveren').waitFor();
    const body = await page.locator('body').innerText();
    expect(body).toContain(`Please connect to the Suveren gateway: MCP server at http://localhost:${MCP_PORT}/mcp`);
    expect(body).not.toMatch(/localhost:7430|localhost:3430/);
    // The stats grid and "Needs your attention" wait until the card is gone.
    expect(body).not.toContain('Needs your attention');
    await shot('1-nothing-done');

    // Phone width: the open step fits without sideways scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await dashboard();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await shot('1-phone');
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  it('2. an AI connects: step 1 done with its name; step 2 opens the Delegation mandate directly', async () => {
    const agent = await connectAgent('E2E Agent');
    await agent.close();
    await dashboard();
    await page.locator('text=E2E Agent connected').waitFor({ timeout: 15_000 });
    const button = page.locator('a:has-text("Give the Delegation mandate")');
    await button.waitFor();
    expect(await button.getAttribute('href')).toMatch(/\/mandates\?new=1&profile=/);
    await shot('2-ai-connected');

    await button.click();
    await page.waitForURL(/\/mandates/, { timeout: 15_000 });
    await page.locator('text=Delegation').first().waitFor({ timeout: 15_000 });
    // Straight into the Delegation mandate, not the grid of every connector.
    expect(await page.locator('body').innerText()).not.toMatch(/Choose what to authorize|Pick a system/i);
    await shot('2b-delegation-opened');
  });

  it('3. Delegation given: step 3 open with the sentence to say to the AI', async () => {
    const bounds = { profile: DELEGATION, read_access: 'unlimited', brief_daily_max: 5, mandate_daily_max: 30 };
    const boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max']);
    const contextHash = computeContextHash({}, []);
    const gate = { intent: 'E2E: let my AI set itself up.' };
    const att = await sp.submitAttestation(user.apiKey, {
      profile_id: DELEGATION, group_id: groupId, bounds, bounds_hash: boundsHash, context_hash: contextHash,
      domain: 'owner', did: user.user.did, commitment_mode: 'review',
      gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ g: 1 }),
    });
    await mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: {} }, DELEGATION, gate);
    await dashboard();
    await page.locator('text=Delegation mandate given').waitFor({ timeout: 15_000 });
    await page.locator('text=How do I start with Suveren?').first().waitFor();
    await shot('3-delegation-given');
  });

  it('4. the AI proposes: all three done, and the card gives way to the normal dashboard', async () => {
    await new Promise((r) => setTimeout(r, 1_500));
    const agent = await connectAgent('E2E Agent');
    const r = await agent.callTool({
      name: 'setup__create_mandate',
      arguments: {
        profile: 'customers', mode: 'automatic', title: 'CRM setup',
        intent: 'Load the test data into the CRM.',
        limits: { read_access: 'none', export_access: 'none', write_daily_max: 0, delete_daily_max: 0, setup_daily_max: 2 },
        scope: { contact_type: 'customer' },
      },
    });
    await agent.close();
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    await dashboard();
    await page.locator('text=Needs your attention').waitFor({ timeout: 20_000 });
    await shot('4-card-gone');
    // The card's own title (exact match — "Getting started" elsewhere is not the card).
    expect(await page.getByText('Get started', { exact: true }).count()).toBe(0);
    // …and the live-mode guide does not take its place in simulation mode.
    expect(await page.getByText('Get Started', { exact: true }).count()).toBe(0);
    expect(await page.locator('body').innerText()).not.toMatch(/of 4 complete/);
  });
});
