/**
 * DL7 (suveren-as docs/work-plan.md "Added 2026-10-10 — Delegation outside
 * simulation mode"): the AI proposes mandates and its agent brief on a gateway
 * that is NOT in simulation mode — bounded by delegation 0.4's scope.
 *
 * Real stack: Authority Server, the whole gateway (control plane + MCP server)
 * WITHOUT simulation mode, the shipped profiles incl. delegation 0.4, a real
 * browser for the approval card.
 *
 * What must hold:
 * - create_mandate / set_agent_brief are offered; get_guide (test-data guides)
 *   is not usable; the internal preview tools are never offered to the AI;
 * - a proposal inside the Delegation scope becomes a proposal, its card shows
 *   "what you would sign" read by the gateway, and approval creates exactly it;
 * - a profile outside the scope, a mode outside the scope, and Delegation itself
 *   are refused before any proposal — and recorded under Blocked;
 * - a brief proposal's card shows the change against the current brief.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { chromium, type Browser } from '@playwright/test';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { ControlPlaneClient, newSecret, startControlPlane, startMcpServer, textOf, PROFILES_DIR, type StackOptions } from '../src/helpers/gateway-stack.js';
import { profileHashFor } from '../src/helpers/profiles.js';

const AS_PORT = 19830;
const CP_PORT = 19831;
const MCP_PORT = 19832;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const P = 'github.com/humanagencyprotocol/hap-profiles';
const DELEGATION = `${P}/delegation@0.4`;
const available = existsSync(join(PROFILES_DIR, 'delegation', '0.4.profile.json'));

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-dl-'));
// NOT simulation mode — the whole point.
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL,
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

let anna: { apiKey: string; user: { id: string; did: string } };
let agent: Client;
let browser: Browser;

const SALES_LIMITS = {
  read_access: 'unlimited', value_max: 1000, discount_max: 5, order_value_daily_max: 5000,
  quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0,
};

async function as(method: string, path: string, apiKey: string, body?: unknown) {
  const res = await fetch(`${AS_URL}${path}`, {
    method, headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

async function pending(): Promise<Array<{ id: string; tool: string; status: string }>> {
  return ((await as('GET', '/api/proposals?domain=owner', anna.apiKey)).body.proposals ?? [])
    .filter((p: { status: string }) => p.status === 'pending');
}

async function gatewayMandates(): Promise<Record<string, string>> {
  const res = await fetch(`http://localhost:${MCP_PORT}/internal/gate-content`, { headers: { 'X-Internal-Secret': stack.secret } });
  const entries = ((await res.json()) as { entries?: Array<{ authorizationId: string; profileId: string }> }).entries ?? [];
  return Object.fromEntries(entries.map((e) => [e.authorizationId, e.profileId]));
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await agent.callTool({ name: tool, arguments: args });
  return { denied: r.isError === true, text: textOf(r) };
}

async function denials(): Promise<Array<{ tool: string; kind?: string; detail: string }>> {
  const res = await cp.authed(anna.apiKey, 'GET', '/denials');
  return ((await res.json()) as { records?: Array<{ tool: string; kind?: string; detail: string }> }).records ?? [];
}

async function previewOf(proposalId: string) {
  const res = await cp.authed(anna.apiKey, 'GET', `/proposal-status/${proposalId}/preview`);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

/** The approvals page in a real browser, signed in; the first card's preview text. */
async function cardText(): Promise<{ status: string | null; text: string; hasEdit: boolean }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${CP_URL}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(anna.apiKey);
    await page.locator('button:has-text("Sign In")').click();
    await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 45_000 });
    await page.locator('.sidebar a[href="/approvals"]').click();
    await page.waitForURL('**/approvals');
    const box = page.locator('[data-testid="approval-preview"]').first();
    await box.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="approval-preview"]')?.getAttribute('data-preview-status') !== 'loading', null, { timeout: 20_000 });
    const text = await box.innerText();
    if (process.env.HAP_E2E_SHOW_CARD) console.error('[DL E2E] card:\n' + text);
    return { status: await box.getAttribute('data-preview-status'), text, hasEdit: (await page.locator('[data-testid="edit-before-signing"]').count()) > 0 };
  } finally {
    await page.close();
  }
}

describe.skipIf(!available)('delegation outside simulation mode: bounded by the Delegation scope (real stack)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    await pm.startSP(AS_PORT);
    anna = await sp.register('Anna DL', `anna-dl-${Date.now()}@test.local`);

    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    const login = await cp.login(anna.apiKey);
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    // Anna's Delegation 0.4 mandate: may propose Sales mandates, review only.
    const groupId = await sp.getPersonalGroupId(anna.apiKey);
    const bounds = { profile: DELEGATION, read_access: 'unlimited', brief_daily_max: 5, mandate_daily_max: 5 };
    const keys = ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max'];
    const scope = { allowed_profiles: 'sales', allowed_modes: 'review' };
    const boundsHash = computeBoundsHash(bounds, keys);
    const contextHash = computeScopeHash(scope, ['allowed_profiles', 'allowed_modes']);
    const gate = { intent: 'E2E: the AI may propose Sales mandates in review mode, on real systems.' };
    const att = await sp.submitMandate(anna.apiKey, {
      profile_id: DELEGATION, profile_hash: profileHashFor(DELEGATION, PROFILES_DIR), group_id: groupId, bounds,
      bounds_hash: boundsHash, scope_hash: contextHash, domain: 'owner', did: anna.user.did, commitment_mode: 'review',
      gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ m: 'delegation-0.4' }),
    });
    await mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: scope }, DELEGATION, gate);

    await new Promise((r) => setTimeout(r, 1_500));
    agent = new Client({ name: 'setup-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (agent) await agent.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('offers create_mandate and set_agent_brief; never the internal preview tools', async () => {
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toContain('setup__create_mandate');
    expect(names).toContain('setup__set_agent_brief');
    expect(names.some((n) => /describe_(mandate|brief)_proposal/.test(n))).toBe(false);
  });

  it('the test-data guides stay simulation-only', async () => {
    const r = await call('setup__get_guide', {});
    expect(r.denied).toBe(true);
  });

  it('a Charge mandate is outside the Delegation scope: refused, no proposal, recorded under Blocked', async () => {
    const r = await call('setup__create_mandate', {
      profile: 'charge', limits: { read_access: 'none' }, intent: 'Why — test.', mode: 'review',
    });
    expect(r.denied, r.text).toBe(true);
    expect(await pending()).toHaveLength(0);
    expect((await denials()).some((d) => d.tool === 'setup__create_mandate')).toBe(true);
  });

  it('an automatic Sales mandate is outside the allowed modes: refused, no proposal', async () => {
    const r = await call('setup__create_mandate', {
      profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — test.', mode: 'automatic',
    });
    expect(r.denied, r.text).toBe(true);
    expect(await pending()).toHaveLength(0);
  });

  it('Delegation itself can never be proposed', async () => {
    const r = await call('setup__create_mandate', {
      profile: 'delegation', limits: { read_access: 'unlimited', brief_daily_max: 5, mandate_daily_max: 5 },
      scope: { allowed_profiles: 'sales,charge', allowed_modes: 'review,automatic' }, intent: 'Why — widen.', mode: 'review',
    });
    expect(r.denied, r.text).toBe(true);
    expect(await pending()).toHaveLength(0);
  });

  let proposalId = '';

  it('a Sales review mandate inside the scope becomes a proposal; its preview is what would be signed', async () => {
    const r = await call('setup__create_mandate', {
      profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, mode: 'review', duration_hours: 720,
      title: 'Innendienst Angebote', intent: 'Why — answer quote requests the same day.',
    });
    expect(r.denied, r.text).toBe(false);
    expect(r.text).toMatch(/Awaiting commitment/);
    const [p] = await pending();
    expect(p.tool).toBe('setup__create_mandate');
    proposalId = p.id;

    const { status, body } = await previewOf(proposalId);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe('ok');
    const s = body.body.structured;
    expect(s.proposal).toMatch(/Sales/);
    expect(s.mode).toBe('review');
    expect(s.intent).toContain('same day');
    expect(Object.keys(s.limits).length).toBeGreaterThan(3);
    expect(JSON.stringify(s.limits)).toContain('1');
    expect(s.checks.length).toBeGreaterThan(0);
  }, 60_000);

  it('in the browser, the card shows what would be signed — and offers Edit before signing', async () => {
    const { status, text, hasEdit } = await cardText();
    expect(status).toBe('ok');
    expect(text).toMatch(/Sales/);
    expect(text).toContain('same day');
    expect(text).toMatch(/Written by the AI/i);
    expect(hasEdit).toBe(true);
  }, 120_000);

  it('approval creates exactly the proposed Sales mandate', async () => {
    const before = new Set(Object.keys(await gatewayMandates()));
    const res = await as('POST', `/api/proposals/${proposalId}/resolve`, anna.apiKey, { action: 'commit', domain: 'owner' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    let created: string | undefined;
    const until = Date.now() + 25_000;
    while (!created && Date.now() < until) {
      created = Object.keys(await gatewayMandates()).find((id) => !before.has(id));
      if (!created) await new Promise((r) => setTimeout(r, 500));
    }
    expect(created, 'no mandate appeared after approval').toBeTruthy();
    const summary = await sp.getAuthorizationSummary(anna.apiKey, created!);
    expect(summary.body).toMatchObject({ profile_id: `${P}/sales@0.4`, commitment_mode: 'review' });
  }, 60_000);

  it('a brief proposal: the preview shows the change against the current brief', async () => {
    const r = await call('setup__set_agent_brief', { content: '# Brief\n\n- Answer the same day.\n- New: EUR prices for Germany.\n' });
    expect(r.denied, r.text).toBe(false);
    const p = (await pending()).find((x) => x.tool === 'setup__set_agent_brief');
    expect(p).toBeTruthy();
    const { body } = await previewOf(p!.id);
    expect(body.status).toBe('ok');
    expect(body.body.structured.change).toMatch(/^\+.*EUR prices for Germany/m);
    expect(body.body.outputSchema.properties.change.contentMediaType).toBe('text/x-diff');
  }, 60_000);
});
