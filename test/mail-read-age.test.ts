/**
 * Mail (email-mcp) read-age window — Gateway E2E (gateway PR #116,
 * fix/gmail-read-access, G3).
 *
 * mail.json's get_message now declares a full per-item age adapter
 * (`resultDatePath: "received_at"`, a flat field in the real connector's
 * response) and `readPolicy.defaultAgeDays: 30` backfills existing/new
 * installs so they don't immediately fail closed on an unset window (F11).
 * list_messages only declares `ageField` (no resultDatePath) — the connector
 * has no query arg to inject an age ceiling into, so it is window-gated
 * (fails closed if no window is set at all) but NOT item-verified; only
 * get_message checks an individual message's age.
 *
 * `load_simulation` deliberately IGNORES a package's own `received_at` (see
 * hap-email-mcp/src/tools/simulation.ts: "a package's own `received_at` is
 * ignored — fixed dates would look stale on every re-run") — every seeded
 * message lands within the hour before load. To get a genuinely old message
 * for this test, we backdate it directly in the connector's own SQLite file
 * at its real on-disk path (`${HAP_DATA_DIR}/email.db`) between tool calls —
 * the real connector, the real schema, just reaching around a load-time
 * default the connector itself does not let an agent control.
 *
 * Uses the SHIPPED mail.json manifest (not an inline copy).
 *
 * Run: npx vitest run test/mail-read-age.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeScopeHash,
} from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const MAIL_MANIFEST = join(ROOT, 'suveren-gateway', 'content', 'integrations', 'mail.json');

function gatewayHasFix(): boolean {
  if (!existsSync(MAIL_MANIFEST)) return false;
  try {
    const mail = JSON.parse(readFileSync(MAIL_MANIFEST, 'utf8'));
    return (
      typeof mail.readPolicy?.defaultAgeDays === 'number' &&
      mail.toolGating?.overrides?.get_message?.read?.resultDatePath === 'received_at'
    );
  } catch {
    return false;
  }
}
const available = gatewayHasFix();

const PROFILE_ID = PROFILE_V07.email;
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'];
const WINDOW_DAYS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal but SCHEMA-VALID simulation package — the connector's own
 *  parser only needs name+cases, but the MCP tool's declared inputSchema
 *  (mirroring SIMULATION_PACKAGE_SCHEMA) requires currency/customers/products
 *  too, and the MCP SDK validates client-side before the call even reaches
 *  the connector. */
function minimalPackage(name: string, caseId: string) {
  return {
    name,
    currency: 'EUR',
    customers: [{ name: 'A Customer', credit_limit: 0 }],
    products: [{ sku: 'SKU-1', name: 'Product', list_price: 1, stock: 1 }],
    cases: [{
      id: caseId,
      request: { from: { name: 'A Customer', email: 'customer@example.com' }, subject: 'Hello', body: 'A question.' },
      reply: { subject: 'Re: Hello', body: 'An answer.' },
    }],
  };
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { text, isError: result.isError === true };
}

/** Directly set a message's received_at in the connector's own SQLite file —
 *  the only way to get a controllable date, since load_simulation ignores
 *  the package's own received_at by design. */
function setReceivedAt(dataDir: string, messageId: string, iso: string): void {
  execFileSync('sqlite3', [
    join(dataDir, 'email.db'),
    `UPDATE messages SET received_at = '${iso}' WHERE id = '${messageId}';`,
  ]);
}

interface Stack {
  pm: ProcessManager;
  gw: GatewayClient;
  client: Client;
}

async function boot(spPort: number, gwPort: number, opts: { readAgeDays?: number; boundReadMaxAge?: number }): Promise<Stack> {
  const pm = new ProcessManager();
  const spUrl = `http://localhost:${spPort}`;
  const gwUrl = `http://localhost:${gwPort}`;
  const sp = new SPClient(spUrl);
  const gw = new GatewayClient(gwUrl);

  pm.buildGateway();
  await pm.startSP(spPort);

  const user = await sp.register('MailReadAge E2E', `mail-readage-${spPort}-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  // This suite only needs `mail` — skip auto-provisioning crm/erp/records.
  const prevAuto = process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
  process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = '1';
  try {
    await pm.startGateway({ port: gwPort, spUrl, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  } finally {
    if (prevAuto === undefined) delete process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
    else process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = prevAuto;
  }
  await gw.configure({ sessionCookie: `mail-readage-${spPort}`, apiKey });

  const bounds: Record<string, string | number> = {
    profile: PROFILE_ID,
    read_access: 'unlimited',
    recipient_max: 5,
    send_daily_max: 10,
    setup_daily_max: 5,
  };
  // read_max_age_days is required:false on the email profile — omitted
  // entirely (not 0) models "never configured" so resolveAgeBoundField /
  // maxReadAgeDays genuinely see no value (canonicalRecords skips
  // undefined/null keys — see crypto.ts), not a very-strict 0-day window.
  if (opts.boundReadMaxAge !== undefined) bounds.read_max_age_days = opts.boundReadMaxAge;
  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeScopeHash({}, []);
  const gateContent = { intent: 'mail read-age E2E' };

  const att = await sp.submitMandate(apiKey, {
    profile_id: PROFILE_ID,
    profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR),
    group_id: groupId,
    bounds,
    bounds_hash: boundsHash,
    scope_hash: contextHash,
    domain: 'communications',
    did: user.user.did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gateContent),
    execution_context_hash: hashExecutionContext({ profile: PROFILE_ID, domain: 'communications' }),
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
    PROFILE_ID,
    gateContent,
  );

  const mail = JSON.parse(readFileSync(MAIL_MANIFEST, 'utf8'));
  await gw.addIntegration({
    id: mail.id,
    name: mail.name,
    command: mail.mcp.command,
    args: mail.mcp.args,
    envKeys: {},
    profile: mail.profile,
    enabled: true,
    toolGating: mail.toolGating,
    npmPackage: mail.npmPackage,
    ...(opts.readAgeDays !== undefined ? { readAgeDays: opts.readAgeDays } : {}),
  } as Parameters<GatewayClient['addIntegration']>[0]);
  await gw.waitForIntegration('mail');
  await sleep(500);

  const client = new Client({ name: 'hap-mail-readage-e2e', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${gwUrl}/sse`)));
  return { pm, gw, client };
}

// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!available)('Mail (email-mcp) read-age window — get_message per-item enforcement', () => {
  let stack: Stack;
  let messageId: string;

  beforeAll(async () => {
    // Window of 30 days, set as the integration's LOCAL readAgeDays (the
    // owner's live setting — wins over any grant bound, per read-gate.ts's
    // precedence comment).
    stack = await boot(19120, 19121, { readAgeDays: WINDOW_DAYS });

    const pkg = minimalPackage('Mail Read Age Co', 'c1');
    const r = await stack.client.callTool({ name: 'mail__load_simulation', arguments: { package: pkg } });
    expect(r.isError).not.toBe(true);

    const list = await callText(stack.client, 'mail__list_messages', {});
    const parsed = JSON.parse(list.text);
    messageId = parsed[0].id;
  }, 180_000);

  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('a freshly-seeded (recent) message is readable', async () => {
    const { text, isError } = await callText(stack.client, 'mail__get_message', { id: messageId });
    expect(isError).toBe(false);
    expect(text).not.toContain('Read blocked');
    const parsed = JSON.parse(text);
    expect(parsed.id).toBe(messageId);
  });

  it('the same message, backdated beyond the 30-day window, is refused — content withheld', async () => {
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    setReceivedAt(stack.pm.getDataDir(), messageId, oldDate);

    const { text, isError } = await callText(stack.client, 'mail__get_message', { id: messageId });
    expect(isError).toBe(true);
    expect(text).toContain('Read blocked');
    expect(text.toLowerCase()).toContain('older than');
    expect(text).toContain(`${WINDOW_DAYS}-day`);
    // The body must not leak on a blocked read.
    expect(text).not.toMatch(/"body"|"snippet"/);
  });

  it('the same message, moved back inside the window, is readable again', async () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    setReceivedAt(stack.pm.getDataDir(), messageId, recentDate);

    const { text, isError } = await callText(stack.client, 'mail__get_message', { id: messageId });
    expect(isError).toBe(false);
    expect(text).not.toContain('Read blocked');
  });
});

describe.skipIf(!available)('Mail (email-mcp) read-age window — fail-closed when no window is set anywhere (F11)', () => {
  let stack: Stack;
  let messageId: string;

  beforeAll(async () => {
    // Neither the integration's local readAgeDays NOR the grant's
    // read_max_age_days bound is set — both opts are omitted, and `boot`
    // leaves read_max_age_days out of the bounds object entirely (not 0),
    // so resolveAgeBoundField/maxReadAgeDays see genuinely no value.
    stack = await boot(19122, 19123, {});

    const pkg = minimalPackage('Mail No Window Co', 'c1');
    const r = await stack.client.callTool({ name: 'mail__load_simulation', arguments: { package: pkg } });
    expect(r.isError).not.toBe(true);

    // list_messages is ALSO F11-gated (no window anywhere), so it cannot be
    // used to fetch a real id in this stack — not needed anyway: the F11
    // check happens before any fetch, so a placeholder id still proves it.
    messageId = 'placeholder-id';
  }, 180_000);

  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('get_message is refused — no read-age window is set for this integration', async () => {
    const { text, isError } = await callText(stack.client, 'mail__get_message', { id: messageId });
    expect(isError).toBe(true);
    expect(text).toContain('Read blocked');
    expect(text.toLowerCase()).toContain('no read-age window is set');
  });
});
