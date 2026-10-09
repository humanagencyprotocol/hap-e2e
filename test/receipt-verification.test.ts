/**
 * M1 — signed-ticket verification (POST /api/as/verify-ticket; v0.7, moved
 * from POST /api/as/verify-receipt, which now answers 410).
 *
 * Tickets are Ed25519-signed by the AS; this endpoint makes them
 * independently verifiable after the fact (the accountability half of the
 * manifest). Verifies that a genuine ticket validates, and that any
 * tampering — to a field or to the signature — is detected.
 *
 * Only the AS is needed (no gateway).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeScopeHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';

const SP_PORT = 15400;
const SP_URL = `http://localhost:${SP_PORT}`;
const PROFILES_DIR = `${process.cwd()}/../hap-profiles`;
const PROFILE_ID = PROFILE_V07.charge;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

let apiKey = '';
let did = '';
let groupId = '';
let ticket: Record<string, unknown>;

async function verifyTicket(body: unknown) {
  const res = await fetch(`${SP_URL}/api/as/verify-ticket`, {
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

  const att = await sp.submitMandate(apiKey, {
    profile_id: PROFILE_ID,
    profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR),
    group_id: groupId,
    bounds: { profile: PROFILE_ID, amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 20 },
    scope_hash: computeScopeHash({ currency: 'USD', action_type: 'charge' }, ['currency', 'action_type']),
    domain: 'owner',
    did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent({ intent: 'Receipt verification test.' }),
    execution_context_hash: hashExecutionContext({ action_type: 'charge', amount: 20, currency: 'USD' }),
  });

  const r = await sp.postTicket(apiKey, {
    authorizationId: att.authorization_id,
    profileId: PROFILE_ID,
    action: 'charge',
    actionType: 'charge',
    amount: 20,
    executionContext: { amount: 20, currency: 'USD', action_type: 'charge' },
  });
  expect(r.status).toBe(201);
  ticket = r.body.ticket as Record<string, unknown>;
  expect(ticket.signature).toBeTruthy();
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

describe('M1 — ticket verification endpoint', () => {
  it('validates a genuine signed ticket', async () => {
    const res = await verifyTicket({ ticket });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('rejects a ticket with a tampered field', async () => {
    const tampered = { ...ticket, action: 'charge_tampered' };
    const res = await verifyTicket({ ticket: tampered });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('rejects a ticket with a tampered cumulative-state value', async () => {
    const tampered = {
      ...ticket,
      cumulativeState: { daily: { amount: 999999, count: 1 }, monthly: { amount: 999999, count: 1 } },
    };
    const res = await verifyTicket({ ticket: tampered });
    expect(res.body.valid).toBe(false);
  });

  it('rejects a ticket with a forged signature', async () => {
    const forged = { ...ticket, signature: Buffer.from('not-a-real-signature').toString('base64') };
    const res = await verifyTicket({ ticket: forged });
    expect(res.body.valid).toBe(false);
  });

  it('400s when the ticket is missing', async () => {
    const res = await verifyTicket({});
    expect(res.status).toBe(400);
  });
});
