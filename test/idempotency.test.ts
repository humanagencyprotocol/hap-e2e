/**
 * M3 — automatic-mode idempotency (replay protection).
 *
 * Automatic mode issues a receipt and increments cumulative state at call
 * time, so a naively retried POST would double-count against the authority's
 * bounds. (Review mode is already replay-safe via the proposal commit→executed
 * CAS.) The gateway sends a stable `idempotencyKey` per logical tool call; a
 * replay with the same key must return the ORIGINAL receipt and leave
 * cumulative state untouched.
 *
 * Only the AS is needed (no gateway).
 *
 * The final block is the exception: it drives the REAL gateway SPClient (its
 * actual retry loop) against the real AS through a fault-injected transport,
 * closing the seam that the other tests only cover transitively.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeContextHash } from '../src/helpers/crypto.js';
// The production gateway's receipt client — imported from the gateway source so
// the integration test exercises the SAME retry/idempotency code that ships,
// not a re-implementation. It is dependency-free (uses only globalThis.fetch),
// so this cross-package import drags in no other gateway internals.
import { SPClient as GatewaySPClient } from '../../suveren-gateway/apps/mcp-server/src/lib/sp-client.ts';

const SP_PORT = 15401;
const SP_URL = `http://localhost:${SP_PORT}`;
const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

let apiKey = '';
let did = '';
let groupId = '';
let frameHash = '';

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const user = await sp.register('Idempotency', `idempotency-${Date.now()}@test.local`);
  apiKey = user.apiKey;
  did = user.user.did;
  groupId = await sp.getPersonalGroupId(apiKey);

  const att = await sp.submitAttestation(apiKey, {
    profile_id: PROFILE_ID,
    group_id: groupId,
    bounds: { profile: PROFILE_ID, amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 20 },
    context_hash: computeContextHash({ currency: 'USD', action_type: 'charge' }, ['currency', 'action_type']),
    domain: 'owner',
    did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent({ intent: 'Idempotency replay test.' }),
    execution_context_hash: hashExecutionContext({ action_type: 'charge', amount: 30, currency: 'USD' }),
  });
  frameHash = att.frame_hash;
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

describe('M3 — automatic-mode idempotency', () => {
  const key = `idem-${Date.now()}-A`;
  const receiptBody = {
    attestationHash: '',
    profileId: PROFILE_ID,
    action: 'charge',
    amount: 30,
    executionContext: { amount: 30, currency: 'USD', action_type: 'charge' },
    idempotencyKey: key,
  };

  let firstReceiptId = '';

  it('issues a receipt on first POST (201)', async () => {
    receiptBody.attestationHash = frameHash;
    const r = await sp.postReceipt(apiKey, receiptBody);
    expect(r.status).toBe(201);
    const receipt = r.body.receipt as Record<string, unknown>;
    expect(receipt.id).toBeTruthy();
    firstReceiptId = receipt.id as string;
    const cum = receipt.cumulativeState as { daily: { amount: number; count: number } };
    expect(cum.daily.count).toBe(1);
    expect(cum.daily.amount).toBe(30);
  });

  it('returns the SAME receipt on replay (200, idempotent) without double-counting', async () => {
    const r = await sp.postReceipt(apiKey, receiptBody);
    expect(r.status).toBe(200);
    expect(r.body.idempotent).toBe(true);
    const receipt = r.body.receipt as Record<string, unknown>;
    // Same receipt id — not a freshly minted one.
    expect(receipt.id).toBe(firstReceiptId);
    // Cumulative state is the original (count still 1, amount still 30).
    const cum = receipt.cumulativeState as { daily: { amount: number; count: number } };
    expect(cum.daily.count).toBe(1);
    expect(cum.daily.amount).toBe(30);
  });

  it('treats a different idempotencyKey as a new execution (counts again)', async () => {
    const r = await sp.postReceipt(apiKey, {
      ...receiptBody,
      idempotencyKey: `${key}-DISTINCT`,
    });
    expect(r.status).toBe(201);
    const receipt = r.body.receipt as Record<string, unknown>;
    expect(receipt.id).not.toBe(firstReceiptId);
    const cum = receipt.cumulativeState as { daily: { amount: number; count: number } };
    // Now the second genuine execution: count 2, amount 60.
    expect(cum.daily.count).toBe(2);
    expect(cum.daily.amount).toBe(60);
  });

  it('REJECTS a synchronous receipt with no idempotencyKey (now required)', async () => {
    // The key is required on the synchronous (automatic) path so exactly-once is
    // guaranteed, not opt-in. Bypass the SPClient helper (which auto-defaults a
    // key) with a raw fetch to genuinely omit it.
    const res = await fetch(`${SP_URL}/api/as/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({
        // v0.5 wire: bare boundsHash (frameHash is `${boundsHash}:${userId}`).
        boundsHash: frameHash.split(':').slice(0, 2).join(':'),
        profileId: PROFILE_ID,
        action: 'charge',
        amount: 10,
        executionContext: { amount: 10, currency: 'USD', action_type: 'charge' },
        // no idempotencyKey
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: Array<{ code: string }> };
    expect(body.errors?.[0]?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('lost-response recovery: a replay creates NO second receipt record', async () => {
    // The deployed end-to-end guarantee: when the gateway retries after a lost
    // response (same idempotencyKey), the AS must not just leave the counter
    // unchanged — it must not persist a second receipt at all. We assert on the
    // authoritative receipt index, not on the response body.
    const lostKey = `idem-${Date.now()}-LOST`;
    const body = {
      attestationHash: frameHash,
      profileId: PROFILE_ID,
      action: 'charge',
      amount: 5,
      executionContext: { amount: 5, currency: 'USD', action_type: 'charge' },
      idempotencyKey: lostKey,
    };

    const before = (await sp.getGroupReceipts(apiKey, groupId)).receipts.length;

    const first = await sp.postReceipt(apiKey, body); // AS commits + persists
    expect(first.status).toBe(201);
    const retry = await sp.postReceipt(apiKey, body); // the "lost response" retry
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);

    const after = (await sp.getGroupReceipts(apiKey, groupId)).receipts.length;
    expect(after - before).toBe(1); // exactly one record for one logical execution
    expect((retry.body.receipt as { id: string }).id).toBe(
      (first.body.receipt as { id: string }).id,
    );
  });

  it('rejects a key reused for a DIFFERENT execution with IDEMPOTENCY_MISMATCH', async () => {
    // A key identifies one execution. Reusing it with a different payload is a
    // distinct action, not a retry — the AS must reject rather than return the
    // original receipt (which would let the new action proceed uncounted).
    const conflictKey = `idem-${Date.now()}-CONFLICT`;
    const mk = (amount: number) => ({
      attestationHash: frameHash,
      profileId: PROFILE_ID,
      action: 'charge',
      amount,
      executionContext: { amount, currency: 'USD', action_type: 'charge' },
      idempotencyKey: conflictKey,
    });

    const first = await sp.postReceipt(apiKey, mk(7));
    expect(first.status).toBe(201);

    // Same key, different executionContext (amount 8 vs 7) → conflict.
    const conflict = await sp.postReceipt(apiKey, mk(8));
    expect(conflict.status).toBe(409);
    const errors = conflict.body.errors as Array<{ code: string }> | undefined;
    expect(errors?.[0]?.code).toBe('IDEMPOTENCY_MISMATCH');

    // Same key, SAME payload still returns the original (only different payloads conflict).
    const replay = await sp.postReceipt(apiKey, mk(7));
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
    expect((replay.body.receipt as { id: string }).id).toBe(
      (first.body.receipt as { id: string }).id,
    );
  });
});

/**
 * Integrated seam test — the REAL gateway SPClient against the REAL AS, with a
 * fault-injected transport.
 *
 * The tests above prove the AS dedup contract using hap-e2e's own client; the
 * gateway's retry/idempotency unit tests prove the client behaviour against a
 * stubbed fetch. Neither runs both halves together, so the end-to-end guarantee
 * was only ever inferred ("the gateway reuses the key" + "the AS honours it").
 *
 * This block removes the inference. It instantiates the production gateway
 * SPClient, points it at the live AS, and wraps globalThis.fetch so the FIRST
 * receipt request reaches the AS (which commits + counts the execution) and
 * then throws — exactly the "AS committed but the response was lost" failure.
 * The gateway's real retry loop fires with the SAME idempotency key, and we
 * assert the authoritative AS state shows ONE execution, not two.
 *
 * A fresh user/attestation isolates this from the count-sensitive tests above;
 * the AS process spawned in the file-level beforeAll is reused.
 */
describe('M3 seam — real gateway client + real AS + lost response', () => {
  let gwApiKey = '';
  let gwFrameHash = '';

  beforeAll(async () => {
    const user = await sp.register('Idem Seam', `idem-seam-${Date.now()}@test.local`);
    gwApiKey = user.apiKey;
    const gwGroupId = await sp.getPersonalGroupId(gwApiKey);
    const att = await sp.submitAttestation(gwApiKey, {
      profile_id: PROFILE_ID,
      group_id: gwGroupId,
      bounds: { profile: PROFILE_ID, amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 20 },
      context_hash: computeContextHash({ currency: 'USD', action_type: 'charge' }, ['currency', 'action_type']),
      domain: 'owner',
      did: user.user.did,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: 'Seam test.' }),
      execution_context_hash: hashExecutionContext({ action_type: 'charge', amount: 40, currency: 'USD' }),
    });
    gwFrameHash = att.frame_hash;
  }, 60_000);

  it('recovers a lost response end-to-end: one execution, counted once', async () => {
    const realFetch = globalThis.fetch;
    let receiptAttempts = 0;
    // Fault injection: the AS really processes the first receipt request (so it
    // commits and records the idempotency mapping), but the gateway never sees
    // the response — it's dropped, as a real socket reset would.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/as/receipt')) {
        receiptAttempts++;
        if (receiptAttempts === 1) {
          await realFetch(input as Parameters<typeof realFetch>[0], init); // AS commits + counts
          throw new TypeError('simulated lost response'); // gateway never sees it
        }
      }
      return realFetch(input as Parameters<typeof realFetch>[0], init);
    }) as typeof globalThis.fetch;

    try {
      // The production retry client, with short backoff for the test.
      const gw = new GatewaySPClient(SP_URL, { maxAttempts: 3, delaysMs: [10, 30] });
      gw.setApiKey(gwApiKey);

      const { receipt } = await gw.postReceipt({
        // v0.5 wire: bare boundsHash (gwFrameHash is `${boundsHash}:${userId}`).
        boundsHash: gwFrameHash.split(':').slice(0, 2).join(':'),
        profileId: PROFILE_ID,
        action: 'charge',
        actionType: 'charge',
        executionContext: { amount: 40, currency: 'USD', action_type: 'charge' },
        amount: 40,
        idempotencyKey: `seam-${Date.now()}`,
      });

      // The client retried after the lost response...
      expect(receiptAttempts).toBe(2);
      // ...and surfaced a receipt whose cumulative state reflects ONE execution.
      const cum = receipt.cumulativeState as { daily: { amount: number; count: number } };
      expect(cum.daily.count).toBe(1);
      expect(cum.daily.amount).toBe(40);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Authoritative AS state: exactly one receipt persisted for one execution.
    const receipts = (await sp.getGroupReceipts(gwApiKey, await sp.getPersonalGroupId(gwApiKey))).receipts;
    expect(receipts.length).toBe(1);
  });
});
