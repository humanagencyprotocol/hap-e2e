/**
 * Blocked page redesign (signed-off mockup temp/blocked-mockup, 2026-10-14):
 * the sidebar's Blocked badge counts only blocks the person has not seen;
 * opening the Blocked page marks them seen (stored on the gateway, not in
 * the browser); a block that arrives afterwards counts again and is marked
 * "New". Each item shows the profile rail, date + time, and the mandate by
 * its title.
 *
 * Real stack: a real refusal through the gateway's MCP server (a CRM write
 * outside the mandate's contact_type scope), read back through the UI.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
const SCREENSHOT_DIR = join(__dirname, '..', 'test-results', 'blocked');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const CUSTOMERS_PROFILE = latestProfileId('customers');
const KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'];
const SCOPE = { contact_type: 'customer' };
const MANDATE_TITLE = 'Blocked e2e customer care';

// Runs only against a gateway that stores "seen" (the redesign).
const GW_SEEN_TS = join(__dirname, '..', '..', 'suveren-gateway', 'apps', 'control-plane', 'src', 'lib', 'blocked-seen-store.ts');
const HAS_SEEN = existsSync(GW_SEEN_TS) && readFileSync(GW_SEEN_TS, 'utf8').length > 0;

async function pushGateContent(authorizationId: string, boundsHash: string, scopeHash: string, intent: string): Promise<void> {
  const res = await fetch(`${GW_MCP_URL}/internal/gate-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
    body: JSON.stringify({ authorizationId, boundsHash, contextHash: scopeHash, context: SCOPE, path: CUSTOMERS_PROFILE, gateContent: { intent } }),
  });
  if (!res.ok) throw new Error(`pushGateContent failed (${res.status}): ${await res.text()}`);
}

async function blockOnce(label: string): Promise<void> {
  const client = new Client({ name: 'blocked-e2e-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${GW_MCP_URL}/sse`)));
  try {
    // A lead, under a mandate scoped to customers → refused before anything ran.
    const res = await client.callTool({
      name: 'crm__create_contact',
      arguments: { name: label, email: `${label.toLowerCase().replace(/\W+/g, '.')}@example.com`, type: 'lead', contact_type: 'lead' },
    });
    expect(res.isError, 'the call is refused').toBeTruthy();
  } finally {
    await client.close();
  }
}

const badge = (page: Page) => page.locator('.sidebar-item', { hasText: 'Blocked' }).locator('span').filter({ hasText: /^\d+$/ });

async function openBlocked(page: Page): Promise<void> {
  await page.click('.sidebar-item:has-text("Dashboard")');
  await page.click('.sidebar-item:has-text("Blocked")');
  await page.waitForURL('**/blocked');
}

test.describe.serial('Blocked page: seen badge, rail, date and mandate title (real stack)', () => {
  test.skip(!HAS_SEEN, 'gateway without the Blocked redesign (seen store)');
  let apiKey: string;
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); });
  test.afterAll(async () => { await page?.close(); });

  test('setup: a CRM mandate scoped to customers', async ({ request }) => {
    test.setTimeout(180_000);
    apiKey = await registerOnSP(page, 'Blocked Seen');
    const sess = await request.post(`${SP_URL}/api/auth/session`, { headers: { 'x-api-key': apiKey } });
    const did = (await sess.json()).user.did;
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    const bounds = { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 20, delete_daily_max: 0, setup_daily_max: 0 };
    const intent = 'Blocked e2e: customers only.';
    const boundsHash = computeBoundsHash(bounds, KEY_ORDER);
    const scopeHash = computeScopeHash(SCOPE, ['contact_type']);
    const att = await spApiAttest(request as APIRequestContext, apiKey, {
      profile_id: CUSTOMERS_PROFILE, domain: 'owner', did, bounds, bounds_hash: boundsHash, scope_hash: scopeHash,
      gate_content_hashes: hashGateContent({ intent }), execution_context_hash: 'sha256:' + 'd'.repeat(64),
      commitment_mode: 'automatic', title: MANDATE_TITLE,
    });
    expect(att.status).toBe('active');
    await pushGateContent(att.authorization_id as string, boundsHash, scopeHash, intent);
  });

  test('A → B: unseen blocks show in the badge; opening the page clears it and marks them seen', async () => {
    test.setTimeout(120_000);
    await blockOnce('First Lead');
    await blockOnce('Second Lead');

    // A new block reaches the badge through the gateway's live events — no
    // reload, well before the 5-minute fallback poll.
    await page.click('.sidebar-item:has-text("Dashboard")');
    await expect(badge(page)).toBeVisible({ timeout: 20_000 });
    // The badge can appear on the first block's event, before the second
    // arrives — wait for the count, don't read it the moment it shows.
    await expect.poll(async () => Number(await badge(page).textContent()), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    const before = Number(await badge(page).textContent());

    await openBlocked(page);
    const item = page.locator('.blocked-item', { hasText: 'create_contact' }).first();
    await expect(item).toBeVisible({ timeout: 30_000 });
    // Same card shape as Mandates: the profile rail on the left.
    // The profile identity: the rail on older gateways, the shared top line
    // on core-objects gateways (UI spec §12.2).
    const identity = item.locator('.id-rail, .obj-line').first();
    await expect(identity).toBeVisible();
    await expect(identity).toContainText(/customers/i);
    // Date + time, not only the time.
    await expect(item).toContainText(/(Today|Yesterday|[A-Z][a-z]{2} \d{1,2}) · \d{1,2}:\d{2}/);
    // The mandate by its title.
    await expect(item).toContainText(MANDATE_TITLE);
    // During this visit, what was new stays marked new.
    await expect(item).toHaveAttribute('data-seen', 'false');
    await expect(item.locator('.new-pill')).toBeVisible();
    await item.screenshot({ path: join(SCREENSHOT_DIR, 'a-new-item.png') });

    // The badge clears right away, without the 5-minute poll.
    await expect(badge(page)).toHaveCount(0, { timeout: 15_000 });

    // Leaving and coming back: the same items are now seen.
    await openBlocked(page);
    const again = page.locator('.blocked-item', { hasText: 'create_contact' }).first();
    await expect(again).toHaveAttribute('data-seen', 'true', { timeout: 15_000 });
    await expect(page.locator('.new-pill')).toHaveCount(0);
  });

  test('C: one new block afterwards → badge 1, only that item is new; seen is kept by the gateway', async ({ browser }) => {
    test.setTimeout(120_000);
    await page.click('.sidebar-item:has-text("Dashboard")');
    await blockOnce('Third Lead');
    await expect(badge(page)).toHaveText('1', { timeout: 20_000 });

    // Stored on the gateway, not in this browser: a fresh browser context sees the same count.
    const other = await browser.newPage();
    try {
      await signInToGateway(other, apiKey);
      await expect(badge(other)).toHaveText('1', { timeout: 30_000 });
    } finally {
      await other.close();
    }

    await openBlocked(page);
    await expect(page.locator('.blocked-item[data-seen="false"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.blocked-item[data-seen="false"]')).toContainText('create_contact');
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'c-one-new.png'), fullPage: true });
  });
});
