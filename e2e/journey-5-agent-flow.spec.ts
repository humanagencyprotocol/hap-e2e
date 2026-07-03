/**
 * Journey 5: Agent Flow — Authorization → Proposal → Commit → Revoke
 *
 * Tests the deferred commitment cycle:
 * 1. Create authorization with review mode (defer commitment)
 * 2. Simulate agent proposal
 * 3. User reviews and commits/rejects in browser
 * 4. Revocation blocks further activity
 */
import { test, expect, ensureUsersRegistered, ALICE, signInToGateway, handleOnboarding, createAuthorization, activateIntegration, spApiAttest, SP_URL, GW_URL } from './fixtures';

test.describe.serial('Journey 5: Agent Flow', () => {
  let apiKey: string;
  let userDid: string;
  let authorizationId: string;

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
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await createAuthorization(page, {
      profileName: 'CRM',
      bounds: { write_daily_max: '10' },
      intent: 'Agent needs CRM access for customer management',
      title: 'CRM: agent ops',
      commitMode: 'now',
    });
    // createAuthorization lands on /authorizations on success.
  });

  test('5.3 Create authorization with Review Each Action via API', async ({ request }) => {
    const sessionRes = await request.post(`${SP_URL}/api/auth/session`, {
      headers: { 'x-api-key': apiKey },
    });
    const sessionData = await sessionRes.json();
    userDid = sessionData.user?.did ?? 'did:hap:agentuser';

    const data = await spApiAttest(request, apiKey, {
      profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
      domain: 'owner',
      did: userDid,
      bounds: { profile: 'customers', write_daily_max: 5, delete_daily_max: 2 },
      context_hash: 'sha256:' + '0'.repeat(64),
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
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        pending_domains: ['owner'],
        tool: 'crm__create_contact',
        tool_args: { name: 'Jane Smith', email: 'jane@example.com', type: 'customer' },
        execution_context: { contact_type: 'customer' },
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.proposal.status).toBe('pending');
  });

  test('5.5 Proposal appears in gateway Pending Reviews', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Pending Approvals")');
    await page.waitForURL('**/proposals');
    await expect(page.locator('.page-title, h1').first()).toBeVisible({ timeout: 10_000 });

    // Review-mode (deferred-commitment) proposals appear under the "All" tab,
    // rendered as an ActionCard with an Approve action.
    await page.click('.nav-tab:has-text("All")');
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('button:has-text("Approve")').first()).toBeVisible({ timeout: 10_000 });
  });

  test('5.6 Revoke blocks further receipts', async ({ request }) => {
    const revokeRes = await request.post(`${SP_URL}/api/authorizations/${encodeURIComponent(authorizationId)}/revoke`, {
      headers: { 'x-api-key': apiKey },
      data: { reason: 'E2E test revocation' },
    });
    expect(revokeRes.ok()).toBe(true);

    // Receipt should be rejected
    const receiptRes = await request.post(`${SP_URL}/api/as/receipt`, {
      headers: { 'x-api-key': apiKey },
      data: {
        authorizationId,
        profileId: 'github.com/humanagencyprotocol/hap-profiles/customers@0.4',
        action: 'create_contact',
        executionContext: { contact_type: 'customer' },
        idempotencyKey: `journey5-revoked-${Date.now()}`,
      },
    });
    expect(receiptRes.status()).toBe(403);
  });
});
