/**
 * Journey 8: SP Dashboard — Attestations, Activity, Revocation
 *
 * Tests SP-side views of attestations and receipts.
 */
import { test, expect, registerOnSP, signInToSP, spApiAttest, spApiReceipt, SP_URL } from './fixtures';

test.describe.serial('Journey 8: SP Dashboard', () => {
  let apiKey: string;
  let boundsHash: string;

  test('8.1 Register user', async ({ page }) => {
    apiKey = await registerOnSP(page, 'SPDashUser');
    expect(apiKey).toBeTruthy();
  });

  test('8.2 SP dashboard loads with user info', async ({ page }) => {
    await signInToSP(page, apiKey);
    await page.goto(`${SP_URL}/dashboard`);
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 10_000 });
  });

  test('8.3 Create attestation via API', async ({ request }) => {
    const sessionRes = await request.post(`${SP_URL}/api/auth/session`, {
      headers: { 'x-api-key': apiKey },
    });
    const sessionData = await sessionRes.json();
    const did = sessionData.user?.did ?? 'did:hap:spdashuser';

    const data = await spApiAttest(request, apiKey, {
      profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
      path: 'charge-routine',
      domain: 'owner',
      did,
      bounds: { profile: 'charge', path: 'charge-routine', amount_max: 50, amount_daily_max: 200, amount_monthly_max: 2000, transaction_count_daily_max: 10 },
      context_hash: 'sha256:' + '0'.repeat(64),
      gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
      execution_context_hash: 'sha256:' + 'd'.repeat(64),
    });
    expect(data.status).toBe('active');
    boundsHash = data.bounds_hash as string;
  });

  test('8.4 SP attestations page shows the attestation', async ({ page }) => {
    await signInToSP(page, apiKey);
    await page.goto(`${SP_URL}/dashboard/attestations`);

    // Should show at least one attestation
    await expect(page.locator('text=charge')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Active').or(page.locator('text=active')).first()).toBeVisible();
  });

  test('8.5 Post receipts and verify activity', async ({ request, page }) => {
    // Post a receipt
    const receipt1 = await spApiReceipt(request, apiKey, {
      attestationHash: boundsHash,
      profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
      path: 'charge-routine',
      action: 'charge',
      executionContext: { amount: 25, action_type: 'charge' },
      amount: 25,
    });
    expect(receipt1.status).toBe(201);

    // Post another receipt
    const receipt2 = await spApiReceipt(request, apiKey, {
      attestationHash: boundsHash,
      profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
      path: 'charge-routine',
      action: 'charge',
      executionContext: { amount: 15, action_type: 'charge' },
      amount: 15,
    });
    expect(receipt2.status).toBe(201);

    // View activity page
    await signInToSP(page, apiKey);
    await page.goto(`${SP_URL}/dashboard/activity`);
    await expect(page.locator('text=charge')).toBeVisible({ timeout: 10_000 });
  });

  test('8.6 Receipt exceeding bounds is rejected', async ({ request }) => {
    // Try $60 — exceeds amount_max of $50
    const receipt = await spApiReceipt(request, apiKey, {
      attestationHash: boundsHash,
      profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
      path: 'charge-routine',
      action: 'charge',
      executionContext: { amount: 60, action_type: 'charge' },
      amount: 60,
    });
    expect(receipt.status).toBe(403);
    expect(receipt.body.error).toBe('LIMIT_EXCEEDED');
  });

  test('8.7 Revoke attestation via SP dashboard', async ({ page }) => {
    await signInToSP(page, apiKey);
    await page.goto(`${SP_URL}/dashboard/attestations`);

    // Find revoke button
    const revokeBtn = page.locator('button:has-text("Revoke")').first();
    if (await revokeBtn.isVisible({ timeout: 5_000 })) {
      await revokeBtn.click();
      // Wait for status change
      await page.waitForTimeout(2000);
      await page.reload();
      await expect(page.locator('text=Revoked').or(page.locator('text=revoked')).first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test('8.8 Revoked attestation blocks receipts', async ({ request }) => {
    const receipt = await spApiReceipt(request, apiKey, {
      attestationHash: boundsHash,
      profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
      path: 'charge-routine',
      action: 'charge',
      executionContext: { amount: 10, action_type: 'charge' },
      amount: 10,
    });
    expect(receipt.status).toBe(403);
    expect(receipt.body.error).toBe('REVOKED');
  });
});
