/**
 * The AI proposes its own agent brief; a person approves (simulation setup S4 + S7),
 * on the real stack: real Authority Server, real gateway in simulation mode, the
 * shipped delegation@0.1 profile.
 *
 * What must hold:
 * - delegation is review only: the AS refuses to sign an automatic mandate on it;
 * - without a delegation mandate the brief tool is not listed, and a call is
 *   refused — no proposal, no ticket;
 * - with one, a call only becomes a proposal; the brief (context.md) is unchanged
 *   until a person approves; after approval it is replaced and the next session's
 *   instructions carry it;
 * - a rejected proposal changes nothing;
 * - a brief over 16 KB is refused at the call — no proposal is created.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 18400;
const GW_PORT = 18401;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const DELEGATION = 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1';
const KEYS = ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max'];
const available = existsSync(join(PROFILES_DIR, 'delegation', '0.1.profile.json'));

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
let apiKey: string;
let did: string;
let groupId: string;
let mcpClient: Client;
const prevEnv = { sim: process.env.SUVEREN_SIMULATION, auto: process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS };

const brief = () => {
  const p = join(pm.getDataDir(), 'context.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

function delegationBody(commitment_mode: 'review' | 'automatic') {
  const bounds = { profile: DELEGATION, read_access: 'unlimited', brief_daily_max: 3, mandate_daily_max: 0 };
  return {
    bounds,
    boundsHash: computeBoundsHash(bounds, KEYS),
    contextHash: computeContextHash({}, []),
    gate: { intent: `E2E delegation (${commitment_mode})` },
    commitment_mode,
  };
}

async function reconnect() {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 2_000));
  mcpClient = new Client({ name: 'setup-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text };
}

/** Pending proposals in this personal workspace (its domain is 'owner'). */
async function proposals(): Promise<Array<{ id: string; status: string; tool: string }>> {
  const res = await fetch(`${SP_URL}/api/proposals?domain=owner`, { headers: { 'X-API-Key': apiKey } });
  const body = await res.json() as { proposals?: Array<{ id: string; status: string; tool: string }> };
  return body.proposals ?? [];
}

async function resolve(id: string, action: 'commit' | 'reject') {
  const res = await fetch(`${SP_URL}/api/proposals/${id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ action, domain: 'owner' }),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
}

async function waitFor(check: () => boolean, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!available)('delegation: the AI proposes its agent brief, a person approves (real AS + gateway)', () => {
  beforeAll(async () => {
    process.env.SUVEREN_SIMULATION = '1';
    process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = '1';
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('Delegation E2E', `delegation-${Date.now()}@test.local`);
    apiKey = reg.apiKey; did = reg.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);
    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'delegation-e2e', apiKey });
    writeFileSync(join(pm.getDataDir(), 'context.md'), '# Old brief');
    await reconnect();
  }, 300_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
    process.env.SUVEREN_SIMULATION = prevEnv.sim;
    process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS = prevEnv.auto;
    if (prevEnv.sim === undefined) delete process.env.SUVEREN_SIMULATION;
    if (prevEnv.auto === undefined) delete process.env.SUVEREN_DISABLE_AUTO_INTEGRATIONS;
  }, 30_000);

  it('without a delegation mandate the brief tool is not listed, and a call is refused — no proposal', async () => {
    const names = (await mcpClient.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('setup__set_agent_brief');
    const r = await call('setup__set_agent_brief', { content: '# Sneaky brief' });
    expect(r.denied).toBe(true);
    expect(await proposals()).toHaveLength(0);
    expect(brief()).toBe('# Old brief');
  });

  it('the AS refuses an automatic delegation mandate (review only)', async () => {
    const d = delegationBody('automatic');
    const r = await sp.submitAttestationRaw(apiKey, {
      authorization_id: `authz_${randomUUID()}`, profile_id: DELEGATION, group_id: groupId,
      bounds: d.bounds, bounds_hash: d.boundsHash, context_hash: d.contextHash, domain: 'owner', did,
      commitment_mode: 'automatic', gate_content_hashes: hashGateContent(d.gate),
      execution_context_hash: hashExecutionContext({ m: 'automatic' }),
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('commitment_mode_not_allowed');
  });

  it('with a review delegation mandate the tool is listed', async () => {
    const d = delegationBody('review');
    const att = await sp.submitAttestation(apiKey, {
      profile_id: DELEGATION, group_id: groupId, bounds: d.bounds, bounds_hash: d.boundsHash,
      context_hash: d.contextHash, domain: 'owner', did, commitment_mode: 'review',
      gate_content_hashes: hashGateContent(d.gate), execution_context_hash: hashExecutionContext({ m: 'review' }),
    });
    await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash: d.boundsHash, contextHash: d.contextHash, context: {} }, DELEGATION, d.gate);
    await reconnect();
    expect((await mcpClient.listTools()).tools.map((t) => t.name)).toContain('setup__set_agent_brief');
  });

  it('a brief over 16 KB is refused at the call — no proposal', async () => {
    const r = await call('setup__set_agent_brief', { content: 'x'.repeat(16 * 1024 + 1) });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/limit is 16384/);
    expect(await proposals()).toHaveLength(0);
  });

  it('a call becomes a proposal; the brief is unchanged until a person approves; then the next session carries it', async () => {
    const r = await call('setup__set_agent_brief', { content: '# New brief\n\nAnswer quote requests the same day.' });
    expect(r.denied, r.text).toBe(false);
    expect(r.text).toMatch(/Awaiting commitment/);
    const [p] = await proposals();
    expect(p).toMatchObject({ tool: 'setup__set_agent_brief', status: 'pending' });
    expect(brief()).toBe('# Old brief');

    await resolve(p.id, 'commit');
    await waitFor(() => brief() !== '# Old brief');
    expect(brief()).toBe('# New brief\n\nAnswer quote requests the same day.');

    await reconnect();
    expect(mcpClient.getInstructions()).toContain('Answer quote requests the same day.');
  }, 60_000);

  it('a rejected proposal changes nothing', async () => {
    const r = await call('setup__set_agent_brief', { content: '# Rejected brief' });
    expect(r.text).toMatch(/Awaiting commitment/);
    const p = (await proposals()).find((x) => x.status === 'pending')!;
    await resolve(p.id, 'reject');
    await new Promise((res) => setTimeout(res, 7_000)); // one executor poll
    expect(brief()).toBe('# New brief\n\nAnswer quote requests the same day.');
  }, 30_000);
});
