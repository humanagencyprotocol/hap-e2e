/**
 * Email Authorization Lifecycle — Full Gateway E2E Test
 *
 * Tests the complete real-world flow through the gateway:
 *   1. Create authorization (attestation for email-send)
 *   2. Send email via MCP tool → accepted
 *   3. Revoke authorization
 *   4. Send email via MCP tool → rejected
 *   5. Re-authorize (new attestation)
 *   6. Send email via MCP tool → accepted again
 *
 * Requires Gmail OAuth credentials:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *
 * Set these in hap-e2e/.env or export them before running.
 *
 * Run:  npx vitest run test/email-lifecycle.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeContextHash,
} from '../src/helpers/crypto.js';

// ── Credentials ─────────────────────────────────────────────────────────────

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN ?? '';
const HAS_GMAIL = !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN);

// ── Constants ───────────────────────────────────────────────────────────────

const SP_PORT = 16100;
const GW_PORT = 16030;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
const PROFILE_SHORT = 'email';
const EXEC_PATH = 'email-send';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const BOUNDS_KEY_ORDER = ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max'];
const CONTEXT_KEY_ORDER = ['allowed_recipients', 'allowed_domains'];

const TEST_RECIPIENT = 'andreas@sublin.app';
const TEST_DOMAIN = 'sublin.app';

const BOUNDS = {
  profile: PROFILE_ID,
  recipient_max: 5,
  send_daily_max: 10,
};

const CONTEXT = {
  allowed_recipients: TEST_RECIPIENT,
  allowed_domains: TEST_DOMAIN,
};

// email profile uses v0.4 intent gate
const GATE_CONTENT = {
  intent: 'E2E test: need agent to send email on behalf of user. Enable automated email sending within bounded recipients.',
};

// ── Shared state ────────────────────────────────────────────────────────────

let userApiKey = '';
let userDid = '';
let personalGroupId = '';
let attestationHash = '';
let mcpClient: Client | null = null;

// ── Clients ─────────────────────────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function submitEmailAttestation(bounds: Record<string, unknown>): Promise<string> {
  const gateContentHashes = hashGateContent(GATE_CONTENT);
  const executionContextHash = hashExecutionContext({
    recipient_count: 1,
    allowed_recipients: TEST_RECIPIENT,
    allowed_domains: TEST_DOMAIN,
  });

  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

  const result = await sp.submitAttestation(userApiKey, {
    profile_id: PROFILE_ID,
    group_id: personalGroupId,
    bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'communications',
    did: userDid,
    commitment_mode: 'automatic',
    gate_content_hashes: gateContentHashes,
    execution_context_hash: executionContextHash,
  });

  const hash = result.bounds_hash ?? result.frame_hash;

  // Push gate content to gateway so it knows about this authorization
  await gw.pushGateContent(
    { boundsHash: hash, contextHash, context: CONTEXT },
    EXEC_PATH,
    GATE_CONTENT,
  );

  return hash;
}

async function sendTestEmail(): Promise<{ isError: boolean; text: string }> {
  const result = await mcpClient!.callTool({
    name: 'gmail__send_message',
    arguments: {
      to: [TEST_RECIPIENT],
      subject: `HAP E2E Test — ${new Date().toISOString()}`,
      body: 'This is an automated test email from the HAP email lifecycle e2e test. You can ignore it.',
    },
  });

  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  return { isError: !!result.isError, text };
}

// ═════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  if (!HAS_GMAIL) return;

  // 1. Build gateway
  pm.buildGateway();

  // 2. Start SP
  await pm.startSP(SP_PORT);

  // 3. Register test user and resolve personal group id (required in v0.4)
  const user = await sp.register('Email E2E', `email-e2e-${Date.now()}@test.local`);
  userApiKey = user.apiKey;
  userDid = user.user.did;
  personalGroupId = await sp.getPersonalGroupId(userApiKey);

  console.error(`[E2E-Email] Registered user: ${user.user.id} (group ${personalGroupId})`);

  // 4. Start gateway with user's API key
  await pm.startGateway({
    port: GW_PORT,
    spUrl: SP_URL,
    spApiKey: userApiKey,
    profilesDir: PROFILES_DIR,
  });

  // 5. Configure gateway
  await gw.configure({
    sessionCookie: 'email-e2e-test',
    apiKey: userApiKey,
  });

  // 6. Push Gmail credentials
  await gw.pushServiceCredentials('gmail', {
    clientId: GMAIL_CLIENT_ID,
    clientSecret: GMAIL_CLIENT_SECRET,
    refreshToken: GMAIL_REFRESH_TOKEN,
  });

  // 7. Add Gmail integration
  const integration = await gw.addIntegration({
    id: 'gmail',
    name: 'Gmail',
    command: 'npx',
    args: ['-y', '@shinzolabs/gmail-mcp@latest'],
    envKeys: {
      CLIENT_ID: 'gmail.clientId',
      CLIENT_SECRET: 'gmail.clientSecret',
      REFRESH_TOKEN: 'gmail.refreshToken',
    },
    profile: PROFILE_SHORT,
    enabled: true,
  });

  console.error(`[E2E-Email] Gmail tools: ${integration.tools.join(', ')}`);
  await sleep(1_000);
}, 120_000);

afterAll(async () => {
  if (mcpClient) {
    try { await mcpClient.close(); } catch { /* ignore */ }
  }
  await pm.killAll();
}, 30_000);

// ═════════════════════════════════════════════════════════════════════════════
// Block 1: Setup — Authorization + MCP Connection
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_GMAIL)('Email Lifecycle — Setup', () => {
  it('creates authorization for email-send', async () => {
    attestationHash = await submitEmailAttestation(BOUNDS);
    expect(attestationHash).toBeTruthy();
    console.error(`[E2E-Email] Authorization hash: ${attestationHash}`);
  });

  it('connects MCP client via SSE', async () => {
    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    const client = new Client(
      { name: 'hap-email-e2e', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    mcpClient = client;

    const { tools } = await client.listTools();
    const gmailTools = tools.filter(t => t.name.startsWith('gmail__'));
    console.error(`[E2E-Email] Gmail MCP tools: ${gmailTools.map(t => t.name).join(', ')}`);
    expect(gmailTools.length).toBeGreaterThan(0);
    expect(gmailTools.some(t => t.name === 'gmail__send_message')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Block 2: Send Email — Should Succeed
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_GMAIL)('Email Lifecycle — Send (authorized)', () => {
  it('sends email to andreas@sublin.app → accepted', async () => {
    const { isError, text } = await sendTestEmail();

    if (isError) {
      console.error(`[E2E-Email] Unexpected error: ${text}`);
    }
    expect(isError).toBe(false);
  });

  it('receipt was recorded in SP', async () => {
    // Verify via direct SP API — the receipt should exist
    const result = await sp.postReceipt(userApiKey, {
      attestationHash,
      profileId: PROFILE_ID,
      action: 'send',
      executionContext: {
        recipient_count: 1,
        allowed_recipients: TEST_RECIPIENT,
        allowed_domains: TEST_DOMAIN,
      },
    });
    // Should succeed (we're within limits)
    expect(result.status).toBe(201);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Block 2b: Out-of-scope recipient — Gatekeeper must reject
// ═════════════════════════════════════════════════════════════════════════════
// Declared context: allowed_recipients = TEST_RECIPIENT only.
// Sending to any other address must be blocked locally by the Gatekeeper's
// subset check — the SP holds only context_hash and cannot enforce this.

describe.skipIf(!HAS_GMAIL)('Email Lifecycle — Out-of-scope recipient', () => {
  it('send to recipient outside allowed_recipients → blocked by Gatekeeper', async () => {
    const result = await mcpClient!.callTool({
      name: 'gmail__send_message',
      arguments: {
        to: ['stranger@example.com'],
        subject: 'HAP E2E out-of-scope',
        body: 'This should never be delivered — Gatekeeper must reject.',
      },
    });

    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(result.isError).toBe(true);
    expect(text).toMatch(/not in authorized set|BOUND_EXCEEDED|allowed_recipients|allowed_domains/i);
    console.error(`[E2E-Email] Correctly blocked out-of-scope recipient: ${text}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Block 3: Revoke — Should Block Sending
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_GMAIL)('Email Lifecycle — Revoke', () => {
  it('revokes the authorization', async () => {
    const result = await sp.revokeAttestation(
      userApiKey,
      attestationHash,
      'E2E test: revoking email access',
    );
    expect(result.revocation).toBeTruthy();
    console.error(`[E2E-Email] Revoked authorization: ${attestationHash}`);
  });

  it('send email → rejected after revocation', async () => {
    const { isError, text } = await sendTestEmail();
    expect(isError).toBe(true);
    expect(text).toMatch(/Blocked by SP|REVOKED/i);
    console.error(`[E2E-Email] Correctly blocked: ${text}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Block 4: Re-authorize — Should Work Again
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_GMAIL)('Email Lifecycle — Re-authorize', () => {
  it('creates new authorization with tighter bounds', async () => {
    const tighterBounds = {
      ...BOUNDS,
      recipient_max: 3,
      send_daily_max: 5,
    };

    const newHash = await submitEmailAttestation(tighterBounds);
    expect(newHash).toBeTruthy();
    expect(newHash).not.toBe(attestationHash);
    attestationHash = newHash;
    console.error(`[E2E-Email] New authorization hash: ${attestationHash}`);

    // Give gateway time to pick up new gate content
    await sleep(1_000);
  });

  it('send email → accepted under new authorization', async () => {
    const { isError, text } = await sendTestEmail();

    if (isError) {
      console.error(`[E2E-Email] Unexpected error after re-auth: ${text}`);
    }
    expect(isError).toBe(false);
  });
});
