/**
 * Each cumulative limit counts only the action types it governs — enforced by
 * the Authority Server, and reported truthfully to the agent by the gateway.
 *
 * *Cumulative Tracking* rule 4: consumption is partitioned by action type. The
 * AS enforces it; the gateway enforces no cumulative limit locally (its log is
 * display-only) but reports usage from that log. The report summed every
 * execution under the profile: on sales@0.1 through a real gateway (found
 * 2026-09-30) one quote, one send and one order read as 3 / 3 / 3 and the daily
 * order value summed quotes and sends. The last test fails on that bug; the
 * others pin the AS-side partition on a profile with two count limits, so a
 * regression on either side is caught.
 *
 * Refusals are tested as hard as the permits: each limit must still stop its
 * own action type at exactly its own count.
 *
 * Credential-free — the CRM MCP is local SQLite over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';

const SP_PORT = 17260;
const GW_PORT = 17292;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/customers@0.7';
const EXEC_PATH = PROFILE_ID;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max'];
const CONTEXT_KEY_ORDER = ['contact_type'];
const CONTEXT = { contact_type: 'customer' };
const GATE_CONTENT = { intent: 'E2E: each cumulative limit counts only its own action type.' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; did: string; apiKey: string };
let personalGroupId: string;
let mcpClient: Client;
const contactIds: string[] = [];

async function call(tool: string, args: Record<string, unknown> = {}) {
  const result = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (result.content as Array<{ text?: string }> | undefined)
    ?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: result.isError === true, text };
}

async function createContact(name: string) {
  const r = await call('crm__create_contact', { name, type: 'customer' });
  if (!r.denied) {
    const id = (JSON.parse(r.text) as { id?: string }).id;
    if (id) contactIds.push(id);
  }
  return r;
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const result = await sp.register('Partition Test', `partition-e2e-${Date.now()}@test.local`);
  user = { ...result.user, apiKey: result.apiKey };
  personalGroupId = await sp.getPersonalGroupId(user.apiKey);

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: user.apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: 'partition-e2e-test', apiKey: user.apiKey });
  await gw.waitForIntegration('crm');

  // write_daily_max 3, delete_daily_max 1 — a delete limit smaller than the
  // number of writes that precede it, which is exactly what the combined total broke.
  const bounds = {
    profile: PROFILE_ID, read_access: 'unlimited', export_access: 'none',
    write_daily_max: 3, delete_daily_max: 1,
  };
  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeScopeHash(CONTEXT, CONTEXT_KEY_ORDER);
  const att = await sp.submitMandate(user.apiKey, {
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
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: CONTEXT },
    EXEC_PATH,
    GATE_CONTENT,
  );

  await new Promise((r) => setTimeout(r, 2_000));
  mcpClient = new Client({ name: 'partition-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}, 300_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

describe('cumulative limits are partitioned by action type (real AS + gateway + CRM)', () => {
  it('two writes pass', async () => {
    for (const name of ['P1', 'P2']) {
      const r = await createContact(name);
      if (r.denied) console.error('[PARTITION E2E] write denied:', r.text.slice(0, 300));
      expect(r.denied).toBe(false);
    }
  });

  it('a delete after two writes passes — writes do not use up delete_daily_max=1', async () => {
    const r = await call('crm__delete_contact', { id: contactIds[0] });
    if (r.denied) console.error('[PARTITION E2E] delete denied:', r.text.slice(0, 300));
    expect(r.denied).toBe(false);
  });

  it('the second delete is refused — delete_daily_max still stops deletes at 1', async () => {
    const r = await call('crm__delete_contact', { id: contactIds[1] });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/delete_daily_max|limit|exceed/i);
  });

  it('a third write passes — the delete does not use up write_daily_max=3', async () => {
    const r = await createContact('P3');
    if (r.denied) console.error('[PARTITION E2E] third write denied:', r.text.slice(0, 300));
    expect(r.denied).toBe(false);
  });

  it('the fourth write is refused — write_daily_max still stops writes at 3', async () => {
    const r = await createContact('P4');
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/write_daily_max|limit|exceed/i);
  });

  it('the agent is told the true usage per limit', async () => {
    const r = await call('list-authorizations', { domain: 'customers' });
    expect(r.denied).toBe(false);
    expect(r.text).toMatch(/Daily write limit:\s+3\s*\/\s*3/);
    expect(r.text).toMatch(/Daily delete limit:\s+1\s*\/\s*1/);
  });
});
