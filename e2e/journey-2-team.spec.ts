/**
 * Journey 2: Team Setup (Multi-Domain)
 *
 * Alice registers → creates group → Bob joins → domains assigned →
 * path domains configured → Alice attests (pending) → Bob attests
 * with deferred commitment → authorization active
 */
import { test, expect, registerOnSP, signInToSP, signInToGateway, handleOnboarding, SP_URL, GW_URL } from './fixtures';

test.describe.serial('Journey 2: Team Setup', () => {
  let aliceKey: string;
  let bobKey: string;
  let groupId: string;
  let inviteCode: string;

  test('2.1 Alice registers on SP', async ({ page }) => {
    aliceKey = await registerOnSP(page, 'TeamAlice');
    expect(aliceKey).toBeTruthy();
  });

  test('2.2 Alice creates a group via SP dashboard', async ({ page }) => {
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/new`);

    await page.fill('input#name', 'Finance Team');
    await page.click('button:has-text("Create Team")');

    // Wait for success — invite code input appears after creation
    const codeInput = page.locator('input[readonly]');
    await expect(codeInput).toBeVisible({ timeout: 15_000 });
    inviteCode = await codeInput.inputValue();
    expect(inviteCode).toBeTruthy();

    // Navigate to group
    await page.click('text=Go to Team');
    await expect(page.locator('h1')).toContainText('Finance Team');

    // Extract group ID from URL
    groupId = page.url().split('/dashboard/groups/')[1]?.split('?')[0] ?? '';
    expect(groupId).toBeTruthy();
  });

  test('2.3 Bob registers and joins the group', async ({ page }) => {
    // Register Bob
    bobKey = await registerOnSP(page, 'TeamBob');

    // Sign in to SP
    await signInToSP(page, bobKey);

    // Join group
    await page.goto(`${SP_URL}/dashboard/groups/join`);
    await page.fill('input#inviteCode', inviteCode);
    await page.click('button:has-text("Join Team")');

    // Should redirect to group page
    await page.waitForURL(new RegExp(`/dashboard/groups/${groupId}`), { timeout: 15_000 });
    await expect(page.locator('h1')).toContainText('Finance Team');
  });

  test('2.4 Alice assigns domains via SP dashboard', async ({ page }) => {
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/${groupId}`);

    // Wait for members table
    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });

    // Edit Alice's row — add "finance" domain
    const aliceRow = page.locator('tr', { has: page.locator('text=TeamAlice') });
    await aliceRow.locator('button:has-text("Edit")').click();
    await page.fill('input[placeholder*="finance"]', 'finance');
    await page.click('button:has-text("+ Add")');
    await page.click('button:has-text("Save")');
    await expect(aliceRow.locator('button:has-text("Edit")')).toBeVisible({ timeout: 5_000 });

    // Edit Bob's row — add "compliance" domain
    const bobRow = page.locator('tr', { has: page.locator('text=TeamBob') }).filter({ hasNot: page.locator('text=admin') });
    await bobRow.locator('button:has-text("Edit")').click();
    await page.fill('input[placeholder*="finance"]', 'compliance');
    await page.click('button:has-text("+ Add")');
    await page.click('button:has-text("Save")');
    await expect(bobRow.locator('button:has-text("Edit")')).toBeVisible({ timeout: 5_000 });
  });

  test('2.5 Alice configures profile domains via API', async ({ request }) => {
    // SP now uses flat profile-level domains (not nested path domains)
    const res = await request.put(`${SP_URL}/api/groups/${groupId}/path-domains`, {
      headers: { 'x-api-key': aliceKey },
      data: {
        pathDomains: {
          'github.com/humanagencyprotocol/hap-profiles/charge@0.4': ['finance'],
        },
      },
    });
    expect(res.ok()).toBe(true);
  });

  test('2.6 Alice signs in to gateway', async ({ page }) => {
    await signInToGateway(page, aliceKey);
    await handleOnboarding(page);
    await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 5_000 });
  });

  test('2.7 Bob signs in to gateway', async ({ page }) => {
    await signInToGateway(page, bobKey);
    await handleOnboarding(page);
    await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 5_000 });
  });

  test('2.8 Group limits configured via SP dashboard', async ({ page }) => {
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/${groupId}?tab=limits`);

    // Add profile limits
    const addBtn = page.locator('button:has-text("Add Profile Limits")');
    if (await addBtn.isVisible({ timeout: 3_000 })) {
      await addBtn.click();
      await expect(page.locator('#profile-select')).toBeVisible({ timeout: 5_000 });
      await page.click('button:has-text("Add"):not(:has-text("Profile"))');
      await expect(page.locator('.card code.mono').first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test('2.9 Delete group via SP dashboard', async ({ page }) => {
    await signInToSP(page, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/${groupId}?tab=delete`);

    // Type confirmation
    const confirmInput = page.locator('input[placeholder*="Delete team"]');
    await expect(confirmInput).toBeVisible({ timeout: 5_000 });
    await confirmInput.fill('Delete team Finance Team');
    await page.click('button:has-text("Delete Team")');

    // Should redirect
    await page.waitForURL(/\/dashboard\/groups$/, { timeout: 10_000 });
  });
});
