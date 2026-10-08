/**
 * The gateway trusts only the Authority Server key it paired with.
 *
 * At sign-in the gateway fetches the AS's public key and pins it next to the
 * AS URL (<dataDir>/as-pairing.json). From then on a different key at that URL
 * means "this is not the server we paired with" — whether an operator rebuilt
 * their AS with a new key or something else is answering on the network — and
 * the gateway must stop and say why:
 *
 *   - a gated action is refused and the downstream tool is never called;
 *   - the gateway locks itself, with a reason;
 *   - signing in again is refused (409 as_key_mismatch) rather than silently
 *     re-pinning.
 *
 * Real Authority Server (restarted on the SAME port with a DIFFERENT signing
 * key), real control plane + MCP server, real records connector. The side-effect
 * oracle is the records connector's own database, read by a separate process.
 *
 * The substituted server here is internally consistent: it holds its own valid
 * mandate for the same operator, signed with its own key, and accepts the
 * gateway's credentials — everything a server at that URL controls — and it is what
 * makes the refusal meaningful — without the pin, every signature it hands out
 * verifies against the key it also hands out.
 *
 * Two harness choices, stated so nobody mistakes them for the product path:
 *  - The MCP server is restarted after the swap. It caches the AS key for five
 *    minutes; the restart stands in for that expiry (and for a reboot).
 *  - After that restart the MCP server is given the operator's API key over the
 *    internal channel, standing in for "the substituted server accepts whatever
 *    credentials the gateway presents". A fresh in-memory AS knows no sessions,
 *    so without it every call would fail on authentication, not on the key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ProcessManager } from '../src/helpers/process-manager';
import { SPClient } from '../src/helpers/sp-client';
import { GatewayClient } from '../src/helpers/gateway-client';
import {
  ROOT, RECORDS_DIST, RECORDS_INTEGRATION, RECORDS_PROFILE_ID, SEED_API_KEY, SEED_DID,
  ControlPlaneClient, asKeyEnv, ed25519Keypair, grantRecordsMandate, newSecret,
  readPairingFile, recordTitles, seedOperatorGroup, sleep, startControlPlane, startMcpServer, textOf,
  type StackOptions,
} from '../src/helpers/gateway-stack';

const AS_PORT = 18100;
const CP_PORT = 18101;
const MCP_PORT = 18102;
const AS_URL = `http://localhost:${AS_PORT}`;

const PAIRED_KEY = ed25519Keypair();
const OTHER_KEY = ed25519Keypair();

const pm = new ProcessManager();
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-pin-'));
const stack: StackOptions = { dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL };
const sp = new SPClient(AS_URL);
const cp = new ControlPlaneClient(`http://localhost:${CP_PORT}`);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);
let agent: Client | null = null;
let otherGroupId = '';

async function connectAgent(): Promise<Client> {
  const client = new Client({ name: 'hap-e2e-pin-agent', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  return client;
}

async function createRecord(title: string) {
  return agent!.callTool({ name: 'records__create_record', arguments: { type: 'note', title, content: 'as-key-pinning e2e' } });
}

async function ticketCount(): Promise<number> {
  return (await sp.getMyTicketsPage(SEED_API_KEY)).tickets.length;
}

async function ensureRecordsIntegration(): Promise<void> {
  const present = (await mcpInternal.integrations()).some((i) => i.id === 'records');
  if (!present) await mcpInternal.addIntegration(RECORDS_INTEGRATION);
  await mcpInternal.waitForIntegration('records');
}

async function pubkeyOf(url: string): Promise<string> {
  return ((await (await fetch(`${url}/api/as/pubkey`)).json()) as { publicKey: string }).publicKey;
}

beforeAll(async () => {
  if (!existsSync(RECORDS_DIST)) {
    execSync('npm run build', { cwd: join(ROOT, 'hap-records-mcp'), stdio: 'pipe', timeout: 120_000 });
  }
  pm.buildGateway();
  await pm.startSP(AS_PORT, { env: asKeyEnv(PAIRED_KEY) });
  expect(await pubkeyOf(AS_URL)).toBe(PAIRED_KEY.publicKeyHex);
  await startControlPlane(pm, stack);
  await startMcpServer(pm, stack);
}, 180_000);

afterAll(async () => {
  if (agent) await agent.close().catch(() => {});
  await pm.killAll();
  rmSync(dataDir, { recursive: true, force: true });
}, 30_000);

describe('Sign-in pins the Authority Server key', () => {
  it('pins the key the Authority Server presents, for that URL', async () => {
    const login = await cp.login(SEED_API_KEY);
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    const pairing = readPairingFile(dataDir);
    expect(pairing, 'sign-in left no pairing record').not.toBeNull();
    expect(pairing!.asUrl).toBe(AS_URL);
    expect(pairing!.publicKeyHex).toBe(PAIRED_KEY.publicKeyHex);

    // The fingerprint an admin compares over a second channel.
    const shown = (await (await cp.authed(SEED_API_KEY, 'GET', '/as-pairing')).json()) as Record<string, unknown>;
    expect(shown.paired).toBe(true);
    expect(shown.asUrl).toBe(AS_URL);
    expect(typeof shown.fingerprint).toBe('string');
  });

  it('positive control: a gated write runs against the paired server', async () => {
    const groupId = await seedOperatorGroup(sp);
    const m = await grantRecordsMandate(sp, { apiKey: SEED_API_KEY, did: SEED_DID, intent: 'pin e2e: paired server', mode: 'automatic', groupId });
    await mcpInternal.pushGateContent(
      { authorizationId: m.authorizationId, boundsHash: m.boundsHash, contextHash: m.scopeHash, context: {} },
      RECORDS_PROFILE_ID,
      m.gateContent,
    );
    await ensureRecordsIntegration();
    agent = await connectAgent();

    const result = await createRecord('pin-before-swap');
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await recordTitles(dataDir)).toContain('pin-before-swap');
  }, 120_000);
});

describe('A different signing key at the same URL', () => {
  beforeAll(async () => {
    // Stop the MCP server FIRST. Its 5-second proposal poll would otherwise
    // reach the restarted AS with the old session, get a genuine 401 and lock
    // the gateway as 'expired' before the key mismatch is ever looked at —
    // correct behaviour, but it is not the case this suite is about.
    if (agent) { await agent.close().catch(() => {}); agent = null; }
    await pm.stopProcess('mcp', { confirmDownUrl: `http://localhost:${MCP_PORT}/health` });

    // Same port, same URL, different key, fresh store — and a server that is
    // internally consistent: it will sign its own mandate for this operator.
    await pm.stopProcess('as', { confirmDownUrl: `${AS_URL}/api/as/pubkey` });
    await pm.startSP(AS_PORT, { env: asKeyEnv(OTHER_KEY) });
    expect(await pubkeyOf(AS_URL)).toBe(OTHER_KEY.publicKeyHex);

    // The restart also stands in for the 5-minute key cache expiring.
    await startMcpServer(pm, stack);
    await mcpInternal.configure({ sessionCookie: 'substituted-server-accepts-anything', apiKey: SEED_API_KEY });
    await ensureRecordsIntegration();

    otherGroupId = await seedOperatorGroup(sp);
    const m = await grantRecordsMandate(sp, { apiKey: SEED_API_KEY, did: SEED_DID, intent: 'pin e2e: substituted server', mode: 'automatic', groupId: otherGroupId });
    await mcpInternal.pushGateContent(
      { authorizationId: m.authorizationId, boundsHash: m.boundsHash, contextHash: m.scopeHash, context: {} },
      RECORDS_PROFILE_ID,
      m.gateContent,
    );
    agent = await connectAgent();

    // The CP never saw the swap: it is still unlocked from the first sign-in.
    expect((await cp.health()).vaultUnlocked).toBe(true);
  }, 180_000);

  it('a committed proposal from a server with a different key is not executed', async () => {
    // The review path: the gateway polls the AS for committed proposals and
    // executes each one after asking for a ticket. Everything in that loop —
    // which tool, which arguments, "committed", the ticket — comes from the
    // server. If the pin does not cover it, a server holding the wrong key can
    // have the gateway run any tool it names.
    const m = await grantRecordsMandate(sp, { apiKey: SEED_API_KEY, did: SEED_DID, intent: 'pin e2e: substituted review grant', mode: 'review', groupId: otherGroupId });
    const created = await fetch(`${AS_URL}/api/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': SEED_API_KEY },
      body: JSON.stringify({
        authorization_id: m.authorizationId,
        profile_id: RECORDS_PROFILE_ID,
        path: RECORDS_PROFILE_ID,
        pending_domains: ['owner'],
        tool: 'records__create_record',
        tool_args: { type: 'note', title: 'pin-injected-by-substituted-server', content: 'should never run' },
        execution_context: { action_type: 'write' },
      }),
    });
    expect(created.status, await created.clone().text()).toBeLessThan(300);
    const proposalId = ((await created.json()) as { proposal: { id: string } }).proposal.id;
    const committed = await fetch(`${AS_URL}/api/proposals/${proposalId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': SEED_API_KEY },
      body: JSON.stringify({ action: 'commit', domain: 'owner' }),
    });
    expect(((await committed.json()) as { status: string }).status).toBe('committed');

    // Two poll intervals (5 s each) and margin.
    await sleep(12_000);
    expect(
      await recordTitles(dataDir),
      'the gateway executed a tool call handed to it by a server whose key does not match the pin',
    ).not.toContain('pin-injected-by-substituted-server');
  }, 60_000);

  it('a gated write is refused with INVALID_SIGNATURE and never reaches the connector', async () => {
    const before = await ticketCount();
    const result = await createRecord('pin-after-swap');
    const text = textOf(result);

    expect(result.isError, `the write ran under a substituted key: ${text.slice(0, 300)}`).toBe(true);
    expect(text).toMatch(/INVALID_SIGNATURE|does not match the one pinned/);
    expect(text).toContain('pinned');
    expect(await recordTitles(dataDir)).not.toContain('pin-after-swap');
    expect(await ticketCount(), 'a ticket was issued for a refused action').toBe(before);
  }, 60_000);

  it('the gateway locks itself and says why', async () => {
    const h = await cp.waitForHealth((x) => x.session.state === 'locked');
    expect(h.vaultUnlocked).toBe(false);
    expect(h.session.state).toBe('locked');
    expect(h.session.lockedReason).toBe('as-key-mismatch');
  }, 30_000);

  it('stays locked: the next write is refused too, and still nothing runs', async () => {
    const result = await createRecord('pin-after-lock');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/LOCKED|pinned/);
    expect(await recordTitles(dataDir)).not.toContain('pin-after-lock');
  }, 60_000);

  it('the agent is told the real reason — a key mismatch, not an ended sign-in', async () => {
    // Telling the user "your sign-in ended, sign in again" sends them to a
    // sign-in that is refused (next test). The agent must relay why.
    const text = textOf(await createRecord('pin-reason-check'));
    expect(text).not.toMatch(/sign-in has ended|last 30 days/);
    expect(text).toMatch(/key/i);
  }, 60_000);

  it('signing in to a server with a different key is refused (409) and the pin is unchanged', async () => {
    const login = await cp.login(SEED_API_KEY);
    expect(login.status, JSON.stringify(login.body)).toBe(409);
    expect(login.body.error).toBe('as_key_mismatch');

    expect(readPairingFile(dataDir)?.publicKeyHex).toBe(PAIRED_KEY.publicKeyHex);
    expect((await cp.health()).vaultUnlocked).toBe(false);
  }, 30_000);
});
