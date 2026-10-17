/**
 * "Issue an invoice, then email it as an attachment" — on the real stack:
 * Authority Server + the whole gateway (control plane + MCP server) + the
 * published erp-mcp in live mode "local" (Suveren's own invoicing: a real
 * company file, real PDFs, a write-once archive) + the published email-mcp
 * (simulated mailbox, with attachments). Nothing is mocked; no real email.
 *
 * The journey (suveren-invoicing-plan.md §5–§7, UI spec §15):
 *   1. an invoicing mandate (review) and an email 0.9 mandate (review) whose
 *      allowed_attachment_sources is "erp:invoice-pdf", for the customer's domain;
 *   2. create_invoice (number "2026-0001", service period, one line, declared
 *      net_total) becomes a proposal; the control-plane preview route the UI
 *      uses returns the PDF as it will be issued (sha256, pages >= 1) — twice,
 *      and the number is still free afterwards (a preview consumes nothing);
 *   3. approval → executed → the invoice is issued with its archived PDF's
 *      fingerprint;
 *   4. send_message with attachments [{connector:"erp", kind:"invoice-pdf",
 *      id:"2026-0001"}] becomes a proposal; the card data carries the SEALED
 *      attachment (filename, sha256 = the issued PDF's), the attachment preview
 *      route answers the same file, and the body is declared AI text
 *      (display.aiText);
 *   5. approval → executed → the simulated mailbox holds exactly that PDF; the
 *      ticket's content binding commits to the attachment's fingerprint;
 *   6. negatives — (a) email 0.8 / 0.9 without allowed sources: refused, nothing
 *      proposed or sent; (b) an undeclared document kind: refused; (c) the
 *      archived PDF altered on disk after approval: execution refused, nothing
 *      sent, outcome recorded as failed; (d) AI-supplied bytes / `raw`: refused.
 *
 * NOT covered: inserting a Mollie payment link into the body (`insert`) — it
 * needs a real Mollie account, which CI does not have, and the house rule is
 * real MCP servers only (no mocked Mollie). Skipped below with a note.
 *
 * Known red (2026-10-17, gateway feat/email-documents b1dae47 + erp-mcp 0.8.0):
 *   - step 3: the AU4 "record changed" check hashes the create_invoice preview
 *     INCLUDING the `kind: "document"` read (preview_invoice), whose PDF embeds
 *     the render time — two renders never match, so an approved review-mode
 *     invoice is always refused at execution. Step 4 then issues the same
 *     invoice as the operator (straight on the connector, no gateway) so the
 *     email half still runs; that fallback never triggers once step 3 passes.
 *   - steps 4, 5, 6(c): the gateway's document resolution reads only
 *     `structuredContent`; erp-mcp 0.8.0's get_document answers in text only.
 *
 * Gated on the gateway's attachment support (attachment-resolution.ts), the
 * profiles' email@0.9 + invoicing@0.1, and the manifests pinning erp-mcp >=
 * 0.8.0 (live/local) and declaring mail attachments. Skips loudly otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeContentHash, selectBoundFields } from '@humanagencyp/hap-core';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { ControlPlaneClient, GW_DIR, PROFILES_DIR } from '../src/helpers/gateway-stack.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { profileHashFor } from '../src/helpers/profiles.js';

const AS_PORT = 19910;
const MCP_PORT = 19911;
const CP_PORT = 19912;
const AS_URL = `http://localhost:${AS_PORT}`;
const MCP_URL = `http://localhost:${MCP_PORT}`;
const CP_URL = `http://localhost:${CP_PORT}`;

const ATTACHMENT_SRC = join(GW_DIR, 'apps', 'mcp-server', 'src', 'lib', 'attachment-resolution.ts');
const ERP_MANIFEST = join(GW_DIR, 'content', 'integrations', 'erp.json');
const MAIL_MANIFEST = join(GW_DIR, 'content', 'integrations', 'mail.json');

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
const erpManifest = readJson(ERP_MANIFEST);
const mailManifest = readJson(MAIL_MANIFEST);
const gaps: string[] = [];
if (!existsSync(ATTACHMENT_SRC)) gaps.push('a gateway with attachments by reference (apps/mcp-server/src/lib/attachment-resolution.ts)');
if (!existsSync(join(PROFILES_DIR, 'email', '0.9.profile.json'))) gaps.push('hap-profiles email@0.9');
if (!existsSync(join(PROFILES_DIR, 'invoicing', '0.1.profile.json'))) gaps.push('hap-profiles invoicing@0.1');
if (String(erpManifest?.npmVersion ?? '').localeCompare('0.8.0', undefined, { numeric: true }) < 0) gaps.push('erp.json pinning erp-mcp >= 0.8.0 (live mode "local")');
if (!erpManifest?.documents?.['invoice-pdf']) gaps.push('erp.json declaring documents.invoice-pdf');
if (mailManifest?.attachments?.transport !== 'field') gaps.push('mail.json declaring an attachments transport (email-mcp >= 0.4.0)');
const available = gaps.length === 0;
if (!available) console.warn(`[INVOICE EMAIL E2E] SKIPPED — needs ${gaps.join('; ')}.`);

const P = 'github.com/humanagencyprotocol/hap-profiles';
const INVOICING = `${P}/invoicing@0.1`;
const EMAIL_09 = `${P}/email@0.9`;
const EMAIL_08 = `${P}/email@0.8`;
const INVOICING_KEYS = ['profile', 'read_access', 'invoice_net_max', 'credit_net_max',
  'invoice_net_monthly_max', 'credit_net_monthly_max', 'invoice_daily_max', 'credit_daily_max'];
const EMAIL_KEYS = ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'];
const EMAIL_SCOPE_KEYS_09 = ['allowed_recipients', 'allowed_domains', 'allowed_attachment_sources'];
const EMAIL_SCOPE_KEYS_08 = ['allowed_recipients', 'allowed_domains'];

// Placeholder company data — an Austrian sole trader, invented throughout.
const COMPANY = {
  name: 'Muster Beratung e.U.', owner: 'Maria Muster',
  address: { street: 'Musterstraße 1', zip: '1010', city: 'Wien', country: 'Österreich', country_code: 'AT' },
  uid: 'ATU12345678', email: 'office@muster-beratung.example', web: 'https://muster-beratung.example',
  register: null, bank: { name: 'Musterbank AG', iban: 'AT611904300234573201', bic: 'MUSTATWWXXX' },
  default_payment_term_days: 14, vat_mode: 'normal',
};
const CUSTOMER_DOMAIN = 'kunde-gmbh.example';
const CUSTOMER_EMAIL = `buchhaltung@${CUSTOMER_DOMAIN}`;
const CUSTOMER = {
  id: 'cust-kunde', name: 'Kunde GmbH', address_lines: ['Kundenweg 2', '4020 Linz'],
  country: 'AT', uid: 'ATU87654321', email: CUSTOMER_EMAIL,
};
const NUMBER = '2026-0001';
const INVOICE_ARGS = {
  customer_id: CUSTOMER.id, number: NUMBER,
  service_period: { from: '2026-09-01', to: '2026-09-30' },
  lines: [{ description: 'Beratung September 2026', qty: 10, unit: 'Std.', unit_price: 120, vat_rate: 20 }],
  net_total: 1200, currency: 'EUR',
};
const ATTACHMENT_REF = { connector: 'erp', kind: 'invoice-pdf', id: NUMBER };
const MAIL_BODY = 'Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unsere Rechnung 2026-0001 für September.\n\nMit freundlichen Grüßen\nMaria Muster';

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const gw = new GatewayClient(MCP_URL);
const cp = new ControlPlaneClient(CP_URL);
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-inv-mail-'));
const COMPANY_FILE = join(work, 'company.json');

let apiKey: string;
let did: string;
let groupId: string;
let agent: Client;
let mailbox: Client;
let previousDisableAuto: string | undefined;

// ── helpers ──────────────────────────────────────────────────────────────

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function call(tool: string, args: Record<string, unknown>) {
  const r = await agent.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

function proposalIdOf(text: string): string {
  const m = text.match(/Proposal ID:\s*([^\s.]+)/);
  expect(m, `a "Proposal ID: ..." line in: ${text}`).toBeTruthy();
  return m![1];
}

async function asApi(method: string, path: string, body?: unknown) {
  const res = await fetch(`${AS_URL}${path}`, {
    method, headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

async function cpGet(path: string) {
  const res = await cp.authed(apiKey, 'GET', path);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function pendingProposals(): Promise<Array<{ id: string; tool: string }>> {
  return ((await asApi('GET', '/api/proposals?domain=owner')).body.proposals ?? [])
    .filter((p: { status: string }) => p.status === 'pending');
}

async function commit(proposalId: string) {
  const r = await asApi('POST', `/api/proposals/${proposalId}/resolve`, { action: 'commit', domain: 'owner' });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

async function reject(proposalId: string) {
  await asApi('POST', `/api/proposals/${proposalId}/resolve`, { action: 'reject', domain: 'owner' });
}

/** After approval: the gateway's executor (poll or this call) runs it once. */
async function awaitExecution(proposalId: string): Promise<{ denied: boolean; text: string }> {
  const until = Date.now() + 40_000;
  let last = { denied: false, text: '' };
  while (Date.now() < until) {
    last = await call('check-pending-commitments', { proposal_id: proposalId });
    if (/executed|refused|failed|nothing was done|Refused/i.test(last.text) && !/Awaiting|pending/i.test(last.text.split('\n')[0])) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return last;
}

function resultJson(text: string): any {
  const i = text.indexOf('Result:');
  expect(i, `a "Result:" in: ${text}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(i + 'Result:'.length).trim());
}

/** The proposal's own args as the approval card reads them (PE1: decrypted on this gateway). */
async function cardArgs(proposalId: string): Promise<Record<string, any>> {
  const { body } = await asApi('GET', `/api/proposals/${proposalId}`);
  const p = body.proposal;
  if (p.toolArgs) return p.toolArgs;
  const res = await cp.authed(apiKey, 'POST', '/api/decrypt-proposal-content', p.content);
  const dec = await res.json() as { plaintext?: string; error?: string };
  expect(res.status, JSON.stringify(dec)).toBe(200);
  return JSON.parse(dec.plaintext!);
}

async function grant(profileId: string, keys: string[], bounds: Record<string, unknown>,
  scope: Record<string, string>, scopeKeys: string[], intent: string): Promise<string> {
  const boundsHash = computeBoundsHash(bounds, keys);
  const contextHash = computeScopeHash(scope, scopeKeys);
  const gate = { intent };
  const att = await sp.submitMandate(apiKey, {
    profile_id: profileId, profile_hash: profileHashFor(profileId, PROFILES_DIR), group_id: groupId,
    bounds, bounds_hash: boundsHash, scope_hash: contextHash, domain: 'owner', did,
    commitment_mode: 'review', gate_content_hashes: hashGateContent(gate),
    execution_context_hash: hashExecutionContext({ intent }),
  });
  await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: scope }, profileId, gate);
  return att.authorization_id;
}

function emailBounds(profileId: string) {
  return { profile: profileId, read_access: 'unlimited', recipient_max: 1, send_daily_max: 20, read_max_age_days: 30, setup_daily_max: 0 };
}

function erpCli(...args: string[]): string {
  const dataDir = pm.getDataDir();
  const bin = join(dataDir, 'integrations', 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js');
  const env: NodeJS.ProcessEnv = { ...process.env, HAP_DATA_DIR: dataDir, ERP_MODE: 'live', ERP_LIVE_ADAPTER: 'local', ERP_LIVE_COMPANY_FILE: COMPANY_FILE };
  delete env.DATABASE_URL;
  return execFileSync('node', [bin, ...args], { env, encoding: 'utf8' });
}

/** The operator's own view of the simulated mailbox: the installed email-mcp, over stdio, on the gateway's data dir. */
async function mailboxCall(tool: string, args: Record<string, unknown>): Promise<any> {
  const r = await mailbox.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  expect(r.isError, text).not.toBe(true);
  return JSON.parse(text);
}

async function sentCount(): Promise<number> {
  const list = await mailboxCall('list_messages', { folder: 'sent' });
  return (Array.isArray(list) ? list : list.messages ?? []).length;
}

// ── suite ────────────────────────────────────────────────────────────────

describe.skipIf(!available)('Issue an invoice, then email it as an attachment (real AS + gateway + erp-mcp live/local + email-mcp)', () => {
  beforeAll(async () => {
    previousDisableAuto = process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
    process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = '1';

    pm.buildGateway();
    await pm.startSP(AS_PORT);
    const reg = await sp.register('Invoice Email E2E', `inv-mail-${Date.now()}@test.local`);
    apiKey = reg.apiKey;
    did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);

    await pm.startGateway({ port: MCP_PORT, cpPort: CP_PORT, spUrl: AS_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'inv-mail-e2e', apiKey });

    // The person's own connector settings, the way the gateway UI saves them:
    // vault credentials for "erp" (mapped to env by erp.json's envMapping),
    // then the connector is activated from its manifest.
    writeFileSync(COMPANY_FILE, JSON.stringify(COMPANY, null, 2));
    const put = await cp.authed(apiKey, 'PUT', '/vault/credentials/erp', { mode: 'live', liveAdapter: 'local', companyFile: COMPANY_FILE });
    expect(put.status, await put.text()).toBe(200);
    for (const id of ['erp', 'mail']) {
      const res = await cp.authed(apiKey, 'POST', `/mcp/integrations/${id}/activate`);
      expect(res.status, await res.text()).toBe(200);
    }
    await gw.waitForIntegration('erp');
    await gw.waitForIntegration('mail');

    // The customer is master data: only the person adds it (CLI), never the AI.
    erpCli('customers', 'add', JSON.stringify(CUSTOMER));

    const mailBin = join(pm.getDataDir(), 'integrations', 'node_modules', '@humanagencyp', 'email-mcp', 'dist', 'index.js');
    const mailEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL') mailEnv[k] = v;
    mailbox = new Client({ name: 'operator-mailbox', version: '1.0.0' }, { capabilities: {} });
    await mailbox.connect(new StdioClientTransport({ command: process.execPath, args: [mailBin], env: { ...mailEnv, HAP_DATA_DIR: pm.getDataDir() } }));

    await new Promise((r) => setTimeout(r, 1_000));
    agent = new Client({ name: 'invoice-email-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`${MCP_URL}/sse`)));
  }, 300_000);

  afterAll(async () => {
    for (const c of [agent, mailbox]) if (c) await c.close().catch(() => {});
    await pm.killAll();
    rmSync(work, { recursive: true, force: true });
    if (previousDisableAuto === undefined) delete process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
    else process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = previousDisableAuto;
  }, 30_000);

  let invoiceProposal = '';
  let previewShas: string[] = [];
  let previewSha = '';
  let issuedSha = '';
  let archivePath = '';
  let mailProposal = '';
  let ticketId = '';
  let emailAuthId = '';

  it('1. an invoicing mandate (review) and an email 0.9 mandate (review) allowing erp:invoice-pdf for the customer', async () => {
    await grant(INVOICING, INVOICING_KEYS, {
      profile: INVOICING, read_access: 'unlimited', invoice_net_max: 5000, credit_net_max: 5000,
      invoice_net_monthly_max: 20000, credit_net_monthly_max: 20000, invoice_daily_max: 10, credit_daily_max: 10,
    }, { currency: 'EUR' }, ['currency'], 'E2E: issue our invoices, each approved before it is issued.');
    emailAuthId = await grant(EMAIL_09, EMAIL_KEYS, emailBounds(EMAIL_09), {
      allowed_recipients: CUSTOMER_EMAIL, allowed_domains: CUSTOMER_DOMAIN, allowed_attachment_sources: 'erp:invoice-pdf',
    }, EMAIL_SCOPE_KEYS_09, 'E2E: send issued invoices to the customer, each email approved.');
    await new Promise((r) => setTimeout(r, 1_000));

    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toContain('erp__create_invoice');
    expect(names).toContain('mail__send_message');
    // The connector's document tools are internal: the gateway's, never the AI's.
    expect(names).not.toContain('erp__preview_invoice');
    expect(names).not.toContain('erp__get_document');
  });

  it('2. create_invoice becomes a proposal; the preview is the PDF as it will be issued, and consumes no number', async () => {
    const r = await call('erp__create_invoice', INVOICE_ARGS);
    expect(r.denied, r.text).toBe(false);
    expect(r.text).toMatch(/Awaiting commitment/);
    invoiceProposal = proposalIdOf(r.text);

    async function documentPreview() {
      const { status, body } = await cpGet(`/proposal-status/${invoiceProposal}/preview`);
      expect(status, JSON.stringify(body)).toBe(200);
      expect(body.status, JSON.stringify(body).slice(0, 600)).toBe('ok');
      const reads: any[] = body.reads ?? body.sections ?? [];
      const doc = reads.find((s) => s.kind === 'document');
      expect(doc, JSON.stringify(Object.keys(body))).toBeTruthy();
      expect(doc.tool).toBe('preview_invoice');
      expect(doc.result?.status, JSON.stringify(doc.result).slice(0, 400)).toBe('ok');
      const b = doc.result.body;
      return (b.structured ?? JSON.parse(b.text)) as { filename: string; contentType: string; contentBase64: string; sha256: string; pages: number };
    }

    const first = await documentPreview();
    expect(first.contentType).toBe('application/pdf');
    expect(first.filename).toContain(NUMBER);
    expect(first.pages).toBeGreaterThanOrEqual(1);
    const bytes = Buffer.from(first.contentBase64, 'base64');
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(first.sha256).toBe(sha256(bytes));
    previewSha = first.sha256;

    const second = await documentPreview();
    expect(second.pages).toBeGreaterThanOrEqual(1);
    previewShas = [first.sha256, second.sha256];

    // Two previews and still nothing issued, nothing archived: the number is free.
    const list = await call('erp__list_invoices', {});
    expect(list.denied, list.text).toBe(false);
    expect(Array.isArray(list.json) ? list.json : list.json?.invoices).toHaveLength(0);
    expect(existsSync(join(pm.getDataDir(), 'erp-local-archive'))).toBe(false);
  }, 60_000);

  it('3. approved → executed: the invoice is issued, with its archived PDF\'s fingerprint', async () => {
    await commit(invoiceProposal);
    const done = await awaitExecution(invoiceProposal);
    if (done.denied) console.error(`[INVOICE EMAIL E2E] step 3 refused at execution: ${done.text}\n  the two previews' sha256: ${previewShas.join(' / ')}`);
    expect(done.denied, done.text).toBe(false);
    const inv = resultJson(done.text);
    expect(inv.number).toBe(NUMBER);
    expect(inv.status).toBe('issued');
    expect(inv.net_total).toBe(1200);
    expect(inv.archive_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.ticket_id).toEqual(expect.any(String));
    issuedSha = inv.archive_sha256;
    archivePath = inv.archive_path;
    expect(sha256(readFileSync(archivePath))).toBe(issuedSha);
    // The issue time is printed on the PDF, so the issued file is a new render — not the preview's bytes.
    if (issuedSha !== previewSha) console.error('[INVOICE EMAIL E2E] note: issued PDF differs from the preview render (issue date/time printed).');
  }, 60_000);

  it('4. send_message with the invoice by reference becomes a proposal; the card shows it sealed, same file as issued, body as AI text', async () => {
    if (!issuedSha) {
      // Only while step 3 is red: issue the same invoice as the operator,
      // straight on the installed connector (no gateway), so steps 4–6 still
      // test the email half against a real issued, archived PDF.
      console.error('[INVOICE EMAIL E2E] step 3 did not issue the invoice — issuing it as the operator (no gateway) so steps 4–6 can run.');
      const erp = new Client({ name: 'operator-erp', version: '1.0.0' }, { capabilities: {} });
      const bin = join(pm.getDataDir(), 'integrations', 'node_modules', '@humanagencyp', 'erp-mcp', 'dist', 'index.js');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL') env[k] = v;
      await erp.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: {
        ...env, HAP_DATA_DIR: pm.getDataDir(), ERP_MODE: 'live', ERP_LIVE_ADAPTER: 'local', ERP_LIVE_COMPANY_FILE: COMPANY_FILE,
      } }));
      try {
        const r = await erp.callTool({ name: 'create_invoice', arguments: INVOICE_ARGS });
        const inv = JSON.parse((r.content as Array<{ text: string }>)[0].text);
        expect(r.isError, JSON.stringify(inv)).not.toBe(true);
        issuedSha = inv.archive_sha256;
        archivePath = inv.archive_path;
      } finally {
        await erp.close().catch(() => {});
      }
    }
    const before = await sentCount();
    const r = await call('mail__send_message', {
      to: [CUSTOMER_EMAIL], subject: `Rechnung ${NUMBER}`, body: MAIL_BODY, attachments: [ATTACHMENT_REF],
    });
    expect(r.denied, r.text).toBe(false);
    expect(r.text).toMatch(/Awaiting commitment/);
    mailProposal = proposalIdOf(r.text);
    expect(await sentCount()).toBe(before);

    const args = await cardArgs(mailProposal);
    // The proposal carries the reference's fingerprint, never bytes, and no reference arg.
    expect(args.attachments).toBeUndefined();
    expect(JSON.stringify(args)).not.toContain('contentBase64');
    const sealed = args._attachmentsSealed?.attachments;
    expect(sealed, JSON.stringify(args).slice(0, 500)).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ connector: 'erp', kind: 'invoice-pdf', id: NUMBER, contentType: 'application/pdf', sha256: issuedSha });
    expect(sealed[0].filename).toMatch(/\.pdf$/);
    expect(sealed[0].bytes).toBe(readFileSync(archivePath).length);

    // "Same file as issued": the live attachment preview re-reads the archive and matches the seal.
    const prev = await cpGet(`/proposal-status/${mailProposal}/attachment-preview/${issuedSha}`);
    expect(prev.status, JSON.stringify(prev.body).slice(0, 300)).toBe(200);
    expect(prev.body.status, JSON.stringify(prev.body).slice(0, 300)).toBe('ok');
    expect(prev.body.sha256).toBe(issuedSha);
    expect(sha256(Buffer.from(prev.body.contentBase64, 'base64'))).toBe(issuedSha);
    // A fingerprint that is not sealed on this proposal is never served.
    const other = await cpGet(`/proposal-status/${mailProposal}/attachment-preview/${'0'.repeat(64)}`);
    expect(other.status).toBe(404);

    // The body is the AI's own text — declared by the manifest, shown in its own box.
    const display = await cpGet('/tool-display');
    expect(display.status).toBe(200);
    expect(display.body.tools['mail__send_message'].aiTextArg).toBe('body');
    expect(args.body).toBe(MAIL_BODY);
  }, 60_000);

  it('5. approved → executed: the mailbox holds exactly the issued PDF; the ticket binds its fingerprint', async () => {
    expect(mailProposal, 'step 4 made no proposal').not.toBe('');
    const before = await sentCount();
    await commit(mailProposal);
    const done = await awaitExecution(mailProposal);
    expect(done.denied, done.text).toBe(false);
    const sent = resultJson(done.text);
    expect(await sentCount()).toBe(before + 1);

    const msg = await mailboxCall('get_message', { id: sent.id });
    expect(msg.to).toEqual([CUSTOMER_EMAIL]);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({ contentType: 'application/pdf', sha256: issuedSha });
    const file = await mailboxCall('get_attachment', { message_id: sent.id, sha256: issuedSha });
    const fileBytes = Buffer.from(file.contentBase64, 'base64');
    expect(sha256(fileBytes)).toBe(issuedSha);
    expect(fileBytes.equals(readFileSync(archivePath))).toBe(true);

    // The ticket (issued and signed by the AS) commits to the attachment's fingerprint.
    // The verification footer the gateway appended names the ticket; the AS lists it too.
    const { tickets } = await sp.getMyTicketsPage(apiKey, { limit: 100 });
    const mine = tickets.filter((t) => String(t.action).includes('send_message') && t.authorizationId === emailAuthId);
    expect(mine, JSON.stringify(tickets.map((t) => [t.action, t.authorizationId]))).toHaveLength(1);
    ticketId = String(mine[0].id);
    expect(msg.body).toContain(ticketId);
    const pub = await fetch(`${AS_URL}/api/as/public-receipt/${ticketId}`);
    const receipt = await pub.json() as any;
    expect(pub.status, JSON.stringify(receipt)).toBe(200);
    expect(receipt.signatureValid).toBe(true);
    expect(receipt.contentBinding?.fields).toContain('attachments');

    const binding = { version: '2', kind: 'jcs', fields: ['to', 'cc', 'subject', 'body', 'attachments'], required_fields: ['to', 'body'] } as const;
    const expected = selectBoundFields(binding as any, {
      to: [CUSTOMER_EMAIL], subject: `Rechnung ${NUMBER}`, body: MAIL_BODY,
      attachments: [{ filename: msg.attachments[0].filename, sha256: issuedSha }],
    });
    expect(receipt.contentHash).toBe(computeContentHash(binding as any, expected));
    // Any other file would not match what was signed.
    const forged = selectBoundFields(binding as any, {
      to: [CUSTOMER_EMAIL], subject: `Rechnung ${NUMBER}`, body: MAIL_BODY,
      attachments: [{ filename: msg.attachments[0].filename, sha256: 'f'.repeat(64) }],
    });
    expect(receipt.contentHash).not.toBe(computeContentHash(binding as any, forged));

    // The gateway's local ticket archive holds the bound content: fingerprints, never bytes.
    const ev = await cpGet(`/api/evidence/receipt/${ticketId}`);
    expect(ev.status, JSON.stringify(ev.body).slice(0, 300)).toBe(200);
    expect(ev.body.entry.boundContent.attachments).toEqual([{ filename: msg.attachments[0].filename, sha256: issuedSha }]);
    expect(JSON.stringify(ev.body.entry.boundContent)).not.toContain('contentBase64');
    // The ticket view's own attachment preview answers the same file.
    const tv = await cpGet(`/api/evidence/receipt/${ticketId}/attachment-preview/${issuedSha}`);
    expect(tv.body.status, JSON.stringify(tv.body).slice(0, 300)).toBe('ok');
  }, 90_000);

  describe('6. negatives', () => {
    const NEG = {
      a08: { domain: 'neg-a.example', to: 'ap@neg-a.example' },
      a09: { domain: 'neg-b.example', to: 'ap@neg-b.example' },
      b: { domain: 'neg-c.example', to: 'ap@neg-c.example' },
    };

    async function expectRefusedNothingProposedOrSent(args: Record<string, unknown>, pattern: RegExp) {
      const pendingBefore = (await pendingProposals()).length;
      const sentBefore = await sentCount();
      const r = await call('mail__send_message', args);
      expect(r.denied, r.text).toBe(true);
      expect(r.text).toMatch(pattern);
      expect((await pendingProposals()).length).toBe(pendingBefore);
      expect(await sentCount()).toBe(sentBefore);
      return r;
    }

    beforeAll(async () => {
      // Each mandate covers its own recipient domain only, so exactly one of
      // them passes the Gatekeeper for each call — no ordering, no revocation.
      await grant(EMAIL_08, EMAIL_KEYS, emailBounds(EMAIL_08),
        { allowed_recipients: NEG.a08.to, allowed_domains: NEG.a08.domain }, EMAIL_SCOPE_KEYS_08,
        'E2E: an email 0.8 mandate — it knows nothing of attachments.');
      await grant(EMAIL_09, EMAIL_KEYS, emailBounds(EMAIL_09),
        { allowed_recipients: NEG.a09.to, allowed_domains: NEG.a09.domain }, EMAIL_SCOPE_KEYS_09,
        'E2E: an email 0.9 mandate without allowed attachment sources.');
      await grant(EMAIL_09, EMAIL_KEYS, emailBounds(EMAIL_09),
        { allowed_recipients: NEG.b.to, allowed_domains: NEG.b.domain, allowed_attachment_sources: 'erp:delivery-note-pdf' }, EMAIL_SCOPE_KEYS_09,
        'E2E: an email 0.9 mandate allowing a document kind the erp connector does not declare.');
      await new Promise((r) => setTimeout(r, 1_000));
    }, 60_000);

    it('(a) an email 0.8 mandate: the attachment is refused — nothing proposed, nothing sent', async () => {
      await expectRefusedNothingProposedOrSent(
        { to: [NEG.a08.to], subject: 'Rechnung', body: 'Anbei die Rechnung.', attachments: [ATTACHMENT_REF] },
        /not allowed[\s\S]*does not yet declare "allowed_attachment_sources"/,
      );
    });

    it('(a) an email 0.9 mandate without allowed sources: the attachment is refused — nothing proposed, nothing sent', async () => {
      await expectRefusedNothingProposedOrSent(
        { to: [NEG.a09.to], subject: 'Rechnung', body: 'Anbei die Rechnung.', attachments: [ATTACHMENT_REF] },
        /"erp:invoice-pdf" is not in this mandate's "allowed_attachment_sources" \(\(none\)\)/,
      );
    });

    it('(b) a kind the connector does not declare: refused even where the mandate lists it', async () => {
      await expectRefusedNothingProposedOrSent(
        { to: [NEG.b.to], subject: 'Lieferschein', body: 'Anbei der Lieferschein.', attachments: [{ connector: 'erp', kind: 'delivery-note-pdf', id: NUMBER }] },
        /declares no document kind "delivery-note-pdf"/,
      );
      // And under the main mandate, a kind outside its allowed sources is refused by policy.
      await expectRefusedNothingProposedOrSent(
        { to: [CUSTOMER_EMAIL], subject: 'Gutschrift', body: 'Anbei.', attachments: [{ connector: 'erp', kind: 'credit-note-pdf', id: NUMBER }] },
        /allowed_attachment_sources: Values \[erp:credit-note-pdf\] not in authorized set \[erp:invoice-pdf\]|"erp:credit-note-pdf" is not in this mandate's "allowed_attachment_sources"/,
      );
    });

    it('(d) AI-supplied bytes are refused — on the reference, or as a file object', async () => {
      const pdf = readFileSync(archivePath).toString('base64');
      await expectRefusedNothingProposedOrSent(
        { to: [CUSTOMER_EMAIL], subject: 'Rechnung', body: 'Anbei.', attachments: [{ ...ATTACHMENT_REF, contentBase64: pdf }] },
        /contentBase64/,
      );
      await expectRefusedNothingProposedOrSent(
        { to: [CUSTOMER_EMAIL], subject: 'Rechnung', body: 'Anbei.', attachments: [{ filename: 'rechnung.pdf', contentType: 'application/pdf', contentBase64: pdf }] },
        /attachments|connector/i,
      );
    });

    it('(d) a `raw` MIME message from the AI never reaches the mailbox', async () => {
      const raw = Buffer.from(`To: ${CUSTOMER_EMAIL}\r\nSubject: x\r\n\r\nforged`).toString('base64url');
      const pendingBefore = (await pendingProposals()).length;
      const sentBefore = await sentCount();
      const r = await call('mail__send_message', { to: [CUSTOMER_EMAIL], subject: 'Rechnung', body: 'Anbei.', raw });
      if (r.denied) {
        expect((await pendingProposals()).length).toBe(pendingBefore);
      } else {
        // Not refused: then it must be dropped — the proposal carries no `raw`.
        const id = proposalIdOf(r.text);
        const args = await cardArgs(id);
        console.error(`[INVOICE EMAIL E2E] (d) raw was not refused on mail__send_message; proposal args keys: ${Object.keys(args).join(', ')}`);
        expect(args.raw).toBeUndefined();
        await reject(id);
      }
      expect(await sentCount()).toBe(sentBefore);
    });

    it('(c) the archived PDF altered on disk after approval: execution refused, nothing sent, outcome failed', async () => {
      const r = await call('mail__send_message', {
        to: [CUSTOMER_EMAIL], subject: `Rechnung ${NUMBER} (erneut)`, body: MAIL_BODY, attachments: [ATTACHMENT_REF],
      });
      expect(r.denied, r.text).toBe(false);
      const id = proposalIdOf(r.text);
      const sentBefore = await sentCount();

      await commit(id);
      // Right after approval, before the gateway's executor reads it: change one byte of the archive.
      const original = readFileSync(archivePath);
      const altered = Buffer.from(original);
      altered[altered.length - 2] = altered[altered.length - 2] ^ 0x01;
      writeFileSync(archivePath, altered);

      const done = await awaitExecution(id);
      expect(done.denied, done.text).toBe(true);
      expect(done.text).toMatch(/attachment "[^"]+\.pdf" \(erp:invoice-pdf\/2026-0001\)/);
      expect(done.text).toContain('Nothing was sent.');
      expect(await sentCount()).toBe(sentBefore);

      // The gateway's own journal: failed, because the document changed.
      const outcome = await cpGet(`/proposal-status/${id}/outcome`);
      expect(outcome.status).toBe(200);
      expect(outcome.body, JSON.stringify(outcome.body)).toMatchObject({ state: 'failed', outcome: 'changed' });
      // The card's live preview now says the file is not the sealed one.
      const prev = await cpGet(`/proposal-status/${id}/attachment-preview/${issuedSha}`);
      expect(prev.body.status).not.toBe('ok');

      writeFileSync(archivePath, original);
    }, 90_000);

    it.skip('payment link inserted into the body (Mollie) — needs a real Mollie account; no mocked Mollie (house rule)', () => {});
  });
});
