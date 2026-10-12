/**
 * The AI proposes a mandate; a person approves; the gateway creates it — on the
 * real stack (simulation setup S8): real Authority Server, the whole gateway
 * (control plane + MCP server) in simulation mode, the shipped profiles.
 *
 * Two people, two gateways: an account is EITHER Personal OR in one team
 * (suveren-as WS0–WS2) — while it is in a team, Personal is paused and a new
 * Personal mandate is refused (403 PERSONAL_PAUSED). So the Personal cases run
 * for Anna, who is in no team, on her own gateway; the team cases run for
 * Bernd, a member of "Sales Vienna", on a second gateway with his own data dir,
 * ports and agent client.
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
import { profileHashFor } from '../src/helpers/profiles.js';

// 18540–18549 belong to this file.
const AS_PORT = 18540;
const PERSONAL_PORTS = { cp: 18541, mcp: 18542 };
const TEAM_PORTS = { cp: 18543, mcp: 18544 };
const AS_URL = `http://localhost:${AS_PORT}`;
const P = 'github.com/humanagencyprotocol/hap-profiles';
const DELEGATION = `${P}/delegation@0.3`;
const available = existsSync(join(PROFILES_DIR, 'delegation', '0.3.profile.json'));

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);

type Account = { apiKey: string; user: { id: string; did: string } };

/** One person's gateway: its own data dir, ports, internal secret and agent client. */
interface Gateway {
  name: string;
  stack: StackOptions;
  cp: ControlPlaneClient;
  mcpInternal: GatewayClient;
  agent?: Client;
  /** The person signed in to this gateway. */
  owner?: Account;
  /** The commitment domain the owner approves in: 'owner' in Personal, their user id in a team. */
  domain?: string;
}

function newGateway(name: string, ports: { cp: number; mcp: number }): Gateway {
  const stack: StackOptions = {
    dataDir: mkdtempSync(join(tmpdir(), `hap-e2e-create-mandate-${name}-`)), ports, secret: newSecret(), asUrl: AS_URL,
    extraEnv: { SUVEREN_SIMULATION: '1', SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
  };
  return { name, stack, cp: new ControlPlaneClient(`http://localhost:${ports.cp}`), mcpInternal: new GatewayClient(`http://localhost:${ports.mcp}`, stack.secret) };
}

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

async function pending(gw: Gateway): Promise<Array<{ id: string; tool: string; status: string }>> {
  return (await as('GET', `/api/proposals?domain=${encodeURIComponent(gw.domain!)}`, gw.owner!.apiKey)).body.proposals ?? [];
}

/** Gate content the gateway holds, by authorization id → profile id. */
async function gatewayMandates(gw: Gateway): Promise<Record<string, string>> {
  const res = await fetch(`http://localhost:${gw.stack.ports.mcp}/internal/gate-content`, { headers: { 'X-Internal-Secret': gw.stack.secret } });
  const entries = ((await res.json()) as { entries?: Array<{ authorizationId: string; profileId: string }> }).entries ?? [];
  return Object.fromEntries(entries.map((e) => [e.authorizationId, e.profileId]));
}

async function call(gw: Gateway, args: Record<string, unknown>) {
  const r = await gw.agent!.callTool({ name: 'setup__create_mandate', arguments: args });
  return { denied: r.isError === true, text: textOf(r) };
}

async function approveAndWait(gw: Gateway, proposalId: string, action: 'commit' | 'reject'): Promise<string | null> {
  const before = new Set(Object.keys(await gatewayMandates(gw)));
  const r = await as('POST', `/api/proposals/${proposalId}/resolve`, gw.owner!.apiKey, { action, domain: gw.domain });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    const created = Object.keys(await gatewayMandates(gw)).filter((id) => !before.has(id));
    if (created.length) return created[0];
    await new Promise((res) => setTimeout(res, 500));
    if (action === 'reject' && Date.now() > until - 15_000) break;
  }
  return null;
}

/**
 * Start the gateway, sign `owner` in (registers their E2EE key, hands the
 * session to the gateway), give them a delegation mandate (review only) in
 * `groupId`, and connect the setup agent.
 */
async function startGatewayWithDelegation(gw: Gateway, owner: Account, groupId: string, domain: string): Promise<void> {
  gw.owner = owner;
  gw.domain = domain;
  await startControlPlane(pm, gw.stack, `cp-${gw.name}`);
  await startMcpServer(pm, gw.stack, `mcp-${gw.name}`);
  const login = await gw.cp.login(owner.apiKey);
  expect(login.status, JSON.stringify(login.body)).toBe(200);

  const bounds = { profile: DELEGATION, read_access: 'unlimited', brief_daily_max: 0, mandate_daily_max: 5 };
  const keys = ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max'];
  const boundsHash = computeBoundsHash(bounds, keys);
  const contextHash = computeScopeHash({}, []);
  const gate = { intent: 'E2E: let the AI propose mandates for the test.' };
  const att = await sp.submitMandate(owner.apiKey, {
    profile_id: DELEGATION, profile_hash: profileHashFor(DELEGATION, PROFILES_DIR), group_id: groupId, bounds, bounds_hash: boundsHash, scope_hash: contextHash,
    domain, did: owner.user.did, commitment_mode: 'review',
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ m: 'delegation' }),
  });
  await gw.mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: {} }, DELEGATION, gate);

  await new Promise((r) => setTimeout(r, 1_500));
  gw.agent = new Client({ name: 'setup-agent', version: '1.0.0' }, { capabilities: {} });
  await gw.agent.connect(new SSEClientTransport(new URL(`http://localhost:${gw.stack.ports.mcp}/sse`)));
}

async function stopGateway(gw: Gateway): Promise<void> {
  if (gw.agent) await gw.agent.close().catch(() => {});
  await pm.stopProcess(`mcp-${gw.name}`).catch(() => {});
  await pm.stopProcess(`cp-${gw.name}`).catch(() => {});
  rmSync(gw.stack.dataDir, { recursive: true, force: true });
}

describe.skipIf(!available)('delegation: the AI proposes a mandate, a person approves, the gateway creates it (real stack)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(AS_PORT);
  }, 300_000);

  afterAll(async () => {
    await pm.killAll();
  }, 30_000);

  // ── Personal: Anna is in no team; her delegation mandate is in Personal ────
  describe('personal', () => {
    const gw = newGateway('personal', PERSONAL_PORTS);
    let anna: Account;

    beforeAll(async () => {
      anna = await sp.register('Anna CM', `anna-cm-${Date.now()}@test.local`);
      await startGatewayWithDelegation(gw, anna, await sp.getPersonalGroupId(anna.apiKey), 'owner');
    }, 120_000);

    afterAll(async () => { await stopGateway(gw); }, 30_000);

    it('the tool is listed to the setup agent', async () => {
      expect((await gw.agent!.listTools()).tools.map((t) => t.name)).toContain('setup__create_mandate');
    });

    it('a limit the profile does not have: refused at the call — no proposal', async () => {
      const r = await call(gw, { profile: 'sales', limits: { ...SALES_LIMITS, bogus_max: 1 }, scope: { currency: 'EUR' }, intent: 'Why — test.', mode: 'automatic' });
      expect(r.denied).toBe(true);
      expect(r.text).toMatch(/bogus_max/);
      expect(await pending(gw)).toHaveLength(0);
    });

    it('personal: a proposal first; after approval the mandate exists on the AS with exactly the proposed terms', async () => {
      const r = await call(gw, { profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — quotes wait two days.\n\nGoal — same-day quotes.', mode: 'automatic', duration_hours: 24, title: 'Same-day quotes (AI)' });
      expect(r.denied, r.text).toBe(false);
      expect(r.text).toMatch(/Awaiting commitment/);
      const [p] = await pending(gw);
      expect(p).toMatchObject({ tool: 'setup__create_mandate', status: 'pending' });

      const id = await approveAndWait(gw, p.id, 'commit');
      expect(id, 'no mandate appeared on the gateway after approval').toBeTruthy();
      expect((await gatewayMandates(gw))[id!]).toBe(`${P}/sales@0.4`);

      const summary = await sp.getAuthorizationSummary(anna.apiKey, id!);
      expect(summary.status, JSON.stringify(summary.body)).toBe(200);
      // Under Anna's account, with exactly the proposed limits (the AS recomputes
      // the bounds hash from what it signed) and mode.
      const SALES_KEYS = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max', 'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'];
      expect(summary.body).toMatchObject({
        created_by: anna.user.id,
        profile_id: `${P}/sales@0.4`,
        commitment_mode: 'automatic',
        bounds_hash: computeBoundsHash({ profile: `${P}/sales@0.4`, ...SALES_LIMITS }, SALES_KEYS),
      });
    }, 60_000);

    it('a rejected proposal creates nothing', async () => {
      const r = await call(gw, { profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — rejected.', mode: 'automatic', title: 'Rejected (AI)' });
      expect(r.text).toMatch(/Awaiting commitment/);
      const p = (await pending(gw)).find((x) => x.status === 'pending')!;
      expect(await approveAndWait(gw, p.id, 'reject')).toBeNull();
    }, 60_000);

    it('standing "always show my name": an AI-created mandate and its tickets carry the verified name', async () => {
      const verify = await fetch(`${AS_URL}/api/admin/users/${encodeURIComponent(anna.user.id)}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'local-dev-key' },
        body: JSON.stringify({ name: 'Anna Verified' }),
      });
      expect(verify.status).toBe(200);
      const on = await as('PUT', '/api/users/me/identity-disclosure', anna.apiKey, { always: true });
      expect(on.body).toMatchObject({ always: true, verified: true, name: 'Anna Verified' });

      const r = await call(gw, { profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — named quotes.', mode: 'automatic', duration_hours: 24, title: 'Named quotes (AI)' });
      expect(r.denied, r.text).toBe(false);
      const p = (await pending(gw)).find((x) => x.status === 'pending')!;
      const id = await approveAndWait(gw, p.id, 'commit');
      expect(id).toBeTruthy();

      const t = await sp.postTicket(anna.apiKey, {
        authorizationId: id!, profileId: `${P}/sales@0.4`, action: 'erp__create_quote', actionType: 'quote',
        executionContext: { action_type: 'quote', value: 100, discount_pct: 0, currency: 'EUR' },
      });
      expect(t.status, JSON.stringify(t.body)).toBeLessThan(300);
      const receipt = (t.body.ticket ?? t.body) as Record<string, any>;
      // `identity` is AS-internal display data, never part of the SIGNED ticket
      // (ticket-signed-subset.ts) -- the raw POST /api/as/ticket response no
      // longer carries it (v0.7: it used to, only because the response was the
      // whole storage row, which also leaked path/authorizationId outside the
      // signature -- see the sibling ticket-holder-verification fix). The
      // verified name surfaces on the public ticket view instead.
      expect(receipt.identity).toBeUndefined();
      const pub = await fetch(`${AS_URL}/api/as/public-ticket/${receipt.id}`);
      expect(pub.status).toBe(200);
      const pubView = await pub.json() as { identity?: { name: string } };
      expect(pubView.identity).toMatchObject({ name: 'Anna Verified' });
    }, 60_000);
  });

  // ── Team: Tom created "Sales Vienna" (admin); Bernd joined; Bernd's delegation
  //    mandate is a TEAM mandate, on his own gateway ──────────────────────────
  describe('team', () => {
    const gw = newGateway('team', TEAM_PORTS);
    let tom: Account;
    let bernd: Account;

    beforeAll(async () => {
      tom = await sp.register('Tom CM', `tom-cm-${Date.now()}@test.local`);
      bernd = await sp.register('Bernd CM', `bernd-cm-${Date.now()}@test.local`);
      // Tom's gateway would register his E2EE key at sign-in; a random X25519-sized key stands in.
      await as('PUT', '/api/users/me/pubkey', tom.apiKey, { pubkey: randomBytes(32).toString('base64') });

      const team = await sp.createGroup(tom.apiKey, 'Sales Vienna');
      const teamId = team.group.id;
      // Joining is a request; Tom (admin) confirms it.
      await sp.joinGroup(bernd.apiKey, team.inviteCode ?? team.group.inviteCode, tom.apiKey);
      // In a team the AS takes an attest only from a configured approver of the
      // profile — Bernd signs his own delegation mandate, so he is one.
      await sp.setProfileConfig(tom.apiKey, teamId, DELEGATION, { approvers: [bernd.user.id] });
      await sp.setProfileConfig(tom.apiKey, teamId, `${P}/sales@0.4`, { approvers: [tom.user.id, bernd.user.id] });
      await sp.setProfileConfig(tom.apiKey, teamId, `${P}/customers@0.9`, { approvers: [tom.user.id] });

      // Team mandate: group_id = the team, domain = the member's user id.
      await startGatewayWithDelegation(gw, bernd, teamId, bernd.user.id);
    }, 120_000);

    afterAll(async () => { await stopGateway(gw); }, 30_000);

    it('a team where the person is not an approver: refused at the call — no proposal', async () => {
      const r = await call(gw, { team: 'Sales Vienna', profile: 'customers', limits: { read_access: 'unlimited', export_access: 'none', write_daily_max: 5, delete_daily_max: 0, setup_daily_max: 0 }, scope: { contact_type: 'customer' }, intent: 'Why — test.', mode: 'automatic' });
      expect(r.denied).toBe(true);
      expect(r.text).toMatch(/approvers in "Sales Vienna"/);
      expect(await pending(gw)).toHaveLength(0);
    });

    it('team: after approval the intent is encrypted for every approver of the profile', async () => {
      const r = await call(gw, { team: 'Sales Vienna', profile: 'sales', limits: SALES_LIMITS, scope: { currency: 'EUR' }, intent: 'Why — team quotes.', mode: 'review', duration_hours: 24, title: 'Team quotes (AI)' });
      expect(r.denied, r.text).toBe(false);
      const p = (await pending(gw)).find((x) => x.status === 'pending')!;
      expect(p, 'no pending proposal').toBeTruthy();
      const id = await approveAndWait(gw, p.id, 'commit');
      expect(id).toBeTruthy();

      for (const who of [tom, bernd]) {
        const intent = await as('GET', `/api/authorizations/${id}/intent`, who.apiKey);
        expect(intent.status, `${who.user.id}: ${JSON.stringify(intent.body)}`).toBe(200);
        expect(intent.body.approversFrozen).toEqual(expect.arrayContaining([tom.user.id, bernd.user.id]));
        expect(intent.body.encryptedKey).toMatchObject({ ct: expect.any(String), enc: expect.any(String) });
      }
    }, 60_000);
  });
});
