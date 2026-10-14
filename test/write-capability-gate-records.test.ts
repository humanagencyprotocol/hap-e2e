/**
 * Write-side capability gate — Gateway E2E (gateway PR #116, fix/gmail-read-
 * access, write-side gap found while tracing G1-G3).
 *
 * THE GAP: records.json's delete_record/archive_record declare `boundField`/
 * `requiredValue` (delete_access/archive_access), but this field was read
 * ONLY inside tool-proxy.ts's `category:"read"` branch — a WRITE override
 * declaring it was silently dropped at resolution (integration-manager.ts)
 * and never enforced anywhere. hap-core's Gatekeeper deliberately skips enum
 * bounds by design, and the Authority Server's receipt route does too — so
 * tool-proxy.ts was the ONLY place that could enforce this, and didn't, on
 * the write path. A mandate with delete_access:"none" did not block
 * records__delete_record.
 *
 * TARGET: the write path checks the capability gate PER CANDIDATE
 * authorization, BEFORE the Gatekeeper and BEFORE any ticket is requested —
 * same mechanism the read branch already had (`boundsSatisfyReadGate`), just
 * wired into the write branch's candidate loop too. A denial here must
 * produce NO receipt at the Authority Server: the gate fails closed before
 * any ticket is ever asked for.
 *
 * Uses the records manifest exactly as shipped (records is `personalDefault`,
 * so the gateway auto-installs it from content/integrations/records.json —
 * no inline toolGating copy is passed by this test at all).
 *
 * Real @humanagencyp/records-mcp (local SQLite) — no credentials.
 *
 * Run: npx vitest run test/write-capability-gate-records.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeScopeHash,
} from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const TOOL_PROXY_SRC = join(ROOT, 'suveren-gateway', 'apps', 'mcp-server', 'src', 'lib', 'tool-proxy.ts');

// Feature gate: PR #116 moves the capability-gate check (toolBoundField) out
// of the read-only branch into the shared candidate loop used by both read
// AND write tools. Detected generically from the gateway's own source.
function gatewayHasFix(): boolean {
  if (!existsSync(TOOL_PROXY_SRC)) return false;
  try {
    const src = readFileSync(TOOL_PROXY_SRC, 'utf8');
    return src.includes('toolBoundField') && src.includes('Capability gate');
  } catch {
    return false;
  }
}
const available = gatewayHasFix();

const PROFILE_ID = PROFILE_V07.records;
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Stack {
  pm: ProcessManager;
  sp: SPClient;
  apiKey: string;
  client: Client;
}

async function boot(spPort: number, gwPort: number, deleteAccess: 'allowed' | 'none'): Promise<Stack> {
  const pm = new ProcessManager();
  const spUrl = `http://localhost:${spPort}`;
  const gwUrl = `http://localhost:${gwPort}`;
  const sp = new SPClient(spUrl);
  const gw = new GatewayClient(gwUrl);

  pm.buildGateway();
  await pm.startSP(spPort);

  const user = await sp.register('WriteCapGate E2E', `write-capgate-${spPort}-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({ port: gwPort, spUrl, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: `write-capgate-${spPort}`, apiKey });

  const bounds = {
    profile: PROFILE_ID,
    read_access: 'unlimited',
    write_daily_max: 10,
    delete_access: deleteAccess,
    archive_access: 'allowed',
  };
  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeScopeHash({}, []);
  const gateContent = { intent: `records delete_access=${deleteAccess}` };

  const att = await sp.submitMandate(apiKey, {
    profile_id: PROFILE_ID,
    profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR),
    group_id: groupId,
    bounds,
    bounds_hash: boundsHash,
    scope_hash: contextHash,
    domain: 'owner',
    did: user.user.did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gateContent),
    execution_context_hash: hashExecutionContext({ profile: PROFILE_ID, domain: 'owner' }),
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
    PROFILE_ID,
    gateContent,
  );

  await gw.waitForIntegration('records');
  await sleep(500);

  const client = new Client({ name: 'hap-writecapgate-e2e', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${gwUrl}/sse`)));
  return { pm, sp, apiKey, client };
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { text, isError: result.isError === true };
}

// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!available)('Write-capability gate — records delete_access:none is blocked BEFORE any ticket', () => {
  let stack: Stack;
  let spUrl: string;
  beforeAll(async () => {
    stack = await boot(19140, 19141, 'none');
    spUrl = `http://localhost:19140`;
  }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  async function receipts(): Promise<number> {
    const res = await fetch(`${spUrl}/api/tickets/mine`, { headers: { 'X-API-Key': stack.apiKey } });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { tickets: unknown[] };
    return body.tickets.length;
  }

  it('records__delete_record is refused — delete_access:none, not the connector', async () => {
    const before = await receipts();
    expect(before).toBe(0);

    const { text, isError } = await callText(stack.client, 'records__delete_record', { id: 'does-not-exist' });
    expect(isError).toBe(true);
    expect(text).toContain('delete_access');
    expect(text.toLowerCase()).toContain('does not grant it');
    // It must be the CAPABILITY GATE refusing this, not the connector trying
    // and failing to find the (nonexistent) id — proves the call never
    // reached records-mcp at all.
    expect(text).not.toContain('Record not found');

    // No ticket was ever requested: the Authority Server shows zero tickets
    // for this user, before and after.
    const after = await receipts();
    expect(after).toBe(before);
  });

  it('records__archive_record (archive_access:allowed on this mandate) still works — the gate is per-switch, not all-or-nothing', async () => {
    const created = await callText(stack.client, 'records__create_record', { type: 'note', title: 'Archivable' });
    expect(created.isError).toBe(false);
    const { id } = JSON.parse(created.text);

    const { isError } = await callText(stack.client, 'records__archive_record', { id });
    expect(isError).toBe(false);
  });
});

describe.skipIf(!available)('Write-capability gate — records delete_access:allowed permits the delete', () => {
  let stack: Stack;
  let spUrl: string;
  beforeAll(async () => {
    stack = await boot(19150, 19151, 'allowed');
    spUrl = `http://localhost:19150`;
  }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  async function receipts(): Promise<number> {
    const res = await fetch(`${spUrl}/api/tickets/mine`, { headers: { 'X-API-Key': stack.apiKey } });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { tickets: unknown[] };
    return body.tickets.length;
  }

  it('records__delete_record succeeds and actually deletes the record', async () => {
    const created = await callText(stack.client, 'records__create_record', { type: 'note', title: 'ToDelete' });
    expect(created.isError).toBe(false);
    const { id } = JSON.parse(created.text);

    const before = await receipts();

    const del = await callText(stack.client, 'records__delete_record', { id });
    expect(del.isError).toBe(false);
    expect(del.text).toContain('deleted');

    // Unlike the blocked case, a ticket WAS requested and issued.
    const after = await receipts();
    expect(after).toBeGreaterThan(before);

    const get = await callText(stack.client, 'records__get_record', { id });
    expect(get.isError).toBe(true);
    expect(get.text).toContain('Record not found');
  });
});
