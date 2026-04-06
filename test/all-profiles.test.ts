/**
 * All-Profiles E2E Test — validates every HAP profile against the gateway
 * using mock MCP servers.
 *
 * For each profile:
 * 1. Attestation creation (SP)
 * 2. Gateway configuration (gate content, integration)
 * 3. Read tools work with authorization
 * 4. Write tools check bounds via execution context
 * 5. Receipts are created with correct data
 * 6. Cumulative limits enforce at the SP
 * 7. Revocation blocks all tool calls
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

// ── Constants ─────────────────────────────────────────────

const SP_PORT = 18100;
const GW_PORT = 18030;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const MOCK_MCP_PATH = join(import.meta.dirname, '..', 'src', 'helpers', 'mock-mcp.ts');
const TSX_BIN = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; name: string; email: string; did: string; apiKey: string };
let mcpClient: Client;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Profile definitions ───────────────────────────────────

interface ProfileTestConfig {
  profileId: string;
  profileShort: string;
  boundsKeyOrder: string[];
  contextKeyOrder: string[];
  bounds: Record<string, unknown>;
  context: Record<string, unknown>;
  /** Tools exposed by the mock MCP server */
  mockTools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  /** Tool gating config (from manifest pattern) */
  toolGating: Record<string, unknown>;
  /** A write tool to test gating */
  writeToolName: string;
  /** Arguments for the write tool call */
  writeToolArgs: Record<string, unknown>;
  /** A read tool to test read access */
  readToolName: string;
  /** The daily limit field name in bounds (for cumulative enforcement) */
  dailyLimitField: string;
  /** The daily limit value in bounds */
  dailyLimitValue: number;
  /** Gate style: 'intent' (v0.4) or 'legacy' (v0.3 problem/objective/tradeoffs) */
  gateStyle?: 'intent' | 'legacy';
}

const PROFILES: ProfileTestConfig[] = [
  {
    profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
    profileShort: 'charge',
    boundsKeyOrder: ['profile', 'amount_max', 'amount_daily_max', 'amount_monthly_max', 'transaction_count_daily_max'],
    contextKeyOrder: ['currency', 'action_type'],
    bounds: {
      profile: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
      amount_max: 100,
      amount_daily_max: 500,
      amount_monthly_max: 5000,
      transaction_count_daily_max: 3,
    },
    context: { currency: 'USD', action_type: 'charge' },
    mockTools: [
      { name: 'create_payment', description: 'Create a payment', inputSchema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' } } } },
      { name: 'list_payments', description: 'List payments', inputSchema: { type: 'object', properties: {} } },
    ],
    toolGating: {
      default: { executionMapping: {}, staticExecution: { action_type: 'charge', amount: 0, currency: 'USD' } },
      overrides: {
        create_payment: {
          executionMapping: { amount: 'amount', currency: 'currency' },
          staticExecution: { action_type: 'charge' },
        },
        list_payments: { category: 'read' },
      },
    },
    writeToolName: 'create_payment',
    writeToolArgs: { amount: 10, currency: 'USD' },
    readToolName: 'list_payments',
    dailyLimitField: 'transaction_count_daily_max',
    dailyLimitValue: 3,
    gateStyle: 'legacy', // charge profile uses v0.3 problem/objective/tradeoff gates
  },
  {
    profileId: 'github.com/humanagencyprotocol/hap-profiles/purchase@0.4',
    profileShort: 'purchase',
    boundsKeyOrder: ['profile', 'spend_max', 'spend_daily_max', 'spend_monthly_max', 'transaction_count_daily_max'],
    contextKeyOrder: ['currency', 'category', 'allowed_vendors'],
    bounds: {
      profile: 'github.com/humanagencyprotocol/hap-profiles/purchase@0.4',
      spend_max: 200,
      spend_daily_max: 500,
      spend_monthly_max: 5000,
      transaction_count_daily_max: 3,
    },
    context: { currency: 'EUR', category: 'subscription', allowed_vendors: 'AWS,Vercel' },
    mockTools: [
      { name: 'make_purchase', description: 'Make a purchase', inputSchema: { type: 'object', properties: { spend: { type: 'number' }, currency: { type: 'string' }, vendor: { type: 'string' } } } },
      { name: 'list_purchases', description: 'List purchases', inputSchema: { type: 'object', properties: {} } },
    ],
    toolGating: {
      default: { executionMapping: {}, staticExecution: { spend: 0, currency: 'EUR', category: 'subscription' } },
      overrides: {
        make_purchase: {
          executionMapping: { spend: 'spend', currency: 'currency', vendor: 'allowed_vendors' },
          staticExecution: { category: 'subscription' },
        },
        list_purchases: { category: 'read' },
      },
    },
    writeToolName: 'make_purchase',
    writeToolArgs: { spend: 10, currency: 'EUR', vendor: 'AWS' },
    readToolName: 'list_purchases',
    dailyLimitField: 'transaction_count_daily_max',
    dailyLimitValue: 3,
  },
  {
    profileId: 'github.com/humanagencyprotocol/hap-profiles/email@0.4',
    profileShort: 'email',
    boundsKeyOrder: ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max'],
    contextKeyOrder: ['allowed_recipients', 'allowed_domains'],
    bounds: {
      profile: 'github.com/humanagencyprotocol/hap-profiles/email@0.4',
      recipient_max: 5,
      send_daily_max: 3,
      read_max_age_days: 30,
      read_daily_max: 50,
    },
    context: { allowed_recipients: 'test@example.com,team@example.com', allowed_domains: 'example.com' },
    mockTools: [
      { name: 'send_message', description: 'Send email', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } } },
      { name: 'list_messages', description: 'List messages', inputSchema: { type: 'object', properties: {} } },
    ],
    toolGating: {
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
          staticExecution: {},
        },
        list_messages: { category: 'read' },
      },
    },
    writeToolName: 'send_message',
    writeToolArgs: { to: 'test@example.com', subject: 'Test' },
    readToolName: 'list_messages',
    dailyLimitField: 'send_daily_max',
    dailyLimitValue: 3,
  },
  {
    profileId: 'github.com/humanagencyprotocol/hap-profiles/schedule@0.4',
    profileShort: 'schedule',
    boundsKeyOrder: ['profile', 'booking_daily_max', 'booking_duration_max', 'lookahead_days_max'],
    contextKeyOrder: ['allowed_calendars', 'allowed_attendees', 'allowed_domains'],
    bounds: {
      profile: 'github.com/humanagencyprotocol/hap-profiles/schedule@0.4',
      booking_daily_max: 3,
      booking_duration_max: 60,
      lookahead_days_max: 14,
    },
    context: { allowed_calendars: 'Work,Personal', allowed_attendees: 'alice@example.com', allowed_domains: 'example.com' },
    mockTools: [
      { name: 'book_event', description: 'Book a calendar event', inputSchema: { type: 'object', properties: { duration: { type: 'number' }, attendee: { type: 'string' } } } },
      { name: 'list_events', description: 'List events', inputSchema: { type: 'object', properties: {} } },
    ],
    toolGating: {
      default: { executionMapping: {}, staticExecution: { duration: 30, lookahead: 1 } },
      overrides: {
        book_event: {
          executionMapping: { duration: 'duration' },
          staticExecution: { lookahead: 1, allowed_calendars: 'Work', allowed_attendees: 'alice@example.com', allowed_domains: 'example.com' },
        },
        list_events: { category: 'read' },
      },
    },
    writeToolName: 'book_event',
    writeToolArgs: { duration: 30, attendee: 'alice@example.com' },
    readToolName: 'list_events',
    dailyLimitField: 'booking_daily_max',
    dailyLimitValue: 3,
  },
  {
    profileId: 'github.com/humanagencyprotocol/hap-profiles/publish@0.4',
    profileShort: 'publish',
    boundsKeyOrder: ['profile', 'post_daily_max', 'post_monthly_max'],
    contextKeyOrder: ['allowed_platforms', 'content_type', 'audience'],
    bounds: {
      profile: 'github.com/humanagencyprotocol/hap-profiles/publish@0.4',
      post_daily_max: 3,
      post_monthly_max: 100,
    },
    context: { allowed_platforms: 'twitter,linkedin', content_type: 'text', audience: 'public' },
    mockTools: [
      { name: 'create_post', description: 'Create a post', inputSchema: { type: 'object', properties: { text: { type: 'string' }, platform: { type: 'string' } } } },
      { name: 'list_posts', description: 'List posts', inputSchema: { type: 'object', properties: {} } },
    ],
    toolGating: {
      default: { executionMapping: {}, staticExecution: { allowed_platforms: 'twitter', content_type: 'text', audience: 'public' } },
      overrides: {
        create_post: {
          executionMapping: { platform: 'allowed_platforms' },
          staticExecution: { content_type: 'text', audience: 'public' },
        },
        list_posts: { category: 'read' },
      },
    },
    writeToolName: 'create_post',
    writeToolArgs: { text: 'Hello world', platform: 'twitter' },
    readToolName: 'list_posts',
    dailyLimitField: 'post_daily_max',
    dailyLimitValue: 3,
  },
  {
    profileId: 'github.com/humanagencyprotocol/hap-profiles/records@0.4',
    profileShort: 'records',
    boundsKeyOrder: ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'],
    contextKeyOrder: [],
    bounds: {
      profile: 'github.com/humanagencyprotocol/hap-profiles/records@0.4',
      read_access: 'all',
      write_daily_max: 3,
      delete_access: 'own_24h',
      archive_access: 'all',
    },
    context: {},
    mockTools: [
      { name: 'create_record', description: 'Create a record', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
      { name: 'search_records', description: 'Search records', inputSchema: { type: 'object', properties: {} } },
    ],
    toolGating: {
      default: { executionMapping: {}, staticExecution: {} },
      overrides: {
        create_record: { executionMapping: {}, staticExecution: {} },
        search_records: { category: 'read' },
      },
    },
    writeToolName: 'create_record',
    writeToolArgs: { title: 'Test Record' },
    readToolName: 'search_records',
    dailyLimitField: 'write_daily_max',
    dailyLimitValue: 3,
  },
];

const GATE_CONTENT_LEGACY = {
  problem: 'E2E profile validation test.',
  objective: 'Verify all profiles work end-to-end through the gateway.',
  tradeoffs: 'Accepts test-level risk for validation purposes.',
};

const GATE_CONTENT_V4 = {
  intent: 'E2E profile validation: verify all profiles work end-to-end through the gateway.',
};

// ── Lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const result = await sp.register('Profile Test', `profile-e2e-${Date.now()}@test.local`);
  user = { ...result.user, apiKey: result.apiKey };
  console.error(`[ALL-PROFILES] Registered user ${user.id}`);

  await pm.startGateway({
    port: GW_PORT,
    spUrl: SP_URL,
    spApiKey: user.apiKey,
    profilesDir: PROFILES_DIR,
  });
}, 120_000);

afterAll(async () => {
  if (mcpClient) {
    try { await mcpClient.close(); } catch { /* ignore */ }
  }
  await pm.killAll();
}, 30_000);

// ── Test each profile ─────────────────────────────────────

for (const profile of PROFILES) {
  describe(`Profile: ${profile.profileShort}`, () => {
    let boundsHash: string;
    let contextHash: string;

    it('creates attestation', async () => {
      const gateContent = profile.gateStyle === 'legacy' ? GATE_CONTENT_LEGACY : GATE_CONTENT_V4;
      const gateContentHashes = hashGateContent(gateContent);
      const executionContextHash = hashExecutionContext({
        ...Object.fromEntries(
          Object.entries(profile.context).map(([k, v]) => [k, v]),
        ),
      });

      boundsHash = computeBoundsHash(
        profile.bounds as Record<string, unknown>,
        profile.boundsKeyOrder,
      );
      contextHash = computeContextHash(
        profile.context as Record<string, unknown>,
        profile.contextKeyOrder,
      );

      const result = await sp.submitAttestation(user.apiKey, {
        profile_id: profile.profileId,
        bounds: profile.bounds,
        bounds_hash: boundsHash,
        context_hash: contextHash,
        domain: 'owner',
        did: user.did,
        gate_content_hashes: gateContentHashes,
        execution_context_hash: executionContextHash,
      });

      expect(result.bounds_hash ?? result.frame_hash).toBeTruthy();
      expect(result.status).toMatch(/active|pending/);
    });

    it('configures gateway', async () => {
      await gw.configure({
        sessionCookie: `profile-test-${profile.profileShort}`,
        apiKey: user.apiKey,
      });

      const gateContent = profile.gateStyle === 'legacy' ? GATE_CONTENT_LEGACY : GATE_CONTENT_V4;
      await gw.pushGateContent(
        { boundsHash, contextHash, context: profile.context as Record<string, string | number> },
        profile.id,
        gateContent,
      );
    });

    it('adds mock integration', async () => {
      const integrationId = `mock-${profile.profileShort}`;

      // Remove previous integration if exists (from prior test run)
      try { await gw.removeIntegration(integrationId); } catch { /* ignore */ }

      const result = await gw.addIntegration({
        id: integrationId,
        name: `Mock ${profile.profileShort}`,
        command: TSX_BIN,
        args: [MOCK_MCP_PATH],
        envKeys: {},
        env: {
          MOCK_MCP_NAME: `mock-${profile.profileShort}`,
          MOCK_MCP_TOOLS: JSON.stringify(profile.mockTools),
        },
        profile: profile.profileShort,
        enabled: true,
        toolGating: profile.toolGating,
      });

      expect(result.ok).toBe(true);
      console.error(`[${profile.profileShort}] Integration tools: ${result.tools.join(', ')}`);

      await sleep(2_000);
    });

    it('connects MCP client and sees tools', async () => {
      // Close previous client
      if (mcpClient) {
        try { await mcpClient.close(); } catch { /* ignore */ }
      }

      const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
      const client = new Client(
        { name: 'hap-profile-e2e', version: '0.1.0' },
        { capabilities: {} },
      );
      await client.connect(transport);
      mcpClient = client;

      const { tools } = await client.listTools();
      const prefix = `mock-${profile.profileShort}__`;
      const profileTools = tools.filter(t => t.name.startsWith(prefix));
      console.error(`[${profile.profileShort}] Visible tools: ${profileTools.map(t => t.name).join(', ')}`);
      expect(profileTools.length).toBeGreaterThan(0);
    });

    it('read tool works with authorization', async () => {
      const toolName = `mock-${profile.profileShort}__${profile.readToolName}`;
      const result = await mcpClient.callTool({
        name: toolName,
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      const response = JSON.parse(text);
      expect(response.success).toBe(true);
    });

    it('write tool succeeds within bounds', async () => {
      const toolName = `mock-${profile.profileShort}__${profile.writeToolName}`;
      const result = await mcpClient.callTool({
        name: toolName,
        arguments: profile.writeToolArgs,
      });

      if (result.isError) {
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
        console.error(`[${profile.profileShort}] Write tool error: ${text}`);
      }
      expect(result.isError).not.toBe(true);
    });

    it('receipt is recorded at SP', async () => {
      // Post receipt directly to verify SP tracking
      const receiptResult = await sp.postReceipt(user.apiKey, {
        attestationHash: boundsHash,
        profileId: profile.profileId,
        action: profile.writeToolName,
        amount: typeof profile.writeToolArgs.amount === 'number' ? profile.writeToolArgs.amount
          : typeof profile.writeToolArgs.spend === 'number' ? profile.writeToolArgs.spend
          : 0,
        executionContext: profile.writeToolArgs,
      });

      // Receipt should succeed (we're within limits)
      expect(receiptResult.status).toBe(201);
      expect(receiptResult.body).toBeTruthy();
    });

    it(`cumulative limit enforces (${profile.dailyLimitField}=${profile.dailyLimitValue})`, async () => {
      const toolName = `mock-${profile.profileShort}__${profile.writeToolName}`;

      // The gateway already posted 1 receipt from the write test above.
      // We also posted 1 directly in the receipt test.
      // The daily limit counts receipts at the SP level.
      // Make calls until limit is hit.
      let blocked = false;

      for (let i = 0; i < profile.dailyLimitValue + 2; i++) {
        const result = await mcpClient.callTool({
          name: toolName,
          arguments: profile.writeToolArgs,
        });

        if (result.isError) {
          const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
          expect(text).toMatch(/Blocked by SP|LIMIT|disabled/i);
          blocked = true;
          console.error(`[${profile.profileShort}] Limit hit after ${i + 1} additional calls`);
          break;
        }
      }

      expect(blocked).toBe(true);
    });

    it('revocation blocks write tool', async () => {
      await sp.revokeAttestation(user.apiKey, boundsHash, 'E2E test revocation');

      const toolName = `mock-${profile.profileShort}__${profile.writeToolName}`;
      const result = await mcpClient.callTool({
        name: toolName,
        arguments: profile.writeToolArgs,
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(text).toMatch(/Blocked by SP|REVOKED|Gatekeeper|disabled/i);
    });
  });
}
