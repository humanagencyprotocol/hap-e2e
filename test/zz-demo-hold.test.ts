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

const AS_PORT = 19800;
const CP_PORT = 19801;
const MCP_PORT = 19802;
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

describe('DEMO hold', () => {
  it('holds a fresh simulation gateway for a person to look at', async () => {
    const profiles = localProfilesForAs(PROFILES_DIR);
    await pm.startSP(AS_PORT, { cwd: profiles.cwd, env: profiles.env });
    const u = await sp.register('Andreas Demo', `demo-${Date.now()}@test.local`);
    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    (await import('node:fs')).writeFileSync('/Users/andreasschadauer/Development/HAP/temp/first-run-dashboard/DEMO.txt',
      `UI: ${CP_URL}\nAPI key: ${u.apiKey}\nMCP: http://localhost:${MCP_PORT}/mcp\n`);
    await new Promise((r) => setTimeout(r, 120 * 60_000));
    await pm.killAll();
  }, 125 * 60_000);
});
