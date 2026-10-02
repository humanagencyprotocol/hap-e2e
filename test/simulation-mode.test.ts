/**
 * Gateway simulation mode: on the pilot laptop every real system is blocked.
 *
 * A mandate is bound to a profile, not to a connector — so with a real and a
 * simulated connector of the same profile on one gateway, a mandate meant for the
 * test also authorizes the real system. Simulation mode closes that gap locally
 * (the Authority Server never learns a test is running): only connectors that
 * declare a simulation mode start, forced into it; everything else stays off.
 *
 * Also pinned here: `load_simulation` is hidden from an agent whose mandates
 * cannot authorize it (setup_daily_max 0) and appears once a setup mandate
 * exists — the working AI never sees that test data exists.
 *
 * Runs the published connectors the gateway installs itself, the shipped
 * manifests and the live profiles. Credential-free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 17560;
const GW_PORT = 17592;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const SALES = 'github.com/humanagencyprotocol/hap-profiles/sales@0.2';
const SALES_KEYS = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max', 'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'];
const SALES_WORK = { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10, setup_daily_max: 0 };
const SALES_SETUP = { read_access: 'none', value_max: 0, discount_max: 0, order_value_daily_max: 0, quote_daily_max: 0, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 1 };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'simulation-package.example.json'), 'utf8'));

let apiKey: string;
let did: string;
let groupId: string;
let mcpClient: Client;
const prevSim = process.env.SUVEREN_SIMULATION;

async function grantSales(bounds: Record<string, unknown>) {
  const full = { profile: SALES, ...bounds };
  const boundsHash = computeBoundsHash(full, SALES_KEYS);
  const ctx = { currency: 'EUR' };
  const contextHash = computeContextHash(ctx, ['currency']);
  const gate = { intent: 'E2E simulation mode' };
  const att = await sp.submitAttestation(apiKey, {
    profile_id: SALES, group_id: groupId, bounds: full, bounds_hash: boundsHash, context_hash: contextHash,
    domain: 'owner', did, commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ b: Object.keys(bounds).length }),
  });
  await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: ctx }, SALES, gate);
}

async function reconnect() {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 2_000));
  mcpClient = new Client({ name: 'sim-mode-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}

const toolNames = async () => (await mcpClient.listTools()).tools.map((t) => t.name);

describe('gateway simulation mode (real AS + gateway + published simulators)', () => {
  beforeAll(async () => {
    process.env.SUVEREN_SIMULATION = '1'; // inherited by the spawned gateway, like the CLI's saved setting
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('Sim Mode Test', `sim-mode-${Date.now()}@test.local`);
    apiKey = reg.apiKey; did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);
    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'sim-mode-e2e', apiKey });
    await gw.waitForIntegration('erp');
    await gw.waitForIntegration('crm');
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
    if (prevSim === undefined) delete process.env.SUVEREN_SIMULATION; else process.env.SUVEREN_SIMULATION = prevSim;
  }, 30_000);

  it('the simulated connectors start', async () => {
    const list = await gw.integrations();
    expect(list.find((i) => i.id === 'erp')?.running).toBe(true);
    expect(list.find((i) => i.id === 'crm')?.running).toBe(true);
  });

  it('a real connector (no simulation mode) is blocked, with the reason shown', async () => {
    // records-mcp is a personal default without a simulation marker.
    let rec: { running?: boolean; error?: string } | undefined;
    for (let i = 0; i < 60 && !rec?.error; i++) {
      rec = (await gw.integrations()).find((x) => x.id === 'records');
      if (!rec?.error) await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(rec?.running).toBeFalsy();
    expect(rec?.error).toMatch(/simulation mode/i);
  });

  it("the working agent sees the ERP's work tools but not load_simulation, and no tools of a blocked system", async () => {
    await grantSales(SALES_WORK);
    await reconnect();
    const names = await toolNames();
    expect(names).toContain('erp__create_quote');
    expect(names).not.toContain('erp__load_simulation');
    expect(names.some((n) => n.startsWith('records__'))).toBe(false);
  });

  it('a setup mandate makes load_simulation appear — and it loads into the simulated ERP', async () => {
    await grantSales(SALES_SETUP);
    await reconnect();
    expect(await toolNames()).toContain('erp__load_simulation');
    const r = await mcpClient.callTool({ name: 'erp__load_simulation', arguments: { package: pkg } });
    const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? '';
    if (r.isError) console.error('[SIM MODE E2E] load denied:', text.slice(0, 300));
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text).package_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
