/**
 * AU3 for the CRM: the approval card shows the contact as the CRM holds it,
 * bound to the revision the request names — on the real stack (Authority
 * Server + the gateway's control plane AND MCP server + the published
 * crm connector), in a real browser.
 *
 *   - archiving a customer waits for approval; the card shows the CRM's own
 *     read of that contact (name, company, revision 1) — the AI is not involved;
 *   - the contact changes while the card waits (revision 2) → the card says a
 *     newer revision exists;
 *   - approved anyway → the CRM refuses the outdated revision, nothing is archived.
 *
 * Not here (unit-tested in the gateway repo, crm-preview.test.ts): the
 * version-less previews of log_activity / create_deal / create_task, and a
 * task without a contact showing no preview.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { chromium, type Browser } from '@playwright/test';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { profileHashFor } from '../src/helpers/profiles.js';
import {
  ControlPlaneClient, MANIFESTS_DIR, PROFILES_DIR, newSecret, startControlPlane, startMcpServer, type StackOptions,
} from '../src/helpers/gateway-stack.js';

const AS_PORT = 19810;
const CP_PORT = 19811;
const MCP_PORT = 19812;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const MCP_URL = `http://localhost:${MCP_PORT}`;

const MANIFEST = join(MANIFESTS_DIR, 'crm.json');
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
/** Only meaningful against a gateway whose crm manifest declares the preview. */
const available = !!manifest?.toolGating?.overrides?.delete_contact?.preview;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/customers@0.10';
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'];
const SCOPE = { contact_type: 'customer' };

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-crm-preview-'));
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
      console.error(`[CRM preview E2E] no preview box on ${page.url()}:\n`, (await page.locator('body').innerText()).slice(0, 2000));
      throw err;
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="approval-preview"]');
      return !!el && el.getAttribute('data-preview-status') !== 'loading';
    }, null, { timeout: 20_000 });
    const out = { status: await box.getAttribute('data-preview-status'), text: await box.innerText() };
    if (process.env.HAP_E2E_SHOW_CARD) console.error('[CRM preview E2E] card:\n' + out.text);
    return out;
  } finally {
    await page.close();
  }
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await agent.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
}

async function grant(mode: 'automatic' | 'review', bounds: Record<string, string | number>, intent: string) {
  const full = { profile: PROFILE_ID, ...bounds };
  const boundsHash = computeBoundsHash(full, BOUNDS_KEY_ORDER);
  const scopeHash = computeScopeHash(SCOPE, ['contact_type']);
  const gate = { intent };
  const att = await sp.submitMandate(user.apiKey, {
    profile_id: PROFILE_ID, profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR), group_id: groupId,
    bounds: full, bounds_hash: boundsHash, scope_hash: scopeHash,
    domain: 'owner', did: user.user.did, commitment_mode: mode,
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ intent }),
  });
  await mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash: scopeHash, context: SCOPE }, PROFILE_ID, gate);
}

async function preview(proposalId: string) {
  const res = await cp.authed(user.apiKey, 'GET', `/proposal-status/${proposalId}/preview`);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

describe.skipIf(!available)('AU3 for the CRM: the approval card shows the contact, bound to a revision (real AS + gateway CP + MCP + crm-mcp)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    // A person's browser: the gateway refuses automation-flagged browsers at sign-in.
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    await pm.startSP(AS_PORT);
    user = await sp.register('CRM Preview Test', `crm-preview-${Date.now()}@test.local`);
    groupId = await sp.getPersonalGroupId(user.apiKey);

    await startControlPlane(pm, stack, 'cp');
    await startMcpServer(pm, stack, 'mcp');
    const login = await cp.login(user.apiKey);
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    // The crm integration exactly as its shipped manifest declares it (incl. `preview`).
    await mcpInternal.addIntegration({
      id: 'crm', name: manifest.name, command: manifest.mcp.command, args: manifest.mcp.args, envKeys: {},
      profile: manifest.profile, enabled: true, toolGating: manifest.toolGating, npmPackage: manifest.npmPackage,
    } as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration('crm');

    // Customers only. Changes run automatically; archiving waits for approval.
    await grant('automatic', { read_access: 'unlimited', export_access: 'none', write_daily_max: 20, delete_daily_max: 0, setup_daily_max: 0 }, 'CRM preview e2e: change customer records automatically.');
    await grant('review', { read_access: 'unlimited', export_access: 'none', write_daily_max: 0, delete_daily_max: 5, setup_daily_max: 0 }, 'CRM preview e2e: archive customers only after my approval.');

    await new Promise((r) => setTimeout(r, 2_000));
    agent = new Client({ name: 'crm-preview-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`${MCP_URL}/sse`)));
  }, 400_000);

  afterAll(async () => {
    if (agent) { try { await agent.close(); } catch { /* ignore */ } }
    if (browser) await browser.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  let contactId: string;
  let proposalId: string;

  it('a customer is created (revision 1) and archiving it is requested under review — nothing archived yet', async () => {
    const c = await call('crm__create_contact', { name: 'Maria Huber', type: 'customer', company: 'Huber Agrar' });
    expect(c.denied, c.text).toBe(false);
    contactId = c.json?.id ?? c.text.match(/"id":\s*"([^"]+)"/)?.[1];
    expect(contactId, c.text).toBeTruthy();

    const d = await call('crm__delete_contact', { id: contactId, revision: 1, contact_type: 'customer' });
    expect(d.denied, d.text).toBeFalsy();
    expect(d.text).toContain('Awaiting commitment');
    proposalId = d.text.match(/Proposal ID: ([a-f0-9-]+)/)![1];
  }, 60_000);

  it('the preview is the CRM\'s own read of that contact at revision 1, not stale', async () => {
    const { status, body } = await preview(proposalId);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.tool).toBe('get_contact');
    expect(body.body.structured).toMatchObject({ id: contactId, name: 'Maria Huber', company: 'Huber Agrar', archived: false, revision: 1 });
    expect(body.version).toMatchObject({ field: 'revision', approved: 1, current: 1, stale: false });
  }, 30_000);

  it('in the browser, the card shows name, company and the revision being approved', async () => {
    const { status, text } = await approvalPreviewText();
    expect(status).toBe('ok');
    expect(text).toContain('Name');
    expect(text).toContain('Maria Huber');
    expect(text).toContain('Company');
    expect(text).toContain('Huber Agrar');
    expect(text).toMatch(/You approve revision 1/i);
  }, 120_000);

  it('the contact changes while the card waits — the card says a newer revision exists', async () => {
    const u = await call('crm__update_contact', { id: contactId, revision: 1, contact_type: 'customer', company: 'Huber Agrar GmbH' });
    expect(u.denied, u.text).toBe(false);

    const { body } = await preview(proposalId);
    expect(body.body.structured.revision).toBe(1);
    expect(body.version).toMatchObject({ approved: 1, current: 2, stale: true });
    expect(body.version.currentBody.structured.company).toBe('Huber Agrar GmbH');

    const { status, text } = await approvalPreviewText();
    expect(status).toBe('stale');
    expect(text).toMatch(/newer revision exists/i);
    expect(text).toContain('Huber Agrar GmbH');
  }, 120_000);

  it('approved anyway: the CRM refuses the outdated revision and nothing is archived', async () => {
    const r = await fetch(`${AS_URL}/api/proposals/${proposalId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': user.apiKey },
      body: JSON.stringify({ action: 'commit', domain: 'owner' }),
    });
    expect(r.ok).toBe(true);

    const result = await call('check-pending-commitments', { proposal_id: proposalId });
    expect(result.text).toMatch(/refused to run it — nothing was done/);

    const got = await call('crm__get_contact', { id: contactId });
    expect(got.json).toMatchObject({ archived: false, revision: 2 });
  }, 90_000);
});
