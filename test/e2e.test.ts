import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, computeFrameHash, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';
import { ctx } from '../src/helpers/context.js';

// ── Constants ─────────────────────────────────────────────

const SP_PORT = 14100;
const GW_PORT = 13030;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
const PROFILE_SHORT = 'charge';
const EXEC_PATH = 'charge-routine';

const STRIPE_TEST_KEY = process.env.STRIPE_TEST_KEY ?? '';
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

/** v0.4 bounds key order (from the charge profile). */
const BOUNDS_KEY_ORDER = ['profile', 'path', 'amount_max', 'amount_daily_max', 'amount_monthly_max', 'transaction_count_daily_max'];
/** v0.4 context key order. */
const CONTEXT_KEY_ORDER = ['currency', 'action_type'];

const BOUNDS = {
  profile: PROFILE_ID,
  path: EXEC_PATH,
  amount_max: 100,
  amount_daily_max: 500,
  amount_monthly_max: 5000,
  transaction_count_daily_max: 20,
};

const CONTEXT = {
  currency: 'USD',
  action_type: 'charge',
};

const LIMITS = {
  [PROFILE_ID]: {
    [EXEC_PATH]: {
      charge: {
        perTransaction: { amount_max: 50 },
        daily: { amount_max: 150, transaction_count_max: 5 },
      },
    },
  },
};

// ── Clients ───────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════

beforeAll(async () => {
  // 1. Build gateway
  pm.buildGateway();

  // 2. Start SP
  await pm.startSP(SP_PORT);

  // 3. Register test users on SP
  const alice = await sp.register('Alice E2E', `alice-e2e-${Date.now()}@test.local`);
  ctx.adminUser = { ...alice.user, apiKey: alice.apiKey };

  const bob = await sp.register('Bob E2E', `bob-e2e-${Date.now()}@test.local`);
  ctx.agentUser = { ...bob.user, apiKey: bob.apiKey };

  console.error(`[E2E] Registered Alice (${ctx.adminUser.id}) and Bob (${ctx.agentUser.id})`);

  // 4. Start gateway with Bob's API key (agent identity)
  await pm.startGateway({
    port: GW_PORT,
    spUrl: SP_URL,
    spApiKey: ctx.agentUser.apiKey,
    profilesDir: PROFILES_DIR,
  });
}, 120_000);

afterAll(async () => {
  if (ctx.mcpClient) {
    try { await ctx.mcpClient.close(); } catch { /* ignore */ }
  }
  await pm.killAll();
}, 30_000);

// ══════════════════════════════════════════════════════════
// Block 1: SP Setup
// ══════════════════════════════════════════════════════════

describe('SP Setup', () => {
  it('creates a group', async () => {
    const result = await sp.createGroup(ctx.adminUser!.apiKey, 'E2E Test Group');
    ctx.groupId = result.group.id;
    ctx.inviteCode = result.inviteCode;
    expect(ctx.groupId).toBeTruthy();
    expect(ctx.inviteCode).toBeTruthy();
  });

  it('Bob joins the group', async () => {
    const result = await sp.joinGroup(ctx.agentUser!.apiKey, ctx.inviteCode!);
    expect(result.member).toBeTruthy();
  });

  it('Alice assigns finance domain to Bob', async () => {
    const result = await sp.setMemberDomains(
      ctx.adminUser!.apiKey,
      ctx.groupId!,
      ctx.agentUser!.id,
      ['finance'],
    );
    expect(result.member).toBeTruthy();
  });

  it('Alice configures path domains', async () => {
    const result = await sp.setPathDomains(ctx.adminUser!.apiKey, ctx.groupId!, {
      [PROFILE_ID]: {
        [EXEC_PATH]: ['finance'],
      },
    });
    expect(result).toBeTruthy();
  });

  it('Alice sets group limits', async () => {
    const result = await sp.setLimits(ctx.adminUser!.apiKey, ctx.groupId!, LIMITS);
    expect(result).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════
// Block 2: Attestation
// ══════════════════════════════════════════════════════════

describe('Attestation', () => {
  it('Bob submits v0.4 attestation for charge-routine', async () => {
    const gateContentHashes = hashGateContent(ctx.gateContent);
    const executionContextHash = hashExecutionContext({
      action_type: CONTEXT.action_type,
      amount: BOUNDS.amount_max,
      currency: CONTEXT.currency,
    });

    const boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
    const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

    const result = await sp.submitAttestation(ctx.agentUser!.apiKey, {
      profile_id: PROFILE_ID,
      group_id: ctx.groupId!,
      bounds: BOUNDS,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      domain: 'finance',
      did: ctx.agentUser!.did,
      path: EXEC_PATH,
      gate_content_hashes: gateContentHashes,
      execution_context_hash: executionContextHash,
    });

    ctx.frameHash = result.bounds_hash ?? result.frame_hash;
    expect(ctx.frameHash).toBeTruthy();
    expect(result.status).toMatch(/active|pending/);
    expect(result.blob).toBeTruthy();
    expect(result.bounds_hash).toBe(boundsHash);
  });
});

// ══════════════════════════════════════════════════════════
// Block 3: Gateway Configuration
// ══════════════════════════════════════════════════════════

describe('Gateway Configuration', () => {
  it('configures gateway with SP credentials', async () => {
    await gw.configure({
      sessionCookie: 'e2e-test',
      apiKey: ctx.agentUser!.apiKey,
    });
  });

  it('pushes gate content for the attestation', async () => {
    const boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
    const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);
    await gw.pushGateContent(
      { boundsHash, contextHash, context: CONTEXT },
      EXEC_PATH,
      ctx.gateContent,
    );
  });

  it('pushes Stripe service credentials', async () => {
    if (!STRIPE_TEST_KEY) {
      console.error('[E2E] STRIPE_TEST_KEY not set — skipping credential push');
      return;
    }
    await gw.pushServiceCredentials('stripe', { apiKey: STRIPE_TEST_KEY });
  });

  it('adds Stripe integration', async () => {
    if (!STRIPE_TEST_KEY) {
      console.error('[E2E] STRIPE_TEST_KEY not set — skipping integration add');
      return;
    }

    const result = await gw.addIntegration({
      id: 'stripe',
      name: 'Stripe',
      command: 'npx',
      args: ['-y', '@stripe/mcp@latest'],
      envKeys: { STRIPE_SECRET_KEY: 'stripe.apiKey' },
      profile: PROFILE_SHORT,
      enabled: true,
    });

    expect(result.ok).toBe(true);
    console.error(`[E2E] Stripe integration tools: ${result.tools.join(', ')}`);

    // Some tools should be discovered
    if (result.tools.length > 0) {
      expect(result.tools.some((t) => t.startsWith('stripe__'))).toBe(true);
    } else if (result.warning) {
      console.error(`[E2E] Integration warning: ${result.warning}`);
    }

    // Give the gateway time to register tools with active sessions
    await sleep(1_000);
  });
});

// ══════════════════════════════════════════════════════════
// Block 4: MCP Tool Calls — Stripe
// ══════════════════════════════════════════════════════════

describe.skipIf(!STRIPE_TEST_KEY)('MCP Tool Calls — Stripe', () => {
  it('connects MCP client via SSE', async () => {
    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    const client = new Client(
      { name: 'hap-e2e', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    ctx.mcpClient = client;

    const { tools } = await client.listTools();
    console.error(`[E2E] MCP tools: ${tools.map((t) => t.name).join(', ')}`);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('ungated tool (list_invoices) works', async () => {
    const result = await ctx.mcpClient!.callTool({
      name: 'stripe__list_invoices',
      arguments: {},
    });
    // Should not be an error — Stripe returns an invoice list (possibly empty)
    expect(result.isError).not.toBe(true);
  });

  it('creates a product for price tests (direct Stripe API)', async () => {
    // create_product via MCP is default-gated (action_type: "read") which doesn't match
    // our frame's action_type: "charge". Create directly via Stripe REST API instead.
    const res = await fetch('https://api.stripe.com/v1/products', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_TEST_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'name=E2E+Test+Product',
    });
    expect(res.ok).toBe(true);
    const product = await res.json() as { id: string };
    (ctx as any).productId = product.id;
    console.error(`[E2E] Created product: ${product.id}`);
  });

  it('gated tool within limits succeeds ($20, under $50 per-tx)', async () => {
    // create_price: executionMapping maps unit_amount → amount (/100), currency → currency
    // staticExecution: action_type = "charge"
    // $20 is under the $50 per-tx limit
    const result = await ctx.mcpClient!.callTool({
      name: 'stripe__create_price',
      arguments: {
        product: (ctx as any).productId,
        unit_amount: 2000,
        currency: 'USD',
      },
    });

    if (result.isError) {
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      console.error(`[E2E] create_price error: ${text}`);
    }
    expect(result.isError).not.toBe(true);
  });

  it('verifies receipt was recorded in SP', async () => {
    const { receipts } = await sp.getGroupReceipts(ctx.adminUser!.apiKey, ctx.groupId!);
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    const latest = receipts[receipts.length - 1];
    expect(latest.action).toBe('charge');
    expect(latest.profileId).toBe(PROFILE_ID);
  });

  it('per-tx limit exceeded ($60 > $50 per-tx)', async () => {
    const result = await ctx.mcpClient!.callTool({
      name: 'stripe__create_price',
      arguments: {
        product: (ctx as any).productId,
        unit_amount: 6000,
        currency: 'USD',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    // Blocked by either local gatekeeper (amount > frame max) or SP (amount > per-tx limit)
    expect(text).toMatch(/Blocked by SP|Gatekeeper|LIMIT/i);
  });

  it('daily transaction count exceeded after multiple calls', async () => {
    // We already have 1 successful tx from above.
    // Limits: daily transaction_count_max = 5, so we need 4 more successes, then the 6th should fail.
    const successfulCalls: number[] = [];

    for (let i = 0; i < 4; i++) {
      const result = await ctx.mcpClient!.callTool({
        name: 'stripe__create_price',
        arguments: {
          product: (ctx as any).productId,
          unit_amount: 1000, // $10 each, well within per-tx ($50) and daily amount ($150)
          currency: 'USD',
        },
      });
      if (!result.isError) {
        successfulCalls.push(i + 2);
      } else {
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
        console.error(`[E2E] Tx #${i + 2} failed unexpectedly: ${text}`);
        // Might hit daily amount limit before count limit
        break;
      }
    }

    console.error(`[E2E] Successful transactions so far: ${successfulCalls.length + 1}`);

    // Now the 6th call should be blocked by either count or amount limit
    const result = await ctx.mcpClient!.callTool({
      name: 'stripe__create_price',
      arguments: {
        product: (ctx as any).productId,
        unit_amount: 1000,
        currency: 'USD',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    // Blocked by either local gatekeeper or SP limit
    expect(text).toMatch(/Blocked by SP|Gatekeeper|LIMIT/i);
  });
});

// ══════════════════════════════════════════════════════════
// Block 5: Revocation
// ══════════════════════════════════════════════════════════

describe.skipIf(!STRIPE_TEST_KEY)('Revocation', () => {
  it('Alice revokes the attestation', async () => {
    const result = await sp.revokeAttestation(
      ctx.adminUser!.apiKey,
      ctx.frameHash!,
      'E2E test revocation',
    );
    expect(result.revocation).toBeTruthy();
  });

  it('tool call blocked after revocation', async () => {
    const result = await ctx.mcpClient!.callTool({
      name: 'stripe__create_price',
      arguments: {
        product: (ctx as any).productId,
        unit_amount: 500,
        currency: 'USD',
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    // After revocation, blocked by SP (REVOKED) or gatekeeper
    expect(text).toMatch(/Blocked by SP|REVOKED|Gatekeeper/i);
  });
});
