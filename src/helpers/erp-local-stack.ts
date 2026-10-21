/**
 * The real stack for ERP Local in production (hap-erp-mcp
 * docs/local-production-contract.md): Authority Server + the whole gateway
 * (control plane + MCP server) + the erp connector in live mode "local" (real
 * company file, real SQLite, real PDFs, write-once archive) + the email
 * connector (simulated mailbox). Nothing is mocked. The ONLY stand-in is the
 * EU VIES service (vies-stub.ts), reached through the connector's own
 * `ERP_VIES_URL` setting.
 *
 * How ERP_VIES_URL reaches the connector: through the connector's own setting,
 * erp.json's "VAT-ID check address" field (`viesUrl` → ERP_VIES_URL), saved in
 * the vault and activated the way the gateway UI does it — no workaround.
 *
 * Shared by test/erp-local-production.test.ts (vitest) and
 * e2e/erp-local-production.spec.ts (Playwright, the card in a browser).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ProcessManager } from './process-manager.js';
import { SPClient } from './sp-client.js';
import { GatewayClient } from './gateway-client.js';
import { ControlPlaneClient, GW_DIR, PROFILES_DIR } from './gateway-stack.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from './crypto.js';
import { profileHashFor } from './profiles.js';

export const ERP_MANIFEST_PATH = join(GW_DIR, 'content', 'integrations', 'erp.json');
export const P = 'github.com/humanagencyprotocol/hap-profiles';

/** Placeholder company — an Austrian sole trader, invented throughout (MUSTER data). */
export const COMPANY = {
  name: 'Muster Beratung e.U.', owner: 'Maria Muster',
  address: { street: 'Musterstraße 1', zip: '1010', city: 'Wien', country: 'Österreich', country_code: 'AT' },
  uid: 'ATU99999999', email: 'office@muster-beratung.example', web: 'https://muster-beratung.example',
  register: null, bank: { name: 'Musterbank AG', iban: 'AT611904300234573201', bic: 'MUSTATWWXXX' },
  default_payment_term_days: 14, vat_mode: 'normal',
};

/** Today in the connector's default timezone — documents must be dated today. */
export const TODAY_VIENNA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

export function readProfile(profileId: string): any {
  const index = JSON.parse(readFileSync(join(PROFILES_DIR, 'index.json'), 'utf8')) as { profiles: Record<string, string> };
  const rel = index.profiles[profileId];
  if (!rel) throw new Error(`${profileId} is not in ${PROFILES_DIR}/index.json`);
  return JSON.parse(readFileSync(join(PROFILES_DIR, rel), 'utf8'));
}

export interface CallResult { denied: boolean; text: string; json: any }

export interface ErpLocalStackOptions {
  asPort: number;
  mcpPort: number;
  cpPort: number;
  viesUrl: string;
  /** Called with the gateway data dir BEFORE the gateway starts (e.g. to put a fixture DB in place). */
  beforeGateway?: (dataDir: string) => void | Promise<void>;
  label: string;
  /** Activate the email connector (simulated mailbox) too. */
  mail?: boolean;
}

export class ErpLocalStack {
  readonly pm = new ProcessManager();
  readonly sp: SPClient;
  readonly gw: GatewayClient;
  readonly cp: ControlPlaneClient;
  readonly asUrl: string;
  readonly cpUrl: string;
  readonly mcpUrl: string;
  apiKey = '';
  did = '';
  userId = '';
  groupId = '';
  agent!: Client;
  mailbox: Client | null = null;
  companyFile = '';
  private previousDisableAuto: string | undefined;

  constructor(readonly opts: ErpLocalStackOptions) {
    this.asUrl = `http://localhost:${opts.asPort}`;
    this.cpUrl = `http://localhost:${opts.cpPort}`;
    this.mcpUrl = `http://localhost:${opts.mcpPort}`;
    this.sp = new SPClient(this.asUrl);
    this.gw = new GatewayClient(this.mcpUrl);
    this.cp = new ControlPlaneClient(this.cpUrl);
  }

  get dataDir(): string { return this.pm.getDataDir(); }

  async start(): Promise<void> {
    this.previousDisableAuto = process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
    process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = '1';

    this.pm.buildGateway();
    await this.pm.startSP(this.opts.asPort);
    const reg = await this.sp.register(`ERP Local ${this.opts.label}`, `erp-local-${this.opts.label}-${Date.now()}@test.local`);
    this.apiKey = reg.apiKey;
    this.did = reg.user.did;
    this.userId = String((reg.user as { id?: string }).id ?? '');
    this.groupId = await this.sp.getPersonalGroupId(this.apiKey);

    await this.opts.beforeGateway?.(this.dataDir);
    await this.pm.startGateway({ port: this.opts.mcpPort, cpPort: this.opts.cpPort, spUrl: this.asUrl, spApiKey: this.apiKey, profilesDir: PROFILES_DIR });
    await this.gw.configure({ sessionCookie: `erp-local-${this.opts.label}`, apiKey: this.apiKey });

    // The person's own connector settings, saved the way the gateway UI saves them.
    this.companyFile = join(this.dataDir, 'company.json');
    writeFileSync(this.companyFile, JSON.stringify(COMPANY, null, 2));
    const put = await this.cp.authed(this.apiKey, 'PUT', '/vault/credentials/erp', {
      mode: 'live', liveAdapter: 'local', companyFile: this.companyFile, viesUrl: this.opts.viesUrl,
    });
    if (put.status !== 200) throw new Error(`vault PUT erp: ${put.status} ${await put.text()}`);
    const act = await this.cp.authed(this.apiKey, 'POST', '/mcp/integrations/erp/activate');
    if (act.status !== 200) throw new Error(`activate erp: ${act.status} ${await act.text()}`);
    await this.gw.waitForIntegration('erp');

    if (this.opts.mail) {
      const res = await this.cp.authed(this.apiKey, 'POST', '/mcp/integrations/mail/activate');
      if (res.status !== 200) throw new Error(`activate mail: ${res.status} ${await res.text()}`);
      await this.gw.waitForIntegration('mail');
      const mailBin = join(this.dataDir, 'integrations', 'node_modules', '@humanagencyp', 'email-mcp', 'dist', 'index.js');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL') env[k] = v;
      this.mailbox = new Client({ name: 'operator-mailbox', version: '1.0.0' }, { capabilities: {} });
      await this.mailbox.connect(new StdioClientTransport({ command: process.execPath, args: [mailBin], env: { ...env, HAP_DATA_DIR: this.dataDir }, stderr: 'ignore' }));
    }

    await new Promise((r) => setTimeout(r, 1_000));
    this.agent = new Client({ name: `erp-local-agent-${this.opts.label}`, version: '1.0.0' }, { capabilities: {} });
    await this.agent.connect(new SSEClientTransport(new URL(`${this.mcpUrl}/sse`)));
  }

  async stop(): Promise<void> {
    for (const c of [this.agent, this.mailbox]) if (c) await c.close().catch(() => {});
    await this.pm.killAll();
    if (this.previousDisableAuto === undefined) delete process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
    else process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = this.previousDisableAuto;
  }

  // ── the agent's side ────────────────────────────────────────────────────

  async call(tool: string, args: Record<string, unknown>): Promise<CallResult> {
    const r = await this.agent.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
    const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { denied: r.isError === true, text, json };
  }

  // ── the Authority Server (the approver's side) ──────────────────────────

  async asApi(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.asUrl}${path}`, {
      method, headers: { 'X-API-Key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async pendingProposals(): Promise<Array<{ id: string; tool: string; status: string }>> {
    return ((await this.asApi('GET', '/api/proposals?domain=owner')).body.proposals ?? [])
      .filter((p: { status: string }) => p.status === 'pending');
  }

  async commit(proposalId: string): Promise<void> {
    const r = await this.asApi('POST', `/api/proposals/${proposalId}/resolve`, { action: 'commit', domain: 'owner' });
    if (r.status >= 300) throw new Error(`commit ${proposalId}: ${r.status} ${JSON.stringify(r.body)}`);
  }

  async reject(proposalId: string): Promise<void> {
    await this.asApi('POST', `/api/proposals/${proposalId}/resolve`, { action: 'reject', domain: 'owner' });
  }

  /** After approval: the gateway's executor (poll or this call) runs it once. */
  async awaitExecution(proposalId: string): Promise<CallResult> {
    const until = Date.now() + 60_000;
    let last: CallResult = { denied: false, text: '', json: null };
    while (Date.now() < until) {
      last = await this.call('check-pending-commitments', { proposal_id: proposalId });
      if (/executed|refused|failed|nothing was done|Refused/i.test(last.text) && !/Awaiting|pending/i.test(last.text.split('\n')[0])) return last;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return last;
  }

  /** Approve and wait for the execution outcome. */
  async approve(proposalId: string): Promise<CallResult> {
    await this.commit(proposalId);
    return this.awaitExecution(proposalId);
  }

  /**
   * A review-mode mandate under `profileId` with the given bounds and scope;
   * key orders come from the profile file itself.
   */
  async grant(profileId: string, bounds: Record<string, unknown>, scope: Record<string, string>, intent: string,
    mode: 'review' | 'automatic' | 'review_above_cap' = 'review'): Promise<string> {
    const r = await this.submitMandate(profileId, bounds, scope, intent, mode);
    if (r.status !== 201 && r.status !== 200) throw new Error(`mandate ${profileId} (${mode}): ${r.status} ${JSON.stringify(r.body)}`);
    const authorizationId = String(r.body.authorization_id);
    const doc = readProfile(profileId);
    const scopeKeys: string[] = doc.scopeSchema?.keyOrder ?? doc.contextSchema?.keyOrder ?? [];
    await this.gw.pushGateContent({
      authorizationId, boundsHash: computeBoundsHash(bounds, doc.boundsSchema.keyOrder),
      contextHash: computeScopeHash(scope, scopeKeys), context: scope,
    }, profileId, { intent });
    return authorizationId;
  }

  /** The raw mandate request (never throws) — for refusal tests. */
  async submitMandate(profileId: string, bounds: Record<string, unknown>, scope: Record<string, string>, intent: string,
    mode: 'review' | 'automatic' | 'review_above_cap', extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, any> }> {
    const doc = readProfile(profileId);
    const scopeKeys: string[] = doc.scopeSchema?.keyOrder ?? doc.contextSchema?.keyOrder ?? [];
    const gate = { intent };
    return this.sp.submitMandateRaw(this.apiKey, {
      authorization_id: `authz_${randomUUID()}`,
      profile_id: profileId, profile_hash: profileHashFor(profileId, PROFILES_DIR), group_id: this.groupId,
      bounds, bounds_hash: computeBoundsHash(bounds, doc.boundsSchema.keyOrder),
      scope_hash: computeScopeHash(scope, scopeKeys), domain: 'owner', did: this.did,
      commitment_mode: mode, gate_content_hashes: hashGateContent(gate),
      execution_context_hash: hashExecutionContext({ intent }),
      ...extra,
    });
  }

  // ── the gateway's own surfaces (what the approval card reads) ───────────

  async cpGet(path: string): Promise<{ status: number; body: any }> {
    const res = await this.cp.authed(this.apiKey, 'GET', path);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** GET /proposal-status/:id/preview — the card's reads and its checks line. */
  async cardPreview(proposalId: string): Promise<{ status: string; reads: any[]; checks: any[]; raw: any }> {
    const { status, body } = await this.cpGet(`/proposal-status/${proposalId}/preview`);
    if (status !== 200) throw new Error(`preview ${proposalId}: ${status} ${JSON.stringify(body)}`);
    return { status: body.status, reads: body.reads ?? body.sections ?? [], checks: body.checks ?? [], raw: body };
  }

  /** The proposal's own args as the approval card reads them (decrypted on this gateway). */
  async cardArgs(proposalId: string): Promise<Record<string, any>> {
    const { body } = await this.asApi('GET', `/api/proposals/${proposalId}`);
    const p = body.proposal;
    if (p.toolArgs) return p.toolArgs;
    const res = await this.cp.authed(this.apiKey, 'POST', '/api/decrypt-proposal-content', p.content);
    const dec = await res.json() as { plaintext?: string; error?: string };
    if (res.status !== 200) throw new Error(`decrypt ${proposalId}: ${JSON.stringify(dec)}`);
    return JSON.parse(dec.plaintext!);
  }

  /** The owner's "Blocked" list (GET /denials, decrypted by the control plane). */
  async blocked(): Promise<any[]> {
    const { status, body } = await this.cpGet('/denials?limit=500');
    if (status !== 200) throw new Error(`/denials: ${status} ${JSON.stringify(body)}`);
    return body.records ?? [];
  }

  // ── the simulated mailbox, the operator's own view ──────────────────────

  async mailboxCall(tool: string, args: Record<string, unknown>): Promise<any> {
    if (!this.mailbox) throw new Error('mail not started');
    const r = await this.mailbox.callTool({ name: tool, arguments: args });
    const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
    if (r.isError) throw new Error(`mailbox ${tool}: ${text}`);
    return JSON.parse(text);
  }
}

export function proposalIdOf(text: string): string {
  const m = text.match(/Proposal ID:\s*([^\s.]+)/);
  if (!m) throw new Error(`no "Proposal ID: ..." line in: ${text}`);
  return m[1];
}

export function resultJson(text: string): any {
  const i = text.indexOf('Result:');
  if (i < 0) throw new Error(`no "Result:" in: ${text}`);
  // The gateway may append lines after the JSON (e.g. a note for the agent):
  // parse exactly the first balanced JSON value that follows "Result:".
  const rest = text.slice(i + 'Result:'.length).trimStart();
  let depth = 0, inStr = false, esc = false;
  for (let k = 0; k < rest.length; k++) {
    const c = rest[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return JSON.parse(rest.slice(0, k + 1)); }
  }
  return JSON.parse(rest);
}
