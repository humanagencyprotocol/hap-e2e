/**
 * Signed in means it works; when it cannot work, the gateway locks and says why.
 *
 * The failure this pins: the gateway reaches the Authority Server with a
 * session obtained at sign-in. That session ended after 24 hours, nothing
 * noticed, and the gateway kept looking signed in while every ticket request
 * failed with "Authentication required" — neither the user nor the agent knew
 * what to do. Now a gateway session lasts 30 days, can be ended on the server
 * (suspension, key change, sign-out), and the moment the server rejects it the
 * gateway locks itself and tells the agent to have the user sign in again.
 *
 * Real Authority Server, real gateway, real downstream MCP server. The gateway
 * gets ONLY a real 30-day gateway session (no API key), exactly as after a
 * normal sign-in, so the session path is what is tested. The session is then
 * ended on the server by signing it out. The 30-day clock itself is covered by
 * the gateway's unit tests with a simulated clock; this suite cannot wait.
 *
 * Like the outage suite, it first proves the same call succeeds, so a later
 * refusal cannot be mistaken for an unrelated failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ProcessManager } from '../src/helpers/process-manager';
import { SPClient } from '../src/helpers/sp-client';
import { GatewayClient } from '../src/helpers/gateway-client';
import { computeBoundsHash, hashGateContent, hashExecutionContext } from '../src/helpers/crypto';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles';

const SP_PORT = 16800;
const GW_PORT = 16830;
const SP_URL = `http://localhost:${SP_PORT}`;
const PROFILE = PROFILE_V07.customers;
const PROFILES_DIR = `${process.cwd()}/../hap-profiles`;

const pm = new ProcessManager();
let sp: SPClient;
let gw: GatewayClient;
let mcpClient: Client;
let apiKey: string;
let sessionToken: string;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(c => c.text ?? '').join(' ');
}

async function createContact(name: string) {
  return mcpClient.callTool({ name: 'crm__create_contact', arguments: { name, type: 'customer' } });
}

async function receiptCount(): Promise<number> {
  const page = await sp.getMyTicketsPage(apiKey);
  return (page as { tickets?: unknown[] }).tickets?.length ?? 0;
}

/** Sign in the way the gateway does: API key plus the gateway version header. */
async function gatewaySignIn(key: string): Promise<{ token: string; expiresAt: number; maxAge: number }> {
  const res = await fetch(`${SP_URL}/api/auth/session`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'x-suveren-gateway-version': '0.0.0-e2e' },
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token = /hap-session=([^;]+)/.exec(setCookie)?.[1];
  const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1] ?? NaN);
  expect(token, 'no hap-session cookie on a gateway sign-in').toBeTruthy();
  const body = await res.json() as { sessionExpiresAt?: number };
  return { token: token!, expiresAt: body.sessionExpiresAt ?? 0, maxAge };
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  sp = new SPClient(SP_URL);

  const user = await sp.register('SessionUser', `session-${Date.now()}@test.com`);
  apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({
    port: GW_PORT,
    spUrl: SP_URL,
    // NO API key: with SUVEREN_AS_API_KEY set, the gateway sends X-API-Key on
    // every AS call and the server falls back to the key when the session
    // ends, which would make this suite prove nothing. Session only.
    spApiKey: '',
    profilesDir: `${process.cwd()}/../hap-profiles`,
  });
  gw = new GatewayClient(`http://localhost:${GW_PORT}`);

  sessionToken = (await gatewaySignIn(apiKey)).token;
  await gw.configure({ sessionCookie: `hap-session=${sessionToken}` });

  const bounds = {
    profile: PROFILE, read_access: 'unlimited', export_access: 'none',
    write_daily_max: 50, delete_daily_max: 5, setup_daily_max: 0,
  };
  const boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max']);
  const contextHash = computeBoundsHash({}, []);
  const att = await sp.submitMandate(apiKey, {
    profile_id: PROFILE,
    profile_hash: profileHashFor(PROFILE, PROFILES_DIR),
    group_id: groupId,
    domain: 'owner',
    did: user.user.did,
    bounds,
    bounds_hash: boundsHash,
    scope_hash: contextHash,
    gate_content_hashes: hashGateContent({ intent: 'session test' }),
    execution_context_hash: hashExecutionContext({ profile: PROFILE, domain: 'owner' }),
    commitment_mode: 'automatic',
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
    PROFILE,
    { intent: 'session test' },
  );

  await gw.addIntegration({
    id: 'crm',
    name: 'CRM',
    command: 'npx',
    args: ['-y', '@humanagencyp/crm-mcp@1.4.1'],
    envKeys: {},
    profile: 'customers',
    enabled: true,
    toolGating: {
      default: { executionMapping: {}, staticExecution: { contact_type: 'customer' } },
      overrides: {
        create_contact: { executionMapping: { type: 'contact_type' }, staticExecution: { action_type: 'write' } },
        find_contacts: { category: 'read', readGovernance: 'none' },
      },
    },
  });
  await gw.waitForIntegration('crm');

  const transport = new SSEClientTransport(new URL(`http://localhost:${GW_PORT}/sse`));
  mcpClient = new Client({ name: 'session-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* */ } }
  await pm.killAll();
});

describe('Gateway sign-in: 30 days, and a visible lock when it ends', () => {
  it('a gateway sign-in gets a 30-day session; a browser sign-in keeps 24 hours', async () => {
    const gwSession = await gatewaySignIn(apiKey);
    expect(gwSession.maxAge).toBe(30 * 24 * 60 * 60);
    expect(gwSession.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 24 * 60 * 60);

    const browser = await fetch(`${SP_URL}/api/auth/session`, { method: 'POST', headers: { 'X-API-Key': apiKey } });
    expect(browser.status).toBe(200);
    expect(Number(/Max-Age=(\d+)/i.exec(browser.headers.get('set-cookie') ?? '')?.[1])).toBe(24 * 60 * 60);
  });

  it('positive control: a gated write succeeds on the session alone', async () => {
    const before = await receiptCount();
    const result = await createContact('Before Session End');
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await receiptCount()).toBe(before + 1);
  }, 60_000);

  it('once the server ends the session, the next write is refused with a sign-in instruction, and nothing runs', async () => {
    // End the session on the server, as a suspension, key change or sign-out would.
    const out = await fetch(`${SP_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `hap-session=${sessionToken}` },
      redirect: 'manual',
    });
    expect([200, 302, 303, 307, 308]).toContain(out.status);

    const before = await receiptCount();
    const result = await createContact('After Session End');
    const text = textOf(result);

    expect(result.isError, 'the write ran on an ended session').toBe(true);
    // The agent is told what happened and what the user must do, not
    // "Authentication required".
    expect(text).toMatch(/LOCKED/);
    expect(text.toLowerCase()).toMatch(/sign(ed)?[- ]?in|api key/);
    expect(text).not.toMatch(/Authentication required/);
    expect(await receiptCount(), 'a ticket was issued on an ended session').toBe(before);
  }, 60_000);

  it('stays locked: the following call is refused the same way, without asking the server again', async () => {
    const result = await createContact('Still After Session End');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/LOCKED/);
  }, 60_000);
});
