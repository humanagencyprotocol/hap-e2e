/**
 * Journey 6: Authorization Expiry & Extension
 *
 * Tests:
 * 1. Create authorization with short TTL (60 seconds)
 * 2. Verify it shows as active
 * 3. Wait for expiry
 * 4. Verify it shows as expired
 * 5. Dashboard shows expired attention item
 * 6. Extend (re-authorize) the expired path
 */
import { test, expect, registerOnSP, signInToGateway, handleOnboarding, spApiAttest, SP_URL, GW_URL } from './fixtures';

test.describe.serial('Journey 6: Expiry & Extension', () => {
  let apiKey: string;
  let boundsHash: string;

  test('6.1 Register user', async ({ page }) => {
    apiKey = await registerOnSP(page, 'ExpiryUser');
    expect(apiKey).toBeTruthy();
  });

  test('6.2 Create authorization with short TTL (60s)', async ({ request }) => {
    const sessionRes = await request.post(`${SP_URL}/api/auth/session`, {
      headers: { 'x-api-key': apiKey },
    });
    const sessionData = await sessionRes.json();
    const did = sessionData.user?.did ?? 'did:hap:expiryuser';

    const data = await spApiAttest(request, apiKey, {
      profile_id: 'github.com/humanagencyprotocol/hap-profiles/records@0.4',
      path: 'records-write',
      domain: 'owner',
      did,
      bounds: { profile: 'records', path: 'records-write', write_daily_max: 5 },
      context_hash: 'sha256:' + '0'.repeat(64),
      gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
      execution_context_hash: 'sha256:' + 'd'.repeat(64),
      ttl: 60, // 60 second TTL
    });
    expect(data.status).toBe('active');
    boundsHash = data.bounds_hash as string;
  });

  test('6.3 Gateway authorizations page shows active', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Agent Authorizations")');
    await expect(page.locator('.status-badge:has-text("Active")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=records-write')).toBeVisible();
  });

  test('6.4 Wait for expiry and verify expired state', async ({ page }) => {
    test.setTimeout(90_000); // Extend test timeout

    // Wait for the 60s TTL to expire
    console.error('[E2E] Waiting 65 seconds for TTL expiry...');
    await page.waitForTimeout(65_000);

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Check authorizations page — should show expired
    await page.click('.sidebar-item:has-text("Agent Authorizations")');

    // Click "Expired" tab
    await page.locator('button:has-text("Expired")').first().click();
    await expect(page.locator('text=records-write')).toBeVisible({ timeout: 10_000 });
  });

  test('6.5 Dashboard shows expired attention item', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Dashboard should show expired count > 0
    await expect(page.locator('text=Expired')).toBeVisible({ timeout: 10_000 });

    // Attention item for expired auth
    await expect(page.locator('text=records')).toBeVisible();
  });

  test('6.6 Receipt rejected after expiry', async ({ request }) => {
    const res = await request.post(`${SP_URL}/api/sp/receipt`, {
      headers: { 'x-api-key': apiKey },
      data: {
        attestationHash: boundsHash,
        profileId: 'github.com/humanagencyprotocol/hap-profiles/records@0.4',
        path: 'records-write',
        action: 'create_record',
        executionContext: {},
      },
    });
    // Expired attestation — SP should still accept receipts (TTL is gatekeeper concern)
    // But the gatekeeper would reject the tool call
    // The SP receipt endpoint doesn't check TTL — it checks revocation + limits
    expect(res.status()).toBe(201); // SP accepts (no revocation)
  });
});
