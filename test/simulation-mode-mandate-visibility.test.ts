/**
 * Simulation mode must not leak the existence of a mandate for a profile
 * whose only connector is paused (Andreas, 2026-10-02): the working agent
 * must not be able to tell simulation from live.
 *
 * `SUVEREN_SIMULATION=1` is the gateway-wide switch (simulation-mode.ts):
 * only connectors whose manifest declares a `simulation` field are started;
 * every other connector is refused at start (integration-manager.ts). Two
 * of the shipped `personalDefault` manifests land on either side of that
 * line without any extra setup:
 *
 *  - `erp` (profile `sales`) declares `simulation` — it starts, and its
 *    tools are registered.
 *  - `records` (profile `records`) does NOT declare `simulation` — the
 *    gateway refuses to start it, so no tool for its profile is ever
 *    registered.
 *
 * A mandate is bound to a PROFILE, not a connector, so a complete `records`
 * mandate exists at the Authority Server regardless of whether its connector
 * ever starts. This suite proves the AGENT'S OWN surface hides it:
 * list-authorizations (compact overview, domain detail, the "Active
 * domains:" not-found hint) and the MCP session instructions (the mandate
 * brief) must all read exactly as if the `records` mandate did not exist,
 * while the `sales` mandate (backed by the running `erp` simulator) is
 * shown normally.
 *
 * Real Authority Server + real gateway + the real erp-mcp package the
 * gateway installs itself — no mocks. Credential-free (`records` and `erp`
 * are both personal defaults; `records` never even reaches its npm install
 * step under simulation mode — see integration-manager.ts).
 *
 * Run:  npx vitest run test/simulation-mode-mandate-visibility.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 17860;
const GW_PORT = 17892;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const GATEWAY_DIR = join(ROOT, 'suveren-gateway');
const MANIFEST = join(GATEWAY_DIR, 'content', 'integrations', 'erp.json');
const available = existsSync(MANIFEST);

// Running simulator — erp personal default, profile `sales`.
const SALES_ID = 'github.com/humanagencyprotocol/hap-profiles/sales@0.1';
const SALES_KEY_ORDER = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max'];
const SALES_CONTEXT = { currency: 'EUR' };
const SALES_BOUNDS = {
  profile: SALES_ID, read_access: 'unlimited', value_max: 1000, discount_max: 10,
  order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10,
};

// Paused real connector — records personal default has no `simulation`
// manifest marker, so it never starts under SUVEREN_SIMULATION=1.
const RECORDS_ID = 'github.com/humanagencyprotocol/hap-profiles/records@0.4';
const RECORDS_KEY_ORDER = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];
const RECORDS_BOUNDS = {
  profile: RECORDS_ID, read_access: 'unlimited', write_daily_max: 5, delete_access: 'none', archive_access: 'none',
};

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let apiKey: string;
let did: string;
let groupId: string;
let mcpClient: Client;

async function grant(profileId: string, keyOrder: string[], bounds: Record<string, unknown>, context: Record<string, unknown>): Promise<string> {
  const boundsHash = computeBoundsHash(bounds, keyOrder);
  const contextHash = computeContextHash(context, Object.keys(context));
  const gate = { intent: `E2E simulation-visibility mandate for ${profileId}` };
  const att = await sp.submitAttestation(apiKey, {
    profile_id: profileId, group_id: groupId, bounds, bounds_hash: boundsHash, context_hash: contextHash,
    domain: 'owner', did, commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ profile_id: profileId }),
  });
  await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context }, profileId, gate);
  return att.authorization_id;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text };
}

describe.skipIf(!available)('simulation mode hides a paused-connector mandate from the agent (real AS + gateway)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('Sim Visibility Test', `sim-visibility-${Date.now()}@test.local`);
    apiKey = reg.apiKey;
    did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);

    // Same env startGateway() would build, plus SUVEREN_SIMULATION=1 — that
    // helper has no knob for it, so this suite assembles its own via the
    // generic startManaged (see process-manager.ts).
    const dataDir = pm.getDataDir();
    await pm.startManaged('gateway', 'node', ['apps/mcp-server/dist/http.mjs'], {
      cwd: GATEWAY_DIR,
      env: {
        ...process.env,
        SUVEREN_MCP_PORT: String(GW_PORT),
        SUVEREN_AS_URL: SP_URL,
        SUVEREN_AS_API_KEY: apiKey,
        SUVEREN_PROFILES_DIR: PROFILES_DIR,
        SUVEREN_MANIFESTS_DIR: join(GATEWAY_DIR, 'content', 'integrations'),
        SUVEREN_INTEGRATIONS_DIR: join(dataDir, 'integrations'),
        SUVEREN_DATA_DIR: dataDir,
        SUVEREN_SIMULATION: '1',
      },
      healthUrl: `${GW_URL}/health`,
      timeoutMs: 30_000,
    });
    await gw.configure({ sessionCookie: 'sim-visibility-e2e', apiKey });

    // erp (sales) is a personal default and declares `simulation` — it starts.
    await gw.waitForIntegration('erp');

    // records is also a personal default but declares no `simulation` marker
    // — confirm the gateway actually refused to start it under this switch,
    // so the rest of this suite is proving something real.
    const recordsStatus = (await gw.integrations()).find((i) => i.id === 'records') as
      { id: string; running?: boolean; paused?: string } | undefined;
    expect(recordsStatus?.running).toBe(false);
    expect(recordsStatus?.paused).toBe('simulation');

    await grant(RECORDS_ID, RECORDS_KEY_ORDER, RECORDS_BOUNDS, {});
    await grant(SALES_ID, SALES_KEY_ORDER, SALES_BOUNDS, SALES_CONTEXT);

    await new Promise((r) => setTimeout(r, 1_000));
    mcpClient = new Client({ name: 'sim-visibility-agent', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
  }, 30_000);

  it('list-authorizations compact overview shows sales, omits records', async () => {
    const r = await callTool('list-authorizations', {});
    expect(r.denied).toBe(false);
    expect(r.text).toContain('sales@0.1');
    expect(r.text).not.toContain('records@0.4');
  });

  it('list-authorizations(domain: "records") reads exactly like no mandate exists at all', async () => {
    const hidden = await callTool('list-authorizations', { domain: 'records' });
    const neverExisted = await callTool('list-authorizations', { domain: 'totally-unknown-domain-xyz' });

    expect(hidden.text).toContain('No authorizations found for domain "records"');
    // Nothing about the actual hidden mandate may leak: no bounds, no
    // profile id, no intent.
    expect(hidden.text).not.toContain('records@0.4');
    expect(hidden.text).not.toContain('write_daily_max');
    // The "Active domains:" hint must list only what is actually reachable.
    expect(hidden.text).toContain('Active domains: sales');
    expect(neverExisted.text).toContain('Active domains: sales');
  });

  it('list-authorizations(domain: "sales") still shows full detail', async () => {
    const r = await callTool('list-authorizations', { domain: 'sales' });
    expect(r.denied).toBe(false);
    expect(r.text).toContain('sales@0.1');
    expect(r.text).toContain('Bounds:');
  });

  it('the MCP session instructions (mandate brief) omit the records mandate', () => {
    const instructions = mcpClient.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('sales@0.1');
    expect(instructions).not.toContain('records@0.4');
  });
});
