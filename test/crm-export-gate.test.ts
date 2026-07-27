/**
 * Bulk export is a separate decision from reading.
 *
 * Until customers@0.6, one checkbox (`read_access`) authorised both "look up a
 * contact" and "export the entire customer database". Those are not the same
 * risk — and in an AI-delegation product bulk extraction is the one that
 * matters, because the whole CRM ends up in a model's context.
 *
 * customers@0.6 splits `export_access` out, defaulting to `none`, and crm.json
 * points `export_crm` at it. This proves the split on the real stack: same
 * grant, full read access, export refused.
 *
 * Credential-free — the CRM MCP is local SQLite over stdio and the Authority
 * Server runs on in-memory storage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 17160;
const GW_PORT = 17092;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/customers@0.6';
const EXEC_PATH = PROFILE_ID;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

// customers@0.6 boundsSchema keyOrder — export_access sits after read_access.
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max'];
const CONTEXT_KEY_ORDER = ['contact_type'];
const CONTEXT = { contact_type: 'customer,lead' };

const GATE_CONTENT = {
  intent: 'E2E: prove bulk export is gated separately from ordinary CRM reads.',
};

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; did: string; apiKey: string };
let personalGroupId: string;
let mcpClient: Client;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Issue an authorization for customers@0.6 with the given access flags. */
async function authorize(readAccess: string, exportAccess: string) {
  const bounds = {
    profile: PROFILE_ID,
    read_access: readAccess,
    export_access: exportAccess,
    write_daily_max: 5,
    delete_daily_max: 1,
  };
  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

  const result = await sp.submitAttestation(user.apiKey, {
    profile_id: PROFILE_ID,
    group_id: personalGroupId,
    bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'owner',
    did: user.did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(GATE_CONTENT),
    execution_context_hash: hashExecutionContext({ write_count_daily: bounds.write_daily_max }),
  });

  await gw.pushGateContent(
    { authorizationId: result.authorization_id, boundsHash, contextHash, context: CONTEXT },
    EXEC_PATH,
    GATE_CONTENT,
  );
  return result.authorization_id;
}

async function call(tool: string, args: Record<string, unknown> = {}) {
  const result = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (result.content as Array<{ text?: string }> | undefined)
    ?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: result.isError === true, text };
}

async function reconnect() {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await sleep(2_000);
  const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
  mcpClient = new Client({ name: 'export-gate-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const result = await sp.register('Export Gate Test', `export-e2e-${Date.now()}@test.local`);
  user = { ...result.user, apiKey: result.apiKey };
  personalGroupId = await sp.getPersonalGroupId(user.apiKey);

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: user.apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: 'export-e2e-test', apiKey: user.apiKey });

  // Real crm-mcp, auto-registered as a personal default. Poll for readiness —
  // a cold npm install runs ~12s, well past any fixed sleep.
  await gw.waitForIntegration('crm');
}, 300_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

describe('Bulk export is gated separately from reading', () => {
  it('full read access does NOT confer export', async () => {
    await authorize('unlimited', 'none');
    await reconnect();

    const read = await call('crm__find_contacts', {});
    if (read.denied) console.error('[EXPORT E2E] unexpected read denial:', read.text.slice(0, 200));
    expect(read.denied).toBe(false);

    const exported = await call('crm__export_crm', {});
    console.error('[EXPORT E2E] export denial:', exported.text.slice(0, 200));
    expect(exported.denied).toBe(true);
  });

  it('granting export_access enables it, without changing read access', async () => {
    // Proves the new bound is a real switch, not merely an extra way to deny.
    await authorize('unlimited', 'allowed');
    await reconnect();

    const exported = await call('crm__export_crm', {});
    if (exported.denied) console.error('[EXPORT E2E] export still denied:', exported.text.slice(0, 200));
    expect(exported.denied).toBe(false);

    const read = await call('crm__find_contacts', {});
    expect(read.denied).toBe(false);
  });
});
