/**
 * CRM revisions on the real stack (CRM4 of the 2026-10-09 plan): real AS, the
 * gateway, the CRM connector with revisions (hap-crm-mcp feat/crm-revisions —
 * run with a local build via HAP_E2E_PREINSTALLED_INTEGRATIONS + SUVEREN_OFFLINE=1
 * until it is released).
 *
 * - "Customers only" holds: the contact type is declared per call, the gatekeeper
 *   checks it against the mandate's scope, the connector against the real record.
 * - The race: archiving a contact waits for approval; meanwhile the contact
 *   changes (revision 2); the person approves → the CRM refuses the outdated
 *   revision and nothing is archived.
 * - Archiving with the current revision works and destroys nothing: the
 *   contact's activities and deals survive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';

const SP_PORT = 17300;
const GW_PORT = 17330;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const PROFILE_ID = PROFILE_V07.customers;
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'];
const SCOPE_KEY_ORDER = ['contact_type'];
const SCOPE = { contact_type: 'customer' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let apiKey: string;
let groupId: string;
let did: string;
let agent: Client;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function grant(mode: 'automatic' | 'review', bounds: Record<string, string | number>, intent: string) {
  const full = { profile: PROFILE_ID, ...bounds };
  const boundsHash = computeBoundsHash(full, BOUNDS_KEY_ORDER);
  const scopeHash = computeScopeHash(SCOPE, SCOPE_KEY_ORDER);
  const gate = { intent };
  const att = await sp.submitMandate(apiKey, {
    profile_id: PROFILE_ID,
    profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR),
    group_id: groupId,
    bounds: full,
    bounds_hash: boundsHash,
    scope_hash: scopeHash,
    domain: 'owner',
    did,
    commitment_mode: mode,
    gate_content_hashes: hashGateContent(gate),
    execution_context_hash: hashExecutionContext({ mode }),
  });
  await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash: scopeHash, context: SCOPE }, PROFILE_ID, gate);
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await agent.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { error: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
}

async function commit(proposalId: string) {
  const res = await fetch(`${SP_URL}/api/proposals/${proposalId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ action: 'commit', domain: 'owner' }),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
}

/** Wait until the gateway's auto-execution has handled the committed proposal. */
async function waitHandled(proposalId: string): Promise<string> {
  let text = '';
  for (let i = 0; i < 15; i++) {
    await sleep(2_000);
    text = (await call('check-pending-commitments', { proposal_id: proposalId })).text;
    if (!/pending/i.test(text) || /executed|failed|refused|not found/i.test(text)) return text;
  }
  return text;
}

const proposalOf = (text: string) => text.match(/Proposal ID: ([a-f0-9]+)/)?.[1];

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  const reg = await sp.register('CRM Revisions E2E', `crm-rev-${Date.now()}@test.local`);
  apiKey = reg.apiKey;
  did = reg.user.did;
  groupId = await sp.getPersonalGroupId(apiKey);
  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: 'crm-revisions-e2e', apiKey });
  // Automatic for changes; review for archiving/restoring — both "customers only".
  await grant('automatic', { read_access: 'unlimited', export_access: 'none', write_daily_max: 20, delete_daily_max: 0, setup_daily_max: 0 }, 'E2E: change customer records automatically.');
  await grant('review', { read_access: 'unlimited', export_access: 'none', write_daily_max: 0, delete_daily_max: 5, setup_daily_max: 0 }, 'E2E: archive customer records only after my approval.');
  await gw.waitForIntegration('crm');
  await sleep(2_000);
  agent = new Client({ name: 'crm-revisions-e2e', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}, 300_000);

afterAll(async () => {
  if (agent) { try { await agent.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

let customerId: string;
let leadId: string;

describe('CRM revisions on the real stack', () => {
  it('the connector offers the new tools', async () => {
    const names = (await agent.listTools()).tools.map((t) => t.name);
    for (const t of ['crm__get_contact', 'crm__get_deal', 'crm__get_task', 'crm__restore_contact', 'crm__convert_contact']) expect(names).toContain(t);
  });

  it('creates a customer (revision 1) with an activity and a deal, and a lead', async () => {
    const c = await call('crm__create_contact', { name: 'Huber Agrar', type: 'customer', company: 'Huber Agrar' });
    expect(c.error, c.text).toBe(false);
    customerId = c.json?.id ?? c.text.match(/"id":\s*"([^"]+)"/)?.[1];
    expect(customerId, c.text).toBeTruthy();
    const got = await call('crm__get_contact', { id: customerId });
    expect(got.json?.revision ?? Number(got.text.match(/"revision":\s*(\d+)/)?.[1])).toBe(1);

    expect((await call('crm__log_activity', { contact_id: customerId, contact_type: 'customer', type: 'call', summary: 'Asked for a quote' })).error).toBe(false);
    expect((await call('crm__create_deal', { contact_id: customerId, contact_type: 'customer', title: 'Spare parts Q4', value: 900, currency: 'EUR' })).error).toBe(false);

    // A lead can be created only under a mandate whose scope includes "lead" — this one is customers only.
    const lead = await call('crm__create_contact', { name: 'Steiner Hof', type: 'lead' });
    expect(lead.error, lead.text).toBe(true);
  });

  it('"customers only" holds for a change: a declared customer that is really a lead is refused by the CRM', async () => {
    // A lead exists in the CRM (loaded without the gateway's mandate check: created directly as data
    // is not possible here, so use convert on a second customer to make one).
    const c2 = await call('crm__create_contact', { name: 'Steiner Hof', type: 'customer' });
    leadId = c2.json?.id ?? c2.text.match(/"id":\s*"([^"]+)"/)?.[1];
    // convert is a write under this mandate; declaring the CURRENT type (customer) passes the gate.
    const conv = await call('crm__convert_contact', { id: leadId, revision: 1, to_type: 'lead', contact_type: 'customer' });
    expect(conv.error, conv.text).toBe(false);
    // Now the record is a lead: claiming "customer" passes the gate but the CRM checks the real type.
    const upd = await call('crm__update_contact', { id: leadId, revision: 2, contact_type: 'customer', notes: 'x' });
    expect(upd.error, upd.text).toBe(true);
    expect(upd.json?.error ?? upd.text).toMatch(/is type "lead"; this request declares "customer"/);
    // Declaring the truth ("lead") is outside the mandate's scope: the gatekeeper refuses before any ticket.
    const upd2 = await call('crm__update_contact', { id: leadId, revision: 2, contact_type: 'lead', notes: 'x' });
    expect(upd2.error, upd2.text).toBe(true);
  });

  it('update_contact cannot change the type — that is convert_contact', async () => {
    // `type` is not part of update_contact's schema any more: it never reaches the CRM.
    const r = await call('crm__update_contact', { id: customerId, revision: 1, contact_type: 'customer', type: 'lead' });
    expect(r.error, r.text).toBe(true);
    const got = await call('crm__get_contact', { id: customerId });
    expect(got.text).toMatch(/"type":\s*"customer"/);
    expect(got.text).toMatch(/"revision":\s*1/);
  });

  it('the race: archive approved for revision 1, contact changed to revision 2 meanwhile → refused, nothing archived', async () => {
    const del = await call('crm__delete_contact', { id: customerId, revision: 1, contact_type: 'customer' });
    const proposalId = proposalOf(del.text);
    expect(proposalId, del.text).toBeTruthy();

    // While the approval waits, the contact changes (automatic mandate) → revision 2.
    const upd = await call('crm__update_contact', { id: customerId, revision: 1, contact_type: 'customer', notes: 'Prefers phone calls' });
    expect(upd.error, upd.text).toBe(false);

    await commit(proposalId!);
    const outcome = await waitHandled(proposalId!);

    // The CRM refused the outdated revision: nothing was archived.
    const got = await call('crm__get_contact', { id: customerId });
    expect(got.text).toMatch(/"revision":\s*2/);
    expect(got.text).toMatch(/"archived":\s*(false|0)/);
    // …and the gateway reports it as refused, not as executed (gateway #88): asking later
    // consults the execution journal, not the AS's "executed" set at ticket issuance.
    expect(outcome).not.toMatch(/EXECUTED/);
    expect(outcome).toMatch(/refused to run it — nothing was done/);
  }, 90_000);

  it('archiving with the current revision works — activities and deals survive', async () => {
    const del = await call('crm__delete_contact', { id: customerId, revision: 2, contact_type: 'customer' });
    const proposalId = proposalOf(del.text);
    expect(proposalId, del.text).toBeTruthy();
    await commit(proposalId!);
    await waitHandled(proposalId!);

    const got = await call('crm__get_contact', { id: customerId });
    expect(got.text).toMatch(/"archived":\s*(true|1)/);
    expect(got.text).toMatch(/"revision":\s*3/);

    const timeline = await call('crm__get_timeline', { contact_id: customerId });
    expect(timeline.text).toMatch(/Asked for a quote/);
    const pipeline = await call('crm__get_pipeline', { include_archived: true });
    expect(pipeline.text).toMatch(/Spare parts Q4/);
    const hidden = await call('crm__find_contacts', { query: 'Huber' });
    expect(hidden.text).not.toMatch(/Huber Agrar/);
  }, 90_000);

  it('an old revision can be read back for the approval preview', async () => {
    const r1 = await call('crm__get_contact', { id: customerId, revision: 1 });
    expect(r1.error, r1.text).toBe(false);
    expect(r1.text).toMatch(/"revision":\s*1/);
    expect(r1.text).not.toMatch(/Prefers phone calls/);
  });
});
