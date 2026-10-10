/**
 * AU3 + AU4 (suveren-as/docs/work-plan.md "Added 2026-10-09"): the approval
 * card shows what will happen, read from the system before it runs, bound to
 * a document version — on the real stack (Authority Server + the gateway's
 * control plane AND MCP server + the published erp connector).
 *
 * What this proves, end to end, through the gateway UI's own HTTP surface:
 *   - GET /proposal-status/:id/preview answers with the ERP's own read
 *     (get_quote, declared in the erp manifest as `preview`) for exactly the
 *     revision the proposal binds — the AI is not involved;
 *   - the quote changes while the card waits → the preview says a newer
 *     revision exists and shows both revisions;
 *   - the person approves the stale revision anyway → the ERP refuses it,
 *     nothing is sent, and GET /proposal-status/:id/outcome says "refused"
 *     with the ERP's own text (not the AS's "executed");
 *   - the preview route is behind the gateway's sign-in, and the MCP
 *     server's /internal/preview behind the internal secret.
 *
 * Not here (unit-tested in the gateway repo): the "none" / "unavailable"
 * fallbacks and the re-read fallback for systems without versions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { chromium, type Browser } from '@playwright/test';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';
import {
  ControlPlaneClient, MANIFESTS_DIR, PROFILES_DIR, newSecret, startControlPlane, startMcpServer, type StackOptions,
} from '../src/helpers/gateway-stack.js';

const AS_PORT = 19800;
const CP_PORT = 19801;
const MCP_PORT = 19802;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const MCP_URL = `http://localhost:${MCP_PORT}`;

const MANIFEST = join(MANIFESTS_DIR, 'erp.json');
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
/** Only meaningful against a gateway whose erp manifest declares the preview. */
const available = !!manifest?.toolGating?.overrides?.send_quote?.preview;

/** AU6 (ticket view) ships after AU3 — its browser check runs only against a gateway that has it. */
const hasTicketView = existsSync(join(MANIFESTS_DIR, '..', '..', 'apps', 'ui', 'src', 'components', 'TicketWhatWasDone.tsx'));

const PROFILE_ID = PROFILE_V07.sales;
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'];
const CONTEXT = { currency: 'EUR' };

const COMPANY_DATA = {
  name: 'E2E Preview Industrial', currency: 'EUR',
  items: [
    { id: 'item-1', sku: 'WIDGET-100', name: 'Widget 100', unit: 'pcs', list_price: 25, stock: 500 },
    { id: 'item-2', sku: 'WIDGET-200', name: 'Widget 200 Pro', unit: 'pcs', list_price: 45, stock: 300 },
  ],
  customers: [
    { id: 'cust-4', name: 'Meridian Industrial Ltd', email: 'payables@meridianind.example', country: 'IE', credit_limit: 100000, open_balance: 0, payment_terms: 'NET60' },
  ],
};
// 45 * (1 - REV2_DISCOUNT/100) = 25: revision 2 has the same net total, different item.
const REV2_DISCOUNT = ((45 - 25) / 45) * 100;

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-au3-'));
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-au3-files-'));
const secret = newSecret();
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret, asUrl: AS_URL,
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(MCP_URL, secret);

let user: { apiKey: string; user: { id: string; did: string } };
let groupId: string;
let agent: Client;
let browser: Browser;
let quoteNumber: string;

/** The approvals page in a real browser, signed in as the person — the card the human actually sees. */
async function approvalPreviewText(): Promise<{ status: string | null; text: string }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${CP_URL}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(user.apiKey);
    await page.locator('button:has-text("Sign In")').click();
    await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 45_000 });
    // In-app navigation: the API key lives in the page's memory, a full page load drops it.
    await page.locator('.sidebar a[href="/approvals"]').click();
    await page.waitForURL('**/approvals');
    const box = page.locator('[data-testid="approval-preview"]').first();
    try {
      await box.waitFor({ timeout: 20_000 });
    } catch (err) {
      // Show what the person actually sees, so a missing card is diagnosable.
      const shot = join(work, 'approvals.png');
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      console.error(`[AU3 E2E] no preview box on ${page.url()} (screenshot ${shot}):\n`, (await page.locator('body').innerText()).slice(0, 2000));
      throw err;
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="approval-preview"]');
      return !!el && el.getAttribute('data-preview-status') !== 'loading';
    }, null, { timeout: 20_000 });
    const out = { status: await box.getAttribute('data-preview-status'), text: await box.innerText() };
    if (process.env.HAP_E2E_SHOW_CARD) console.error('[AU3 E2E] card:\n' + out.text);
    return out;
  } finally {
    await page.close();
  }
}

function erpCli(extraEnv: Record<string, string>, ...args: string[]): string {
  const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, HAP_DATA_DIR: dataDir, ...extraEnv };
  delete env.DATABASE_URL;
  return execFileSync('node', [bin, ...args], { env, encoding: 'utf8' });
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await agent.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

async function grant(bounds: Record<string, string | number>, mode: 'automatic' | 'review', intent: string) {
  const full = { profile: PROFILE_ID, ...bounds };
  const boundsHash = computeBoundsHash(full, BOUNDS_KEY_ORDER);
  const contextHash = computeScopeHash(CONTEXT, ['currency']);
  const gate = { intent };
  const att = await sp.submitMandate(user.apiKey, {
    profile_id: PROFILE_ID, profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR), group_id: groupId,
    bounds: full, bounds_hash: boundsHash, scope_hash: contextHash,
    domain: 'owner', did: user.user.did, commitment_mode: mode,
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ intent }),
  });
  await mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: CONTEXT }, PROFILE_ID, gate);
}

async function preview(proposalId: string) {
  const res = await cp.authed(user.apiKey, 'GET', `/proposal-status/${proposalId}/preview`);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

describe.skipIf(!available)('AU3/AU4: the approval preview is read from the system, bound to a revision (real AS + gateway CP + MCP + erp-mcp)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    // A person's browser: the gateway refuses automation-flagged browsers at sign-in.
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    await pm.startSP(AS_PORT);
    user = await sp.register('AU3 Preview Test', `au3-preview-${Date.now()}@test.local`);
    groupId = await sp.getPersonalGroupId(user.apiKey);

    await startControlPlane(pm, stack, 'cp');
    await startMcpServer(pm, stack, 'mcp');
    const login = await cp.login(user.apiKey);
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    // The erp integration exactly as its shipped manifest declares it (incl. `preview`).
    await mcpInternal.addIntegration({
      id: 'erp', name: manifest.name, command: manifest.mcp.command, args: manifest.mcp.args, envKeys: {},
      profile: manifest.profile, enabled: true, toolGating: manifest.toolGating, npmPackage: manifest.npmPackage,
    } as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration('erp');

    // Seed the (empty) ERP database the running connector uses.
    const company = join(work, 'company.json');
    writeFileSync(company, JSON.stringify(COMPANY_DATA));
    erpCli({ ERP_COMPANY_FILE: company }, 'export');

    // A: automatic, quotes only. B: review, sends only.
    await grant({ read_access: 'unlimited', value_max: 1000, discount_max: 50, order_value_daily_max: 5000,
      quote_daily_max: 10, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 0 }, 'automatic', 'AU3 e2e: quotes automatically.');
    await grant({ read_access: 'unlimited', value_max: 1000, discount_max: 50, order_value_daily_max: 5000,
      quote_daily_max: 0, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0 }, 'review', 'AU3 e2e: review sends.');

    await new Promise((r) => setTimeout(r, 2_000));
    agent = new Client({ name: 'au3-preview-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`${MCP_URL}/sse`)));
  }, 400_000);

  afterAll(async () => {
    if (agent) { try { await agent.close(); } catch { /* ignore */ } }
    if (browser) await browser.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
    if (!process.env.HAP_E2E_KEEP_FILES) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  let quoteId: string;
  let proposalId: string;

  it('a quote is created (revision 1) and its send is requested under review — nothing sent yet', async () => {
    const q = await call('erp__create_quote', {
      customer_id: 'cust-4', lines: [{ item_id: 'item-1', qty: 1 }], discount_pct: 0, value: 25, currency: 'EUR',
    });
    expect(q.denied, q.text).toBe(false);
    expect(q.json.revision).toBe(1);
    quoteId = q.json.id;
    quoteNumber = q.json.number;

    const s = await call('erp__send_quote', { id: quoteId, revision: 1, value: 25, discount_pct: 0, currency: 'EUR' });
    expect(s.denied, s.text).toBeFalsy();
    expect(s.text).toContain('Awaiting commitment');
    proposalId = s.text.match(/Proposal ID: ([a-f0-9-]+)/)![1];
  }, 60_000);

  it('the card preview is the ERP\'s own read of exactly revision 1 — with its output schema, not stale', async () => {
    const { status, body } = await preview(proposalId);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.integration).toBe('erp');
    expect(body.tool).toBe('get_quote');
    expect(body.readAt).toEqual(expect.any(Number));
    const q = body.body.structured;
    expect(q.id).toBe(quoteId);
    expect(q.revision).toBe(1);
    expect(q.customer_id).toBe('cust-4');
    expect(JSON.stringify(q)).toContain('item-1');
    expect(body.body.outputSchema?.type).toBe('object');
    expect(body.version).toMatchObject({ field: 'revision', approved: 1, current: 1, stale: false });
    expect(body.version.currentBody).toBeUndefined();
  }, 30_000);

  it('in the browser, the review card the person sees shows the ERP preview of revision 1', async () => {
    const { status, text } = await approvalPreviewText();
    expect(status).toBe('ok');
    expect(text).toContain('Quote number');
    expect(text).toContain(quoteNumber);
    expect(text).toMatch(/You approve revision 1/i);
    expect(text).toContain('Lines');
    expect(text).toContain('item-1');
    expect(text).toContain('Net total');
    expect(text).toMatch(/AI is not involved/);
  }, 120_000);

  it('the quote changes while the card waits — the preview says a newer revision exists and shows both', async () => {
    const u = await call('erp__update_quote', {
      id: quoteId, lines: [{ item_id: 'item-2', qty: 1 }], discount_pct: REV2_DISCOUNT, value: 25, currency: 'EUR',
    });
    expect(u.denied, u.text).toBe(false);
    expect(u.json.revision).toBe(2);

    const { body } = await preview(proposalId);
    expect(body.status).toBe('ok');
    // What the person would approve: still revision 1, item-1.
    expect(body.body.structured.revision).toBe(1);
    expect(JSON.stringify(body.body.structured)).toContain('item-1');
    expect(body.version).toMatchObject({ field: 'revision', approved: 1, current: 2, stale: true });
    expect(body.version.currentBody.structured.revision).toBe(2);
    expect(JSON.stringify(body.version.currentBody.structured)).toContain('item-2');
  }, 60_000);

  it('in the browser, the card now warns that a newer revision exists', async () => {
    const { status, text } = await approvalPreviewText();
    expect(status).toBe('stale');
    expect(text).toMatch(/newer revision exists/i);
    // The comparison shows what changed: the line item, in both revisions.
    expect(text).toContain('item-1');
    expect(text).toContain('item-2');
  }, 120_000);

  it('approved anyway: the ERP refuses the stale revision, nothing is sent, and the outcome says so', async () => {
    const r = await fetch(`${AS_URL}/api/proposals/${proposalId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': user.apiKey },
      body: JSON.stringify({ action: 'commit', domain: 'owner' }),
    });
    expect(r.ok).toBe(true);

    const result = await call('check-pending-commitments', { proposal_id: proposalId });
    expect(result.text).not.toContain('committed and executed');
    expect(result.text).toMatch(/refused to run it — nothing was done/);

    const quote = await call('erp__get_quote', { id: quoteId });
    expect(quote.json.status).toBe('draft');
    expect(quote.json.revision).toBe(2);

    const res = await cp.authed(user.apiKey, 'GET', `/proposal-status/${proposalId}/outcome`);
    expect(res.status).toBe(200);
    const outcome = await res.json() as any;
    expect(outcome.state).toBe('failed');
    expect(outcome.outcome).toBe('refused');
    expect(outcome.detail).toContain('is at revision 2');
    expect(outcome.detail.length).toBeLessThanOrEqual(500);
  }, 90_000);

  it('the preview is behind the gateway sign-in, and /internal/preview behind the internal secret', async () => {
    const anon = await fetch(`${CP_URL}/proposal-status/${proposalId}/preview`);
    expect(anon.status).toBe(401);

    const noSecret = await fetch(`${MCP_URL}/internal/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, tool: 'erp__send_quote', toolArgs: { id: quoteId, revision: 1 } }),
    });
    expect([401, 403]).toContain(noSecret.status);
  }, 30_000);

  it('the internal route calls only the declared preview tool — never an arbitrary one', async () => {
    const res = await fetch(`${MCP_URL}/internal/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      // update_quote declares no preview: the route must not run anything for it.
      body: JSON.stringify({ proposalId: 'x', tool: 'erp__update_quote', toolArgs: { id: quoteId, lines: [], value: 0, discount_pct: 0, currency: 'EUR' } }),
    });
    const body = await res.json() as any;
    expect(body.status).toBe('none');
    const quote = await call('erp__get_quote', { id: quoteId });
    expect(quote.json.revision).toBe(2); // unchanged — nothing ran
  }, 30_000);

  it('the agent never sees the preview: no preview tool or text reaches the MCP client', async () => {
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => /preview/i.test(n))).toBe(false);
  }, 30_000);

  it.skipIf(!hasTicketView)('AU6: in the browser, the quote ticket shows what was done — the bound content, verified against the ticket', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${CP_URL}/login`, { waitUntil: 'networkidle' });
      await page.locator('input[type="password"]').fill(user.apiKey);
      await page.locator('button:has-text("Sign In")').click();
      await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 45_000 });
      await page.locator('.sidebar a[href="/tickets"]').click();
      await page.waitForURL('**/tickets');
      const boxes = page.locator('[data-testid="ticket-what-was-done"]');
      await boxes.first().waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ticket-what-was-done"]')]
        .every((el) => el.getAttribute('data-bound') !== 'loading'), null, { timeout: 20_000 });
      const states = await boxes.evaluateAll((els) => els.map((el) => ({ bound: el.getAttribute('data-bound'), text: (el as HTMLElement).innerText })));
      if (process.env.HAP_E2E_SHOW_CARD) console.error('[AU6 E2E] tickets:\n' + JSON.stringify(states, null, 1));
      // Every ticket of this run was issued here, so its content is on this device and must verify.
      expect(states.length).toBeGreaterThan(0);
      for (const st of states) expect(st.bound, st.text).toBe('verified');
      // The create_quote ticket shows what the AI actually sent: customer and line item.
      const quote = states.find((st) => st.text.includes('cust-4') && st.text.includes('item-1'));
      expect(quote, JSON.stringify(states)).toBeTruthy();
      expect(quote!.text).toMatch(/bound by hash/);
      // The Ed25519 signature check on each ticket card (issuer key archived at issuance).
      const feet = await page.locator('.receipt-foot').evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText));
      if (process.env.HAP_E2E_SHOW_CARD) console.error('[AU6 E2E] feet:\n' + JSON.stringify(feet, null, 1));
      expect(feet.length).toBeGreaterThan(0);
      for (const f of feet) expect(f, f).toContain('Verified on this device');
    } finally {
      await page.close();
    }
  }, 120_000);
});
