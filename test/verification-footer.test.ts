/**
 * Verification footer — happy-path E2E (gateway + real Gmail).
 *
 * Proves the full Level-1 loop end to end:
 *   1. A gated email send through the gateway gets a "Verified by Suveren" footer
 *      injected into its body (Category-A profile).
 *   2. The footer carries a /r/<receiptId> link.
 *   3. That receipt verifies on the AS: GET /api/as/public-receipt/:id →
 *      signatureValid:true, redacted.
 *
 * Requires Gmail OAuth creds (GMAIL_CLIENT_ID / _SECRET / _REFRESH_TOKEN) — the
 * suite auto-skips without them, so it's "ready to run once an integration is
 * connected". Mirrors the harness in email-lifecycle.test.ts.
 *
 * NOTE: read-back relies on Gmail search indexing the just-sent message, which
 * is eventually consistent — hence the retry loop in findSentBody().
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

const SP_PORT = 16110;
const GW_PORT = 16040;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
const PROFILE_SHORT = 'email';
const EXEC_PATH = 'email-send';
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const FOOTER_MARKER = '— Sent by an AI agent via Suveren';
const RECEIPT_LINK = /https?:\/\/[^\s"]+\/r\/([0-9a-fA-F-]{36})/;

const TEST_RECIPIENT = 'andreas@sublin.app';
const TEST_DOMAIN = 'sublin.app';
const BOUNDS = { profile: PROFILE_ID, recipient_max: 5, send_daily_max: 10 };
const CONTEXT = { allowed_recipients: TEST_RECIPIENT, allowed_domains: TEST_DOMAIN };
const GATE_CONTENT = { intent: 'E2E: verification-footer test — bounded automated email sending.' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
let userApiKey = '';
let userDid = '';
let personalGroupId = '';
let mcpClient: Client | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function submitEmailAttestation(): Promise<string> {
  const boundsHash = computeBoundsHash(BOUNDS, ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max']);
  const contextHash = computeContextHash(CONTEXT, ['allowed_recipients', 'allowed_domains']);
  const result = await sp.submitAttestation(userApiKey, {
    profile_id: PROFILE_ID,
    group_id: personalGroupId,
    bounds: BOUNDS,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'communications',
    did: userDid,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(GATE_CONTENT),
    execution_context_hash: hashExecutionContext({ recipient_count: 1, allowed_recipients: TEST_RECIPIENT, allowed_domains: TEST_DOMAIN }),
  });
  const hash = result.bounds_hash ?? result.frame_hash;
  await gw.pushGateContent({ boundsHash: hash, contextHash, context: CONTEXT }, EXEC_PATH, GATE_CONTENT);
  return hash;
}

/** Find the just-sent message body by subject, retrying for Gmail indexing. */
async function findSentBody(subject: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const list = await mcpClient!.callTool({ name: 'gmail__list_messages', arguments: { maxResults: 1, q: `subject:"${subject}"` } });
    const listText = (list.content as Array<{ text?: string }>)[0]?.text ?? '{}';
    const id = (JSON.parse(listText).messages ?? [])[0]?.id;
    if (id) {
      const msg = await mcpClient!.callTool({ name: 'gmail__get_message', arguments: { id } });
      return (msg.content as Array<{ text?: string }>)[0]?.text ?? '';
    }
    await sleep(2_000);
  }
  return '';
}

beforeAll(async () => {
  if (!HAS_GMAIL) return;
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  const user = await sp.register('Footer E2E', `footer-e2e-${Date.now()}@test.local`);
  userApiKey = user.apiKey;
  userDid = user.user.did;
  personalGroupId = await sp.getPersonalGroupId(userApiKey);
  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: userApiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: 'footer-e2e-test', apiKey: userApiKey });
  await gw.pushServiceCredentials('gmail', { clientId: GMAIL_CLIENT_ID, clientSecret: GMAIL_CLIENT_SECRET, refreshToken: GMAIL_REFRESH_TOKEN });
  await gw.addIntegration({
    id: 'gmail', name: 'Gmail', command: 'npx', args: ['-y', '@shinzolabs/gmail-mcp@latest'],
    envKeys: { CLIENT_ID: 'gmail.clientId', CLIENT_SECRET: 'gmail.clientSecret', REFRESH_TOKEN: 'gmail.refreshToken' },
    profile: PROFILE_SHORT, enabled: true,
  });
  await submitEmailAttestation();
  const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
  mcpClient = new Client({ name: 'hap-footer-e2e', version: '0.1.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
  await sleep(1_000);
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

describe.skipIf(!HAS_GMAIL)('verification footer — happy path', () => {
  it('injects a verify link into the sent body, and that receipt verifies on the AS', async () => {
    const subject = `HAP Footer E2E — ${Date.now()}`;
    const send = await mcpClient!.callTool({
      name: 'gmail__send_message',
      arguments: { to: [TEST_RECIPIENT], subject, body: 'Automated footer e2e — ignore.' },
    });
    expect(send.isError).toBeFalsy();

    const body = await findSentBody(subject);
    expect(body).toContain(FOOTER_MARKER);

    const m = body.match(RECEIPT_LINK);
    expect(m).not.toBeNull();
    const receiptId = m![1];

    const res = await fetch(`${SP_URL}/api/as/public-receipt/${receiptId}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, unknown>;
    expect(view.signatureValid).toBe(true);
    expect(view.profileId).toBe(PROFILE_ID);
    // redaction holds end-to-end
    for (const f of ['userId', 'cumulativeState', 'limits', 'executionContext', 'signature']) {
      expect(view[f]).toBeUndefined();
    }
  }, 120_000);
});
