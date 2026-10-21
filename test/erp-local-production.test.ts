/**
 * ERP Local in production — customers (with the EU VIES check), quotes and the
 * catalogue — on the real stack: Authority Server + the whole gateway (control
 * plane + MCP server) + the erp connector in live mode "local" (real company
 * file, SQLite, PDFs, write-once archive) + the email connector (simulated
 * mailbox). Contract: hap-erp-mcp docs/local-production-contract.md, incl. §11
 * (AM1–AM4), §12 (Andreas's decisions D1–D5) and §13 (F1–F14).
 *
 * The ONLY stand-in is the EU VIES service: a local HTTP server
 * (src/helpers/vies-stub.ts) the connector reaches through its own setting,
 * erp.json's "VAT-ID check address" (viesUrl → ERP_VIES_URL), saved and
 * activated the way the gateway UI does it. One optional test (end of file)
 * asks the REAL EU VIES and skips, saying so, when it cannot be reached.
 *
 *   1. master-data mandates: review only — the AS refuses automatic and
 *      review_above_cap (suveren-as PR #109);
 *   2. create_customer → card → approve → ticket; update_customer_tax_data on a
 *      customer with issued invoices shows the "already issued" line; a stale
 *      revision is refused before any card (blocking `revision` check), and an
 *      approval that races a newer change is refused at execution;
 *   3. VIES: valid / invalid (blocking: refused before any card, Blocked entry)
 *      / unreachable (card says not checked, saving allowed) / AM1 — an
 *      approval survives a second VIES answer with a new request id and a
 *      flipped status; the execution-time answer is what is stored;
 *   4. blocking: malformed VAT ID, duplicate VAT ID, duplicate CRM contact,
 *      reverse charge without a VIES-valid VAT ID (D1), non-EU customer (F3)
 *      on an invoice and on a quote — each refused
 *      before any proposal, with a Blocked entry, nothing in the ERP;
 *   5. quote (number from the request, own series) → quote PDF → email with the
 *      PDF attached by reference (sha = archive) → create_invoice {quote_id} →
 *      invoice; conversion refused after a tax-data change (AM2);
 *   6. catalogue: item; an invoice line priced off the list shows the notice
 *      check; an item_revision pin is refused after a price change;
 *   7. migration: a Local DB made by erp-mcp 0.9.5 (fixture copied from
 *      hap-erp-mcp test/fixtures/local-0.9.5) under the new connector: old
 *      invoices list/get, a credit note on an old invoice renders the migrated
 *      snapshot.
 *
 * Runs only with a LOCAL erp-mcp build that has the Local production tools
 * (preinstalled via HAP_E2E_PREINSTALLED_INTEGRATIONS + SUVEREN_OFFLINE=1,
 * README "Unpublished connector builds" — or a published erp-mcp that has
 * them), a gateway whose manifest declares `checks`, and hap-profiles with
 * master-data@0.1. Skips loudly otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { COMPANY, ErpLocalStack, ERP_MANIFEST_PATH, P, TODAY_VIENNA, proposalIdOf, resultJson, type CallResult } from '../src/helpers/erp-local-stack.js';
import { ViesStub } from '../src/helpers/vies-stub.js';
import { PROFILES_DIR } from '../src/helpers/gateway-stack.js';

// ── availability (skip loudly) ───────────────────────────────────────────

const erpManifest = (() => { try { return JSON.parse(readFileSync(ERP_MANIFEST_PATH, 'utf8')); } catch { return null; } })();
const PREINSTALLED = process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
const preinstalledErp = PREINSTALLED ? join(PREINSTALLED, 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js') : '';
const gaps: string[] = [];
if (!erpManifest?.toolGating?.overrides?.create_customer?.checks) gaps.push('a gateway whose erp.json declares create_customer with `checks` (suveren-gateway feat/erp-local-production)');
if (!existsSync(join(PROFILES_DIR, 'master-data', '0.1.profile.json'))) gaps.push('hap-profiles master-data@0.1');
if (!existsSync(join(PROFILES_DIR, 'email', '0.9.profile.json'))) gaps.push('hap-profiles email@0.9');
// The Local production tools ship in erp-mcp 0.10.0 (contract §0). Either the
// manifest pins that release (the gateway installs it from npm, as in CI), or a
// local build that has them is preinstalled.
const pinsRelease = String(erpManifest?.npmVersion ?? '').localeCompare('0.10.0', undefined, { numeric: true }) >= 0;
const preinstalledHasTools = !!preinstalledErp && existsSync(preinstalledErp) && readFileSync(preinstalledErp, 'utf8').includes('check_customer_duplicates');
if (!pinsRelease && !preinstalledHasTools) {
  gaps.push('erp.json pinning erp-mcp >= 0.10.0, or a local build with the Local production tools preinstalled (HAP_E2E_PREINSTALLED_INTEGRATIONS + SUVEREN_OFFLINE=1)');
}
const available = gaps.length === 0;
if (!available) console.warn(`[ERP LOCAL E2E] SKIPPED — needs ${gaps.join('; ')}.`);

// ── profiles and bounds ──────────────────────────────────────────────────

const MASTER_DATA = `${P}/master-data@0.1`;
const INVOICING = `${P}/invoicing@0.1`;
const SALES = `${P}/sales@0.4`;
const EMAIL = `${P}/email@0.9`;

const MD_BOUNDS = {
  profile: MASTER_DATA, read_access: 'unlimited', customer_create_daily_max: 30, customer_update_daily_max: 30,
  customer_tax_daily_max: 30, customer_payment_daily_max: 0, item_create_daily_max: 30, item_update_daily_max: 30,
  item_price_daily_max: 30, list_price_max: 10_000, credit_limit_max: 0,
};
const INV_BOUNDS = {
  profile: INVOICING, read_access: 'unlimited', invoice_net_max: 20_000, credit_net_max: 20_000,
  invoice_net_monthly_max: 100_000, credit_net_monthly_max: 100_000, invoice_daily_max: 30, credit_daily_max: 30,
};
const SALES_BOUNDS = {
  profile: SALES, read_access: 'unlimited', value_max: 20_000, discount_max: 0, order_value_daily_max: 0,
  quote_daily_max: 30, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 0,
};

// ── test data (MUSTER: invented throughout) ──────────────────────────────

const CUSTOMER_DOMAIN = 'kunde-gmbh.example';
const CUSTOMER_EMAIL = `buchhaltung@${CUSTOMER_DOMAIN}`;
const C1 = { name: 'Kunde GmbH', address_lines: ['Kundenweg 2', '4020 Linz'], country: 'AT', uid: 'ATU11111111', email: CUSTOMER_EMAIL, crm_contact_id: 'crm-contact-1' };
const C1_NEW_UID = 'ATU44444444';
const VAT_INVALID = 'ATU22222222';
const DE_UNREACHABLE = { name: 'Nord Anlagen GmbH', address_lines: ['Hafenstraße 4', '20457 Hamburg'], country: 'DE', uid: 'DE333333333' };
const AM1_A = { name: 'Alpen Handel GmbH', address_lines: ['Bergweg 1', '6020 Innsbruck'], country: 'AT', uid: 'ATU55555555' };
const AM1_B = { name: 'Donau Technik GmbH', address_lines: ['Uferstraße 9', '3500 Krems'], country: 'AT', uid: 'ATU66666666' };
const AM1_C = { name: 'Murtal Werkzeug GmbH', address_lines: ['Werkstraße 3', '8720 Knittelfeld'], country: 'AT', uid: 'ATU77777777' };
const NON_EU = { name: 'Zürcher Präzision AG', address_lines: ['Bahnhofstrasse 1', '8001 Zürich'], country: 'CH', uid: 'CHE123456789' };
const SERVICE_PERIOD = { from: '2026-09-01', to: '2026-09-30' };

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const vies = new ViesStub();
let s: ErpLocalStack;

// ── helpers over the stack ───────────────────────────────────────────────

async function propose(tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await s.call(tool, args);
  expect(r.denied, r.text).toBe(false);
  expect(r.text).toMatch(/Awaiting commitment/);
  return proposalIdOf(r.text);
}

async function approveOk(proposalId: string): Promise<any> {
  const done = await s.approve(proposalId);
  expect(done.denied, done.text).toBe(false);
  expect(done.text).toMatch(/executed/);
  return resultJson(done.text);
}

async function read(tool: string, args: Record<string, unknown>): Promise<any> {
  const r = await s.call(tool, args);
  expect(r.denied, r.text).toBe(false);
  return r.json;
}

async function customersByUid(uid: string): Promise<any[]> {
  const j = await read('erp__find_customers', { uid });
  return Array.isArray(j) ? j : j?.customers ?? [];
}

async function customersByName(query: string): Promise<any[]> {
  const j = await read('erp__find_customers', { query });
  return Array.isArray(j) ? j : j?.customers ?? [];
}

async function invoiceCount(): Promise<number> {
  const j = await read('erp__list_invoices', {});
  return (Array.isArray(j) ? j : j?.invoices ?? []).length;
}

/**
 * A blocking refusal: the call is refused, no proposal reaches the AS, the
 * owner's Blocked list gains one `check` entry for this tool naming `field`.
 */
async function expectBlockedBeforeAnyCard(tool: string, args: Record<string, unknown>, field: string, text: RegExp): Promise<CallResult> {
  const pendingBefore = (await s.pendingProposals()).length;
  const blockedBefore = (await s.blocked()).length;
  const r = await s.call(tool, args);
  expect(r.denied, r.text).toBe(true);
  expect(r.text).toMatch(text);
  expect(r.text).toContain('Nothing was proposed and nothing ran');
  expect((await s.pendingProposals()).length, 'no proposal may reach the Authority Server').toBe(pendingBefore);
  const blocked = await s.blocked();
  expect(blocked.length, JSON.stringify(blocked.slice(0, 3))).toBe(blockedBefore + 1);
  expect(blocked[0], JSON.stringify(blocked[0])).toMatchObject({ tool: tool.replace(/^erp__/, ''), integrationId: 'erp', kind: 'check', field, code: 'CHECK_FAILED', who: 'gateway' });
  return r;
}

/** Where a refusal happened — printed so a run log answers it without a debugger. */
function note(what: string, where: string, text: string): void {
  console.error(`[ERP LOCAL E2E] ${what}: ${where} — ${text.replace(/\s+/g, ' ').slice(0, 900)}`);
}

function check(checks: any[], key: string, index?: number): any {
  const c = checks.find((x) => x.key === key && (index === undefined || x.index === index));
  expect(c, `check "${key}" in ${JSON.stringify(checks)}`).toBeTruthy();
  return c;
}

// ── suite ────────────────────────────────────────────────────────────────

describe.skipIf(!available)('ERP Local in production (real AS + gateway + erp-mcp live/local + email-mcp; VIES = local stand-in)', () => {
  beforeAll(async () => {
    const url = await vies.start();
    vies.set(C1.uid, { kind: 'valid', name: 'KUNDE GMBH', address: 'Kundenweg 2, 4020 Linz' });
    vies.set(C1_NEW_UID, { kind: 'valid' });
    vies.set(VAT_INVALID, { kind: 'invalid' });
    vies.set(DE_UNREACHABLE.uid, { kind: 'unavailable' });
    s = new ErpLocalStack({ asPort: 19940, mcpPort: 19941, cpPort: 19942, viesUrl: url, label: 'main', mail: true });
    await s.start();
  }, 300_000);

  afterAll(async () => {
    await s?.stop();
    await vies.stop();
  }, 60_000);

  // ── 1. master-data: review only ────────────────────────────────────────
  describe('1. master-data mandates are review only (Authority Server)', () => {
    it('automatic → refused 422 commitment_mode_not_allowed, nothing signed', async () => {
      const r = await s.submitMandate(MASTER_DATA, MD_BOUNDS, {}, 'E2E: automatic master data', 'automatic');
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.errors?.[0]).toMatchObject({ code: 'commitment_mode_not_allowed', allowed: ['review'] });
      expect(r.body.blob).toBeUndefined();
    });

    it('review_above_cap (well-formed: caps + approver) → refused 422 commitment_mode_not_allowed, nothing signed', async () => {
      const r = await s.submitMandate(MASTER_DATA, MD_BOUNDS, {}, 'E2E: above-cap master data', 'review_above_cap', {
        above_cap_caps: { customer_create_daily_max: 1 }, above_cap_approvers: [s.userId],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.errors?.[0]).toMatchObject({ code: 'commitment_mode_not_allowed', allowed: ['review'] });
      expect(r.body.blob).toBeUndefined();
    });

    it('review → signed; with invoicing, sales and email 0.9 (quote-pdf allowed) mandates the tools are listed', async () => {
      await s.grant(MASTER_DATA, MD_BOUNDS, {}, 'E2E: customers and catalogue, each change approved.');
      await s.grant(INVOICING, INV_BOUNDS, { currency: 'EUR' }, 'E2E: invoices, each approved before it is issued.');
      await s.grant(SALES, SALES_BOUNDS, { currency: 'EUR' }, 'E2E: quotes, each approved before it is issued.');
      await s.grant(EMAIL, { profile: EMAIL, read_access: 'unlimited', recipient_max: 1, send_daily_max: 20, read_max_age_days: 30, setup_daily_max: 0 },
        { allowed_recipients: CUSTOMER_EMAIL, allowed_domains: CUSTOMER_DOMAIN, allowed_attachment_sources: 'erp:quote-pdf' },
        'E2E: send quotes to the customer, each email approved.');
      await new Promise((r) => setTimeout(r, 1_000));
      const names = (await s.agent.listTools()).tools.map((t) => t.name);
      for (const t of ['erp__create_customer', 'erp__update_customer_tax_data', 'erp__create_item', 'erp__update_item_price', 'erp__create_quote', 'erp__create_invoice', 'mail__send_message']) {
        expect(names).toContain(t);
      }
      // Card-only reads are the gateway's, never the AI's.
      for (const t of ['erp__check_vat_id', 'erp__preview_customer_change', 'erp__check_customer_duplicates', 'erp__preview_quote', 'erp__preview_invoice', 'erp__get_document']) {
        expect(names).not.toContain(t);
      }
    });
  });

  // ── 2. customers ───────────────────────────────────────────────────────
  let c1: any;
  let c1Invoice: any;
  describe('2. create_customer → card → approve → ticket; tax-data change; stale revision', () => {
    let proposal = '';

    it('create_customer becomes a proposal; the card carries the VIES result and passing checks; nothing saved yet', async () => {
      proposal = await propose('erp__create_customer', C1);
      const card = await s.cardPreview(proposal);
      expect(card.status).toBe('ok');
      const vat = card.reads.find((r) => r.tool === 'check_vat_id');
      expect(vat?.displayOnly, 'AM1: the VIES read is display-only').toBe(true);
      expect(vat.result.body.structured.vies).toMatchObject({ status: 'valid', name: 'KUNDE GMBH' });
      expect(check(card.checks, 'vat-format').status).toBe('pass');
      expect(check(card.checks, 'vies')).toMatchObject({ status: 'pass', blocking: true });
      expect(check(card.checks, 'vies').detail).toContain(`checked ${TODAY_VIENNA}`);
      expect(check(card.checks, 'vat-duplicate').status).toBe('pass');
      expect(check(card.checks, 'crm-duplicate').status).toBe('pass');
      expect(await customersByUid(C1.uid)).toHaveLength(0);
    });

    it('approved → executed: revision 1, VIES valid with a consultation number, a ticket from the AS under master-data', async () => {
      c1 = await approveOk(proposal);
      expect(c1).toMatchObject({ name: C1.name, country: 'AT', uid: C1.uid, revision: 1, crm_contact_id: C1.crm_contact_id, vies_status: 'valid', tax_mode: 'normal' });
      expect(c1.vies.request_id).toMatch(/^WAPI/);
      const { tickets } = await s.sp.getMyTicketsPage(s.apiKey, { limit: 100 });
      const t = tickets.filter((x: any) => String(x.action).includes('create_customer'));
      expect(t, JSON.stringify(tickets.map((x: any) => x.action))).toHaveLength(1);
      expect(JSON.stringify(t[0])).toContain('master-data');
      expect((await read('erp__get_customer', { id: c1.id })).revision).toBe(1);
    });

    it('an invoice is issued to the customer (the card confirms its VAT ID by VIES)', async () => {
      const id = await propose('erp__create_invoice', {
        customer_id: c1.id, number: '2026-0001', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
        lines: [{ description: 'Beratung September', qty: 10, unit: 'Std.', unit_price: 120, vat_rate: 20 }], net_total: 1200, currency: 'EUR',
      });
      const card = await s.cardPreview(id);
      expect(check(card.checks, 'vies').status).toBe('pass');
      expect(card.checks.find((c) => c.key === 'reverse-charge'), 'no reverse-charge line for a normal-VAT customer').toBeUndefined();
      c1Invoice = await approveOk(id);
      expect(c1Invoice).toMatchObject({ number: '2026-0001', status: 'issued' });
    });

    let taxProposal = '';
    it('update_customer_tax_data (new VAT ID) on a customer with an issued invoice: the card shows the "already issued" line', async () => {
      taxProposal = await propose('erp__update_customer_tax_data', {
        id: c1.id, revision: 1, name: C1.name, address_lines: C1.address_lines, country: 'AT', uid: C1_NEW_UID,
      });
      const card = await s.cardPreview(taxProposal);
      const issued = check(card.checks, 'already-invoiced');
      expect(issued.status).toBe('notice');
      expect(issued.detail).toBe('1 invoice, 0 credit notes — they keep the old data');
      expect(check(card.checks, 'vies').status).toBe('pass');
      expect(check(card.checks, 'vat-duplicate').status).toBe('pass');
      expect(check(card.checks, 'tax-mode').status).toBe('pass');
      expect((await read('erp__get_customer', { id: c1.id })).uid).toBe(C1.uid);
    });

    it('approved → revision 2; the issued invoice keeps the data it was issued with', async () => {
      const after = await approveOk(taxProposal);
      expect(after).toMatchObject({ id: c1.id, revision: 2, uid: C1_NEW_UID, vies_status: 'valid' });
      const inv = await read('erp__get_invoice', { id: '2026-0001' });
      expect(inv.customer).toMatchObject({ uid: C1.uid, revision: 1, source: 'issued' });
      // The old revision stays readable.
      expect((await read('erp__get_customer', { id: c1.id, revision: 1 })).uid).toBe(C1.uid);
    });

    it('a stale revision is refused before any card (blocking "revision" check), naming both versions — nothing changes', async () => {
      const r = await expectBlockedBeforeAnyCard('erp__update_customer_tax_data',
        { id: c1.id, revision: 1, name: 'Kunde GmbH (alt)', address_lines: C1.address_lines, country: 'AT', uid: C1_NEW_UID },
        'revision', /Request is for the record's current version: failed/);
      expect(r.text).toContain('request for version 1, record at version 2');
      const now = await read('erp__get_customer', { id: c1.id });
      expect(now).toMatchObject({ revision: 2, name: C1.name });
    });

    it('race: approval made for revision 2, a newer change lands first → the approved change is refused at execution', async () => {
      const slow = await propose('erp__update_customer_tax_data', {
        id: c1.id, revision: 2, name: 'Kunde GmbH', address_lines: ['Kundenweg 4', '4020 Linz'], country: 'AT', uid: C1_NEW_UID,
      });
      const fast = await propose('erp__update_customer_tax_data', {
        id: c1.id, revision: 2, name: 'Kunde GmbH', address_lines: ['Kundenweg 6', '4020 Linz'], country: 'AT', uid: C1_NEW_UID,
      });
      expect((await approveOk(fast)).revision).toBe(3);
      const done = await s.approve(slow);
      note('race on customer revision', 'refused at execution', done.text);
      expect(done.denied, done.text).toBe(true);
      expect(done.text).toMatch(/revision 3[\s\S]*revision 2|changed/i);
      const now = await read('erp__get_customer', { id: c1.id });
      expect(now).toMatchObject({ revision: 3, address_lines: ['Kundenweg 6', '4020 Linz'] });
    });
  });

  // ── 3. VIES through the stand-in ───────────────────────────────────────
  let deCustomer: any;
  describe('3. VIES (local stand-in via ERP_VIES_URL)', () => {
    it('valid: stored with the execution-time consultation number (see 2.)', async () => {
      const stored = await read('erp__get_customer', { id: c1.id });
      expect(stored.vies.status).toBe('valid');
      expect(stored.vies.request_id).toMatch(/^WAPI/);
      expect(vies.callsFor(C1.uid).length).toBeGreaterThanOrEqual(2); // card + execution
      expect(vies.callsFor(C1.uid)[0].requester).toBe('ATU99999999');
    });

    it('invalid: blocking — refused before any card, a Blocked entry, nothing saved', async () => {
      const calls = vies.callsFor(VAT_INVALID).length;
      await expectBlockedBeforeAnyCard('erp__create_customer',
        { name: 'Falsch GmbH', address_lines: ['Irrweg 1', '1010 Wien'], country: 'AT', uid: VAT_INVALID }, 'vies',
        /VAT ID confirmed by VIES: failed \(invalid\)/);
      expect(vies.callsFor(VAT_INVALID).length).toBeGreaterThan(calls);
      expect(await customersByUid(VAT_INVALID)).toHaveLength(0);
    });

    it('unreachable (HTTP 503): a card with "not checked" and the outage sentence; approval saves it as not checked', async () => {
      const id = await propose('erp__create_customer', DE_UNREACHABLE);
      const card = await s.cardPreview(id);
      const v = check(card.checks, 'vies');
      expect(v.status).toBe('not_checked');
      expect(v.detail).toContain('VIES unreachable (HTTP 503)');
      expect(v.detail).toContain('saving is not blocked while VIES is unreachable');
      deCustomer = await approveOk(id);
      expect(deCustomer).toMatchObject({ uid: DE_UNREACHABLE.uid, vies_status: 'not_checked', tax_mode: 'reverse_charge' });
      expect(deCustomer.vies.reason).toBe('VIES unreachable (HTTP 503)');
    });

    it('AM1: card valid (request id A) → execution valid with request id B — the approval survives, B is stored', async () => {
      vies.set(AM1_A.uid, { kind: 'valid', requestIdentifier: 'WAPI-CARD-A' });
      const id = await propose('erp__create_customer', AM1_A);
      const card = await s.cardPreview(id);
      expect(card.reads.find((r) => r.tool === 'check_vat_id').result.body.structured.vies.request_id).toBe('WAPI-CARD-A');
      vies.set(AM1_A.uid, { kind: 'valid', requestIdentifier: 'WAPI-EXEC-B' });
      const created = await approveOk(id);
      expect(created.vies).toMatchObject({ status: 'valid', request_id: 'WAPI-EXEC-B' });
    });

    it('AM1: card not checked (MS_UNAVAILABLE) → execution valid with a new request id — the approval survives, the flip is stored', async () => {
      vies.set(AM1_B.uid, { kind: 'userError', code: 'MS_UNAVAILABLE' });
      const id = await propose('erp__create_customer', AM1_B);
      expect(check((await s.cardPreview(id)).checks, 'vies').status).toBe('not_checked');
      vies.set(AM1_B.uid, { kind: 'valid', requestIdentifier: 'WAPI-EXEC-C' });
      const created = await approveOk(id);
      expect(created.vies).toMatchObject({ status: 'valid', request_id: 'WAPI-EXEC-C' });
      expect(created.vies_status).toBe('valid');
    });

    it('O11: card valid → execution invalid — the connector refuses at execution, nothing saved', async () => {
      vies.set(AM1_C.uid, { kind: 'valid' });
      const id = await propose('erp__create_customer', AM1_C);
      vies.set(AM1_C.uid, { kind: 'invalid' });
      const done = await s.approve(id);
      expect(done.denied, done.text).toBe(true);
      expect(done.text).toMatch(/VIES reports VAT ID ATU77777777 as not valid/);
      expect(done.text).toContain('Nothing was saved');
      expect(await customersByUid(AM1_C.uid)).toHaveLength(0);
    });
  });

  // ── 4. blocking checks ─────────────────────────────────────────────────
  describe('4. blocking — refused before any proposal, a Blocked entry, nothing in the ERP', () => {
    it('malformed VAT ID (wrong pattern): refused before any card, never sent to VIES', async () => {
      const calls = vies.calls.length;
      await expectBlockedBeforeAnyCard('erp__create_customer',
        { name: 'Format GmbH', address_lines: ['Formweg 1', '1010 Wien'], country: 'AT', uid: 'ATU1234' }, 'vat-format',
        /VAT ID format: failed/);
      expect(vies.calls.length).toBe(calls);
      expect(await customersByName('Format GmbH')).toHaveLength(0);
    });

    it('duplicate VAT ID', async () => {
      const r = await expectBlockedBeforeAnyCard('erp__create_customer',
        { name: 'Zweitkunde GmbH', address_lines: ['Andere Gasse 1', '1010 Wien'], country: 'AT', uid: AM1_A.uid }, 'vat-duplicate',
        /No other customer with this VAT ID: failed/);
      expect(r.text).toMatch(/already customer [0-9a-f-]{36}/);
      expect(await customersByName('Zweitkunde')).toHaveLength(0);
    });

    it('duplicate CRM contact', async () => {
      await expectBlockedBeforeAnyCard('erp__create_customer',
        { name: 'Doppel GmbH', address_lines: ['Doppelweg 2', '1010 Wien'], country: 'AT', crm_contact_id: C1.crm_contact_id }, 'crm-duplicate',
        /No other customer for this CRM contact: failed/);
      expect(await customersByName('Doppel')).toHaveLength(0);
    });

    it('reverse charge without a VIES-valid VAT ID (D1): create_invoice refused before any card', async () => {
      const before = await invoiceCount();
      await expectBlockedBeforeAnyCard('erp__create_invoice', {
        customer_id: deCustomer.id, number: '2026-0100', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
        lines: [{ description: 'Montage', qty: 1, unit_price: 900, vat_rate: 0 }], net_total: 900, currency: 'EUR',
      }, 'reverse-charge', /Reverse charge: VAT ID confirmed by VIES: failed/);
      expect(await invoiceCount()).toBe(before);
    });

    let nonEu: any;
    it('non-EU customer (F3): the customer itself may be saved (VIES not applicable)', async () => {
      const id = await propose('erp__create_customer', NON_EU);
      const card = await s.cardPreview(id);
      expect(check(card.checks, 'vies').status).toBe('notice');
      nonEu = await approveOk(id);
      expect(nonEu).toMatchObject({ country: 'CH', tax_mode: 'unsupported' });
      expect(vies.callsFor(NON_EU.uid)).toHaveLength(0); // never sent outside
    });

    it('non-EU customer (F3): create_invoice refused before any proposal, Blocked entry, nothing issued', async () => {
      const before = await invoiceCount();
      await expectBlockedBeforeAnyCard('erp__create_invoice', {
        customer_id: nonEu.id, number: '2026-0101', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
        lines: [{ description: 'Beratung', qty: 1, unit_price: 500, vat_rate: 0 }], net_total: 500, currency: 'EUR',
      }, 'tax-supported', /Tax treatment supported for this customer: failed/);
      expect(await invoiceCount()).toBe(before);
    });

    it('non-EU customer (F3): create_quote refused before any proposal, Blocked entry, nothing issued', async () => {
      const lq = await read('erp__list_quotes', {});
      const before = (Array.isArray(lq) ? lq : lq?.quotes ?? []).length;
      await expectBlockedBeforeAnyCard('erp__create_quote', {
        customer_id: nonEu.id, number: 'A-2026-090', document_date: TODAY_VIENNA,
        lines: [{ description: 'Beratung', qty: 1, unit_price: 500, vat_rate: 0 }], value: 500, discount_pct: 0, currency: 'EUR',
      }, 'tax-supported', /Tax treatment supported for this customer: failed/);
      const lq2 = await read('erp__list_quotes', {});
      expect((Array.isArray(lq2) ? lq2 : lq2?.quotes ?? []).length).toBe(before);
    });
  });

  // ── 5. quote → PDF → email → invoice ───────────────────────────────────
  describe('5. quote (number from the request) → PDF → email by reference → invoice; AM2', () => {
    const QUOTE_NO = 'A-2026-001';
    const QUOTE_LINES = [{ description: 'Workshop Prozessanalyse', qty: 2, unit: 'Tag', unit_price: 950, vat_rate: 20 }];
    let quoteProposal = '';
    let previewSha = '';
    let quote: any;

    it('create_quote becomes a proposal; the card carries the quote PDF as it will be issued', async () => {
      quoteProposal = await propose('erp__create_quote', {
        customer_id: c1.id, number: QUOTE_NO, document_date: TODAY_VIENNA, lines: QUOTE_LINES,
        value: 1900, discount_pct: 0, currency: 'EUR', valid_until: '2026-12-31',
      });
      const card = await s.cardPreview(quoteProposal);
      const doc = card.reads.find((r) => r.kind === 'document');
      expect(doc?.tool).toBe('preview_quote');
      expect(doc.result.status, JSON.stringify(doc.result).slice(0, 400)).toBe('ok');
      const pdf = doc.result.body.structured ?? JSON.parse(doc.result.body.text);
      const bytes = Buffer.from(pdf.contentBase64, 'base64');
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.sha256).toBe(sha256(bytes));
      previewSha = pdf.sha256;
      const lq = await read('erp__list_quotes', {});
      expect(Array.isArray(lq) ? lq : lq?.quotes ?? []).toHaveLength(0);
    });

    it('approved → the quote is issued under its own number; the archived PDF is the previewed one', async () => {
      quote = await approveOk(quoteProposal);
      expect(quote).toMatchObject({ number: QUOTE_NO, revision: 1, status: 'issued' });
      const got = await read('erp__get_quote', { id: QUOTE_NO });
      expect(got.document?.sha256, JSON.stringify(got).slice(0, 500)).toBe(previewSha);
    });

    it('own series: an invoice may not take the quote\'s number (F4)', async () => {
      const before = await invoiceCount();
      const r = await s.call('erp__create_invoice', {
        customer_id: c1.id, number: QUOTE_NO, document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
        lines: [{ description: 'x', qty: 1, unit_price: 10, vat_rate: 20 }], net_total: 10, currency: 'EUR',
      });
      let text = r.text;
      if (!r.denied) text = (await s.approve(proposalIdOf(r.text))).text;
      note('invoice with the quote number', r.denied ? 'refused at the call' : 'proposal made, refused at execution', text);
      expect(text).toMatch(/already|used|Refused/i);
      expect(await invoiceCount()).toBe(before);
    });

    let mailProposal = '';
    it('send_message with the quote PDF by reference: the card seals the archived file', async () => {
      mailProposal = await propose('mail__send_message', {
        to: [CUSTOMER_EMAIL], subject: `Angebot ${QUOTE_NO}`, body: 'Sehr geehrte Damen und Herren,\n\nanbei unser Angebot.\n\nMaria Muster',
        attachments: [{ connector: 'erp', kind: 'quote-pdf', id: QUOTE_NO }],
      });
      const args = await s.cardArgs(mailProposal);
      const sealed = args._attachmentsSealed?.attachments;
      expect(sealed, JSON.stringify(args).slice(0, 500)).toHaveLength(1);
      expect(sealed[0]).toMatchObject({ connector: 'erp', kind: 'quote-pdf', id: QUOTE_NO, contentType: 'application/pdf', sha256: previewSha });
      const prev = await s.cpGet(`/proposal-status/${mailProposal}/attachment-preview/${previewSha}`);
      expect(prev.body.status, JSON.stringify(prev.body).slice(0, 300)).toBe('ok');
    });

    it('approved → the mailbox holds exactly the archived quote PDF', async () => {
      const sent = await approveOk(mailProposal);
      const msg = await s.mailboxCall('get_message', { id: sent.id });
      expect(msg.to).toEqual([CUSTOMER_EMAIL]);
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]).toMatchObject({ contentType: 'application/pdf', sha256: previewSha });
      const file = await s.mailboxCall('get_attachment', { message_id: sent.id, sha256: previewSha });
      expect(sha256(Buffer.from(file.contentBase64, 'base64'))).toBe(previewSha);
    });

    it('create_invoice {quote_id, quote_revision} → card shows the quote → approved → invoice with the quote\'s lines; quote converted', async () => {
      const id = await propose('erp__create_invoice', {
        customer_id: c1.id, quote_id: QUOTE_NO, quote_revision: 1, number: '2026-0002', document_date: TODAY_VIENNA,
        service_period: SERVICE_PERIOD, net_total: 1900, currency: 'EUR',
      });
      const card = await s.cardPreview(id);
      const q = card.reads.find((r) => r.tool === 'get_quote');
      expect(q?.result?.status, JSON.stringify(q).slice(0, 300)).toBe('ok');
      const inv = await approveOk(id);
      expect(inv).toMatchObject({ number: '2026-0002', status: 'issued', net_total: 1900 });
      const got = await read('erp__get_invoice', { id: '2026-0002' });
      expect(got.quote_id ?? got.quote?.id).toBeTruthy();
      expect(got.lines.map((l: any) => [l.description, l.qty, l.unit_price])).toEqual([['Workshop Prozessanalyse', 2, 950]]);
      expect((await read('erp__get_quote', { id: QUOTE_NO })).status).toBe('converted');
    });

    it('AM2: a quote whose customer changed tax data since → conversion refused, naming both revisions; nothing issued', async () => {
      const am2Customer = await read('erp__find_customers', { uid: AM1_A.uid }).then((j) => (Array.isArray(j) ? j : j.customers)[0]);
      const qid = await propose('erp__create_quote', {
        customer_id: am2Customer.id, number: 'A-2026-002', document_date: TODAY_VIENNA,
        lines: [{ description: 'Wartung', qty: 1, unit_price: 400, vat_rate: 20 }], value: 400, discount_pct: 0, currency: 'EUR',
      });
      await approveOk(qid);
      const tid = await propose('erp__update_customer_tax_data', {
        id: am2Customer.id, revision: am2Customer.revision, name: AM1_A.name, address_lines: ['Neuer Weg 7', '6020 Innsbruck'], country: 'AT', uid: AM1_A.uid,
      });
      const changed = await approveOk(tid);
      expect(changed.revision).toBe(am2Customer.revision + 1);
      const before = await invoiceCount();
      const r = await s.call('erp__create_invoice', {
        customer_id: am2Customer.id, quote_id: 'A-2026-002', quote_revision: 1, number: '2026-0003', document_date: TODAY_VIENNA,
        service_period: SERVICE_PERIOD, net_total: 400, currency: 'EUR',
      });
      let text = r.text;
      if (!r.denied) text = (await s.approve(proposalIdOf(r.text))).text;
      note('AM2 conversion', r.denied ? 'refused at the call' : 'proposal made, refused at execution', text);
      // Since gateway 0.38.0 the manifest's blocking check (customer version pinned by the
      // quote vs. the customer now) refuses at the call — before a card; the connector's own
      // execution-time refusal says "revision", the gateway's check says "version".
      expect(r.denied, text).toBe(true);
      const v = '(?:revision|version)';
      expect(text).toMatch(new RegExp(`${v} ${changed.revision}[\\s\\S]*${v} ${am2Customer.revision}|${v} ${am2Customer.revision}[\\s\\S]*${v} ${changed.revision}`));
      expect(await invoiceCount()).toBe(before);
      expect((await read('erp__get_quote', { id: 'A-2026-002' })).status).toBe('issued');
    });
  });

  // ── 6. catalogue ───────────────────────────────────────────────────────
  describe('6. catalogue: item; off-list price notice; item_revision pin after a price change', () => {
    let item: any;
    it('create_item → card → approved: revision 1', async () => {
      const id = await propose('erp__create_item', { name: 'Beratungsstunde', kind: 'service', unit: 'Std.', list_price: 120, vat_rate: 20, sku: 'B-100' });
      item = await approveOk(id);
      expect(item).toMatchObject({ sku: 'B-100', list_price: 120, vat_rate: 20, revision: 1, active: true });
    });

    it('an invoice line priced off the list: the card shows the "Price vs. list" notice naming both prices; VAT matches', async () => {
      const id = await propose('erp__create_invoice', {
        customer_id: c1.id, number: '2026-0004', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
        lines: [{ item_id: item.id, description: 'Beratung (Sonderpreis)', qty: 3, unit: 'Std.', unit_price: 100, vat_rate: 20 }],
        net_total: 300, currency: 'EUR',
      });
      const card = await s.cardPreview(id);
      const lp = check(card.checks, 'list-price', 1);
      expect(lp.status).toBe('notice');
      expect(lp.detail).toMatch(/line 1: .*100[.,]00.*list price .*120[.,]00/);
      expect(check(card.checks, 'item-vat', 1).status).toBe('pass');
      await s.reject(id);
    });

    it('item_revision pinned to 1, the price changes before approval → the invoice is refused at execution; nothing issued', async () => {
      const pinned = await propose('erp__create_invoice', {
        customer_id: c1.id, number: '2026-0005', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
        lines: [{ item_id: item.id, item_revision: 1, description: 'Beratung', qty: 1, unit: 'Std.', unit_price: 120, vat_rate: 20 }],
        net_total: 120, currency: 'EUR',
      });
      const priceProposal = await propose('erp__update_item_price', { id: item.id, revision: 1, list_price: 130, vat_rate: 20 });
      const pc = await s.cardPreview(priceProposal);
      expect(check(pc.checks, 'price-change').status).toBe('notice');
      expect((await approveOk(priceProposal)).revision).toBe(2);
      const before = await invoiceCount();
      const done = await s.approve(pinned);
      note('pinned item revision after a price change', 'refused at execution', done.text);
      expect(done.denied, done.text).toBe(true);
      expect(done.text).toMatch(/is at revision 2; this request is for revision 1|changed/);
      expect(await invoiceCount()).toBe(before);
    });

    it('a NEW call pinning the old item revision is refused too', async () => {
      const before = await invoiceCount();
      const r = await s.call('erp__create_invoice', {
        customer_id: c1.id, number: '2026-0006', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
        lines: [{ item_id: item.id, item_revision: 1, description: 'Beratung', qty: 1, unit: 'Std.', unit_price: 120, vat_rate: 20 }],
        net_total: 120, currency: 'EUR',
      });
      let text = r.text;
      if (!r.denied) text = (await s.approve(proposalIdOf(r.text))).text;
      note('new call pinning the old item revision', r.denied ? 'refused at the call' : 'proposal made, refused at execution', text);
      // Since gateway 0.38.0 the manifest's blocking item-version check refuses at the call.
      expect(r.denied, text).toBe(true);
      expect(text).toMatch(/item version 1, the item is now at version 2|Item [0-9a-f-]{36} is at revision 2; this request is for revision 1/);
      expect(await invoiceCount()).toBe(before);
    });
  });
});

// ── 7. migration from a 0.9.5 Local DB ───────────────────────────────────

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'erp-local-0.9.5');

describe.skipIf(!available)('7. a Local DB made by erp-mcp 0.9.5, under the new connector, through the gateway', () => {
  const migVies = new ViesStub();
  let m: ErpLocalStack;
  const archived: Record<string, string> = {};
  let creditNoteId = '';

  beforeAll(async () => {
    const url = await migVies.start();
    m = new ErpLocalStack({
      asPort: 19945, mcpPort: 19946, cpPort: 19947, viesUrl: url, label: 'migration',
      beforeGateway: (dataDir) => {
        // As erp-mcp 0.9.5 left it in the gateway's data folder: the SQLite DB and the archive.
        mkdirSync(dataDir, { recursive: true });
        cpSync(join(FIXTURE_DIR, 'erp-local-archive'), join(dataDir, 'erp-local-archive'), { recursive: true });
        const sql = readFileSync(join(FIXTURE_DIR, 'local-db.sql'), 'utf8').split('__DATA_DIR__').join(dataDir);
        // better-sqlite3 from the connector install itself (hap-e2e has no SQLite dependency).
        // Without HAP_E2E_PREINSTALLED_INTEGRATIONS (CI, and a run against the published
        // connector) nothing is installed yet when this runs: install the PINNED package from
        // npm into the gateway's integrations dir exactly as the gateway does
        // (integration-manager.ts: `npm install --no-fund --no-audit <pkg>@<pin>`, cwd = that
        // dir) — the gateway then finds it at the pin and does not install it again.
        const integrationsDir = join(dataDir, 'integrations');
        const pkgJson = join(integrationsDir, 'node_modules', '@humanagencyp', 'erp-mcp', 'package.json');
        if (!existsSync(pkgJson)) {
          mkdirSync(integrationsDir, { recursive: true });
          execFileSync('npm', ['install', '--no-fund', '--no-audit', `${erpManifest.npmPackage}@${erpManifest.npmVersion}`], { cwd: integrationsDir, stdio: 'pipe' });
        }
        const req = createRequire(pkgJson);
        const Database = req('better-sqlite3');
        const raw = new Database(join(dataDir, 'erp-local.sqlite'));
        raw.exec(sql);
        for (const r of raw.prepare('SELECT number, archive_sha256 FROM local_invoices UNION ALL SELECT number, archive_sha256 FROM local_credit_notes').all()) {
          archived[r.number] = r.archive_sha256;
        }
        raw.close();
      },
    });
    await m.start();
    s = m; // the shared helpers above act on `s`
    await m.grant(INVOICING, INV_BOUNDS, { currency: 'EUR' }, 'E2E: invoices and credit notes on the migrated data, each approved.');
    await m.grant(MASTER_DATA, MD_BOUNDS, {}, 'E2E: customer changes on the migrated data, each approved.');
    await new Promise((r) => setTimeout(r, 1_000));
  }, 300_000);

  afterAll(async () => {
    await m?.stop();
    await migVies.stop();
  }, 60_000);

  it('old invoices list and get; their customer data is the migrated snapshot; every archived PDF is untouched', async () => {
    const list = await read('erp__list_invoices', {});
    const rows = Array.isArray(list) ? list : list.invoices;
    expect(rows.map((r: any) => r.number).sort()).toEqual(['F-2026-001', 'F-2026-002', 'F-2026-003']);
    const inv = await read('erp__get_invoice', { id: 'F-2026-002' });
    expect(inv.customer).toEqual({
      name: 'Kessler Anlagenbau GmbH', address_lines: ['Hafenstraße 4', '20457 Hamburg', 'Deutschland'],
      country: 'DE', uid: 'DE123456789', revision: 1, source: 'migrated',
    });
    for (const [number, sha] of Object.entries(archived)) {
      expect(sha256(readFileSync(join(m.dataDir, 'erp-local-archive', '2026', `${number}.pdf`))), number).toBe(sha);
    }
    const notes = await read('erp__list_credit_notes', {});
    expect((Array.isArray(notes) ? notes : notes.credit_notes).map((n: any) => n.number).sort()).toEqual(['F-2026-004', 'F-2026-005']);
  });

  it('the customer changes address (new revision); a credit note on the old invoice renders the migrated snapshot', async () => {
    const cust = await read('erp__get_customer', { id: 'c-at-0002' });
    expect(cust.revision).toBe(1);
    const tid = await propose('erp__update_customer_tax_data', {
      id: 'c-at-0002', revision: 1, name: 'Huber Werbetechnik e.U.', address_lines: ['Neue Straße 10', '4020 Linz', 'Österreich'], country: 'AT', uid: null,
    });
    const card = await s.cardPreview(tid);
    expect(card.checks.find((c) => c.key === 'already-invoiced'), 'address only: no "already issued" line').toBeUndefined();
    expect((await approveOk(tid)).revision).toBe(2);

    const cid = await propose('erp__create_credit_note', {
      invoice_id: 'F-2026-003', number: 'F-2026-006', document_date: TODAY_VIENNA, credit_total: 150, currency: 'EUR', reason: 'Storno',
    });
    const cn = await approveOk(cid);
    expect(cn).toMatchObject({ number: 'F-2026-006' });
    creditNoteId = cn.id;
    const got = await read('erp__get_credit_note', { id: cn.id });
    expect(got.customer).toMatchObject({ name: 'Huber Werbetechnik e.U.', address_lines: ['Hauptplatz 3', '4020 Linz', 'Österreich'], country: 'AT', uid: null, revision: 1 });
    expect(cn.archive_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(readFileSync(cn.archive_path))).toBe(cn.archive_sha256);
    // The archived PDF prints the old address, not the new one (uncompressed pdfmake output; text as hex glyph runs is
    // not searchable, so this asserts what the connector reports it rendered from).
    expect((await read('erp__get_invoice', { id: 'F-2026-003' })).status).toBe('credited');
    // Old PDFs still untouched after the new writes.
    for (const [number, sha] of Object.entries(archived)) {
      expect(sha256(readFileSync(join(m.dataDir, 'erp-local-archive', '2026', `${number}.pdf`))), number).toBe(sha);
    }
  });

  it('get_credit_note answers by number too, as its schema says ("Credit note ID or number")', async () => {
    expect(creditNoteId, 'the credit note of the previous step').not.toBe('');
    const byNumber = await s.call('erp__get_credit_note', { id: 'F-2026-006' });
    expect(byNumber.denied, byNumber.text).toBe(false);
    expect(byNumber.json?.id).toBe(creditNoteId);
  });
});

// ── optional: the REAL EU VIES ───────────────────────────────────────────

const REAL_VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
/** A publicly known VAT ID (Google Ireland Limited) — used only for this opt-in reachability check. */
const PUBLIC_VALID_VAT = { country: 'IE', uid: 'IE6388047V' };

async function realViesReachable(): Promise<string | null> {
  try {
    const res = await fetch(REAL_VIES_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ countryCode: 'IE', vatNumber: '6388047V' }), signal: AbortSignal.timeout(8_000),
    });
    const body = await res.json().catch(() => null) as any;
    if (res.status >= 500 || !body) return `HTTP ${res.status}`;
    if (body.userError && !['VALID', 'INVALID'].includes(body.userError)) return `VIES answered ${body.userError}`;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe.skipIf(!available || !preinstalledHasTools)('optional: the real EU VIES (skips without network or without a preinstalled erp-mcp build)', () => {
  let why: string | null = 'not probed';
  beforeAll(async () => {
    why = await realViesReachable();
    if (why) console.warn(`[ERP LOCAL E2E] real-VIES test SKIPPED — ec.europa.eu VIES not usable from here (${why}). Run by hand with network.`);
  }, 20_000);

  it('the connector itself (no ERP_VIES_URL) checks a public VAT ID against ec.europa.eu: valid', async (ctx) => {
    if (why) ctx.skip();
    const dataDir = join(tmpdir(), `hap-e2e-real-vies-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    const company = join(dataDir, 'company.json');
    writeFileSync(company, JSON.stringify(COMPANY));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ERP_') && k !== 'DATABASE_URL') env[k] = v;
    const client = new Client({ name: 'real-vies', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [preinstalledErp], stderr: 'ignore',
      env: { ...env, HAP_DATA_DIR: dataDir, ERP_MODE: 'live', ERP_LIVE_ADAPTER: 'local', ERP_LIVE_COMPANY_FILE: company },
    }));
    try {
      const r = await client.callTool({ name: 'check_vat_id', arguments: PUBLIC_VALID_VAT });
      const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
      const out = JSON.parse(text);
      expect(out.format).toBe('ok');
      // The company's own (invented) VAT ID is refused as requester → checked without a consultation number.
      expect(out.vies.status, text).toBe('valid');
    } finally {
      await client.close().catch(() => {});
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
