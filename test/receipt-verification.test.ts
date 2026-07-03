/**
 * M1 — signed-receipt verification (POST /api/as/verify-receipt).
 *
 * Receipts are Ed25519-signed by the AS; this endpoint makes them
 * independently verifiable after the fact (the accountability half of the
 * manifest). Verifies that a genuine receipt validates, and that any
 * tampering — to a field or to the signature — is detected.
 *
 * Only the AS is needed (no gateway).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 15400;
const SP_URL = `http://localhost:${SP_PORT}`;
const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

let apiKey = '';
let did = '';
let groupId = '';
let receipt: Record<string, unknown>;

async function verifyReceipt(body: unknown) {
  const res = await fetch(`${SP_URL}/api/as/verify-receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const user = await sp.register('Receipt Verify', `receipt-verify-${Date.now()}@test.local`);
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
    gate_content_hashes: hashGateContent({ intent: 'Receipt verification test.' }),
    execution_context_hash: hashExecutionContext({ action_type: 'charge', amount: 20, currency: 'USD' }),
  });

  const r = await sp.postReceipt(apiKey, {
    authorizationId: att.authorization_id,
    profileId: PROFILE_ID,
    action: 'charge',
    amount: 20,
    executionContext: { amount: 20, currency: 'USD', action_type: 'charge' },
  });
  expect(r.status).toBe(201);
  receipt = r.body.receipt as Record<string, unknown>;
  expect(receipt.signature).toBeTruthy();
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

describe('M1 — receipt verification endpoint', () => {
  it('validates a genuine signed receipt', async () => {
    const res = await verifyReceipt({ receipt });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('rejects a receipt with a tampered field', async () => {
    const tampered = { ...receipt, action: 'charge_tampered' };
    const res = await verifyReceipt({ receipt: tampered });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('rejects a receipt with a tampered cumulative-state value', async () => {
    const tampered = {
      ...receipt,
      cumulativeState: { daily: { amount: 999999, count: 1 }, monthly: { amount: 999999, count: 1 } },
    };
    const res = await verifyReceipt({ receipt: tampered });
    expect(res.body.valid).toBe(false);
  });

  it('rejects a receipt with a forged signature', async () => {
    const forged = { ...receipt, signature: Buffer.from('not-a-real-signature').toString('base64') };
    const res = await verifyReceipt({ receipt: forged });
    expect(res.body.valid).toBe(false);
  });

  it('400s when the receipt is missing', async () => {
    const res = await verifyReceipt({});
    expect(res.status).toBe(400);
  });
});
