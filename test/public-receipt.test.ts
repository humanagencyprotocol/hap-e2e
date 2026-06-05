/**
 * Public receipt endpoint — GET /api/as/public-receipt/:id.
 *
 * The public, unauthenticated lookup that backs the /r/:id verify page (the
 * target of "Verified by Suveren" links). Pins the two guarantees against a
 * REAL signed receipt issued by a running AS:
 *   1. Redaction — only the whitelisted public fields are returned; no userId,
 *      groupId, cumulativeState, limits, executionContext, or signature.
 *   2. Signature is re-verified server-side (signatureValid:true for a genuine
 *      receipt); unknown ids 404.
 *
 * Only the AS is needed (no gateway) — a receipt is minted via postReceipt, so
 * this runs without any OAuth integration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 15410;
const SP_URL = `http://localhost:${SP_PORT}`;
const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';

const PUBLIC_FIELDS = [
  'id', 'profileId', 'actionType', 'action', 'timestamp', 'boundsHashShort', 'issuer', 'signatureValid',
  // v0.5 Content Provenance — null on receipts whose profile declares no content_binding.
  'contentHash', 'contentBinding',
].sort();
const PRIVATE_FIELDS = ['userId', 'groupId', 'cumulativeState', 'limits', 'executionContext', 'path', 'signature'];

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

let did = '';
let groupId = '';
let receiptId = '';

async function getPublicReceipt(id: string) {
  const res = await fetch(`${SP_URL}/api/as/public-receipt/${id}`);
  return { status: res.status, raw: await res.text() };
}

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const user = await sp.register('Public Receipt', `public-receipt-${Date.now()}@test.local`);
  did = user.user.did;
  groupId = await sp.getPersonalGroupId(user.apiKey);

  const att = await sp.submitAttestation(user.apiKey, {
    profile_id: PROFILE_ID,
    group_id: groupId,
    bounds: { profile: PROFILE_ID, amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 20 },
    context_hash: computeContextHash({ currency: 'USD', action_type: 'charge' }, ['currency', 'action_type']),
    domain: 'owner',
    did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent({ intent: 'Public receipt endpoint test.' }),
    execution_context_hash: hashExecutionContext({ action_type: 'charge', amount: 20, currency: 'USD' }),
  });

  const r = await sp.postReceipt(user.apiKey, {
    attestationHash: att.frame_hash,
    profileId: PROFILE_ID,
    action: 'charge',
    amount: 20,
    executionContext: { amount: 20, currency: 'USD', action_type: 'charge' },
  });
  expect(r.status).toBe(201);
  receiptId = (r.body.receipt as { id: string }).id;
  expect(receiptId).toBeTruthy();
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

describe('GET /api/as/public-receipt/:id', () => {
  it('returns a redacted, signature-verified projection for a real receipt', async () => {
    const { status, raw } = await getPublicReceipt(receiptId);
    expect(status).toBe(200);
    const view = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(view).sort()).toEqual(PUBLIC_FIELDS);
    expect(view.signatureValid).toBe(true);
    expect(view.issuer).toBe('suveren.ai');
    expect(view.profileId).toBe(PROFILE_ID);
    expect(typeof view.boundsHashShort).toBe('string');
    expect((view.boundsHashShort as string).length).toBeGreaterThan(0);
  });

  it('never leaks private fields or values', async () => {
    const { raw } = await getPublicReceipt(receiptId);
    const view = JSON.parse(raw) as Record<string, unknown>;
    for (const f of PRIVATE_FIELDS) expect(view[f]).toBeUndefined();
    // value-level: the response must not contain the user's did or group id
    expect(raw).not.toContain(did);
    expect(raw).not.toContain(groupId);
  });

  it('404s for an unknown receipt id', async () => {
    const { status } = await getPublicReceipt('does-not-exist-xyz');
    expect(status).toBe(404);
  });
});
