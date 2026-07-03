/**
 * Multiple Authorizations per Profile — Gateway E2E Test
 *
 * Regression guard for the bug where two grants under the SAME profile
 * (e.g. an "email send" grant and an "email read" grant, both email@0.4)
 * collided in the gateway: v0.4 removed execution paths, so the attestation
 * cache and gate store keyed by profileId, and the second grant silently
 * overwrote the first — one lost its intent ("Gate content not available")
 * and disappeared from the agent's list-authorizations.
 *
 * The fix keys the cache and gate store by authorizationId (unique per
 * authorization). This test creates two email@0.4 grants with distinct
 * bounds, scope, and intent, pushes their gate content WITHOUT an execution
 * path (the real v0.4 flow that collided), and asserts both survive — each
 * with its own intent, scope, and bounds — via the real MCP list-authorizations.
 *
 * No Gmail credentials needed: this exercises authorization listing/keying,
 * not email sending.
 *
 * Run:  npx vitest run test/multiple-grants-per-profile.test.ts
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

// ── Constants ───────────────────────────────────────────────────────────────

const SP_PORT = 16310;
const GW_PORT = 16240;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const BOUNDS_KEY_ORDER = ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max'];
const CONTEXT_KEY_ORDER = ['allowed_recipients', 'allowed_domains'];

// Two grants under the SAME profile, distinct on bounds, scope, and intent.
const GRANT_A = {
  bounds: { profile: PROFILE_ID, recipient_max: 5, send_daily_max: 20 },
  context: { allowed_recipients: 'alpha@sublin.app' },
  gateContent: { intent: 'AUTHORITY-ALPHA: send team updates within bounds.' },
};
const GRANT_B = {
  bounds: { profile: PROFILE_ID, recipient_max: 1, send_daily_max: 5 },
  context: { allowed_recipients: 'bravo@sublin.app' },
  gateContent: { intent: 'AUTHORITY-BRAVO: read-only inbox digest.' },
};

// ── Shared state ────────────────────────────────────────────────────────────

let userApiKey = '';
let userDid = '';
let personalGroupId = '';
let mcpClient: Client | null = null;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function submitGrant(grant: {
  bounds: Record<string, unknown>;
  context: Record<string, string>;
  gateContent: { intent: string };
}): Promise<string> {
  const gateContentHashes = hashGateContent(grant.gateContent);
  const executionContextHash = hashExecutionContext({ recipient_count: 1, ...grant.context });
  const boundsHash = computeBoundsHash(grant.bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash(grant.context, CONTEXT_KEY_ORDER);

  const result = await sp.submitAttestation(userApiKey, {
    profile_id: PROFILE_ID,
    group_id: personalGroupId,
    bounds: grant.bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'communications',
    did: userDid,
    commitment_mode: 'automatic',
    gate_content_hashes: gateContentHashes,
    execution_context_hash: executionContextHash,
  });

  // Push gate content WITHOUT a path — the real v0.4 flow. Pre-fix the gateway
  // keyed this by profileId, so the second grant overwrote the first.
  await gw.pushGateContent(
    {
      authorizationId: result.authorization_id,
      boundsHash: result.bounds_hash ?? boundsHash,
      contextHash,
      context: grant.context,
    },
    undefined,
    grant.gateContent,
  );

  return result.authorization_id;
}

async function listAuthorizations(domain?: string): Promise<string> {
  const result = await mcpClient!.callTool({
    name: 'list-authorizations',
    arguments: domain ? { domain } : {},
  });
  return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const user = await sp.register('Multi-grant E2E', `multigrant-e2e-${Date.now()}@test.local`);
  userApiKey = user.apiKey;
  userDid = user.user.did;
  personalGroupId = await sp.getPersonalGroupId(userApiKey);

  await pm.startGateway({
    port: GW_PORT,
    spUrl: SP_URL,
    spApiKey: userApiKey,
    profilesDir: PROFILES_DIR,
  });
  await gw.configure({ sessionCookie: 'multigrant-e2e-test', apiKey: userApiKey });

  // Two grants under the same profile, created back-to-back (the collision case).
  await submitGrant(GRANT_A);
  await submitGrant(GRANT_B);
  await sleep(500);

  const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
  mcpClient = new Client({ name: 'hap-multigrant-e2e', version: '0.1.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
}, 120_000);

afterAll(async () => {
  if (mcpClient) {
    try { await mcpClient.close(); } catch { /* ignore */ }
  }
  await pm.killAll();
}, 30_000);

// ═════════════════════════════════════════════════════════════════════════════

describe('Multiple authorizations per profile', () => {
  it('both grants survive and appear with their own intent, scope, and bounds', async () => {
    const text = await listAuthorizations('email');

    // Both grants present — proves no collision AND no cross-contamination
    // (each keeps its own intent).
    expect(text).toContain('AUTHORITY-ALPHA');
    expect(text).toContain('AUTHORITY-BRAVO');

    // Distinct scope preserved per grant.
    expect(text).toContain('alpha@sublin.app');
    expect(text).toContain('bravo@sublin.app');

    // Distinct bounds preserved per grant.
    expect(text).toContain('recipient_max: 5');
    expect(text).toContain('recipient_max: 1');

    // Two separate grant blocks for the same profile (pre-fix: only one).
    const emailBlocks = (text.match(/email@0\.4/g) ?? []).length;
    expect(emailBlocks).toBeGreaterThanOrEqual(2);
  });

  it('the compact overview also lists both grants', async () => {
    const text = await listAuthorizations();
    const emailBlocks = (text.match(/email@0\.4/g) ?? []).length;
    expect(emailBlocks).toBeGreaterThanOrEqual(2);
  });
});
