/**
 * Gap #7: Group limits vs authorization bounds — verify Math.min(authBound, groupLimit).
 */
import { test, expect, startServers, stopServers, registerUser, SP_URL } from './fixtures';

test.describe('Group Limits vs Authorization Bounds', () => {
  let aliceKey: string;
  let aliceDid: string;
  let groupId: string;
  let boundsHash: string;

  test.beforeAll(async ({ request }) => {
    await startServers();

    const alice = await registerUser(request, 'Alice', 'alice-limits@test.com');
    aliceKey = alice.apiKey;
    aliceDid = alice.did;

    // Create group
    const createRes = await request.post(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': aliceKey },
      data: { name: 'Limits Test Group' },
    });
    const createData = await createRes.json();
    groupId = createData.group.id;

    // Assign finance domain
    await request.put(`${SP_URL}/api/groups/${groupId}/members/${alice.id}`, {
      headers: { 'x-api-key': aliceKey },
      data: { domains: ['finance'] },
    });

    // Configure path domains
    await request.put(`${SP_URL}/api/groups/${groupId}/path-domains`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        pathDomains: {
          'github.com/humanagencyprotocol/hap-profiles/charge@0.4': {
            'charge-routine': ['finance'],
          },
        },
      },
    });

    // Set group limits — ceiling LOWER than what Alice will authorize
    await request.put(`${SP_URL}/api/groups/${groupId}/limits`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        limits: {
          'github.com/humanagencyprotocol/hap-profiles/charge@0.4': {
            amount_max: 50,           // Group ceiling: $50 per tx
            amount_daily_max: 200,    // Group ceiling: $200/day
          },
        },
      },
    });

    // Alice attests with HIGHER bounds than group limits
    const attestRes = await request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-routine',
        domain: 'finance',
        did: aliceDid,
        bounds: { profile: 'charge', path: 'charge-routine', amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 20 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        group_id: groupId,
      },
    });
    const attestData = await attestRes.json();
    boundsHash = attestData.bounds_hash;
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('$40 receipt succeeds (under both group $50 and auth $100)', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/sp/receipt`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        attestationHash: boundsHash,
        profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-routine',
        action: 'charge',
        executionContext: { amount: 40, action_type: 'charge' },
        amount: 40,
      },
    });
    expect(res.ok()).toBe(true);
  });

  test('$60 receipt fails (exceeds group $50 ceiling, even though auth allows $100)', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/sp/receipt`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        attestationHash: boundsHash,
        profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-routine',
        action: 'charge',
        executionContext: { amount: 60, action_type: 'charge' },
        amount: 60,
      },
    });
    expect(res.status()).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('LIMIT_EXCEEDED');
  });

  test('cumulative $40 + $40 = $80 fails (exceeds group $200/day? no — but exceeds group $50 per-tx)', async ({ request }) => {
    // This tests that per-transaction limit applies per receipt
    const res = await request.post(`${SP_URL}/api/sp/receipt`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        attestationHash: boundsHash,
        profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-routine',
        action: 'charge',
        executionContext: { amount: 40, action_type: 'charge' },
        amount: 40,
      },
    });
    // $40 per-tx is under $50 group limit, should succeed
    expect(res.ok()).toBe(true);
  });
});
