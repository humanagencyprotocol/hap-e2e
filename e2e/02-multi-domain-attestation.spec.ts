/**
 * Gap #1, #6: Multi-domain attestation — two users attesting different domains,
 * authorization only complete when both attest.
 */
import { test, expect, startServers, stopServers, registerUser, spPage, gatewayPage, SP_URL, GW_URL } from './fixtures';

test.describe('Multi-Domain Attestation', () => {
  let aliceKey: string;
  let aliceDid: string;
  let bobKey: string;
  let bobDid: string;
  let groupId: string;

  test.beforeAll(async ({ request }) => {
    await startServers();

    // Register users
    const alice = await registerUser(request, 'Alice', 'alice-multi@test.com');
    aliceKey = alice.apiKey;
    aliceDid = alice.did;
    const bob = await registerUser(request, 'Bob', 'bob-multi@test.com');
    bobKey = bob.apiKey;
    bobDid = bob.did;

    // Setup group via API (faster than UI for setup)
    const createRes = await request.post(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': aliceKey },
      data: { name: 'Multi-Domain Team' },
    });
    const createData = await createRes.json();
    groupId = createData.group.id;

    // Bob joins
    await request.post(`${SP_URL}/api/groups/join`, {
      headers: { 'x-api-key': bobKey },
      data: { inviteCode: createData.inviteCode },
    });

    // Assign domains
    await request.put(`${SP_URL}/api/groups/${groupId}/members/${alice.id}`, {
      headers: { 'x-api-key': aliceKey },
      data: { domains: ['finance'] },
    });
    await request.put(`${SP_URL}/api/groups/${groupId}/members/${bob.id}`, {
      headers: { 'x-api-key': aliceKey },
      data: { domains: ['compliance'] },
    });

    // Configure path domains: charge-reviewed needs both finance + compliance
    await request.put(`${SP_URL}/api/groups/${groupId}/path-domains`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        pathDomains: {
          'github.com/humanagencyprotocol/hap-profiles/charge@0.4': {
            'charge-routine': ['finance'],
            'charge-reviewed': ['finance', 'compliance'],
          },
        },
      },
    });
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('Alice attests finance domain — status is pending', async ({ browser }) => {
    const page = await spPage(browser, aliceKey);

    // Navigate to attestation page and create attestation via API
    // (The SP dashboard doesn't have a gate wizard — attestations go through the gateway UI)
    // For this test, we use the API to create attestation and verify status in the UI
    const res = await page.request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-reviewed',
        domain: 'finance',
        did: aliceDid,
        bounds: { profile: 'charge', path: 'charge-reviewed', amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 10 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        group_id: groupId,
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.attested_domains).toContain('finance');
    expect(data.required_domains).toContain('compliance');

    // Verify on SP dashboard — attestation shows as pending
    await page.goto(`${SP_URL}/dashboard/attestations`);
    await expect(page.locator('text=pending')).toBeVisible({ timeout: 5_000 });

    await page.close();
  });

  test('Bob attests compliance domain — status becomes active', async ({ browser }) => {
    const page = await spPage(browser, bobKey);

    const res = await page.request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': bobKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-reviewed',
        domain: 'compliance',
        did: bobDid,
        bounds: { profile: 'charge', path: 'charge-reviewed', amount_max: 100, amount_daily_max: 500, amount_monthly_max: 5000, transaction_count_daily_max: 10 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        group_id: groupId,
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('active');
    expect(data.attested_domains).toContain('finance');
    expect(data.attested_domains).toContain('compliance');

    // Verify on SP dashboard — attestation shows as active
    await page.goto(`${SP_URL}/dashboard/attestations`);
    await expect(page.locator('.badge:has-text("active")')).toBeVisible({ timeout: 5_000 });

    await page.close();
  });
});
