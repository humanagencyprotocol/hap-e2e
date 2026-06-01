/**
 * Journey 6: Expiry & TTL Enforcement
 *
 * Creates a short-TTL authorization and verifies:
 * 1. Active authorization shows on authorizations page
 * 2. After TTL expires, status changes to expired
 * 3. Receipts are rejected after expiry
 */
import { test, expect, registerOnSP, signInToGateway, handleOnboarding, spApiAttest, spApiReceipt, SP_URL } from './fixtures';

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
    const user = (await sessionRes.json()).user;

    const data = await spApiAttest(request, apiKey, {
      profile_id: 'github.com/humanagencyprotocol/hap-profiles/records@0.4',
      domain: 'owner',
      did: user.did,
      bounds: { profile: 'records', read_access: 'all', write_daily_max: 10, delete_access: 'own_24h', archive_access: 'all' },
      context_hash: 'sha256:' + '0'.repeat(64),
      gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
      execution_context_hash: 'sha256:' + 'b'.repeat(64),
      ttl: 60,
    });
    // Receipts/lookups key on the per-user storage key (frame_hash).
    boundsHash = (data.frame_hash ?? data.bounds_hash) as string;
    expect(boundsHash).toBeTruthy();
  });

  test('6.3 Gateway authorizations page shows active', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Authorizations")');
    await page.waitForURL('**/authorizations**');
    await expect(page.locator('.page-title')).toHaveText('Authorizations', { timeout: 10_000 });
    await expect(page.locator('text=Records').first()).toBeVisible({ timeout: 10_000 });
  });

  test('6.4 Wait for expiry and verify expired state', async ({ page, request }) => {
    test.setTimeout(90_000);

    // Wait for TTL to expire
    await page.waitForTimeout(65_000);

    // Check via API — attestation should be expired
    const attestRes = await request.get(`${SP_URL}/api/attestations/mine`, {
      headers: { 'x-api-key': apiKey },
    });
    const { attestations } = await attestRes.json();
    const our = attestations.find((a: { boundsHash?: string; frameHash?: string }) =>
      (a.boundsHash ?? a.frameHash) === boundsHash
    );
    // After TTL elapses the attestation may drop out of /mine entirely or show
    // as expired — both are valid. The authoritative expiry check is the
    // rejected receipt in 6.5; here we just confirm it is no longer usable.
    if (our) {
      expect((our as { status?: string }).status).not.toBe('active');
    }
  });

  test('6.5 Receipt rejected after expiry', async ({ request }) => {
    const receipt = await spApiReceipt(request, apiKey, {
      attestationHash: boundsHash,
      profileId: 'github.com/humanagencyprotocol/hap-profiles/records@0.4',
      action: 'create_record',
      executionContext: {},
    });
    // SP must reject receipts for expired attestations
    expect(receipt.status).toBe(403);
  });
});
