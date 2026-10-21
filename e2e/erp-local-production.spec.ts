/**
 * ERP Local in production — the approval card in a browser, on its own real
 * stack (Authority Server + gateway + erp-mcp live/local; VIES = the local
 * stand-in, src/helpers/vies-stub.ts). The behaviour itself (checks, blocking,
 * VIES, quotes, catalogue, migration) is proven in
 * test/erp-local-production.test.ts against the control plane's card data;
 * this spec checks what a person sees.
 *
 * Its own stack (src/helpers/erp-local-stack.ts, ports 19950–19952) rather than
 * the shared Playwright gateway: the erp connector here runs in live mode
 * "local", which the shared gateway's AU8/AU10 specs must not inherit.
 *
 * PENDING (UI not finished at the gateway branch head this was written
 * against, suveren-gateway feat/erp-local-production @ 3c139d0): the manifest
 * `checks` line (pass ✓ / fail ✕ red / not checked – / notice) is not rendered
 * by ApprovalBody yet — the card shows only the per-call limit checks. Those
 * cases are `test.fixme` below with what they must show; drop the fixme when
 * the UI lands (UI spec suveren-as/docs/ui-spec, "checks line").
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, openApprovalCard } from './fixtures';
import { ErpLocalStack, ERP_MANIFEST_PATH, P, TODAY_VIENNA, proposalIdOf } from '../src/helpers/erp-local-stack.js';
import { ViesStub } from '../src/helpers/vies-stub.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SCREENSHOT_DIR = join(__dirname, '..', 'test-results', 'erp-local-production');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const manifest = (() => { try { return JSON.parse(readFileSync(ERP_MANIFEST_PATH, 'utf8')); } catch { return null; } })();
const PRE = process.env.HAP_E2E_PREINSTALLED_INTEGRATIONS;
const preErp = PRE ? join(PRE, 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js') : '';
const AVAILABLE = !!manifest?.toolGating?.overrides?.create_customer?.checks
  && existsSync(join(ROOT, 'hap-profiles', 'master-data', '0.1.profile.json'))
  && ((!!preErp && existsSync(preErp) && readFileSync(preErp, 'utf8').includes('check_customer_duplicates'))
    || String(manifest?.npmVersion ?? '').localeCompare('0.10.0', undefined, { numeric: true }) >= 0);
/** The UI renders manifest checks once ApprovalBody knows them (any of these markers). */
const APPROVAL_BODY = join(ROOT, 'suveren-gateway', 'apps', 'ui', 'src', 'components', 'ApprovalBody.tsx');
const UI_HAS_CHECKS = existsSync(join(ROOT, 'suveren-gateway', 'apps', 'ui', 'src', 'components', 'ChecksLines.tsx'))
  || (existsSync(APPROVAL_BODY) && /manifestChecks|ChecksLines|preview\.checks/.test(readFileSync(APPROVAL_BODY, 'utf8')));

const MASTER_DATA = `${P}/master-data@0.1`;
const INVOICING = `${P}/invoicing@0.1`;
const MD_BOUNDS = {
  profile: MASTER_DATA, read_access: 'unlimited', customer_create_daily_max: 10, customer_update_daily_max: 10,
  customer_tax_daily_max: 10, customer_payment_daily_max: 0, item_create_daily_max: 10, item_update_daily_max: 10,
  item_price_daily_max: 10, list_price_max: 10_000, credit_limit_max: 0,
};
const INV_BOUNDS = {
  profile: INVOICING, read_access: 'unlimited', invoice_net_max: 20_000, credit_net_max: 20_000,
  invoice_net_monthly_max: 100_000, credit_net_monthly_max: 100_000, invoice_daily_max: 10, credit_daily_max: 10,
};
const CUSTOMER = { name: 'Kunde GmbH', address_lines: ['Kundenweg 2', '4020 Linz'], country: 'AT', uid: 'ATU11111111', email: 'buchhaltung@kunde-gmbh.example' };
const OUTAGE = { name: 'Nord Anlagen GmbH', address_lines: ['Hafenstraße 4', '20457 Hamburg'], country: 'DE', uid: 'DE333333333' };

async function signIn(page: Page, cpUrl: string, apiKey: string): Promise<void> {
  await page.goto(`${cpUrl}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').fill(apiKey);
  await page.locator('button:has-text("Sign In")').click();
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 45_000 });
  await expect(page.locator('.page-title')).toBeVisible({ timeout: 15_000 });
}

async function openApprovals(page: Page): Promise<void> {
  await page.click('.sidebar-item:has-text("Approvals")');
  await page.waitForURL('**/approvals');
  const awaiting = page.locator('.nav-tab:has-text("Awaiting me")');
  if (await awaiting.count()) await awaiting.click();
}

test.describe.serial('ERP Local in production — the approval card (own real stack)', () => {
  test.skip(!AVAILABLE, 'needs the gateway erp.json with `checks`, hap-profiles master-data@0.1 and a preinstalled erp-mcp with the Local production tools');

  const vies = new ViesStub();
  let s: ErpLocalStack;
  let customerProposal = '';
  let outageProposal = '';
  let customerId = '';
  let taxProposal = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // The Playwright run uses the gateway build the suite already made (fixtures.ts spawns its dist too).
    process.env.HAP_E2E_PREBUILT = '1';
    const url = await vies.start();
    vies.set(CUSTOMER.uid, { kind: 'valid', name: 'KUNDE GMBH', address: 'Kundenweg 2, 4020 Linz', requestIdentifier: 'WAPI-CARD-0001' });
    vies.set(OUTAGE.uid, { kind: 'unavailable' });
    vies.set('ATU44444444', { kind: 'valid' });
    s = new ErpLocalStack({ asPort: 19950, mcpPort: 19951, cpPort: 19952, viesUrl: url, label: 'pw' });
    await s.start();
    await s.grant(MASTER_DATA, MD_BOUNDS, {}, 'E2E: customers, each change approved.');
    await s.grant(INVOICING, INV_BOUNDS, { currency: 'EUR' }, 'E2E: invoices, each approved.');
    await new Promise((r) => setTimeout(r, 1_000));
    customerProposal = proposalIdOf((await s.call('erp__create_customer', CUSTOMER)).text);
    outageProposal = proposalIdOf((await s.call('erp__create_customer', OUTAGE)).text);
  });

  test.afterAll(async () => {
    await s?.stop();
    await vies.stop();
  });

  test('create_customer card: the manifest summary, the bound values with their labels, the VIES answer from the system', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, s.cpUrl, s.apiKey);
    await openApprovals(page);
    const card = await openApprovalCard(page, /Kunde GmbH/);
    // Summary sentence from erp.json — never from the AI.
    await expect(page.locator('[data-testid="approval-row"].is-open [data-testid="approval-row-summary"]').or(card).first())
      .toContainText('New customer Kunde GmbH, AT — VAT ID ATU11111111', { timeout: 20_000 });
    await expect(card.locator('[data-preview-status="ok"]').first()).toBeVisible({ timeout: 45_000 });
    // Sealed values, manifest labels.
    for (const t of ['VAT ID', 'ATU11111111', 'Kundenweg 2', '4020 Linz']) await expect(card).toContainText(t);
    // From the system: what VIES returned (its consultation number), marked as read by the gateway.
    await expect(card).toContainText('WAPI-CARD-0001');
    await expect(card).toContainText('KUNDE GMBH');
    await expect(card).toContainText('Read by the gateway, not by the AI');
    await expect(card).toContainText('from the system — read by the gateway, not by the AI');
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'create-customer-card.png') });
  });

  test('create_customer card: the VIES read under the manifest labels, hidden fields hidden, the duplicates read not shown as a section', async ({ page }) => {
    test.fixme(!UI_HAS_CHECKS, 'PENDING UI: at the branch head the read fields render as one raw run-on line ("VIES result valid, —, <iso>, <id>, …"), ' +
      'display.labels/hidden for attached reads are not applied, and the `as: duplicates` read is rendered as its own section');
    test.setTimeout(120_000);
    await signIn(page, s.cpUrl, s.apiKey);
    await openApprovals(page);
    const card = await openApprovalCard(page, /Kunde GmbH/);
    await expect(card.locator('[data-preview-status="ok"]').first()).toBeVisible({ timeout: 45_000 });
    await expect(card).toContainText('Name at VIES');
    await expect(card).toContainText('Address at VIES');
    await expect(card).toContainText('Consultation no.');
    await expect(card).not.toContainText('Another customer has it');
    await expect(card).not.toContainText('Check customer duplicates');
  });

  test('approving in the browser creates the customer — the ticket is the Authority Server\'s', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, s.cpUrl, s.apiKey);
    await openApprovals(page);
    const card = await openApprovalCard(page, /Kunde GmbH/);
    await card.locator('button:has-text("Approve")').first().click();
    const done = await s.awaitExecution(customerProposal);
    expect(done.denied, done.text).toBe(false);
    customerId = JSON.parse(done.text.slice(done.text.indexOf('Result:') + 7)).id;
    const { tickets } = await s.sp.getMyTicketsPage(s.apiKey, { limit: 50 });
    expect(tickets.some((t: any) => String(t.action).includes('create_customer'))).toBe(true);
  });

  test('checks line: VIES unreachable reads "not checked" with the reason and the outage sentence, nothing red', async ({ page }) => {
    test.fixme(!UI_HAS_CHECKS, 'PENDING UI: the manifest checks line is not rendered by the gateway under test');
    test.setTimeout(120_000);
    await signIn(page, s.cpUrl, s.apiKey);
    await openApprovals(page);
    const card = await openApprovalCard(page, /Nord Anlagen GmbH/);
    await expect(card).toContainText('VAT ID confirmed by VIES', { timeout: 45_000 });
    await expect(card).toContainText('not checked');
    await expect(card).toContainText('VIES unreachable (HTTP 503)');
    await expect(card).toContainText('saving is not blocked while VIES is unreachable');
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'create-customer-vies-not-checked.png') });
    void outageProposal;
  });

  test('checks line: a tax-data change on an invoiced customer shows "Already issued to this customer" as a notice', async ({ page }) => {
    test.fixme(!UI_HAS_CHECKS, 'PENDING UI: the manifest checks line is not rendered by the gateway under test');
    test.setTimeout(180_000);
    expect(customerId, 'created by the approval test').not.toBe('');
    const inv = await s.call('erp__create_invoice', {
      customer_id: customerId, number: '2026-0001', document_date: TODAY_VIENNA, service_period: { from: '2026-09-01', to: '2026-09-30' },
      lines: [{ description: 'Beratung', qty: 1, unit_price: 100, vat_rate: 20 }], net_total: 100, currency: 'EUR',
    });
    const issued = await s.approve(proposalIdOf(inv.text));
    expect(issued.denied, issued.text).toBe(false);
    taxProposal = proposalIdOf((await s.call('erp__update_customer_tax_data', {
      id: customerId, revision: 1, name: CUSTOMER.name, address_lines: CUSTOMER.address_lines, country: 'AT', uid: 'ATU44444444',
    })).text);
    await signIn(page, s.cpUrl, s.apiKey);
    await openApprovals(page);
    const card = await openApprovalCard(page, /Change tax data of customer/);
    await expect(card).toContainText('Already issued to this customer', { timeout: 45_000 });
    await expect(card).toContainText('1 invoices, 0 credit notes — they keep the old data');
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'tax-data-already-issued.png') });
    void taxProposal;
  });
});
