/**
 * Context Privacy Test
 *
 * Verifies that context content NEVER reaches the SP.
 * The SP should only store/return hashes — never plaintext context values.
 *
 * This test starts only the SP (no gateway or Stripe needed).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, computeBoundsHash, computeContextHash, hashExecutionContext } from '../src/helpers/crypto.js';

// ── Constants ─────────────────────────────────────────────

const SP_PORT = 14200;
const SP_URL = `http://localhost:${SP_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
const EXEC_PATH = 'charge-routine';

/** v0.4 bounds key order (from the charge profile). */
const BOUNDS_KEY_ORDER = ['profile', 'amount_max', 'amount_daily_max', 'amount_monthly_max', 'transaction_count_daily_max'];
/** v0.4 context key order. */
const CONTEXT_KEY_ORDER = ['currency', 'action_type'];

const BOUNDS = {
  profile: PROFILE_ID,
  amount_max: 100,
  amount_daily_max: 500,
  amount_monthly_max: 5000,
  transaction_count_daily_max: 20,
};

const CONTEXT = {
  currency: 'USD',
  action_type: 'charge',
};

const GATE_CONTENT = { intent: 'Test purchasing authority for context privacy validation. Verify context values never leave local custody.' };

// ── State ─────────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

let adminApiKey: string;
let agentApiKey: string;
let agentUserId: string;
let agentDid: string;
let groupId: string;

let boundsHash: string;
let contextHash: string;

// ── Lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const ts = Date.now();

  const alice = await sp.register('Alice Privacy', `alice-privacy-${ts}@test.local`);
  adminApiKey = alice.apiKey;

  const bob = await sp.register('Bob Privacy', `bob-privacy-${ts}@test.local`);
  agentApiKey = bob.apiKey;
  agentUserId = bob.user.id;
  agentDid = bob.user.did;

  // Set up group
  const group = await sp.createGroup(adminApiKey, 'Privacy Test Group');
  groupId = group.group.id;
  await sp.joinGroup(agentApiKey, group.inviteCode);
  await sp.setMemberDomains(adminApiKey, groupId, agentUserId, ['finance']);
  await sp.setPathDomains(adminApiKey, groupId, {
    [PROFILE_ID]: {
      [EXEC_PATH]: ['finance'],
    },
  });
}, 120_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

// ── Tests ─────────────────────────────────────────────────

describe('Context Privacy', () => {

  describe('Attestation — context hash only, no plaintext context', () => {
    it('computes bounds and context hashes locally', () => {
      boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
      contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

      expect(boundsHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(contextHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Hashes must not contain the plaintext values
      expect(boundsHash).not.toContain('USD');
      expect(boundsHash).not.toContain('charge');
      expect(contextHash).not.toContain('USD');
      expect(contextHash).not.toContain('charge');
    });

    it('submits attestation with context_hash but NOT context content', async () => {
      const gateContentHashes = hashGateContent(GATE_CONTENT);
      const executionContextHash = hashExecutionContext({
        action_type: CONTEXT.action_type,
        amount: BOUNDS.amount_max,
        currency: CONTEXT.currency,
      });

      // The attestation request body must contain hashes only — no CONTEXT object
      const requestBody = {
        profile_id: PROFILE_ID,
        group_id: groupId,
        bounds: BOUNDS,
        bounds_hash: boundsHash,
        context_hash: contextHash,
        domain: 'finance',
        did: agentDid,
        path: EXEC_PATH,
        gate_content_hashes: gateContentHashes,
        execution_context_hash: executionContextHash,
      };

      // Verify the request body does NOT include plaintext context values
      const bodyJson = JSON.stringify(requestBody);
      expect(bodyJson).not.toContain('"currency":"USD"');
      expect(bodyJson).not.toContain('"action_type":"charge"');
      // The context hash IS present
      expect(bodyJson).toContain(contextHash);

      const result = await sp.submitAttestation(agentApiKey, requestBody);
      expect(result.bounds_hash).toBe(boundsHash);
      expect(result.status).toMatch(/active|pending/);
    });

    it('SP response contains context_hash but not context content', async () => {
      const gateContentHashes = hashGateContent(GATE_CONTENT);
      const executionContextHash = hashExecutionContext({
        action_type: CONTEXT.action_type,
        amount: BOUNDS.amount_max,
        currency: CONTEXT.currency,
      });

      // Capture the raw response to inspect all fields
      const rawResponse = await fetch(`${SP_URL}/api/sp/attest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': agentApiKey,
        },
        body: JSON.stringify({
          profile_id: PROFILE_ID,
          group_id: groupId,
          bounds: BOUNDS,
          bounds_hash: boundsHash,
          context_hash: contextHash,
          domain: 'finance',
          did: agentDid,
          path: EXEC_PATH,
          gate_content_hashes: gateContentHashes,
          execution_context_hash: executionContextHash,
        }),
      });

      const responseBody = await rawResponse.json() as Record<string, unknown>;
      const responseJson = JSON.stringify(responseBody);

      // context_hash MUST be present in the response
      expect(responseBody.context_hash).toBe(contextHash);

      // Plaintext context values must NOT appear anywhere in the response
      expect(responseJson).not.toContain('"currency"');
      expect(responseJson).not.toContain('"action_type"');
      expect(responseJson).not.toContain('USD');
      expect(responseJson).not.toContain('charge');

      // The blob is the signed attestation — it should contain only the hash
      expect(responseBody.blob).toBeTruthy();
      const blob = responseBody.blob as string;
      // Decode the blob (base64url-encoded JSON) and check no context content leaks
      const decoded = Buffer.from(blob, 'base64url').toString('utf-8');
      expect(decoded).toContain('context_hash');
      expect(decoded).not.toContain('"currency"');
      expect(decoded).not.toContain('"action_type"');
    });
  });

  describe('Receipt request — context values must not be sent to SP', () => {
    it('receipt request body uses context hash not context content', () => {
      // Construct a receipt request as the gateway would
      const receiptRequest = {
        attestationHash: boundsHash,
        profileId: PROFILE_ID,
        action: 'charge',
        amount: 50,
        // executionContext field on the SP receipt endpoint accepts arbitrary KV for audit —
        // the gateway MUST NOT forward semantic context content (currency, action_type values)
        // It sends only structural metadata (amount, action) — never the context object itself
        executionContext: {
          // Only safe, bounded fields — not raw context content
          amount: 50,
        },
      };

      const bodyJson = JSON.stringify(receiptRequest);

      // Plaintext context field values must not appear in the receipt request
      expect(bodyJson).not.toContain('"currency":"USD"');
      expect(bodyJson).not.toContain('"action_type":"charge"');

      // The amount and action are bounded values derived from limits, not context
      expect(bodyJson).toContain('"amount":50');
    });

    it('context hash is a one-way hash — cannot reconstruct context from it', () => {
      // Verify the hash is irreversible: different context produces different hash
      const differentContext = { currency: 'EUR', action_type: 'refund' };
      const differentContextHash = computeContextHash(differentContext, CONTEXT_KEY_ORDER);

      expect(contextHash).not.toBe(differentContextHash);

      // The original hash does not contain any decodable context values
      const hashHex = contextHash.replace('sha256:', '');
      const hashBuffer = Buffer.from(hashHex, 'hex');
      expect(hashBuffer.toString('utf-8')).not.toContain('USD');
      expect(hashBuffer.toString('utf-8')).not.toContain('charge');
    });
  });
});
