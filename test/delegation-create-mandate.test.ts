/**
 * The AI proposes a mandate; a person approves; the gateway creates it — on the
 * real stack (simulation setup S8): real Authority Server, the whole gateway
 * (control plane + MCP server) in simulation mode, the shipped profiles.
 *
 * What must hold:
 * - what can never be created is refused at the call, before any proposal: a
 *   team where the person is not an approver, a limit the profile does not have;
 * - a valid call only becomes a proposal; nothing exists until a person approves;
 * - after approval the mandate exists on the AS under the person's account, with
 *   exactly the proposed limits, mode and title — and the gateway holds its intent;
 * - in a team, the intent is encrypted for the profile's approvers (each approver
 *   can fetch their copy from the AS) — the sign page silently skipped this before;
 * - a rejected proposal creates nothing;
 * - with the person's standing choice "always show my verified name", a mandate
 *   the AI proposed carries the verified name, and so do its tickets — the
 *   create path never sends disclose_identity (found 2026-10-06: 27 of 29
 *   tickets of a verified owner came out without a name).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { ControlPlaneClient, newSecret, startControlPlane, startMcpServer, textOf, PROFILES_DIR, type StackOptions } from '../src/helpers/gateway-stack.js';

const AS_PORT = 18500;
const CP_PORT = 18501;
const MCP_PORT = 18502;
const AS_URL = `http://localhost:${AS_PORT}`;
const P = 'github.com/humanagencyprotocol/hap-profiles';
const DELEGATION = `${P}/delegation@0.1`;
const available = existsSync(join(PROFILES_DIR, 'delegation', '0.1.profile.json'));

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-create-mandate-'));
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL,
  extraEnv: { SUVEREN_SIMULATION: '1', SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(`http://localhost:${CP_PORT}`);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

let anna: { apiKey: string; user: { id: string; did: string } };
let bernd: { apiKey: string; user: { id: string; did: string } };
let teamId: string;
let agent: Client;

const SALES_LIMITS = {
  read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000,
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
  return (await as('GET', '/api/proposals?domain=owner', anna.apiKey)).body.proposals ?? [];
}

/** Gate content the gateway holds, by authorization id → profile id. */
async function gatewayMandates(): Promise<Record<string, string>> {
  const res = await fetch(`http://localhost:${MCP_PORT}/internal/gate-content`, { headers: { 'X-Internal-Secret': stack.secret } });
  const entries = ((await res.json()) as { entries?: Array<{ authorizationId: string; profileId: string }> }).entries ?? [];
  return Object.fromEntries(entries.map((e) => [e.authorizationId, e.profileId]));
}

async function call(args: Record<string, unknown>) {
  const r = await agent.callTool({ name: 'setup__create_mandate', arguments: args });
  return { denied: r.isError === true, text: textOf(r) };
}

async function approveAndWait(proposalId: string, action: 'commit' | 'reject'): Promise<string | null> {
  const before = new Set(Object.keys(await gatewayMandates()));
  const r = await as('POST', `/api/proposals/${proposalId}/resolve`, anna.apiKey, { action, domain: 'owner' });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    const created = Object.keys(await gatewayMandates()).filter((id) => !before.has(id));
    if (created.length) return created[0];
    await new Promise((res) => setTimeout(res, 500));
    if (action === 'reject' && Date.now() > until - 15_000) break;
  }
  return null;
}

describe.skipIf(!available)('delegation: the AI proposes a mandate, a person approves, the gateway creates it (real stack)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(AS_PORT);
    anna = await sp.register('Anna CM', `anna-cm-${Date.now()}@test.local`);
    bernd = await sp.register('Bernd CM', `bernd-cm-${Date.now()}@test.local`);
    // Bernd's gateway would register his E2EE key at sign-in; a random X25519-sized key stands in.
    await as('PUT', '/api/users/me/pubkey', bernd.apiKey, { pubkey: randomBytes(32).toString('base64') });

    const team = await sp.createGroup(anna.apiKey, 'Sales Vienna');
    teamId = team.group.id;
    await sp.joinGroup(bernd.apiKey, team.inviteCode ?? team.group.inviteCode);
    await sp.setProfileConfig(anna.apiKey, teamId, `${P}/sales@0.3`, { approvers: [anna.user.id, bernd.user.id] });
    await sp.setProfileConfig(anna.apiKey, teamId, `${P}/customers@0.8`, { approvers: [bernd.user.id] });

    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    const login = await cp.login(anna.apiKey); // registers Anna's E2EE key, hands the session to the gateway
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    // Anna's delegation mandate (review only), personal workspace.
    const groupId = await sp.getPersonalGroupId(anna.apiKey);
    const bounds = { profile: DELEGATION, read_access: 'unlimited', brief_daily_max: 0, mandate_daily_max: 5 };
    const keys = ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max'];
    const boundsHash = computeBoundsHash(bounds, keys);
    const contextHash = computeScopeHash({}, []);
    const gate = { intent: 'E2E: let the AI propose mandates for the test.' };
    const att = await sp.submitMandate(anna.apiKey, {
      profile_id: DELEGATION, group_id: groupId, bounds, bounds_hash: boundsHash, context_hash: contextHash,
      domain: 'owner', did: anna.user.did, commitment_mode: 'review',
      gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ m: 'delegation' }),
    });
    await mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: {} }, DELEGATION, gate);

    await new Promise((r) => setTimeout(r, 1_500));
    agent = new Client({ name: 'setup-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (agent) await agent.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('the tool is listed to the setup agent', async () => {
    expect((await agent.listTools()).tools.map((t) => t.name)).toContain('setup__create_mandate');
  });

  it('a team where the person is not an approver: refused at the call — no proposal', async () => {
    const r = await call({ team: 'Sales Vienna', profile: 'customers', limits: { read_access: 'unlimited', export_access: 'none', write_daily_max: 5, delete_daily_max: 0, setup_daily_max: 0 }, scope: { contact_type: 'customer' }, intent: 'Why — test.', mode: 'automatic' });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/approvers in "Sales Vienna"/);
    expect(await pending()).toHaveLength(0);
  });

  it('a limit the profile does not have: refused at the call — no proposal', async () => {
    const r = await call({ profile: 'sales', limits: { ...SALES_LIMITS, bogus_max: 1 }, scope: { currency: 'EUR' }, intent: 'Why — test.', mode: 'automatic' });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/bogus_max/);
    expect(await pending()).toHaveLength(0);
  });

  it('personal: a proposal first; after approval the mandate exists on the AS with exactly the proposed terms', async () => {
    const r = await call({ profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — quotes wait two days.\n\nGoal — same-day quotes.', mode: 'automatic', duration_hours: 24, title: 'Same-day quotes (AI)' });
    expect(r.denied, r.text).toBe(false);
    expect(r.text).toMatch(/Awaiting commitment/);
    const [p] = await pending();
    expect(p).toMatchObject({ tool: 'setup__create_mandate', status: 'pending' });

    const id = await approveAndWait(p.id, 'commit');
    expect(id, 'no mandate appeared on the gateway after approval').toBeTruthy();
    expect((await gatewayMandates())[id!]).toBe(`${P}/sales@0.3`);

    const summary = await sp.getAuthorizationSummary(anna.apiKey, id!);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    // Under Anna's account, with exactly the proposed limits (the AS recomputes
    // the bounds hash from what it signed) and mode.
    const SALES_KEYS = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max', 'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'];
    expect(summary.body).toMatchObject({
      created_by: anna.user.id,
      profile_id: `${P}/sales@0.3`,
      commitment_mode: 'automatic',
      bounds_hash: computeBoundsHash({ profile: `${P}/sales@0.3`, ...SALES_LIMITS }, SALES_KEYS),
    });
  }, 60_000);

  it('team: after approval the intent is encrypted for every approver of the profile', async () => {
    const r = await call({ team: 'Sales Vienna', profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — team quotes.', mode: 'review', duration_hours: 24, title: 'Team quotes (AI)' });
    expect(r.denied, r.text).toBe(false);
    const p = (await pending()).find((x) => x.status === 'pending')!;
    const id = await approveAndWait(p.id, 'commit');
    expect(id).toBeTruthy();

    for (const who of [anna, bernd]) {
      const intent = await as('GET', `/api/authorizations/${id}/intent`, who.apiKey);
      expect(intent.status, `${who.user.id}: ${JSON.stringify(intent.body)}`).toBe(200);
      expect(intent.body.approversFrozen).toEqual(expect.arrayContaining([anna.user.id, bernd.user.id]));
      expect(intent.body.encryptedKey).toMatchObject({ ct: expect.any(String), enc: expect.any(String) });
    }
  }, 60_000);

  it('a rejected proposal creates nothing', async () => {
    const r = await call({ profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — rejected.', mode: 'automatic', title: 'Rejected (AI)' });
    expect(r.text).toMatch(/Awaiting commitment/);
    const p = (await pending()).find((x) => x.status === 'pending')!;
    expect(await approveAndWait(p.id, 'reject')).toBeNull();
  }, 60_000);

  it('standing "always show my name": an AI-created mandate and its tickets carry the verified name', async () => {
    const verify = await fetch(`${AS_URL}/api/admin/users/${encodeURIComponent(anna.user.id)}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'local-dev-key' },
      body: JSON.stringify({ name: 'Anna Verified' }),
    });
    expect(verify.status).toBe(200);
    const on = await as('PUT', '/api/users/me/identity-disclosure', anna.apiKey, { always: true });
    expect(on.body).toMatchObject({ always: true, verified: true, name: 'Anna Verified' });

    const r = await call({ profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — named quotes.', mode: 'automatic', duration_hours: 24, title: 'Named quotes (AI)' });
    expect(r.denied, r.text).toBe(false);
    const p = (await pending()).find((x) => x.status === 'pending')!;
    const id = await approveAndWait(p.id, 'commit');
    expect(id).toBeTruthy();

    const t = await sp.postTicket(anna.apiKey, {
      authorizationId: id!, profileId: `${P}/sales@0.3`, action: 'erp__create_quote', actionType: 'quote',
      executionContext: { action_type: 'quote', value: 100, discount_pct: 0, currency: 'EUR' },
    });
    expect(t.status, JSON.stringify(t.body)).toBeLessThan(300);
    const receipt = (t.body.receipt ?? t.body) as Record<string, any>;
    expect(receipt.identity, JSON.stringify(t.body)).toMatchObject({ name: 'Anna Verified' });
  }, 60_000);
});
