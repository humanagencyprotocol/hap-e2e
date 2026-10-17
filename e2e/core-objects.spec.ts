/**
 * Core objects — approvals, mandates, tickets (UI spec §12, suveren-as
 * docs/ui-spec; signed-off mockup core-objects.html C2). Real stack: AS +
 * gateway + the CRM connector; the agent is a real MCP client.
 *
 *   setup  an automatic customers mandate → 3 contacts created (automatic
 *          tickets); then a review mandate → 2 contacts proposed (waiting)
 *   A      dashboard: waiting for you (2), done automatically (3 × Contact
 *          created, 3 new), mandates at work today (3 of 20)
 *   B      "Automatic tickets" lands on Tickets filtered to Automatic; the
 *          three are marked new; Approved is empty
 *   C      after that visit the dashboard shows the group as seen
 *   (UI3)  each approval reads as one sentence from the manifest template
 *   D      a dashboard row opens that approval in place on the Approvals
 *          page; approving it opens the next one; its ticket is "Approved"
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  test, expect,
  SP_URL, GW_MCP_URL, INTERNAL_SECRET,
  registerOnSP, signInToGateway, handleOnboarding, activateIntegration,
  spApiAttest, latestProfileId,
} from './fixtures';
import { hashGateContent, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', 'test-results', 'core-objects');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Runs only against a gateway with the core-objects UI (CI runs the journeys
// against the gateway's main branch, which may not have it yet).
const HAS_CORE = existsSync(join(__dirname, '..', '..', 'suveren-gateway', 'apps', 'ui', 'src', 'lib', 'core-objects.ts'));
// UI spec §13 (gateway 0.32.0): areas first, tools second.
const HAS_AREAS = existsSync(join(__dirname, '..', '..', 'suveren-gateway', 'apps', 'ui', 'src', 'lib', 'area.ts'));
/**
 * The area name the gateway must show: the newest customers profile's own
 * `name`, as the Authority Server lists it (what the gateway receives).
 */
async function customersAreaName(request: APIRequestContext): Promise<string> {
  const { profiles } = await (await request.get(`${SP_URL}/api/profiles`)).json() as { profiles: Array<{ id: string; name?: string }> };
  const ver = (id: string) => id.slice(id.indexOf('@') + 1).split('.').map(Number);
  const newest = profiles
    .filter(p => /\/customers@/.test(p.id))
    .sort((x, y) => ver(y.id)[0] - ver(x.id)[0] || ver(y.id)[1] - ver(x.id)[1])[0];
  expect(newest?.name, 'the AS lists the profile name (suveren-as: /api/profiles returns name)').toBeTruthy();
  return newest.name as string;
}

const CUSTOMERS_PROFILE = latestProfileId('customers');
const KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'];
const SCOPE = { contact_type: 'customer' };
const BOUNDS = { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 20, delete_daily_max: 0, setup_daily_max: 0 };

async function mandate(request: APIRequestContext, apiKey: string, did: string, mode: 'automatic' | 'review', intent: string): Promise<void> {
  const boundsHash = computeBoundsHash(BOUNDS, KEY_ORDER);
  const scopeHash = computeScopeHash(SCOPE, Object.keys(SCOPE));
  const att = await spApiAttest(request, apiKey, {
    profile_id: CUSTOMERS_PROFILE, domain: 'owner', did,
    bounds: BOUNDS, bounds_hash: boundsHash, scope_hash: scopeHash,
    gate_content_hashes: hashGateContent({ intent }),
    execution_context_hash: 'sha256:' + 'd'.repeat(64),
    commitment_mode: mode,
    title: mode === 'automatic' ? 'Customer care' : 'Customer review',
  });
  expect(att.status).toBe('active');
  const res = await fetch(`${GW_MCP_URL}/internal/gate-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
    body: JSON.stringify({
      authorizationId: att.authorization_id, boundsHash, contextHash: scopeHash, context: SCOPE,
      path: CUSTOMERS_PROFILE, gateContent: { intent },
    }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

async function createContacts(names: string[]): Promise<void> {
  const client = new Client({ name: 'core-objects-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${GW_MCP_URL}/sse`)));
  try {
    for (const name of names) {
      const res = await client.callTool({
        name: 'crm__create_contact',
        arguments: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@core-objects.de`, type: 'customer', contact_type: 'customer' },
      });
      const body = ((res.content as Array<{ text?: string }>) ?? [])[0]?.text ?? '';
      expect(res.isError, body).toBeFalsy();
    }
  } finally {
    await client.close();
  }
}

async function goDashboard(page: Page): Promise<void> {
  await page.click('.sidebar-item:has-text("Dashboard")');
  await expect(page.getByTestId('core-cols')).toBeVisible({ timeout: 30_000 });
}

test.describe.serial('Core objects — dashboard, tickets, approvals (real stack)', () => {
  test.skip(!HAS_CORE, 'gateway without the core-objects UI (UI spec §12)');
  let apiKey: string;
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); });
  test.afterAll(async () => { await page?.close(); });

  test('setup: 3 automatic tickets, then 2 approvals waiting', async ({ request }) => {
    test.setTimeout(240_000);
    apiKey = await registerOnSP(page, 'Core Objects');
    const sess = await request.post(`${SP_URL}/api/auth/session`, { headers: { 'x-api-key': apiKey } });
    const did = (await sess.json()).user.did as string;
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    await mandate(request, apiKey, did, 'automatic', 'Core objects e2e: keep customers up to date.');
    await createContacts(['Anna Auto', 'Bernd Auto', 'Clara Auto']);
    // Created after the seeding: when both match, the review mandate wins.
    await mandate(request, apiKey, did, 'review', 'Core objects e2e: review new customers.');
    await createContacts(['Dora Review', 'Emil Review']);
  });

  test('A: the dashboard shows what waits, what ran automatically, and the mandate at work', async () => {
    test.setTimeout(90_000);
    await goDashboard(page);
    const waiting = page.getByTestId('col-waiting');
    await expect(waiting.getByTestId('dash-approval')).toHaveCount(2, { timeout: 30_000 });
    await expect(waiting.getByTestId('dash-approval').first()).toContainText(/waiting/);
    // UI3: the sentence comes from the manifest's summary template + the
    // sealed values ("Create contact Dora Review"), not just the action name.
    await expect(waiting.getByTestId('dash-approval').filter({ hasText: 'Create contact Dora Review' })).toHaveCount(1, { timeout: 30_000 });
    await expect(waiting.getByTestId('dash-approval').filter({ hasText: 'Create contact Emil Review' })).toHaveCount(1);

    const auto = page.getByTestId('col-automatic');
    const group = auto.getByTestId('auto-group').filter({ hasText: 'Contact created' }).first();
    await expect(group).toContainText('3 × Contact created', { timeout: 30_000 });
    await expect(group).toContainText('3 new');
    await expect(group).toContainText('Customer care');

    const atWork = page.getByTestId('col-mandates').getByTestId('mandate-at-work').filter({ hasText: 'Customer care' });
    await expect(atWork).toContainText('3 of 20 today', { timeout: 30_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'a-dashboard.png'), fullPage: true });
  });

  test('B: "Automatic tickets" lands on Tickets filtered to Automatic, marked new', async () => {
    test.setTimeout(60_000);
    await page.getByTestId('btn-automatic-tickets').click();
    await page.waitForURL(/\/tickets\?filter=automatic/);
    await expect(page.getByTestId('tickets-filter-automatic')).toHaveAttribute('aria-selected', 'true');
    const rows = page.locator('.ticket-obj-card');
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    await expect(rows.filter({ hasText: 'automatic' })).toHaveCount(3);
    await expect(page.locator('.ticket-obj-card[data-new="true"]')).toHaveCount(3);
    await expect(page.getByTestId('tickets-new-count')).toContainText('3 new');
    await expect(page.getByTestId('tickets-filter-approved')).toContainText('0');
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'b-tickets-automatic.png'), fullPage: true });
  });

  test('C: after that visit, the dashboard shows the group as seen', async () => {
    test.setTimeout(60_000);
    await goDashboard(page);
    const group = page.getByTestId('col-automatic').getByTestId('auto-group').filter({ hasText: 'Contact created' }).first();
    await expect(group).toHaveClass(/is-seen/, { timeout: 30_000 });
    await expect(group).toContainText('seen');
  });

  test('D: a dashboard row opens that approval in place; approving opens the next; its ticket is Approved', async () => {
    test.setTimeout(120_000);
    await goDashboard(page);
    await page.getByTestId('col-waiting').getByTestId('dash-approval').first().click();
    await page.waitForURL(/\/approvals\?open=/);
    const rows = page.getByTestId('approval-row');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('approval-row-summary').filter({ hasText: /^Create contact (Dora|Emil) Review$/ })).toHaveCount(2, { timeout: 30_000 });
    // Exactly the one from the dashboard is open.
    const openId = new URL(page.url()).searchParams.get('open');
    await expect(page.locator(`[data-testid="approval-row"][data-proposal-id="${openId}"]`)).toHaveClass(/is-open/);
    await expect(page.locator('[data-testid="approval-row"].is-open')).toHaveCount(1);
    await expect(page.locator('.approval-resp')).toContainText('Approving sends exactly this');

    const open = page.locator('[data-testid="approval-row"].is-open');
    await open.locator('button:has-text("Approve")').click();
    // The decided one leaves the list and the remaining one opens by itself.
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.first()).toHaveClass(/is-open/, { timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'd-next-opened.png'), fullPage: true });

    await page.click('.sidebar-item:has-text("Tickets")');
    await page.waitForURL('**/tickets');
    await page.getByTestId('tickets-filter-approved').click();
    await expect(page.locator('.ticket-obj-card')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.ticket-obj-card').first()).toContainText('approved');
    // The approved ticket's headline is the sentence the approver saw (from the
    // proposal's sealed values), not only the action's name.
    if (HAS_AREAS) {
      await expect(page.locator('.ticket-obj-card').first().getByTestId('ticket-headline'))
        .toHaveText(/^Create contact (Dora|Emil) Review$/, { timeout: 30_000 });
    }
  });
  test('E: areas first, tools second — area + "via CRM" on the top line, the mandate name underneath', async ({ request }) => {
    test.skip(!HAS_AREAS, 'gateway without UI spec §13 (areas)');
    test.setTimeout(90_000);
    const area = await customersAreaName(request);
    await goDashboard(page);
    const group = page.getByTestId('col-automatic').getByTestId('auto-group').filter({ hasText: 'Contact created' }).first();
    await expect(group.locator('.obj-line')).toContainText(area, { timeout: 30_000 });
    await expect(group.locator('.obj-line')).toContainText('via CRM');
    // The mandate's own name is a separate line, under the headline — never the area.
    await expect(group.getByTestId('mandate-line')).toHaveText('Mandate: Customer care');
    await expect(group.locator('.obj-line')).not.toContainText('Customer care');
    // Each mandate at work shows its own name; the area is the same for both.
    const atWork = page.getByTestId('col-mandates').getByTestId('mandate-at-work');
    await expect(atWork.filter({ hasText: 'Customer care' })).toHaveCount(1);
    await expect(atWork.filter({ hasText: 'Customer care' }).locator('.obj-line')).toContainText(area);
    await expect(page.getByTestId('col-waiting').getByTestId('dash-approval').first().getByTestId('mandate-line')).toHaveText('Mandate: Customer review');
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'e-dashboard-areas.png'), fullPage: true });

    // Approvals: the one left after D carries its mandate's name underneath.
    await page.click('.sidebar-item:has-text("Approvals")');
    await page.waitForURL('**/approvals**');
    const row = page.getByTestId('approval-row').first();
    await expect(row.locator('.obj-line')).toContainText(area, { timeout: 30_000 });
    await expect(row.getByTestId('mandate-line')).toHaveText('Mandate: Customer review');

    // Tickets: one area only → no area pills (nothing to choose between).
    await page.click('.sidebar-item:has-text("Tickets")');
    await page.waitForURL('**/tickets');
    await expect(page.locator('.ticket-obj-card').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('area-filter')).toHaveCount(0);
    await expect(page.locator('.ticket-obj-card').first().locator('.obj-line')).toContainText(area);
    await expect(page.locator('.ticket-obj-card').first().locator('.obj-line')).toContainText('via CRM');

    // Search: typing never blanks the page (2026-10-17: a ticket without
    // path/attestationHash threw), and it finds what the row shows.
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const search = page.getByTestId('tickets-search');
    await search.fill('contact');
    await expect(page.locator('.ticket-obj-card').first()).toBeVisible();
    await search.fill('zzz-nothing-matches');
    await expect(page.locator('.ticket-obj-card')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
    await search.fill('');
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'e-tickets-search.png'), fullPage: true });
    expect(errors).toEqual([]);

    // Mandates: grouped by area, heading with the area name and the tool.
    await page.click('.sidebar-item:has-text("Mandates")');
    await page.waitForURL('**/mandates');
    const grp = page.locator('[data-testid="mandate-area"][data-area="customers"]');
    await expect(grp.locator('.area-group-h')).toContainText(area, { timeout: 30_000 });
    await expect(grp.locator('.area-group-h')).toContainText('via CRM');
    // Cards under their area heading do not repeat the area.
    await expect(grp.locator('.mandate-card .obj-line').first()).not.toContainText(area);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'e-mandates-areas.png'), fullPage: true });

    // Integrations: the CRM under its area.
    await page.click('.sidebar-item:has-text("Integrations")');
    await page.waitForURL('**/integrations');
    const ia = page.locator('[data-testid="integration-area"][data-area="customers"]');
    await expect(ia.locator('.area-group-h')).toContainText(area, { timeout: 30_000 });
    await expect(ia).toContainText('CRM');
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'e-integrations-areas.png'), fullPage: true });
  });
});
