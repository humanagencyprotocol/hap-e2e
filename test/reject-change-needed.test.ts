/**
 * RJ6 (suveren-as docs/work-plan.md "Added 2026-10-11 — Reject or ask for a
 * change"): the person rejects or asks for a change on the approval card, and
 * the AI learns which — through the real stack (AS + whole gateway + records
 * connector under a review mandate + a real browser).
 *
 * What must hold:
 * - Reject (one click, no note) → the AI is told REJECTED … must not be retried;
 * - Change needed with a note → the card shows CHANGE NEEDED + the note as
 *   stored; the AI's NEXT, unrelated tool call carries a one-time line with the
 *   note; a second call does not repeat it; check-pending-commitments says
 *   SENT BACK FOR A CHANGE, may propose again;
 * - replaced (Edit before signing) → REPLACED, not "must not be retried".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const AS_PORT = 19860;
const CP_PORT = 19861;
const MCP_PORT = 19862;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const COMMITMENTS = join(GW_DIR, 'apps', 'mcp-server', 'src', 'tools', 'commitments.ts');
/** Only meaningful against a gateway that has RJ (the new outcome texts). */
const available = existsSync(RECORDS_DIST) && existsSync(COMMITMENTS)
  && readFileSync(COMMITMENTS, 'utf8').includes('SENT BACK FOR A CHANGE');

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-rj-'));
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL,
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

let user: { apiKey: string; user: { id: string; did: string } };
let agent: Client;
let browser: Browser;
const NOTE = 'Shorter title, please — max five words.';

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await agent.callTool({ name, arguments: args });
  return { denied: r.isError === true, text: textOf(r) };
}

async function propose(title: string): Promise<string> {
  const r = await call('records__create_record', { type: 'note', title, content: `content of ${title}` });
  expect(r.text, r.text).toMatch(/Awaiting commitment/);
  return r.text.match(/Proposal ID: ([a-f0-9-]+)/)![1];
}

async function as(method: string, path: string, body?: unknown) {
  const res = await fetch(`${AS_URL}${path}`, {
    method, headers: { 'X-API-Key': user.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

/** Signed in, on /approvals, the card for one proposal (by its id in the footer). */
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

/** Decided proposals leave "Awaiting me"; their stored outcome is listed under All → All. */
async function showDecided(page: Page): Promise<void> {
  await page.locator('button.nav-tab', { hasText: /^All$/ }).click();
  await page.locator('button.filter-chip', { hasText: /^All$/ }).click();
}

function cardOf(page: Page, proposalId: string) {
  return page.locator('.card', { hasText: proposalId }).first();
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

describe.skipIf(!available)('reject or ask for a change — the AI learns which (real stack + browser)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    await pm.startSP(AS_PORT);
    user = await sp.register('RJ E2E', `rj-${Date.now()}@test.local`);
    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    expect((await cp.login(user.apiKey)).status).toBe(200);
    await mcpInternal.addIntegration(RECORDS_INTEGRATION as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration('records');
    const g = await grantRecordsMandate(sp, { apiKey: user.apiKey, did: user.user.did, intent: 'E2E: records under review.', mode: 'review' });
    await mcpInternal.pushGateContent({ authorizationId: g.authorizationId, boundsHash: g.boundsHash, contextHash: g.scopeHash, context: {} }, RECORDS_PROFILE_ID, g.gateContent);
    await new Promise((r) => setTimeout(r, 1_500));
    agent = new Client({ name: 'rj-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (agent) await agent.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('Reject (one click, no note): the AI is told REJECTED — must not be retried', async () => {
    const id = await propose(`RJ reject ${Date.now()}`);
    const page = await approvalsPage();
    try {
      const card = cardOf(page, id);
      await card.locator('[data-testid="btn-reject"]').click();
      // Backend truth first: the click must have reached the server before the
      // All view is opened (in CI the view could load before the rejection was stored).
      await until(async () => ((await as('GET', `/api/proposals/${id}`)).body.proposal?.status === 'rejected' ? true : undefined), 'rejection stored on the server');
      await showDecided(page);
      // Backend truth: the after-state comes from the server.
      try {
        await until(async () => ((await page.locator('[data-testid="outcome-kind"]').allInnerTexts()).some((t) => /REJECTED/i.test(t)) ? true : undefined), 'rejected shown');
      } catch (err) {
        {
          console.error('[RJ DEBUG] AS proposal:', JSON.stringify((await as('GET', `/api/proposals/${id}`)).body).slice(0, 600));
          console.error('[RJ DEBUG] page:', (await page.locator('main, body').first().innerText()).slice(0, 2500));
        }
        throw err;
      }
    } finally { await page.close(); }
    const r = await call('check-pending-commitments', { proposal_id: id });
    expect(r.text).toMatch(/was REJECTED/);
    expect(r.text).toMatch(/must not be retried/);
    expect(r.text).not.toMatch(/SENT BACK/);
  }, 120_000);

  it('Change needed with a note: the card shows it, the AI\'s next unrelated call carries it once', async () => {
    const id = await propose(`RJ change ${Date.now()}`);
    const page = await approvalsPage();
    try {
      const card = cardOf(page, id);
      expect(await card.locator('[data-testid="change-note"]').count()).toBe(0); // only after the click
      await card.locator('[data-testid="btn-change-needed"]').click();
      await card.locator('[data-testid="change-note"]').fill(NOTE);
      await card.locator('[data-testid="btn-send-back"]').click();
      await showDecided(page);
      const shownNote = await until(async () => {
        const n = await page.locator('[data-testid="outcome-note"]').allInnerTexts();
        return n.find((t) => t.includes('max five words'));
      }, 'note shown from the server');
      expect(shownNote).toContain(NOTE);
    } finally { await page.close(); }

    const stored = await as('GET', `/api/proposals/${id}`);
    expect(stored.body.proposal.rejectedBy).toMatchObject({ outcome: 'change_needed', note: NOTE });

    // The AI learns it on its next call to ANY tool — here an unrelated one.
    const first = await until(async () => {
      const r = await call('list-authorizations');
      return r.text.includes(id) ? r.text : undefined;
    }, 'outcome line on the next tool reply', 45_000);
    expect(first).toMatch(/\[Suveren gateway\] Since your last call/);
    expect(first).toMatch(/SENT BACK FOR A CHANGE/);
    expect(first).toContain(NOTE);
    // Delivered once.
    const second = await call('list-authorizations');
    expect(second.text).not.toContain(id);

    const r = await call('check-pending-commitments', { proposal_id: id });
    expect(r.text).toMatch(/SENT BACK FOR A CHANGE/);
    expect(r.text).toContain(NOTE);
    expect(r.text).toMatch(/propose again/);
    expect(r.text).not.toMatch(/must not be retried/);
  }, 150_000);

  it('replaced (Edit before signing): REPLACED — not "must not be retried"', async () => {
    const id = await propose(`RJ replaced ${Date.now()}`);
    const res = await as('POST', `/api/proposals/${id}/resolve`, { action: 'reject', domain: 'owner', outcome: 'replaced' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const r = await call('check-pending-commitments', { proposal_id: id });
    expect(r.text).toMatch(/was REPLACED/);
    expect(r.text).not.toMatch(/must not be retried/);
  }, 60_000);

  it('the AS refuses a note on a plain reject, and a change without a note', async () => {
    const id = await propose(`RJ invalid ${Date.now()}`);
    const a = await as('POST', `/api/proposals/${id}/resolve`, { action: 'reject', domain: 'owner', outcome: 'rejected', note: 'x' });
    expect(a.status).toBe(400);
    const b = await as('POST', `/api/proposals/${id}/resolve`, { action: 'reject', domain: 'owner', outcome: 'change_needed' });
    expect(b.status).toBe(400);
    const c = await as('POST', `/api/proposals/${id}/resolve`, { action: 'reject', domain: 'owner', outcome: 'change_needed', note: 'y'.repeat(501) });
    expect(c.status).toBe(400);
  }, 60_000);
});
