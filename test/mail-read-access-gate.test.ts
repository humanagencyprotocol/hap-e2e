/**
 * Mail (email-mcp) read_access gate — Gateway E2E (gateway PR #116,
 * fix/gmail-read-access, G1/G3).
 *
 * THE GAP (gmail-specific, generalized here for email-mcp): gmail's
 * list_messages/get_message declared category:"read" with an age adapter but
 * no boundField/requiredValue, so the email profile's read_access switch was
 * never checked — a mandate with read_access:"none" still let reads through.
 * mail.json (email-mcp) already had boundField/requiredValue wired before
 * this PR; this PR adds the `read` age adapter alongside it. This suite
 * proves read_access is still enforced on mail__list_messages/get_message
 * now that the age adapter sits next to it, using the SHIPPED manifest (not
 * an inline copy) — the whole point of the gap this PR fixes was that a test
 * using a hand-written copy of the gating config would not have caught a
 * manifest regression.
 *
 * Real @humanagencyp/email-mcp (local SQLite simulation) — no credentials,
 * no external side effects. Two isolated stacks so the block/allow grants
 * don't mix.
 *
 * Run: npx vitest run test/mail-read-access-gate.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
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
const READ_GATE_SRC = join(ROOT, 'suveren-gateway', 'apps', 'mcp-server', 'src', 'lib', 'read-gate.ts');

// Feature gate (not a sibling-checkout gate): this suite needs the gateway
// PR #116 (fix/gmail-read-access) source — detected generically from the
// gateway's own checkout rather than hardcoding a version. `classifyEnumSwitches`
// is the D6 guard that PR introduces; mail.json's `readPolicy.defaultAgeDays`
// is the G3 backfill field it also introduces for email-mcp. Both must be
// present or this gateway predates the fix under test.
function gatewayHasFix(): boolean {
  if (!existsSync(MAIL_MANIFEST) || !existsSync(READ_GATE_SRC)) return false;
  try {
    const mail = JSON.parse(readFileSync(MAIL_MANIFEST, 'utf8'));
    const src = readFileSync(READ_GATE_SRC, 'utf8');
    return (
      typeof mail.readPolicy?.defaultAgeDays === 'number' &&
      mail.toolGating?.overrides?.list_messages?.boundField === 'read_access' &&
      mail.toolGating?.overrides?.get_message?.boundField === 'read_access' &&
      src.includes('classifyEnumSwitches')
    );
  } catch {
    return false;
  }
}
const available = gatewayHasFix();

const PROFILE_ID = PROFILE_V07.email;
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Stack {
  pm: ProcessManager;
  client: Client;
}

/** Boot an isolated stack with a single mail grant at the given read_access,
 *  registering the `mail` integration from the SHIPPED manifest. */
async function boot(spPort: number, gwPort: number, readAccess: 'unlimited' | 'none'): Promise<Stack> {
  const pm = new ProcessManager();
  const spUrl = `http://localhost:${spPort}`;
  const gwUrl = `http://localhost:${gwPort}`;
  const sp = new SPClient(spUrl);
  const gw = new GatewayClient(gwUrl);

  pm.buildGateway();
  await pm.startSP(spPort);

  const user = await sp.register('MailReadGate E2E', `mail-readgate-${spPort}-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  // This suite only needs `mail`. Skip auto-provisioning crm/erp/records
  // (personalDefault) — their npm install cost is unneeded here, and it is
  // never required for an email-only suite to pull them in at all.
  const prevAuto = process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
  process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = '1';
  try {
    await pm.startGateway({ port: gwPort, spUrl, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  } finally {
    if (prevAuto === undefined) delete process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
    else process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = prevAuto;
  }
  await gw.configure({ sessionCookie: `mail-readgate-${spPort}`, apiKey });

  const bounds = {
    profile: PROFILE_ID,
    read_access: readAccess,
    recipient_max: 5,
    send_daily_max: 10,
    read_max_age_days: 30,
    setup_daily_max: 5,
  };
  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeScopeHash({}, []);
  const gateContent = { intent: `mail read_access=${readAccess}` };

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

  // Register `mail` from the SHIPPED manifest (not an inline copy) — read
  // the real content/integrations/mail.json bytes, exactly as the gateway's
  // own control-plane bridge would resolve them.
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
    readAgeDays: mail.readPolicy?.defaultAgeDays,
  } as Parameters<GatewayClient['addIntegration']>[0]);
  await gw.waitForIntegration('mail');
  await sleep(500);

  const client = new Client({ name: 'hap-mail-readgate-e2e', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${gwUrl}/sse`)));
  return { pm, client };
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

// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!available)('Mail (email-mcp) read_access gate — read_access:none is blocked', () => {
  let stack: Stack;
  beforeAll(async () => { stack = await boot(19100, 19101, 'none'); }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('mail__list_messages is refused when the grant lacks read_access:unlimited', async () => {
    const { text, isError } = await callText(stack.client, 'mail__list_messages', {});
    expect(isError).toBe(true);
    expect(text).toContain('Read blocked');
    expect(text).toContain('read_access');
  });

  it('mail__get_message is refused when the grant lacks read_access:unlimited', async () => {
    const { text, isError } = await callText(stack.client, 'mail__get_message', { id: 'anything' });
    expect(isError).toBe(true);
    expect(text).toContain('Read blocked');
    expect(text).toContain('read_access');
  });
});

describe.skipIf(!available)('Mail (email-mcp) read_access gate — read_access:unlimited is allowed', () => {
  let stack: Stack;
  let messageId: string;
  beforeAll(async () => {
    stack = await boot(19110, 19111, 'unlimited');
    // Seed one message so get_message has a real id to fetch.
    const pkg = minimalPackage('Mail Read Gate Co', 'c1');
    const r = await stack.client.callTool({ name: 'mail__load_simulation', arguments: { package: pkg } });
    expect(r.isError).not.toBe(true);
  }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('mail__list_messages is permitted when the grant has read_access:unlimited', async () => {
    const { text, isError } = await callText(stack.client, 'mail__list_messages', {});
    expect(isError).toBe(false);
    expect(text).not.toContain('Read blocked');
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    messageId = parsed[0].id;
  });

  it('mail__get_message is permitted when the grant has read_access:unlimited', async () => {
    expect(messageId, 'messageId from the previous test').toBeTruthy();
    const { text, isError } = await callText(stack.client, 'mail__get_message', { id: messageId });
    expect(isError).toBe(false);
    expect(text).not.toContain('Read blocked');
    const parsed = JSON.parse(text);
    expect(parsed.id).toBe(messageId);
  });
});
