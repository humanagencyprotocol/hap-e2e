/**
 * AU10 — the request and the customer's latest entries on the approval card,
 * on the real stack (Authority Server + gateway + the email, CRM connectors,
 * over the browser).
 *
 * Contract: doc/au10-request-context.md (HAP root). Visual reference: the
 * signed-off mockup temp/au10-mockup/index.html.
 *
 * Everything the AI does goes through the gateway's MCP server, as an AI
 * would: automatic calls seed the world (inbox via mail__load_simulation, CRM
 * contacts and activities), review-mode calls create the proposals whose cards
 * are checked. The CRM activities written here by an AUTOMATIC call carry a
 * real ticket, so the gateway knows them as written by the AI.
 *
 *  A  (cases 1, 2, 7) _source → Request block; history of the same email
 *     domain within 14 days, incl. an AI-written entry; older entries and
 *     other domains are absent.
 *  B  (case 3) no _source → "No request linked."; approve → the contact is
 *     really created.
 *  C  (case 4) unknown connector / missing message → visible state, approve
 *     still enabled.
 *  D  (case 6) an automatic call with _source executes and the stored record
 *     carries no _source.
 *  E  (case 8) free-mail sender → only the exact address is matched.
 *  F  (implicit source) mail__send_message with in_reply_to → the request is
 *     shown although the AI gave no _source, labelled as the AI's link.
 *
 * Case 5 (connector not reachable) and case 9 (phase B) are not here yet: 5
 * needs an installed-but-stopped connector (open question on the gateway
 * side), 9 is phase B.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  test, expect,
  SP_URL, GW_MCP_URL, INTERNAL_SECRET,
  registerOnSP, signInToGateway, handleOnboarding, activateIntegration,
  spApiAttest, latestProfileId, gatewayDataDir,
} from './fixtures';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hashGateContent, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', 'test-results', 'au10');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const CUSTOMERS_PROFILE = latestProfileId('customers');
const EMAIL_PROFILE = latestProfileId('email');
const CUSTOMERS_KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'];
const EMAIL_KEY_ORDER = ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'];
const CUSTOMERS_SCOPE = { contact_type: 'customer' };
const SALES_PROFILE = latestProfileId('sales');
const SALES_KEY_ORDER = [
  'profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max',
];
const SALES_SCOPE = { currency: 'EUR' };
const salesBounds = (o: Record<string, unknown> = {}) => ({
  profile: SALES_PROFILE, read_access: 'unlimited', value_max: 1000, discount_max: 10,
  order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0, ...o,
});

const HISTORY_LABEL = 'Read by the gateway — same customer, not matched to this request';

// Runs only against a gateway that has AU10 (CI runs the journeys against the
// gateway's main branch, which may not have it yet) — same gate as AU8.
const GW_AU10_TS = join(__dirname, '..', '..', 'suveren-gateway', 'apps', 'mcp-server', 'src', 'lib', 'request-context.ts');
const HAS_AU10 = existsSync(GW_AU10_TS) && readFileSync(GW_AU10_TS, 'utf8').includes('stripSourceLink');
// Phase B needs both sides: the gateway's snapshot store and an AS that
// records shown_hash per decision.
const GW_SHOWN_TS = join(__dirname, '..', '..', 'suveren-gateway', 'apps', 'control-plane', 'src', 'lib', 'shown-snapshot.ts');
const AS_STORE_TS = join(__dirname, '..', '..', 'suveren-as', 'apps', 'as', 'src', 'lib', 'proposal-store.ts');
const HAS_PHASE_B = existsSync(GW_SHOWN_TS)
  && existsSync(AS_STORE_TS) && readFileSync(AS_STORE_TS, 'utf8').includes('shownHashes');

async function pushGateContent(opts: {
  authorizationId: string; boundsHash: string; scopeHash: string; scope: Record<string, string>; path: string; intent: string;
}): Promise<void> {
  const res = await fetch(`${GW_MCP_URL}/internal/gate-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
    body: JSON.stringify({
      authorizationId: opts.authorizationId,
      boundsHash: opts.boundsHash,
      contextHash: opts.scopeHash,
      context: opts.scope,
      path: opts.path,
      gateContent: { intent: opts.intent },
    }),
  });
  if (!res.ok) throw new Error(`pushGateContent failed (${res.status}): ${await res.text()}`);
}

async function mandate(request: APIRequestContext, apiKey: string, did: string, opts: {
  profile: string; keyOrder: string[]; bounds: Record<string, unknown>; scope: Record<string, string>;
  intent: string; mode: 'automatic' | 'review';
}): Promise<void> {
  const boundsHash = computeBoundsHash(opts.bounds, opts.keyOrder);
  const scopeHash = computeScopeHash(opts.scope, Object.keys(opts.scope));
  const att = await spApiAttest(request, apiKey, {
    profile_id: opts.profile, domain: 'owner', did,
    bounds: opts.bounds, bounds_hash: boundsHash, scope_hash: scopeHash,
    gate_content_hashes: hashGateContent({ intent: opts.intent }),
    execution_context_hash: 'sha256:' + 'd'.repeat(64),
    commitment_mode: opts.mode,
  });
  expect(att.status).toBe('active');
  await pushGateContent({
    authorizationId: att.authorization_id as string, boundsHash, scopeHash, scope: opts.scope, path: opts.profile, intent: opts.intent,
  });
}

async function withAgent<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'au10-e2e-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${GW_MCP_URL}/sse`)));
  try { return await fn(client); } finally { await client.close(); }
}

function text(res: { content?: unknown }): string {
  return ((res.content as Array<{ text?: string }>) ?? [])[0]?.text ?? '';
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await c.callTool({ name, arguments: args });
  const body = text(res);
  if (res.isError) throw new Error(`${name} failed: ${body}`);
  return body;
}

async function openCard(page: Page, hasText: string): Promise<Locator> {
  await page.click('.sidebar-item:has-text("Dashboard")');
  await page.click('.sidebar-item:has-text("Pending Approvals")');
  await page.waitForURL('**/approvals');
  await page.click('.nav-tab:has-text("Awaiting me")');
  const card = page.locator('.card', { hasText }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test.describe.serial('AU10: request and customer history on the approval card (real stack)', () => {
  test.skip(!HAS_AU10, 'gateway without AU10 (request and history on the card)');
  let apiKey: string;
  let did: string;
  // One browser page, signed in once, for the whole spec: the gateway allows
  // 10 sign-ins a minute, and the browser specs share one gateway — signing
  // in per test locked the next spec out.
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); });
  test.afterAll(async () => { await page?.close(); });
  const msg: Record<'kraus' | 'hans', string> = { kraus: '', hans: '' };

  test('setup: connectors, automatic mandates, inbox and CRM history seeded through the gateway', async ({ request }) => {
    test.setTimeout(240_000);
    apiKey = await registerOnSP(page, 'AU10 Request Context');
    const sess = await request.post(`${SP_URL}/api/auth/session`, { headers: { 'x-api-key': apiKey } });
    expect(sess.ok()).toBe(true);
    did = (await sess.json()).user.did;

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'Email (simulation)');
    await activateIntegration(page, 'CRM');
    await activateIntegration(page, 'ERP');

    await mandate(request, apiKey, did, {
      profile: EMAIL_PROFILE, keyOrder: EMAIL_KEY_ORDER, scope: {}, mode: 'automatic',
      bounds: { profile: EMAIL_PROFILE, read_access: 'unlimited', recipient_max: 1, send_daily_max: 0, read_max_age_days: 30, setup_daily_max: 2 },
      intent: 'AU10 e2e: load a simulated inbox and read it.',
    });
    await mandate(request, apiKey, did, {
      profile: CUSTOMERS_PROFILE, keyOrder: CUSTOMERS_KEY_ORDER, scope: CUSTOMERS_SCOPE, mode: 'automatic',
      bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 20, delete_daily_max: 0, setup_daily_max: 0 },
      intent: 'AU10 e2e: keep the CRM up to date automatically.',
    });
    await mandate(request, apiKey, did, {
      profile: SALES_PROFILE, keyOrder: SALES_KEY_ORDER, scope: SALES_SCOPE, mode: 'automatic',
      bounds: salesBounds({ send_daily_max: 0 }),
      intent: 'AU10 e2e: create quotes automatically, within bounds.',
    });
    let quoteId = '';

    await withAgent(async (c) => {
      // The AI sees _source on write tools, not on reads (contract §1).
      const { tools } = await c.listTools();
      const schemaOf = (n: string) => tools.find(t => t.name === n)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
      expect(schemaOf('crm__create_contact')?.properties?._source).toBeDefined();
      expect(schemaOf('crm__log_activity')?.properties?._source).toBeDefined();
      expect(schemaOf('crm__get_timeline')?.properties?._source).toBeUndefined();
      expect(schemaOf('mail__list_messages')?.properties?._source).toBeUndefined();

      await call(c, 'mail__load_simulation', {
        package: {
          name: 'Ennstal Umformtechnik', currency: 'EUR',
          customers: [{ id: 'cust-77', name: 'Bavaria Umformtechnik GmbH', email: 'einkauf@bavaria-umform.de', credit_limit: 15000 }],
          products: [{ id: 'item-1', sku: 'PV-55A', name: 'Proportionalventil PV-55A', list_price: 1850, stock: 4 }],
          cases: [
            {
              id: 'c1',
              request: {
                from: { name: 'J. Kraus', email: 'j.kraus@bavaria-umform.de' },
                subject: 'RF 55 Stillstand – Seriennummer 55-2291',
                body: 'Guten Morgen,\n\nunsere Anlage RF 55 steht seit heute früh. Bitte um Rückruf.\n\nJürgen Kraus',
              },
              reply: { subject: 'Re: RF 55 Stillstand', body: 'Wir melden uns.' },
            },
            {
              id: 'c2',
              request: {
                from: { name: 'Hans Privat', email: 'hans.privat@gmail.com' },
                subject: 'Preisanfrage Ersatzteil',
                body: 'Was kostet ein Hammersatz?',
              },
              reply: { subject: 'Re: Preisanfrage', body: 'Wir melden uns.' },
            },
          ],
        },
      });
      const inbox = JSON.parse(await call(c, 'mail__list_messages', { folder: 'inbox' })) as Array<{ id: string; subject: string }>;
      msg.kraus = inbox.find(m => m.subject.startsWith('RF 55 Stillstand'))!.id;
      msg.hans = inbox.find(m => m.subject === 'Preisanfrage Ersatzteil')!.id;
      expect(msg.kraus).toBeTruthy();
      expect(msg.hans).toBeTruthy();

      const contact = async (name: string, email: string) =>
        (JSON.parse(await call(c, 'crm__create_contact', { name, email, type: 'customer', contact_type: 'customer' })) as { id: string }).id;
      // An entry a PERSON typed into the CRM — written straight into the
      // connector's database, not through the gateway, so it has no ticket.
      const crmDb = new DatabaseSync(join(gatewayDataDir(), 'crm.db'));
      const personEntry = (contact_id: string, type: string, summary: string, created_by: string, date = new Date().toISOString()) =>
        crmDb.prepare('INSERT INTO activities (id, contact_id, type, summary, detail, date, created_by, receipt_id) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)')
          .run(randomUUID(), contact_id, type, summary, date, created_by);

      // Same domain as Kraus: a colleague's call note, an entry written by
      // the AI (this automatic call carries a ticket), and one older than the
      // 14-day window.
      const leitner = await contact('L. Leitner', 'l.leitner@bavaria-umform.de');
      personEntry(leitner, 'call', 'RF 55 steht, Ventil dringend', 'L. Leitner');
      await call(c, 'crm__log_activity', { contact_id: leitner, type: 'email', summary: 'Angebot Q-1198 an Bavaria gesendet', contact_type: 'customer' });
      personEntry(leitner, 'note', 'OLD-ENTRY outside the window', 'L. Leitner', daysAgo(30));
      // Another company: must never appear on a Bavaria card.
      const other = await contact('O. Anders', 'o.anders@other-firma.de');
      personEntry(other, 'call', 'OTHER-DOMAIN entry', 'O. Anders');
      // Free mail: the exact address matches, the shared domain never does.
      const hans = await contact('Hans Privat', 'hans.privat@gmail.com');
      personEntry(hans, 'call', 'Hans fragt nach Hammersatz', 'L. Leitner');
      const stranger = await contact('Gerda Fremd', 'gerda.fremd@gmail.com');
      personEntry(stranger, 'call', 'GMAIL-STRANGER entry', 'L. Leitner');
      // The ERP customer cust-1 (fixtures: einkauf@steiner-landtechnik.example)
      // has a colleague in the CRM on the same domain.
      const steiner = await contact('M. Steiner', 'm.steiner@steiner-landtechnik.example');
      personEntry(steiner, 'call', 'STEINER-CALL Rückfrage Keilriemen', 'L. Leitner');
      crmDb.close();

      // A real quote, so sending it has something to read (quote → customer).
      const quote = JSON.parse(await call(c, 'erp__create_quote', {
        customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }], discount_pct: 0, value: 385, currency: 'EUR',
      })) as { id: string };
      quoteId = quote.id;

      // Case D (contract test 6): an automatic call with _source executes,
      // and the record that reaches the CRM carries no _source.
      const stored = JSON.parse(await call(c, 'crm__create_contact', {
        name: 'Stripped Source', email: 'stripped@other-firma.de', type: 'customer', contact_type: 'customer',
        _source: { connector: 'mail', kind: 'message', id: msg.kraus },
      })) as Record<string, unknown>;
      expect(stored.name).toBe('Stripped Source');
      expect(JSON.stringify(stored)).not.toContain('_source');
      const reread = await call(c, 'crm__get_contact', { id: stored.id as string });
      expect(reread).not.toContain('_source');
    });

    // Review mandates for the cards. Created after the seeding: when an
    // automatic and a review mandate both match, the review one wins.
    await mandate(request, apiKey, did, {
      profile: CUSTOMERS_PROFILE, keyOrder: CUSTOMERS_KEY_ORDER, scope: CUSTOMERS_SCOPE, mode: 'review',
      bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 20, delete_daily_max: 0, setup_daily_max: 0 },
      intent: 'AU10 e2e: review new contacts before they are created.',
    });
    await mandate(request, apiKey, did, {
      profile: EMAIL_PROFILE, keyOrder: EMAIL_KEY_ORDER, scope: {}, mode: 'review',
      bounds: { profile: EMAIL_PROFILE, read_access: 'unlimited', recipient_max: 1, send_daily_max: 10, read_max_age_days: 30, setup_daily_max: 0 },
      intent: 'AU10 e2e: review replies before they go out.',
    });
    await mandate(request, apiKey, did, {
      profile: SALES_PROFILE, keyOrder: SALES_KEY_ORDER, scope: SALES_SCOPE, mode: 'review',
      bounds: salesBounds({ quote_daily_max: 0 }),
      intent: 'AU10 e2e: review quote sends before they go out.',
    });

    await withAgent(async (c) => {
      const propose = async (args: Record<string, unknown>) => {
        const res = await c.callTool({ name: 'crm__create_contact', arguments: { type: 'customer', contact_type: 'customer', ...args } });
        expect(res.isError, text(res)).toBeFalsy();
      };
      await propose({ name: 'J. Kraus', email: 'j.kraus@bavaria-umform.de', _source: { connector: 'mail', kind: 'message', id: msg.kraus } });
      await propose({ name: 'No Source', email: 'nosource@au10-nolink.de' });
      await propose({ name: 'Unknown Connector', email: 'unknown@au10-bad.de', _source: { connector: 'nosuchconnector', kind: 'record', id: 'x' } });
      await propose({ name: 'Missing Message', email: 'missing@au10-bad.de', _source: { connector: 'mail', kind: 'message', id: 'no-such-message' } });
      await propose({ name: 'Hans Privat Neu', email: 'hans.privat@gmail.com', _source: { connector: 'mail', kind: 'message', id: msg.hans } });
      const reply = await c.callTool({
        name: 'mail__send_message',
        arguments: { to: ['j.kraus@bavaria-umform.de'], subject: 'Re: RF 55 Stillstand', body: 'IMPLICIT-REPLY wir rufen zurück.', in_reply_to: msg.kraus },
      });
      expect(reply.isError, text(reply)).toBeFalsy();
      const send = await c.callTool({
        name: 'erp__send_quote',
        arguments: { id: quoteId, value: 385, discount_pct: 0, currency: 'EUR', revision: 1 },
      });
      expect(send.isError, text(send)).toBeFalsy();
    });
  });

  test('A: request linked by the AI, and the latest entries for the same email domain', async () => {
    test.setTimeout(120_000);
    const card = await openCard(page, 'j.kraus@bavaria-umform.de');
    const req = card.getByTestId('au10-request');
    const hist = card.getByTestId('au10-history');

    await expect(req).toContainText('Linked by the AI', { timeout: 45_000 });
    await expect(req).toContainText('RF 55 Stillstand – Seriennummer 55-2291');
    await expect(req).toContainText('unsere Anlage RF 55 steht');
    await expect(req).toContainText('from J. Kraus, not checked');

    await expect(hist).toContainText(HISTORY_LABEL, { timeout: 45_000 });
    await expect(hist).toContainText('bavaria-umform.de');
    await expect(hist).toContainText('matched by email domain');
    await expect(hist).toContainText('RF 55 steht, Ventil dringend');
    await expect(hist).toContainText('from L. Leitner, not checked');
    // An entry the AI wrote through the gateway is the AI's text, quoted.
    await expect(hist).toContainText('Angebot Q-1198 an Bavaria gesendet');
    await expect(hist).toContainText('Written by the AI via Suveren');
    // Outside the window, or another company: never on this card.
    await expect(hist).not.toContainText('OLD-ENTRY');
    await expect(hist).not.toContainText('OTHER-DOMAIN');
    // Never claimed as related to this request.
    await expect(card).not.toContainText('related to this request');

    // The sealed action is still there, above the context.
    await expect(card).toContainText('j.kraus@bavaria-umform.de');
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'a-request-and-history.png') });
  });

  test('B: no link → "No request linked."; approving still creates the contact', async () => {
    test.setTimeout(120_000);
    const card = await openCard(page, 'nosource@au10-nolink.de');
    await expect(card.getByTestId('au10-request')).toContainText('No request linked.', { timeout: 45_000 });
    await expect(card.getByTestId('au10-request')).not.toContainText('Linked by the AI');
    await expect(card.getByTestId('au10-history')).toContainText(HISTORY_LABEL);

    const shortId = ((await card.textContent()) ?? '').match(/Proposal:\s*([0-9a-f]{6,})/)?.[1];
    expect(shortId, 'card shows its proposal id').toBeTruthy();

    await card.locator('button:has-text("Approve")').click();
    await expect(async () => {
      const found = await withAgent(c => call(c, 'crm__find_contacts', { query: 'nosource@au10-nolink.de' }));
      expect(found).toContain('nosource@au10-nolink.de');
    }).toPass({ timeout: 45_000 });

    // Phase B: the decision carried the fingerprint of what the card showed —
    // one entry, for this approver, and only a hash (contract §8.4).
    if (!HAS_PHASE_B) return;
    const list = await page.request.get(`${SP_URL}/api/proposals?domain=owner&status=all`, { headers: { 'x-api-key': apiKey } });
    const proposals = ((await list.json()).proposals ?? []) as Array<{ id: string }>;
    const full = proposals.find(p => p.id.replace(/^prop_/, '').startsWith(shortId!) || p.id.startsWith(shortId!));
    expect(full, `proposal ${shortId} on the AS`).toBeTruthy();
    const got = await page.request.get(`${SP_URL}/api/proposals/${encodeURIComponent(full!.id)}`, { headers: { 'x-api-key': apiKey } });
    const shown = (await got.json()).proposal.shownHashes as Record<string, { hash: string; by: string }>;
    const entries = Object.values(shown ?? {});
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(shown)).not.toContain('No request linked');

    // The ticket view re-checks the local copy against that fingerprint.
    await page.click('.sidebar-item:has-text("Tickets")');
    await page.waitForURL('**/tickets');
    const what = page.getByTestId('au10-shown').first();
    await expect(what).toBeVisible({ timeout: 30_000 });
    await expect(what).toHaveAttribute('data-shown-status', 'verified');
    await expect(what).toContainText('What you saw');
    await what.screenshot({ path: join(SCREENSHOT_DIR, 'g-what-you-saw.png') });
  });

  test('C: an unreadable link is shown as such and never blocks', async () => {
    test.setTimeout(120_000);
    const unknown = await openCard(page, 'unknown@au10-bad.de');
    await expect(unknown.getByTestId('au10-request')).toContainText('Request: link not readable', { timeout: 45_000 });
    await expect(unknown.locator('button:has-text("Approve")')).toBeEnabled();

    const missing = page.locator('.card', { hasText: 'missing@au10-bad.de' }).first();
    await expect(missing).toBeVisible({ timeout: 30_000 });
    await expect(missing.getByTestId('au10-request')).toContainText('Request: this message no longer exists.', { timeout: 45_000 });
    await expect(missing.locator('button:has-text("Approve")')).toBeEnabled();
  });

  test('E: free-mail sender → only the exact address is matched, never the shared domain', async () => {
    test.setTimeout(120_000);
    const card = await openCard(page, 'Hans Privat Neu');
    const hist = card.getByTestId('au10-history');
    await expect(card.getByTestId('au10-request')).toContainText('Preisanfrage Ersatzteil', { timeout: 45_000 });
    await expect(hist).toContainText('Hans fragt nach Hammersatz', { timeout: 45_000 });
    await expect(hist).toContainText('hans.privat@gmail.com');
    await expect(hist).not.toContainText('matched by email domain');
    await expect(hist).not.toContainText('GMAIL-STRANGER');
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'e-free-mail.png') });
  });

  test('F: a reply with in_reply_to shows the request although the AI gave no _source', async () => {
    test.setTimeout(120_000);
    const card = await openCard(page, 'IMPLICIT-REPLY');
    const req = card.getByTestId('au10-request');
    await expect(req).toContainText('Linked by the AI', { timeout: 45_000 });
    await expect(req).toContainText('RF 55 Stillstand – Seriennummer 55-2291');
    await expect(card.getByTestId('au10-history')).toContainText('RF 55 steht, Ventil dringend', { timeout: 45_000 });
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'f-implicit-reply.png') });
  });

  test('H: sending an existing quote — the customer is found in two steps (quote → customer)', async () => {
    test.setTimeout(120_000);
    const card = await openCard(page, 'send_quote');
    const hist = card.getByTestId('au10-history');
    await expect(hist).toContainText('STEINER-CALL Rückfrage Keilriemen', { timeout: 45_000 });
    await expect(hist).toContainText('steiner-landtechnik.example');
    await expect(hist).not.toContainText('RF 55 steht');
    await expect(card.getByTestId('au10-request')).toContainText('No request linked.');
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'h-send-quote.png') });
  });

  // Last: it breaks the CRM for the rest of this run.
  test('I: CRM down → "not reachable", and approving is still possible', async () => {
    test.setTimeout(120_000);
    // A stopped connector is restarted by the gateway on its own (credential
    // push, sign-in), so "down" here is a CRM that cannot start: its
    // installed package is moved away, then the running process is stopped.
    // The registration stays — installed, but not reachable.
    const pkg = join(gatewayDataDir(), 'integrations', 'node_modules', '@humanagencyp', 'crm-mcp');
    renameSync(pkg, `${pkg}.broken`);
    try {
    const stop = await fetch(`${GW_MCP_URL}/internal/stop-all-running`, {
      method: 'POST', headers: { 'X-Internal-Secret': INTERNAL_SECRET },
    });
    expect(stop.ok, await stop.text()).toBe(true);

    const card = await openCard(page, 'Hans Privat Neu');
    const hist = card.getByTestId('au10-history');
    await expect(hist).toContainText('not reachable', { timeout: 45_000 });
    await expect(hist).toContainText('Read by the gateway');
    await expect(hist).not.toContainText('Hans fragt nach Hammersatz');
    await expect(card.locator('button:has-text("Approve")')).toBeEnabled();
    await card.screenshot({ path: join(SCREENSHOT_DIR, 'i-crm-down.png') });
    } finally {
      // The browser specs share one gateway: put the CRM back and wait until
      // every connector this spec stopped answers again.
      renameSync(`${pkg}.broken`, pkg);
      await signInToGateway(page, apiKey);
      await expect(async () => {
        const { tools } = await withAgent(c => c.listTools());
        for (const t of ['crm__find_contacts', 'erp__get_customer', 'mail__list_messages']) {
          expect(tools.some(x => x.name === t), `${t} listed again`).toBe(true);
        }
        await withAgent(c => call(c, 'crm__find_contacts', { query: 'Hans' }));
      }).toPass({ timeout: 60_000 });
    }
  });
});
