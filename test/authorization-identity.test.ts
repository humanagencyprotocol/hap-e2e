/**
 * Per-ceremony authorization identity — protocol conformance E2E.
 *
 * Replays the four failure modes of the fingerprint-as-identity incident
 * against the REAL Authority Server and (for the parity block) the REAL
 * gateway — no mocks:
 *
 *   F1 silent merge      — two grants with IDENTICAL bounds used to collapse
 *                          into one frame key. Now: two ids, two grants.
 *   F2 content swap      — re-attesting a fingerprint used to replace the
 *                          original's context/intent. Now: 409 AUTHZ_MISMATCH.
 *   F3 resurrection      — re-attesting used to clear an existing revocation.
 *                          Now: revocation is permanent; 409 AUTHZ_REVOKED.
 *   F4 ambiguous revoke  — revoking by fingerprint could hit the wrong twin.
 *                          Now: an id names exactly one decision.
 *
 * Plus the lifecycle glue: idempotent ceremony retry, renew (expiry-only),
 * receipts naming the governing grant, and cross-user/foreign-group scoping.
 *
 * Run:  npx vitest run test/authorization-identity.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient, mintAuthorizationId } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeContextHash,
} from '../src/helpers/crypto.js';

// ── Constants ───────────────────────────────────────────────────────────────

const SP_PORT = 15501;
const GW_PORT = 15502;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
const BOUNDS_KEY_ORDER = ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_daily_max'];
const CONTEXT_KEY_ORDER = ['allowed_recipients', 'allowed_domains'];

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

// The incident shape: IDENTICAL bounds and context — only the intent (and the
// human decision behind it) differs. Under fingerprint identity these were one
// frame; under per-ceremony identity they are two independent grants.
const SHARED_BOUNDS = { profile: PROFILE_ID, recipient_max: 2, send_daily_max: 10 };
const SHARED_CONTEXT = { allowed_recipients: 'twin@sublin.app' };
const INTENT_A = 'TWIN-A: couple communication — friendly and funny.';
const INTENT_B = 'TWIN-B: business outreach — formal tone only.';

// ── Shared state ────────────────────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let apiKey = '';
let did = '';
let groupId = '';
let foreignApiKey = '';
let foreignDid = '';
let foreignGroupId = '';
let mcpClient: Client | null = null;

const boundsHash = computeBoundsHash(SHARED_BOUNDS, BOUNDS_KEY_ORDER);
const contextHash = computeContextHash(SHARED_CONTEXT, CONTEXT_KEY_ORDER);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full attest body for a given intent — everything identical except the intent. */
function attestBody(intent: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile_id: PROFILE_ID,
    group_id: groupId,
    bounds: SHARED_BOUNDS,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'owner',
    did,
    commitment_mode: 'automatic' as const,
    gate_content_hashes: hashGateContent({ intent }),
    execution_context_hash: hashExecutionContext({ recipient_count: 1, ...SHARED_CONTEXT }),
    ...overrides,
  };
}

function receiptBody(authorizationId: string, overrides: Record<string, unknown> = {}) {
  return {
    authorizationId,
    boundsHash,
    profileId: PROFILE_ID,
    action: 'send_message',
    executionContext: { recipient_count: 1, ...SHARED_CONTEXT },
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  // Build BEFORE the Authority Server exists, exactly as every other suite does.
  //
  // `buildGateway()` is a synchronous `execSync('pnpm build')`, so it blocks the
  // event loop for as long as the build takes — ~15s cold on CI, ~0s locally
  // where turbo caches it. Blocking the loop *after* the AS has served traffic
  // is what broke this suite: Next's dev server closes idle keep-alive sockets
  // after 5s, undici cannot process the close while the loop is blocked, and the
  // next POST is written to a socket the peer already closed. Building here
  // means there is no pooled socket to go stale.
  pm.buildGateway();

  await pm.startSP(SP_PORT);

  const user = await sp.register('Identity E2E', `authz-identity-${Date.now()}@test.local`);
  apiKey = user.apiKey;
  did = user.user.did;
  groupId = await sp.getPersonalGroupId(apiKey);

  const foreign = await sp.register('Foreign User', `authz-foreign-${Date.now()}@test.local`);
  foreignApiKey = foreign.apiKey;
  foreignDid = foreign.user.did;
  foreignGroupId = await sp.getPersonalGroupId(foreignApiKey);
}, 90_000);

afterAll(async () => {
  if (mcpClient) {
    try { await mcpClient.close(); } catch { /* ignore */ }
  }
  await pm.killAll();
}, 30_000);

// ═════════════════════════════════════════════════════════════════════════════

describe('F1 — same-fingerprint twins are independent grants', () => {
  let idA = '';
  let idB = '';

  it('two ceremonies with identical bounds+context mint two ACTIVE grants', async () => {
    const a = await sp.submitAttestation(apiKey, attestBody(INTENT_A) as Parameters<typeof sp.submitAttestation>[1]);
    const b = await sp.submitAttestation(apiKey, attestBody(INTENT_B) as Parameters<typeof sp.submitAttestation>[1]);
    idA = a.authorization_id;
    idB = b.authorization_id;

    expect(idA).toMatch(/^authz_/);
    expect(idB).toMatch(/^authz_/);
    expect(idA).not.toBe(idB); // the fingerprint no longer merges them
    expect(a.status).toBe('active');
    expect(b.status).toBe('active');

    const statusA = await sp.getAuthorizationStatus(apiKey, idA);
    const statusB = await sp.getAuthorizationStatus(apiKey, idB);
    expect(statusA.status).toBe(200);
    expect(statusB.status).toBe(200);
    expect(statusA.body.status).toBe('active');
    expect(statusB.body.status).toBe('active');
  });

  it('receipts name the governing grant by its id', async () => {
    const r = await sp.postReceipt(apiKey, receiptBody(idA));
    expect(r.status).toBe(201);
    const receipt = r.body.receipt as Record<string, unknown>;
    expect(receipt.authorizationId).toBe(idA);
  });

  it('F4 — revoking twin A leaves twin B fully alive', async () => {
    await sp.revokeAuthorization(apiKey, idA, 'twin A no longer needed');

    // A is dead: no receipt can be issued against it.
    const dead = await sp.postReceipt(apiKey, receiptBody(idA));
    expect(dead.status).toBe(403);
    const codes = (dead.body.errors as Array<{ code: string }>).map(e => e.code);
    expect(codes).toContain('ATTESTATION_REVOKED');

    // B — same fingerprint — is untouched.
    const alive = await sp.postReceipt(apiKey, receiptBody(idB));
    expect(alive.status).toBe(201);
    expect((alive.body.receipt as Record<string, unknown>).authorizationId).toBe(idB);

    const statusB = await sp.getAuthorizationStatus(apiKey, idB);
    expect(statusB.body.status).toBe('active');
  });

  it('F3 — a revoked id can NEVER be resurrected by re-attesting', async () => {
    const resurrect = await sp.submitAttestationRaw(apiKey, {
      ...attestBody(INTENT_A),
      authorization_id: idA,
    });
    expect(resurrect.status).toBe(409);
    expect(resurrect.body.error).toBe('AUTHZ_REVOKED');

    // Still revoked afterwards — the attempt changed nothing.
    const dead = await sp.postReceipt(apiKey, receiptBody(idA));
    expect(dead.status).toBe(403);
  });

  it('"I want it back" = a NEW ceremony with a NEW id — old id stays dead', async () => {
    const again = await sp.submitAttestation(apiKey, attestBody(INTENT_A) as Parameters<typeof sp.submitAttestation>[1]);
    expect(again.authorization_id).not.toBe(idA);
    expect(again.status).toBe('active');

    const r = await sp.postReceipt(apiKey, receiptBody(again.authorization_id));
    expect(r.status).toBe(201);

    const stillDead = await sp.postReceipt(apiKey, receiptBody(idA));
    expect(stillDead.status).toBe(403);
  });
});

describe('Ceremony retry and identity integrity', () => {
  it('idempotent retry: replaying the SAME id with the SAME content succeeds (one grant)', async () => {
    const id = mintAuthorizationId();
    const body = attestBody('RETRY: lost-response ceremony retry.', { authorization_id: id });

    const first = await sp.submitAttestationRaw(apiKey, body);
    const retry = await sp.submitAttestationRaw(apiKey, body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.authorization_id).toBe(id);
    // Still version 1 — a retry is not a renew.
    expect(retry.body.version).toBe(1);
  });

  it('F2 — content swap on an existing id is rejected with AUTHZ_MISMATCH; original intact', async () => {
    const id = mintAuthorizationId();
    const original = await sp.submitAttestationRaw(apiKey, attestBody('SWAP: the original decision.', { authorization_id: id }));
    expect(original.status).toBe(201);

    // Same id, different intent → different decision → rejected.
    const swap = await sp.submitAttestationRaw(apiKey, attestBody('SWAP: a very different decision.', { authorization_id: id }));
    expect(swap.status).toBe(409);
    expect(swap.body.error).toBe('AUTHZ_MISMATCH');

    // Same id, different commitment mode → also a different decision.
    const flip = await sp.submitAttestationRaw(apiKey, attestBody('SWAP: the original decision.', {
      authorization_id: id,
      commitment_mode: 'review',
    }));
    expect(flip.status).toBe(409);

    // The original grant is untouched and still active.
    const status = await sp.getAuthorizationStatus(apiKey, id);
    expect(status.body.status).toBe('active');
  });

  it('a foreign user cannot graft onto someone else\'s authorization id', async () => {
    const id = mintAuthorizationId();
    const mine = await sp.submitAttestationRaw(apiKey, attestBody('FOREIGN: my grant.', { authorization_id: id }));
    expect(mine.status).toBe(201);

    const theft = await sp.submitAttestationRaw(foreignApiKey, {
      ...attestBody('FOREIGN: my grant.', { authorization_id: id }),
      group_id: foreignGroupId,
      did: foreignDid,
    });
    expect(theft.status).toBe(403);

    // And they can't revoke it either.
    await expect(sp.revokeAuthorization(foreignApiKey, id)).rejects.toThrow(/403/);
  });

  it('renew extends the SAME grant (version bump); renew with different content is rejected', async () => {
    const id = mintAuthorizationId();
    const body = attestBody('RENEW: keep this grant alive.', { authorization_id: id });

    const created = await sp.submitAttestationRaw(apiKey, body);
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);

    const renewed = await sp.submitAttestationRaw(apiKey, { ...body, renew: true });
    expect(renewed.status).toBe(201);
    expect(renewed.body.authorization_id).toBe(id);
    expect(renewed.body.version).toBe(2);

    // Renew is expiry-only: content is locked at creation.
    const mutate = await sp.submitAttestationRaw(apiKey, {
      ...attestBody('RENEW: sneak in new content.', { authorization_id: id }),
      renew: true,
    });
    expect(mutate.status).toBe(409);
    expect(mutate.body.error).toBe('AUTHZ_MISMATCH');
  });

  it('concurrent attests on the SAME id with DIFFERENT content: exactly one wins', async () => {
    // The NX-create race: two ceremonies simultaneously claim one id with
    // different decisions. Exactly one must own the identity (201); the
    // other must be rejected (409 AUTHZ_MISMATCH) — never two grants under
    // one id, never a silent merge.
    const id = mintAuthorizationId();
    const [r1, r2] = await Promise.all([
      sp.submitAttestationRaw(apiKey, attestBody('RACE: decision one.', { authorization_id: id })),
      sp.submitAttestationRaw(apiKey, attestBody('RACE: decision two.', { authorization_id: id })),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error).toBe('AUTHZ_MISMATCH');

    // The surviving grant is intact and receipt-able.
    const status = await sp.getAuthorizationStatus(apiKey, id);
    expect(status.body.status).toBe('active');
  });

  it('malformed or missing ids are rejected up front', async () => {
    const missing = await sp.submitAttestationRaw(apiKey, (() => {
      const b = attestBody('BAD: no id.');
      delete b.authorization_id;
      return b;
    })());
    expect(missing.status).toBe(400);

    const malformed = await sp.submitAttestationRaw(apiKey, attestBody('BAD: wrong shape.', {
      authorization_id: 'sha256:deadbeef:user-1',
    }));
    expect(malformed.status).toBe(400);
  });

  it('receipts reject legacy fingerprint fields and cross-check boundsHash', async () => {
    const grant = await sp.submitAttestation(apiKey, attestBody('RECEIPT: wire contract.') as Parameters<typeof sp.submitAttestation>[1]);

    // Legacy field → 400 (the wire moved; fail loudly, not silently).
    const legacy = await fetch(`${SP_URL}/api/as/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({
        attestationHash: boundsHash,
        profileId: PROFILE_ID,
        action: 'send_message',
        idempotencyKey: `legacy-${Date.now()}`,
      }),
    });
    expect(legacy.status).toBe(400);

    // boundsHash disagreeing with the record → 409 BOUNDS_HASH_MISMATCH.
    const mismatch = await sp.postReceipt(apiKey, receiptBody(grant.authorization_id, {
      boundsHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    }));
    expect(mismatch.status).toBe(409);
    const codes = (mismatch.body.errors as Array<{ code: string }>).map(e => e.code);
    expect(codes).toContain('BOUNDS_HASH_MISMATCH');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Surface parity: the SAME twins through the REAL gateway. Gate content is
// keyed by the per-ceremony id, so identical-fingerprint grants keep their
// own intent all the way to the agent's list-authorizations — the exact
// cross-contamination the incident surfaced ("couple" intent bleeding into
// the template grant).
// ═════════════════════════════════════════════════════════════════════════════

describe('Gateway parity — identical-bounds twins keep separate intents end-to-end', () => {
  let gwApiKey = '';
  let gwDid = '';
  let gwGroupId = '';
  let twinA = '';
  let twinB = '';

  async function attestAndPush(intent: string): Promise<string> {
    const result = await sp.submitAttestation(gwApiKey, {
      profile_id: PROFILE_ID,
      group_id: gwGroupId,
      bounds: SHARED_BOUNDS,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      domain: 'owner',
      did: gwDid,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent }),
      execution_context_hash: hashExecutionContext({ recipient_count: 1, ...SHARED_CONTEXT }),
    });
    await gw.pushGateContent(
      {
        authorizationId: result.authorization_id,
        boundsHash: result.bounds_hash ?? boundsHash,
        contextHash,
        context: SHARED_CONTEXT,
      },
      undefined,
      { intent },
    );
    return result.authorization_id;
  }

  async function listAuthorizations(): Promise<string> {
    const result = await mcpClient!.callTool({
      name: 'list-authorizations',
      arguments: { domain: 'email' },
    });
    return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  }

  beforeAll(async () => {
    // The gateway is built in the file-level beforeAll, before the AS starts.
    // Do not build here: a blocking build between AS requests kills the pooled
    // keep-alive socket and the next POST fails with "other side closed".

    // A fresh user so this block's grants are the ONLY ones the gateway sees.
    const user = await sp.register('Identity GW E2E', `authz-gw-${Date.now()}@test.local`);
    gwApiKey = user.apiKey;
    gwDid = user.user.did;
    gwGroupId = await sp.getPersonalGroupId(gwApiKey);

    await pm.startGateway({
      port: GW_PORT,
      spUrl: SP_URL,
      spApiKey: gwApiKey,
      profilesDir: PROFILES_DIR,
    });
    await gw.configure({ sessionCookie: 'authz-identity-e2e', apiKey: gwApiKey });

    twinA = await attestAndPush(INTENT_A);
    twinB = await attestAndPush(INTENT_B);
    await sleep(500);

    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    mcpClient = new Client({ name: 'hap-authz-identity-e2e', version: '0.1.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
  }, 240_000);

  it('the agent sees BOTH twins, each with its own intent', async () => {
    expect(twinA).not.toBe(twinB); // identical fingerprint, two identities
    const text = await listAuthorizations();
    expect(text).toContain('TWIN-A');
    expect(text).toContain('TWIN-B');
    // Two separate grant blocks despite the identical fingerprint.
    const blocks = (text.match(/email@0\.4/g) ?? []).length;
    expect(blocks).toBeGreaterThanOrEqual(2);
  });

  it('revoking twin A removes ONLY twin A from the agent\'s view', async () => {
    await sp.revokeAuthorization(gwApiKey, twinA, 'parity: revoke one twin');

    // Propagation trigger: in production the control plane reacts to the
    // revoke event by POSTing /internal/resync-gates on the MCP server. The
    // e2e runs the MCP server alone, so fire the same trigger directly —
    // resync re-syncs every stored gate by its per-ceremony id, and
    // syncAuthorization drops revoked grants from the cache.
    const resync = await fetch(`${GW_URL}/internal/resync-gates`, { method: 'POST' });
    expect(resync.ok).toBe(true);

    const text = await listAuthorizations();
    expect(text).not.toContain('TWIN-A');
    expect(text).toContain('TWIN-B'); // the surviving twin keeps its intent
  });
});
