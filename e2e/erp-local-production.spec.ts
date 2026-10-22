/**
 * ERP Local in production — what a person sees, in a browser, on its own real
 * stack (Authority Server + gateway + erp-mcp live/local; VIES = the local
 * stand-in src/helpers/vies-stub.ts, reached through the connector's own
 * "VAT-ID check address" setting). The behaviour behind it (checks, blocking,
 * VIES, quotes, catalogue, migration) is proven in
 * test/erp-local-production.test.ts; this spec checks the signed-off card
 * (UI spec §4.2.2 checks line, revised 2026-10-21, mockup temp/erp-checks-mockup):
 *
 *  - checks line: one line per check — pass ✓ quiet, not checked "–" bold in a
 *    dashed frame, notice a plain line with a thin edge; no red line on a card
 *    (a failing blocking check never reaches one);
 *  - the VIES answer in its own "From EU VIES — checked <time>" box OUTSIDE the
 *    sealed values (display-only, asked again on save);
 *  - a tax-data change as a Now / New table, plus the "already issued" notice;
 *  - an invoice line priced off the list: the "Price vs. list" notice;
 *  - a quote: the PDF as it will be issued;
 *  - a refused request (VIES invalid): a "Blocked — a check failed" entry.
 *
 * Its own stack (src/helpers/erp-local-stack.ts, ports 19950–19952) rather than
 * the shared Playwright gateway: the erp connector here runs in live mode
 * "local", which the shared gateway's AU8/AU10 specs must not inherit.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect, openApprovalCard, selectQueueView } from './fixtures';
import { ErpLocalStack, ERP_MANIFEST_PATH, P, TODAY_VIENNA, proposalIdOf, resultJson } from '../src/helpers/erp-local-stack.js';
import { ViesStub } from '../src/helpers/vies-stub.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SCREENSHOT_DIR = join(__dirname, '..', 'test-results', 'erp-local-production');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const manifest = (() => { try { return JSON.parse(readFileSync(ERP_MANIFEST_PATH, 'utf8')); } catch { return null; } })();
const PRE = process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
const preErp = PRE ? join(PRE, 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js') : '';
const AVAILABLE = !!manifest?.credentials?.envMapping?.ERP_VIES_URL
  && existsSync(join(ROOT, 'suveren-gateway', 'apps', 'ui', 'src', 'components', 'ChecksLines.tsx'))
  && existsSync(join(ROOT, 'hap-profiles', 'master-data', '0.1.profile.json'))
  && ((!!preErp && existsSync(preErp) && readFileSync(preErp, 'utf8').includes('check_customer_duplicates'))
    || String(manifest?.npmVersion ?? '').localeCompare('0.10.0', undefined, { numeric: true }) >= 0);

const MASTER_DATA = `${P}/master-data@0.1`;
const INVOICING = `${P}/invoicing@0.1`;
const SALES = `${P}/sales@0.4`;
const MD_BOUNDS = {
  profile: MASTER_DATA, read_access: 'unlimited', customer_create_daily_max: 10, customer_update_daily_max: 10,
  customer_tax_daily_max: 10, customer_payment_daily_max: 0, item_create_daily_max: 10, item_update_daily_max: 10,
  item_price_daily_max: 10, list_price_max: 10_000, credit_limit_max: 0,
};
const INV_BOUNDS = {
  profile: INVOICING, read_access: 'unlimited', invoice_net_max: 20_000, credit_net_max: 20_000,
  invoice_net_monthly_max: 100_000, credit_net_monthly_max: 100_000, invoice_daily_max: 10, credit_daily_max: 10,
};
const SALES_BOUNDS = {
  profile: SALES, read_access: 'unlimited', value_max: 20_000, discount_max: 0, order_value_daily_max: 0,
  quote_daily_max: 10, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 0,
};
const CUSTOMER = { name: 'Kunde GmbH', address_lines: ['Kundenweg 2', '4020 Linz'], country: 'AT', uid: 'ATU11111111', email: 'buchhaltung@kunde-gmbh.example' };
const OUTAGE = { name: 'Nord Anlagen GmbH', address_lines: ['Hafenstraße 4', '20457 Hamburg'], country: 'DE', uid: 'DE333333333' };
const INVALID = { name: 'Falsch GmbH', address_lines: ['Irrweg 1', '1010 Wien'], country: 'AT', uid: 'ATU22222222' };
const NEW_UID = 'ATU44444444';
const SERVICE_PERIOD = { from: '2026-09-01', to: '2026-09-30' };

async function signIn(page: Page, cpUrl: string, apiKey: string): Promise<void> {
  await page.goto(`${cpUrl}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').fill(apiKey);
  await page.locator('button:has-text("Sign In")').click();
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 45_000 });
  await expect(page.locator('.page-title')).toBeVisible({ timeout: 15_000 });
}

async function openCard(page: Page, s: ErpLocalStack, hasText: string | RegExp): Promise<Locator> {
  await signIn(page, s.cpUrl, s.apiKey);
  await page.click('.sidebar-item:has-text("Approvals")');
  await page.waitForURL('**/approvals');
  await selectQueueView(page, 'me');
  const card = await openApprovalCard(page, hasText);
  await expect(card.locator('[data-preview-status="ok"]').first()).toBeVisible({ timeout: 45_000 });
  return card;
}

/** The checks line of a card, and the one rule that holds on every card: no red line on it. */
async function checksOf(card: Locator): Promise<Locator> {
  const body = card.getByTestId('card-checks-body');
  await expect(body).toBeVisible({ timeout: 30_000 });
  // v3: the passed checks are one folded row ("✓ N checks passed") — open it so its lines are visible too.
  // (Folds are an accordion — open only this one.)
  await card.getByTestId('checks-passed').evaluateAll((ds) => ds.forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  await expect(card.getByTestId('card-checks-top')).toHaveCount(0);
  await expect(card.locator('[data-check-status="fail"]')).toHaveCount(0);
  return body;
}

function line(checks: Locator, status: 'pass' | 'not_checked' | 'notice', text: string | RegExp): Locator {
  return checks.locator(`[data-check-status="${status}"]`, { hasText: text });
}

test.describe.serial('ERP Local in production — the approval card and Blocked (own real stack)', () => {
  test.skip(!AVAILABLE, 'needs a gateway with the erp.json VIES address setting and ChecksLines, hap-profiles master-data@0.1, and erp-mcp with the Local production tools');

  const vies = new ViesStub();
  let s: ErpLocalStack;
  let customerId = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // The Playwright run uses the gateway build the suite already made (fixtures.ts spawns its dist too).
    process.env.HAP_E2E_PREBUILT = '1';
    const url = await vies.start();
    vies.set(CUSTOMER.uid, { kind: 'valid', name: 'KUNDE GMBH', address: 'Kundenweg 2, 4020 Linz', requestIdentifier: 'WAPI-CARD-0001' });
    vies.set(OUTAGE.uid, { kind: 'unavailable' });
    vies.set(INVALID.uid, { kind: 'invalid' });
    vies.set(NEW_UID, { kind: 'valid' });
    s = new ErpLocalStack({ asPort: 19950, mcpPort: 19951, cpPort: 19952, viesUrl: url, label: 'pw' });
    await s.start();
    await s.grant(MASTER_DATA, MD_BOUNDS, {}, 'E2E: customers and catalogue, each change approved.');
    await s.grant(INVOICING, INV_BOUNDS, { currency: 'EUR' }, 'E2E: invoices, each approved.');
    await s.grant(SALES, SALES_BOUNDS, { currency: 'EUR' }, 'E2E: quotes, each approved.');
    await new Promise((r) => setTimeout(r, 1_000));
  });

  test.afterAll(async () => {
    await s?.stop();
    await vies.stop();
  });

  test('create_customer: summary, sealed values, passing checks, and the VIES answer in its own box outside the sealed values', async ({ page }) => {
    test.setTimeout(120_000);
    const proposal = proposalIdOf((await s.call('erp__create_customer', CUSTOMER)).text);
    const card = await openCard(page, s, /Kunde GmbH/);
    await expect(card.getByTestId('approval-summary').or(card).first())
      .toContainText('New customer Kunde GmbH, AT — VAT ID ATU11111111');
    for (const t of ['VAT ID', 'ATU11111111', 'Kundenweg 2', '4020 Linz']) await expect(card).toContainText(t);

    const checks = await checksOf(card);
    for (const label of ['VAT ID format', 'VAT ID confirmed by VIES', 'No other customer with this VAT ID']) {
      await expect(line(checks, 'pass', label)).toHaveCount(1);
      await expect(line(checks, 'pass', label).locator('.check-mark')).toHaveText('✓');
    }
    await expect(line(checks, 'pass', 'VAT ID confirmed by VIES')).toContainText(`checked ${TODAY_VIENNA}`);

    const box = card.getByTestId('system-box');
    await expect(box).toHaveCount(1);
    await expect(box.locator('.system-box-heading')).toContainText(/^From EU VIES — checked /);
    for (const t of ['Name at VIES', 'KUNDE GMBH', 'Address at VIES', 'Kundenweg 2, 4020 Linz', 'Consultation no.', 'WAPI-CARD-0001']) await expect(box).toContainText(t);
    await expect(box).toContainText('Shown for this decision only. It is asked again when this is saved; that answer is stored.');
    // Outside the sealed values, and hidden fields stay hidden; the duplicates read is input for checks only.
    await expect(card.locator('.sealed, [data-sealed]').filter({ hasText: 'WAPI-CARD-0001' })).toHaveCount(0);
    await expect(card).not.toContainText('Another customer has it');
    await expect(card).not.toContainText('Check customer duplicates');
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'create-customer-card.png') });

    await card.locator('button:has-text("Approve")').first().click();
    const done = await s.awaitExecution(proposal);
    expect(done.denied, done.text).toBe(false);
    customerId = resultJson(done.text).id;
    const { tickets } = await s.sp.getMyTicketsPage(s.apiKey, { limit: 50 });
    expect(tickets.some((t: any) => String(t.action).includes('create_customer'))).toBe(true);
  });

  test('VIES unreachable: "not checked" in a dashed frame with the reason and the outage sentence — nothing red', async ({ page }) => {
    test.setTimeout(120_000);
    const proposal = proposalIdOf((await s.call('erp__create_customer', OUTAGE)).text);
    const card = await openCard(page, s, /Nord Anlagen GmbH/);
    const checks = await checksOf(card);
    const nc = line(checks, 'not_checked', 'VAT ID confirmed by VIES');
    await expect(nc).toHaveCount(1);
    await expect(nc).toHaveClass(/check-not-checked/);
    await expect(nc.locator('.check-mark')).toHaveText('–');
    await expect(nc).toContainText('VAT ID confirmed by VIES: not checked');
    await expect(nc).toContainText('VIES unreachable (HTTP 503)');
    await expect(nc).toContainText('saving is not blocked while VIES is unreachable');
    // "not checked" comes first (what needs attention), before the passed checks.
    await expect(checks.locator('.check-line').first()).toHaveAttribute('data-check-status', 'not_checked');
    await expect(card.getByTestId('system-box')).toHaveCount(0); // VIES gave no answer to show
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'create-customer-vies-not-checked.png') });
    await s.reject(proposal);
  });

  test('tax-data change on an invoiced customer: Now / New table and the "already issued" notice', async ({ page }) => {
    test.setTimeout(180_000);
    expect(customerId, 'created in the first test').not.toBe('');
    const inv = await s.call('erp__create_invoice', {
      customer_id: customerId, number: '2026-0001', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
      lines: [{ description: 'Beratung', qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100, currency: 'EUR',
    });
    expect((await s.approve(proposalIdOf(inv.text))).denied).toBe(false);
    const proposal = proposalIdOf((await s.call('erp__update_customer_tax_data', {
      id: customerId, revision: 1, name: CUSTOMER.name, address_lines: ['Kundenweg 9', '4020 Linz'], country: 'AT', uid: NEW_UID,
    })).text);
    const card = await openCard(page, s, /Change tax data of customer/);

    const table = card.getByTestId('compare-table');
    await expect(table).toHaveCount(1);
    await expect(table.locator('thead')).toContainText('Now (from');
    await expect(table.locator('thead')).toContainText('New');
    const uidRow = table.locator('tr', { hasText: 'VAT ID' });
    await expect(uidRow.locator('.compare-now')).toContainText('ATU11111111');
    await expect(uidRow.locator('.compare-new')).toContainText(NEW_UID);
    const addrRow = table.locator('tr', { hasText: 'Address' });
    await expect(addrRow.locator('.compare-now')).toContainText('Kundenweg 2');
    await expect(addrRow.locator('.compare-new')).toContainText('Kundenweg 9');

    const checks = await checksOf(card);
    const issued = line(checks, 'notice', 'Already issued to this customer');
    await expect(issued).toHaveCount(1);
    await expect(issued).toHaveClass(/check-notice/);
    await expect(issued).toContainText('Already issued to this customer: 1 invoice, 0 credit notes — they keep the old data');
    await expect(line(checks, 'pass', 'New VAT ID confirmed by VIES')).toHaveCount(1);
    // `showOnly: "fail"` (gateway 0.38.0): the version check still runs and blocks, but a pass is not shown.
    await expect(card.getByText('Request is for the record\'s current version')).toHaveCount(0);
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'tax-data-now-new-already-issued.png') });
    await s.reject(proposal);
  });

  test('invoice line priced off the list: the "Price vs. list" notice names both prices', async ({ page }) => {
    test.setTimeout(180_000);
    const itemDone = await s.approve(proposalIdOf((await s.call('erp__create_item', {
      name: 'Beratungsstunde', kind: 'service', unit: 'Std.', list_price: 120, vat_rate: 20, sku: 'B-100',
    })).text));
    expect(itemDone.denied, itemDone.text).toBe(false);
    const item = resultJson(itemDone.text);
    const proposal = proposalIdOf((await s.call('erp__create_invoice', {
      customer_id: customerId, number: '2026-0002', document_date: TODAY_VIENNA, service_period: SERVICE_PERIOD,
      lines: [{ item_id: item.id, description: 'Beratung (Sonderpreis)', qty: 3, unit: 'Std.', unit_price: 100, vat_rate: 20 }],
      net_total: 300, currency: 'EUR',
    })).text);
    const card = await openCard(page, s, /2026-0002/);
    const checks = await checksOf(card);
    const lp = line(checks, 'notice', 'Price vs. list');
    await expect(lp).toHaveCount(1);
    await expect(lp).toContainText(/Price vs\. list: line 1: .*100[.,]00.*list price .*120[.,]00/);
    await expect(line(checks, 'pass', 'VAT vs. item')).toHaveCount(1);
    await expect(card.getByTestId('document-preview')).toBeVisible();
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'invoice-price-vs-list.png') });
    await s.reject(proposal);
  });

  test('create_quote: the quote PDF as it will be issued', async ({ page }) => {
    test.setTimeout(120_000);
    const proposal = proposalIdOf((await s.call('erp__create_quote', {
      customer_id: customerId, number: 'A-2026-001', document_date: TODAY_VIENNA,
      lines: [{ description: 'Workshop Prozessanalyse', qty: 2, unit: 'Tag', unit_price: 950, vat_rate: 20 }],
      value: 1900, discount_pct: 0, currency: 'EUR',
    })).text);
    const card = await openCard(page, s, /A-2026-001/);
    const pdf = card.getByTestId('document-preview');
    await expect(pdf).toBeVisible({ timeout: 45_000 });
    await expect(pdf).toContainText('The PDF as it will be issued');
    await expect(pdf.locator('.document-preview-filename')).toContainText('A-2026-001');
    await expect(pdf).toContainText('Fingerprint');
    await expect(pdf.locator('object[type="application/pdf"]')).toHaveCount(1);
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'quote-pdf.png') });
    await s.reject(proposal);
  });

  test('VIES invalid: no card — the Blocked page shows "Blocked — a check failed"', async ({ page }) => {
    test.setTimeout(120_000);
    const r = await s.call('erp__create_customer', INVALID);
    expect(r.denied, r.text).toBe(true);
    await signIn(page, s.cpUrl, s.apiKey);
    await page.click('.sidebar-item:has-text("Blocked")');
    await page.waitForURL('**/blocked');
    const item = page.locator('.blocked-item', { hasText: 'Blocked — a check failed' }).first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText('create_customer');
    await expect(item).toContainText('VAT ID confirmed by VIES');
    await expect(item).toContainText('Nothing ran and no approval was asked for.');
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'blocked-check-failed.png'), fullPage: true });
  });
});
