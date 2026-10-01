/**
 * Pointing the gateway at a different Authority Server re-pairs it.
 *
 * A mandate is signed by one Authority Server and means nothing to another.
 * When the gateway restarts against a different AS URL it must: drop the
 * pairing with the old server, drop the old server's cached mandates, boot
 * locked with a reason that says the server changed, and sign in to the new
 * one — pinning the NEW server's key. What it keeps: local vault credentials
 * (not tied to any AS) and the local ticket archive (each entry records its
 * own asUrl).
 *
 * Two real Authority Servers with different signing keys, the real control
 * plane + MCP server, the real records connector. The seeded AS operator
 * (same API key on every fresh AS) signs in to both, so the vault key — which
 * is derived from the API key — is the same on both sides and what survives
 * the move is attributable to the re-pair code, not to a coincidence of keys.
 *
 * The control plane and the MCP server each check the pairing at their own
 * boot, and bundle/server.js starts them concurrently, so either can come up
 * first. Both orders are run explicitly.
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
  readPairingFile, recordTitles, seedOperatorGroup, startControlPlane, startMcpServer, textOf,
  type StackOptions,
} from '../src/helpers/gateway-stack';

const AS1_PORT = 18110;
const AS2_PORT = 18111;
const AS1_URL = `http://localhost:${AS1_PORT}`;
const AS2_URL = `http://localhost:${AS2_PORT}`;
const KEY1 = ed25519Keypair();
const KEY2 = ed25519Keypair();

const pm = new ProcessManager();
const sp1 = new SPClient(AS1_URL);
const sp2 = new SPClient(AS2_URL);
// The seed operator may belong to one team per AS — one group each, shared.
let group1 = '';
let group2 = '';

beforeAll(async () => {
  if (!existsSync(RECORDS_DIST)) {
    execSync('npm run build', { cwd: join(ROOT, 'hap-records-mcp'), stdio: 'pipe', timeout: 120_000 });
  }
  pm.buildGateway();
  await pm.startSP(AS1_PORT, { name: 'as1', env: asKeyEnv(KEY1) });
  await pm.startSP(AS2_PORT, { name: 'as2', env: asKeyEnv(KEY2) });
  group1 = await seedOperatorGroup(sp1);
  group2 = await seedOperatorGroup(sp2);
}, 180_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

const ORDERS = [
  { label: 'control plane boots first', cpFirst: true, cp: 18112, mcp: 18113 },
  { label: 'MCP server boots first', cpFirst: false, cp: 18114, mcp: 18115 },
];

describe.each(ORDERS)('Re-pairing on an AS URL change ($label)', ({ label, cpFirst, cp: cpPort, mcp: mcpPort }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-repair-'));
  const secret = newSecret();
  const at = (asUrl: string): StackOptions => ({ dataDir, ports: { cp: cpPort, mcp: mcpPort }, secret, asUrl });
  const cp = new ControlPlaneClient(`http://localhost:${cpPort}`);
  const mcpInternal = new GatewayClient(`http://localhost:${mcpPort}`, secret);
  const cpName = `cp-${cpPort}`;
  const mcpName = `mcp-${mcpPort}`;
  const tag = cpFirst ? 'cpfirst' : 'mcpfirst';
  const AS1_INTENT = `repair e2e (${tag}): grant from AS1`;
  let agent: Client | null = null;
  let as1TicketId = '';

  async function connectAgent(): Promise<Client> {
    const c = new Client({ name: 'hap-e2e-repair-agent', version: '0.1.0' }, { capabilities: {} });
    await c.connect(new SSEClientTransport(new URL(`http://localhost:${mcpPort}/sse`)));
    return c;
  }
  async function createRecord(title: string) {
    return agent!.callTool({ name: 'records__create_record', arguments: { type: 'note', title, content: `repair e2e ${label}` } });
  }
  async function ensureRecordsIntegration(): Promise<void> {
    if (!(await mcpInternal.integrations()).some((i) => i.id === 'records')) {
      await mcpInternal.addIntegration(RECORDS_INTEGRATION);
    }
    await mcpInternal.waitForIntegration('records');
  }
  async function pushMandate(m: Awaited<ReturnType<typeof grantRecordsMandate>>) {
    await mcpInternal.pushGateContent(
      { authorizationId: m.authorizationId, boundsHash: m.boundsHash, contextHash: m.contextHash, context: {} },
      RECORDS_PROFILE_ID,
      m.gateContent,
    );
  }

  afterAll(async () => {
    if (agent) await agent.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('paired with AS1', () => {
    beforeAll(async () => {
      await startControlPlane(pm, at(AS1_URL), cpName);
      await startMcpServer(pm, at(AS1_URL), mcpName);
    }, 120_000);

    it('signs in to AS1 and pins its key', async () => {
      const login = await cp.login(SEED_API_KEY);
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(readPairingFile(dataDir)).toMatchObject({ asUrl: AS1_URL, publicKeyHex: KEY1.publicKeyHex });
    });

    it('stores a vault credential', async () => {
      const res = await cp.authed(SEED_API_KEY, 'PUT', '/vault/credentials/e2e-repair', { token: `keep-me-${tag}` });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
    });

    it('runs a gated write under an AS1 mandate (and archives its ticket)', async () => {
      await pushMandate(await grantRecordsMandate(sp1, { apiKey: SEED_API_KEY, did: SEED_DID, intent: AS1_INTENT, mode: 'automatic', groupId: group1 }));
      await ensureRecordsIntegration();
      agent = await connectAgent();

      const ticketIds = async () => (await sp1.getMyReceiptsPage(SEED_API_KEY)).receipts.map((r) => String(r.id));
      const before = new Set(await ticketIds());
      const result = await createRecord(`repair-${tag}-as1`);
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(await recordTitles(dataDir)).toContain(`repair-${tag}-as1`);

      const fresh = (await ticketIds()).filter((id) => !before.has(id));
      expect(fresh, 'the write issued no ticket on AS1').toHaveLength(1);
      as1TicketId = fresh[0];
      const local = await cp.authed(SEED_API_KEY, 'GET', `/api/evidence/receipt/${as1TicketId}`);
      expect(local.status, 'ticket not archived locally before the move').toBe(200);
    }, 120_000);
  });

  describe('restarted against AS2', () => {
    beforeAll(async () => {
      if (agent) { await agent.close().catch(() => {}); agent = null; }
      await pm.stopProcess(cpName, { confirmDownUrl: `http://localhost:${cpPort}/health` });
      await pm.stopProcess(mcpName, { confirmDownUrl: `http://localhost:${mcpPort}/health` });
      // Deterministic worst cases of the concurrent boot in bundle/server.js.
      if (cpFirst) {
        await startControlPlane(pm, at(AS2_URL), cpName);
        await startMcpServer(pm, at(AS2_URL), mcpName);
      } else {
        await startMcpServer(pm, at(AS2_URL), mcpName);
        await startControlPlane(pm, at(AS2_URL), cpName);
      }
    }, 120_000);

    it('both halves resolve AS2', async () => {
      expect((await cp.health()).spUrl).toBe(AS2_URL);
      const mcpHealth = (await (await fetch(`http://localhost:${mcpPort}/health`)).json()) as { sp: string };
      expect(mcpHealth.sp).toBe(AS2_URL);
    });

    it('drops the pairing with AS1', () => {
      expect(readPairingFile(dataDir)).toBeNull();
    });

    it('boots locked and says the Authority Server changed', async () => {
      const h = await cp.health();
      expect(h.vaultUnlocked).toBe(false);
      expect(h.session.state).toBe('locked');
      expect(h.session.lockedReason).toBe('as-url-changed');
    });

    it("drops AS1's cached mandates from disk (plaintext AND encrypted gate store)", () => {
      expect(existsSync(join(dataDir, 'gates.json')), 'gates.json survived the AS change').toBe(false);
      expect(existsSync(join(dataDir, 'gates.enc.json')), 'gates.enc.json survived the AS change — it is resurrected at the next unlock').toBe(false);
    });

    it("signs in to AS2 and pins AS2's key", async () => {
      const login = await cp.login(SEED_API_KEY);
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(readPairingFile(dataDir)).toMatchObject({ asUrl: AS2_URL, publicKeyHex: KEY2.publicKeyHex });
    });

    it('keeps the vault credential', async () => {
      const res = await cp.authed(SEED_API_KEY, 'GET', '/vault/credentials/e2e-repair');
      expect(res.status).toBe(200);
      // The route reports presence + field names, never the secret itself.
      expect(await res.json()).toMatchObject({ configured: true, fieldNames: ['token'] });
    });

    it("keeps AS1's ticket in the local archive, still attributed to AS1", async () => {
      const res = await cp.authed(SEED_API_KEY, 'GET', `/api/evidence/receipt/${as1TicketId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entry: { asUrl?: string } };
      expect(body.entry.asUrl).toBe(AS1_URL);
    });

    it('the AS1 mandate no longer authorizes anything, and nothing runs', async () => {
      await ensureRecordsIntegration();
      agent = await connectAgent();
      const listed = textOf(await agent.callTool({ name: 'list-authorizations', arguments: { domain: 'records' } }));
      expect(listed).not.toContain(AS1_INTENT);

      const result = await createRecord(`repair-${tag}-after-switch`);
      expect(result.isError, `an AS1 mandate authorized a write against AS2: ${textOf(result).slice(0, 300)}`).toBe(true);
      expect(await recordTitles(dataDir)).not.toContain(`repair-${tag}-after-switch`);
    }, 120_000);

    it('positive control: an AS2 mandate works after re-pairing', async () => {
      await pushMandate(await grantRecordsMandate(sp2, { apiKey: SEED_API_KEY, did: SEED_DID, intent: `repair e2e (${tag}): AS2`, mode: 'automatic', groupId: group2 }));
      const result = await createRecord(`repair-${tag}-as2`);
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(await recordTitles(dataDir)).toContain(`repair-${tag}-as2`);
    }, 120_000);
  });
});

/**
 * The common migration to a self-hosted Authority Server: a gateway that has
 * been running against the hosted AS on a version WITHOUT pairing records
 * (older gateways write neither as-pairing.json nor mcp-as-pairing.json) is
 * upgraded and pointed at the operator's own AS in the same restart. The
 * data dir is produced by this build and then stripped of both pairing files,
 * which is exactly what an older gateway leaves behind.
 */
describe('Upgrade from a gateway with no pairing record, switching AS in the same restart', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-repair-upgrade-'));
  const secret = newSecret();
  const ports = { cp: 18116, mcp: 18117 };
  const at = (asUrl: string): StackOptions => ({ dataDir, ports, secret, asUrl });
  const cp = new ControlPlaneClient(`http://localhost:${ports.cp}`);
  const mcpInternal = new GatewayClient(`http://localhost:${ports.mcp}`, secret);
  const INTENT = 'repair e2e (upgrade): grant from AS1';

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("does not carry the old server's mandates over to the new one", async () => {
    await startControlPlane(pm, at(AS1_URL), 'cp-upgrade');
    await startMcpServer(pm, at(AS1_URL), 'mcp-upgrade');
    expect((await cp.login(SEED_API_KEY)).status).toBe(200);
    const m = await grantRecordsMandate(sp1, { apiKey: SEED_API_KEY, did: SEED_DID, intent: INTENT, mode: 'automatic', groupId: group1 });
    await mcpInternal.pushGateContent(
      { authorizationId: m.authorizationId, boundsHash: m.boundsHash, contextHash: m.contextHash, context: {} },
      RECORDS_PROFILE_ID,
      m.gateContent,
    );
    await pm.stopProcess('cp-upgrade', { confirmDownUrl: `http://localhost:${ports.cp}/health` });
    await pm.stopProcess('mcp-upgrade', { confirmDownUrl: `http://localhost:${ports.mcp}/health` });
    expect(existsSync(join(dataDir, 'gates.enc.json')) || existsSync(join(dataDir, 'gates.json'))).toBe(true);

    // What an older gateway leaves behind: no record of which AS it used.
    rmSync(join(dataDir, 'as-pairing.json'), { force: true });
    rmSync(join(dataDir, 'mcp-as-pairing.json'), { force: true });

    await startControlPlane(pm, at(AS2_URL), 'cp-upgrade');
    await startMcpServer(pm, at(AS2_URL), 'mcp-upgrade');
    expect((await cp.login(SEED_API_KEY)).status).toBe(200);

    const client = new Client({ name: 'hap-e2e-repair-upgrade', version: '0.1.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(new URL(`http://localhost:${ports.mcp}/sse`)));
    try {
      const listed = textOf(await client.callTool({ name: 'list-authorizations', arguments: { domain: 'records' } }));
      expect(listed, "an AS1 grant is still advertised to the agent after switching to AS2").not.toContain(INTENT);
      // With no pairing record there is nothing to compare at boot; the
      // post-sign-in resync with AS2 is what purges the AS1 entry (AS2 does
      // not know that grant). Allow it a bounded moment, then require it gone.
      const storedGates = async () =>
        ((await (await fetch(`http://localhost:${ports.mcp}/health`)).json()) as { storedGates: number }).storedGates;
      const deadline = Date.now() + 20_000;
      while ((await storedGates()) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
      expect(await storedGates(), 'AS1 gate entries survived the switch to AS2').toBe(0);
    } finally {
      await client.close().catch(() => {});
    }
  }, 180_000);
});

/**
 * The upgrade EVERY existing user makes: a gateway from a version without
 * pairing records (older gateways write neither as-pairing.json nor
 * mcp-as-pairing.json), upgraded and restarted against the SAME Authority
 * Server. Nothing changed about the server, so nothing the human granted may
 * be lost: the local gate store holds the only copy of each grant's intent
 * and scope (the AS never sees them), and a grant without it is dropped from
 * the agent's authorizations.
 */
describe('Upgrade from a gateway with no pairing record, SAME Authority Server', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-repair-sameas-'));
  const secret = newSecret();
  const ports = { cp: 18118, mcp: 18119 };
  const at = (asUrl: string): StackOptions => ({ dataDir, ports, secret, asUrl });
  const cp = new ControlPlaneClient(`http://localhost:${ports.cp}`);
  const mcpInternal = new GatewayClient(`http://localhost:${ports.mcp}`, secret);
  const INTENT = 'repair e2e (upgrade, same AS): grant that must survive';

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  async function writeRecord(title: string) {
    const client = new Client({ name: 'hap-e2e-repair-sameas', version: '0.1.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(new URL(`http://localhost:${ports.mcp}/sse`)));
    try {
      return await client.callTool({ name: 'records__create_record', arguments: { type: 'note', title, content: 'upgrade same AS' } });
    } finally {
      await client.close().catch(() => {});
    }
  }

  it("keeps the user's grants working across the upgrade", async () => {
    await startControlPlane(pm, at(AS1_URL), 'cp-sameas');
    await startMcpServer(pm, at(AS1_URL), 'mcp-sameas');
    expect((await cp.login(SEED_API_KEY)).status).toBe(200);
    const m = await grantRecordsMandate(sp1, { apiKey: SEED_API_KEY, did: SEED_DID, intent: INTENT, mode: 'automatic', groupId: group1 });
    await mcpInternal.pushGateContent(
      { authorizationId: m.authorizationId, boundsHash: m.boundsHash, contextHash: m.contextHash, context: {} },
      RECORDS_PROFILE_ID,
      m.gateContent,
    );
    if (!(await mcpInternal.integrations()).some((i) => i.id === 'records')) await mcpInternal.addIntegration(RECORDS_INTEGRATION);
    await mcpInternal.waitForIntegration('records');
    const before = await writeRecord('repair-sameas-before-upgrade');
    expect(before.isError, textOf(before)).toBeFalsy();

    await pm.stopProcess('cp-sameas', { confirmDownUrl: `http://localhost:${ports.cp}/health` });
    await pm.stopProcess('mcp-sameas', { confirmDownUrl: `http://localhost:${ports.mcp}/health` });
    // What an older gateway leaves behind: no record of which AS it used.
    rmSync(join(dataDir, 'as-pairing.json'), { force: true });
    rmSync(join(dataDir, 'mcp-as-pairing.json'), { force: true });

    await startControlPlane(pm, at(AS1_URL), 'cp-sameas');
    await startMcpServer(pm, at(AS1_URL), 'mcp-sameas');
    expect((await cp.login(SEED_API_KEY)).status).toBe(200);
    await mcpInternal.waitForIntegration('records');

    // Sign-in re-syncs grants in the background; give it a bounded moment to
    // list the grant again before the write (a real agent retries likewise).
    const listed = async () => {
      const c = new Client({ name: 'hap-e2e-repair-sameas-list', version: '0.1.0' }, { capabilities: {} });
      await c.connect(new SSEClientTransport(new URL(`http://localhost:${ports.mcp}/sse`)));
      try { return textOf(await c.callTool({ name: 'list-authorizations', arguments: { domain: 'records' } })); } finally { await c.close().catch(() => {}); }
    };
    const deadline = Date.now() + 20_000;
    let text = await listed();
    while (!text.includes(INTENT) && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 500)); text = await listed(); }
    expect(text, 'the grant the human made before the upgrade is gone').toContain(INTENT);

    const after = await writeRecord('repair-sameas-after-upgrade');
    expect(after.isError, `a grant was lost by upgrading against the same AS: ${textOf(after).slice(0, 300)}`).toBeFalsy();
    expect(await recordTitles(dataDir)).toContain('repair-sameas-after-upgrade');
  }, 180_000);
});
