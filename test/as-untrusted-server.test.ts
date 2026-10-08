/**
 * A server at the gateway's configured Authority Server URL that does NOT
 * hold the pinned signing key gets nothing it can use.
 *
 * A public key is public — anyone can serve the pinned one — so the gateway
 * must only trust what is signed by the pinned key, and only for the request
 * it belongs to. These tests verify that protection:
 *
 *  1. An AS that cannot sign the sign-in challenge never receives the API key.
 *  2. A committed proposal this gateway never submitted is not executed, even
 *     when it comes with a genuine ticket for some other request: a ticket
 *     must name the proposal it authorizes.
 *  3. A ticket issued for another request is refused, even when action, scope
 *     and content are identical: a ticket names the request it answers (its
 *     idempotency key), so the Authority Server stays the sole cumulative
 *     bounds enforcer.
 *
 * Real Authority Server, real control plane + MCP server, real records
 * connector (its own database is the side-effect oracle). The only test
 * double is the untrusted server itself: a relay on the configured URL that
 * forwards to the real AS and, when switched on, answers a handful of routes
 * itself. It holds no signing key and signs nothing. The genuine tickets it
 * hands out are obtained from the real AS with the operator's API key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

const AS_PORT = 18150;
const RELAY_PORT = 18151;
const CP_PORT = 18152;
const MCP_PORT = 18153;
const REAL_AS = `http://localhost:${AS_PORT}`;
const AS_URL = `http://localhost:${RELAY_PORT}`; // what the gateway is configured with

const KEY = ed25519Keypair();
const pm = new ProcessManager();
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-untrusted-'));
const stack: StackOptions = { dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL };
const sp = new SPClient(REAL_AS);
const cp = new ControlPlaneClient(`http://localhost:${CP_PORT}`);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

// ── The untrusted server ────────────────────────────────────────────────────
const untrusted = {
  on: false,
  /** Relay the signing-key challenge to the real AS (an on-path relay) or not
   *  (a stand-alone fake that only knows the public key). */
  relayChallenge: true,
  /** Every request that reached the untrusted server while it was on and carried the
   *  operator's API key anywhere (header or body) — the credential leak oracle. */
  leaks: [] as string[],
  /** Proposals it reports as committed. */
  committed: [] as Record<string, unknown>[],
  /** Genuine tickets it hands back to receipt requests, in order. */
  tickets: [] as Record<string, unknown>[],
};
let relay: Server;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const url = req.url ?? '/';
  if (untrusted.on) {
    const seen = JSON.stringify(req.headers) + body.toString('utf-8');
    if (seen.includes(SEED_API_KEY)) untrusted.leaks.push(`${req.method} ${url}`);
    if (req.method === 'POST' && url.startsWith('/api/auth/session')) {
      return json(res, 401, { error: 'Invalid API key' });
    }
    if (req.method === 'POST' && url.startsWith('/api/as/challenge') && !untrusted.relayChallenge) {
      // It has the public key but not the private one: the best it can do is
      // answer with something that is not a valid signature.
      const nonce = (JSON.parse(body.toString('utf-8') || '{}') as { nonce?: string }).nonce;
      return json(res, 200, { typ: 'hap-as-challenge', nonce, issuedAt: Math.floor(Date.now() / 1000), signature: Buffer.alloc(64).toString('base64') });
    }
    if (req.method === 'GET' && url.startsWith('/api/proposals?') && url.includes('status=committed')) {
      return json(res, 200, { proposals: untrusted.committed });
    }
    if (req.method === 'POST' && url.startsWith('/api/as/receipt') && untrusted.tickets.length > 0) {
      return json(res, 200, { approved: true, receipt: untrusted.tickets.shift(), idempotent: false });
    }
  }
  // Everything else (incl. /api/as/pubkey — the public key IS public) is relayed.
  const up = httpRequest(
    { host: '127.0.0.1', port: AS_PORT, path: url, method: req.method, headers: { ...req.headers, host: `localhost:${AS_PORT}` } },
    (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); },
  );
  up.on('error', (e) => json(res, 502, { error: String(e) }));
  up.end(body);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
let agent: Client;
let authorizationId = '';
let boundsHash = '';
let groupId = '';
/** action + executionContext exactly as the gateway sends them for create_record. */
let requestShape: {
  action: string;
  actionType?: string;
  executionContext: Record<string, unknown>;
  /** Present when the profile binds content (records@0.4 does, jcs): the
   *  hash of the positive control's arguments, exactly as the AS signed it. */
  contentHash?: string;
  contentBinding?: Record<string, unknown>;
};

async function createRecord(title: string) {
  return agent.callTool({ name: 'records__create_record', arguments: { type: 'note', title, content: 'untrusted-server e2e' } });
}

/** A genuine ticket from the REAL AS, minted with the operator's API key. */
async function mintGenuineTicket(): Promise<Record<string, unknown>> {
  const r = await sp.postTicket(SEED_API_KEY, {
    authorizationId,
    boundsHash,
    profileId: RECORDS_PROFILE_ID,
    action: requestShape.action,
    actionType: requestShape.actionType,
    executionContext: requestShape.executionContext,
    // Same content commitment as the positive control: the ticket is for a
    // call with IDENTICAL arguments, so a content-hash check cannot tell a
    // replay from a fresh ticket — only a request-bound ticket could.
    ...(requestShape.contentHash
      ? { contentHash: requestShape.contentHash, contentBinding: requestShape.contentBinding }
      : {}),
  } as Parameters<SPClient['postTicket']>[1]);
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body.receipt as Record<string, unknown>;
}

beforeAll(async () => {
  if (!existsSync(RECORDS_DIST)) {
    execSync('npm run build', { cwd: join(ROOT, 'hap-records-mcp'), stdio: 'pipe', timeout: 120_000 });
  }
  pm.buildGateway();
  await pm.startSP(AS_PORT, { env: asKeyEnv(KEY) });
  relay = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => relay.listen(RELAY_PORT, '127.0.0.1', () => r()));
  await startControlPlane(pm, stack);
  await startMcpServer(pm, stack);

  const login = await cp.login(SEED_API_KEY);
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  expect(readPairingFile(dataDir)?.publicKeyHex).toBe(KEY.publicKeyHex);

  groupId = await seedOperatorGroup(sp);
  // Daily write limit 3: the positive control uses one, the two spare
  // minted tickets the others — after that the real AS refuses every write.
  const m = await grantRecordsMandate(sp, { apiKey: SEED_API_KEY, did: SEED_DID, intent: 'untrusted-server e2e', mode: 'automatic', groupId, writeDailyMax: 3 });
  authorizationId = m.authorizationId;
  boundsHash = m.boundsHash;
  await mcpInternal.pushGateContent(
    { authorizationId: m.authorizationId, boundsHash: m.boundsHash, contextHash: m.scopeHash, context: {} },
    RECORDS_PROFILE_ID,
    m.gateContent,
  );
  await mcpInternal.addIntegration(RECORDS_INTEGRATION);
  await mcpInternal.waitForIntegration('records');
  agent = new Client({ name: 'hap-e2e-untrusted-agent', version: '0.1.0' }, { capabilities: {} });
  await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
}, 180_000);

afterAll(async () => {
  if (agent) await agent.close().catch(() => {});
  await new Promise<void>((r) => (relay ? relay.close(() => r()) : r()));
  await pm.killAll();
  rmSync(dataDir, { recursive: true, force: true });
}, 30_000);

describe('Through an honest relay', () => {
  it('positive control: a gated write runs and its ticket is issued by the real AS', async () => {
    const result = await createRecord('untrusted-positive-control');
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await recordTitles(dataDir)).toContain('untrusted-positive-control');

    const [ticket] = (await sp.getMyTicketsPage(SEED_API_KEY)).tickets;
    requestShape = {
      action: String(ticket.action),
      actionType: typeof ticket.actionType === 'string' ? ticket.actionType : undefined,
      executionContext: ticket.executionContext as Record<string, unknown>,
      contentHash: typeof ticket.contentHash === 'string' ? ticket.contentHash : undefined,
      contentBinding: ticket.contentBinding as Record<string, unknown> | undefined,
    };
    expect(requestShape.action).toBe('records__create_record');
  }, 60_000);
});

describe('A server at the configured URL without the pinned signing key', () => {
  let spareTicket: Record<string, unknown>;
  let spareTicket2: Record<string, unknown>;

  beforeAll(async () => {
    // The last writes the grant allows, as genuine tickets held back for the tests below.
    spareTicket = await mintGenuineTicket();
    spareTicket2 = await mintGenuineTicket();
    // Control: the real AS now refuses further writes.
    const refused = await sp.postTicket(SEED_API_KEY, {
      authorizationId, boundsHash, profileId: RECORDS_PROFILE_ID,
      action: requestShape.action, actionType: requestShape.actionType, executionContext: requestShape.executionContext,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    untrusted.on = true;
  }, 60_000);

  it('an AS that cannot sign the challenge never receives the API key', async () => {
    untrusted.relayChallenge = false;
    untrusted.leaks.length = 0;
    const login = await cp.login(SEED_API_KEY);
    untrusted.relayChallenge = true;
    expect(login.status, JSON.stringify(login.body)).not.toBe(200);
    expect(untrusted.leaks, 'the API key reached a server that failed the signing-key challenge').toEqual([]);
  }, 30_000);

  // Scope: without pin-tls, only TLS protects the connection. A relay that
  // forwards every request — including the signing-key challenge, which
  // therefore verifies — sits inside the TLS session the operator trusts.
  // The pinned case is verified in as-tls-pinning.test.ts.
  it.skip('without pin-tls, only TLS protects the connection (a forwarding relay is out of scope)', () => {});

  it('a committed proposal this gateway never submitted is not executed, even with a genuine ticket', async () => {
    // Non-vacuity: a locked gateway refuses everything, which would make
    // this pass for the wrong reason.
    expect((await cp.health()).vaultUnlocked, 'gateway already locked — test would be vacuous').toBe(true);
    const ticket = await (async () => {
      // A second genuine ticket from a fresh grant (the first grant is spent).
      const groupTicketGrant = await grantRecordsMandate(sp, {
        apiKey: SEED_API_KEY, did: SEED_DID, intent: 'untrusted-server e2e 2', mode: 'automatic',
        groupId,
      });
      authorizationId = groupTicketGrant.authorizationId;
      boundsHash = groupTicketGrant.boundsHash;
      return mintGenuineTicket();
    })();

    untrusted.tickets.push(ticket);
    untrusted.committed = [{
      id: 'prop_never_submitted_by_this_gateway',
      authorizationId,
      profileId: RECORDS_PROFILE_ID,
      path: RECORDS_PROFILE_ID,
      pendingDomains: [],
      committedBy: { owner: { userId: 'local-admin', at: Math.floor(Date.now() / 1000) } },
      rejectedBy: null,
      tool: requestShape.action,
      toolArgs: { type: 'note', title: 'untrusted-unsubmitted-proposal', content: 'the AS never saw these arguments' },
      executionContext: requestShape.executionContext,
      status: 'committed',
      executionResult: null,
      createdAt: Math.floor(Date.now() / 1000) - 60,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }];
    // Two poll intervals (5 s) and margin.
    await sleep(12_000);
    untrusted.committed = [];
    untrusted.tickets.length = 0;
    expect(
      await recordTitles(dataDir),
      'the gateway executed a proposal (tool + arguments) the Authority Server never issued a ticket for',
    ).not.toContain('untrusted-unsubmitted-proposal');
  }, 90_000);

  it('a ticket issued for another request is refused, even for identical content (tickets name their request)', async () => {
    // Only a ticket that names the request (signed idempotency key) can
    // tell this replay — identical action, scope and content — from a fresh
    // ticket. The grant is spent: the real AS refuses. A refusal here locks
    // the gateway (binding mismatch), so this runs after the tests that need
    // it unlocked.
    // Non-vacuity: a locked gateway refuses everything, which would make
    // this pass for the wrong reason.
    expect((await cp.health()).vaultUnlocked, 'gateway already locked — test would be vacuous').toBe(true);
    const before = (await recordTitles(dataDir)).filter((t) => t === 'untrusted-positive-control').length;
    untrusted.tickets.push(spareTicket2);
    const result = await createRecord('untrusted-positive-control');
    untrusted.tickets.length = 0;
    const after = (await recordTitles(dataDir)).filter((t) => t === 'untrusted-positive-control').length;
    expect(after, `a write ran on a ticket issued for another request, past the daily limit: ${textOf(result).slice(0, 300)}`).toBe(before);
  }, 60_000);

  it('a ticket issued for different content is refused', async () => {
    // The previous refusal may have locked the gateway; sign in again through
    // an honest relay so this test is not vacuous.
    if (!(await cp.health()).vaultUnlocked) {
      untrusted.on = false;
      const relogin = await cp.login(SEED_API_KEY);
      untrusted.on = true;
      expect(relogin.status, JSON.stringify(relogin.body)).toBe(200);
    }
    // The spare ticket commits to the positive control's content; this call
    // carries other content. Passes since the gateway checks contentHash.
    // Runs LAST: the mismatch locks the gateway (as-key-mismatch).
    expect((await cp.health()).vaultUnlocked, 'gateway already locked — test would be vacuous').toBe(true);
    untrusted.tickets.push(spareTicket);
    const result = await createRecord('untrusted-other-request-ticket');
    untrusted.tickets.length = 0;
    expect(await recordTitles(dataDir), `ran on a ticket issued for other content: ${textOf(result).slice(0, 300)}`)
      .not.toContain('untrusted-other-request-ticket');
    // The ticket's idempotency key is checked too, and a
    // replayed ticket can never carry this call's key — so either binding may
    // be the one that refuses. Content binding alone is covered by the
    // gateway's ticket-verify unit tests.
    expect(textOf(result)).toMatch(/contentHash|idempotencyKey/);
  }, 60_000);
});
