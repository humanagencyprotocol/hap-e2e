/**
 * Email read-age enforcement — Gateway E2E (Finding A, doc §1 F1 — the pentest hole).
 *
 * Asserts that `read_max_age_days` is ENFORCED on email reads:
 *   - list_messages: an explicitly-old query is neutralized by the injected
 *     `newer_than:{days}d` ceiling → out-of-bounds mail can't come back;
 *   - list_messages: a HOSTILE query fragment cannot escape that ceiling (F8) —
 *     a trailing `OR`/unbalanced paren is refused, an interior `OR` is bracketed;
 *   - get_message: a message older than the window is BLOCKED, content withheld.
 *
 * CREDENTIAL-GATED (skipIf !HAS_GMAIL) — needs real Gmail OAuth. The get-block
 * assertion additionally needs a known old message id via GMAIL_OLD_MESSAGE_ID
 * (a message in the test mailbox older than READ_MAX_AGE_DAYS); without it, that
 * one assertion is skipped. This file is NOT run in the credential-less dev/CI
 * environment — it is the on-hardware validation of the generic read-age path
 * whose decision logic is already unit-tested in
 * suveren-gateway/apps/mcp-server/test/read-gate.test.ts.
 *
 * Run (with creds):
 *   GMAIL_CLIENT_ID=… GMAIL_CLIENT_SECRET=… GMAIL_REFRESH_TOKEN=… \
 *   [GMAIL_OLD_MESSAGE_ID=…] npx vitest run test/email-read-age.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN ?? '';
const HAS_GMAIL = !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN);
const OLD_MESSAGE_ID = process.env.GMAIL_OLD_MESSAGE_ID ?? '';
const SPAM_MESSAGE_ID = process.env.GMAIL_SPAM_MESSAGE_ID ?? '';

const SP_PORT = 17270;
const GW_PORT = 17271;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
const PROFILE_SHORT = 'email';
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const READ_MAX_AGE_DAYS = 30;
const BOUNDS_KEY_ORDER = ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max'];
const CONTEXT_KEY_ORDER = ['allowed_recipients', 'allowed_domains'];
const BOUNDS = {
  profile: PROFILE_ID,
  recipient_max: 5,
  send_daily_max: 10,
  read_max_age_days: READ_MAX_AGE_DAYS,
  read_daily_max: 100,
};
// Unscoped (no recipient scope) so these AGE tests aren't also gated by
// coverage — an unscoped grant covers every correspondent. Coverage/scope
// enforcement is unit-tested in read-gate.test.ts and verified live on the dev
// gateway (a scoped grant + an out-of-scope correspondent → coverage denial).
const CONTEXT: Record<string, string> = {};

// The read adapters under test (mirror content/integrations/gmail.json).
const GMAIL_TOOL_GATING = {
  default: { executionMapping: {}, staticExecution: { recipient_count: 0 } },
  overrides: {
    send_message: {
      executionMapping: {
        to: [
          { field: 'recipient_count', transform: 'length' },
          { field: 'allowed_recipients', transform: 'join' },
          { field: 'allowed_domains', transform: 'join_domains' },
        ],
      },
      staticExecution: { action_type: 'send' },
    },
    list_messages: {
      category: 'read',
      read: {
        ageField: 'read_age_days', queryArg: 'q', ageConstraint: 'newer_than:{days}d',
        pinnedArgs: { includeSpamTrash: false }, // F7 spam pin
      },
    },
    get_message: {
      category: 'read',
      read: {
        ageField: 'read_age_days', resultDatePath: 'internalDate',
        blockResultValues: ['SPAM', 'TRASH'], resultValuesPath: 'labelIds', // F7 spam pin
      },
    },
  },
};

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
let mcpClient: Client;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callText(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await mcpClient.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { text, isError: result.isError === true };
}

beforeAll(async () => {
  if (!HAS_GMAIL) return;

  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const user = await sp.register('Email Read-Age E2E', `email-readage-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: 'email-readage-e2e', apiKey });

  const boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);
  const gateContent = { intent: 'Read recent mail within a 30-day window for E2E.' };

  const att = await sp.submitAttestation(apiKey, {
    profile_id: PROFILE_ID,
    group_id: groupId,
    bounds: BOUNDS,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'communications',
    did: user.user.did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gateContent),
    execution_context_hash: hashExecutionContext({ recipient_count: 1, ...CONTEXT }),
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: CONTEXT },
    PROFILE_ID,
    gateContent,
  );

  await gw.pushServiceCredentials('gmail', {
    clientId: GMAIL_CLIENT_ID,
    clientSecret: GMAIL_CLIENT_SECRET,
    refreshToken: GMAIL_REFRESH_TOKEN,
  });
  await gw.addIntegration({
    id: 'gmail',
    name: 'Gmail',
    command: 'npx',
    args: ['-y', '@shinzolabs/gmail-mcp@latest'],
    envKeys: { CLIENT_ID: 'gmail.clientId', CLIENT_SECRET: 'gmail.clientSecret', REFRESH_TOKEN: 'gmail.refreshToken' },
    profile: PROFILE_SHORT,
    enabled: true,
    toolGating: GMAIL_TOOL_GATING,
  });
  await sleep(6_000);

  mcpClient = new Client({ name: 'hap-email-readage-e2e', version: '0.1.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

describe.skipIf(!HAS_GMAIL)('Email read-age enforcement', () => {
  it('list_messages: an explicitly-old query is neutralized (injected newer_than wins)', async () => {
    // Without the gateway, `older_than:365d` would return old mail. The gateway
    // ANDs in `newer_than:30d`, which contradicts it → no messages come back.
    const { text, isError } = await callText('gmail__list_messages', { q: 'older_than:365d' });
    expect(isError).toBe(false);
    // No message ids in the payload (Gmail returns {"messages":[...]} only when non-empty).
    expect(/"id"\s*:/.test(text)).toBe(false);
  });

  it('list_messages: a within-window query is permitted', async () => {
    const { isError } = await callText('gmail__list_messages', { q: 'newer_than:7d' });
    expect(isError).toBe(false);
  });

  // ── F8: the agent's own query must not escape the injected ceiling ─────────
  //
  // Enforcement here is BY CONSTRUCTION — the gateway ANDs `newer_than:30d`
  // onto the agent's `q`. Before the fix the two were space-joined, so a
  // fragment ending in `OR` produced `older_than:365d OR newer_than:30d` — a
  // union, and year-old mail came back. The gateway now brackets the agent's
  // fragment and refuses one that can't be safely combined.

  it('list_messages: a trailing OR cannot turn the AND into a union', async () => {
    const { text, isError } = await callText('gmail__list_messages', { q: 'older_than:365d OR' });
    // Fail closed: the request is denied rather than silently rewritten.
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain('dangling operator');
    // The bypass payload must not come back under any circumstance.
    expect(/"id"\s*:/.test(text)).toBe(false);
  });

  it('list_messages: an unbalanced parenthesis is refused', async () => {
    const { text, isError } = await callText('gmail__list_messages', { q: '(older_than:365d' });
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain('unbalanced parentheses');
  });

  it('list_messages: an interior OR is contained by bracketing, ceiling still applies', async () => {
    // Legitimate disjunction — allowed, but bracketed so `newer_than:30d` is
    // ANDed against the WHOLE expression, not made one of its alternatives.
    const { text, isError } = await callText('gmail__list_messages', {
      q: 'older_than:365d OR older_than:400d',
    });
    expect(isError).toBe(false);
    expect(/"id"\s*:/.test(text)).toBe(false); // both disjuncts are out of window
  });

  it.skipIf(!OLD_MESSAGE_ID)('get_message: a message older than the window is blocked, content withheld', async () => {
    const { text, isError } = await callText('gmail__get_message', { id: OLD_MESSAGE_ID });
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain('older than');
    // The body must NOT leak — no snippet/payload fields in a blocked read.
    expect(text).not.toMatch(/"snippet"|"payload"/);
  });

  // ── F7 spam pin ────────────────────────────────────────────────────────────
  // Set GMAIL_SPAM_MESSAGE_ID to a message currently in Spam/Trash to run these.

  it('list_messages: the agent cannot opt into spam (includeSpamTrash is pinned false)', async () => {
    // Even asking for spam, the gateway forces includeSpamTrash:false. Without a
    // known spam id we can't assert exclusion of a specific message, but the call
    // must still succeed (the pin is applied, not rejected) and stay in-window.
    const { isError } = await callText('gmail__list_messages', { q: 'newer_than:7d', includeSpamTrash: true });
    expect(isError).toBe(false);
  });

  it.skipIf(!SPAM_MESSAGE_ID)('get_message: a spam/trash message is blocked, content withheld', async () => {
    const { text, isError } = await callText('gmail__get_message', { id: SPAM_MESSAGE_ID });
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain('spam');
    expect(text).not.toMatch(/"snippet"|"payload"/);
  });
});
