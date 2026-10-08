/**
 * A profile can restrict the commitment modes its mandates are signed with
 * (`commitment_modes`, e.g. review only). The Authority Server is the place
 * that holds: signing an `automatic` mandate on a review-only profile is
 * refused by the AS itself — a direct API call, not a screen that hides a
 * button. Profiles without the field keep both modes.
 *
 * Uses throwaway community profiles authored on the AS (as
 * per-transaction-required-for.test.ts does), so no published profile has to
 * change for the test. No gateway needed: the subject is the AS's refusal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash } from '../src/helpers/crypto.js';

const SP_PORT = 18300;
const SP_URL = `http://localhost:${SP_PORT}`;
const BOUNDS_KEY_ORDER = ['profile', 'write_daily_max'];
const GATE_CONTENT = { intent: 'E2E fixture: commitment_modes coverage.' };

function testProfile(id: string, commitment_modes?: string[]) {
  return {
    id,
    name: 'E2E commitment_modes fixture',
    version: '1.0',
    description: 'Throwaway community profile for commitment_modes coverage. Not a published hap-profiles profile.',
    ...(commitment_modes ? { commitment_modes } : {}),
    boundsSchema: {
      actionTypes: ['write'],
      keyOrder: BOUNDS_KEY_ORDER,
      fields: {
        profile: { type: 'string', required: true },
        write_daily_max: {
          type: 'number', required: true, displayName: 'Writes per day', description: 'Test fixture.',
          unit: 'count', boundType: { kind: 'cumulative', of: 'count', window: 'daily' },
        },
      },
    },
    scopeSchema: { keyOrder: [], fields: {} },
    executionContextSchema: {
      fields: {
        action_type: { source: 'declared', description: 'write', required: true, constraint: { type: 'string', enforceable: ['enum'] } },
      },
    },
    requiredGates: ['intent'],
    ttl: { default: 3600, max: 86400 },
  };
}

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
let apiKey: string;
let did: string;
let groupId: string;

function attest(profileId: string, commitment_mode: string) {
  const bounds = { profile: profileId, write_daily_max: 5 };
  return sp.submitMandateRaw(apiKey, {
    authorization_id: `authz_${randomUUID()}`,
    profile_id: profileId, group_id: groupId, bounds,
    bounds_hash: computeBoundsHash(bounds, BOUNDS_KEY_ORDER),
    context_hash: computeScopeHash({}, []),
    domain: 'owner', did, commitment_mode,
    gate_content_hashes: hashGateContent(GATE_CONTENT),
    execution_context_hash: hashExecutionContext({ profile: profileId, commitment_mode }),
  });
}

describe('profile commitment_modes (real AS)', () => {
  let reviewOnly: string;
  let unrestricted: string;

  beforeAll(async () => {
    await pm.startSP(SP_PORT);
    const user = await sp.register('Commitment modes E2E', `commitment-modes-${Date.now()}@test.local`);
    apiKey = user.apiKey;
    did = user.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);
    reviewOnly = (await sp.createProfile(apiKey, testProfile('review-only-fixture@1.0', ['review']))).profile_id;
    unrestricted = (await sp.createProfile(apiKey, testProfile('unrestricted-fixture@1.0'))).profile_id;
  }, 300_000);

  afterAll(async () => {
    await pm.killAll();
  }, 30_000);

  it('the AS serves the declaration with the profile', async () => {
    const res = await fetch(`${SP_URL}/api/profiles/${encodeURIComponent(reviewOnly)}`);
    expect((await res.json()).commitment_modes).toEqual(['review']);
  });

  it('review-only profile: an automatic mandate is refused by the AS, nothing signed', async () => {
    const r = await attest(reviewOnly, 'automatic');
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('commitment_mode_not_allowed');
    expect(r.body.allowed).toEqual(['review']);
    expect(r.body.blob).toBeUndefined();
  });

  it('review-only profile: a review mandate is signed', async () => {
    const r = await attest(reviewOnly, 'review');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('a profile without the field: both modes are signed, as before', async () => {
    expect((await attest(unrestricted, 'automatic')).status).toBe(201);
    expect((await attest(unrestricted, 'review')).status).toBe(201);
  });
});
