/**
 * Identity Assurance (v0.6) — AS chain against a real Authority Server.
 *
 * Operator verifies an account (as_vouched) → an attestation created with
 * disclose_identity carries a SIGNED `subjects` block → the verified name renders
 * in the footer line, and tampering with the name breaks the attestation signature.
 * (Footer rendering itself is unit-covered in the gateway; this proves the AS end.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';
import {
  decodeAttestationBlob, encodeAttestationBlob, deriveIdentityLine, verifyAttestationSignature,
} from '@humanagencyp/hap-core';

const SP_PORT = 17131;
const SP_URL = `http://localhost:${SP_PORT}`;
const ADMIN_KEY = 'local-dev-key'; // seed local-admin (ADMIN_USER_IDS=local-admin in the harness)

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/publish@0.4';
const BOUNDS_KEY_ORDER = ['profile', 'post_daily_max', 'post_monthly_max'];
const BOUNDS = { profile: PROFILE_ID, post_daily_max: 10, post_monthly_max: 50 };
const CONTEXT_KEY_ORDER = ['allowed_platforms', 'content_type', 'audience'];
const CONTEXT = { allowed_platforms: 'linkedin', content_type: 'text', audience: 'public' };
const GATE = { intent: 'E2E identity assurance — bounded public publishing.' };

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
let agent: { id: string; did: string; apiKey: string };
let groupId: string;
let spPubkey: string;

beforeAll(async () => {
  await pm.startSP(SP_PORT);
  const r = await sp.register('Identity Agent', `id-${Date.now()}@test.local`);
  agent = { id: r.user.id, did: r.user.did, apiKey: r.apiKey };
  groupId = await sp.getPersonalGroupId(agent.apiKey);
  spPubkey = (await (await fetch(`${SP_URL}/api/as/pubkey`)).json()).publicKey;
}, 120_000);

afterAll(async () => { await pm.killAll(); }, 30_000);

function adminVerify(userId: string, name: string) {
  return fetch(`${SP_URL}/api/admin/users/${encodeURIComponent(userId)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': ADMIN_KEY },
    body: JSON.stringify({ name }),
  });
}

function attest(extra: Record<string, unknown> = {}) {
  return sp.submitAttestation(agent.apiKey, {
    profile_id: PROFILE_ID,
    group_id: groupId,
    bounds: BOUNDS,
    bounds_hash: computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER),
    context_hash: computeContextHash(CONTEXT, CONTEXT_KEY_ORDER),
    domain: 'owner',
    did: agent.did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(GATE),
    execution_context_hash: hashExecutionContext({
      allowed_platforms: 'linkedin', content_type: 'text', audience: 'public',
      post_count_daily: 10, post_count_monthly: 50,
    }),
    ...extra,
  } as Parameters<typeof sp.submitAttestation>[1]);
}

describe('Identity Assurance — operator verification → signed subject', () => {
  it('unverified account: no subjects even with disclose_identity', async () => {
    const r = await attest({ disclose_identity: true });
    expect(decodeAttestationBlob(r.blob).payload.subjects).toBeUndefined();
  });

  it('rejects a non-admin caller of the verify endpoint', async () => {
    const res = await fetch(`${SP_URL}/api/admin/users/${agent.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': agent.apiKey },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('operator verifies the account (admin only)', async () => {
    const res = await adminVerify(agent.id, 'Andreas Schadauer');
    expect(res.status).toBe(200);
    expect((await res.json()).identity).toMatchObject({
      verified_name: 'Andreas Schadauer', method: 'as_vouched', trust_root: 'as',
    });
  });

  it('verified + disclose: attestation carries a signed high/as_vouched subject', async () => {
    const r = await attest({ disclose_identity: true });
    const att = decodeAttestationBlob(r.blob);
    expect(att.payload.subjects).toHaveLength(1);
    expect(att.payload.subjects![0]).toMatchObject({
      assurance: 'high', method: 'as_vouched', trust_root: 'as', disclose: { name: 'Andreas Schadauer' },
    });
    expect(deriveIdentityLine(att.payload.subjects![0], { operatorName: 'Suveren' }))
      .toBe('Sent by an AI agent of Andreas Schadauer — verified by Suveren');
    // the subject is INSIDE the signed payload
    await expect(verifyAttestationSignature(att, spPubkey)).resolves.toBeUndefined();
  });

  it('verified but NOT disclosing: no subjects', async () => {
    const r = await attest({});
    expect(decodeAttestationBlob(r.blob).payload.subjects).toBeUndefined();
  });

  it('tamper: swapping disclose.name breaks the attestation signature', async () => {
    const r = await attest({ disclose_identity: true });
    const att = decodeAttestationBlob(r.blob);
    att.payload.subjects![0].disclose!.name = 'Mallory';
    const tampered = decodeAttestationBlob(encodeAttestationBlob(att));
    await expect(verifyAttestationSignature(tampered, spPubkey)).rejects.toThrow(/INVALID_SIGNATURE/);
  });
});
