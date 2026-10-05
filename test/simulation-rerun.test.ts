/**
 * Re-running a simulation, on the real stack: clear, then load again.
 *
 * The same cases must be able to run again under a different setup (other
 * mandates, another agent brief), and other cases under the same setup. Each
 * simulator therefore has `clear_simulation` next to `load_simulation`: both are
 * ticketed `setup` actions, hidden from an agent without a setup mandate. What
 * must hold:
 *
 * - clear_simulation is invisible to the working agent and appears only with a
 *   setup mandate;
 * - after a clear, each simulator holds nothing but the record of the clear
 *   itself, and the same package loads again (same fingerprint);
 * - every trace left in the three simulators is a ticket the AS issued — the
 *   clear removes the earlier traces, by design, and nothing else does;
 * - the email requests are dated within the hour before the load, in case order.
 *
 * The connectors are the ones the gateway installs from the shipped manifests,
 * as in simulation-setup.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 17660;
const GW_PORT = 17692;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const INTEGRATIONS = join(ROOT, 'suveren-gateway', 'content', 'integrations');
const MAIL_MANIFEST = join(INTEGRATIONS, 'mail.json');
const available = existsSync(MAIL_MANIFEST);
const PKG = { erp: 'erp-mcp', crm: 'crm-mcp', mail: 'email-mcp' } as const;
const SYSTEMS = ['erp', 'crm', 'mail'] as const;

const P = 'github.com/humanagencyprotocol/hap-profiles';
const PROFILES = {
  sales: {
    id: `${P}/sales@0.2`,
    keyOrder: ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max', 'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'],
    ctxOrder: ['currency'], ctx: { currency: 'EUR' },
    setup: { read_access: 'none', value_max: 0, discount_max: 0, order_value_daily_max: 0, quote_daily_max: 0, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 5 },
    work: { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10, setup_daily_max: 0 },
  },
  customers: {
    id: `${P}/customers@0.8`,
    keyOrder: ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'],
    ctxOrder: ['contact_type'], ctx: { contact_type: 'customer' },
    setup: { read_access: 'none', export_access: 'none', write_daily_max: 0, delete_daily_max: 0, setup_daily_max: 5 },
    work: { read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
  },
  email: {
    id: `${P}/email@0.7`,
    keyOrder: ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max', 'setup_daily_max'],
    ctxOrder: ['allowed_recipients', 'allowed_domains'],
    ctx: { allowed_recipients: 'einkauf@huber.example,office@steiner.example', allowed_domains: 'huber.example,steiner.example' },
    setup: { read_access: 'none', recipient_max: 0, send_daily_max: 0, read_max_age_days: 0, read_daily_max: 0, setup_daily_max: 5 },
    work: { read_access: 'unlimited', recipient_max: 1, send_daily_max: 10, read_max_age_days: 3650, read_daily_max: 1000, setup_daily_max: 0 },
  },
} as const;
type ProfileKey = keyof typeof PROFILES;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let apiKey: string;
let did: string;
let groupId: string;
let mcpClient: Client;

async function grant(key: ProfileKey, kind: 'setup' | 'work'): Promise<string> {
  const p = PROFILES[key];
  const bounds = { profile: p.id, ...p[kind] };
  const boundsHash = computeBoundsHash(bounds, [...p.keyOrder]);
  const contextHash = computeContextHash(p.ctx, [...p.ctxOrder]);
  const gate = { intent: `E2E ${kind} mandate for ${key}` };
  const att = await sp.submitAttestation(apiKey, {
    profile_id: p.id, group_id: groupId, bounds, bounds_hash: boundsHash, context_hash: contextHash,
    domain: 'owner', did, commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ kind }),
  });
  await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: p.ctx }, p.id, gate);
  return att.authorization_id;
}

async function reconnect() {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 2_000));
  mcpClient = new Client({ name: 'sim-rerun-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}

async function toolNames(): Promise<string[]> {
  return (await mcpClient.listTools()).tools.map((t) => t.name);
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  if (r.isError) console.error(`[SIM RERUN E2E] ${tool} denied:`, text.slice(0, 300));
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** The connector's own operator command, from the package the gateway installed, on the gateway's data dir. */
function exportOf(c: (typeof SYSTEMS)[number]) {
  const dataDir = pm.getDataDir();
  const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', PKG[c], 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, HAP_DATA_DIR: dataDir };
  delete env.DATABASE_URL;
  return JSON.parse(execFileSync('node', [bin, 'export'], { env, encoding: 'utf8' }));
}

const traceIds = (ex: any) => [...ex.changes, ...ex.refusals].map((x: any) => x.receipt_id);

describe.skipIf(!available)('simulation re-run: clear, then load again (real AS + gateway + email/CRM/ERP simulators)', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'simulation-package.example.json'), 'utf8'));
  const firstHash: Record<string, string> = {};

  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('Sim Rerun Test', `sim-rerun-${Date.now()}@test.local`);
    apiKey = reg.apiKey; did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);
    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'sim-rerun-e2e', apiKey });

    await gw.waitForIntegration('erp');
    await gw.waitForIntegration('crm');
    const mail = JSON.parse(readFileSync(MAIL_MANIFEST, 'utf8'));
    await gw.addIntegration({
      id: 'mail', name: mail.name, command: mail.mcp.command, args: mail.mcp.args, envKeys: {},
      profile: mail.profile, enabled: true, toolGating: mail.toolGating,
      npmPackage: mail.npmPackage,
    } as Parameters<GatewayClient['addIntegration']>[0]);
    await gw.waitForIntegration('mail');
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
  }, 30_000);

  it('the working agent does not see clear_simulation', async () => {
    for (const k of ['sales', 'customers', 'email'] as const) await grant(k, 'work');
    await reconnect();
    const names = await toolNames();
    expect(names).toContain('erp__create_quote');
    for (const c of SYSTEMS) expect(names).not.toContain(`${c}__clear_simulation`);
  });

  it('a setup mandate makes clear_simulation appear; the package loads into all three', async () => {
    for (const k of ['sales', 'customers', 'email'] as const) await grant(k, 'setup');
    await reconnect();
    const names = await toolNames();
    for (const c of SYSTEMS) expect(names).toContain(`${c}__clear_simulation`);
    for (const c of SYSTEMS) {
      const r = await call(`${c}__load_simulation`, { package: pkg });
      expect(r.denied).toBe(false);
      firstHash[c] = r.json.package_sha256;
    }
  });

  it('a second load is refused until the simulator is cleared', async () => {
    const r = await call('erp__load_simulation', { package: pkg });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/clear it first/);
  });

  it('clear empties each simulator, leaving only the record of the clear', async () => {
    for (const c of SYSTEMS) {
      const r = await call(`${c}__clear_simulation`, {});
      expect(r.denied).toBe(false);
      expect(r.json.cleared).toBe(true);
      const ex = exportOf(c);
      expect(ex.changes.map((x: any) => x.tool)).toEqual(['clear_simulation']);
      expect(ex.refusals).toEqual([]);
    }
    expect(exportOf('mail').inbox).toEqual([]);
  });

  it('the same package loads again — same fingerprint — and the requests are dated within the last hour', async () => {
    const before = Date.now();
    for (const c of SYSTEMS) {
      const r = await call(`${c}__load_simulation`, { package: pkg });
      expect(r.denied).toBe(false);
      expect(r.json.package_sha256).toBe(firstHash[c]);
    }
    const inbox = exportOf('mail').inbox as Array<{ case_id: string; received_at: string }>;
    expect(inbox.map((m) => m.case_id)).toEqual(pkg.cases.map((c: any) => c.id)); // export orders by received_at
    for (const m of inbox) {
      const t = Date.parse(m.received_at);
      expect(t).toBeGreaterThan(before - 3_600_000);
      expect(t).toBeLessThanOrEqual(Date.now());
    }
  });

  it('every trace left is a ticket the AS issued; the clear removed the earlier ones', async () => {
    const traces = SYSTEMS.flatMap((c) => traceIds(exportOf(c)));
    expect(traces.every(Boolean)).toBe(true);
    // Per simulator: the clear + the second load.
    expect(traces).toHaveLength(6);
    // Tickets: 3 loads + the connector-refused second load + 3 clears + 3 loads = 10.
    const { receipts } = await sp.getMyReceiptsPage(apiKey, { limit: 50 });
    const tickets = new Set(receipts.map((t) => String(t.id)));
    expect(tickets.size).toBe(10);
    for (const id of traces) expect(tickets.has(id)).toBe(true);
  });
});
