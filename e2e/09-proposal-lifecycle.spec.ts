/**
 * Gap #3, #4: Proposal lifecycle — create proposal via SP API,
 * commit via domain owner, reject scenario.
 */
import { test, expect, startServers, stopServers, registerUser, SP_URL } from './fixtures';

test.describe('Proposal Lifecycle', () => {
  let userKey: string;
  let userDid: string;
  let boundsHash: string;

  test.beforeAll(async ({ request }) => {
    await startServers();

    const user = await registerUser(request, 'Frank', 'frank@test.com');
    userKey = user.apiKey;
    userDid = user.did;

    // Create attestation with deferred commitment
    const res = await request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': userKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write',
        domain: 'owner',
        did: userDid,
        bounds: { profile: 'customers', path: 'customers-write', write_daily_max: 10 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        defer_commitment: true,
      },
    });
    const data = await res.json();
    boundsHash = data.bounds_hash;
    expect(data.deferred_commitment_domains).toContain('owner');
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('create a proposal', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': userKey },
      data: {
        frame_hash: boundsHash,
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write',
        pending_domains: ['owner'],
        tool: 'crm___create_contact',
        tool_args: { name: 'John Doe', email: 'john@example.com' },
        execution_context: { contact_type: 'customer' },
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();

    expect(data.proposal.id).toBeTruthy();
    expect(data.proposal.status).toBe('pending');
    expect(data.proposal.pendingDomains).toContain('owner');
    expect(data.proposal.tool).toBe('crm___create_contact');

    process.env.E2E_PROPOSAL_ID = data.proposal.id;
  });

  test('list pending proposals for domain', async ({ request }) => {
    const res = await request.get(`${SP_URL}/api/proposals?domain=owner`, {
      headers: { 'x-api-key': userKey },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.proposals.length).toBeGreaterThan(0);
    expect(data.proposals[0].status).toBe('pending');
  });

  test('commit the proposal', async ({ request }) => {
    const proposalId = process.env.E2E_PROPOSAL_ID!;
    const res = await request.post(`${SP_URL}/api/proposals/${proposalId}/resolve`, {
      headers: { 'x-api-key': userKey },
      data: { action: 'commit', domain: 'owner' },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('committed');
    expect(data.committedDomains).toContain('owner');
    expect(data.remainingDomains).toHaveLength(0);
  });

  test('create and reject a proposal', async ({ request }) => {
    // Create another proposal
    const createRes = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': userKey },
      data: {
        frame_hash: boundsHash,
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write',
        pending_domains: ['owner'],
        tool: 'crm___delete_contact',
        tool_args: { id: 'some-id' },
        execution_context: { contact_type: 'customer' },
      },
    });
    const createData = await createRes.json();

    // Reject it
    const res = await request.post(`${SP_URL}/api/proposals/${createData.proposal.id}/resolve`, {
      headers: { 'x-api-key': userKey },
      data: { action: 'reject', domain: 'owner' },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('rejected');
  });
});
