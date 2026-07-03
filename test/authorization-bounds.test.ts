/**
 * Authorization Bounds Tests (v0.4)
 *
 * Verifies that the Authority Server enforces the human's authorization bounds
 * embedded in the attestation. Only the AS needs to be running (no gateway or
 * Stripe). Uses a personal group (auto-provisioned 'owner' domain) — the bounds
 * under test live on the attestation itself, not on any group ceiling.
 *
 * Tight authorization bounds under test:
 *   amount_max:                    25  (per-transaction ceiling)
 *   amount_daily_max:              50  (cumulative daily ceiling)
 *   amount_monthly_max:          1000  (generous — not the bottleneck)
 *   transaction_count_daily_max:    3  (daily transaction count ceiling)
 *
 * v0.4 notes:
 * - No execution paths. Bounds + context replace the v0.3 frame.
 * - `bounds_hash` is intentionally NOT sent: the AS computes it from `bounds`
 *   and the profile, so the receipt-time bounds-hash binding (authority
 *   hardening H1) verifies by construction.
 * - Receipt failures use the v0.4 envelope: { approved:false, errors:[{ code, expected, actual }] }.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeContextHash,
} from '../src/helpers/crypto.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const SP_PORT = 15100; // distinct port from main e2e suite
const SP_URL = `http://localhost:${SP_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';

const CONTEXT_KEY_ORDER = ['currency', 'action_type'];

/** Tight authorization bounds — the human-defined limits under test. */
const TIGHT_BOUNDS = {
  profile: PROFILE_ID,
  amount_max: 25,
  amount_daily_max: 50,
  amount_monthly_max: 1000,
  transaction_count_daily_max: 3,
};

const CONTEXT = {
  currency: 'USD',
  action_type: 'charge',
};

const GATE_CONTENT = { intent: 'Authorization bounds enforcement test. Validate per-tx, daily amount, and daily count limits.' };

// ── Shared test state ─────────────────────────────────────────────────────────

let agentApiKey = '';
let agentDid = '';
let groupId = '';
let authorizationId = '';

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const agentResult = await sp.register(
    'Agent Bounds',
    `agent-bounds-${Date.now()}@test.local`,
  );
  agentApiKey = agentResult.apiKey;
  agentDid = agentResult.user.did;

  // v0.4: every attestation belongs to a group. Use the user's personal group,
  // which auto-provisions the 'owner' domain on first attest — no admin/join/
  // path-domain ceremony required.
  groupId = await sp.getPersonalGroupId(agentApiKey);
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

// ── Block 1: Attestation with tight bounds ────────────────────────────────────

describe('Authorization Bounds — Attestation', () => {
  it('submits a v0.4 attestation with tight authorization bounds', async () => {
    const gateContentHashes = hashGateContent(GATE_CONTENT);
    const executionContextHash = hashExecutionContext({
      action_type: CONTEXT.action_type,
      amount: TIGHT_BOUNDS.amount_max,
      currency: CONTEXT.currency,
    });
    const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

    const result = await sp.submitAttestation(agentApiKey, {
      profile_id: PROFILE_ID,
      group_id: groupId,
      bounds: TIGHT_BOUNDS,
      // bounds_hash omitted on purpose — AS computes it from bounds + profile.
      context_hash: contextHash,
      domain: 'owner',
      did: agentDid,
      commitment_mode: 'automatic',
      gate_content_hashes: gateContentHashes,
      execution_context_hash: executionContextHash,
    });

    // The receipt route keys on the per-ceremony authorizationId, not on a
    // content fingerprint. The AS mints the id (or honours the caller-supplied
    // one) and returns it in authorization_id.
    authorizationId = result.authorization_id;
    expect(authorizationId).toBeTruthy();
    expect(result.status).toMatch(/active|pending/);
  });
});

// ── Block 2: Receipt enforcement against authorization bounds ─────────────────

describe('Authorization Bounds — Receipt Enforcement', () => {
  it('$20 receipt succeeds (under per-tx max of $25)', async () => {
    const result = await sp.postReceipt(agentApiKey, {
      authorizationId,
      profileId: PROFILE_ID,
      action: 'charge',
      amount: 20,
      executionContext: { amount: 20, currency: 'USD', action_type: 'charge' },
    });

    expect(result.status).toBe(201);
    expect(result.body.receipt).toBeTruthy();
  });

  it('$30 receipt fails — exceeds per-tx amount_max of $25', async () => {
    const result = await sp.postReceipt(agentApiKey, {
      authorizationId,
      profileId: PROFILE_ID,
      action: 'charge',
      amount: 30,
      executionContext: { amount: 30, currency: 'USD', action_type: 'charge' },
    });

    expect(result.status).toBe(403);
    const err = (result.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(String(err.message)).toMatch(/per-transaction|amount/i);
    expect(err.expected).toBe(25);
    expect(err.actual).toBe(30);
  });

  it('second $20 receipt succeeds (cumulative: $40, under daily max $50)', async () => {
    const result = await sp.postReceipt(agentApiKey, {
      authorizationId,
      profileId: PROFILE_ID,
      action: 'charge',
      amount: 20,
      executionContext: { amount: 20, currency: 'USD', action_type: 'charge' },
    });

    expect(result.status).toBe(201);
    expect(result.body.receipt).toBeTruthy();

    const receipt = result.body.receipt as Record<string, unknown>;
    const cumState = receipt.cumulativeState as Record<string, unknown> | undefined;
    if (cumState) {
      const daily = cumState.daily as Record<string, unknown>;
      expect(typeof daily.amount).toBe('number');
      expect(typeof daily.count).toBe('number');
    }
  });

  it('third $20 receipt fails — cumulative $60 exceeds daily amount_max of $50', async () => {
    const result = await sp.postReceipt(agentApiKey, {
      authorizationId,
      profileId: PROFILE_ID,
      action: 'charge',
      amount: 20,
      executionContext: { amount: 20, currency: 'USD', action_type: 'charge' },
    });

    expect(result.status).toBe(403);
    const err = (result.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(String(err.message)).toMatch(/daily.*amount|amount.*daily|cumulative/i);
    expect(err.expected).toBe(50);
  });

  it('receipt response includes cumulative state values', async () => {
    // Daily amount is $40 (from two $20 successes). A $5 transaction stays under
    // the $50 daily ceiling but may hit the daily count limit (3) — both valid.
    const result = await sp.postReceipt(agentApiKey, {
      authorizationId,
      profileId: PROFILE_ID,
      action: 'charge',
      amount: 5,
      executionContext: { amount: 5, currency: 'USD', action_type: 'charge' },
    });

    if (result.status === 201) {
      const receipt = result.body.receipt as Record<string, unknown>;
      expect(receipt).toBeTruthy();
      expect(typeof receipt.id).toBe('string');
      expect(typeof receipt.timestamp).toBe('number');
      const cumState = receipt.cumulativeState as Record<string, unknown>;
      expect(cumState).toBeTruthy();
      expect(cumState.daily).toBeTruthy();
      expect(cumState.monthly).toBeTruthy();
    } else {
      expect(result.status).toBe(403);
      const err = (result.body.errors as Array<Record<string, unknown>>)[0];
      expect(err.code).toBe('LIMIT_EXCEEDED');
    }
  });
});
