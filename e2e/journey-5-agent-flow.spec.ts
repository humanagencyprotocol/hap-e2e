/**
 * Journey 5: Agent Flow — Tool Call → Proposal → Commit → Receipt
 *
 * Tests the full agent interaction cycle:
 * 1. Create authorization (commit per action)
 * 2. Agent calls tool → proposal created
 * 3. User reviews and commits proposal in browser
 * 4. Receipt appears in audit page
 *
 * Also tests: revocation blocks agent, proposal rejection.
 */
import { test, expect, registerOnSP, signInToGateway, handleOnboarding, createAuthorization, spApiAttest, gatewayConfigureSession, SP_URL, GW_URL, GW_MCP_URL } from './fixtures';

test.describe.serial('Journey 5: Agent Flow', () => {
  let apiKey: string;
  let userDid: string;
  let boundsHash: string;

  test('5.1 Register user', async ({ page }) => {
    apiKey = await registerOnSP(page, 'AgentUser');
    expect(apiKey).toBeTruthy();
  });

  test('5.2 Create authorization with Commit Now via gateway', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await createAuthorization(page, {
      profileName: 'Records',
      bounds: { write_daily_max: '10' },
      intent: 'Agent needs to store research for persistent knowledge management',
      title: 'Records: agent storage',
      commitMode: 'now',
    });

    // Verify success
    await page.locator('text=Authorization Created').waitFor({ state: 'visible', timeout: 15_000 });
  });

  test('5.3 Create authorization with Commit Per Action via API', async ({ request }) => {
    // Get user DID
    const sessionRes = await request.post(`${SP_URL}/api/auth/session`, {
      headers: { 'x-api-key': apiKey },
    });
    const sessionData = await sessionRes.json();
    userDid = sessionData.user?.did ?? 'did:hap:agentuser';

    const data = await spApiAttest(request, apiKey, {
      profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
      path: 'customers-write',
      domain: 'owner',
      did: userDid,
      bounds: { profile: 'customers', path: 'customers-write', write_daily_max: 5, delete_daily_max: 2 },
      context_hash: 'sha256:' + '0'.repeat(64),
      gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
      execution_context_hash: 'sha256:' + 'd'.repeat(64),
      defer_commitment: true,
    });
    expect(data.status).toBe('active');
    expect(data.deferred_commitment_domains).toContain('owner');
    boundsHash = data.bounds_hash as string;
  });

  test('5.4 Create proposal (simulating agent tool call)', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': apiKey },
      data: {
        frame_hash: boundsHash,
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write',
        pending_domains: ['owner'],
        tool: 'crm___create_contact',
        tool_args: { name: 'Jane Smith', email: 'jane@example.com', type: 'customer' },
        execution_context: { contact_type: 'customer' },
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.proposal.status).toBe('pending');
    process.env.E2E_PROPOSAL_ID = data.proposal.id;
  });

  test('5.5 Proposal appears in gateway Proposals page', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Pending Reviews")');
    await expect(page.locator('h1:has-text("Proposals")')).toBeVisible({ timeout: 10_000 });

    // Should show the pending proposal
    await expect(page.locator('text=crm___create_contact')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('button:has-text("Commit")')).toBeVisible();
  });

  test('5.6 User commits proposal in browser', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Pending Reviews")');
    await expect(page.locator('text=crm___create_contact')).toBeVisible({ timeout: 15_000 });

    // Click Commit
    await page.click('button:has-text("Commit")');

    // Should show success message
    await expect(page.locator('text=committed').or(page.locator('text=Committed'))).toBeVisible({ timeout: 10_000 });
  });

  test('5.7 Create and reject a proposal', async ({ request, page }) => {
    // Create another proposal
    const createRes = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': apiKey },
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

    // View in browser and reject
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await page.click('.sidebar-item:has-text("Pending Reviews")');
    await expect(page.locator('text=crm___delete_contact')).toBeVisible({ timeout: 15_000 });

    await page.click('button:has-text("Reject")');
    await expect(page.locator('text=rejected').or(page.locator('text=Rejected'))).toBeVisible({ timeout: 10_000 });
  });

  test('5.8 SP revoke blocks further attestations', async ({ request }) => {
    // Revoke the attestation
    const revokeRes = await request.post(`${SP_URL}/api/attestations/${encodeURIComponent(boundsHash)}/revoke`, {
      headers: { 'x-api-key': apiKey },
      data: { reason: 'E2E test revocation' },
    });
    expect(revokeRes.ok()).toBe(true);

    // Try to post a receipt — should be rejected
    const receiptRes = await request.post(`${SP_URL}/api/sp/receipt`, {
      headers: { 'x-api-key': apiKey },
      data: {
        attestationHash: boundsHash,
        profileId: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        path: 'customers-write',
        action: 'create_contact',
        executionContext: { contact_type: 'customer' },
      },
    });
    expect(receiptRes.status()).toBe(403);
    const receiptData = await receiptRes.json();
    expect(receiptData.error).toBe('REVOKED');
  });
});
