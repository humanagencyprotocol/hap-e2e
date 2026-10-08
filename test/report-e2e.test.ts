/**
 * Regular reporting (RR7): evidence-backed reports, end to end on the real stack.
 *
 * Real Authority Server (serving the LOCAL hap-profiles — reporting@0.2 may not
 * be on GitHub main yet), the whole gateway (control plane + MCP server), the
 * real records connector and the published email / CRM / ERP simulators the
 * gateway installs itself. The test script plays the AI (no LLM). No mocks.
 *
 *  0. Before the test: real, NON-simulation work in the same gateway archive —
 *     one ticket three days old (the AS and the gateway run on a clock shifted
 *     back by three days while it is issued; the signed timestamp is genuine)
 *     and one fresh ticket. The gateway then restarts in simulation mode.
 *  1. a three-case simulation package loads (setup mandates);
 *  2. two cases are worked through real gated calls; the c1 reply runs under a
 *     REVIEW email mandate, approved by a person on the AS;
 *  3. the reporting mandate: a window of 367 days is refused by the AS (422,
 *     nothing signed) and by the create_mandate ceremony; a reporting@0.1
 *     mandate is refused by every report tool; reporting@0.2 with a one-day
 *     `read_max_age_days` is issued;
 *  4. the read tools: only tickets inside the window (in simulation mode: not
 *     before the test data was loaded) — the old and the fresh real ticket are
 *     not listed and cannot be opened; no tool output carries a user / group /
 *     mandate id, a signature or an attestation blob (grepped for the real
 *     values);
 *  5. the AI writes a report in the two-tag format (sv-ai, sv-row, every
 *     verified kind incl. full/compact tickets, a glossary), with top-level
 *     junk, sv-* and styles inside sv-ai, an overlay attack, a wrong reference
 *     and references to the old ticket;
 *  6. GET /api/report against the sources of truth — AS tickets, proposal,
 *     mandates, each connector's own export CLI; metrics and durations against
 *     an independent computation (start = max(received_at, loaded_at));
 *  7. every drawn verified box (in Chromium) holds only signed field names and
 *     their values + seal + link; glosses only on words in the boxes and only
 *     with the switch on;
 *  8. the export: what the report does not show is not in the file; the
 *     verify-report CLI exit codes (2 / 0 / 0, and 1 for tampering, a random
 *     key, an upgraded not-verifiable element); CSS-only translation switch;
 *  9. the gateway UI (Playwright, real control plane): AI CSS cannot cover a
 *     verified box, Checked values opens details without a reload/logout, the
 *     public-check popup opens (intercepted), the switch, phone width;
 * 10. a rewrite replaces the report; its export carries neither real ticket;
 * 11. outside simulation mode (gateway restarted): the window is the mandate's
 *     day count alone — the fresh real ticket is in, the old one is out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { chromium, type Browser, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTicketSignature, encodeDidKey } from '@humanagencyp/hap-core';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash, computeProfileHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';
import {
  ControlPlaneClient, GW_DIR, MANIFESTS_DIR, PROFILES_DIR, RECORDS_DIST, RECORDS_INTEGRATION, RECORDS_PROFILE_ID,
  newSecret, startControlPlane, startMcpServer, textOf, type StackOptions,
} from '../src/helpers/gateway-stack.js';
import { shiftedClock, type ShiftedClock } from '../src/helpers/clock.js';
import { localProfilesForAs } from '../src/helpers/local-profiles.js';

const AS_PORT = 19600;
const CP_PORT = 19601;
const MCP_PORT = 19602;
const AS_URL = `http://localhost:${AS_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;
const CLI = join(GW_DIR, 'bundle', 'dist', 'bin', 'suveren-gateway.js');

const DAY = 86_400;
/** The reporting mandate's window. */
const WINDOW_DAYS = 1;
/** How old the old real ticket is — well outside the window. */
const OLD_AGE_SECONDS = 3 * DAY;

const P = 'github.com/humanagencyprotocol/hap-profiles';
const REPORTING = PROFILE_V07.reporting;
// v0.7: a pre-0.7 reporting mandate (e.g. the old reporting@0.1, which has
// no window bound at all) can no longer be ISSUED post-switch -- any
// profile still naming the retired decision_owner gate fails PROFILE_INVALID
// at the AS before a mandate could ever exist to test the "every report
// tool refuses it" behaviour. That behaviour itself is NOT version-specific
// (window.ts's resolveAgeBoundField reads the bounds SCHEMA, never a profile
// id) so it is reproduced here with a throwaway, v0.7-valid community
// profile that simply declares no reporting-window bound — see
// REPORTING_OLD_DOC below, registered in beforeAll.
let REPORTING_OLD = '';
let REPORTING_OLD_DOC: Record<string, unknown>;
function reportingOldFixtureDoc(id: string): Record<string, unknown> {
  return {
    id,
    name: 'E2E reporting-without-window fixture',
    version: '0.0',
    description: 'Throwaway community profile: a reporting profile with no reporting-window bound (mirrors reporting@0.1, which cannot be issued post-v0.7-switch).',
    boundsSchema: {
      actionTypes: ['report'],
      keyOrder: ['profile', 'read_access', 'report_daily_max'],
      fields: {
        profile: { type: 'string', required: true },
        read_access: {
          type: 'string', required: true, displayName: 'Read evidence',
          boundType: { kind: 'enum', values: ['unlimited', 'none'] }, default: 'unlimited',
        },
        report_daily_max: {
          type: 'number', required: true, displayName: 'Report updates per day',
          boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['report'],
        },
      },
    },
    executionContextSchema: {
      fields: {
        report_count_daily: {
          source: 'cumulative', cumulativeField: '_count', window: 'daily',
          description: 'Running daily count of report writes', required: true,
          constraint: { type: 'number', enforceable: ['max'] },
        },
      },
    },
    requiredGates: ['bounds', 'intent', 'commitment', 'mandate_owner'],
    ttl: { default: 86400, max: 86400 },
  };
}
const DELEGATION = PROFILE_V07.delegation;
const available =
  existsSync(join(PROFILES_DIR, 'reporting', '0.3.profile.json')) &&
  existsSync(join(MANIFESTS_DIR, 'mail.json')) &&
  existsSync(RECORDS_DIST);

const SYSTEMS = ['erp', 'crm', 'mail'] as const;
type System = (typeof SYSTEMS)[number];
const PKG: Record<System, string> = { erp: 'erp-mcp', crm: 'crm-mcp', mail: 'email-mcp' };

/** Unique per run, so a grep for an intent can only hit that one mandate. */
const RUN = randomBytes(4).toString('hex');
const intentOf = (name: string) => `R7 intent for ${name} [${RUN}]`;

interface MandateSpec {
  id: string;
  keyOrder: string[];
  ctxOrder: string[];
  ctx: Record<string, string>;
  bounds: Record<string, string | number>;
}

const SALES = { id: PROFILE_V07.sales, keyOrder: ['profile', 'read_access', 'value_max', 'discount_max', 'order_value_daily_max', 'quote_daily_max', 'send_daily_max', 'order_daily_max', 'setup_daily_max'], ctxOrder: ['currency'], ctx: { currency: 'EUR' } };
const CUSTOMERS = { id: PROFILE_V07.customers, keyOrder: ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'], ctxOrder: ['contact_type'], ctx: { contact_type: 'customer' } };
const EMAIL = {
  // v0.7: read_daily_max is gone (replaced by read_access; never enforced, CONFORMANCE.md).
  id: PROFILE_V07.email, keyOrder: ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'],
  ctxOrder: ['allowed_recipients', 'allowed_domains'], ctx: { allowed_recipients: 'einkauf@huber.example,office@steiner.example', allowed_domains: 'huber.example,steiner.example' },
};

const SPECS: Record<string, MandateSpec> = {
  'sales:setup': { ...SALES, bounds: { read_access: 'none', value_max: 0, discount_max: 0, order_value_daily_max: 0, quote_daily_max: 0, send_daily_max: 0, order_daily_max: 0, setup_daily_max: 5 } },
  'sales:work': { ...SALES, bounds: { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10, setup_daily_max: 0 } },
  'customers:setup': { ...CUSTOMERS, bounds: { read_access: 'none', export_access: 'none', write_daily_max: 0, delete_daily_max: 0, setup_daily_max: 1 } },
  'customers:work': { ...CUSTOMERS, bounds: { read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 } },
  'email:setup': { ...EMAIL, bounds: { read_access: 'none', recipient_max: 0, send_daily_max: 0, read_max_age_days: 0, setup_daily_max: 1 } },
  'email:work': { ...EMAIL, bounds: { read_access: 'unlimited', recipient_max: 1, send_daily_max: 10, read_max_age_days: 3650, setup_daily_max: 0 } },
  'records:old': { id: RECORDS_PROFILE_ID, keyOrder: ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'], ctxOrder: [], ctx: {}, bounds: { read_access: 'unlimited', write_daily_max: 20, delete_access: 'allowed', archive_access: 'allowed' } },
  'delegation': { id: DELEGATION, keyOrder: ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max'], ctxOrder: [], ctx: {}, bounds: { read_access: 'unlimited', brief_daily_max: 0, mandate_daily_max: 5 } },
  'reporting:0.1': { id: REPORTING_OLD, keyOrder: ['profile', 'read_access', 'report_daily_max'], ctxOrder: [], ctx: {}, bounds: { read_access: 'unlimited', report_daily_max: 5 } },
  'reporting': { id: REPORTING, keyOrder: ['profile', 'read_access', 'read_max_age_days', 'report_daily_max'], ctxOrder: [], ctx: {}, bounds: { read_access: 'unlimited', read_max_age_days: WINDOW_DAYS, report_daily_max: 5 } },
};
SPECS['records:recent'] = SPECS['records:old'];

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-report-'));
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-report-files-'));
const secret = newSecret();
/** Gateway processes draw timestamps in their local zone — pinned to a zone with a
 *  non-zero, DST-free offset (UTC+5:30), so the numeric offset label is exercised
 *  and this test can format every timestamp independently. */
const GW_ZONE = 'Asia/Kolkata';
const GW_OFFSET_MIN = 330;
const GW_TZ = { TZ: GW_ZONE };
const simStack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret, asUrl: AS_URL,
  extraEnv: { SUVEREN_SIMULATION: '1', SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1', ...GW_TZ },
};
const liveStack = (extra: Record<string, string> = {}): StackOptions => ({
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret, asUrl: AS_URL,
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1', ...GW_TZ, ...extra },
});
const cp = new ControlPlaneClient(CP_URL);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, secret);

let clock: ShiftedClock;
let browser: Browser;
let user: { apiKey: string; user: { id: string; did: string } };
let groupId: string;
let agent: Client;

interface Held { id: string; blob: string; bounds: Record<string, string | number>; boundsHash: string; contextHash: string; intent: string; profile: string; mode: string }
const mandates: Record<string, Held> = {};

/** Every text a report__* tool returned — grepped for internal values in step 4 and again at the end. */
const reportToolOutputs: Array<{ tool: string; text: string }> = [];

// ─── helpers ────────────────────────────────────────────────────────────────

async function grant(name: string, mode: 'automatic' | 'review' = 'automatic'): Promise<Held> {
  const s = SPECS[name];
  const bounds = { profile: s.id, ...s.bounds };
  const boundsHash = computeBoundsHash(bounds, s.keyOrder);
  const contextHash = computeScopeHash(s.ctx, s.ctxOrder);
  const gate = { intent: intentOf(name) };
  const profileHash = s.id === REPORTING_OLD
    ? computeProfileHash({ ...REPORTING_OLD_DOC, id: REPORTING_OLD })
    : profileHashFor(s.id, PROFILES_DIR);
  const att = await sp.submitMandate(user.apiKey, {
    profile_id: s.id, profile_hash: profileHash, group_id: groupId, bounds, bounds_hash: boundsHash, scope_hash: contextHash,
    domain: 'owner', did: user.user.did, commitment_mode: mode,
    gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ name }),
  });
  await mcpInternal.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: s.ctx }, s.id, gate);
  mandates[name] = { id: att.authorization_id, blob: att.blob, bounds, boundsHash, contextHash, intent: gate.intent, profile: s.id, mode };
  return mandates[name];
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
    if (tool.startsWith('report__')) reportToolOutputs.push({ tool, text });
    return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
  } catch (err) {
    return { denied: true, text: String(err), json: null as any };
  }
}

type AsTicket = Record<string, any> & { id: string; action: string; timestamp: number; authorizationId: string; signature: string };

/** The caller's tickets as the Authority Server itself lists them — the source of truth. */
async function asTickets(): Promise<AsTicket[]> {
  const { tickets: receipts } = await sp.getMyTicketsPage(user.apiKey, { limit: 200 });
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
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const ms = Date.parse(iso);
  expect(Number.isFinite(ms), `unparseable timestamp ${v}`).toBe(true);
  return Math.floor(ms / 1000);
}

/** A timestamp as a verified box must show it: wall clock in the gateway's zone plus its
 *  numeric offset — "2026-10-06 15:09:34 UTC+5:30". Computed here without the gateway's code. */
function fmtTs(v: number | string): string {
  const s = typeof v === 'number' ? v : seconds(v);
  const iso = new Date((s + GW_OFFSET_MIN * 60) * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC+5:30`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/** Raw computed number as the gateway prints it: integers as is, else ≤ 4 decimals. */
function raw(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000);
}

/** Poll until `fn` holds (UI state settles asynchronously). */
async function eventually(fn: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function cpGet(path: string): Promise<Response> {
  return fetch(`${CP_URL}${path}`, { headers: { 'X-API-Key': user.apiKey } });
}

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['SUVEREN_AS_URL', 'SUVEREN_DATA_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'HAP_E2E_CLOCK_FILE']) delete env[k];
  return spawnSync(process.execPath, [CLI, 'verify-report', ...args], { env, encoding: 'utf-8', timeout: 60_000 });
}

/** The proof bundle embedded in an exported file. */
function bundleOf(html: string): any {
  const m = /<script[^>]*id="suveren-proof"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  expect(m, 'the export embeds its proof bundle').toBeTruthy();
  return JSON.parse(m![1]);
}

async function startSimulationGateway() {
  await startControlPlane(pm, simStack, 'cp');
  await startMcpServer(pm, simStack, 'mcp');
  const login = await cp.login(user.apiKey);
  expect(login.status, JSON.stringify(login.body)).toBe(200);
}

async function stopGateway(cpName: string, mcpName: string) {
  if (agent) { try { await agent.close(); } catch { /* ignore */ } }
  await pm.stopProcess(mcpName, { confirmDownUrl: `http://localhost:${MCP_PORT}/health` });
  await pm.stopProcess(cpName, { confirmDownUrl: `http://localhost:${CP_PORT}/health` });
}

// The UI's frame document (ReportsPage.tsx#buildSrcDoc) — used only to lay out
// the gateway's render in Chromium for the box checks of step 7; step 9 runs the
// same checks on the srcdoc the real UI put in its frame.
function frameDoc(rendered: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">`;
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{margin:12px;background:#fff}</style></head><body>${rendered}</body></html>`;
}

interface DrawnKv { key: string | null; value: string; formula: string | null; group: string | null; step: string | null }
interface DrawnBox {
  id: string; cls: string; seal: string | null; sealSource: string | null; kvs: DrawnKv[];
  links: Array<{ href: string | null; text: string; target: string }>; reason: string | null; notes: string[];
  stepTags: string[]; stray: string[]; text: string; rubies: Array<{ base: string; rt: string }>;
}

/** Every gateway-drawn box on the page, decomposed into what the gateway may put in it. */
async function drawnBoxes(page: Page): Promise<DrawnBox[]> {
  return page.evaluate(() => {
    const ALLOWED = '.sv-k, .sv-v, .sv-f, .sv-badge, .sv-link, .sv-step-tag, .sv-group-label, .sv-reason, .sv-note, rt';
    const textNoRt = (el: Element | null) => {
      if (!el) return '';
      const c = el.cloneNode(true) as Element;
      c.querySelectorAll('rt').forEach((r) => r.remove());
      return c.textContent ?? '';
    };
    return [...document.querySelectorAll<HTMLElement>('[data-sv-id]')].map((box) => {
      const seal = box.querySelector<HTMLElement>('.sv-badge');
      const kvs = [...box.querySelectorAll('.sv-kv')].map((kv) => {
        const k = kv.querySelector(':scope > .sv-k, :scope > ruby > .sv-k');
        const vs = [...kv.querySelectorAll(':scope > .sv-v, :scope > ruby > .sv-v')];
        const f = kv.querySelector(':scope > .sv-f');
        const groupLabel = kv.closest('.sv-group')?.querySelector('.sv-group-label');
        const step = kv.closest('.sv-step')?.querySelector('.sv-step-tag');
        return {
          key: k ? textNoRt(k) : null,
          value: vs.map((v) => textNoRt(v)).join(''),
          formula: f ? f.textContent : null,
          group: groupLabel ? textNoRt(groupLabel) : null,
          step: step ? step.textContent : null,
        };
      });
      const stray: string[] = [];
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode as Text;
        if (!(t.textContent ?? '').trim()) continue;
        if (!t.parentElement?.closest(ALLOWED)) stray.push(t.textContent ?? '');
      }
      return {
        id: box.dataset.svId ?? '',
        cls: box.className,
        seal: seal ? seal.textContent : null,
        sealSource: seal?.dataset.svSource ?? null,
        kvs,
        links: [...box.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent ?? '', target: a.target })),
        reason: box.querySelector('.sv-reason')?.textContent ?? null,
        notes: [...box.querySelectorAll('.sv-note')].map((n) => n.textContent ?? ''),
        stepTags: [...box.querySelectorAll('.sv-step-tag')].map((s) => s.textContent ?? ''),
        stray,
        text: box.textContent ?? '',
        rubies: [...box.querySelectorAll('ruby.sv-gloss')].map((r) => ({ base: textNoRt(r), rt: r.querySelector('rt')?.textContent ?? '' })),
      };
    });
  });
}

/** For every verified box: is the element at its centre and inner corners inside that box?
 *  Its border as the gateway drew it? Every AI frame label uncovered? */
async function layoutFacts(page: Page) {
  return page.evaluate(() => {
    const inside = (box: Element, x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return !!el && box.contains(el);
    };
    const boxes = [...document.querySelectorAll<HTMLElement>('[data-sv-id]')].map((box) => {
      box.scrollIntoView({ block: 'center' });
      const r = box.getBoundingClientRect();
      const pts: Array<[number, number]> = [
        [r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)],
        [r.left + 4, r.top + 4], [r.right - 4, r.top + 4],
      ];
      const cs = getComputedStyle(box);
      return {
        id: box.dataset.svId, hits: pts.map(([x, y]) => inside(box, x, y)),
        border: `${cs.borderTopStyle} ${cs.borderTopColor} ${cs.borderTopWidth}`,
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      };
    });
    const labels = [...document.querySelectorAll<HTMLElement>('.sv-ai-label')].map((l) => {
      l.scrollIntoView({ block: 'center' });
      const r = l.getBoundingClientRect();
      return inside(l, r.left + r.width / 2, r.top + r.height / 2);
    });
    const overlay = document.getElementById('ai-overlay');
    const frame = overlay?.closest('.sv-ai-block')?.getBoundingClientRect();
    const or = overlay?.getBoundingClientRect();
    return {
      boxes, labels,
      overlayFound: !!overlay,
      // The overlay asks for 5000×5000 px fixed at the viewport; the frame clips it.
      overlayClipped: !!frame && !!or && or.width > frame.width && (
        document.elementFromPoint(frame.left + frame.width / 2, frame.bottom + 30) === null ||
        !overlay!.contains(document.elementFromPoint(frame.left + frame.width / 2, frame.bottom + 30))
      ),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

// ─── state carried between the steps ────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'simulation-package.example.json'), 'utf8'));
const start: Record<string, { id: string; from: string }> = {};
const t: Record<string, AsTicket> = {}; // named work tickets
let tOld: AsTicket;
let tRecent: AsTicket;
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
let loadedAt: number;
const loadTickets: AsTicket[] = [];

const BOGUS_REF = `tkt_does_not_exist_${randomBytes(4).toString('hex')}`;
const NAME_UNDISCLOSED_OWNER = 'Owner (name not disclosed)';
const NAME_UNDISCLOSED_APPROVER = 'a person (name not disclosed)';
/** Every verified box's frame — the only text in it that is not a source value. */
const SEALS: Record<string, string> = {
  'sv-ticket': '✓ verified · signed', 'sv-mandate': '✓ verified · signed', 'sv-approval': '✓ verified · archive',
  'sv-record': '✓ verified · database', 'sv-case': '✓ verified · computed', 'sv-metric': '✓ verified · computed',
};
const CHECK_LINK_TEXT = 'Check on suveren.ai ↗';
/** Field name + formula per metric (documented in the brief / render-report.ts). */
const METRICS: Record<string, { name: string; formula: string }> = {
  completed: { name: 'cases_completed', formula: '= count(case.goal verified)' },
  'median-time': { name: 'median_duration_s', formula: '= median(case.duration_s)' },
  'average-time': { name: 'average_duration_s', formula: '= mean(case.duration_s)' },
  'without-approval': { name: 'without_approval_ratio', formula: '= count(case.approvals = 0) / count(case)' },
  approvals: { name: 'approvals', formula: '= count(case.approval)' },
  'median-approval-wait': { name: 'median_approval_wait_s', formula: '= median(approval.decidedAt − approval.createdAt)' },
  tickets: { name: 'tickets', formula: '= count(distinct case.goal, case.steps)' },
  refusals: { name: 'refusals', formula: '= count(refusal.at in [case.start, case.goal])' },
};
const DURATION_FORMULA = '= goal.timestamp − max(start.received_at, simulation_load.loaded_at)';
const WAIT_FORMULA = '= decidedAt − createdAt';
/** Human wording that must never appear inside a verified box (the 0.18.x labels, connecting words). */
const TRANSLATED_WORDS = [
  'Quote created', 'Quote sent', 'Reply sent', 'Activity logged', 'Report written', 'Max value', 'Email in',
  'waited', 'within', ' net ', 'Approved by', 'Mandate:', 'cases completed', 'median time',
];
/** Glossary the AI sends: four valid words, then everything the gateway must refuse. */
const GLOSS_OK: Record<string, string> = {
  erp__create_quote: 'Angebot erstellt',
  value_max: 'Höchstwert pro Angebot',
  automatic: 'automatisch',
  action: 'Aktion',
};

describe.skipIf(!available)('RR7: regular reporting (real AS + gateway + records connector + email/CRM/ERP simulators)', () => {
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
    // A real browser is part of this suite (layout + UI). Fails loudly without one.
    // A person's browser: Playwright's default announces automation (navigator.webdriver),
    // which the gateway refuses at sign-in and approval (defense in depth, by design).
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });

    // The AS serves the local hap-profiles and starts on a clock three days back.
    clock = shiftedClock(-OLD_AGE_SECONDS);
    const profiles = localProfilesForAs(PROFILES_DIR);
    await pm.startSP(AS_PORT, { cwd: profiles.cwd, env: { ...profiles.env, ...clock.env } });
    user = await sp.register('Report E2E', `report-e2e-${Date.now()}@test.local`);
    groupId = await sp.getPersonalGroupId(user.apiKey);
    asPublicKey = ((await (await fetch(`${AS_URL}/api/as/pubkey`)).json()) as { publicKey: string }).publicKey;
    expect(asPublicKey).toMatch(/^[0-9a-f]{64}$/);

    // The "reporting mandate with no window bound" fixture (see the const's
    // own comment) -- author it on the AS and point SPECS['reporting:0.1']
    // at the id the community-profile store actually assigned.
    // Must end "/reporting@<version>" -- the gateway's report builtin
    // recognizes the reporting authority by profileMatches(id, 'reporting')
    // (tool-proxy.ts), which checks the id's last path segment, not a
    // registry lookup. The version must sort BELOW the real reporting
    // profile's newest (0.3) -- the gateway's own "which version is
    // current" picker compares the number after '@', and a fixture that
    // outranked the real one would shadow it for setup__create_mandate too.
    const createdOld = await sp.createProfile(user.apiKey, reportingOldFixtureDoc('reporting@0.0'));
    REPORTING_OLD = createdOld.profile_id;
    REPORTING_OLD_DOC = reportingOldFixtureDoc(REPORTING_OLD);
    SPECS['reporting:0.1'].id = REPORTING_OLD;

    // ── 0. real, non-simulation work in this gateway's archive ──
    // Three days ago: the gateway on the same shifted clock, NOT in simulation mode.
    await startControlPlane(pm, liveStack(clock.env), 'cp-live-old');
    await startMcpServer(pm, liveStack(clock.env), 'mcp-live-old');
    expect((await cp.login(user.apiKey)).status).toBe(200);
    await mcpInternal.addIntegration(RECORDS_INTEGRATION as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration('records');
    await grant('records:old');
    await reconnect();
    tOld = (await ticketed('records__create_record', { type: 'note', title: `family calendar ${RUN}`, content: 'private — must never reach a report' })).ticket;
    // The AS signed it three days back.
    expect(Math.floor(Date.now() / 1000) - tOld.timestamp).toBeGreaterThan(OLD_AGE_SECONDS - 600);

    // Today: real clock, same gateway, a fresh real ticket.
    await clock.set(0);
    await grant('records:recent');
    await reconnect();
    tRecent = (await ticketed('records__create_record', { type: 'note', title: `fresh real work ${RUN}`, content: 'real work, before the test' })).ticket;
    expect(Math.floor(Date.now() / 1000) - tRecent.timestamp).toBeLessThan(600);
    await stopGateway('cp-live-old', 'mcp-live-old');

    // ── the test itself: the same gateway (same data dir, same archive) in simulation mode ──
    await startSimulationGateway();
    for (const c of SYSTEMS) {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, `${c}.json`), 'utf8'));
      await mcpInternal.addIntegration({
        id: c, name: m.name, command: m.mcp.command, args: m.mcp.args, envKeys: {},
        profile: m.profile, enabled: true, toolGating: m.toolGating, npmPackage: m.npmPackage,
      } as Parameters<GatewayClient['addIntegration']>[0]);
    }
    for (const c of SYSTEMS) await mcpInternal.waitForIntegration(c);
  }, 480_000);

  afterAll(async () => {
    if (agent) { try { await agent.close(); } catch { /* ignore */ } }
    if (browser) await browser.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  // ── 1. setup ──────────────────────────────────────────────────────────────

  it('1. a three-case simulation package loads into email, CRM and ERP (simulation mode)', async () => {
    expect(pkg.cases.length).toBeGreaterThanOrEqual(3);
    for (const k of ['sales', 'customers', 'email']) await grant(`${k}:setup`);
    await reconnect();
    const hashes: string[] = [];
    for (const c of SYSTEMS) {
      // The test period starts at the email load; a pause puts the ERP/CRM load
      // tickets measurably before it (they must not be in the reporting window).
      if (c === 'mail') await new Promise((r) => setTimeout(r, 1_100));
      const r = await ticketed(`${c}__load_simulation`, { package: pkg });
      hashes.push(r.json.package_sha256);
      loadTickets.push(r.ticket);
    }
    expect(new Set(hashes).size).toBe(1);
    for (const c of SYSTEMS) expect(exportOf(c).mode).toBe('simulation');
    const mail = exportOf('mail');
    expect(mail.inbox.map((m: any) => m.case_id)).toEqual(pkg.cases.map((c: any) => c.id));
    loadedAt = seconds(mail.simulation_load.loaded_at);
    // Not vacuous: ERP/CRM loads, tOld and tRecent are all before the test data existed.
    for (const x of [loadTickets[0], loadTickets[1], tOld, tRecent]) expect(x.timestamp).toBeLessThan(loadedAt);
  }, 120_000);

  // ── 2. work ───────────────────────────────────────────────────────────────

  it('2a. work mandates: sales + customers automatic, email in REVIEW', async () => {
    await grant('sales:work');
    await grant('customers:work');
    await grant('email:work', 'review');
    await reconnect();
    const inbox = await call('mail__list_messages', {});
    expect(inbox.denied).toBe(false);
    expect(inbox.json).toHaveLength(pkg.cases.length);
    const byCase = exportOf('mail').inbox as Array<{ id: string; case_id: string; from_email: string }>;
    for (const m of byCase) start[m.case_id] = { id: m.id, from: m.from_email };
    expect(inbox.json.map((m: any) => m.id).sort()).toEqual(byCase.map((m) => m.id).sort());
  }, 60_000);

  it('2b. case c1 (Huber, quote request): CRM note, ERP quote — each with its own AS ticket', async () => {
    const contact = await call('crm__find_contacts', { query: 'Huber' });
    expect(contact.denied).toBe(false);
    t.c1Note = (await ticketed('crm__log_activity', { contact_id: contact.json[0].id, type: 'note', summary: 'c1: quote request 10 x SP-100' })).ticket;
    const items = await call('erp__list_items', { query: 'SP-100' });
    const customers = await call('erp__find_customers', { query: 'Huber' });
    const item = items.json[0];
    const q = await ticketed('erp__create_quote', {
      customer_id: customers.json[0].id, lines: [{ item_id: item.id, qty: 10 }],
      discount_pct: 0, value: 10 * item.list_price, currency: 'EUR',
    });
    t.c1Quote = q.ticket;
    quote1Id = q.json.id;
    const activity = (exportOf('crm').activities as any[]).find((a) => a.receipt_id === t.c1Note.id);
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
    t.c2Send = (await ticketed('erp__send_quote', { id: q.json.id, value, discount_pct: 0, currency: 'EUR' })).ticket;
    expect(exportOf('mail').sent.every((m: any) => m.in_reply_to !== start.c3.id)).toBe(true);
  }, 60_000);

  // ── 3. the reporting mandate ──────────────────────────────────────────────

  it('3a. before any reporting mandate: report__* tools are not listed and refused', async () => {
    expect((await toolNames()).filter((n) => n.startsWith('report__'))).toEqual([]);
    expect((await call('report__list_tickets', {})).denied).toBe(true);
    expect((await call('report__write_report', { html: '<sv-ai><p>x</p></sv-ai>' })).denied).toBe(true);
  }, 30_000);

  it('3b. a 367-day window: the real AS refuses it (422 BOUNDS_INVALID_VALUE) and signs nothing', async () => {
    const mine = async () => ((await asApi('GET', '/api/mandates/mine')).body.mandates as any[]);
    const before = await mine();
    const s = SPECS.reporting;
    const bounds = { profile: s.id, ...s.bounds, read_max_age_days: 367 };
    const authorizationId = `authz_${randomUUID()}`;
    const r = await sp.submitMandateRaw(user.apiKey, {
      authorization_id: authorizationId, profile_id: s.id, profile_hash: profileHashFor(s.id, PROFILES_DIR), group_id: groupId, bounds,
      bounds_hash: computeBoundsHash(bounds, s.keyOrder), scope_hash: computeScopeHash({}, []),
      domain: 'owner', did: user.user.did, commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: 'too wide' }), execution_context_hash: hashExecutionContext({ m: 367 }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const err = (r.body.errors as Array<Record<string, unknown>>)[0];
    expect(err).toMatchObject({ code: 'BOUNDS_INVALID_VALUE', field: 'read_max_age_days', maximum: 366 });
    expect(r.body).not.toHaveProperty('blob');
    expect(r.body).not.toHaveProperty('mandate_id');
    const after = await mine();
    expect(after.map((a) => a.authorization_id).sort()).toEqual(before.map((a) => a.authorization_id).sort());
    expect(after.some((a) => a.authorization_id === authorizationId)).toBe(false);
    const status = await asApi('GET', `/api/mandates?authorization_id=${authorizationId}`);
    expect(status.body.blob ?? status.body.mandates?.[0]?.blob).toBeUndefined();
  }, 30_000);

  it('3c. a 367-day window: the create_mandate ceremony refuses it at the call — no proposal; 366 becomes one (rejected)', async () => {
    await grant('delegation', 'review');
    await reconnect();
    expect(await toolNames()).toContain('setup__create_mandate');
    const pending = async () => (((await asApi('GET', '/api/proposals?domain=owner')).body.proposals ?? []) as any[]).filter((p) => p.status === 'pending');
    expect(await pending()).toHaveLength(0);
    const limits = { read_access: 'unlimited', read_max_age_days: 367, report_daily_max: 5 };
    const r = await call('setup__create_mandate', { profile: 'reporting', limits, scope: {}, intent: 'Why — a year and a day.', mode: 'automatic' });
    expect(r.denied, r.text).toBe(true);
    expect(r.text).toMatch(/read_max_age_days" may be at most 366/);
    expect(await pending()).toHaveLength(0);

    // The boundary itself is accepted — the refusal is about the maximum, nothing else.
    const ok = await call('setup__create_mandate', { profile: 'reporting', limits: { ...limits, read_max_age_days: 366 }, scope: {}, intent: 'Why — the maximum.', mode: 'automatic' });
    expect(ok.denied, ok.text).toBe(false);
    expect(ok.text).toMatch(/Awaiting commitment/);
    const [p] = await pending();
    expect(p).toMatchObject({ tool: 'setup__create_mandate' });
    expect((await asApi('POST', `/api/proposals/${p.id}/resolve`, { action: 'reject', domain: 'owner' })).status).toBeLessThan(300);
    expect(await pending()).toHaveLength(0);
  }, 60_000);

  it('3d. a reporting mandate whose profile declares no window bound: every report tool refuses it, and a refused write consumes no ticket', async () => {
    await grant('reporting:0.1');
    await reconnect();
    const tools = ['report__get_records', 'report__get_ticket', 'report__list_cases', 'report__list_tickets', 'report__write_report'];
    expect((await toolNames()).filter((n) => n.startsWith('report__')).sort()).toEqual(tools);
    const before = (await asTickets()).length;
    const args: Record<string, Record<string, unknown>> = {
      report__get_records: { system: 'erp' }, report__get_ticket: { id: t.c1Quote.id }, report__list_cases: {},
      report__list_tickets: {}, report__write_report: { html: '<sv-ai><p>old mandate</p></sv-ai>' },
    };
    for (const tool of tools) {
      const r = await call(tool, args[tool]);
      expect(r.denied, `${tool}: ${r.text}`).toBe(true);
      // v0.7: the refusal no longer names a hardcoded version (see window.ts).
      expect(r.text, tool).toMatch(/older profile version — create a new reporting mandate/);
      expect(r.text, tool).not.toMatch(/@\d+\.\d+/);
      expect(r.text, tool).not.toContain(t.c1Quote.action);
    }
    expect((await asTickets()).length).toBe(before);
  }, 60_000);

  it('3e. reporting with a one-day window: issued by the real AS with read_max_age_days, and the tools use it', async () => {
    const m = await grant('reporting');
    const summary = await sp.getAuthorizationSummary(user.apiKey, m.id);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ profile_id: REPORTING, commitment_mode: 'automatic', bounds_hash: m.boundsHash });
    const mine = ((await asApi('GET', '/api/mandates/mine')).body.mandates as any[]).find((a) => a.authorization_id === m.id);
    expect(mine.bounds).toMatchObject({ read_max_age_days: WINDOW_DAYS });
    await reconnect();
    const listed = await call('report__list_tickets', {});
    expect(listed.denied, listed.text).toBe(false);
    // In simulation mode the one-day window starts no earlier than the test data.
    expect(listed.json.window.start).toBe(loadedAt);
    expect(listed.json.window.since).toMatch(/when the test data was loaded/);
  }, 60_000);

  // ── 4. read tools: window + read scope ────────────────────────────────────

  it('4a. list_tickets / get_ticket see only the window: the old and the fresh real ticket are invisible', async () => {
    const all = await asTickets();
    const listed = await call('report__list_tickets', {});
    const listedIds = (listed.json.tickets as any[]).map((x) => x.id);
    const now = Math.floor(Date.now() / 1000);
    const expected = all.filter((x) => x.timestamp >= loadedAt && x.timestamp <= now + 120).map((x) => x.id);
    expect([...listedIds].sort()).toEqual([...expected].sort());
    for (const hidden of [tOld, tRecent, loadTickets[0], loadTickets[1]]) expect(listedIds).not.toContain(hidden.id);
    expect(listed.text).not.toContain(tOld.id);
    expect(listed.text).not.toContain(tRecent.id);
    for (const k of Object.keys(t)) {
      const row = (listed.json.tickets as any[]).find((x) => x.id === t[k].id);
      expect(row).toMatchObject({ action: t[k].action, time: t[k].timestamp, profile: t[k].profileId, hasApproval: k === 'c1Reply' });
    }

    for (const hidden of [tOld, tRecent]) {
      const r = await call('report__get_ticket', { id: hidden.id });
      expect(r.denied).toBe(true);
      expect(r.text).toContain('not verifiable — outside the reporting window');
      expect(r.text).not.toContain(mandates['records:old'].intent);
      expect(r.text).not.toContain(mandates['records:recent'].intent);
      expect(r.text).not.toContain(hidden.action);
    }
  }, 60_000);

  it('4b. get_ticket: the working-agent view of own mandates (intent, limits) + approval facts, equal to the sources', async () => {
    const named: Record<string, string> = { c1Note: 'customers:work', c1Quote: 'sales:work', c1Reply: 'email:work', c2Note: 'customers:work', c2Quote: 'sales:work', c2Send: 'sales:work' };
    for (const k of Object.keys(t)) {
      const r = await call('report__get_ticket', { id: t[k].id });
      expect(r.denied, r.text).toBe(false);
      const m = mandates[named[k]];
      expect(r.json.ticket).toMatchObject({ ticketId: t[k].id, action: t[k].action, time: t[k].timestamp, profile: t[k].profileId, checkUrl: `${AS_URL}/r/${t[k].id}` });
      expect(r.json.mandate).toMatchObject({ verified: true, profile: m.profile, mode: m.mode, intent: m.intent, rawLimits: m.bounds, owners: [NAME_UNDISCLOSED_OWNER] });
      if (k === 'c1Reply') {
        const decided = Object.values(replyProposal.committedBy) as Array<{ at: number }>;
        const decidedAt = Math.max(...decided.map((d) => d.at));
        expect(r.json.approval).toMatchObject({
          verified: true, approved: true, approvedBy: NAME_UNDISCLOSED_APPROVER,
          askedAt: replyProposal.createdAt, decidedAt, waitSeconds: decidedAt - replyProposal.createdAt,
        });
      } else {
        expect(r.json.approval.verified).toBe(false);
      }
    }
  }, 60_000);

  it('4c. list_cases / get_records: the loaded cases and records, never the reference replies', async () => {
    const cases = await call('report__list_cases', {});
    expect(cases.denied).toBe(false);
    expect(cases.json.cases.map((c: any) => [c.caseId, c.startMessageId])).toEqual(['c1', 'c2', 'c3'].map((c) => [c, start[c].id]));
    expect(cases.json.sent).toEqual([expect.objectContaining({ id: replySentId, inReplyTo: start.c1.id, receiptId: t.c1Reply.id })]);
    expect(cases.text).not.toContain(pkg.cases[0].reply.body.slice(0, 40));
    const erp = await call('report__get_records', { system: 'erp', kind: 'quotes' });
    expect((erp.json.records.quotes as any[]).map((q) => q.id).sort()).toEqual([quote1Id, quote2Id].sort());
    const crm = await call('report__get_records', { system: 'crm', kind: 'activities' });
    expect((crm.json.records.activities as any[]).some((a) => a.id === activity1Id)).toBe(true);
    const email = await call('report__get_records', { system: 'email' });
    expect(email.json.records.sent.map((m: any) => m.id)).toEqual([replySentId]);
    expect(Object.keys(email.json.records)).not.toContain('reference_replies');
    for (const sys of ['erp', 'crm'] as const) await call('report__get_records', { system: sys });
  }, 60_000);

  it('4d. read scope: no report tool output contains a user / group / mandate id, an owner DID, a signature or an attestation blob', async () => {
    const all = await asTickets();
    const secrets: Array<[string, string]> = [
      ['userId', user.user.id], ['groupId', groupId], ['owner DID', user.user.did], ['API key', user.apiKey],
      ['proposalId', replyProposal.id],
      ...Object.entries(mandates).flatMap(([n, m]): Array<[string, string]> => [
        [`authorizationId ${n}`, m.id], [`attestation blob ${n}`, m.blob], [`boundsHash ${n}`, m.boundsHash],
      ]),
      ...all.map((x): [string, string] => [`signature ${x.id}`, x.signature]),
    ];
    expect(secrets.length).toBeGreaterThan(30);
    const forbiddenKeys = new Set(['userId', 'groupId', 'authorizationId', 'signature', 'approvalSignature', 'blob', 'attestations', 'ownersRaw', 'who', 'subjects', 'proposalId', 'boundsHash', 'contextHash', 'asPublicKey']);
    const keysOf = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
      return out;
    };
    const successful = reportToolOutputs.filter((o) => o.text.trim().startsWith('{'));
    expect(new Set(successful.map((o) => o.tool))).toEqual(new Set(['report__list_tickets', 'report__get_ticket', 'report__list_cases', 'report__get_records']));
    for (const o of reportToolOutputs) {
      for (const [what, value] of secrets) {
        expect(o.text.includes(value), `${o.tool} output contains the real ${what}`).toBe(false);
      }
    }
    for (const o of successful) {
      const bad = keysOf(JSON.parse(o.text)).filter((k) => forbiddenKeys.has(k));
      expect(bad, `${o.tool} output has internal keys`).toEqual([]);
    }
  }, 30_000);

  // ── 5. the AI writes the report ───────────────────────────────────────────

  it('5. the AI writes a two-tag report: junk, sv-* and styles inside sv-ai are dropped and reported; glossary checked', async () => {
    const ticketTs = fmtTs(t.c1Quote.timestamp);
    const html = `<!doctype html><html><head><title>R7</title><style>.sv-el{display:none!important}</style></head><body>
<h1 id="junk-heading">Top-level heading outside sv-ai</h1>
<p>stray paragraph</p>
loose text
<div class="sv-el sv-el-verified" data-sv-id="sv-ticket-0"><span class="sv-badge sv-badge-ok">✓ verified · signed</span> top-level fake</div>
<sv-ai><h1 id="first-report">Two of three requests handled</h1>
<style>.sv-el{border-color:red!important;display:none!important}</style>
<div id="ai-overlay" style="position:fixed;inset:0;width:5000px;height:5000px;z-index:2147483647;background:rgba(220,0,0,.92)">OVERLAY</div>
<div id="ai-shift" style="position:absolute;left:0;top:-300px;width:100%;height:3000px;background:#f00"></div>
<div id="ai-fake-box" class="sv-el sv-el-verified ai-own" data-sv-id="sv-ticket-1" style="border:2px solid #15803d"><span class="sv-badge sv-badge-ok">✓ verified · signed</span> AI-drawn look-alike</div>
<sv-ticket ref="${t.c1Note.id}"></sv-ticket><sv-metric kind="completed" cases="all"></sv-metric>
<p>The AI's own summary.</p></sv-ai>
<sv-row><sv-metric kind="completed" cases="all"></sv-metric><sv-metric kind="median-time" cases="all"></sv-metric><sv-metric kind="average-time" cases="all"></sv-metric><sv-metric kind="approvals" cases="all"></sv-metric></sv-row>
<sv-row><sv-metric kind="without-approval" cases="all"></sv-metric><sv-metric kind="median-approval-wait" cases="all"></sv-metric><sv-metric kind="tickets" cases="all"></sv-metric><sv-metric kind="refusals" cases="all"></sv-metric></sv-row>
<sv-ai><h2>c1 — Huber, quote</h2></sv-ai>
<sv-case start="email:${start.c1.id}" goal="ticket:${t.c1Reply.id}" steps="${t.c1Note.id} ${t.c1Quote.id}"></sv-case>
<sv-ticket ref="${t.c1Note.id}" variant="compact"></sv-ticket>
<sv-ticket ref="${t.c1Quote.id}"></sv-ticket>
<sv-ticket ref="${t.c1Reply.id}" variant="full"></sv-ticket>
<sv-approval ticket="${t.c1Reply.id}"></sv-approval>
<sv-mandate ticket="${t.c1Quote.id}"></sv-mandate>
<sv-row><sv-record system="erp" ref="${quote1Id}"></sv-record><sv-record system="crm" ref="${activity1Id}"></sv-record><sv-record system="email" ref="${replySentId}"></sv-record></sv-row>
<sv-ai><h2>c2 — Steiner, order</h2></sv-ai>
<sv-case start="email:${start.c2.id}" goal="ticket:${t.c2Send.id}" steps="${t.c2Note.id} ${t.c2Quote.id}"></sv-case>
<sv-ticket ref="${t.c2Note.id}" variant="compact"></sv-ticket>
<sv-ticket ref="${t.c2Quote.id}" variant="compact"></sv-ticket>
<sv-ticket ref="${t.c2Send.id}" variant="full"></sv-ticket>
<sv-ai><p>References the AI got wrong — and old real work it should not see:</p></sv-ai>
<sv-ticket ref="${BOGUS_REF}"></sv-ticket>
<sv-ticket ref="${tOld.id}" variant="full"></sv-ticket>
<sv-mandate ticket="${tOld.id}"></sv-mandate>
<sv-ai><p>Assessment.</p></sv-ai>
<sv-glossary lang="de">
<sv-term key="erp__create_quote">${GLOSS_OK.erp__create_quote}</sv-term>
<sv-term key="value_max">${GLOSS_OK.value_max}</sv-term>
<sv-term key="automatic">${GLOSS_OK.automatic}</sv-term>
<sv-term key="action">${GLOSS_OK.action}</sv-term>
<sv-term key="1000">eintausend</sv-term>
<sv-term key="${ticketTs}">Zeitpunkt</sv-term>
<sv-term key="${t.c1Note.id}">Notiz</sv-term>
<sv-term key="no_such_field">nichts</sv-term>
<sv-term key="timestamp">✓ geprüft</sv-term>
<sv-term key="commitment_mode">${'x'.repeat(61)}</sv-term>
<sv-term key="action">Doppelt</sv-term>
</sv-glossary>
<sv-glossary lang="en"><sv-term key="action">second glossary</sv-term></sv-glossary>
</body></html>`;

    const before = new Set((await asTickets()).map((x) => x.id));
    const oldMandateUse = (await asTickets()).filter((x) => x.authorizationId === mandates['reporting:0.1'].id).length;
    expect(oldMandateUse, 'the refused reporting@0.1 mandate was never charged').toBe(0);
    const w = await call('report__write_report', { html });
    expect(w.denied, w.text).toBe(false);
    // 8 metrics + 2 cases + 8 tickets + 1 approval + 2 mandates + 3 records; not verifiable: the bogus ref, the old ticket (twice).
    expect(w.text).toMatch(/Report stored\. 21 element\(s\) verified, 0 warning\(s\), 3 not verifiable\./);
    expect(w.text).toContain(BOGUS_REF);
    expect(w.text).toContain(`Ticket "${tOld.id}": not verifiable — outside the reporting window`);
    expect(w.text).toContain('dropped: 4 block(s) outside sv-ai');
    expect(w.text).toContain('dropped: 2 sv-* element(s) inside sv-ai');
    expect(w.text).toContain('dropped: 2 <style> block(s)');
    expect(w.text).toContain('dropped: 1 extra sv-glossary');
    expect(w.text).toContain('Glossary: 4 term(s) shown as translation');
    const ignored = [...w.text.matchAll(/- ignored "([^"]*)": (.*)/g)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(ignored.map(([k, why]) => [k, why.split(' ')[0]]))).toEqual({
      'action': 'duplicate', 'timestamp': 'contains', 'commitment_mode': 'longer',
      '1000': 'not', [ticketTs]: 'not', [t.c1Note.id]: 'not', 'no_such_field': 'not',
    });
    expect(w.text).toMatch(/Missing cases \(not defined with sv-case\): c3/);
    expect(w.text).toMatch(/Reporting window: since .* \(when the test data was loaded\)/);
    expect(w.text).not.toContain(mandates['records:old'].intent);
    const fresh = (await asTickets()).filter((x) => !before.has(x.id));
    expect(fresh.map((x) => x.action)).toEqual(['report__write_report']);
    firstWriteTicket = fresh[0];
    // The write is authorized by the reporting@0.2 mandate — never by the old
    // reporting@0.1 one, which every report tool refuses (3d).
    expect(fresh[0].profileId, 'write_report ticketed under the refused reporting@0.1 mandate').toBe(REPORTING);
    expect(fresh[0].authorizationId).toBe(mandates.reporting.id);
    // reporting@0.1's report_daily_max usage is unchanged: still no ticket on it.
    expect((await asTickets()).filter((x) => x.authorizationId === mandates['reporting:0.1'].id)).toHaveLength(oldMandateUse);
  }, 90_000);

  // ── 6. the verified report vs the sources of truth ────────────────────────

  it('6. GET /api/report: every element against its source of truth; metrics and durations recomputed here', async () => {
    const res = await cpGet('/api/report');
    expect(res.status).toBe(200);
    report = ((await res.json()) as any).report;
    expect(report).toBeTruthy();
    firstSavedAt = report.savedAt;
    const els = report.elements as any[];
    const byKind = (k: string) => els.filter((e) => e.kind === k);
    // Non-metric elements in document order, then the metrics (computed over the cases, in a second pass).
    expect(els.map((e) => e.id)).toEqual([
      'sv-case-0', 'sv-ticket-0', 'sv-ticket-1', 'sv-ticket-2', 'sv-approval-0', 'sv-mandate-0',
      'sv-record-0', 'sv-record-1', 'sv-record-2', 'sv-case-1', 'sv-ticket-3', 'sv-ticket-4', 'sv-ticket-5',
      'sv-ticket-6', 'sv-ticket-7', 'sv-mandate-1',
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `sv-metric-${i}`),
    ]);
    expect(els).toHaveLength(24);

    const notVerified = els.filter((e) => e.status !== 'verified');
    expect(notVerified.map((e) => [e.kind, e.attrs.ref ?? e.attrs.ticket])).toEqual([
      ['sv-ticket', BOGUS_REF], ['sv-ticket', tOld.id], ['sv-mandate', tOld.id],
    ]);
    for (const e of notVerified) expect(e.data).toBeUndefined();
    expect(notVerified[1].reason).toContain('not verifiable — outside the reporting window');
    expect(notVerified[2].reason).toContain('not verifiable — outside the reporting window');

    const all = await asTickets();
    const asById = new Map(all.map((x) => [x.id, x]));

    for (const el of byKind('sv-ticket').filter((e) => e.status === 'verified')) {
      const src = asById.get(el.attrs.ref)!;
      expect(el.data).toMatchObject({ ticketId: src.id, action: src.action, time: src.timestamp, profile: src.profileId, checkUrl: `${AS_URL}/r/${src.id}` });
    }
    const decided = Object.values(replyProposal.committedBy) as Array<{ userId: string; at: number }>;
    const decidedAt = Math.max(...decided.map((d) => d.at));
    expect(byKind('sv-approval')[0].data).toMatchObject({
      ticketId: t.c1Reply.id, createdAt: replyProposal.createdAt, decidedAt, waitSeconds: decidedAt - replyProposal.createdAt,
    });
    const [mandateEl] = byKind('sv-mandate');
    expect(mandateEl.data).toMatchObject({ profile: SALES.id, mode: 'automatic', intent: mandates['sales:work'].intent, rawLimits: mandates['sales:work'].bounds });

    const erpX = exportOf('erp');
    const crmX = exportOf('crm');
    const mailX = exportOf('mail');
    const recs = Object.fromEntries(byKind('sv-record').map((e) => [e.attrs.system, e.data]));
    expect(recs.erp).toEqual({ kind: 'quote', ...(erpX.quotes as any[]).find((q) => q.id === quote1Id) });
    expect(recs.crm).toEqual({ kind: 'activity', ...(crmX.activities as any[]).find((a) => a.id === activity1Id) });
    expect(recs.email).toEqual({ kind: 'message', folder: 'sent', ...(mailX.sent as any[]).find((m) => m.id === replySentId) });

    // Effective case start = max(email received_at, simulation_load.loaded_at).
    expect(seconds(mailX.simulation_load.loaded_at)).toBe(loadedAt);
    const emailTime = (c: string) => seconds((mailX.inbox as any[]).find((m) => m.id === start[c].id).received_at);
    const startTime = (c: string) => Math.max(emailTime(c), loadedAt);
    const cases = Object.fromEntries(byKind('sv-case').map((e) => [e.data.caseId, e.data]));
    expect(Object.keys(cases).sort()).toEqual(['c1', 'c2']);
    const expectCase = (c: string, goal: AsTicket, steps: AsTicket[], approvals: number) => {
      expect(cases[c]).toMatchObject({
        start: { id: start[c].id, time: startTime(c), sender: start[c].from, emailTime: emailTime(c) },
        goal: { ticketId: goal.id, time: goal.timestamp, action: goal.action },
        steps: steps.map((s) => ({ ticketId: s.id, time: s.timestamp, action: s.action })),
        totalDurationSeconds: goal.timestamp - startTime(c),
      });
      expect(cases[c].approvals).toHaveLength(approvals);
      expect(cases[c].start.time).toBeGreaterThanOrEqual(loadedAt);
    };
    expectCase('c1', t.c1Reply, [t.c1Note, t.c1Quote], 1);
    expectCase('c2', t.c2Send, [t.c2Note, t.c2Quote], 0);
    // The package backdates its emails: the load time is what starts the cases (not vacuous).
    expect(emailTime('c1')).toBeLessThan(loadedAt);

    // sv-metric: recomputed here, with the documented formulas.
    const durations = [t.c1Reply.timestamp - startTime('c1'), t.c2Send.timestamp - startTime('c2')];
    const wait = decidedAt - replyProposal.createdAt;
    const refusalTimes = [erpX, crmX, mailX].flatMap((x) => (x.refusals as Array<{ at: string }>).map((r) => seconds(r.at)));
    const windows = [[startTime('c1'), t.c1Reply.timestamp], [startTime('c2'), t.c2Send.timestamp]];
    const expectedMetrics = {
      'completed': 2,
      'median-time': median(durations),
      'average-time': (durations[0] + durations[1]) / 2,
      'approvals': 1,
      'without-approval': 1 / 2,
      'tickets': new Set([t.c1Reply, t.c1Note, t.c1Quote, t.c2Send, t.c2Note, t.c2Quote].map((x) => x.id)).size,
      'median-approval-wait': wait,
      'refusals': windows.reduce((n, [a, b]) => n + refusalTimes.filter((x) => x >= a && x <= b).length, 0),
    };
    const metrics = Object.fromEntries(byKind('sv-metric').map((e) => [e.data.kind, e.data.value]));
    expect(metrics).toEqual(expectedMetrics);
    for (const el of byKind('sv-metric')) expect(el.data.caseCount).toBe(2);
    expect(wait).toBeGreaterThanOrEqual(1);

    // "Checked values": each verified element's headline fields, raw — the same values its box shows.
    const quote1 = (erpX.quotes as any[]).find((q) => q.id === quote1Id);
    const ticketLine = (x: AsTicket) => `action ${x.action} · timestamp ${fmtTs(x.timestamp)}`;
    const expectedLines: Record<string, string> = {
      'sv-case-0': `case_id c1 · duration_s ${durations[0]}`, 'sv-case-1': `case_id c2 · duration_s ${durations[1]}`,
      'sv-ticket-0': ticketLine(t.c1Note), 'sv-ticket-1': ticketLine(t.c1Quote), 'sv-ticket-2': ticketLine(t.c1Reply),
      'sv-ticket-3': ticketLine(t.c2Note), 'sv-ticket-4': ticketLine(t.c2Quote), 'sv-ticket-5': ticketLine(t.c2Send),
      'sv-approval-0': `committedBy ${NAME_UNDISCLOSED_APPROVER} · wait_s ${wait} = decidedAt − createdAt`,
      'sv-mandate-0': `profileId ${SALES.id} · commitment_mode automatic`,
      'sv-record-0': quote1.number ? `number ${quote1.number}` : `id ${quote1Id}`,
      'sv-record-1': `id ${activity1Id}`, 'sv-record-2': `id ${replySentId}`,
      ...Object.fromEntries(byKind('sv-metric').map((e) => [e.id, `${METRICS[e.data.kind].name} ${raw((expectedMetrics as Record<string, number>)[e.data.kind])}`])),
    };
    expect(Object.fromEntries((report.proof.verifiedValues as any[]).map((x) => [x.elementId, x.summary]))).toEqual(expectedLines);

    const realRefs = new Set([t.c1Note, t.c1Quote, t.c1Reply, t.c2Note, t.c2Quote, t.c2Send].map((x) => x.id));
    expect(report.proof.unverifiableCount).toBe(3);
    expect([...report.proof.ticketsReferenced].sort()).toEqual([...realRefs, BOGUS_REF, tOld.id].sort());
    expect(report.proof.signaturesValid).toBe(realRefs.size);
    expect(report.proof.recordsChecked).toBe(3);

    // Coverage: the period is the window (simulation: from the load); neither real ticket is in it.
    const cov = report.coverage;
    expect(cov.loadedCases).toEqual(['c1', 'c2', 'c3']);
    expect(cov.missingCases).toEqual(['c3']);
    expect(cov.periodStart).toBe(loadedAt);
    expect(cov.window).toMatchObject({ start: loadedAt, days: WINDOW_DAYS });
    const inPeriod = all.filter((x) => x.timestamp >= loadedAt).map((x) => x.id);
    expect([...cov.ticketsInPeriod].sort()).toEqual([...inPeriod].sort());
    expect(cov.ticketsInPeriod).not.toContain(tOld.id);
    expect(cov.ticketsInPeriod).not.toContain(tRecent.id);
    expect(cov.ticketsNotReferenced).toContain(firstWriteTicket.id);
  }, 60_000);

  // ── 7. drawn boxes: only signed fields + seal + link; glosses ─────────────

  it('7a. every verified box holds only signed field names and their values (+ seal, link) — equal to the sources', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(frameDoc(report.renderedHtml));
    const boxes = await drawnBoxes(page);
    await page.close();
    const els = new Map((report.elements as any[]).map((e) => [e.id, e]));
    expect(boxes.map((b) => b.id).sort()).toEqual([...els.keys()].sort());

    const mailX = exportOf('mail');
    const erpX = exportOf('erp');
    const crmX = exportOf('crm');
    const decided = Object.values(replyProposal.committedBy) as Array<{ at: number }>;
    const decidedAt = Math.max(...decided.map((d) => d.at));
    const asById = new Map((await asTickets()).map((x) => [x.id, x]));
    const mandateOf: Record<string, Held> = {
      [t.c1Note.id]: mandates['customers:work'], [t.c2Note.id]: mandates['customers:work'], [t.c1Reply.id]: mandates['email:work'],
      [t.c1Quote.id]: mandates['sales:work'], [t.c2Quote.id]: mandates['sales:work'], [t.c2Send.id]: mandates['sales:work'],
    };
    const v = (x: unknown) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x));
    const pair = (kv: DrawnKv) => `${kv.step ? `[${kv.step}] ` : ''}${kv.group ? `${kv.group}/` : ''}${kv.key}=${kv.value}${kv.formula ? ` ${kv.formula}` : ''}`;
    const FORBIDDEN = new Set(['userId', 'groupId', 'authorizationId', 'signature', 'proposalId', 'boundsHash', 'contextHash']);
    const ctxPairs = (ctx: Record<string, unknown>, group = '') =>
      Object.entries(ctx).filter(([k, x]) => !FORBIDDEN.has(k) && x !== null && x !== undefined && x !== '').map(([k, x]) => `${group}${k}=${v(x)}`);
    const boundsPairs = (m: Held, group = '') => Object.entries(m.bounds).map(([k, x]) => `${group}${k}=${v(x)}`);
    const approvalPairs = (prefix: string) => [
      `${prefix}createdAt=${fmtTs(replyProposal.createdAt)}`, `${prefix}decidedAt=${fmtTs(decidedAt)}`, `${prefix}committedBy=${NAME_UNDISCLOSED_APPROVER}`,
    ];
    const TIME_KEY = /(^|_|\.)(at|timestamp)$|At$|_at$/;
    const recordPairs = (row: Record<string, unknown>) => Object.entries(row)
      .filter(([k, x]) => !['body', 'lines', 'cc_json'].includes(k) && x !== null && x !== undefined && x !== '')
      .map(([k, x]) => `${k}=${TIME_KEY.test(k) ? fmtTs(typeof x === 'number' ? x : String(x)) : v(x)}`);

    const expected = (el: any): string[] => {
      const d = el.data;
      switch (el.kind) {
        case 'sv-ticket': {
          const src = asById.get(el.attrs.ref)!;
          if ((el.attrs.variant ?? '') !== 'full') return [`action=${src.action}`, `timestamp=${fmtTs(src.timestamp)}`];
          const m = mandateOf[src.id];
          return [
            `action=${src.action}`, ...(src.actionType !== undefined ? [`actionType=${src.actionType}`] : []), `profileId=${src.profileId}`,
            ...ctxPairs(src.executionContext ?? {}),
            ...boundsPairs(m, 'mandate/'), `mandate/commitment_mode=${m.mode}`, `mandate/owner=${NAME_UNDISCLOSED_OWNER}`,
            ...(src.id === t.c1Reply.id ? approvalPairs('approval/') : []),
            `timestamp=${fmtTs(src.timestamp)}`, `ticket=${src.id}`,
          ];
        }
        case 'sv-approval':
          return [...approvalPairs(''), `status=${d.status}`, `wait_s=${decidedAt - replyProposal.createdAt} ${WAIT_FORMULA}`];
        case 'sv-mandate': {
          const m = mandateOf[el.attrs.ticket];
          return [`profileId=${m.profile}`, ...boundsPairs(m), `commitment_mode=${m.mode}`, `owner=${NAME_UNDISCLOSED_OWNER}`, `intent=${m.intent}`];
        }
        case 'sv-record': {
          if (el.attrs.system === 'erp') return recordPairs((erpX.quotes as any[]).find((q) => q.id === el.attrs.ref));
          if (el.attrs.system === 'crm') return recordPairs((crmX.activities as any[]).find((q) => q.id === el.attrs.ref));
          return recordPairs((mailX.sent as any[]).find((q) => q.id === el.attrs.ref));
        }
        case 'sv-case': {
          const caseId = d.caseId as string;
          const inbox = (mailX.inbox as any[]).find((m) => m.id === start[caseId].id);
          const emailT = seconds(inbox.received_at);
          const startT = Math.max(emailT, loadedAt);
          const goal = caseId === 'c1' ? t.c1Reply : t.c2Send;
          const steps = caseId === 'c1' ? [t.c1Note, t.c1Quote] : [t.c2Note, t.c2Quote];
          // Time order, start first, goal last, each approval right before the action it approved.
          const items: Array<{ time: number; pairs: string[] }> = [{
            time: startT, pairs: [
              `[database] received_at=${fmtTs(inbox.received_at)}`, `[database] subject=${inbox.subject}`, `[database] from_email=${inbox.from_email}`,
              ...(emailT < loadedAt ? [`[database] simulation_load.loaded_at=${fmtTs(mailX.simulation_load.loaded_at)}`] : []),
            ],
          }];
          for (const s of [...steps, goal]) {
            if (s.id === t.c1Reply.id) items.push({ time: Math.min(decidedAt, s.timestamp), pairs: approvalPairs('[archive] approval.') });
            const tag = s === goal ? 'signed · goal' : 'signed';
            items.push({ time: s.timestamp, pairs: [`[${tag}] action=${s.action}`, `[${tag}] timestamp=${fmtTs(s.timestamp)}`] });
          }
          items.sort((a, b) => a.time - b.time);
          return [`case_id=${caseId}`, `duration_s=${goal.timestamp - startT} ${DURATION_FORMULA}`, ...items.flatMap((i) => i.pairs)];
        }
        case 'sv-metric': {
          const f = METRICS[d.kind];
          return [`${f.name}=${raw(d.value)} ${f.formula}`, 'cases=c1 c2'];
        }
      }
      throw new Error(`unexpected ${el.kind}`);
    };

    for (const box of boxes) {
      const el = els.get(box.id)!;
      expect(box.stray, `${box.id}: text outside fields/seal/link`).toEqual([]);
      if (el.status !== 'verified') {
        expect(box.seal).toBe('✗ not verifiable');
        expect(box.kvs).toEqual([]);
        expect(box.links).toEqual([]);
        // Nothing from the old ticket's mandate or record leaks into its refusal.
        expect(box.text).not.toContain(mandates['records:old'].intent);
        expect(box.text).not.toContain('family calendar');
        continue;
      }
      expect(box.seal, box.id).toBe(SEALS[el.kind]);
      const drawn = box.kvs.map(pair);
      const want = expected(el);
      if (el.kind === 'sv-case') expect(drawn, box.id).toEqual(want); // order matters: the gateway draws the time line
      else expect([...drawn].sort(), box.id).toEqual([...want].sort());
      if (el.kind === 'sv-ticket' && el.attrs.variant === 'full') {
        expect(box.links).toEqual([{ href: `${AS_URL}/r/${el.attrs.ref}`, text: CHECK_LINK_TEXT, target: '_blank' }]);
      } else {
        expect(box.links, box.id).toEqual([]);
      }
      if (el.kind === 'sv-case') {
        expect(box.stepTags[0]).toBe('database');
        expect(box.stepTags.at(-1)).toBe('signed · goal');
      }
      const words = box.text.replace(box.seal ?? '', '').replace(CHECK_LINK_TEXT, '');
      for (const w of TRANSLATED_WORDS) expect(words.includes(w), `${box.id} contains "${w}"`).toBe(false);
      expect(box.rubies, `${box.id}: gloss markup with translation off`).toEqual([]);
    }
  }, 60_000);

  it('7b. AI blocks: each framed "AI analysis — not verified", nothing verified or gateway-styled inside', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(frameDoc(report.renderedHtml));
    const facts = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll('.sv-ai-wrap')];
      return {
        count: wraps.length,
        labels: wraps.map((w) => w.querySelector(':scope > .sv-ai-label')?.textContent),
        verifiedInside: document.querySelectorAll('.sv-ai-content [data-sv-id], .sv-ai-content .sv-el, .sv-ai-content .sv-badge').length,
        gatewayClassesInside: [...document.querySelectorAll('.sv-ai-content *')].filter((e) => [...e.classList].some((c) => c.startsWith('sv-'))).length,
        stylesOrScripts: document.querySelectorAll('.sv-ai-content style, .sv-ai-content script, script').length,
        topLevelJunk: !!document.getElementById('junk-heading') || document.body.textContent!.includes('stray paragraph') || document.body.textContent!.includes('loose text') || document.body.textContent!.includes('top-level fake'),
        fake: (() => { const f = document.getElementById('ai-fake-box'); return f ? { cls: f.className, inFrame: !!f.closest('.sv-ai-block'), sv: f.getAttribute('data-sv-id') } : null; })(),
        overlayInFrame: !!document.getElementById('ai-overlay')?.closest('.sv-ai-block'),
        gloss: document.querySelectorAll('ruby, rt').length,
      };
    });
    await page.close();
    expect(facts).toEqual({
      count: 5, labels: Array(5).fill('AI analysis — not verified'), verifiedInside: 0, gatewayClassesInside: 0,
      stylesOrScripts: 0, topLevelJunk: false, fake: { cls: 'ai-own', inFrame: true, sv: null }, overlayInFrame: true, gloss: 0,
    });
  }, 60_000);

  it('7c. glossary: glosses only on field names / fixed words in the boxes, never on numbers, timestamps or ids; only in the switched-on render', async () => {
    expect(report.renderedHtml).not.toMatch(/<ruby|<rt/);
    expect(report.renderedHtmlGloss).toBeTruthy();
    const page = await browser.newPage();
    await page.setContent(frameDoc(report.renderedHtmlGloss));
    const boxes = await drawnBoxes(page);
    await page.close();
    const rubies = boxes.flatMap((b) => b.rubies);
    expect(rubies.length).toBeGreaterThan(4);
    for (const r of rubies) expect(GLOSS_OK[r.base], `gloss on "${r.base}"`).toBe(r.rt);
    expect(new Set(rubies.map((r) => r.base))).toEqual(new Set(Object.keys(GLOSS_OK)));
    for (const r of rubies) {
      expect(r.base).not.toMatch(/^\d/);
      expect(r.base).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    for (const bad of ['eintausend', 'Zeitpunkt', 'Notiz', 'nichts', 'geprüft', 'Doppelt', 'second glossary', 'x'.repeat(61)]) {
      expect(report.renderedHtmlGloss).not.toContain(bad);
    }
    // The legend is drawn once per surface, outside the report body (UI: step 9; export: 8e).
    expect(report.renderedHtml).not.toContain('class="sv-legend"');
    expect(report.renderedHtmlGloss).not.toContain('class="sv-legend"');
    // The values themselves are the same with the switch on (the gloss never replaces them).
    const plain = await browser.newPage();
    await plain.setContent(frameDoc(report.renderedHtml));
    const plainBoxes = await drawnBoxes(plain);
    await plain.close();
    expect(boxes.map((b) => b.kvs)).toEqual(plainBoxes.map((b) => b.kvs));
  }, 60_000);

  // ── 8. export ─────────────────────────────────────────────────────────────

  it('8a. GET /api/report/export: an attachment with no executable content; what the report does not show is not in it', async () => {
    const res = await cpGet('/api/report/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="suveren-report-\d{4}-\d{2}-\d{2}\.html"$/);
    exportHtml = await res.text();
    exportFile = join(work, 'suveren-report.html');
    writeFileSync(exportFile, exportHtml);

    const scripts = [...exportHtml.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/type="application\/json"/);
    const withoutData = exportHtml.replace(/<script\b[^>]*id="suveren-proof"[^>]*>[\s\S]*?<\/script>/i, '');
    expect(withoutData).not.toMatch(/<script/i);
    for (const tag of [...withoutData.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0])) {
      expect(tag, tag).not.toMatch(/\son[a-z]+\s*=/i);
      expect(tag, tag).not.toMatch(/javascript:/i);
    }
    expect(withoutData).toContain('first-report');
    expect(withoutData).toContain('AI analysis — not verified');

    // SR1: the old real ticket is outside the window — its payload, signature, record and mandate are not in the file.
    const bundle = bundleOf(exportHtml);
    expect((bundle.tickets as any[]).map((x) => x.id)).not.toContain(tOld.id);
    expect(exportHtml).not.toContain(tOld.signature);
    expect(exportHtml).not.toContain('family calendar');
    // The fresh real ticket is before the test data: not in the file at all.
    expect(exportHtml).not.toContain(tRecent.id);
    expect(exportHtml).not.toContain(tRecent.signature);
    // RR5: a placed mandate's intent is in the file; every other intent is not.
    expect(exportHtml).toContain(mandates['sales:work'].intent);
    for (const name of Object.keys(mandates).filter((n) => n !== 'sales:work')) {
      expect(exportHtml.includes(mandates[name].intent), `intent of ${name} (not shown in the report) is in the export`).toBe(false);
    }
    // Mandate data in the bundle: the mandates the report draws — sales (sv-mandate, with
    // intent) and email (only via the full reply ticket: limits/mode/owner, NO intent text).
    expect(Object.keys(bundle.authorizations).sort()).toEqual([mandates['sales:work'].id, mandates['email:work'].id].sort());
    expect(bundle.authorizations[mandates['sales:work'].id].intent).toBe(mandates['sales:work'].intent);
    expect(bundle.authorizations[mandates['email:work'].id]).not.toHaveProperty('intent');
    expect(JSON.stringify(bundle.authorizations[mandates['email:work'].id])).not.toContain(mandates['email:work'].intent);
    // Scope values are drawn by no box, so they never travel.
    for (const a of Object.values(bundle.authorizations) as any[]) expect(a.context).toBeUndefined();
    expect(exportHtml).not.toContain(EMAIL.ctx.allowed_recipients);
    expect(bundle.version).toBe(2);
    // The zone the gateway drew in (ICU may report Asia/Kolkata under its older alias).
    expect(new Intl.DateTimeFormat('en', { timeZone: bundle.timeZone }).resolvedOptions().timeZone).toBe(new Intl.DateTimeFormat('en', { timeZone: GW_ZONE }).resolvedOptions().timeZone);
    expect(bundle.identityAttestations).toEqual([]);
  }, 60_000);

  it('8b. every ticket in the embedded bundle verifies with hap-core against the spawned AS key', async () => {
    const bundle = bundleOf(exportHtml);
    expect(bundle.format).toBe('suveren-report-export');
    expect(bundle.authorityServer).toEqual({ url: AS_URL, publicKeyHex: asPublicKey });
    const all = new Map((await asTickets()).map((x) => [x.id, x]));
    const ids = (bundle.tickets as any[]).map((x) => x.id);
    for (const ticket of bundle.tickets as any[]) {
      await expect(
        verifyTicketSignature(ticket, { trustedIssuers: [encodeDidKey(Buffer.from(asPublicKey, 'hex'))] }),
        ticket.id,
      ).resolves.toBeUndefined();
      const src = all.get(ticket.id)!;
      expect(src, ticket.id).toBeTruthy();
      expect(ticket.signature).toBe(src.signature);
      expect(ticket.timestamp).toBe(src.timestamp);
      expect(ticket.timestamp).toBeGreaterThanOrEqual(loadedAt);
    }
    const expected = new Set([...bundle.proof.ticketsReferenced, ...bundle.coverage.ticketsInPeriod].filter((id) => all.has(id) && id !== tOld.id));
    expect([...ids].sort()).toEqual([...expected].sort());
    for (const k of Object.keys(t)) expect(ids).toContain(t[k].id);
    await expect(
      verifyTicketSignature(bundle.tickets[0], { trustedIssuers: [encodeDidKey(randomBytes(32))] }),
    ).rejects.toThrow();
  }, 60_000);

  it('8c. the verify-report CLI: unconfirmed key → 2, --key → 0, --online → 0; the not-verifiable references are listed', () => {
    expect(existsSync(CLI), `${CLI} — the npm bundle must be assembled (node bundle/build.mjs)`).toBe(true);
    const ticketKinds = new Set(['sv-ticket', 'sv-approval', 'sv-mandate', 'sv-case']);
    const shownVerified = (report.elements as any[]).filter((e) => ticketKinds.has(e.kind) && e.status !== 'unverifiable').length;
    expect(shownVerified).toBe(10);
    const countsLine = `References: ${shownVerified} verified · 3 not verifiable (as shown in the report).`;
    const nAuth = Object.keys(bundleOf(exportHtml).authorizations).length;

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
      expect(r.stdout).toContain(`Mandates: all ${nAuth} valid`);
      expect(r.stdout).toContain('Page: exactly what the signed data draws.');
      expect(r.stdout).toMatch(/Boxes: \d+ fully checked · \d+ partly not checkable offline · 0 MISMATCH\./);
      // Per box: what the file cannot back offline is listed as such, never as signed.
      const nc = /Not checkable offline[^\n]*:\n((?: {4}- .*\n?)+)/.exec(r.stdout);
      expect(nc, r.stdout).toBeTruthy();
      const ncLines = Object.fromEntries(nc![1].trim().split('\n').map((l) => { const m = /- (\S+): (.*)/.exec(l.trim())!; return [m[1], m[2]]; }));
      for (const id of ['sv-record-0', 'sv-record-1', 'sv-record-2']) expect(ncLines[id], `${id} not listed as not checkable`).toMatch(/\(database\)/);
      for (const id of ['sv-case-0', 'sv-case-1']) expect(ncLines[id], `${id} case start not listed`).toMatch(/\(database\)/);
      expect(ncLines['sv-approval-0']).toMatch(/\(archive\)/);
      // A full ticket's signed fields are checked against the signature, not listed as uncheckable.
      expect(r.stdout).toMatch(new RegExp(`- sv-ticket-2: checked against signature: [^\\n]*action`));
      expect(r.stdout).not.toMatch(/INVALID/);
      const section = /Not verifiable \(as shown in the report\):\n((?: {4}- .*\n?)+)/.exec(r.stdout);
      expect(section, r.stdout).toBeTruthy();
      const listed = section![1].trim().split('\n');
      expect(listed).toHaveLength(3);
      expect(listed.filter((l) => l.includes(`not in the file: ${BOGUS_REF}`))).toHaveLength(1);
      expect(listed.filter((l) => l.includes(`not in the file: ${tOld.id}`))).toHaveLength(2);
    }
  }, 120_000);

  it('8d. tampering fails: one byte of a ticket, a random key, an upgraded or downgraded card, an edited drawn value, an edited bound → 1', () => {
    const m = /(<script[^>]*id="suveren-proof"[^>]*>)([\s\S]*?)(<\/script>)/i.exec(exportHtml)!;
    const bundle = JSON.parse(m[2]);
    const victim = bundle.tickets[0];
    const tsString = String(victim.timestamp);
    victim.timestamp = Number(tsString.slice(0, -1) + String((Number(tsString.slice(-1)) + 1) % 10));
    const tamperedJson = JSON.stringify(bundle).replace(/<\//g, '<\\/');
    expect(tamperedJson.length).toBe(m[2].length);
    const tamperedFile = join(work, 'tampered.html');
    writeFileSync(tamperedFile, exportHtml.replace(m[0], `${m[1]}${tamperedJson}${m[3]}`));
    const tampered = runCli([tamperedFile]);
    expect(tampered.status, tampered.stdout + tampered.stderr).toBe(1);
    expect(tampered.stdout).toContain(victim.id);
    expect(runCli([tamperedFile, '--key', asPublicKey]).status).toBe(1);

    const wrongKey = runCli([exportFile, '--key', randomBytes(32).toString('hex')]);
    expect(wrongKey.status, wrongKey.stdout + wrongKey.stderr).toBe(1);
    expect(wrongKey.stdout).toMatch(/Key MISMATCH/);

    // A forger may downgrade a claim, never upgrade one: flip the old ticket's drawn card to verified.
    const visible = exportHtml.slice(0, exportHtml.indexOf('<script'));
    expect(visible.split('sv-badge sv-badge-bad').length - 1).toBe(3);
    const cardRe = /<div class="sv-el sv-el-unverifiable" data-sv-id="sv-ticket-7">[\s\S]*?<\/div><\/div>/;
    const card = cardRe.exec(exportHtml);
    expect(card, 'the old ticket\'s card').toBeTruthy();
    expect(card![0]).toContain(tOld.id);
    const upgradedCard = card![0].replace('sv-el-unverifiable', 'sv-el-verified').replace('sv-badge sv-badge-bad', 'sv-badge sv-badge-ok');
    const upgradedFile = join(work, 'upgraded.html');
    writeFileSync(upgradedFile, exportHtml.replace(card![0], upgradedCard));
    for (const args of [[upgradedFile], [upgradedFile, '--key', asPublicKey], [upgradedFile, '--online']]) {
      const r = runCli(args);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/INVALID — 1 reference\(s\) shown as verified with no valid backing/);
      expect(r.stdout).toContain(`Ticket ${tOld.id} is not in the bundle.`);
    }

    const expectInvalid = (file: string, what: string, pattern: RegExp) => {
      for (const args of [[file], [file, '--key', asPublicKey], [file, '--online']]) {
        const r = runCli(args);
        expect(r.status, `${what} (${args.slice(1).join(' ') || 'no key'}): ${r.stdout}${r.stderr}`).toBe(1);
        expect(r.stdout, what).toMatch(pattern);
      }
    };
    const scriptAt = exportHtml.indexOf('<script');
    const page = exportHtml.slice(0, scriptAt);
    const tail = exportHtml.slice(scriptAt);

    // A downgrade by hand: a verified card redrawn as "not verifiable".
    const okCard = /<div class="sv-el sv-el-verified" data-sv-id="sv-ticket-2">/.exec(page);
    expect(okCard).toBeTruthy();
    const downFile = join(work, 'downgraded.html');
    writeFileSync(downFile, page.replace(okCard![0], okCard![0].replace('sv-el-verified', 'sv-el-unverifiable')) + tail);
    expectInvalid(downFile, 'downgraded card', /INVALID — page/);

    // A drawn value edited on the page: the sales mandate's value_max in the sv-mandate box.
    const limit = /(<div class="sv-el sv-el-verified" data-sv-id="sv-mandate-0">[\s\S]*?<span class="sv-k">value_max<\/span>(?:<rt>[^<]*<\/rt><\/ruby>)?<span class="sv-v">)1000(<\/span>)/.exec(page);
    expect(limit, 'the mandate box draws value_max 1000').toBeTruthy();
    const valueFile = join(work, 'edited-value.html');
    writeFileSync(valueFile, page.replace(limit![0], `${limit![1]}9000${limit![2]}`) + tail);
    expectInvalid(valueFile, 'edited mandate limit', /INVALID — page/);

    // A full ticket's signed value edited on the page: the reply ticket's recipient_count.
    const full = /(<div class="sv-el sv-el-verified" data-sv-id="sv-ticket-2">[\s\S]*?<span class="sv-k">recipient_count<\/span>(?:<rt>[^<]*<\/rt><\/ruby>)?<span class="sv-v">)1(<\/span>)/.exec(page);
    expect(full, 'the full reply ticket draws recipient_count 1').toBeTruthy();
    const fullFile = join(work, 'edited-ticket.html');
    writeFileSync(fullFile, page.replace(full![0], `${full![1]}5${full![2]}`) + tail);
    expectInvalid(fullFile, 'edited full-ticket value', /INVALID — page/);

    // A bundled bound edited without its hash: page untouched, the mandate's bounds no longer hash to bounds_hash.
    const b2 = bundleOf(exportHtml);
    const salesAuth = b2.authorizations[mandates['sales:work'].id];
    expect(salesAuth.bounds.value_max).toBe(1000);
    salesAuth.bounds.value_max = 9000;
    const boundFile = join(work, 'edited-bound.html');
    writeFileSync(boundFile, exportHtml.replace(m[0], `${m[1]}${JSON.stringify(b2).replace(/<\//g, '<\\/')}${m[3]}`));
    expectInvalid(boundFile, 'edited bundled bound', /Mandates: \d+\/\d+ valid — INVALID/);

    // The same bound edited consistently everywhere — page, drawn elements, bundle — still fails:
    // the bounds hash is signed by the AS.
    const b3 = bundleOf(exportHtml);
    b3.authorizations[mandates['sales:work'].id].bounds.value_max = 9000;
    const el3 = (b3.elements as any[]).find((e) => e.id === 'sv-mandate-0');
    expect(JSON.stringify(el3)).toContain('"value_max":1000');
    const el3New = JSON.parse(JSON.stringify(el3).replace('"value_max":1000', '"value_max":9000'));
    Object.assign(el3, el3New);
    const consistentFile = join(work, 'edited-everywhere.html');
    writeFileSync(consistentFile, page.replace(limit![0], `${limit![1]}9000${limit![2]}`) + tail.replace(m[0], `${m[1]}${JSON.stringify(b3).replace(/<\//g, '<\\/')}${m[3]}`));
    expectInvalid(consistentFile, 'bound edited on page + elements + bundle', /Mandates: \d+\/\d+ valid — INVALID/);
  }, 120_000);

  it('8e. the export\'s translation switch works without any script (JavaScript off)', async () => {
    expect(exportHtml).toContain('<input type="checkbox" id="sv-gloss-toggle"');
    expect(exportHtml).toContain('Übersetzung anzeigen / show translation');
    const header = /<div class="sv-export-header">[\s\S]*?<div class="sv-export-layout">/.exec(exportHtml)?.[0] ?? '';
    expect(header).toContain('Green = verified by the gateway');
    expect(header).toContain('= translation by the AI, not verified');
    expect(exportHtml.split('class="sv-legend"').length - 1, 'the export draws its legend once').toBe(1);
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`file://${exportFile}`);
    const shown = () => page.locator('ruby.sv-gloss rt').evaluateAll((rts) => rts.filter((r) => getComputedStyle(r).display !== 'none').length);
    const total = await page.locator('ruby.sv-gloss rt').count();
    expect(total).toBeGreaterThan(4);
    expect(await shown()).toBe(0);
    await page.locator('label.sv-toggle-text').click();
    expect(await page.locator('#sv-gloss-toggle').isChecked()).toBe(true);
    expect(await shown()).toBe(total);
    await page.locator('label.sv-toggle-text').click();
    expect(await shown()).toBe(0);
    await ctx.close();
  }, 60_000);

  // ── 9. the gateway UI ─────────────────────────────────────────────────────

  it('9. gateway UI: AI CSS cannot cover a box; Checked values → details without a reload; the public-check popup (intercepted); the switch; phone width', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const external: string[] = [];
    const intercepted: string[] = [];
    await ctx.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host === 'suveren.ai' || host.endsWith('.suveren.ai')) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await ctx.route(`${AS_URL}/r/**`, (route) => {
      intercepted.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>intercepted</title><p>intercepted</p>' });
    });
    const page = await ctx.newPage();
    await page.goto(`${CP_URL}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(user.apiKey);
    await page.locator('button:has-text("Sign In")').click();
    await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 45_000 });
    await page.locator('.sidebar a[href="/reports"]').click();
    await page.locator('iframe.reports-iframe').waitFor({ timeout: 20_000 });
    // A marker in the page's own JS heap: a full page load (the old target=_top
    // links) would drop it, and the in-memory API key with it.
    await page.evaluate(() => { (window as any).__r7Marker = 'kept'; });
    const stillSameDocument = async () => {
      expect(page.url()).not.toContain('/login');
      expect(await page.evaluate(() => (window as any).__r7Marker)).toBe('kept');
    };

    // (a) the real frame document: AI CSS cannot change or cover a verified box.
    const srcdoc = await page.locator('iframe.reports-iframe').getAttribute('srcdoc');
    expect(srcdoc).toContain('Content-Security-Policy');
    expect(srcdoc).toContain(report.renderedHtml.slice(0, 200));
    expect(await page.locator('iframe.reports-iframe').getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    for (const width of [1280, 375]) {
      const p = await browser.newPage({ viewport: { width, height: 900 } });
      await p.setContent(srcdoc!);
      const f = await layoutFacts(p);
      await p.close();
      expect(f.overlayFound).toBe(true);
      expect(f.overlayClipped, `overlay not clipped at ${width}px`).toBe(true);
      expect(f.labels.every(Boolean), `an AI frame label is covered at ${width}px`).toBe(true);
      expect(f.boxes).toHaveLength(24);
      for (const b of f.boxes) {
        expect(b.hits, `${b.id} covered at ${width}px`).toEqual([true, true, true]);
        expect([b.display, b.visibility, b.opacity], b.id!).toEqual(['block', 'visible', '1']);
        expect(b.border, b.id!).toMatch(/^solid rgb\((21, 128, 61|185, 28, 28)\) 2px$/);
      }
      expect(f.scrollWidth, `report scrolls sideways at ${width}px`).toBeLessThanOrEqual(f.clientWidth);
    }

    // (b) a Checked-values row opens its details in place — no reload, no logout.
    // The legend, once, in the gateway UI outside the frame — incl. the translation note.
    const uiLegend = (await page.locator('.reports-legend').textContent()) ?? '';
    expect(uiLegend).toContain('Green = verified by the gateway');
    expect(uiLegend).toContain('AI analysis — not verified');
    expect(uiLegend).toContain('= translation by the AI, not verified');
    // Checked values: the same raw field names and values as the boxes.
    const rows = await page.locator('.reports-checked-values .reports-row-button').allTextContents();
    expect(rows.map((r) => r.replace(/›$/, ''))).toEqual((report.proof.verifiedValues as any[]).map((x) => x.summary));
    const caseRow = page.locator('.reports-checked-values .reports-row-button', { hasText: /^case_id c1 · / });
    await caseRow.click();
    await eventually(() => page.url().includes('element=sv-case-0'), 'case detail URL');
    await page.locator('.reports-detail').waitFor();
    await stillSameDocument();
    const stepButtons = page.locator('.reports-case-steps button');
    expect(await stepButtons.count()).toBe(3);
    await stepButtons.nth(1).click();
    await eventually(() => page.url().includes(`ticket=${t.c1Quote.id}`), 'case step URL');
    await eventually(async () => ((await page.locator('.reports-detail').textContent()) ?? '').includes(mandates['sales:work'].intent), 'the step\'s mandate in the detail panel');
    await stillSameDocument();
    await page.locator('.reports-checked-values .reports-row-button', { hasText: /^committedBy / }).click();
    await eventually(() => page.url().includes('element=sv-approval-0'), 'approval detail URL');
    await stillSameDocument();

    // (c) "Check on suveren.ai" opens a new tab with the ticket's public check — intercepted.
    const frame = page.frameLocator('iframe.reports-iframe');
    const [popup] = await Promise.all([
      ctx.waitForEvent('page'),
      frame.getByText(CHECK_LINK_TEXT).first().click(),
    ]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe(`${AS_URL}/r/${t.c1Reply.id}`);
    expect(await popup.title()).toBe('intercepted');
    expect(intercepted).toContain(`${AS_URL}/r/${t.c1Reply.id}`);
    await popup.close();
    await stillSameDocument();

    // (d) the translation switch: off by default, on, off again.
    const frameHasGloss = async () => /<ruby class="sv-gloss">/.test((await page.locator('iframe.reports-iframe').getAttribute('srcdoc')) ?? '');
    const sw = page.getByRole('switch');
    expect(await sw.isChecked()).toBe(false);
    expect(await frameHasGloss()).toBe(false);
    // The input is visually hidden; the reader clicks the drawn switch (its label).
    const switchLabel = page.locator('label.reports-gloss-switch');
    await switchLabel.click();
    expect(await sw.isChecked()).toBe(true);
    await eventually(frameHasGloss, 'gloss shown after switching on');
    for (const word of Object.values(GLOSS_OK)) expect(await page.locator('iframe.reports-iframe').getAttribute('srcdoc')).toContain(word);
    await switchLabel.click();
    expect(await sw.isChecked()).toBe(false);
    await eventually(async () => !(await frameHasGloss()), 'gloss gone after switching off');
    await stillSameDocument();

    // (e) phone width: no horizontal page scroll — with and without the details open.
    for (const width of [375, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(m.sw, `page scrolls sideways at ${width}px (details open)`).toBeLessThanOrEqual(m.cw);
    }
    await page.locator('.reports-detail button', { hasText: 'Close' }).click();
    await eventually(() => !page.url().includes('element='), 'details closed');
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(closed.sw, 'page scrolls sideways at 360px').toBeLessThanOrEqual(closed.cw);
    await stillSameDocument();

    expect(external, 'the real suveren.ai was contacted').toEqual([]);
    await ctx.close();
  }, 180_000);

  // ── 10. replace ───────────────────────────────────────────────────────────

  it('10. rewriting the report replaces it; its export carries neither real ticket (id, signature, intent)', async () => {
    await reconnect();
    await new Promise((r) => setTimeout(r, 1_100)); // so savedAt can move
    const html = `<sv-ai><h1 id="second-report">Updated report</h1></sv-ai>
<sv-case start="email:${start.c1.id}" goal="ticket:${t.c1Reply.id}" steps="${t.c1Note.id} ${t.c1Quote.id}"></sv-case>
<sv-metric kind="completed" cases="all"></sv-metric>`;
    const w = await call('report__write_report', { html });
    expect(w.denied, w.text).toBe(false);
    expect(w.text).toMatch(/Report stored\. 2 element\(s\) verified, 0 warning\(s\), 0 not verifiable\./);
    expect(w.text).not.toContain('dropped:');

    const res = await cpGet('/api/report');
    const second = ((await res.json()) as any).report;
    expect(second.savedAt).toBeGreaterThan(firstSavedAt);
    expect(second.renderedHtml).toContain('second-report');
    expect(second.renderedHtml).not.toContain('first-report');
    expect(second.elements.map((e: any) => [e.kind, e.status])).toEqual([['sv-case', 'verified'], ['sv-metric', 'verified']]);
    expect(second.elements[1].data.value).toBe(1);
    expect(second.coverage.missingCases).toEqual(['c2', 'c3']);
    expect(second.renderedHtmlGloss).toBeUndefined();

    const exp = await (await cpGet('/api/report/export')).text();
    expect(exp).toContain('second-report');
    expect(exp).not.toContain('first-report');
    for (const real of [tOld, tRecent]) {
      expect(exp.includes(real.id), `real ticket ${real.id} in the export`).toBe(false);
      expect(exp.includes(real.signature)).toBe(false);
    }
    for (const name of Object.keys(mandates)) expect(exp.includes(mandates[name].intent), `intent of ${name}`).toBe(false);
    expect(Object.keys(bundleOf(exp).authorizations)).toEqual([]);
    expect(exp).not.toContain('<input type="checkbox" id="sv-gloss-toggle"');
  }, 60_000);

  // ── 11. outside simulation mode ───────────────────────────────────────────

  it('11. outside simulation mode the window is the mandate\'s day count: the fresh real ticket is in, the old one is out', async () => {
    await stopGateway('cp', 'mcp');
    await startControlPlane(pm, liveStack(), 'cp-live');
    await startMcpServer(pm, liveStack(), 'mcp-live');
    expect((await cp.login(user.apiKey)).status).toBe(200);
    await reconnect();
    expect((await toolNames()).filter((n) => n.startsWith('report__')).length).toBe(5);

    const all = await asTickets();
    const now = Math.floor(Date.now() / 1000);
    const listed = await call('report__list_tickets', {});
    expect(listed.denied, listed.text).toBe(false);
    expect(listed.json.window.since).toMatch(/the last 1 day/);
    expect(Math.abs(listed.json.window.start - (now - WINDOW_DAYS * DAY))).toBeLessThan(120);
    const ids = (listed.json.tickets as any[]).map((x) => x.id);
    const expected = all.filter((x) => x.timestamp >= listed.json.window.start).map((x) => x.id);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(ids).toContain(tRecent.id);
    expect(ids).toContain(loadTickets[0].id);
    expect(ids).not.toContain(tOld.id);
    expect(listed.text).not.toContain(tOld.id);

    const old = await call('report__get_ticket', { id: tOld.id });
    expect(old.denied).toBe(true);
    expect(old.text).toContain('not verifiable — outside the reporting window (since');
    const recent = await call('report__get_ticket', { id: tRecent.id });
    expect(recent.denied, recent.text).toBe(false);
    expect(recent.json.mandate).toMatchObject({ verified: true, intent: mandates['records:recent'].intent });

    const w = await call('report__write_report', { html: `<sv-ai><h1 id="daily">Daily report</h1></sv-ai>
<sv-ticket ref="${tRecent.id}" variant="compact"></sv-ticket>
<sv-ticket ref="${tOld.id}" variant="full"></sv-ticket>` });
    expect(w.denied, w.text).toBe(false);
    expect(w.text).toMatch(/Report stored\. 1 element\(s\) verified, 0 warning\(s\), 1 not verifiable\./);
    expect(w.text).toContain(`Ticket "${tOld.id}": not verifiable — outside the reporting window`);
    const exp = await (await cpGet('/api/report/export')).text();
    const ticketsInFile = (bundleOf(exp).tickets as any[]).map((x) => x.id);
    expect(ticketsInFile).toContain(tRecent.id);
    expect(ticketsInFile).not.toContain(tOld.id);
    expect(exp).not.toContain(tOld.signature);
    expect(exp).not.toContain(mandates['records:old'].intent);
    expect(exp).not.toContain('family calendar');

    // The whole run, once more: no report tool ever returned an internal value.
    for (const o of reportToolOutputs) {
      for (const value of [user.user.id, groupId, user.user.did, ...Object.values(mandates).flatMap((m) => [m.id, m.blob]), ...all.map((x) => x.signature)]) {
        expect(o.text.includes(value), `${o.tool} returned an internal value`).toBe(false);
      }
    }
  }, 180_000);
});
