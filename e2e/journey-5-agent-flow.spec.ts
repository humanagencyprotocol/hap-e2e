/**
 * Journey 5: Agent Flow — Authorization → Proposal → Commit → Revoke
 *
 * Tests the deferred commitment cycle:
 * 1. Create authorization with review mode (defer commitment)
 * 2. Simulate agent proposal
 * 3. User reviews and commits/rejects in browser
 * 4. Revocation blocks further activity
 */
import { test, expect, ensureUsersRegistered, ALICE, signInToGateway, handleOnboarding, createAuthorization, activateIntegration, spApiAttest, SP_URL, GW_URL , ensureProfileEnabledForActiveGroups, latestProfileId} from './fixtures';

// The version the gateway's CRM wizard grants under (newest) — see latestProfileId.
const CUSTOMERS_PROFILE = latestProfileId('customers');

test.describe.serial('Journey 5: Agent Flow', () => {
  let apiKey: string;
  let userDid: string;
  let authorizationId: string;
  let proposalId: string;

  test('5.1 Register and activate integrations', async ({ page }) => {
    test.setTimeout(120_000);
    // Stable ALICE (same account journey-1 uses) so the gateway sign-in never
    // triggers an account-switch wipe — keeps all gateway specs off that path.
    await ensureUsersRegistered();
    apiKey = ALICE.apiKey;
    expect(apiKey).toBeTruthy();

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');
    await activateIntegration(page, 'Records');
  });

  test('5.2 Create authorization with Automatic via gateway', async ({ page }) => {
    // See journey-1: a shared account plus a sequential suite means the active
    // group is a team by now, and a team needs the profile enabled first.
    await ensureProfileEnabledForActiveGroups(apiKey, CUSTOMERS_PROFILE, ALICE.id);
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await createAuthorization(page, {
      profileName: 'CRM',
      bounds: { write_daily_max: '10' },
      intent: 'Agent needs CRM access for customer management',
      title: 'CRM: agent ops',
      commitMode: 'now',
    });
    // createAuthorization lands on /mandates on success.
  });

  test('5.3 Create authorization with Review Each Action via API', async ({ request }) => {
    const sessionRes = await request.post(`${SP_URL}/api/auth/session`, {
      headers: { 'x-api-key': apiKey },
    });
    const sessionData = await sessionRes.json();
    userDid = sessionData.user?.did ?? 'did:hap:agentuser';

    const data = await spApiAttest(request, apiKey, {
      profile_id: CUSTOMERS_PROFILE,
      domain: 'owner',
      did: userDid,
      bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 5, delete_daily_max: 2, setup_daily_max: 0 },
      scope_hash: 'sha256:' + '0'.repeat(64),
      gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
      execution_context_hash: 'sha256:' + 'd'.repeat(64),
      defer_commitment: true,
    });
    expect(data.status).toBe('active');
    expect(data.deferred_commitment_domains).toContain('owner');
    // Proposals/revoke/receipts key on the per-ceremony authorization id.
    authorizationId = data.authorization_id as string;
  });

  test('5.4 Create proposal (simulating agent tool call)', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/proposals`, {
      headers: { 'x-api-key': apiKey },
      data: {
        authorization_id: authorizationId,
        profile_id: CUSTOMERS_PROFILE,
        pending_domains: ['owner'],
        tool: 'crm__create_contact',
        tool_args: { name: 'Jane Smith', email: 'jane@example.com', type: 'customer' },
        execution_context: { contact_type: 'customer' },
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.proposal.status).toBe('pending');
    proposalId = data.proposal.id;
  });

  test('5.5 Personal proposal is approvable while a team is active', async ({ page, request }) => {
    // The mandate (5.3) lives in the personal workspace ('owner'), but by now
    // the active group is a team. "Active context" is a display, not a switch,
    // so the personal queue must still show — found 2026-10-05: ten review
    // requests stayed invisible because the queue read only the team domain.
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Pending Approvals")');
    await page.waitForURL('**/approvals');
    await page.click('.nav-tab:has-text("Awaiting me")');
    const card = page.locator('.card', { hasText: 'jane@example.com' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Approving resolves under the proposal's own domain ('owner'), not the team's.
    await card.locator('button:has-text("Approve")').click();
    await expect(async () => {
      const res = await request.get(`${SP_URL}/api/proposals/${encodeURIComponent(proposalId)}`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(res.ok()).toBe(true);
      expect(['committed', 'executed']).toContain((await res.json()).proposal.status);
    }).toPass({ timeout: 15_000 });
  });

  test('5.6 Revoke blocks further receipts', async ({ request }) => {
    const revokeRes = await request.post(`${SP_URL}/api/authorizations/${encodeURIComponent(authorizationId)}/revoke`, {
      headers: { 'x-api-key': apiKey },
      data: { reason: 'E2E test revocation' },
    });
    expect(revokeRes.ok()).toBe(true);

    // Receipt should be rejected
    const receiptRes = await request.post(`${SP_URL}/api/as/ticket`, {
      headers: { 'x-api-key': apiKey },
      data: {
        authorizationId,
        profileId: CUSTOMERS_PROFILE,
        action: 'create_contact',
        // Required: without it the AS answers 400 INVALID_ACTION_TYPE before
        // it ever reaches the revocation check this test is about.
        actionType: 'write',
        executionContext: { contact_type: 'customer', action_type: 'write' },
        idempotencyKey: `journey5-revoked-${Date.now()}`,
      },
    });
    expect(receiptRes.status()).toBe(403);
  });
});
