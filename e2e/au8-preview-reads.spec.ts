/**
 * AU8 — several reads per preview (temp/briefs/au8-brief.md), on the real
 * stack (Authority Server + gateway + the erp connector, over the browser).
 *
 * C1: a review-mode `erp__create_quote` proposal — the manifest now declares
 *     TWO reads (`get_customer` attached to `customer_id`, `get_item` for
 *     each `lines` element attached to `item`) — merges the bound args with
 *     those reads into one card: the customer's real name next to its bound
 *     id (`cust-1`), the line as a table row with the item's real name next
 *     to `item-1`, and the total formatted as money ("385.00 EUR").
 * D:  a review-mode `erp__send_quote` proposal on a REAL quote (created via
 *     an automatic mandate and a real MCP tool call, so get_quote has
 *     something to read) — the single-object legacy preview (unchanged
 *     manifest config) still works, with its `lines` now rendered as a
 *     table (the generic renderer upgrade, AU8 build item 4's last bullet).
 *
 * A manifest with ONE object (unchanged shape) is covered by the unit tests
 * this change kept passing (apps/mcp-server/test/preview.test.ts,
 * crm-preview.test.ts) and by D above (erp__send_quote's own preview config
 * is untouched) — not duplicated here as a third browser case.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  test, expect,
  SP_URL, GW_MCP_URL, INTERNAL_SECRET,
  registerOnSP, signInToGateway, handleOnboarding, activateIntegration,
  spApiAttest, latestProfileId,
} from './fixtures';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', 'test-results', 'au8');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const SALES_PROFILE = latestProfileId('sales');
const BOUNDS_KEY_ORDER = [
  'profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max',
];
const SCOPE = { currency: 'EUR' };

function salesBounds(overrides: Partial<Record<string, number | string>> = {}) {
  return {
    profile: SALES_PROFILE, read_access: 'unlimited', value_max: 1000, discount_max: 10,
    order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0,
    ...overrides,
  };
}

/** Pushes the gate content (intent) a mandate needs — the Gatekeeper checks
 *  this locally before an AUTOMATIC call may run (same mechanism
 *  hap-e2e/test/erp-quote-revisions.test.ts uses via its own GatewayClient
 *  helper; done here with a raw fetch since fixtures.ts is Playwright-only). */
async function pushGateContent(opts: {
  authorizationId: string; boundsHash: string; scopeHash: string; path: string; intent: string;
}): Promise<void> {
  const res = await fetch(`${GW_MCP_URL}/internal/gate-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
    body: JSON.stringify({
      authorizationId: opts.authorizationId,
      boundsHash: opts.boundsHash,
      contextHash: opts.scopeHash,
      context: SCOPE,
      path: opts.path,
      gateContent: { intent: opts.intent },
    }),
  });
  if (!res.ok) throw new Error(`pushGateContent failed (${res.status}): ${await res.text()}`);
}

test.describe.serial('AU8: several reads per preview (real stack)', () => {
  let apiKey: string;
  let userDid: string;

  test('setup: register, sign in, activate ERP', async ({ page }) => {
    test.setTimeout(120_000);
    apiKey = await registerOnSP(page, 'AU8 Preview Reads');
    const sess = await page.request.post(`${SP_URL}/api/auth/session`, { headers: { 'x-api-key': apiKey } });
    expect(sess.ok()).toBe(true);
    userDid = (await sess.json()).user.did;

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'ERP');
  });

  test('C1: create_quote card merges bound args with its reads — customer name, item name, table row, 385.00 EUR', async ({ page, request }) => {
    const bounds = salesBounds();
    const att = await spApiAttest(request, apiKey, {
      profile_id: SALES_PROFILE, domain: 'owner', did: userDid,
      bounds, bounds_hash: computeBoundsHash(bounds, BOUNDS_KEY_ORDER), scope_hash: computeScopeHash(SCOPE, ['currency']),
      gate_content_hashes: hashGateContent({ intent: 'AU8 e2e: review quotes before they are created.' }),
      execution_context_hash: hashExecutionContext({ value: 385, discount_pct: 0, quote_count_daily: 0 }),
      defer_commitment: true,
    });
    expect(att.status).toBe('active');

    const propRes = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': apiKey },
      data: {
        authorization_id: att.authorization_id,
        profile_id: SALES_PROFILE,
        pending_domains: ['owner'],
        tool: 'erp__create_quote',
        tool_args: { customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }], discount_pct: 0, value: 385, currency: 'EUR' },
        execution_context: { value: 385, discount_pct: 0, currency: 'EUR' },
      },
    });
    expect(propRes.ok()).toBe(true);

    await signInToGateway(page, apiKey);
    await page.click('.sidebar-item:has-text("Pending Approvals")');
    await page.waitForURL('**/approvals');
    await page.click('.nav-tab:has-text("Awaiting me")');

    const card = page.locator('.card', { hasText: 'create_quote' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Wait for the gateway's own live read (get_customer + get_item) to settle.
    await expect(card.locator('[data-preview-status="ok"]')).toBeVisible({ timeout: 20_000 });

    await expect(card).toContainText('Steiner Landtechnik GmbH');
    await expect(card).toContainText('cust-1');
    const table = card.locator('table.preview-table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('Keilriemen SPB 2000');
    await expect(table).toContainText('item-1');
    await expect(card).toContainText('385.00 EUR');

    await card.screenshot({ path: join(SCREENSHOT_DIR, 'c1-create-quote-card.png') });
  });

  test('D: send_quote card still works — single-object legacy preview, lines now rendered as a table', async ({ page, request }) => {
    test.setTimeout(60_000);
    // An AUTOMATIC mandate — real tool call, so a real quote exists for
    // erp__send_quote's own (unchanged) get_quote preview to read.
    const bounds = salesBounds();
    const att = await spApiAttest(request, apiKey, {
      profile_id: SALES_PROFILE, domain: 'owner', did: userDid,
      bounds, bounds_hash: computeBoundsHash(bounds, BOUNDS_KEY_ORDER), scope_hash: computeScopeHash(SCOPE, ['currency']),
      gate_content_hashes: hashGateContent({ intent: 'AU8 e2e: create and send quotes automatically, within bounds.' }),
      execution_context_hash: hashExecutionContext({ value: 385, discount_pct: 0, quote_count_daily: 0, send_count_daily: 0 }),
      // No defer_commitment -> automatic (spApiAttest's own default).
    });
    expect(att.status).toBe('active');
    await pushGateContent({
      authorizationId: att.authorization_id as string,
      boundsHash: computeBoundsHash(bounds, BOUNDS_KEY_ORDER),
      scopeHash: computeScopeHash(SCOPE, ['currency']),
      path: SALES_PROFILE,
      intent: 'AU8 e2e: create and send quotes automatically, within bounds.',
    });

    const mcpClient = new Client({ name: 'au8-e2e-agent', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(new SSEClientTransport(new URL(`${GW_MCP_URL}/sse`)));
    let quoteId: string;
    try {
      const createRes = await mcpClient.callTool({
        name: 'erp__create_quote',
        arguments: { customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }], discount_pct: 0, value: 385, currency: 'EUR' },
      });
      expect(createRes.isError).toBeFalsy();
      const createText = (createRes.content as Array<{ text?: string }>)?.[0]?.text ?? '';
      const quote = JSON.parse(createText) as { id: string; revision: number };
      expect(quote.revision).toBe(1);
      quoteId = quote.id;
    } finally {
      await mcpClient.close();
    }

    // Review-mode (send-only) mandate for the actual card under test.
    const sendBounds = salesBounds({ quote_daily_max: 0 });
    const sendAtt = await spApiAttest(request, apiKey, {
      profile_id: SALES_PROFILE, domain: 'owner', did: userDid,
      bounds: sendBounds, bounds_hash: computeBoundsHash(sendBounds, BOUNDS_KEY_ORDER), scope_hash: computeScopeHash(SCOPE, ['currency']),
      gate_content_hashes: hashGateContent({ intent: 'AU8 e2e: review quote sends before they go out.' }),
      execution_context_hash: hashExecutionContext({ send_count_daily: 0 }),
      defer_commitment: true,
    });
    expect(sendAtt.status).toBe('active');

    const propRes = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': apiKey },
      data: {
        authorization_id: sendAtt.authorization_id,
        profile_id: SALES_PROFILE,
        pending_domains: ['owner'],
        tool: 'erp__send_quote',
        tool_args: { id: quoteId, value: 385, discount_pct: 0, currency: 'EUR', revision: 1 },
        execution_context: { value: 385, discount_pct: 0, currency: 'EUR' },
      },
    });
    expect(propRes.ok()).toBe(true);

    await signInToGateway(page, apiKey);
    await page.click('.sidebar-item:has-text("Pending Approvals")');
    await page.waitForURL('**/approvals');
    await page.click('.nav-tab:has-text("Awaiting me")');

    const card = page.locator('.card', { hasText: 'send_quote' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('[data-preview-status="ok"]')).toBeVisible({ timeout: 20_000 });

    // The single-object preview (erp.json's send_quote config, unchanged)
    // still resolves, and its `lines` array now renders as a real table
    // (the generic renderer upgrade) instead of a compact one-line list.
    const table = card.locator('table.preview-table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('item-1');
    await expect(card).toContainText('385');

    await card.screenshot({ path: join(SCREENSHOT_DIR, 'd-send-quote-card.png') });
  });
});
