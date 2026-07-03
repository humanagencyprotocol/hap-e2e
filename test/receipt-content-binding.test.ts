/**
 * Content binding — Level 2 (HAP v0.5 Content Provenance) — happy-path E2E.
 *
 * Proves the full real-stack loop with NO external credentials (the records MCP
 * is local SQLite, spawned over stdio):
 *
 *   1. A gated `create_record` through the gateway, under a profile that declares
 *      content_binding {kind:"jcs"}, makes the gateway hash the record payload
 *      and send the hash to the AS — which signs `contentHash` + `contentBinding`
 *      into the receipt (the AS never sees the content).
 *   2. The store records the authorizing `receipt_id` on the row (Content
 *      Provenance §4.1) — read back via get_record.
 *   3. The public receipt (GET /api/as/public-receipt/:id) exposes contentHash +
 *      contentBinding and verifies (signatureValid:true).
 *   4. An independent verifier recomputes sha256(JCS(payload)) and it MATCHES the
 *      signed hash; editing one field no longer matches (tamper-evident).
 *
 * Runs the LOCAL records MCP build (dist/index.js) so the not-yet-published
 * receipt_id store contract is exercised. The AS + gateway are built from local
 * source by the harness, so the route + Gatekeeper changes are real too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

// ── Constants ─────────────────────────────────────────────

const SP_PORT = 17120;
const GW_PORT = 17052;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/records@0.4';
const PROFILE_SHORT = 'records';
const EXEC_PATH = PROFILE_ID;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const RECORDS_DIST = join(ROOT, 'hap-records-mcp', 'dist', 'index.js');

// records boundsSchema keyOrder (see hap-profiles/records/0.4.profile.json).
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];
const BOUNDS = {
  profile: PROFILE_ID,
  read_access: 'unlimited',
  write_daily_max: 10,
  delete_access: 'none',
  archive_access: 'none',
};

// records has no contextSchema → empty context, hashes the sha256 of "".
const CONTEXT: Record<string, string> = {};
const CONTEXT_KEY_ORDER: string[] = [];

const GATE_CONTENT = {
  intent: 'E2E: content-binding test — store structured records with Level-2 content proof.',
};

// The exact payload the agent writes. The gateway hashes THIS (pre-footer,
// pre-receipt_id), so a verifier reproduces the hash from the same bytes.
const RECORD_ARGS = {
  type: 'note',
  title: 'Q3 Strategy',
  content: 'Ship Level 2 content binding for records and customers.',
};

// ── Minimal RFC 8785 JCS (mirrors @humanagencyp/hap-core canonicalize) ──────
// Inlined so the verifier hashes exactly as the gateway/hap-core does, without
// adding a hap-core dependency to the e2e suite.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + canonicalize(obj[key]));
  }
  return '{' + parts.join(',') + '}';
}
function contentHashOf(payload: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex')}`;
}

// ── Clients ───────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; name: string; email: string; did: string; apiKey: string };
let personalGroupId: string;
let boundsHash: string;
let contextHash: string;
let authorizationId: string;
let mcpClient: Client;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getPublicReceipt(id: string) {
  const res = await fetch(`${SP_URL}/api/as/public-receipt/${id}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ══════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════

beforeAll(async () => {
  // Build the LOCAL records MCP so dist/index.js carries the receipt_id contract.
  console.error('[CB E2E] Building local records MCP...');
  execSync('npm run build', { cwd: join(ROOT, 'hap-records-mcp'), stdio: 'pipe', timeout: 120_000 });

  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const result = await sp.register('Content Binding Test', `cb-e2e-${Date.now()}@test.local`);
  user = { ...result.user, apiKey: result.apiKey };
  personalGroupId = await sp.getPersonalGroupId(user.apiKey);

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: user.apiKey, profilesDir: PROFILES_DIR });
}, 240_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

// ══════════════════════════════════════════════════════════
// Setup: authorize + wire the local records MCP
// ══════════════════════════════════════════════════════════

describe('Setup', () => {
  it('submits an automatic-mode records attestation', async () => {
    const gateContentHashes = hashGateContent(GATE_CONTENT);
    const executionContextHash = hashExecutionContext({ write_count_daily: BOUNDS.write_daily_max });
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
    authorizationId = result.authorization_id;
    expect(authorizationId).toBeTruthy();
    expect(result.status).toMatch(/active|pending/);
  });

  it('configures the gateway and pushes gate content', async () => {
    await gw.configure({ sessionCookie: 'cb-e2e-test', apiKey: user.apiKey });
    await gw.pushGateContent({ authorizationId, boundsHash, contextHash, context: CONTEXT }, EXEC_PATH, GATE_CONTENT);
  });

  it('adds the LOCAL records integration', async () => {
    const result = await gw.addIntegration({
      id: 'records',
      name: 'Records',
      command: 'node',
      args: [RECORDS_DIST],
      envKeys: {},
      profile: PROFILE_SHORT,
      enabled: true,
      toolGating: {
        default: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        overrides: {
          create_record: { executionMapping: {}, staticExecution: { action_type: 'write' } },
          update_record: { executionMapping: {}, staticExecution: { action_type: 'write' } },
          delete_record: { executionMapping: {}, staticExecution: { action_type: 'delete' } },
          archive_record: { executionMapping: {}, staticExecution: { action_type: 'archive' } },
          get_record: { category: 'read' },
          list_records: { category: 'read' },
          search_records: { category: 'read' },
          export_records: { category: 'read' },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.tools.some((t) => t.startsWith('records__'))).toBe(true);
    await sleep(1_000);
  });

  it('connects the MCP client', async () => {
    await sleep(3_000);
    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    const client = new Client({ name: 'hap-cb-e2e', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    mcpClient = client;
    const { tools } = await client.listTools();
    expect(tools.filter((t) => t.name.startsWith('records__')).length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════
// The Level-2 loop
// ══════════════════════════════════════════════════════════

describe('Content binding — end to end', () => {
  let recordId: string;
  let receiptId: string;

  it('create_record succeeds and the row carries the authorizing receipt_id', async () => {
    const result = await mcpClient.callTool({ name: 'records__create_record', arguments: RECORD_ARGS });
    if (result.isError) {
      console.error('[CB E2E] create_record error:', (result.content as Array<{ text?: string }>)[0]?.text);
    }
    expect(result.isError).not.toBe(true);

    const record = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    recordId = record.id;
    receiptId = record.receipt_id;
    expect(recordId).toBeTruthy();
    // Store contract §4.1: the write recorded which receipt authorized it.
    expect(receiptId).toBeTruthy();
    expect(receiptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('get_record reads back the persisted receipt_id', async () => {
    const result = await mcpClient.callTool({ name: 'records__get_record', arguments: { id: recordId } });
    expect(result.isError).not.toBe(true);
    const record = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(record.receipt_id).toBe(receiptId);
  });

  it('the signed public receipt carries a matching contentHash + contentBinding', async () => {
    const { status, body } = await getPublicReceipt(receiptId);
    expect(status).toBe(200);
    expect(body.signatureValid).toBe(true);
    expect(body.contentBinding).toEqual({ version: '1', kind: 'jcs' });
    // The hash the AS signed equals an independent recompute over the written payload.
    expect(body.contentHash).toBe(contentHashOf(RECORD_ARGS));
  });

  it('an edited payload no longer matches the signed hash (tamper-evident)', async () => {
    const { body } = await getPublicReceipt(receiptId);
    expect(contentHashOf({ ...RECORD_ARGS, title: 'Q4 Strategy' })).not.toBe(body.contentHash);
  });

  // Real-stack coverage for the receipts history paging fix: the windowed
  // /api/receipts/mine returns recent receipts (not the old today-only default)
  // and a `nextBefore` cursor that "Load older" walks to the floor.
  it('the receipt is returned by the windowed /api/receipts/mine, with a cursor', async () => {
    const page = await sp.getMyReceiptsPage(user.apiKey, { limit: 200 });
    expect(page.receipts.some(r => r.id === receiptId)).toBe(true);
    expect(typeof page.nextBefore).toBe('string'); // "Load older" cursor present
  });

  it('the "Load older" cursor walk terminates at the history floor', async () => {
    let cursor: string | null = (await sp.getMyReceiptsPage(user.apiKey, { limit: 50 })).nextBefore;
    let steps = 0;
    while (cursor && steps++ < 40) {
      cursor = (await sp.getMyReceiptsPage(user.apiKey, { before: cursor, limit: 50 })).nextBefore;
    }
    expect(cursor).toBeNull();
  });
});
