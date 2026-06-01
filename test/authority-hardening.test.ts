/**
 * Authority Hardening Tests (H1, H2)
 *
 * Verifies the Authority Server defends the receipt path itself — not just the
 * gateway client. Only the AS is needed (no gateway).
 *
 *  - H1: a receipt whose cached bounds do NOT hash to the SIGNED bounds_hash is
 *        rejected with BOUNDS_HASH_MISMATCH. (Simulates a tampered/stale store:
 *        we sign an attestation with a bogus bounds_hash while storing real
 *        bounds; the AS must recompute the hash on receipt and reject.)
 *  - H2: a receipt posted by someone who is neither the attestation's creator
 *        nor an active member of its group is rejected with
 *        NOT_AUTHORIZED_FOR_ATTESTATION (closes cross-tenant bound consumption).
 *
 * H3 (fail-closed when Redis / signing key is absent in production) is covered
 * by unit tests in suveren-as (redis.ts / keys.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeContextHash,
} from '../src/helpers/crypto.js';

const SP_PORT = 15200;
const SP_URL = `http://localhost:${SP_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
const CONTEXT_KEY_ORDER = ['currency', 'action_type'];
const BOUNDS = {
  profile: PROFILE_ID,
  amount_max: 25,
  amount_daily_max: 50,
  amount_monthly_max: 1000,
  transaction_count_daily_max: 3,
};
const CONTEXT = { currency: 'USD', action_type: 'charge' };
const GATE_CONTENT = { intent: 'Authority hardening test — H1/H2 receipt defenses.' };
const BOGUS_BOUNDS_HASH = 'sha256:' + '0'.repeat(64);

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

let aliceKey = '';
let aliceDid = '';
let aliceGroup = '';
let bobKey = '';

function attestBody(extra: Record<string, unknown>) {
  return {
    profile_id: PROFILE_ID,
    group_id: aliceGroup,
    bounds: BOUNDS,
    context_hash: computeContextHash(CONTEXT, CONTEXT_KEY_ORDER),
    domain: 'owner',
    did: aliceDid,
    commitment_mode: 'automatic' as const,
    gate_content_hashes: hashGateContent(GATE_CONTENT),
    execution_context_hash: hashExecutionContext({
      action_type: CONTEXT.action_type,
      amount: BOUNDS.amount_max,
      currency: CONTEXT.currency,
    }),
    ...extra,
  };
}

const receiptBody = (attestationHash: string) => ({
  attestationHash,
  profileId: PROFILE_ID,
  action: 'charge',
  amount: 10,
  executionContext: { amount: 10, currency: 'USD', action_type: 'charge' },
});

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const alice = await sp.register('Alice Hardening', `alice-hard-${Date.now()}@test.local`);
  aliceKey = alice.apiKey;
  aliceDid = alice.user.did;
  aliceGroup = await sp.getPersonalGroupId(aliceKey);

  // Bob is a separate, unrelated user (his own personal group).
  const bob = await sp.register('Bob Hardening', `bob-hard-${Date.now()}@test.local`);
  bobKey = bob.apiKey;
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

// ── H1: bounds-hash binding on the receipt path ───────────────────────────────

describe('H1 — receipt rejects bounds that do not match the signed bounds_hash', () => {
  it('positive control: a correctly-signed attestation produces a valid receipt', async () => {
    // bounds_hash omitted → AS computes the correct one. Receipt should succeed.
    const att = await sp.submitAttestation(aliceKey, attestBody({}));
    const r = await sp.postReceipt(aliceKey, receiptBody(att.frame_hash));
    expect(r.status).toBe(201);
    expect(r.body.receipt).toBeTruthy();
  });

  it('rejects a receipt when the signed bounds_hash does not match the stored bounds', async () => {
    // Sign with a bogus bounds_hash while storing the real BOUNDS — the AS must
    // recompute the hash from the stored bounds on receipt and reject.
    const att = await sp.submitAttestation(aliceKey, attestBody({ bounds_hash: BOGUS_BOUNDS_HASH }));
    const r = await sp.postReceipt(aliceKey, receiptBody(att.frame_hash));

    expect(r.status).toBe(403);
    const err = (r.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('BOUNDS_HASH_MISMATCH');
  });
});

// ── H2: caller must own / belong to the attestation ───────────────────────────

describe('H2 — receipt rejects a caller who does not own the attestation', () => {
  it('blocks a different authenticated user from posting a receipt against the attestation', async () => {
    // Alice creates a (valid) attestation in her personal group.
    const att = await sp.submitAttestation(aliceKey, attestBody({}));

    // Bob is authenticated but is neither the creator nor a member of Alice's group.
    const r = await sp.postReceipt(bobKey, receiptBody(att.frame_hash));

    expect(r.status).toBe(403);
    const err = (r.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('NOT_AUTHORIZED_FOR_ATTESTATION');
  });

  it('still allows the rightful owner to post a receipt', async () => {
    const att = await sp.submitAttestation(aliceKey, attestBody({}));
    const r = await sp.postReceipt(aliceKey, receiptBody(att.frame_hash));
    expect(r.status).toBe(201);
  });
});
