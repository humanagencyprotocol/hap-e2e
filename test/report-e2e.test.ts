/**
 * R7a: evidence-backed reports, end to end on the real stack.
 *
 * Real Authority Server, the whole gateway (control plane + MCP server) in
 * simulation mode, and the published email / CRM / ERP simulator connectors
 * the gateway installs itself from the shipped manifests. The test script
 * plays the AI (no LLM):
 *
 *  1. a simulation package with three cases is loaded into all three
 *     simulators under setup mandates (as simulation-setup.test.ts does);
 *  2. under work mandates two cases are worked end to end through real gated
 *     calls — every consequential action carries an AS-signed ticket, and the
 *     reply in case c1 runs under a REVIEW email mandate, so a person approves
 *     it on the AS before the gateway executes it. Case c3 is left untouched;
 *  3. report__* tools exist only once a `reporting` mandate is granted;
 *  4. the "AI" reads its references through report__list_tickets /
 *     list_cases / get_records and writes a report with all six element kinds,
 *     one wrong ticket reference, and without case c3;
 *  5. GET /api/report is compared against the sources of truth — the AS's own
 *     signed tickets, proposals and mandates, and each connector's own export
 *     CLI — and coverage and metrics against counts computed here;
 *  6. GET /api/report/export is checked for executable content, every ticket in
 *     its embedded bundle is verified with hap-core directly against the
 *     spawned AS's key, and the real `verify-report` CLI is run on the file.
 *     That file still contains the wrong reference, which the gateway drew as
 *     "not verifiable": the CLI passes the file (2 unconfirmed, 0 with --key /
 *     --online) and lists that reference as not verifiable; a one-byte tamper,
 *     a wrong key, or flipping that element's badge to verified each give 1;
 *  7. a rewrite replaces the report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The hap-core the gateway and AS ship (the suite's own @humanagencyp/hap-core is
// pinned older and predates verifyReceiptSignature).
import { verifyReceiptSignature } from 'hap-core-current';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';
import {
  ControlPlaneClient, GW_DIR, MANIFESTS_DIR, PROFILES_DIR, newSecret, startControlPlane, startMcpServer, textOf,
  type StackOptions,
} from '../src/helpers/gateway-stack.js';

const AS_PORT = 19600;
const CP_PORT = 19601;
const MCP_PORT = 19602;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const CLI = join(GW_DIR, 'bundle', 'dist', 'bin', 'suveren-gateway.js');

const P = 'github.com/humanagencyprotocol/hap-profiles';
const REPORTING = `${P}/reporting@0.1`;
const available = existsSync(join(PROFILES_DIR, 'reporting', '0.1.profile.json')) && existsSync(join(MANIFESTS_DIR, 'mail.json'));

const SYSTEMS = ['erp', 'crm', 'mail'] as const;
type System = (typeof SYSTEMS)[number];
const PKG: Record<System, string> = { erp: 'erp-mcp', crm: 'crm-mcp', mail: 'email-mcp' };

// Same profiles, bounds and scopes as simulation-setup.test.ts.
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
    setup: { read_access: 'none', export_access: 'none', write_daily_max: 0, delete_daily_max: 0, setup_daily_max: 1 },
    work: { read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
  },
  email: {
    id: `${P}/email@0.7`,
    keyOrder: ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max', 'setup_daily_max'],
    ctxOrder: ['allowed_recipients', 'allowed_domains'],
    ctx: { allowed_recipients: 'einkauf@huber.example,office@steiner.example', allowed_domains: 'huber.example,steiner.example' },
    setup: { read_access: 'none', recipient_max: 0, send_daily_max: 0, read_max_age_days: 0, read_daily_max: 0, setup_daily_max: 1 },
    work: { read_access: 'unlimited', recipient_max: 1, send_daily_max: 10, read_max_age_days: 3650, read_daily_max: 1000, setup_daily_max: 0 },
  },
} as const;
type ProfileKey = keyof typeof PROFILES;

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-report-'));
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-report-files-'));
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL,
  extraEnv: { SUVEREN_SIMULATION: '1', SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

let user: { apiKey: string; user: { id: string; did: string } };
let groupId: string;
let agent: Client;
const mandates: Record<string, string> = {}; // `${profile}:${kind}` → authorization id

// ─── helpers ────────────────────────────────────────────────────────────────

async function grant(key: ProfileKey | 'reporting', kind: 'setup' | 'work', mode: 'automatic' | 'review' = 'automatic'): Promise<string> {
  const p = key === 'reporting'
    ? { id: REPORTING, keyOrder: ['profile', 'read_access', 'report_daily_max'], ctxOrder: [] as string[], ctx: {}, work: { read_access: 'unlimited', report_daily_max: 5 }, setup: {} }
    : PROFILES[key];
  const bounds = { profile: p.id, ...p[kind] };
  const boundsHash = computeBoundsHash(bounds, [...p.keyOrder]);
  const contextHash = computeContextHash(p.ctx, [...p.ctxOrder]);
  const gate = { intent: `R7a ${kind} mandate for ${key}` };
  const att = await sp.submitAttestation(user.apiKey, {
    profile_id: p.id, group_id: groupId, bounds, bounds_hash: boundsHash, context_hash: contextHash,
    domain: 'owner', did: user.user.did, commitment_mode: mode,
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ kind }),
  });
  await mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: p.ctx }, p.id, gate);
  mandates[`${key}:${kind}`] = att.authorization_id;
  return att.authorization_id;
}

async function reconnect() {
  if (agent) { try { await agent.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 2_000));
  agent = new Client({ name: 'report-e2e-agent', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
}

async function toolNames(): Promise<string[]> {
  return (await agent.listTools()).tools.map((t) => t.name);
}

async function call(tool: string, args: Record<string, unknown>) {
  try {
    const r = await agent.callTool({ name: tool, arguments: args });
    const text = textOf(r);
    if (r.isError) console.error(`[REPORT E2E] ${tool} refused:`, text.slice(0, 400));
    return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
  } catch (err) {
    return { denied: true, text: String(err), json: null as any };
  }
}

type AsTicket = Record<string, any> & { id: string; action: string; timestamp: number; authorizationId: string };

/** The caller's tickets as the Authority Server itself lists them — the source of truth. */
async function asTickets(): Promise<AsTicket[]> {
  const { receipts } = await sp.getMyReceiptsPage(user.apiKey, { limit: 200 });
  return receipts as AsTicket[];
}

/** Run one consequential call and return the ONE new AS-issued ticket it produced. */
async function ticketed(tool: string, args: Record<string, unknown>) {
  const before = new Set((await asTickets()).map((t) => t.id));
  const r = await call(tool, args);
  expect(r.denied, `${tool}: ${r.text.slice(0, 300)}`).toBe(false);
  const fresh = (await asTickets()).filter((t) => !before.has(t.id));
  expect(fresh, `${tool} must produce exactly one ticket`).toHaveLength(1);
  expect(fresh[0].action).toBe(tool);
  return { ...r, ticket: fresh[0] };
}

async function asApi(method: string, path: string, body?: unknown) {
  const res = await fetch(`${AS_URL}${path}`, {
    method, headers: { 'X-API-Key': user.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

/** The connector's own operator command, from the package the gateway installed, on the gateway's data dir. */
function exportOf(c: System): any {
  const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', PKG[c], 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, HAP_DATA_DIR: dataDir };
  delete env.DATABASE_URL;
  return JSON.parse(execFileSync('node', [bin, 'export'], { env, encoding: 'utf8' }));
}

/** Unix seconds from a simulator timestamp (ISO 8601, or SQLite's UTC `YYYY-MM-DD HH:MM:SS`). */
function seconds(v: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const ms = Date.parse(iso);
  expect(Number.isFinite(ms), `unparseable timestamp ${v}`).toBe(true);
  return Math.floor(ms / 1000);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function cpGet(path: string): Promise<Response> {
  return fetch(`${CP_URL}${path}`, { headers: { 'X-API-Key': user.apiKey } });
}

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['SUVEREN_AS_URL', 'SUVEREN_DATA_DIR', 'NODE_EXTRA_CA_CERTS']) delete env[k];
  return spawnSync(process.execPath, [CLI, 'verify-report', ...args], { env, encoding: 'utf-8', timeout: 60_000 });
}

// ─── state carried between the steps ────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'simulation-package.example.json'), 'utf8'));
const start: Record<string, { id: string; from: string }> = {};
const t: Record<string, AsTicket> = {}; // named work tickets
let quote1Id: string;
let quote2Id: string;
let activity1Id: string;
let replySentId: string;
let replyProposal: any;
let firstWriteTicket: AsTicket;
let report: any;
let asPublicKey: string;
let exportHtml: string;
let exportFile: string;
let firstSavedAt: number;

const BOGUS_REF = `tkt_does_not_exist_${randomBytes(4).toString('hex')}`;

describe.skipIf(!available)('R7a: evidence-backed reports (real AS + gateway + email/CRM/ERP simulators)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    // The verify-report CLI ships in the npm bundle; assemble it from the build
    // output as as-url-cli.test.ts does (reused as-is under HAP_E2E_SKIP_BUILD=1).
    if (!(process.env.HAP_E2E_SKIP_BUILD === '1' && existsSync(CLI))) {
      execFileSync(process.execPath, ['bundle/build.mjs'], {
        cwd: GW_DIR, stdio: 'pipe', timeout: 300_000,
        env: { ...process.env, HAP_PROFILES_SRC: PROFILES_DIR },
      });
    }
    await pm.startSP(AS_PORT);
    user = await sp.register('Report E2E', `report-e2e-${Date.now()}@test.local`);
    groupId = await sp.getPersonalGroupId(user.apiKey);

    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    // Sign-in on the control plane: unlocks the vault and hands the session to the MCP server.
    const login = await cp.login(user.apiKey);
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    // The three simulators, registered from the shipped manifests; the gateway installs the npm packages.
    for (const c of SYSTEMS) {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, `${c}.json`), 'utf8'));
      await mcpInternal.addIntegration({
        id: c, name: m.name, command: m.mcp.command, args: m.mcp.args, envKeys: {},
        profile: m.profile, enabled: true, toolGating: m.toolGating, npmPackage: m.npmPackage,
      } as Parameters<GatewayClient['addIntegration']>[0]);
    }
    for (const c of SYSTEMS) await mcpInternal.waitForIntegration(c);

    asPublicKey = ((await (await fetch(`${AS_URL}/api/as/pubkey`)).json()) as { publicKey: string }).publicKey;
    expect(asPublicKey).toMatch(/^[0-9a-f]{64}$/);
  }, 360_000);

  afterAll(async () => {
    if (agent) { try { await agent.close(); } catch { /* ignore */ } }
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }, 30_000);

  // ── 1. setup ──────────────────────────────────────────────────────────────

  it('1. a three-case simulation package loads into email, CRM and ERP (simulation mode)', async () => {
    expect(pkg.cases.length).toBeGreaterThanOrEqual(3);
    for (const k of ['sales', 'customers', 'email'] as const) await grant(k, 'setup');
    await reconnect();
    const hashes: string[] = [];
    for (const c of SYSTEMS) {
      // The test period starts at the email load (unix seconds); a pause puts the
      // ERP/CRM load tickets measurably before it.
      if (c === 'mail') await new Promise((r) => setTimeout(r, 1_100));
      const r = await call(`${c}__load_simulation`, { package: pkg });
      expect(r.denied, r.text.slice(0, 300)).toBe(false);
      hashes.push(r.json.package_sha256);
    }
    expect(new Set(hashes).size).toBe(1);
    for (const c of SYSTEMS) expect(exportOf(c).mode).toBe('simulation');
    expect(exportOf('mail').inbox.map((m: any) => m.case_id)).toEqual(pkg.cases.map((c: any) => c.id));
  }, 120_000);

  // ── 2. work ───────────────────────────────────────────────────────────────

  it('2a. work mandates: sales + customers automatic, email in REVIEW', async () => {
    await grant('sales', 'work');
    await grant('customers', 'work');
    await grant('email', 'work', 'review');
    await reconnect();
    const inbox = await call('mail__list_messages', {});
    expect(inbox.denied).toBe(false);
    expect(inbox.json).toHaveLength(pkg.cases.length);
    const byCase = exportOf('mail').inbox as Array<{ id: string; case_id: string; from_email: string }>;
    for (const m of byCase) start[m.case_id] = { id: m.id, from: m.from_email };
    // What the AI saw is the same inbox the connector holds.
    expect(inbox.json.map((m: any) => m.id).sort()).toEqual(byCase.map((m) => m.id).sort());
  }, 60_000);

  it('2b. case c1 (Huber, quote request): CRM note, ERP quote — each with its own AS ticket', async () => {
    const contact = await call('crm__find_contacts', { query: 'Huber' });
    expect(contact.denied).toBe(false);
    const note = await ticketed('crm__log_activity', { contact_id: contact.json[0].id, type: 'note', summary: 'c1: quote request 10 x SP-100' });
    t.c1Note = note.ticket;
    const items = await call('erp__list_items', { query: 'SP-100' });
    const customers = await call('erp__find_customers', { query: 'Huber' });
    const item = items.json[0];
    const q = await ticketed('erp__create_quote', {
      customer_id: customers.json[0].id, lines: [{ item_id: item.id, qty: 10 }],
      discount_pct: 0, value: 10 * item.list_price, currency: 'EUR',
    });
    t.c1Quote = q.ticket;
    quote1Id = q.json.id;
    const crm = exportOf('crm');
    const activity = (crm.activities as any[]).find((a) => a.receipt_id === t.c1Note.id);
    expect(activity, 'the CRM holds the note under its ticket').toBeTruthy();
    activity1Id = activity.id;
  }, 60_000);

  it('2c. case c1: the reply goes through review — proposal, a person approves on the AS, then the gateway executes it', async () => {
    const before = new Set((await asTickets()).map((x) => x.id));
    const r = await call('mail__send_message', {
      to: ['einkauf@huber.example'], subject: 'Re: Angebot benötigt — Hydraulic seal kit',
      body: 'Sehr geehrter Herr Huber, anbei unser Angebot über 10 x SP-100.', in_reply_to: start.c1.id,
    });
    expect(r.denied, r.text).toBe(false);
    expect(r.text).toMatch(/Awaiting commitment/i);
    // Nothing runs before the approval: no ticket, no sent mail.
    expect((await asTickets()).filter((x) => !before.has(x.id))).toHaveLength(0);
    expect(exportOf('mail').sent).toHaveLength(0);

    const pending = (await asApi('GET', '/api/proposals?domain=owner')).body.proposals as any[];
    const proposal = pending.find((p) => p.tool === 'mail__send_message' && p.status === 'pending');
    expect(proposal, JSON.stringify(pending)).toBeTruthy();
    await new Promise((res) => setTimeout(res, 1_100)); // a measurable wait between request and decision
    const resolved = await asApi('POST', `/api/proposals/${proposal.id}/resolve`, { action: 'commit', domain: 'owner' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300);

    const deadline = Date.now() + 30_000;
    let reply: AsTicket | undefined;
    while (Date.now() < deadline && !reply) {
      reply = (await asTickets()).find((x) => !before.has(x.id) && x.action === 'mail__send_message');
      if (!reply) await new Promise((res) => setTimeout(res, 500));
    }
    expect(reply, 'the approved reply got its ticket').toBeTruthy();
    t.c1Reply = reply!;
    // Wait for the effect, too.
    let sent: any;
    while (Date.now() < deadline && !sent) {
      sent = (exportOf('mail').sent as any[]).find((m) => m.receipt_id === t.c1Reply.id);
      if (!sent) await new Promise((res) => setTimeout(res, 500));
    }
    expect(sent, 'the reply is in the simulator under its ticket').toBeTruthy();
    expect(sent.in_reply_to).toBe(start.c1.id);
    replySentId = sent.id;
    replyProposal = (await asApi('GET', `/api/proposals/${proposal.id}`)).body.proposal;
    expect(Object.values(replyProposal.committedBy).map((x: any) => x.userId)).toEqual([user.user.id]);
    expect(t.c1Reply.proposalId).toBe(proposal.id);
  }, 90_000);

  it('2d. case c2 (Steiner, order): CRM note, ERP quote, quote sent — automatic, no approval', async () => {
    const contact = await call('crm__find_contacts', { query: 'Steiner' });
    t.c2Note = (await ticketed('crm__log_activity', { contact_id: contact.json[0].id, type: 'note', summary: 'c2: order 15 x SP-200, 10 in stock' })).ticket;
    const items = await call('erp__list_items', { query: 'SP-200' });
    const customers = await call('erp__find_customers', { query: 'Steiner' });
    const item = items.json[0];
    const value = 4 * item.list_price;
    const q = await ticketed('erp__create_quote', {
      customer_id: customers.json[0].id, lines: [{ item_id: item.id, qty: 4 }], discount_pct: 0, value, currency: 'EUR',
    });
    t.c2Quote = q.ticket;
    quote2Id = q.json.id;
    t.c2Send = (await ticketed('erp__send_quote', { id: quote2Id, value, discount_pct: 0, currency: 'EUR' })).ticket;
    // c3 stays untouched: nothing in any simulator mentions it beyond the loaded inbox mail.
    expect(exportOf('mail').sent.every((m: any) => m.in_reply_to !== start.c3.id)).toBe(true);
  }, 60_000);

  // ── 3. reporting mandate ──────────────────────────────────────────────────

  it('3. report__* tools: absent and refused before a reporting mandate, listed after it', async () => {
    const names = await toolNames();
    expect(names.filter((n) => n.startsWith('report__'))).toEqual([]);
    const refused = await call('report__list_tickets', {});
    expect(refused.denied).toBe(true);
    const refusedWrite = await call('report__write_report', { html: '<p>x</p>' });
    expect(refusedWrite.denied).toBe(true);

    await grant('reporting', 'work');
    await reconnect();
    expect((await toolNames()).filter((n) => n.startsWith('report__')).sort()).toEqual(
      ['report__get_records', 'report__get_ticket', 'report__list_cases', 'report__list_tickets', 'report__write_report'],
    );
  }, 60_000);

  // ── 4. collect + write ────────────────────────────────────────────────────

  it('4. the AI collects references through the report tools and writes the report', async () => {
    const listed = await call('report__list_tickets', {});
    expect(listed.denied).toBe(false);
    const listedIds = (listed.json.tickets as any[]).map((x) => x.id);
    // The gateway's archive lists exactly the tickets the AS issued.
    expect([...listedIds].sort()).toEqual((await asTickets()).map((x) => x.id).sort());
    for (const k of Object.keys(t)) {
      const row = (listed.json.tickets as any[]).find((x) => x.id === t[k].id);
      expect(row.action).toBe(t[k].action);
      expect(row.hasApproval).toBe(k === 'c1Reply');
    }

    const cases = await call('report__list_cases', {});
    expect(cases.denied).toBe(false);
    expect(cases.json.cases.map((c: any) => [c.caseId, c.startMessageId])).toEqual(
      ['c1', 'c2', 'c3'].map((c) => [c, start[c].id]),
    );
    expect(cases.json.sent).toEqual([expect.objectContaining({ id: replySentId, inReplyTo: start.c1.id, receiptId: t.c1Reply.id })]);
    // The people's reference replies never reach the AI.
    expect(cases.text).not.toContain(pkg.cases[0].reply.body.slice(0, 40));

    const erp = await call('report__get_records', { system: 'erp', kind: 'quotes' });
    expect((erp.json.records.quotes as any[]).map((q) => q.id).sort()).toEqual([quote1Id, quote2Id].sort());
    const crm = await call('report__get_records', { system: 'crm', kind: 'activities' });
    expect((crm.json.records.activities as any[]).some((a) => a.id === activity1Id)).toBe(true);
    const email = await call('report__get_records', { system: 'email' });
    expect(email.json.records.sent.map((m: any) => m.id)).toEqual([replySentId]);
    expect(Object.keys(email.json.records)).not.toContain('reference_replies');

    const html = `<!doctype html><html><head><title>Test report</title></head><body>
<h1 id="first-report">Two of three requests handled</h1>
<section><sv-metric kind="completed" cases="all"></sv-metric>
<sv-metric kind="median-time" cases="all"></sv-metric>
<sv-metric kind="approvals" cases="all"></sv-metric>
<sv-metric kind="without-approval" cases="all"></sv-metric>
<sv-metric kind="tickets" cases="all"></sv-metric>
<sv-metric kind="median-approval-wait" cases="all"></sv-metric></section>
<h2>c1 — Huber, quote</h2>
<sv-case start="email:${start.c1.id}" goal="ticket:${t.c1Reply.id}" steps="${t.c1Note.id} ${t.c1Quote.id}"></sv-case>
<sv-ticket ref="${t.c1Note.id}"></sv-ticket>
<sv-ticket ref="${t.c1Quote.id}"></sv-ticket>
<sv-ticket ref="${t.c1Reply.id}"></sv-ticket>
<sv-approval ticket="${t.c1Reply.id}"></sv-approval>
<sv-mandate ticket="${t.c1Quote.id}"></sv-mandate>
<sv-mandate ticket="${t.c1Reply.id}"></sv-mandate>
<sv-record system="erp" ref="${quote1Id}"></sv-record>
<sv-record system="crm" ref="${activity1Id}"></sv-record>
<sv-record system="email" ref="${replySentId}"></sv-record>
<h2>c2 — Steiner, order</h2>
<sv-case start="email:${start.c2.id}" goal="ticket:${t.c2Send.id}" steps="${t.c2Note.id} ${t.c2Quote.id}"></sv-case>
<sv-ticket ref="${t.c2Note.id}"></sv-ticket>
<sv-ticket ref="${t.c2Quote.id}"></sv-ticket>
<sv-ticket ref="${t.c2Send.id}"></sv-ticket>
<p>A reference the AI got wrong:</p>
<sv-ticket ref="${BOGUS_REF}"></sv-ticket>
</body></html>`;

    const before = new Set((await asTickets()).map((x) => x.id));
    const w = await call('report__write_report', { html });
    expect(w.denied, w.text).toBe(false);
    expect(w.text).toMatch(/Report stored\. 20 element\(s\) verified, 0 warning\(s\), 1 not verifiable\./);
    expect(w.text).toContain(BOGUS_REF);
    expect(w.text).toMatch(/Missing cases \(not defined with sv-case\): c3/);
    // write_report is itself a ticketed action under the reporting mandate.
    const fresh = (await asTickets()).filter((x) => !before.has(x.id));
    expect(fresh.map((x) => x.action)).toEqual(['report__write_report']);
    expect(fresh[0].authorizationId).toBe(mandates['reporting:work']);
    firstWriteTicket = fresh[0];
  }, 90_000);

  // ── 5. the verified report vs the sources of truth ────────────────────────

  it('5. GET /api/report: every element verified against its source of truth; wrong ref, coverage, metrics', async () => {
    const res = await cpGet('/api/report');
    expect(res.status).toBe(200);
    report = ((await res.json()) as any).report;
    expect(report).toBeTruthy();
    firstSavedAt = report.savedAt;
    const els = report.elements as any[];
    const byKind = (k: string) => els.filter((e) => e.kind === k);
    expect(els).toHaveLength(21);

    // Every correct element verified; exactly the wrong one is not.
    const notVerified = els.filter((e) => e.status !== 'verified');
    expect(notVerified.map((e) => [e.kind, e.attrs.ref ?? e.attrs.ticket, e.status])).toEqual([['sv-ticket', BOGUS_REF, 'unverifiable']]);
    expect(notVerified[0].data).toBeUndefined();
    expect(report.renderedHtml).toMatch(/not verifiable/i);

    const all = await asTickets();
    const asById = new Map(all.map((x) => [x.id, x]));

    // sv-ticket: id, action, time, mandate, profile — as the AS signed them.
    for (const el of byKind('sv-ticket').filter((e) => e.attrs.ref !== BOGUS_REF)) {
      const src = asById.get(el.attrs.ref)!;
      expect(src, el.attrs.ref).toBeTruthy();
      expect(el.data).toMatchObject({
        ticketId: src.id, action: src.action, time: src.timestamp,
        authorizationId: src.authorizationId, profile: src.profileId,
        checkUrl: `${AS_URL}/r/${src.id}`,
      });
    }
    expect(byKind('sv-ticket')).toHaveLength(7);

    // sv-approval: the decider and the times are the AS proposal's.
    const [approval] = byKind('sv-approval');
    const decided = Object.values(replyProposal.committedBy) as Array<{ userId: string; at: number }>;
    expect(approval.data).toMatchObject({
      ticketId: t.c1Reply.id,
      who: [user.user.id],
      createdAt: replyProposal.createdAt,
      decidedAt: Math.max(...decided.map((d) => d.at)),
      waitSeconds: Math.max(...decided.map((d) => d.at)) - replyProposal.createdAt,
    });

    // sv-mandate: profile, mode and mandate id are the AS's record of that mandate.
    for (const el of byKind('sv-mandate')) {
      const ticket = asById.get(el.attrs.ticket)!;
      const summary = await sp.getAuthorizationSummary(user.apiKey, ticket.authorizationId);
      expect(summary.status).toBe(200);
      expect(el.data).toMatchObject({
        authorizationId: ticket.authorizationId,
        profile: summary.body.profile_id,
        mode: summary.body.commitment_mode,
      });
    }
    const modes = Object.fromEntries(byKind('sv-mandate').map((e) => [e.attrs.ticket, [e.data.profile, e.data.mode]]));
    expect(modes).toEqual({
      [t.c1Quote.id]: [PROFILES.sales.id, 'automatic'],
      [t.c1Reply.id]: [PROFILES.email.id, 'review'],
    });
    expect(byKind('sv-mandate').map((e) => e.data.authorizationId).sort()).toEqual([mandates['sales:work'], mandates['email:work']].sort());

    // sv-record: every field equals the connector's own export row.
    const erpX = exportOf('erp');
    const crmX = exportOf('crm');
    const mailX = exportOf('mail');
    const recs = Object.fromEntries(byKind('sv-record').map((e) => [e.attrs.system, e.data]));
    expect(recs.erp).toEqual({ kind: 'quote', ...(erpX.quotes as any[]).find((q) => q.id === quote1Id) });
    expect(recs.erp.receipt_id).toBe(t.c1Quote.id);
    expect(recs.crm).toEqual({ kind: 'activity', ...(crmX.activities as any[]).find((a) => a.id === activity1Id) });
    expect(recs.email).toEqual({ kind: 'message', folder: 'sent', ...(mailX.sent as any[]).find((m) => m.id === replySentId) });

    // sv-case: start, goal, steps, duration — from the inbox and the AS tickets.
    const startTime = (c: string) => seconds((mailX.inbox as any[]).find((m) => m.id === start[c].id).received_at);
    const cases = Object.fromEntries(byKind('sv-case').map((e) => [e.data.caseId, e.data]));
    expect(Object.keys(cases).sort()).toEqual(['c1', 'c2']);
    const expectCase = (c: string, goal: AsTicket, steps: AsTicket[], approvals: number) => {
      expect(cases[c]).toMatchObject({
        start: { id: start[c].id, time: startTime(c), sender: start[c].from },
        goal: { ticketId: goal.id, time: goal.timestamp, action: goal.action },
        steps: steps.map((s) => ({ ticketId: s.id, time: s.timestamp, action: s.action })),
        totalDurationSeconds: goal.timestamp - startTime(c),
      });
      expect(cases[c].approvals).toHaveLength(approvals);
    };
    expectCase('c1', t.c1Reply, [t.c1Note, t.c1Quote], 1);
    expectCase('c2', t.c2Send, [t.c2Note, t.c2Quote], 0);

    // sv-metric: recomputed here from the raw tickets, inbox and proposal.
    const durations = [t.c1Reply.timestamp - startTime('c1'), t.c2Send.timestamp - startTime('c2')];
    const wait = Math.max(...decided.map((d) => d.at)) - replyProposal.createdAt;
    const expectedMetrics = {
      'completed': 2,
      'median-time': median(durations),
      'approvals': 1,
      'without-approval': 1 / 2,
      'tickets': new Set([t.c1Reply, t.c1Note, t.c1Quote, t.c2Send, t.c2Note, t.c2Quote].map((x) => x.id)).size,
      'median-approval-wait': wait,
    };
    const metrics = Object.fromEntries(byKind('sv-metric').map((e) => [e.data.kind, e.data.value]));
    expect(metrics).toEqual(expectedMetrics);
    for (const el of byKind('sv-metric')) expect(el.data.caseCount).toBe(2);
    expect(wait).toBeGreaterThanOrEqual(1);

    // Proof: the wrong reference is counted, and only it.
    const realRefs = new Set([t.c1Note, t.c1Quote, t.c1Reply, t.c2Note, t.c2Quote, t.c2Send].map((x) => x.id));
    expect(report.proof.unverifiableCount).toBe(1);
    expect([...report.proof.ticketsReferenced].sort()).toEqual([...realRefs, BOGUS_REF].sort());
    expect(report.proof.signaturesValid).toBe(realRefs.size);
    expect(report.proof.recordsChecked).toBe(3);
    expect(report.proof.verifiedValues).toHaveLength(20);

    // Coverage: the omitted case is named; ticket coverage equals an independent count.
    const cov = report.coverage;
    expect(cov.emailExportError).toBeUndefined();
    expect(cov.loadedCases).toEqual(['c1', 'c2', 'c3']);
    expect(cov.coveredCases).toEqual(['c1', 'c2']);
    expect(cov.missingCases).toEqual(['c3']);
    const periodStart = seconds(mailX.simulation_load.loaded_at);
    expect(cov.periodStart).toBe(periodStart);
    // Population: every ticket the AS issued to this user (the report's own write
    // ticket included — it was archived before the report was verified).
    const inPeriod = all.filter((x) => x.timestamp >= periodStart).map((x) => x.id);
    const referenced = inPeriod.filter((id) => realRefs.has(id));
    const notReferenced = inPeriod.filter((id) => !realRefs.has(id));
    expect([...cov.ticketsInPeriod].sort()).toEqual([...inPeriod].sort());
    expect([...cov.ticketsReferenced].sort()).toEqual([...referenced].sort());
    expect([...cov.ticketsNotReferenced].sort()).toEqual([...notReferenced].sort());
    // Not vacuous: all six work tickets count as referenced, the report's own write ticket does not.
    expect(referenced.length).toBe(6);
    expect(notReferenced).toContain(firstWriteTicket.id);
    // Setup tickets issued before the email simulator's load are outside the period.
    const setupBefore = all.filter((x) => x.timestamp < periodStart);
    expect(setupBefore.length).toBeGreaterThan(0);
    for (const x of setupBefore) expect(cov.ticketsInPeriod).not.toContain(x.id);
  }, 60_000);

  // ── 6. export with proof ──────────────────────────────────────────────────

  it('6a. GET /api/report/export: an attachment HTML with no executable content', async () => {
    const res = await cpGet('/api/report/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="suveren-report-\d{4}-\d{2}-\d{2}\.html"$/);
    exportHtml = await res.text();

    const scripts = [...exportHtml.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/type="application\/json"/);
    expect(scripts[0]).toMatch(/id="suveren-proof"/);
    const withoutData = exportHtml.replace(/<script\b[^>]*id="suveren-proof"[^>]*>[\s\S]*?<\/script>/i, '');
    expect(withoutData).not.toMatch(/<script/i);
    const tags = [...withoutData.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(20);
    for (const tag of tags) {
      expect(tag, tag).not.toMatch(/\son[a-z]+\s*=/i);
      expect(tag, tag).not.toMatch(/javascript:/i);
    }
    // The drawn report is in the file — including the wrong reference, shown as such.
    expect(withoutData).toContain('first-report');
    expect(withoutData).toMatch(/not verifiable/i);

    exportFile = join(work, 'suveren-report.html');
    writeFileSync(exportFile, exportHtml);
  }, 60_000);

  it('6b. every ticket in the embedded bundle verifies with hap-core against the spawned AS key', async () => {
    const m = /<script[^>]*id="suveren-proof"[^>]*>([\s\S]*?)<\/script>/i.exec(exportHtml);
    expect(m).toBeTruthy();
    const bundle = JSON.parse(m![1]);
    expect(bundle.format).toBe('suveren-report-export');
    expect(bundle.authorityServer).toEqual({ url: AS_URL, publicKeyHex: asPublicKey });

    const all = new Map((await asTickets()).map((x) => [x.id, x]));
    const ids = (bundle.tickets as any[]).map((x) => x.id);
    for (const ticket of bundle.tickets as any[]) {
      await expect(verifyReceiptSignature(ticket, asPublicKey), ticket.id).resolves.toBeUndefined();
      // Byte-identical to what the AS lists for that id.
      const src = all.get(ticket.id)!;
      expect(src, ticket.id).toBeTruthy();
      expect(ticket.signature).toBe(src.signature);
      expect(ticket.action).toBe(src.action);
      expect(ticket.timestamp).toBe(src.timestamp);
    }
    // Every referenced ticket plus every ticket in the period is included.
    const expected = new Set([...bundle.proof.ticketsReferenced, ...bundle.coverage.ticketsInPeriod].filter((id) => all.has(id)));
    expect([...ids].sort()).toEqual([...expected].sort());
    for (const k of Object.keys(t)) expect(ids).toContain(t[k].id);
    expect(ids).not.toContain(BOGUS_REF);
    // A ticket signed by any other key does not verify.
    const otherKey = randomBytes(32).toString('hex');
    await expect(verifyReceiptSignature(bundle.tickets[0], otherKey)).rejects.toThrow();
  }, 60_000);

  it('6c. the real verify-report CLI: the wrong reference, drawn as not verifiable, is listed and does not fail the file — unconfirmed key → 2, --key → 0, --online → 0', () => {
    expect(existsSync(CLI), `${CLI} — the npm bundle must be assembled (node bundle/build.mjs)`).toBe(true);
    // Ticket-backed elements the gateway drew as verified (records/metrics are not ticket references).
    const ticketKinds = new Set(['sv-ticket', 'sv-approval', 'sv-mandate', 'sv-case']);
    const shownVerified = (report.elements as any[]).filter((e) => ticketKinds.has(e.kind) && e.status !== 'unverifiable').length;
    expect(shownVerified).toBeGreaterThan(5);
    const countsLine = `References: ${shownVerified} verified · 1 not verifiable (as shown in the report).`;

    const plain = runCli([exportFile]);
    expect(plain.status, plain.stdout + plain.stderr).toBe(2);
    expect(plain.stdout).toMatch(/Key not confirmed/);

    const keyed = runCli([exportFile, '--key', asPublicKey]);
    expect(keyed.status, keyed.stdout + keyed.stderr).toBe(0);

    const online = runCli([exportFile, '--online']);
    expect(online.status, online.stdout + online.stderr).toBe(0);
    expect(online.stdout).toMatch(/Key confirmed against the live Authority Server/);

    for (const r of [plain, keyed, online]) {
      expect(r.stdout).toContain(countsLine);
      expect(r.stdout).toMatch(/Signatures: all \d+ valid/);
      expect(r.stdout).toMatch(/Mandates: all \d+ valid/);
      expect(r.stdout).not.toMatch(/INVALID/);
      // The bogus reference is listed — and only it — under the not-verifiable section.
      const section = /Not verifiable \(as shown in the report\):\n((?: {4}- .*\n?)+)/.exec(r.stdout);
      expect(section, r.stdout).toBeTruthy();
      const listed = section![1].trim().split('\n');
      expect(listed).toHaveLength(1);
      expect(listed[0]).toContain(BOGUS_REF);
      expect(listed[0]).toContain(`not in the file: ${BOGUS_REF}`);
    }
  }, 60_000);

  it('6d. tampering still fails: one byte of a ticket → 1, a wrong key → 1, the bogus element\'s badge flipped to verified → 1', () => {
    // One byte of one ticket changed: the last digit of its timestamp.
    const m = /(<script[^>]*id="suveren-proof"[^>]*>)([\s\S]*?)(<\/script>)/i.exec(exportHtml)!;
    const bundle = JSON.parse(m[2]);
    const victim = bundle.tickets[0];
    const tsString = String(victim.timestamp);
    const lastDigit = Number(tsString.slice(-1));
    victim.timestamp = Number(tsString.slice(0, -1) + String((lastDigit + 1) % 10));
    const tamperedJson = JSON.stringify(bundle).replace(/<\//g, '<\\/');
    expect(tamperedJson.length).toBe(m[2].length);
    const tamperedFile = join(work, 'tampered.html');
    writeFileSync(tamperedFile, exportHtml.replace(m[0], `${m[1]}${tamperedJson}${m[3]}`));
    const tampered = runCli([tamperedFile]);
    expect(tampered.status, tampered.stdout + tampered.stderr).toBe(1);
    expect(tampered.stdout).toContain(victim.id);
    const tamperedKeyed = runCli([tamperedFile, '--key', asPublicKey]);
    expect(tamperedKeyed.status, tamperedKeyed.stdout).toBe(1);

    const wrongKey = runCli([exportFile, '--key', randomBytes(32).toString('hex')]);
    expect(wrongKey.status, wrongKey.stdout + wrongKey.stderr).toBe(1);
    expect(wrongKey.stdout).toMatch(/Key MISMATCH/);

    // A forger may downgrade a claim, never upgrade one: the bogus reference's
    // drawn card is the file's only not-verifiable badge — flip it to verified.
    const visible = exportHtml.slice(0, exportHtml.indexOf('<script'));
    expect(visible.split('sv-badge sv-badge-bad').length - 1).toBe(1);
    const upgradedFile = join(work, 'upgraded.html');
    writeFileSync(upgradedFile, exportHtml.replace('sv-badge sv-badge-bad', 'sv-badge sv-badge-ok'));
    for (const args of [[upgradedFile], [upgradedFile, '--key', asPublicKey], [upgradedFile, '--online']]) {
      const r = runCli(args);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/INVALID — 1 reference\(s\) shown as verified with no valid backing/);
      expect(r.stdout).toContain(`(${BOGUS_REF}): Ticket ${BOGUS_REF} is not in the bundle.`);
    }
  }, 120_000);

  // ── 7. replace ────────────────────────────────────────────────────────────

  it('7. rewriting the report replaces it — one current report', async () => {
    await new Promise((r) => setTimeout(r, 1_100)); // so savedAt can move
    const html = `<html><body><h1 id="second-report">Updated report</h1>
<sv-case start="email:${start.c1.id}" goal="ticket:${t.c1Reply.id}" steps="${t.c1Note.id} ${t.c1Quote.id}"></sv-case>
<sv-metric kind="completed" cases="all"></sv-metric></body></html>`;
    const w = await call('report__write_report', { html });
    expect(w.denied, w.text).toBe(false);
    expect(w.text).toMatch(/Report stored\. 2 element\(s\) verified, 0 warning\(s\), 0 not verifiable\./);

    const res = await cpGet('/api/report');
    expect(res.status).toBe(200);
    const second = ((await res.json()) as any).report;
    expect(second.savedAt).toBeGreaterThan(firstSavedAt);
    expect(second.renderedHtml).toContain('second-report');
    expect(second.renderedHtml).not.toContain('first-report');
    expect(second.elements.map((e: any) => [e.kind, e.status])).toEqual([['sv-case', 'verified'], ['sv-metric', 'verified']]);
    expect(second.elements[1].data.value).toBe(1);
    expect(second.proof.unverifiableCount).toBe(0);
    expect(second.coverage.missingCases).toEqual(['c2', 'c3']);
    // The export now carries the second report, not the first.
    const exp = await (await cpGet('/api/report/export')).text();
    expect(exp).toContain('second-report');
    expect(exp).not.toContain('first-report');
  }, 60_000);
});
