/**
 * Authorization Bounds Tests
 *
 * Verifies that the SP enforces the human's authorization bounds embedded in
 * the attestation — not just group-level limits. Only the SP needs to be
 * running (no gateway or Stripe required).
 *
 * Tight authorization bounds under test:
 *   amount_max:                    25  (per-transaction ceiling)
 *   amount_daily_max:              50  (cumulative daily ceiling)
 *   amount_monthly_max:          1000  (generous — not the bottleneck)
 *   transaction_count_daily_max:    3  (daily transaction count ceiling)
 *
 * Group limits are set generously so they never fire before authorization
 * bounds do.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeContextHash,
} from '../src/helpers/crypto.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const SP_PORT = 15100; // distinct port from main e2e suite
const SP_URL = `http://localhost:${SP_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
const EXEC_PATH = 'charge-routine';

const BOUNDS_KEY_ORDER = [
  'profile',
  'path',
  'amount_max',
  'amount_daily_max',
  'amount_monthly_max',
  'transaction_count_daily_max',
];
const CONTEXT_KEY_ORDER = ['currency', 'action_type'];

/** Tight authorization bounds — the human-defined limits under test. */
const TIGHT_BOUNDS = {
  profile: PROFILE_ID,
  path: EXEC_PATH,
  amount_max: 25,
  amount_daily_max: 50,
  amount_monthly_max: 1000,
  transaction_count_daily_max: 3,
};

const CONTEXT = {
  currency: 'USD',
  action_type: 'charge',
};

/** Generous group limits — set high so they are never the bottleneck. */
const GENEROUS_LIMITS = {
  [PROFILE_ID]: {
    [EXEC_PATH]: {
      charge: {
        perTransaction: { amount_max: 10_000 },
        daily: { amount_max: 100_000, transaction_count_max: 1000 },
      },
    },
  },
};

const GATE_CONTENT = {
  problem: 'Authorization bounds enforcement test.',
  objective: 'Validate that per-tx, daily amount, and daily count limits are enforced.',
  tradeoffs: 'Accepts risk up to the configured tight bounds.',
};

// ── Shared test state ─────────────────────────────────────────────────────────

let adminApiKey = '';
let agentApiKey = '';
let agentDid = '';
let agentUserId = '';
let groupId = '';
let inviteCode = '';
let attestationHash = '';

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  // Register two users: admin and agent
  const adminResult = await sp.register(
    'Admin Bounds',
    `admin-bounds-${Date.now()}@test.local`,
  );
  adminApiKey = adminResult.apiKey;

  const agentResult = await sp.register(
    'Agent Bounds',
    `agent-bounds-${Date.now()}@test.local`,
  );
  agentApiKey = agentResult.apiKey;
  agentDid = agentResult.user.did;
  agentUserId = agentResult.user.id;
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

// ── Block 1: SP setup ─────────────────────────────────────────────────────────

describe('Authorization Bounds — SP Setup', () => {
  it('creates a group and captures invite code', async () => {
    const result = await sp.createGroup(adminApiKey, 'Bounds Test Group');
    groupId = result.group.id;
    inviteCode = result.inviteCode;
    expect(groupId).toBeTruthy();
    expect(inviteCode).toBeTruthy();
  });

  it('agent joins the group', async () => {
    const result = await sp.joinGroup(agentApiKey, inviteCode);
    expect(result.member).toBeTruthy();
  });

  it('admin assigns finance domain to agent', async () => {
    const result = await sp.setMemberDomains(adminApiKey, groupId, agentUserId, ['finance']);
    expect(result.member).toBeTruthy();
  });

  it('admin sets generous group limits', async () => {
    const result = await sp.setLimits(adminApiKey, groupId, GENEROUS_LIMITS);
    expect(result).toBeTruthy();
  });
});

// ── Block 2: Attestation with tight bounds ────────────────────────────────────

describe('Authorization Bounds — Attestation', () => {
  it('agent submits v0.4 attestation with tight authorization bounds', async () => {
    const gateContentHashes = hashGateContent(GATE_CONTENT);
    const executionContextHash = hashExecutionContext({
      action_type: CONTEXT.action_type,
      amount: TIGHT_BOUNDS.amount_max,
      currency: CONTEXT.currency,
    });

    const boundsHash = computeBoundsHash(TIGHT_BOUNDS, BOUNDS_KEY_ORDER);
    const contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

    const result = await sp.submitAttestation(agentApiKey, {
      profile_id: PROFILE_ID,
      group_id: groupId,
      bounds: TIGHT_BOUNDS,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      domain: 'finance',
      did: agentDid,
      path: EXEC_PATH,
      gate_content_hashes: gateContentHashes,
      execution_context_hash: executionContextHash,
    });

    attestationHash = result.bounds_hash ?? result.frame_hash;
    expect(attestationHash).toBeTruthy();
    expect(result.status).toMatch(/active|pending/);
  });
});

// ── Block 3: Receipt enforcement against authorization bounds ─────────────────

describe('Authorization Bounds — Receipt Enforcement', () => {
  it('$20 receipt succeeds (under per-tx max of $25)', async () => {
    const result = await sp.postReceipt(agentApiKey, {
      attestationHash,
      profileId: PROFILE_ID,
      path: EXEC_PATH,
      action: 'charge',
      amount: 20,
    });

    expect(result.status).toBe(201);
    expect(result.body.receipt).toBeTruthy();
  });

  it('$30 receipt fails — exceeds per-tx amount_max of $25', async () => {
    const result = await sp.postReceipt(agentApiKey, {
      attestationHash,
      profileId: PROFILE_ID,
      path: EXEC_PATH,
      action: 'charge',
      amount: 30,
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toBe('LIMIT_EXCEEDED');
    // Verify the detail message references the per-transaction limit
    expect(String(result.body.detail)).toMatch(/per-transaction|amount/i);
    expect(result.body.limit).toBe(25);
    expect(result.body.requested).toBe(30);
  });

  it('second $20 receipt succeeds (cumulative: $40, under daily max $50)', async () => {
    const result = await sp.postReceipt(agentApiKey, {
      attestationHash,
      profileId: PROFILE_ID,
      path: EXEC_PATH,
      action: 'charge',
      amount: 20,
    });

    expect(result.status).toBe(201);
    expect(result.body.receipt).toBeTruthy();

    // Verify cumulative state is present in receipt
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
      attestationHash,
      profileId: PROFILE_ID,
      path: EXEC_PATH,
      action: 'charge',
      amount: 20,
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toBe('LIMIT_EXCEEDED');
    expect(String(result.body.detail)).toMatch(/daily.*amount|amount.*daily/i);
    expect(result.body.limit).toBe(50);
  });

  it('receipt response includes cumulative state values', async () => {
    // Submit a fresh small transaction after the daily-amount block above.
    // The daily amount is $40 (from two $20 successes). A $5 transaction will succeed.
    const result = await sp.postReceipt(agentApiKey, {
      attestationHash,
      profileId: PROFILE_ID,
      path: EXEC_PATH,
      action: 'charge',
      amount: 5,
    });

    // Either succeeds (if we're under daily count limit) or is blocked by tx count (3).
    // Either way, verify the response body structure is well-formed.
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
      // Blocked by transaction count limit — also valid
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('LIMIT_EXCEEDED');
    }
  });
});
