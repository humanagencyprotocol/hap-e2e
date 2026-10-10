/**
 * An approval card for a tool WITHOUT a declared preview must show what will
 * be sent — open, first — not fold it under "Details". Found 2026-10-10 on a
 * real Gmail send: the email text, the very thing being approved, was hidden.
 *
 * Real stack: Authority Server, the whole gateway, the records connector (no
 * preview declared) under a review mandate, a real browser on /approvals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { chromium, type Browser } from '@playwright/test';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  ControlPlaneClient, GW_DIR, RECORDS_DIST, RECORDS_INTEGRATION, RECORDS_PROFILE_ID,
  grantRecordsMandate, newSecret, startControlPlane, startMcpServer, type StackOptions,
} from '../src/helpers/gateway-stack.js';

const AS_PORT = 19840;
const CP_PORT = 19841;
const MCP_PORT = 19842;
const CP_URL = `http://localhost:${CP_PORT}`;
/** Only meaningful against a gateway that has the fix. */
const VIEW = join(GW_DIR, 'apps', 'ui', 'src', 'lib', 'approval-preview-view.ts');
const available = existsSync(RECORDS_DIST) && existsSync(VIEW)
  && readFileSync(VIEW, 'utf8').includes('boundValuesOpen');

const pm = new ProcessManager();
const sp = new SPClient(`http://localhost:${AS_PORT}`);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-card-open-'));
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: `http://localhost:${AS_PORT}`,
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

let user: { apiKey: string; user: { id: string; did: string } };
let agent: Client;
let browser: Browser;
const TITLE = `Quarterly note ${Date.now()}`;
const CONTENT = 'The exact text a person must see before approving.';

describe.skipIf(!available)('a card without a declared preview shows what will be sent, open (real stack + browser)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    await pm.startSP(AS_PORT);
    user = await sp.register('Card Open', `card-open-${Date.now()}@test.local`);
    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    expect((await cp.login(user.apiKey)).status).toBe(200);
    await mcpInternal.addIntegration(RECORDS_INTEGRATION as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration('records');
    const g = await grantRecordsMandate(sp, { apiKey: user.apiKey, did: user.user.did, intent: 'E2E: records under review.', mode: 'review' });
    await mcpInternal.pushGateContent({ authorizationId: g.authorizationId, boundsHash: g.boundsHash, contextHash: g.scopeHash, context: {} }, RECORDS_PROFILE_ID, g.gateContent);
    await new Promise((r) => setTimeout(r, 1_500));
    agent = new Client({ name: 'card-open-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (agent) await agent.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('the proposal is created under review', async () => {
    const r = await agent.callTool({ name: 'records__create_record', arguments: { type: 'note', title: TITLE, content: CONTENT } });
    const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(/Awaiting commitment/);
  }, 60_000);

  it('in the browser, the card shows the content open — not folded under Details', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${CP_URL}/login`, { waitUntil: 'networkidle' });
      await page.locator('input[type="password"]').fill(user.apiKey);
      await page.locator('button:has-text("Sign In")').click();
      await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 45_000 });
      await page.locator('.sidebar a[href="/approvals"]').click();
      await page.waitForURL('**/approvals');
      const open = page.locator('[data-testid="bound-values-open"]').first();
      await open.waitFor({ timeout: 20_000 });
      // Visible without any click: the title and the exact content.
      expect(await open.getByText(TITLE).isVisible()).toBe(true);
      expect(await open.getByText(CONTENT).isVisible()).toBe(true);
      expect(await open.innerText()).toMatch(/What will be sent/i);
      // And nothing is left behind a "Details" fold on this card.
      expect(await page.locator('details.proposal-args-fold').count()).toBe(0);
      expect(await page.locator('[data-testid="approval-preview"]').first().getAttribute('data-preview-status')).toBe('none');
    } finally {
      await page.close();
    }
  }, 120_000);
});
