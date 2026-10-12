/**
 * Tools always listed (gateway "tools always listed"), on the real stack: real
 * Authority Server, the gateway, the published CRM connector.
 *
 * Many AI clients (ChatGPT among them) ignore `tools/list_changed` and keep the
 * tool list they got when the chat started. Here the client lists tools ONCE,
 * before any mandate exists, and never again:
 *   - the CRM tools are in that list; the setup tools are not;
 *   - a call without a mandate is refused with a text that says what to do,
 *     and recorded under Blocked (not_authorized) — nothing ran;
 *   - list-authorizations says the tools are listed but not usable yet;
 *   - the person grants a mandate mid-session → the same call, from the
 *     original list, now succeeds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';
import { profileHashFor } from '../src/helpers/profiles.js';

const SP_PORT = 19850;
const GW_PORT = 19851;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = process.env.HAP_E2E_PROFILES_DIR ?? join(ROOT, 'hap-profiles');

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/customers@0.9';
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'];
const SCOPE = { contact_type: 'customer' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let apiKey: string;
let groupId: string;
let did: string;
let agent: Client;
/** The one and only tool list this client ever fetched. */
let firstList: string[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(name: string, args: Record<string, unknown>) {
  const r = await agent.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { error: r.isError === true, text };
}

interface DenialRecord { ts: number; kind: string; who: string; code?: string; integrationId?: string; tool?: string }
function readDenials(): DenialRecord[] {
  const path = join(pm.getDataDir(), 'denials.json');
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf-8')) as { records?: DenialRecord[] };
  return [...(data.records ?? [])].sort((a, b) => b.ts - a.ts);
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  const reg = await sp.register('Tools Always Listed E2E', `tools-listed-${Date.now()}@test.local`);
  apiKey = reg.apiKey;
  did = reg.user.did;
  groupId = await sp.getPersonalGroupId(apiKey);
  // signIn: false — sign-in unlocks the vault, and denials.json (read below) would be encrypted.
  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR, signIn: false });
  await gw.configure({ sessionCookie: 'tools-always-listed-e2e', apiKey });
  await gw.waitForIntegration('crm');
  await sleep(2_000);
  agent = new Client({ name: 'tools-always-listed-e2e', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}, 300_000);

afterAll(async () => {
  if (agent) { try { await agent.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

describe('tools always listed — the client lists once, the mandate comes later (real AS + gateway + crm-mcp)', () => {
  it('with no mandate at all, the CRM tools are listed and the setup tools are not', async () => {
    firstList = (await agent.listTools()).tools.map((t) => t.name);
    for (const t of ['crm__create_contact', 'crm__update_contact', 'crm__get_contact', 'crm__find_contacts']) expect(firstList).toContain(t);
    expect(firstList.some((n) => n.startsWith('setup__'))).toBe(false);
    expect(firstList.some((n) => /describe_.*_proposal/.test(n))).toBe(false);
  });

  it('the description says a mandate is needed', async () => {
    // Same server, same session: read the description from the one list we have.
    const tools = (await agent.listTools()).tools;
    const d = tools.find((t) => t.name === 'crm__create_contact')!.description ?? '';
    expect(d).toContain('works only under a customers mandate, check list-authorizations');
  });

  it('a call without a mandate is refused with what to do, recorded under Blocked — nothing ran', async () => {
    const before = readDenials().length;
    const r = await call('crm__create_contact', { name: 'Maria Huber', type: 'customer' });
    expect(r.error, r.text).toBe(true);
    expect(r.text).toBe(
      'Refused: no mandate covers crm__create_contact (customers). Nothing was done. ' +
        'Ask the person to grant a customers mandate in the gateway, then try again. No ticket was requested.',
    );
    const denials = readDenials();
    expect(denials.length).toBe(before + 1);
    expect(denials[0]).toMatchObject({ kind: 'not_authorized', who: 'gateway', code: 'NO_MATCHING_MANDATE', integrationId: 'crm' });
  });

  it('list-authorizations says the CRM tools are listed but not usable yet', async () => {
    const r = await call('list-authorizations', {});
    expect(r.text).toContain('no tool is usable yet');
    expect(r.text).toContain('Listed but not usable yet');
    expect(r.text).toMatch(/customers: .*crm__create_contact/);
    expect(r.text).not.toMatch(/describe_.*_proposal/);
  });

  it('the person grants a mandate mid-session — the same call from the original list now succeeds', async () => {
    const full = { profile: PROFILE_ID, read_access: 'unlimited', export_access: 'none', write_daily_max: 5, delete_daily_max: 0, setup_daily_max: 0 };
    const boundsHash = computeBoundsHash(full, BOUNDS_KEY_ORDER);
    const scopeHash = computeScopeHash(SCOPE, ['contact_type']);
    const gate = { intent: 'E2E: create customer records.' };
    const att = await sp.submitMandate(apiKey, {
      profile_id: PROFILE_ID, profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR), group_id: groupId,
      bounds: full, bounds_hash: boundsHash, scope_hash: scopeHash,
      domain: 'owner', did, commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ mode: 'automatic' }),
    });
    await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash: scopeHash, context: SCOPE }, PROFILE_ID, gate);

    // No listTools() from here on: the client keeps its first list, as ChatGPT does.
    expect(firstList).toContain('crm__create_contact');
    let r = { error: true, text: '' };
    for (let i = 0; i < 10 && r.error; i++) {
      r = await call('crm__create_contact', { name: 'Maria Huber', type: 'customer', company: 'Huber Agrar' });
      if (r.error && /no mandate covers/.test(r.text)) await sleep(1_000); else break;
    }
    expect(r.error, r.text).toBe(false);
    expect(r.text).toMatch(/Maria Huber/);
  }, 60_000);
});
