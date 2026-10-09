/**
 * The three-week test's setup and first case, on the real stack.
 *
 * One simulation package (renamed real cases + the world they need) is loaded
 * into the simulated email, CRM and ERP — each load a ticketed `setup` action
 * under a separate setup mandate — and then an AI works a case from the inbox
 * under ordinary work mandates. What must hold:
 *
 * - the same package reaches all three systems (same fingerprint);
 * - a simulation can only be created, not edited: a second load is refused by
 *   the connector even though the gateway let it through;
 * - the AI's work mandates cannot load test data at all (setup_daily_max 0) —
 *   refused by the gateway, no ticket;
 * - a reply outside the allowed domains is refused by the gateway;
 * - every ticket the AS issued has exactly one trace in the three connectors'
 *   records (a change or a refusal), and nothing refused by the gateway has one;
 * - the people's actual replies (the reference the AI is later compared with)
 *   never appear in anything a tool returned to the AI.
 *
 * The connectors are the published packages, installed by the gateway itself:
 * erp-mcp and crm-mcp as personal defaults, email-mcp registered from the shipped
 * mail.json manifest (it is not a personal default, so it never starts next to
 * Gmail on its own). Governed by the shipped manifests and the live profiles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { profileHashFor } from '../src/helpers/profiles.js';

const SP_PORT = 17460;
const GW_PORT = 17492;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const INTEGRATIONS = join(ROOT, 'suveren-gateway', 'content', 'integrations');
const MAIL_MANIFEST = join(INTEGRATIONS, 'mail.json');
const available = existsSync(MAIL_MANIFEST);
const PKG = { erp: 'erp-mcp', crm: 'crm-mcp', mail: 'email-mcp' } as const;

const P = 'github.com/humanagencyprotocol/hap-profiles';
const PROFILES = {
  sales: {
    id: `${P}/sales@0.4`, short: 'sales',
    keyOrder: ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max', 'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'],
    ctxOrder: ['currency'], ctx: { currency: 'EUR' },
    setup: { read_access: 'none', value_max: 0, discount_max: 0, order_value_daily_max: 0, quote_daily_max: 0, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 5 },
    work: { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10, setup_daily_max: 0 },
  },
  customers: {
    id: `${P}/customers@0.9`, short: 'customers',
    keyOrder: ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'],
    ctxOrder: ['contact_type'], ctx: { contact_type: 'customer' },
    setup: { read_access: 'none', export_access: 'none', write_daily_max: 0, delete_daily_max: 0, setup_daily_max: 1 },
    work: { read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
  },
  email: {
    id: `${P}/email@0.8`, short: 'email',
    // v0.7: read_daily_max is gone (replaced by read_access; never enforced, CONFORMANCE.md).
    keyOrder: ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'],
    ctxOrder: ['allowed_recipients', 'allowed_domains'],
    ctx: { allowed_recipients: 'einkauf@huber.example,office@steiner.example', allowed_domains: 'huber.example,steiner.example' },
    setup: { read_access: 'none', recipient_max: 0, send_daily_max: 0, read_max_age_days: 0, setup_daily_max: 1 },
    work: { read_access: 'unlimited', recipient_max: 1, send_daily_max: 10, read_max_age_days: 3650, setup_daily_max: 0 },
  },
} as const;
type ProfileKey = keyof typeof PROFILES;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-sim-'));

let apiKey: string;
let did: string;
let groupId: string;
let mcpClient: Client;
const toolOutputs: string[] = [];

async function grant(key: ProfileKey, kind: 'setup' | 'work'): Promise<string> {
  const p = PROFILES[key];
  const bounds = { profile: p.id, ...p[kind] };
  const boundsHash = computeBoundsHash(bounds, [...p.keyOrder]);
  const contextHash = computeScopeHash(p.ctx, [...p.ctxOrder]);
  const gate = { intent: `E2E ${kind} mandate for ${p.short}` };
  const att = await sp.submitMandate(apiKey, {
    profile_id: p.id, profile_hash: profileHashFor(p.id, PROFILES_DIR), group_id: groupId, bounds, bounds_hash: boundsHash, scope_hash: contextHash,
    domain: 'owner', did, commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ kind }),
  });
  await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: p.ctx }, p.id, gate);
  return att.authorization_id;
}

async function reconnect() {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 2_000));
  mcpClient = new Client({ name: 'sim-setup-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  toolOutputs.push(text);
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** The connector's own operator command, from the package the gateway installed, on the gateway's data dir. */
function exportOf(c: 'erp' | 'crm' | 'mail') {
  const dataDir = pm.getDataDir();
  const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', PKG[c], 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, HAP_DATA_DIR: dataDir };
  delete env.DATABASE_URL;
  return JSON.parse(execFileSync('node', [bin, 'export'], { env, encoding: 'utf8' }));
}

describe.skipIf(!available)('simulation setup + first case (real AS + gateway + email/CRM/ERP simulators)', () => {
  // The canonical example package shipped with the email simulator (renamed spare-parts cases).
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'simulation-package.example.json'), 'utf8'));
  const setupMandates: string[] = [];

  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('Sim Setup Test', `sim-setup-${Date.now()}@test.local`);
    apiKey = reg.apiKey; did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);
    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'sim-setup-e2e', apiKey });

    // erp + crm: personal defaults, installed from npm by the gateway on start.
    await gw.waitForIntegration('erp');
    await gw.waitForIntegration('crm');
    // mail: registered from the shipped manifest; the gateway installs the npm package.
    const mail = JSON.parse(readFileSync(MAIL_MANIFEST, 'utf8'));
    await gw.addIntegration({
      id: 'mail', name: mail.name, command: mail.mcp.command, args: mail.mcp.args, envKeys: {},
      profile: mail.profile, enabled: true, toolGating: mail.toolGating,
      npmPackage: mail.npmPackage,
    } as Parameters<GatewayClient['addIntegration']>[0]);
    await gw.waitForIntegration('mail');

    for (const k of ['sales', 'customers', 'email'] as const) setupMandates.push(await grant(k, 'setup'));
    await reconnect();
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
    rmSync(work, { recursive: true, force: true });
  }, 30_000);

  const hashes: Record<string, string> = {};

  it('all three simulators describe the same package format to the setup agent', async () => {
    // load_simulation's `package` JSON Schema is one shared definition vendored into
    // erp-mcp, crm-mcp and email-mcp. Each repo tests its own copy against its own
    // parser; only here, across the published packages, can a drifted copy be seen.
    // The per-tool `description` notes which part each connector uses, so it differs.
    const { tools } = await mcpClient.listTools();
    const schemaOf = (name: string) => {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} visible to the setup agent`).toBeTruthy();
      const { description: _note, ...rest } = (t!.inputSchema as any).properties.package;
      return rest;
    };
    const erp = schemaOf('erp__load_simulation');
    expect(erp.required).toEqual(expect.arrayContaining(['name', 'currency', 'customers', 'products', 'cases']));
    expect(Object.keys(erp.properties.products.items.properties)).toEqual(expect.arrayContaining(['sku', 'list_price', 'stock']));
    expect(schemaOf('crm__load_simulation')).toEqual(erp);
    expect(schemaOf('mail__load_simulation')).toEqual(erp);
  });

  it('the same package loads into email, CRM and ERP — one fingerprint', async () => {
    for (const c of ['erp', 'crm', 'mail'] as const) {
      const r = await call(`${c}__load_simulation`, { package: pkg });
      if (r.denied) console.error(`[SIM E2E] ${c} load denied:`, r.text.slice(0, 300));
      expect(r.denied).toBe(false);
      hashes[c] = r.json.package_sha256;
    }
    expect(hashes.erp).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.crm).toBe(hashes.erp);
    expect(hashes.mail).toBe(hashes.erp);
  });

  it('a second load is refused by the connector — a simulation can only be created, not edited', async () => {
    const r = await call('erp__load_simulation', { package: pkg });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/can only be created/);
  });

  it('switching to work mandates: the AI cannot load test data — refused before execution, no ticket', async () => {
    for (const id of setupMandates) await sp.revokeAuthorization(apiKey, id);
    for (const k of ['sales', 'customers', 'email'] as const) await grant(k, 'work');
    await reconnect();
    // The first ticketed call after a revoke can still select the revoked setup
    // mandate (the gateway's cache refresh is asynchronous); the AS refuses it as
    // revoked. Since gateway #44 the gateway then falls back to another mandate that
    // passes locally — but here there is none: the work mandate's setup_daily_max = 0
    // cannot authorize a load. So the first attempt may still end as "revoked" —
    // never as a load — and the second must hit setup_daily_max = 0. The fallback
    // itself is covered by test/revoked-mandate-fallback.test.ts.
    for (const c of ['erp', 'crm', 'mail'] as const) {
      const first = await call(`${c}__load_simulation`, { package: pkg });
      expect(first.denied).toBe(true);
      expect(first.text).toMatch(/revoked|setup_daily_max|limit|exceed/i);
      const r = await call(`${c}__load_simulation`, { package: pkg });
      expect(r.denied).toBe(true);
      expect(r.text).toMatch(/setup_daily_max|limit|exceed/i);
    }
  });

  let msg: any;
  let contactId: string;

  it('the case arrives through the inbox', async () => {
    const list = await call('mail__list_messages', {});
    expect(list.denied).toBe(false);
    expect(list.json).toHaveLength(pkg.cases.length);
    const first = list.json.find((m: any) => /Angebot/.test(m.subject));
    const full = await call('mail__get_message', { id: first.id });
    expect(full.denied).toBe(false);
    msg = full.json;
    expect(JSON.stringify(msg.from)).toMatch(/einkauf@huber\.example/);
  });

  it('the AI looks up and notes the customer in the CRM', async () => {
    const found = await call('crm__find_contacts', { query: 'Huber' });
    expect(found.denied).toBe(false);
    contactId = found.json[0].id;
    const note = await call('crm__log_activity', { contact_id: contactId, type: 'note', summary: 'Quote request: 10 x SP-100' });
    if (note.denied) console.error('[SIM E2E] log_activity denied:', note.text.slice(0, 300));
    expect(note.denied).toBe(false);
  });

  it('the AI writes the quote in the ERP', async () => {
    const items = await call('erp__list_items', { query: 'SP-100' });
    const customers = await call('erp__find_customers', { query: 'Huber' });
    const item = items.json[0];
    const q = await call('erp__create_quote', {
      customer_id: customers.json[0].id, lines: [{ item_id: item.id, qty: 10 }],
      discount_pct: 0, value: 10 * item.list_price, currency: 'EUR',
    });
    if (q.denied) console.error('[SIM E2E] quote denied:', q.text.slice(0, 300));
    expect(q.denied).toBe(false);
  });

  it('the AI replies to the customer', async () => {
    const r = await call('mail__send_message', {
      to: ['einkauf@huber.example'], subject: `Re: ${msg.subject}`,
      body: 'Sehr geehrter Herr Huber, anbei unser Angebot über 10 x SP-100.', in_reply_to: msg.id,
    });
    if (r.denied) console.error('[SIM E2E] send denied:', r.text.slice(0, 300));
    expect(r.denied).toBe(false);
  });

  it('a reply outside the allowed domains is refused by the gateway', async () => {
    const r = await call('mail__send_message', { to: ['someone@elsewhere.example'], subject: 'x', body: 'x' });
    expect(r.denied).toBe(true);
  });

  it('every ticket has exactly one trace across the three simulators', async () => {
    const ex = { erp: exportOf('erp'), crm: exportOf('crm'), mail: exportOf('mail') };
    for (const c of ['erp', 'crm', 'mail'] as const) {
      expect(ex[c].mode).toBe('simulation');
      expect(ex[c].simulation_load?.package_sha256 ?? ex[c].simulation_load?.[0]?.package_sha256).toBe(hashes.erp);
    }
    const traces = (['erp', 'crm', 'mail'] as const)
      .flatMap((c) => [...ex[c].changes, ...ex[c].refusals])
      .map((x: any) => x.receipt_id);
    expect(traces.every(Boolean)).toBe(true);
    expect(new Set(traces).size).toBe(traces.length);

    // 3 loads + the connector-refused second load + log_activity + create_quote + send_message = 7.
    // Gateway refusals (load under the work mandate, reply outside the domains) have none.
    const { tickets: receipts } = await sp.getMyTicketsPage(apiKey, { limit: 50 });
    const tickets = receipts.map((t) => String(t.id)).sort();
    expect(tickets).toHaveLength(7);
    expect([...traces].sort()).toEqual(tickets);
  });

  it("the people's actual replies never reached the AI", () => {
    const ex = exportOf('mail');
    expect(ex.reference_replies).toHaveLength(pkg.cases.length);
    const seen = toolOutputs.join('\n');
    for (const c of pkg.cases) expect(seen).not.toContain(c.reply.body.slice(0, 40));
  });
});
