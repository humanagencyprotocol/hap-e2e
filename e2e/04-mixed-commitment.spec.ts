/**
 * Gap #5: Mixed commitment — one domain commits immediately,
 * another defers commitment. Tool call creates proposal for deferred domain.
 */
import { test, expect, startServers, stopServers, registerUser, SP_URL } from './fixtures';

test.describe('Mixed Commitment (Multi-Domain)', () => {
  let aliceKey: string;
  let aliceDid: string;
  let bobKey: string;
  let bobDid: string;
  let groupId: string;
  let boundsHash: string;

  test.beforeAll(async ({ request }) => {
    await startServers();

    const alice = await registerUser(request, 'Alice', 'alice-mixed@test.com');
    aliceKey = alice.apiKey;
    aliceDid = alice.did;
    const bob = await registerUser(request, 'Bob', 'bob-mixed@test.com');
    bobKey = bob.apiKey;
    bobDid = bob.did;

    // Setup group with two domains
    const createRes = await request.post(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': aliceKey },
      data: { name: 'Mixed Commitment Team' },
    });
    const createData = await createRes.json();
    groupId = createData.group.id;

    await request.post(`${SP_URL}/api/groups/join`, {
      headers: { 'x-api-key': bobKey },
      data: { inviteCode: createData.inviteCode },
    });

    await request.put(`${SP_URL}/api/groups/${groupId}/members/${alice.id}`, {
      headers: { 'x-api-key': aliceKey },
      data: { domains: ['finance'] },
    });
    await request.put(`${SP_URL}/api/groups/${groupId}/members/${bob.id}`, {
      headers: { 'x-api-key': aliceKey },
      data: { domains: ['compliance'] },
    });

    await request.put(`${SP_URL}/api/groups/${groupId}/path-domains`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        pathDomains: {
          'github.com/humanagencyprotocol/hap-profiles/charge@0.4': {
            'charge-reviewed': ['finance', 'compliance'],
          },
        },
      },
    });
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('Alice attests with immediate commitment', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-reviewed',
        domain: 'finance',
        did: aliceDid,
        bounds: { profile: 'charge', path: 'charge-reviewed', amount_max: 200, amount_daily_max: 1000, amount_monthly_max: 10000, transaction_count_daily_max: 20 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        group_id: groupId,
      },
    });
    const data = await res.json();
    expect(data.status).toBe('pending'); // compliance not yet attested
    expect(data.commitment).toBe('immediate');
    boundsHash = data.bounds_hash;
  });

  test('Bob attests with deferred commitment', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': bobKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-reviewed',
        domain: 'compliance',
        did: bobDid,
        bounds: { profile: 'charge', path: 'charge-reviewed', amount_max: 200, amount_daily_max: 1000, amount_monthly_max: 10000, transaction_count_daily_max: 20 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        group_id: groupId,
        defer_commitment: true,
      },
    });
    const data = await res.json();
    expect(data.status).toBe('active'); // both domains attested
    expect(data.commitment).toBe('deferred');
    expect(data.deferred_commitment_domains).toContain('compliance');
  });

  test('attestation response shows mixed commitment modes', async ({ request }) => {
    const res = await request.get(`${SP_URL}/api/attestations?frame_hash=${encodeURIComponent(boundsHash)}`, {
      headers: { 'x-api-key': aliceKey },
    });
    const data = await res.json();

    expect(data.complete).toBe(true);
    expect(data.deferred_commitment_domains).toContain('compliance');
    expect(data.deferred_commitment_domains).not.toContain('finance');

    const financeAtt = data.attestations.find((a: { domain: string }) => a.domain === 'finance');
    const complianceAtt = data.attestations.find((a: { domain: string }) => a.domain === 'compliance');
    expect(financeAtt.commitment).toBe('immediate');
    expect(complianceAtt.commitment).toBe('deferred');
  });
});
