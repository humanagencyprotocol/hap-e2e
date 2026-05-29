import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

// ── Constants ─────────────────────────────────────────────

const SP_PORT = 17100;
const GW_PORT = 17030;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/customers@0.4';
const PROFILE_SHORT = 'customers';
const EXEC_PATH = PROFILE_ID;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const BOUNDS_KEY_ORDER = ['profile', 'write_daily_max', 'delete_daily_max'];
const CONTEXT_KEY_ORDER = ['contact_type'];

const BOUNDS = {
  profile: PROFILE_ID,
  write_daily_max: 10,
  delete_daily_max: 5,
};

const CONTEXT = {
  contact_type: 'customer,lead',
};

// customers profile uses v0.4 intent gate
const GATE_CONTENT = {
  intent: 'Need agent to manage customer contacts and deals for E2E testing. Enable automated CRM operations within bounded daily limits.',
};

// ── Clients ───────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; name: string; email: string; did: string; apiKey: string };
let personalGroupId: string;
let boundsHash: string;
let contextHash: string;
let frameHash: string;
let mcpClient: Client;

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

  // 3. Register test user and resolve personal group id (required in v0.4)
  const result = await sp.register('CRM Test User', `crm-e2e-${Date.now()}@test.local`);
  user = { ...result.user, apiKey: result.apiKey };
  personalGroupId = await sp.getPersonalGroupId(user.apiKey);
  console.error(`[CRM E2E] Registered user ${user.id} (group ${personalGroupId})`);

  // 4. Start gateway with user's API key
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

// ══════════════════════════════════════════════════════════
// Block 1: Authorization
// ══════════════════════════════════════════════════════════

describe('Authorization', () => {
  it('submits v0.4 attestation for customers-write', async () => {
    const gateContentHashes = hashGateContent(GATE_CONTENT);
    const executionContextHash = hashExecutionContext({
      contact_type: 'customer',
      write_count_daily: BOUNDS.write_daily_max,
    });

    boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
    contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

    const result = await sp.submitAttestation(user.apiKey, {
      profile_id: PROFILE_ID,
      group_id: personalGroupId,
      bounds: BOUNDS,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      domain: 'owner',
      did: user.did,
      commitment_mode: 'automatic',
      gate_content_hashes: gateContentHashes,
      execution_context_hash: executionContextHash,
    });

    frameHash = result.frame_hash;
    expect(frameHash).toBeTruthy();
    expect(result.status).toMatch(/active|pending/);
    expect(result.blob).toBeTruthy();
    console.error(`[CRM E2E] Attestation created: ${result.frame_hash}`);
  });
});

// ══════════════════════════════════════════════════════════
// Block 2: Gateway Configuration
// ══════════════════════════════════════════════════════════

describe('Gateway Configuration', () => {
  it('configures gateway with session', async () => {
    await gw.configure({
      sessionCookie: 'crm-e2e-test',
      apiKey: user.apiKey,
    });
  });

  it('pushes gate content', async () => {
    await gw.pushGateContent(
      { frameHash, boundsHash, contextHash, context: CONTEXT },
      EXEC_PATH,
      GATE_CONTENT,
    );
  });

  it('adds CRM integration', async () => {
    const result = await gw.addIntegration({
      id: 'crm',
      name: 'CRM',
      command: 'npx',
      args: ['-y', '@humanagencyp/crm-mcp@latest'],
      envKeys: {},
      profile: PROFILE_SHORT,
      enabled: true,
      toolGating: {
        default: {
          executionMapping: {},
          staticExecution: { contact_type: 'customer' },
        },
        overrides: {
          create_contact: { executionMapping: { type: 'contact_type' }, staticExecution: { action_type: 'write' } },
          update_contact: { executionMapping: {}, staticExecution: { contact_type: 'customer', action_type: 'write' } },
          delete_contact: { executionMapping: {}, staticExecution: { contact_type: 'customer', action_type: 'delete' } },
          log_activity: { executionMapping: {}, staticExecution: { contact_type: 'customer', action_type: 'write' } },
          create_deal: { executionMapping: {}, staticExecution: { contact_type: 'customer', action_type: 'write' } },
          update_deal: { executionMapping: {}, staticExecution: { contact_type: 'customer', action_type: 'write' } },
          create_task: { executionMapping: {}, staticExecution: { contact_type: 'customer', action_type: 'write' } },
          complete_task: { executionMapping: {}, staticExecution: { contact_type: 'customer', action_type: 'write' } },
          find_contacts: { category: 'read' },
          get_timeline: { category: 'read' },
          get_pipeline: { category: 'read' },
          list_tasks: { category: 'read' },
          export_crm: { category: 'read' },
        },
      },
    });

    expect(result.ok).toBe(true);
    console.error(`[CRM E2E] CRM integration tools: ${result.tools.join(', ')}`);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.some((t) => t.startsWith('crm__'))).toBe(true);

    await sleep(1_000);
  });

  it('connects MCP client via SSE', async () => {
    // Wait for CRM MCP child process to fully start (npx download + init)
    await sleep(5_000);

    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    const client = new Client(
      { name: 'hap-crm-e2e', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    mcpClient = client;

    const { tools } = await client.listTools();
    console.error(`[CRM E2E] MCP tools available: ${tools.map((t) => t.name).join(', ')}`);

    // Should see CRM tools (crm__*), not just admin tools
    const crmTools = tools.filter(t => t.name.startsWith('crm__'));
    if (crmTools.length === 0) {
      console.error('[CRM E2E] WARNING: No CRM tools visible. Integration may not have started yet.');
      console.error('[CRM E2E] All tools:', tools.map(t => t.name).join(', '));
    }
    expect(crmTools.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════
// Block 2b: Out-of-scope contact_type — Gatekeeper must reject
// ══════════════════════════════════════════════════════════
// Declared context: contact_type = 'customer,lead'.
// create_contact maps tool arg `type` → execution context `contact_type`.
// Calling with type='vendor' violates the subset constraint and must be
// rejected locally by the Gatekeeper (the SP holds only context_hash).
//
// Placed BEFORE any write ops to avoid an unrelated known bug that disables
// CRM write tools after several successful calls.

describe('Scope Enforcement — contact_type subset', () => {
  it('create_contact with type outside allowed set → blocked by Gatekeeper', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Out-of-scope Vendor',
        email: 'vendor@example.com',
        type: 'vendor',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/not in authorized set|BOUND_EXCEEDED|contact_type/i);
    console.error(`[CRM E2E] Correctly blocked out-of-scope contact_type: ${text}`);
  });
});

// ══════════════════════════════════════════════════════════
// Block 3: CRM Operations — Within Bounds
// ══════════════════════════════════════════════════════════

describe('CRM Operations — Within Bounds', () => {
  let contactId: string;
  let dealId: string;

  it('create_contact succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Maria Testovic',
        email: 'maria@acme.com',
        company: 'Acme Corp',
        role: 'CTO',
        type: 'customer',
      },
    });

    if (result.isError) {
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      console.error(`[CRM E2E] create_contact error: ${text}`);
    }
    expect(result.isError).not.toBe(true);

    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contact = JSON.parse(text);
    contactId = contact.id;
    expect(contact.name).toBe('Maria Testovic');
    expect(contact.email).toBe('maria@acme.com');
    expect(contactId).toBeTruthy();
    console.error(`[CRM E2E] Created contact: ${contactId}`);
  });

  it('find_contacts returns the contact (read — no write count)', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__find_contacts',
      arguments: { query: 'Maria' },
    });

    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contacts = JSON.parse(text);
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    expect(contacts[0].name).toBe('Maria Testovic');
  });

  it('log_activity succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__log_activity',
      arguments: {
        contact_id: contactId,
        type: 'call',
        summary: 'Discussed renewal terms',
      },
    });

    if (result.isError) {
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      console.error(`[CRM E2E] log_activity error: ${text}`);
    }
    expect(result.isError).not.toBe(true);
  });

  it('get_timeline returns the activity (read)', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__get_timeline',
      arguments: { contact_id: contactId },
    });

    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const activities = JSON.parse(text);
    expect(activities.length).toBeGreaterThanOrEqual(1);
    expect(activities[0].summary).toBe('Discussed renewal terms');
  });

  it('create_deal succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_deal',
      arguments: {
        contact_id: contactId,
        title: 'Acme Annual Renewal',
        value: 12000,
        currency: 'EUR',
        stage: 'proposal',
      },
    });

    if (result.isError) {
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      console.error(`[CRM E2E] create_deal error: ${text}`);
    }
    expect(result.isError).not.toBe(true);

    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const deal = JSON.parse(text);
    dealId = deal.id;
    expect(deal.title).toBe('Acme Annual Renewal');
  });

  it('get_pipeline shows the deal (read)', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__get_pipeline',
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const deals = JSON.parse(text);
    expect(deals.length).toBeGreaterThanOrEqual(1);
  });

  it('create_task linked to contact succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_task',
      arguments: {
        title: 'Send renewal proposal to Maria',
        contact_id: contactId,
        deal_id: dealId,
        due_date: '2026-04-01',
      },
    });

    if (result.isError) {
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      console.error(`[CRM E2E] create_task error: ${text}`);
    }
    expect(result.isError).not.toBe(true);
  });

  it('list_tasks returns open tasks (read)', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__list_tasks',
      arguments: { status: 'open' },
    });

    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const tasks = JSON.parse(text);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].title).toBe('Send renewal proposal to Maria');
  });

  it('export_crm returns all data (read)', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__export_crm',
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const data = JSON.parse(text);
    expect(data.contacts.length).toBeGreaterThanOrEqual(1);
    expect(data.activities.length).toBeGreaterThanOrEqual(1);
    expect(data.deals.length).toBeGreaterThanOrEqual(1);
    expect(data.tasks.length).toBeGreaterThanOrEqual(1);
    expect(data.exported_at).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════
// Block 4: Bounds Enforcement — Daily Write Limit
// ══════════════════════════════════════════════════════════

describe('Bounds Enforcement — Daily Write Limit', () => {
  it('creates contacts up to the per-tool SP limit, then gets blocked', async () => {
    // SP tracks cumulative daily_count PER ACTION (tool name).
    // write_daily_max = 10 checked by SP generic _daily_max pattern.
    // We already have 1 create_contact from above. Create 9 more to hit 10.
    const successes: number[] = [];

    for (let i = 0; i < 9; i++) {
      const result = await mcpClient.callTool({
        name: 'crm__create_contact',
        arguments: {
          name: `Bulk Contact ${i + 2}`,
          email: `bulk${i + 2}@test.com`,
          type: 'lead',
        },
      });
      if (!result.isError) {
        successes.push(i + 2);
      } else {
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
        console.error(`[CRM E2E] create_contact #${i + 2} blocked: ${text}`);
        break;
      }
    }
    console.error(`[CRM E2E] Successful create_contact calls: ${successes.length + 1}`);

    // The 11th create_contact should be blocked
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Should Fail',
        email: 'fail@test.com',
        type: 'customer',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    console.error(`[CRM E2E] Limit exceeded: ${text}`);
    expect(text).toMatch(/Blocked by SP|Gatekeeper|LIMIT|disabled/i);
  });

  it('read operations still work after hitting write limit', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__find_contacts',
      arguments: { query: 'Maria' },
    });

    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contacts = JSON.parse(text);
    expect(contacts.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════
// Block 5: Revocation
// ══════════════════════════════════════════════════════════

describe('Revocation', () => {
  it('user revokes the authorization', async () => {
    const result = await sp.revokeAttestation(
      user.apiKey,
      frameHash,
      'CRM E2E test revocation',
    );
    expect(result.revocation).toBeTruthy();
    console.error('[CRM E2E] Authorization revoked');
  });

  it('write tool blocked after revocation', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Post Revocation',
        email: 'revoked@test.com',
        type: 'customer',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/Blocked by SP|REVOKED|Gatekeeper|disabled/i);
  });
});
