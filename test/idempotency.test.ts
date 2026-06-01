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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeContextHash } from '../src/helpers/crypto.js';

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

  it('still issues a fresh receipt each time when no idempotencyKey is sent', async () => {
    const base = {
      attestationHash: frameHash,
      profileId: PROFILE_ID,
      action: 'charge',
      amount: 10,
      executionContext: { amount: 10, currency: 'USD', action_type: 'charge' },
    };
    const a = await sp.postReceipt(apiKey, base);
    const b = await sp.postReceipt(apiKey, base);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ra = a.body.receipt as Record<string, unknown>;
    const rb = b.body.receipt as Record<string, unknown>;
    expect(ra.id).not.toBe(rb.id);
    // Both counted: from 2 → 3 → 4.
    const cumA = ra.cumulativeState as { daily: { count: number } };
    const cumB = rb.cumulativeState as { daily: { count: number } };
    expect(cumA.daily.count).toBe(3);
    expect(cumB.daily.count).toBe(4);
  });
});
