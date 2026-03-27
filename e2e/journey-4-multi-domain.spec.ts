/**
 * Journey 4: Multi-Domain Attestation
 *
 * Two users (Alice + Bob) in same group, each attesting different domains.
 * Authorization only complete when both attest.
 */
import { test, expect, registerOnSP, signInToSP, signInToGateway, handleOnboarding, SP_URL, GW_URL } from './fixtures';

test.describe.serial('Journey 4: Multi-Domain Attestation', () => {
  let aliceKey: string;
  let bobKey: string;
  let groupId: string;
  let inviteCode: string;

  test('4.1 Alice registers and creates group', async ({ page }) => {
    aliceKey = await registerOnSP(page, 'MultiAlice');

    // Create group via SP
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/new`);
    await page.fill('input#name', 'Multi-Domain Team');
    await page.click('button:has-text("Create Group")');
    await expect(page.locator('input[readonly]')).toBeVisible({ timeout: 15_000 });
    inviteCode = await page.locator('input[readonly]').inputValue();
    await page.click('text=Go to Group');
    groupId = page.url().split('/dashboard/groups/')[1]?.split('?')[0] ?? '';
  });

  test('4.2 Bob registers and joins', async ({ page }) => {
    bobKey = await registerOnSP(page, 'MultiBob');
    await signInToSP(page, bobKey);
    await page.goto(`${SP_URL}/dashboard/groups/join`);
    await page.fill('input#inviteCode', inviteCode);
    await page.click('button:has-text("Join Group")');
    await expect(page.locator('h1:has-text("Multi-Domain Team")')).toBeVisible({ timeout: 15_000 });
  });

  test('4.3 Alice assigns domains', async ({ page }) => {
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/${groupId}`);
    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });

    // Alice gets "finance"
    const aliceRow = page.locator('tr', { has: page.locator('text=MultiAlice') });
    await aliceRow.locator('button:has-text("Edit")').click();
    await page.fill('input[placeholder*="finance"]', 'finance');
    await page.click('button:has-text("+ Add")');
    await page.click('button:has-text("Save")');
    await expect(aliceRow.locator('button:has-text("Edit")')).toBeVisible({ timeout: 5_000 });

    // Bob gets "compliance"
    const bobRow = page.locator('tr', { has: page.locator('text=MultiBob') }).filter({ hasNot: page.locator('text=admin') });
    await bobRow.locator('button:has-text("Edit")').click();
    await page.fill('input[placeholder*="finance"]', 'compliance');
    await page.click('button:has-text("+ Add")');
    await page.click('button:has-text("Save")');
    await expect(bobRow.locator('button:has-text("Edit")')).toBeVisible({ timeout: 5_000 });
  });

  test('4.4 Alice configures path domains (charge-reviewed needs both)', async ({ request }) => {
    // API call — path domains UI is complex, use API for reliable setup
    const res = await request.put(`${SP_URL}/api/groups/${groupId}/path-domains`, {
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
    expect(res.ok()).toBe(true);
  });

  test('4.5 Alice attests charge-reviewed — status pending', async ({ request }) => {
    // Alice's SP session via API
    const sessionRes = await request.post(`${SP_URL}/api/auth/session`, {
      headers: { 'x-api-key': aliceKey },
    });
    const sessionData = await sessionRes.json();
    const aliceDid = sessionData.user?.did ?? 'did:hap:alice';

    const res = await request.post(`${SP_URL}/api/sp/attest`, {
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
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.attested_domains).toContain('finance');
    expect(data.required_domains).toContain('compliance');
  });

  test('4.6 SP attestations page shows pending status', async ({ page }) => {
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/attestations`);
    await expect(page.locator('text=Pending').or(page.locator('text=pending'))).toBeVisible({ timeout: 10_000 });
  });

  test('4.7 Bob attests charge-reviewed — status becomes active', async ({ request }) => {
    const sessionRes = await request.post(`${SP_URL}/api/auth/session`, {
      headers: { 'x-api-key': bobKey },
    });
    const sessionData = await sessionRes.json();
    const bobDid = sessionData.user?.did ?? 'did:hap:bob';

    const res = await request.post(`${SP_URL}/api/sp/attest`, {
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
    const data = await res.json();
    expect(data.status).toBe('active');
    expect(data.attested_domains).toContain('finance');
    expect(data.attested_domains).toContain('compliance');
  });

  test('4.8 SP attestations page shows active status', async ({ page }) => {
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/attestations`);
    await expect(page.locator('text=Active').or(page.locator('text=active')).first()).toBeVisible({ timeout: 10_000 });
  });
});
