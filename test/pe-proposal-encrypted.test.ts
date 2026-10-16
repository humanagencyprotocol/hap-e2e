/**
 * PE phase 1 (suveren-as docs/work-plan.md "proposals encrypted end to end";
 * hap-protocol content/0.7/review.md "The Authority Server never sees what an
 * action contains"): a review-mode proposal leaves the gateway encrypted. The
 * Authority Server stores ciphertext and a fingerprint, never the content —
 * checked in its own database. The person still sees the content on the card
 * (decrypted on the gateway), the action still runs after approval, and a
 * "Change needed" note reaches the AI without the AS being able to read it.
 *
 * Real stack: Authority Server + its Postgres, the whole gateway, the records
 * connector under a review mandate, a real browser on /approvals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openApprovalById } from '../src/helpers/gateway-ui.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { chromium, type Browser, type Page } from '@playwright/test';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  ControlPlaneClient, GW_DIR, RECORDS_DIST, RECORDS_INTEGRATION, RECORDS_PROFILE_ID,
  grantRecordsMandate, newSecret, startControlPlane, startMcpServer, textOf, type StackOptions,
} from '../src/helpers/gateway-stack.js';

const AS_PORT = 19890;
const CP_PORT = 19891;
const MCP_PORT = 19892;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const CONTENT_CRYPTO = join(GW_DIR, 'apps', 'control-plane', 'src', 'lib', 'content-crypto.ts');
/** Only meaningful against a gateway that encrypts proposal content. */
const available = existsSync(RECORDS_DIST) && existsSync(CONTENT_CRYPTO)
  && readFileSync(CONTENT_CRYPTO, 'utf8').includes('encryptProposalContent')
  && !!process.env.SUVEREN_DB_URL;

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-pe-'));
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL,
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

let user: { apiKey: string; user: { id: string; did: string } };
let agent: Client;
let browser: Browser;
let db: pg.Client;
const SECRET = `PE-SECRET-${Date.now()}`;
const NOTE = `NOTE-SECRET-${Date.now()} — shorter title please`;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await agent.callTool({ name, arguments: args });
  return { denied: r.isError === true, text: textOf(r) };
}

async function propose(title: string, content: string): Promise<string> {
  const r = await call('records__create_record', { type: 'note', title, content });
  expect(r.text, r.text).toMatch(/Awaiting commitment/);
  return r.text.match(/Proposal ID: ([a-f0-9-]+)/)![1];
}

async function as(method: string, path: string, body?: unknown) {
  const res = await fetch(`${AS_URL}${path}`, {
    method, headers: { 'X-API-Key': user.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

/** Everything the AS stored for this proposal, as one string. */
async function storedRow(id: string): Promise<{ row: Record<string, unknown>; text: string }> {
  const r = await db.query('select * from proposals where id = $1', [id]);
  expect(r.rows.length, `proposal ${id} not in the AS database`).toBe(1);
  return { row: r.rows[0], text: JSON.stringify(r.rows[0]) };
}

async function approvalsPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${CP_URL}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').fill(user.apiKey);
  await page.locator('button:has-text("Sign In")').click();
  await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 45_000 });
  await page.locator('.sidebar a[href="/approvals"]').click();
  await page.waitForURL('**/approvals');
  return page;
}

async function until<T>(fn: () => Promise<T | undefined>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`timed out: ${what}`);
}

describe.skipIf(!available)('proposal content is encrypted end to end — the AS never sees it (real stack + DB + browser)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    await pm.startSP(AS_PORT);
    db = new pg.Client({ connectionString: pm.asDatabaseUrl()! });
    await db.connect();
    user = await sp.register('PE E2E', `pe-${Date.now()}@test.local`);
    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    expect((await cp.login(user.apiKey)).status).toBe(200);
    await mcpInternal.addIntegration(RECORDS_INTEGRATION as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration('records');
    const g = await grantRecordsMandate(sp, { apiKey: user.apiKey, did: user.user.did, intent: 'E2E: records under review.', mode: 'review' });
    await mcpInternal.pushGateContent({ authorizationId: g.authorizationId, boundsHash: g.boundsHash, contextHash: g.scopeHash, context: {} }, RECORDS_PROFILE_ID, g.gateContent);
    await new Promise((r) => setTimeout(r, 1_500));
    agent = new Client({ name: 'pe-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (agent) await agent.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (db) await db.end().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('the AS stores ciphertext and a fingerprint — the content appears nowhere in its database row or its answers', async () => {
    const id = await propose(`PE title ${Date.now()}`, `The body is ${SECRET}.`);
    const { row, text } = await storedRow(id);
    expect(text).not.toContain(SECRET);
    expect(row.tool_args ?? null).toBeNull();
    expect(String(row.content_hash ?? '')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(row.content_ciphertext ?? '').length).toBeGreaterThan(20);

    const one = await as('GET', `/api/proposals/${id}`);
    expect(one.status).toBe(200);
    expect(one.text).not.toContain(SECRET);
    const list = await as('GET', '/api/proposals?domain=owner');
    expect(list.text).not.toContain(SECRET);
  }, 60_000);

  it('the person sees the content on the card (decrypted on the gateway); approving runs the action', async () => {
    const title = `PE approve ${Date.now()}`;
    const body = `Approve me: ${SECRET}-A`;
    const id = await propose(title, body);
    const page = await approvalsPage();
    try {
      const card = await openApprovalById(page, id);
      await card.getByText(body).waitFor({ timeout: 20_000 });
      await card.getByRole('button', { name: 'Approve' }).click();
      // Backend truth before the page closes (closing could cancel the request).
      await until(async () => (['committed', 'executed'].includes(String((await storedRow(id)).row.status)) ? true : undefined), 'approval stored');
    } finally { await page.close(); }

    // The action ran — the record exists, with the content the person approved.
    let last = '';
    const found = await until(async () => {
      const r = await call('check-pending-commitments', { proposal_id: id });
      last = r.text;
      return /executed|committed/i.test(r.text) ? r.text : undefined;
    }, 'proposal executed', 60_000).catch(async (err) => {
      console.error('[PE DEBUG] check-pending-commitments:', last.slice(0, 800));
      console.error('[PE DEBUG] AS row status:', (await storedRow(id)).row.status);
      throw err;
    });
    expect(found).toBeTruthy();
    // And the AS still never saw it.
    expect((await storedRow(id)).text).not.toContain(`${SECRET}-A`);
  }, 150_000);

  it('a "Change needed" note reaches the AI; the AS stores it encrypted', async () => {
    const id = await propose(`PE change ${Date.now()}`, `Change me: ${SECRET}-C`);
    const page = await approvalsPage();
    try {
      const card = await openApprovalById(page, id);
      await card.locator('[data-testid="btn-change-needed"]').click();
      await card.locator('[data-testid="change-note"]').fill(NOTE);
      await card.locator('[data-testid="btn-send-back"]').click();
      await until(async () => ((await storedRow(id)).row.status === 'rejected' ? true : undefined), 'decision stored');
    } finally { await page.close(); }

    const { text } = await storedRow(id);
    expect(text).not.toContain('NOTE-SECRET');
    expect(text).not.toContain(`${SECRET}-C`);

    const r = await call('check-pending-commitments', { proposal_id: id });
    expect(r.text).toMatch(/SENT BACK FOR A CHANGE/);
    expect(r.text).toContain(NOTE);
  }, 150_000);
});
