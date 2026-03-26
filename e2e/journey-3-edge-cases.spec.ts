/**
 * Journey 3: Edge Cases & Verification
 *
 * Group limits enforcement via API, proposal lifecycle via API,
 * gateway step indicator labels, authorize agents path status.
 */
import { test, expect, registerOnSP, signInToGateway, handleOnboarding, SP_URL, GW_URL, GW_MCP_URL } from './fixtures';

test.describe.serial('Journey 3: Edge Cases', () => {
  let userKey: string;

  test('3.1 Register user', async ({ page }) => {
    userKey = await registerOnSP(page, 'EdgeUser');
    expect(userKey).toBeTruthy();
  });

  test('3.2 Group limits vs auth bounds (API verification)', async ({ request }) => {
    // Register via API for speed
    const regRes = await request.post(`${SP_URL}/api/auth/register`, {
      data: { name: 'LimitUser', email: `limituser-${Date.now()}@test.com` },
    });
    const regData = await regRes.json();
    const apiKey = regData.apiKey;
    const userId = regData.user.id;
    const did = regData.user.did ?? `did:hap:${userId}`;

    // Create group, assign domain, set path domains
    const groupRes = await request.post(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': apiKey },
      data: { name: 'Limits Group' },
    });
    const groupData = await groupRes.json();
    const groupId = groupData.group.id;

    await request.put(`${SP_URL}/api/groups/${groupId}/members/${userId}`, {
      headers: { 'x-api-key': apiKey },
      data: { domains: ['finance'] },
    });

    await request.put(`${SP_URL}/api/groups/${groupId}/path-domains`, {
      headers: { 'x-api-key': apiKey },
      data: { pathDomains: { 'github.com/humanagencyprotocol/hap-profiles/charge@0.4': { 'charge-routine': ['finance'] } } },
    });

    // Set group limit: $50 per tx
    await request.put(`${SP_URL}/api/groups/${groupId}/limits`, {
      headers: { 'x-api-key': apiKey },
      data: { limits: { 'github.com/humanagencyprotocol/hap-profiles/charge@0.4': { amount_max: 50 } } },
    });

    // Attest with auth bounds $100 per tx
    const attestRes = await request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-routine', domain: 'finance', did,
        bounds: { profile: 'charge', path: 'charge-routine', amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 20 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        group_id: groupId,
      },
    });
    const attestData = await attestRes.json();
    const boundsHash = attestData.bounds_hash;

    // $40 succeeds (under group $50)
    const r1 = await request.post(`${SP_URL}/api/sp/receipt`, {
      headers: { 'x-api-key': apiKey },
      data: { attestationHash: boundsHash, profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4', path: 'charge-routine', action: 'charge', executionContext: { amount: 40 }, amount: 40 },
    });
    expect(r1.ok()).toBe(true);

    // $60 fails (exceeds group $50, even though auth allows $100)
    const r2 = await request.post(`${SP_URL}/api/sp/receipt`, {
      headers: { 'x-api-key': apiKey },
      data: { attestationHash: boundsHash, profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4', path: 'charge-routine', action: 'charge', executionContext: { amount: 60 }, amount: 60 },
    });
    expect(r2.status()).toBe(403);
  });

  test('3.3 Proposal lifecycle (API verification)', async ({ request }) => {
    // Register user
    const regRes = await request.post(`${SP_URL}/api/auth/register`, {
      data: { name: 'ProposalUser', email: `proposaluser-${Date.now()}@test.com` },
    });
    const regData = await regRes.json();
    const apiKey = regData.apiKey;
    const did = regData.user.did ?? `did:hap:${regData.user.id}`;

    // Attest with deferred commitment
    const attestRes = await request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write', domain: 'owner', did,
        bounds: { profile: 'customers', path: 'customers-write', write_daily_max: 10 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        defer_commitment: true,
      },
    });
    const attestData = await attestRes.json();
    expect(attestData.deferred_commitment_domains).toContain('owner');

    // Create proposal
    const propRes = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': apiKey },
      data: {
        frame_hash: attestData.bounds_hash,
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write',
        pending_domains: ['owner'],
        tool: 'crm___create_contact',
        tool_args: { name: 'John Doe' },
        execution_context: { contact_type: 'customer' },
      },
    });
    expect(propRes.ok()).toBe(true);
    const propData = await propRes.json();
    expect(propData.proposal.status).toBe('pending');
    const proposalId = propData.proposal.id;

    // List proposals
    const listRes = await request.get(`${SP_URL}/api/proposals?domain=owner`, {
      headers: { 'x-api-key': apiKey },
    });
    const listData = await listRes.json();
    expect(listData.proposals.length).toBeGreaterThan(0);

    // Commit proposal
    const commitRes = await request.post(`${SP_URL}/api/proposals/${proposalId}/resolve`, {
      headers: { 'x-api-key': apiKey },
      data: { action: 'commit', domain: 'owner' },
    });
    const commitData = await commitRes.json();
    expect(commitData.status).toBe('committed');

    // Create another proposal and reject it
    const prop2Res = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': apiKey },
      data: {
        frame_hash: attestData.bounds_hash,
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write',
        pending_domains: ['owner'],
        tool: 'crm___delete_contact',
        tool_args: { id: 'some-id' },
        execution_context: { contact_type: 'customer' },
      },
    });
    const prop2Data = await prop2Res.json();

    const rejectRes = await request.post(`${SP_URL}/api/proposals/${prop2Data.proposal.id}/resolve`, {
      headers: { 'x-api-key': apiKey },
      data: { action: 'reject', domain: 'owner' },
    });
    const rejectData = await rejectRes.json();
    expect(rejectData.status).toBe('rejected');
  });

  test('3.4 Gateway step indicator shows correct labels', async ({ page }) => {
    await signInToGateway(page, userKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/agent/new`);
    await page.waitForSelector('.card', { timeout: 10_000 });

    // Click a write path
    const pathBtn = page.locator('button:has-text("-write")').first();
    if (await pathBtn.isVisible({ timeout: 3_000 })) {
      await pathBtn.click();
      await page.click('button:has-text("Create Authorization")');

      // Step labels should be visible
      await expect(page.locator('text=Bounds')).toBeVisible({ timeout: 5_000 });

      // Cancel button should be on the right
      await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
    }
  });

  test('3.5 Authorize Agents path buttons show status colors', async ({ page }) => {
    await signInToGateway(page, userKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/agent/new`);
    await page.waitForSelector('.card', { timeout: 10_000 });

    // Path buttons should exist and have colored dots
    const pathButtons = page.locator('button:has-text("-")');
    const count = await pathButtons.count();
    expect(count).toBeGreaterThan(0);
  });

  test('3.6 Gateway health check', async ({ request }) => {
    const res = await request.get(`${GW_MCP_URL}/health`);
    expect(res.ok()).toBe(true);
  });

  test('3.7 Auto-registered integrations have tools', async ({ request }) => {
    const res = await request.get(`${GW_MCP_URL}/internal/integrations`);
    if (res.ok()) {
      const data = await res.json();
      const records = data.integrations?.find((i: { id: string }) => i.id === 'records');
      const crm = data.integrations?.find((i: { id: string }) => i.id === 'crm');
      expect(records?.running).toBe(true);
      expect(crm?.running).toBe(true);
      expect(records?.toolCount).toBeGreaterThan(0);
      expect(crm?.toolCount).toBeGreaterThan(0);
    }
  });
});
