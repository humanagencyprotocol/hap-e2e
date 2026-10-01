/**
 * The three-week test's evidence chain, on the real stack:
 * request handed over → ticket (Authority Server) → effect in the simulated ERP.
 *
 * The ERP connector runs in simulation mode behind the real gateway, governed by
 * the shipped sales@0.1 profile and the shipped erp.json tool gating — exactly
 * what a pilot runs, and what goes live later with only the connector's mode
 * changed. The test proves the three records can be joined without anything
 * extra reaching the Authority Server:
 *
 * - every ticket for an ERP change has exactly one trace in the ERP's export —
 *   a recorded change, or a recorded refusal (the action never happened
 *   although a ticket exists);
 * - every receipt_id in the ERP's export is a ticket the AS issued;
 * - a call the gateway refuses leaves no ticket and no ERP trace.
 *
 * The connector is the one the gateway installs itself from npm on start (the
 * shipped manifest marks it a personal default) — the artefact a customer gets,
 * not a local build. Credential-free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 17360;
const GW_PORT = 17392;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const MANIFEST = join(ROOT, 'suveren-gateway', 'content', 'integrations', 'erp.json');
const available = existsSync(MANIFEST);

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/sales@0.1';
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max',
  'quote_daily_max', 'send_daily_max', 'order_daily_max'];
const CONTEXT = { currency: 'EUR' };
const GATE_CONTENT = { intent: 'E2E: quotes for scenario requests, within 1,000 EUR and 10% discount.' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-erp-'));
const SCENARIO = join(work, 'scenario.json');

let apiKey: string;
let mcpClient: Client;

/**
 * The ERP's own operator command, run from the package the gateway installed and
 * against the database the gateway-spawned connector uses (HAP_DATA_DIR = the
 * gateway's data dir — the contract the gateway passes to its sub-MCPs).
 */
function erpCli(...args: string[]): string {
  const dataDir = pm.getDataDir();
  const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, HAP_DATA_DIR: dataDir };
  delete env.DATABASE_URL;
  return execFileSync('node', [bin, ...args], { env, encoding: 'utf8' });
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

describe.skipIf(!available)('ERP simulation: request → ticket → effect (real AS + gateway + erp-mcp)', () => {
  beforeAll(async () => {
    writeFileSync(SCENARIO, JSON.stringify({ requests: [
      { id: 'r1', request: 'Meridian asks for 1 × Cable 5m and 1 × Widget 100.', expected: { customer_id: 'cust-4', value: 37 } },
    ] }));

    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('ERP Sim Test', `erp-sim-${Date.now()}@test.local`);
    apiKey = reg.apiKey;
    const groupId = await sp.getPersonalGroupId(apiKey);

    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'erp-sim-e2e', apiKey });

    // The shipped manifest registers the published connector as a personal default;
    // the gateway installs it from npm and starts it in its default (simulation) mode.
    await gw.waitForIntegration('erp');

    const bounds = {
      profile: PROFILE_ID, read_access: 'unlimited', value_max: 1000, discount_max: 10,
      order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10,
    };
    const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
    const contextHash = computeContextHash(CONTEXT, ['currency']);
    const att = await sp.submitAttestation(apiKey, {
      profile_id: PROFILE_ID, group_id: groupId, bounds, bounds_hash: boundsHash, context_hash: contextHash,
      domain: 'owner', did: reg.user.did, commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent(GATE_CONTENT),
      execution_context_hash: hashExecutionContext({ quote_count_daily: bounds.quote_daily_max }),
    });
    await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: CONTEXT }, PROFILE_ID, GATE_CONTENT);

    await new Promise((r) => setTimeout(r, 2_000));
    mcpClient = new Client({ name: 'erp-sim-agent', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
    rmSync(work, { recursive: true, force: true });
  }, 30_000);

  let quoteId: string;

  it('the request is handed over and its time recorded', () => {
    expect(erpCli('scenario', 'next', SCENARIO)).toMatch(/\[r1\] handed over/);
  });

  it('a quote within bounds runs and carries its ticket', async () => {
    const r = await call('erp__create_quote', {
      customer_id: 'cust-4', lines: [{ item_id: 'item-7', qty: 1 }, { item_id: 'item-1', qty: 1 }],
      discount_pct: 0, value: 37, currency: 'EUR',
    });
    if (r.denied) console.error('[ERP SIM E2E] quote denied:', r.text.slice(0, 300));
    expect(r.denied).toBe(false);
    expect(r.json.receipt_id).toEqual(expect.any(String));
    quoteId = r.json.id;
  });

  it('the gateway refuses a quote over value_max — no ticket, no ERP trace', async () => {
    const r = await call('erp__create_quote', {
      customer_id: 'cust-4', lines: [{ item_id: 'item-8', qty: 4 }], discount_pct: 0, value: 1360, currency: 'EUR',
    });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/value_max/);
  });

  it('a false declared value passes the gateway, gets a ticket, and the ERP refuses it', async () => {
    const r = await call('erp__create_quote', {
      customer_id: 'cust-4', lines: [{ item_id: 'item-2', qty: 1 }], discount_pct: 0, value: 20, currency: 'EUR',
    });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/declared 20, expected 45/);
  });

  it('send and convert run', async () => {
    expect((await call('erp__send_quote', { id: quoteId, value: 37, discount_pct: 0, currency: 'EUR' })).denied).toBe(false);
    const o = await call('erp__convert_quote_to_order', { id: quoteId, value: 37, discount_pct: 0, currency: 'EUR' });
    expect(o.denied).toBe(false);
    expect(o.json.receipt_id).toEqual(expect.any(String));
  });

  it('tickets and the ERP export match one to one', async () => {
    const record = JSON.parse(erpCli('export'));
    expect(record.mode).toBe('simulation');
    expect(record.triggers.map((t: any) => t.scenario_id)).toEqual(['r1']);

    // ERP traces: one change per performed call, one refusal per call refused after its ticket.
    expect(record.changes.map((c: any) => c.tool)).toEqual(['create_quote', 'send_quote', 'convert_quote_to_order']);
    expect(record.refusals).toHaveLength(1);
    expect(record.refusals[0].message).toMatch(/declared 20, expected 45/);
    const erpReceiptIds = [...record.changes, ...record.refusals].map((x: any) => x.receipt_id);
    expect(erpReceiptIds.every(Boolean)).toBe(true);
    expect(new Set(erpReceiptIds).size).toBe(erpReceiptIds.length);

    // Tickets the AS issued: create, false-value create, send, convert = 4.
    // The over-limit attempt was refused by the gateway and has none.
    const { receipts } = await sp.getMyReceiptsPage(apiKey, { limit: 50 });
    const ticketIds = receipts.map((t) => String(t.id)).sort();

    // One to one: every ticket has exactly one ERP trace, every trace is a ticket.
    expect([...erpReceiptIds].sort()).toEqual(ticketIds);
  });
});
