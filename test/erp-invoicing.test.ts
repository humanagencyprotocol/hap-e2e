/**
 * Invoicing, on the real stack (Authority Server + gateway + the erp
 * connector): the erp connector's invoice and credit-note tools are governed
 * by their OWN area — the `invoicing` profile — while quotes and orders stay
 * under `sales`. One connector, two areas, chosen per tool by the manifest
 * (`toolGating.overrides.<tool>.profile`).
 *
 * The journey proves, step by step:
 *   1. a sales mandate creates a quote, sends it and converts it to an order;
 *   2. that sales mandate does NOT cover create_invoice — refused, nothing
 *      created (area-per-tool isolation);
 *   3. an automatic invoicing mandate issues the invoice from the order —
 *      INV-<year>-0001, ticket issued by the AS under invoicing / `invoice`;
 *   4. an invoice above invoice_net_max is refused (gateway Gatekeeper; the AS
 *      directly: BOUND_EXCEEDED), one without net_total too (schema on the MCP
 *      path; requiredFor at the AS) — nothing created;
 *   5. a wrong declared net_total within the limit passes the gate but the
 *      connector refuses it — nothing issued;
 *   6. credit notes are checked against credit_net_max only (`credit_total`,
 *      never `net_total`): 300 is refused although the invoice limit is 1000;
 *      a partial credit of 100 and the full credit of the remaining 200 run;
 *   7. get_invoice shows the invoice fully credited.
 *
 * Uses a LOCAL build of hap-erp-mcp (unreleased invoicing feature, same
 * `npmVersion` as the manifest pin), preinstalled via
 * HAP_E2E_PREINSTALLED_INTEGRATIONS + SUVEREN_OFFLINE=1 — see README.md
 * "Unpublished connector builds". Skips loudly without it, or when the gateway
 * under test has no per-tool profile support.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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

const SP_PORT = 17375;
const GW_PORT = 17405;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const MANIFEST = join(ROOT, 'suveren-gateway', 'content', 'integrations', 'erp.json');
const MANIFEST_LOADER = join(ROOT, 'suveren-gateway', 'apps', 'mcp-server', 'src', 'lib', 'manifest-loader.ts');

const PREINSTALLED_DIR = process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
const preinstalled = !!PREINSTALLED_DIR && existsSync(PREINSTALLED_DIR);
const perToolProfiles = existsSync(MANIFEST_LOADER)
  && readFileSync(MANIFEST_LOADER, 'utf8').includes('invalidManifestOverrideProfilesReason');
const invoicingProfile = existsSync(join(PROFILES_DIR, 'invoicing', '0.1.profile.json'));
const available = existsSync(MANIFEST) && preinstalled && perToolProfiles && invoicingProfile;
if (!available) {
  console.warn(
    '[ERP INVOICING E2E] SKIPPED — needs ' +
    (!preinstalled ? 'HAP_E2E_PREINSTALLED_INTEGRATIONS (a local erp-mcp build with invoicing); ' : '') +
    (!perToolProfiles ? 'a gateway with per-tool profiles (invalidManifestOverrideProfilesReason); ' : '') +
    (!invoicingProfile ? 'hap-profiles invoicing@0.1; ' : ''),
  );
}

const SALES_ID = PROFILE_V07.sales;
const INVOICING_ID = 'github.com/humanagencyprotocol/hap-profiles/invoicing@0.1';
const SALES_KEY_ORDER = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'];
const INVOICING_KEY_ORDER = ['profile', 'read_access', 'invoice_net_max', 'credit_net_max',
  'invoice_net_monthly_max', 'credit_net_monthly_max', 'invoice_daily_max', 'credit_daily_max'];
const CONTEXT = { currency: 'EUR' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-erp-inv-'));
const COMPANY = join(work, 'company.json');

/** 12 x item-1 @ 25.00 = an order of 300.00 net — above credit_net_max (200),
 *  below invoice_net_max (1000). That gap is what step 6 needs. */
const COMPANY_DATA = {
  name: 'E2E Invoicing Industrial', currency: 'EUR',
  items: [
    { id: 'item-1', sku: 'WIDGET-100', name: 'Widget 100', unit: 'pcs', list_price: 25, stock: 500 },
  ],
  customers: [
    { id: 'cust-4', name: 'Meridian Industrial Ltd', email: 'payables@meridianind.example', country: 'IE', credit_limit: 100000, open_balance: 0, payment_terms: 'NET60', currency: 'EUR' },
  ],
};
const ORDER_NET = 300;
const YEAR = new Date().getFullYear();

const INVOICING_BOUNDS = {
  profile: INVOICING_ID, read_access: 'unlimited',
  invoice_net_max: 1000, credit_net_max: 200,
  invoice_net_monthly_max: 5000, credit_net_monthly_max: 1000,
  invoice_daily_max: 10, credit_daily_max: 10,
};

let apiKey: string;
let userDid: string;
let groupId: string;
let mcpClient: Client;
let previousOffline: string | undefined;
let previousPreinstalled: string | undefined;
let invoicingAuthId: string;
let invoicingBoundsHash: string;

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

async function invoiceCount(): Promise<number> {
  const r = await call('erp__list_invoices', {});
  expect(r.denied).toBe(false);
  return (Array.isArray(r.json) ? r.json : r.json?.invoices ?? r.json?.items).length;
}

async function creditNoteCount(): Promise<number> {
  const r = await call('erp__list_credit_notes', {});
  expect(r.denied).toBe(false);
  return (Array.isArray(r.json) ? r.json : r.json?.credit_notes ?? r.json?.items).length;
}

async function ticketById(id: string): Promise<Record<string, unknown> | undefined> {
  const { tickets } = await sp.getMyTicketsPage(apiKey, { limit: 100 });
  return tickets.find((t) => String(t.id) === id);
}

async function grant(profileId: string, keyOrder: string[], bounds: Record<string, unknown>, intent: string, ec: Record<string, unknown>) {
  const boundsHash = computeBoundsHash(bounds, keyOrder);
  const contextHash = computeScopeHash(CONTEXT, ['currency']);
  const gateContent = { intent };
  const att = await sp.submitMandate(apiKey, {
    profile_id: profileId, profile_hash: profileHashFor(profileId, PROFILES_DIR), group_id: groupId,
    bounds, bounds_hash: boundsHash, scope_hash: contextHash,
    domain: 'owner', did: userDid, commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gateContent),
    execution_context_hash: hashExecutionContext(ec),
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: CONTEXT },
    profileId, gateContent,
  );
  return { authorizationId: att.authorization_id as string, boundsHash };
}

describe.skipIf(!available)('ERP invoicing: its own area, its own limits (real AS + gateway + erp-mcp)', () => {
  beforeAll(async () => {
    previousPreinstalled = process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
    previousOffline = process.env.SUVEREN_OFFLINE;
    process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS = PREINSTALLED_DIR;
    process.env.SUVEREN_OFFLINE = '1';

    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('ERP Invoicing Test', `erp-inv-${Date.now()}@test.local`);
    apiKey = reg.apiKey;
    userDid = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);

    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'erp-inv-e2e', apiKey });
    await gw.waitForIntegration('erp');

    writeFileSync(COMPANY, JSON.stringify(COMPANY_DATA));
    erpCliWith({ ERP_COMPANY_FILE: COMPANY }, 'export');

    // Sales only, automatic — quote, send and order. No invoicing mandate yet.
    await grant(SALES_ID, SALES_KEY_ORDER, {
      profile: SALES_ID, read_access: 'unlimited', value_max: 1000, discount_max: 50,
      order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10, setup_daily_max: 0,
    }, 'E2E: quote, send and convert to order automatically, within bounds.', { quote_count_daily: 10 });

    await new Promise((r) => setTimeout(r, 2_000));
    mcpClient = new Client({ name: 'erp-inv-agent', version: '1.0.0' }, { capabilities: {} });
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

  let orderId: string;
  let invoiceId: string;

  it('1. the sales mandate creates a quote, sends it and converts it to an order of 300.00', async () => {
    const q = await call('erp__create_quote', {
      customer_id: 'cust-4', lines: [{ item_id: 'item-1', qty: 12 }], discount_pct: 0, value: ORDER_NET, currency: 'EUR',
    });
    if (q.denied) console.error('[ERP INV E2E] create_quote denied:', q.text.slice(0, 300));
    expect(q.denied).toBe(false);
    const quoteId = q.json.id;

    const s = await call('erp__send_quote', { id: quoteId, value: ORDER_NET, discount_pct: 0, currency: 'EUR', revision: 1 });
    if (s.denied) console.error('[ERP INV E2E] send_quote denied:', s.text.slice(0, 300));
    expect(s.denied).toBe(false);

    const o = await call('erp__convert_quote_to_order', { id: quoteId, value: ORDER_NET, discount_pct: 0, currency: 'EUR', revision: 1 });
    if (o.denied) console.error('[ERP INV E2E] convert denied:', o.text.slice(0, 300));
    expect(o.denied).toBe(false);
    expect(o.json.net_total).toBe(ORDER_NET);
    orderId = o.json.id;
  });

  it('2. without an invoicing mandate, create_invoice is refused — the sales mandate does not cover it', async () => {
    const r = await call('erp__create_invoice', { customer_id: 'cust-4', order_id: orderId, net_total: ORDER_NET, currency: 'EUR' });
    expect(r.denied).toBe(true);
    expect(r.text).toContain('no mandate covers erp__create_invoice (invoicing)');
    expect(r.text).toContain('No ticket was requested');
    // Read access is the invoicing area's too — the sales mandate's read_access does not reach it.
    const read = await call('erp__list_invoices', {});
    expect(read.denied).toBe(true);
    expect(read.text).toContain('no mandate covers erp__list_invoices (invoicing)');
    const record = JSON.parse(erpCli('export'));
    expect(record.changes.map((c: any) => c.tool)).not.toContain('create_invoice');
  });

  it('3. an automatic invoicing mandate issues the invoice from the order — INV-<year>-0001, ticket under invoicing / invoice', async () => {
    const g = await grant(INVOICING_ID, INVOICING_KEY_ORDER, INVOICING_BOUNDS,
      'E2E: issue invoices and credit notes automatically, within bounds.', { invoice_count_daily: 10 });
    invoicingAuthId = g.authorizationId;
    invoicingBoundsHash = g.boundsHash;
    await new Promise((r) => setTimeout(r, 1_000));

    const r = await call('erp__create_invoice', { customer_id: 'cust-4', order_id: orderId, net_total: ORDER_NET, currency: 'EUR' });
    if (r.denied) console.error('[ERP INV E2E] create_invoice denied:', r.text.slice(0, 400));
    expect(r.denied).toBe(false);
    expect(r.json.number).toBe(`INV-${YEAR}-0001`);
    expect(r.json.status).toBe('issued');
    expect(r.json.net_total).toBe(ORDER_NET);
    expect(r.json.order_id).toBe(orderId);
    expect(r.json.lines).toHaveLength(1);
    invoiceId = r.json.id;

    // The AS issued the ticket, and it names the invoicing area.
    expect(r.json.receipt_id).toEqual(expect.any(String));
    const ticket = await ticketById(r.json.receipt_id);
    expect(ticket).toBeTruthy();
    expect(ticket!.profileId).toBe(INVOICING_ID);
    expect(ticket!.actionType).toBe('invoice');
    expect(ticket!.action).toMatch(/create_invoice/);
    expect(ticket!.authorizationId).toBe(invoicingAuthId);
  });

  it('4a. an invoice above invoice_net_max is refused by the gateway\'s Gatekeeper — nothing created', async () => {
    const before = await invoiceCount();
    const r = await call('erp__create_invoice', {
      customer_id: 'cust-4', currency: 'EUR', net_total: 1500,
      lines: [{ item_id: 'item-1', description: 'Widget 100', qty: 60, unit_price: 25, vat_rate: 20 }],
    });
    expect(r.denied).toBe(true);
    expect(r.text).toContain('rejected by Gatekeeper');
    expect(r.text).toContain('net_total: Value 1500 exceeds authorized maximum of 1000 for invoice_net_max');
    expect(await invoiceCount()).toBe(before);
    const record = JSON.parse(erpCli('export'));
    expect(record.changes.filter((c: any) => c.tool === 'create_invoice')).toHaveLength(1);
  });

  // The connector's own input schema marks net_total required, so on the MCP
  // path the gateway's schema validation refuses first; the requiredFor rule
  // itself is proven at the AS in 4c (the gateway cannot reach it here).
  it('4b. an invoice declaring no net_total is refused before anything runs — nothing created', async () => {
    const before = await invoiceCount();
    const r = await call('erp__create_invoice', {
      customer_id: 'cust-4', currency: 'EUR',
      lines: [{ item_id: 'item-1', description: 'Widget 100', qty: 1, unit_price: 25, vat_rate: 20 }],
    });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/Required at net_total/);
    expect(await invoiceCount()).toBe(before);
  });

  it('4c. the AS itself refuses an invoice ticket with no net_total (requiredFor, bypassing the gateway)', async () => {
    const result = await sp.postTicket(apiKey, {
      authorizationId: invoicingAuthId,
      boundsHash: invoicingBoundsHash,
      profileId: INVOICING_ID,
      action: 'erp__create_invoice',
      actionType: 'invoice',
      executionContext: { action_type: 'invoice', currency: 'EUR' },
    });
    expect(result.status).toBe(403);
    const err = (result.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('BOUND_EXCEEDED');
    expect(String(err.message)).toMatch(/exposes no net_total/i);
  });

  it('4d. the AS itself refuses an invoice ticket above invoice_net_max: 403 BOUND_EXCEEDED (bypassing the gateway)', async () => {
    const result = await sp.postTicket(apiKey, {
      authorizationId: invoicingAuthId,
      boundsHash: invoicingBoundsHash,
      profileId: INVOICING_ID,
      action: 'erp__create_invoice',
      actionType: 'invoice',
      executionContext: { action_type: 'invoice', currency: 'EUR', net_total: 1500 },
    });
    expect(result.status).toBe(403);
    const err = (result.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('BOUND_EXCEEDED');
    expect(String(err.message)).toMatch(/invoice_net_max/);
  });

  it('5. a wrong declared net_total within the limit passes the gate, and the connector refuses it — nothing issued', async () => {
    const before = await invoiceCount();
    const r = await call('erp__create_invoice', {
      customer_id: 'cust-4', currency: 'EUR', net_total: 60,
      lines: [{ item_id: 'item-1', description: 'Widget 100', qty: 2, unit_price: 25, vat_rate: 20 }],
    });
    expect(r.denied).toBe(true);
    expect(r.text).toContain('net_total mismatch — declared 60, expected 50');
    expect(await invoiceCount()).toBe(before);

    const record = JSON.parse(erpCli('export'));
    const refusal = record.refusals.find((x: any) => x.tool === 'create_invoice' && x.message.includes('net_total'));
    expect(refusal).toBeTruthy();
    // The gate passed it, so the AS had issued a ticket — the connector refused anyway.
    expect(refusal.receipt_id).toEqual(expect.any(String));
    const ticket = await ticketById(refusal.receipt_id);
    expect(ticket?.profileId).toBe(INVOICING_ID);
    expect(record.changes.filter((c: any) => c.tool === 'create_invoice')).toHaveLength(1);
  });

  it('6a. a credit note of 300 is refused by the gate — credit_net_max (200) applies, not invoice_net_max (1000)', async () => {
    // 300 = the whole invoice, so the connector itself would accept it.
    const before = await creditNoteCount();
    const r = await call('erp__create_credit_note', {
      invoice_id: invoiceId, credit_total: ORDER_NET, currency: 'EUR', reason: 'Full cancellation',
    });
    expect(r.denied).toBe(true);
    expect(r.text).toContain('rejected by Gatekeeper');
    expect(r.text).toContain('credit_total: Value 300 exceeds authorized maximum of 200 for credit_net_max');
    expect(r.text).not.toMatch(/invoice_net_max/);
    expect(await creditNoteCount()).toBe(before);
    const inv = await call('erp__get_invoice', { id: invoiceId });
    expect(inv.json.status).toBe('issued');
    expect(inv.json.credited_total).toBe(0);
  });

  it('6b. a partial credit note of 100 runs — CN-<year>-0001, invoice partially_credited, ticket under invoicing / credit', async () => {
    const r = await call('erp__create_credit_note', {
      invoice_id: invoiceId, credit_total: 100, currency: 'EUR', reason: '4 widgets returned',
      lines: [{ item_id: 'item-1', description: 'Widget 100 (returned)', qty: 4, unit_price: 25, vat_rate: 20 }],
    });
    if (r.denied) console.error('[ERP INV E2E] partial credit denied:', r.text.slice(0, 400));
    expect(r.denied).toBe(false);
    expect(r.json.number).toBe(`CN-${YEAR}-0001`);
    expect(r.json.net_total).toBe(100);
    expect(r.json.invoice_id).toBe(invoiceId);

    const ticket = await ticketById(r.json.receipt_id);
    expect(ticket).toBeTruthy();
    expect(ticket!.profileId).toBe(INVOICING_ID);
    expect(ticket!.actionType).toBe('credit');

    const inv = await call('erp__get_invoice', { id: invoiceId });
    expect(inv.json.status).toBe('partially_credited');
    expect(inv.json.credited_total).toBe(100);
  });

  it('6c. the full credit of the remaining 200 runs — CN-<year>-0002', async () => {
    const r = await call('erp__create_credit_note', {
      invoice_id: invoiceId, credit_total: 200, currency: 'EUR', reason: 'Order cancelled',
    });
    if (r.denied) console.error('[ERP INV E2E] remainder credit denied:', r.text.slice(0, 400));
    expect(r.denied).toBe(false);
    expect(r.json.number).toBe(`CN-${YEAR}-0002`);
    expect(r.json.net_total).toBe(200);
  });

  it('7. get_invoice shows the invoice credited, credited_total 300 — the invoice itself unchanged', async () => {
    const inv = await call('erp__get_invoice', { id: `INV-${YEAR}-0001` });
    expect(inv.denied).toBe(false);
    expect(inv.json.id).toBe(invoiceId);
    expect(inv.json.status).toBe('credited');
    expect(inv.json.credited_total).toBe(ORDER_NET);
    expect(inv.json.net_total).toBe(ORDER_NET);
    expect(await creditNoteCount()).toBe(2);
  });
});
