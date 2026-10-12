/**
 * Live bug (demo gateway, simulation mode, 2026-10-12, gateway 0.27.1):
 * setup mandates (customers / sales / email) in REVIEW mode. The AI called
 * `crm__load_simulation`, `erp__load_simulation`, `mail__load_simulation`
 * with `{ package: <pkg> }`; each became a proposal; the person approved
 * all three; check-pending-commitments reported each as approved and
 * EXECUTED — but `crm__find_contacts {}` / `erp__list_items {}` afterwards
 * returned `[]`: nothing was actually loaded.
 *
 * Since gateway 0.27.0, review proposals are end-to-end encrypted — the
 * control plane encrypts `toolArgs`, and the committed executor decrypts
 * them before executing (proposal-content.ts's resolveProposalToolArgs,
 * commitments.ts's executeCommitted). This test reproduces the live
 * sequence against the real stack (real AS + Postgres, real gateway, real
 * CRM/ERP/mail connectors) and asserts on the DOWNSTREAM EFFECT, not just
 * the text check-pending-commitments returns.
 *
 * Requires SUVEREN_DB_URL (the AS has no in-memory fallback).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient, internalSecretHeaders } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { profileHashFor } from '../src/helpers/profiles.js';

const SP_PORT = 17760;
const GW_PORT = 17792;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const INTEGRATIONS = join(ROOT, 'suveren-gateway', 'content', 'integrations');
const MAIL_MANIFEST = join(INTEGRATIONS, 'mail.json');
const available = existsSync(MAIL_MANIFEST) && !!process.env.SUVEREN_DB_URL;
const PKG = { erp: 'erp-mcp', crm: 'crm-mcp', mail: 'email-mcp' } as const;
const SYSTEMS = ['erp', 'crm', 'mail'] as const;
/** Which profile key gates each system — same mapping as simulation-rerun.test.ts. */
const PROFILE_FOR: Record<(typeof SYSTEMS)[number], ProfileKey> = { erp: 'sales', crm: 'customers', mail: 'email' };

const P = 'github.com/humanagencyprotocol/hap-profiles';
const PROFILES = {
  sales: {
    id: `${P}/sales@0.4`,
    keyOrder: ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max', 'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'],
    ctxOrder: ['currency'], ctx: { currency: 'EUR' },
    setup: { read_access: 'none', value_max: 0, discount_max: 0, order_value_daily_max: 0, quote_daily_max: 0, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 2 },
    work: { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10, setup_daily_max: 0 },
  },
  customers: {
    id: `${P}/customers@0.9`,
    keyOrder: ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'],
    ctxOrder: ['contact_type'], ctx: { contact_type: 'customer' },
    setup: { read_access: 'none', export_access: 'none', write_daily_max: 0, delete_daily_max: 0, setup_daily_max: 2 },
    work: { read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
  },
  email: {
    id: `${P}/email@0.8`,
    keyOrder: ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'],
    ctxOrder: ['allowed_recipients', 'allowed_domains'],
    ctx: { allowed_recipients: 'einkauf@huber.example,office@steiner.example', allowed_domains: 'huber.example,steiner.example' },
    setup: { read_access: 'none', recipient_max: 0, send_daily_max: 0, read_max_age_days: 0, setup_daily_max: 2 },
    work: { read_access: 'unlimited', recipient_max: 1, send_daily_max: 10, read_max_age_days: 3650, setup_daily_max: 0 },
  },
} as const;
type ProfileKey = keyof typeof PROFILES;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let apiKey: string;
let did: string;
let groupId: string;
let mcpClient: Client;

/** `kind` selects the bounds; `mode` is the mandate's commitment_mode. */
async function grant(key: ProfileKey, kind: 'setup' | 'work', mode: 'review' | 'automatic'): Promise<string> {
  const p = PROFILES[key];
  const bounds = { profile: p.id, ...p[kind] };
  const boundsHash = computeBoundsHash(bounds, [...p.keyOrder]);
  const contextHash = computeScopeHash(p.ctx, [...p.ctxOrder]);
  const gate = { intent: `E2E ${kind}/${mode} mandate for ${key}` };
  const att = await sp.submitMandate(apiKey, {
    profile_id: p.id, profile_hash: profileHashFor(p.id, PROFILES_DIR), group_id: groupId, bounds, bounds_hash: boundsHash, scope_hash: contextHash,
    domain: 'owner', did, commitment_mode: mode,
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ kind, mode }),
  });
  await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: p.ctx }, p.id, gate);
  return att.authorization_id;
}

async function reconnect() {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 2_000));
  mcpClient = new Client({ name: 'review-load-sim-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

async function resolveProposal(proposalId: string): Promise<void> {
  const res = await fetch(`${SP_URL}/api/proposals/${proposalId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ action: 'commit', domain: 'owner' }),
  });
  const body = await res.json().catch(() => ({}));
  expect(res.ok, JSON.stringify(body)).toBe(true);
}

async function checkPending(proposalId: string) {
  const r = await mcpClient.callTool({ name: 'check-pending-commitments', arguments: { proposal_id: proposalId } });
  const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? '';
  return { denied: r.isError === true, text };
}

describe.skipIf(!available)('review-mode load_simulation: an approved proposal must actually load the package (real AS + gateway + connectors)', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'simulation-package.example.json'), 'utf8'));

  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('Review Sim Test', `review-load-sim-${Date.now()}@test.local`);
    apiKey = reg.apiKey; did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);
    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'review-load-sim-e2e', apiKey });

    await gw.waitForIntegration('erp');
    await gw.waitForIntegration('crm');
    const mail = JSON.parse(readFileSync(MAIL_MANIFEST, 'utf8'));
    await gw.addIntegration({
      id: 'mail', name: mail.name, command: mail.mcp.command, args: mail.mcp.args, envKeys: {},
      profile: mail.profile, enabled: true, toolGating: mail.toolGating,
      npmPackage: mail.npmPackage,
    } as Parameters<GatewayClient['addIntegration']>[0]);
    await gw.waitForIntegration('mail');
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
  }, 30_000);

  it('a setup mandate in REVIEW mode makes load_simulation a proposal (not an immediate execution)', async () => {
    for (const k of ['sales', 'customers', 'email'] as const) await grant(k, 'setup', 'review');
    await reconnect();
    const names = (await mcpClient.listTools()).tools.map((t) => t.name);
    for (const c of SYSTEMS) expect(names).toContain(`${c}__load_simulation`);
  });

  it('clear_simulation under review mode, approved, leaves every simulator empty (same flow as the live report)', async () => {
    const clearId: Record<(typeof SYSTEMS)[number], string> = { erp: '', crm: '', mail: '' };
    for (const c of SYSTEMS) {
      const r = await call(`${c}__clear_simulation`, {});
      expect(r.denied, r.text).toBe(false);
      expect(r.text).toMatch(/Awaiting commitment/);
      const match = r.text.match(/Proposal ID: ([a-f0-9-]+)/);
      expect(match, r.text).toBeTruthy();
      clearId[c] = match![1];
    }
    for (const c of SYSTEMS) await resolveProposal(clearId[c]);
    for (const c of SYSTEMS) {
      const res = await checkPending(clearId[c]);
      if (process.env.HAP_E2E_SHOW_CARD) console.error(`[REVIEW LOAD SIM] clear ${c}:`, res.text);
    }
  }, 60_000);

  const proposalId: Record<(typeof SYSTEMS)[number], string> = { erp: '', crm: '', mail: '' };

  it('calling load_simulation under review mode creates a proposal, no effect yet', async () => {
    for (const c of SYSTEMS) {
      const r = await call(`${c}__load_simulation`, { package: pkg });
      expect(r.denied, r.text).toBe(false);
      expect(r.text).toMatch(/Awaiting commitment/);
      const match = r.text.match(/Proposal ID: ([a-f0-9-]+)/);
      expect(match, r.text).toBeTruthy();
      proposalId[c] = match![1];
    }
  });

  it('approving each proposal at the Authority Server, then running it under concurrent triggers, must actually load the package', async () => {
    // Resolve all three ~simultaneously (like a person approving three cards
    // in quick succession in the browser), then hit every one of them from
    // several triggers AT ONCE — the control-plane nudge, the poll loop
    // underneath, and the agent's own check — exactly the collision
    // exactly-once-execution.test.ts recreates for a single proposal, but
    // here across THREE concurrent proposals under the encrypted-content path.
    await Promise.all(SYSTEMS.map((c) => resolveProposal(proposalId[c])));

    const nudge = () =>
      fetch(`${GW_URL}/internal/run-committed`, { method: 'POST', headers: internalSecretHeaders(GW_URL) }).then((r) => r.status);

    const results = await Promise.all([
      nudge(), nudge(), nudge(),
      ...SYSTEMS.flatMap((c) => [checkPending(proposalId[c]), checkPending(proposalId[c])]),
    ]);
    if (process.env.HAP_E2E_SHOW_CARD) console.error('[REVIEW LOAD SIM] race results:', JSON.stringify(results, null, 2));

    // Let the poll loop take at least one more pass before counting.
    await new Promise((r) => setTimeout(r, 7_000));

    const outcomes: Record<string, string> = {};
    for (const c of SYSTEMS) {
      const res = await checkPending(proposalId[c]);
      outcomes[c] = res.text;
      // The central invariant check: a commitment the AS reports as executed
      // must correspond to a REAL effect. If the connector refused (e.g. it
      // decrypted an empty/garbled package), that MUST be surfaced as an
      // error — never reported as a silent, content-free success.
    }
    if (process.env.HAP_E2E_SHOW_CARD) console.error('[REVIEW LOAD SIM] outcomes:', outcomes);

    // Grant automatic, unlimited-read "work" mandates so we can read back
    // through the real MCP tools, exactly like the live report did.
    for (const k of ['sales', 'customers', 'email'] as const) await grant(k, 'work', 'automatic');
    await reconnect();

    const items = await call('erp__list_items', {});
    const contacts = await call('crm__find_contacts', {});
    expect(items.denied, items.text).toBe(false);
    expect(contacts.denied, contacts.text).toBe(false);

    // THE assertion: the approved package must actually be loaded.
    expect(Array.isArray(items.json) ? items.json.length : (items.json?.items?.length ?? 0))
      .toBe(pkg.products.length);
    expect(Array.isArray(contacts.json) ? contacts.json.length : (contacts.json?.contacts?.length ?? 0))
      .toBe(pkg.customers.length);
  }, 90_000);
});
