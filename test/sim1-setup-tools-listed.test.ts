/**
 * SIM1 — simulation setup tools (load_simulation/clear_simulation) always
 * listed in simulation mode, on the real stack: real Authority Server, the
 * gateway (gateway-wide `SUVEREN_SIMULATION=1`), the published erp-mcp
 * connector.
 *
 * The bug this fixes: `load_simulation`/`clear_simulation` were hidden
 * (manifest `hideUnlessAuthorized`) until a setup mandate existed. Approving
 * one mid-session sends MCP `tools/list_changed`, but AI clients (Claude
 * Code, ChatGPT) often refresh the tool list only on reconnect — so the AI
 * could not see the tool it was just allowed to use. In simulation mode the
 * gateway now lists these tools unconditionally (like every connector tool
 * since 0.25, "tools always listed"); a call without a setup mandate is
 * refused with a clear reason instead of running.
 *
 * This suite:
 *   - lists tools ONCE, before any setup mandate exists — load_simulation
 *     and clear_simulation are already there;
 *   - calls load_simulation without a mandate — refused, nothing loaded;
 *   - grants a setup mandate (sales, setup_daily_max: 1);
 *   - lists tools AGAIN, over the SAME connection (no reconnect) — IDENTICAL
 *     to the first list;
 *   - calls load_simulation again, from the original list — now succeeds.
 *
 * Gated on the erp manifest actually declaring `simulationOnly` for
 * load_simulation (the SIM1 marker) — skips cleanly against a gateway
 * checkout that predates this feature, rather than failing on an assertion
 * that was never meant to hold there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient, registerGatewaySecret } from '../src/helpers/gateway-client.js';
import { newSecret, startControlPlane, startMcpServer, type StackOptions } from '../src/helpers/gateway-stack.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';

const SP_PORT = 18870;
const GW_PORT = 18871;
const CP_PORT = 18872;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = process.env.HAP_E2E_PROFILES_DIR ?? join(ROOT, 'hap-profiles');
const GATEWAY_DIR = join(ROOT, 'suveren-gateway');
const ERP_MANIFEST = join(GATEWAY_DIR, 'content', 'integrations', 'erp.json');

/** SIM1 feature-detect: skip cleanly against a gateway checkout that predates it. */
function erpDeclaresSimulationOnlySetupTools(): boolean {
  if (!existsSync(ERP_MANIFEST)) return false;
  try {
    const manifest = JSON.parse(readFileSync(ERP_MANIFEST, 'utf8'));
    return manifest?.toolGating?.overrides?.load_simulation?.simulationOnly === true;
  } catch {
    return false;
  }
}
const available = erpDeclaresSimulationOnlySetupTools();

const SALES_ID = PROFILE_V07.sales;
const SALES_KEY_ORDER = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'];
const SALES_SETUP_BOUNDS = {
  profile: SALES_ID, read_access: 'none', value_max: 0, discount_max: 0,
  order_value_daily_max: 0, quote_daily_max: 0, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 1,
};
const SALES_CONTEXT = { currency: 'EUR' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let apiKey: string;
let did: string;
let groupId: string;
let mcpClient: Client;

/** Same shape as ProcessManager.startGateway, plus the gateway-wide SUVEREN_SIMULATION
 *  switch that helper has no knob for (see simulation-mode-mandate-visibility.test.ts,
 *  which hits the same gap with its own inline startManaged calls). Signs in via
 *  gw.configure directly (no control-plane HTTP login needed for this suite). */
async function startSimulationGateway(): Promise<void> {
  const dataDir = pm.getDataDir();
  const secret = newSecret();
  registerGatewaySecret(GW_PORT, secret);
  const stack: StackOptions = {
    dataDir,
    ports: { cp: CP_PORT, mcp: GW_PORT },
    secret,
    asUrl: SP_URL,
    extraEnv: {
      SUVEREN_PROFILES_DIR: PROFILES_DIR,
      SUVEREN_AS_API_KEY: apiKey,
      SUVEREN_SIMULATION: '1',
    },
  };
  await startControlPlane(pm, stack, 'gateway-cp');
  await startMcpServer(pm, stack, 'gateway');
  await gw.configure({ sessionCookie: 'sim1-e2e', apiKey });
}

async function grantSetupMandate(): Promise<void> {
  const boundsHash = computeBoundsHash(SALES_SETUP_BOUNDS, SALES_KEY_ORDER);
  const contextHash = computeScopeHash(SALES_CONTEXT, Object.keys(SALES_CONTEXT));
  const gate = { intent: 'E2E SIM1 setup mandate — load test data into the simulated ERP.' };
  const att = await sp.submitMandate(apiKey, {
    profile_id: SALES_ID, profile_hash: profileHashFor(SALES_ID, PROFILES_DIR), group_id: groupId,
    bounds: SALES_SETUP_BOUNDS, bounds_hash: boundsHash, scope_hash: contextHash,
    domain: 'owner', did, commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ profile_id: SALES_ID }),
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: SALES_CONTEXT },
    SALES_ID,
    gate,
  );
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text };
}

describe.skipIf(!available)('SIM1 — simulation setup tools always listed (real AS + gateway + erp-mcp)', () => {
  let firstList: string[];
  // Schema-valid (the MCP SDK validates `package` before the gateway's own
  // gate ever runs) — its content is irrelevant to the refusal test, which
  // must be blocked before any of it is read.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'simulation-package.example.json'), 'utf8'));

  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('SIM1 E2E', `sim1-e2e-${Date.now()}@test.local`);
    apiKey = reg.apiKey;
    did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);

    await startSimulationGateway();
    await gw.waitForIntegration('erp');

    mcpClient = new Client({ name: 'sim1-e2e-agent', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
  }, 30_000);

  it('load_simulation and clear_simulation are listed BEFORE any setup mandate exists', async () => {
    firstList = (await mcpClient.listTools()).tools.map((t) => t.name);
    expect(firstList).toContain('erp__load_simulation');
    expect(firstList).toContain('erp__clear_simulation');
  });

  it('calling it without a setup mandate is refused with the reason — nothing runs', async () => {
    const r = await call('erp__load_simulation', { package: pkg });
    expect(r.denied).toBe(true);
    expect(r.text).toBe(
      'Refused: no mandate covers erp__load_simulation (setup). Nothing was done. ' +
        'Ask the person to grant a setup mandate in the gateway, then try again. No ticket was requested.',
    );
  });

  it('after a setup mandate is granted, listing AGAIN (same connection) gives an IDENTICAL list', async () => {
    await grantSetupMandate();
    // No reconnect — proves the gateway's own `tools/list` answer did not
    // change, not merely that the client's cached copy still happens to work.
    const secondList = (await mcpClient.listTools()).tools.map((t) => t.name);
    expect([...secondList].sort()).toEqual([...firstList].sort());
  });

  it('the call now succeeds, from the connection that saw the tool before the mandate existed', async () => {
    let r = { denied: true, text: '' };
    for (let i = 0; i < 10 && r.denied; i++) {
      r = await call('erp__load_simulation', { package: pkg });
      if (r.denied && /no mandate covers/.test(r.text)) await new Promise((res) => setTimeout(res, 1_000));
      else break;
    }
    expect(r.denied, r.text).toBe(false);
  }, 30_000);
});
