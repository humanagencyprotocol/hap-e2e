/**
 * ERP1-3: quote revisions, on the real stack (Authority Server + gateway +
 * the erp connector). An approval must bind one exact version of a quote's
 * content — not "whatever that quote currently contains" by the time it
 * actually runs.
 *
 * The race this proves: an automatic quote mandate creates a quote (revision
 * 1) and requests a send under a SEPARATE review-mode send mandate — the
 * gateway submits a proposal carrying `revision: 1`, the exact revision at
 * the moment the request was made. Before a human commits it, the same
 * automatic mandate updates the draft (same net total, different line items
 * — revision 2). When the human then commits the pending send, the gateway
 * issues a ticket (the Authority Server has no visibility into the quote's
 * content) and calls the connector with the STALE `revision: 1` recorded at
 * proposal time — and the connector, not the gateway, is what catches it:
 * the quote is refused, naming both revisions, and stays in `draft`. Nothing
 * is sent.
 *
 * Uses a LOCAL build of hap-erp-mcp (unreleased quote-revisions feature,
 * same `npmVersion` as the shipped manifest pin — see
 * HAP_E2E_PREINSTALLED_INTEGRATIONS below) rather than the published
 * package, which does not have this feature yet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';

const SP_PORT = 17365;
const GW_PORT = 17395;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const MANIFEST = join(ROOT, 'suveren-gateway', 'content', 'integrations', 'erp.json');

// This suite needs a LOCAL erp-mcp build with the quote-revisions feature,
// preinstalled via HAP_E2E_PREINSTALLED_INTEGRATIONS + SUVEREN_OFFLINE=1 (see
// hap-e2e/README.md "Unpublished connector builds"). Without it, skip loudly
// rather than silently testing the published (older) connector.
const PREINSTALLED_DIR = process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
const available = existsSync(MANIFEST) && !!PREINSTALLED_DIR && existsSync(PREINSTALLED_DIR);

const PROFILE_ID = PROFILE_V07.sales;
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'];
const CONTEXT = { currency: 'EUR' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-erp-rev-'));
const COMPANY = join(work, 'company.json');

/** item-1 WIDGET-100 @ 25.00, item-2 WIDGET-200 @ 45.00 — picked so revision 1
 *  (1 x item-1) and revision 2 (1 x item-2, discounted) land on the SAME net
 *  total (25.00): a value-only check could never catch this race. */
const COMPANY_DATA = {
  name: 'E2E Revisions Industrial', currency: 'EUR',
  items: [
    { id: 'item-1', sku: 'WIDGET-100', name: 'Widget 100', unit: 'pcs', list_price: 25, stock: 500 },
    { id: 'item-2', sku: 'WIDGET-200', name: 'Widget 200 Pro', unit: 'pcs', list_price: 45, stock: 300 },
  ],
  customers: [
    { id: 'cust-4', name: 'Meridian Industrial Ltd', email: 'payables@meridianind.example', country: 'IE', credit_limit: 100000, open_balance: 0, payment_terms: 'NET60' },
  ],
};
// 45 * (1 - REV2_DISCOUNT/100) = 25, computed rather than hand-rounded.
const REV2_DISCOUNT = ((45 - 25) / 45) * 100;

let apiKey: string;
let userDid: string;
let groupId: string;
let mcpClient: Client;
let previousOffline: string | undefined;
let previousPreinstalled: string | undefined;

/** The ERP's own operator command, against the database the gateway-spawned
 *  connector uses (same contract erp-simulation.test.ts relies on). */
function erpCli(...args: string[]): string {
  return erpCliWith({}, ...args);
}

function erpCliWith(extraEnv: Record<string, string>, ...args: string[]): string {
  const dataDir = pm.getDataDir();
  const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, HAP_DATA_DIR: dataDir, ...extraEnv };
  delete env.DATABASE_URL;
  return execFileSync('node', [bin, ...args], { env, encoding: 'utf8' });
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

async function commitProposal(proposalId: string): Promise<void> {
  const res = await fetch(`${SP_URL}/api/proposals/${proposalId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ action: 'commit', domain: 'owner' }),
  });
  expect(res.ok).toBe(true);
}

describe.skipIf(!available)('ERP quote revisions: an approval binds one exact version (real AS + gateway + erp-mcp)', () => {
  beforeAll(async () => {
    // getDataDir() reads this at first call; set BEFORE anything touches it.
    previousPreinstalled = process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
    previousOffline = process.env.SUVEREN_OFFLINE;
    process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS = PREINSTALLED_DIR;
    process.env.SUVEREN_OFFLINE = '1';

    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('ERP Revisions Test', `erp-rev-${Date.now()}@test.local`);
    apiKey = reg.apiKey;
    userDid = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);

    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'erp-rev-e2e', apiKey });
    await gw.waitForIntegration('erp');

    // Seed the (empty) ERP database the running connector uses: any command of
    // the installed connector seeds an empty database from ERP_COMPANY_FILE on
    // open (same mechanism erp-simulation.test.ts relies on).
    writeFileSync(COMPANY, JSON.stringify(COMPANY_DATA));
    erpCliWith({ ERP_COMPANY_FILE: COMPANY }, 'export');

    // Mandate A — automatic, quote-only (zero-capped for send/order, so the
    // gateway's zero-capped selection routes every quote/update call here
    // and never here for send).
    const boundsA = {
      profile: PROFILE_ID, read_access: 'unlimited', value_max: 1000, discount_max: 50,
      order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 0,
    };
    const boundsHashA = computeBoundsHash(boundsA, BOUNDS_KEY_ORDER);
    const contextHashA = computeScopeHash(CONTEXT, ['currency']);
    const gateContentA = { intent: 'E2E: create and update quotes automatically, within bounds.' };
    const attA = await sp.submitMandate(apiKey, {
      profile_id: PROFILE_ID, profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR), group_id: groupId,
      bounds: boundsA, bounds_hash: boundsHashA, scope_hash: contextHashA,
      domain: 'owner', did: userDid, commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent(gateContentA),
      execution_context_hash: hashExecutionContext({ quote_count_daily: boundsA.quote_daily_max }),
    });
    await gw.pushGateContent(
      { authorizationId: attA.authorization_id, boundsHash: boundsHashA, contextHash: contextHashA, context: CONTEXT },
      PROFILE_ID, gateContentA,
    );

    // Mandate B — review, send-only (zero-capped for quote/order, so the
    // gateway routes every send call here, and under review).
    const boundsB = {
      profile: PROFILE_ID, read_access: 'unlimited', value_max: 1000, discount_max: 50,
      order_value_daily_max: 5000, quote_daily_max: 0, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0,
    };
    const boundsHashB = computeBoundsHash(boundsB, BOUNDS_KEY_ORDER);
    const contextHashB = computeScopeHash(CONTEXT, ['currency']);
    const gateContentB = { intent: 'E2E: review quote sends before they go out.' };
    const attB = await sp.submitMandate(apiKey, {
      profile_id: PROFILE_ID, profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR), group_id: groupId,
      bounds: boundsB, bounds_hash: boundsHashB, scope_hash: contextHashB,
      domain: 'owner', did: userDid, commitment_mode: 'review',
      gate_content_hashes: hashGateContent(gateContentB),
      execution_context_hash: hashExecutionContext({ send_count_daily: boundsB.send_daily_max }),
    });
    await gw.pushGateContent(
      { authorizationId: attB.authorization_id, boundsHash: boundsHashB, contextHash: contextHashB, context: CONTEXT },
      PROFILE_ID, gateContentB,
    );

    await new Promise((r) => setTimeout(r, 2_000));
    mcpClient = new Client({ name: 'erp-rev-agent', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
    rmSync(work, { recursive: true, force: true });
    if (previousPreinstalled === undefined) delete process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
    else process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS = previousPreinstalled;
    if (previousOffline === undefined) delete process.env.SUVEREN_OFFLINE;
    else process.env.SUVEREN_OFFLINE = previousOffline;
  }, 30_000);

  let quoteId: string;
  let proposalId: string;

  it('the automatic quote mandate creates a quote — revision 1', async () => {
    const r = await call('erp__create_quote', {
      customer_id: 'cust-4', lines: [{ item_id: 'item-1', qty: 1 }], discount_pct: 0, value: 25, currency: 'EUR',
    });
    if (r.denied) console.error('[ERP REV E2E] create denied:', r.text.slice(0, 300));
    expect(r.denied).toBe(false);
    expect(r.json.revision).toBe(1);
    quoteId = r.json.id;
  });

  it('requesting the send under the review mandate submits a proposal carrying revision: 1 — nothing sent yet', async () => {
    const r = await call('erp__send_quote', {
      id: quoteId, value: 25, discount_pct: 0, currency: 'EUR', revision: 1,
    });
    expect(r.denied).toBeFalsy();
    expect(r.text).toContain('Awaiting commitment');
    const match = r.text.match(/Proposal ID: ([a-f0-9-]+)/);
    expect(match).toBeTruthy();
    proposalId = match![1];

    const stillDraft = await call('erp__get_quote', { id: quoteId });
    expect(stillDraft.json.status).toBe('draft');
  });

  it('the automatic mandate updates the draft — same net total (25.00), different line item, revision 2', async () => {
    const r = await call('erp__update_quote', {
      id: quoteId, lines: [{ item_id: 'item-2', qty: 1 }], discount_pct: REV2_DISCOUNT, value: 25, currency: 'EUR',
    });
    if (r.denied) console.error('[ERP REV E2E] update denied:', r.text.slice(0, 300));
    expect(r.denied).toBe(false);
    expect(r.json.revision).toBe(2);
    expect(r.json.net_total).toBe(25);
  });

  it('committing the pending send: the Authority Server issues a ticket, the connector refuses it — stale revision', async () => {
    await commitProposal(proposalId);

    // The approved action did not happen, and the gateway says so: a connector
    // refusal on the committed-execution path is an error, never "executed"
    // (fixed in the same change as this test: commitments.ts checks isError).
    const result = await call('check-pending-commitments', { proposal_id: proposalId });
    expect(result.denied).toBe(true);
    expect(result.text).not.toContain('committed and executed');
    expect(result.text).toMatch(/refused to run it — nothing was done/);
    expect(result.text).toMatch(/revision/);
    expect(result.text).toContain('is at revision 2');
    expect(result.text).toContain('this request is for revision 1');
  });

  it('nothing was sent — the quote stays draft at revision 2, and the ERP recorded the refusal naming the field', async () => {
    const quote = await call('erp__get_quote', { id: quoteId });
    expect(quote.json.status).toBe('draft');
    expect(quote.json.revision).toBe(2);

    const record = JSON.parse(erpCli('export'));
    const quoteRecord = record.quotes.find((q: any) => q.id === quoteId);
    expect(quoteRecord.status).toBe('draft');
    expect(quoteRecord.sent_at).toBeFalsy();

    expect(record.changes.map((c: any) => c.tool)).not.toContain('send_quote');

    const refusal = record.refusals.find((r: any) => r.message.includes('revision'));
    expect(refusal).toBeTruthy();
    expect(refusal.message).toContain('is at revision 2');
    expect(refusal.message).toContain('this request is for revision 1');
    // A ticket WAS issued (the AS has no visibility into the quote's
    // content — it signed off before the connector ever saw the call), so
    // the refusal still carries one: no receipt, no execution — but a
    // receipt alone is not a guarantee of execution either.
    expect(refusal.receipt_id).toEqual(expect.any(String));

    // That ticket is real — the AS issued it.
    const { tickets } = await sp.getMyTicketsPage(apiKey, { limit: 50 });
    expect(tickets.some((t) => String(t.id) === refusal.receipt_id)).toBe(true);
  });

  it('sending with the correct current revision (2) now goes through, once committed', async () => {
    const propose = await call('erp__send_quote', {
      id: quoteId, value: 25, discount_pct: REV2_DISCOUNT, currency: 'EUR', revision: 2,
    });
    expect(propose.text).toContain('Awaiting commitment');
    const match = propose.text.match(/Proposal ID: ([a-f0-9-]+)/);
    expect(match).toBeTruthy();
    const secondProposalId = match![1];

    await commitProposal(secondProposalId);
    const result = await call('check-pending-commitments', { proposal_id: secondProposalId });
    if (result.denied) console.error('[ERP REV E2E] second send still denied:', result.text.slice(0, 300));
    expect(result.denied).toBeFalsy();
    expect(result.text).toMatch(/executed/i);

    const quote = await call('erp__get_quote', { id: quoteId });
    expect(quote.json.status).toBe('sent');
    expect(quote.json.revision).toBe(2);
  });
});
