/**
 * Read-gate enforcement — Gateway E2E (Finding A, doc §1 F1).
 *
 * THE GAP: the read path used to only check "does a matching authorization
 * exist?" and then proxy verbatim — so a read tool's DECLARED gate was never
 * enforced. records' `list_records` requires `read_access: unlimited`, yet a
 * grant with `read_access: none` could still read; `export_records` is declared
 * `disabled` yet was reachable. This is the same class of hole as the email
 * read-bounds bypass, provable WITHOUT credentials on the local records server.
 *
 * TARGET (doc §1–§3): the gated read path enforces the declared gate —
 *   - a read is permitted only if some matching authorization satisfies the
 *     gate (`read_access == unlimited`); otherwise blocked, fail-closed;
 *   - a `disabled` tool is always blocked.
 *
 * Generic: the gateway reads `boundField`/`requiredValue`/`disabled` from the
 * manifest — no records-specific code (see read-gate.ts).
 *
 * Real @humanagencyp/records-mcp (local SQLite) — no credentials, no external
 * side effects. Two isolated stacks so the block/allow grants don't mix.
 *
 * Run:  npx vitest run test/read-gate-records.test.ts
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

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/records@0.4';
const PROFILE_SHORT = 'records';
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];

// records read tools declare a static gate (read_access must be "unlimited");
// export_records is declared disabled.
const RECORDS_INTEGRATION = {
  id: 'records',
  name: 'Records',
  command: 'npx',
  args: ['-y', '@humanagencyp/records-mcp@latest'],
  envKeys: {},
  profile: PROFILE_SHORT,
  enabled: true,
  toolGating: {
    default: { executionMapping: {}, staticExecution: {} },
    overrides: {
      create_record: { executionMapping: {}, staticExecution: { action_type: 'write' } },
      list_records: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
      get_record: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
      search_records: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
      export_records: { category: 'disabled' },
    },
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Stack {
  pm: ProcessManager;
  client: Client;
}

/** Boot an isolated stack with a single records grant at the given read_access. */
async function boot(spPort: number, gwPort: number, readAccess: 'unlimited' | 'none'): Promise<Stack> {
  const pm = new ProcessManager();
  const spUrl = `http://localhost:${spPort}`;
  const gwUrl = `http://localhost:${gwPort}`;
  const sp = new SPClient(spUrl);
  const gw = new GatewayClient(gwUrl);

  pm.buildGateway();
  await pm.startSP(spPort);

  const user = await sp.register('ReadGate E2E', `readgate-${spPort}-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({ port: gwPort, spUrl, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: `readgate-${spPort}`, apiKey });

  const bounds = {
    profile: PROFILE_ID,
    read_access: readAccess,
    write_daily_max: 10,
    delete_access: 'allowed',
    archive_access: 'allowed',
  };
  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash({}, []);
  const gateContent = { intent: `records read_access=${readAccess}` };

  const att = await sp.submitAttestation(apiKey, {
    profile_id: PROFILE_ID,
    group_id: groupId,
    bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
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

  await sleep(500);
  const added = await gw.addIntegration(RECORDS_INTEGRATION);
  expect(added.ok).toBe(true);
  expect(added.tools.some((t: string) => t.startsWith('records__'))).toBe(true);
  await sleep(5_000);

  const client = new Client({ name: 'hap-readgate-e2e', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${gwUrl}/sse`)));
  return { pm, client };
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { text, isError: result.isError === true };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Read gate — read_access:none is blocked', () => {
  let stack: Stack;
  beforeAll(async () => { stack = await boot(17250, 17251, 'none'); }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('list_records is blocked when the grant lacks read_access:unlimited', async () => {
    const { text, isError } = await callText(stack.client, 'records__list_records', {});
    expect(isError).toBe(true);
    expect(text).toContain('Read blocked');
  });

  it('export_records (disabled in manifest) is always blocked', async () => {
    const { text, isError } = await callText(stack.client, 'records__export_records', {});
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain('disabled');
  });
});

describe('Read gate — read_access:unlimited is allowed', () => {
  let stack: Stack;
  beforeAll(async () => { stack = await boot(17260, 17261, 'unlimited'); }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('list_records is permitted when the grant has read_access:unlimited', async () => {
    const { text, isError } = await callText(stack.client, 'records__list_records', {});
    expect(text).not.toContain('Read blocked');
    expect(isError).toBe(false);
  });
});
