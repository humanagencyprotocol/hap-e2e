/**
 * Gap #6, #8, #9: Group management — create group, assign domains, delete group.
 */
import { test, expect, startServers, stopServers, registerUser, spPage, SP_URL } from './fixtures';

test.describe('Group Management', () => {
  let aliceKey: string;
  let bobKey: string;

  test.beforeAll(async () => {
    await startServers();
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('register users', async ({ request }) => {
    const alice = await registerUser(request, 'Alice', 'alice@test.com');
    aliceKey = alice.apiKey;
    const bob = await registerUser(request, 'Bob', 'bob@test.com');
    bobKey = bob.apiKey;
  });

  test('Alice creates a group via SP dashboard', async ({ browser }) => {
    const page = await spPage(browser, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/new`);

    await page.fill('input[name="name"]', 'E2E Test Team');
    await page.click('button:has-text("Create Group")');
    await expect(page.locator('.alert-success')).toBeVisible({ timeout: 10_000 });

    // Copy invite code
    const inviteCode = await page.locator('input[readonly]').inputValue();
    expect(inviteCode).toBeTruthy();

    // Store for next test
    process.env.E2E_INVITE_CODE = inviteCode;
    await page.click('text=Go to Group');
    const groupId = page.url().split('/dashboard/groups/')[1]?.split('?')[0];
    process.env.E2E_GROUP_ID = groupId;

    await page.close();
  });

  test('Bob joins the group', async ({ browser }) => {
    const page = await spPage(browser, bobKey);
    await page.goto(`${SP_URL}/dashboard/groups/join`);

    await page.fill('input[name="inviteCode"]', process.env.E2E_INVITE_CODE!);
    await page.click('button:has-text("Join Group")');

    await page.waitForURL(new RegExp(`/dashboard/groups/${process.env.E2E_GROUP_ID}`), { timeout: 15_000 });
    await expect(page.locator('h1')).toContainText('E2E Test Team');
    await page.close();
  });

  test('Alice assigns free-form domain to Bob', async ({ browser }) => {
    const page = await spPage(browser, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/${process.env.E2E_GROUP_ID}`);
    await expect(page.locator('table')).toBeVisible();

    // Find Bob's row and click Edit
    const bobRow = page.locator('tr', { has: page.locator('text=Bob') }).filter({ hasNot: page.locator('text=admin') });
    await bobRow.locator('button:has-text("Edit")').click();

    // Type a domain name in the free-form input
    await page.fill('input[placeholder*="finance"]', 'compliance');
    await page.click('button:has-text("+ Add")');

    // Verify badge appears
    await expect(page.locator('.domain-tag:has-text("compliance")')).toBeVisible();

    // Save
    await page.click('button:has-text("Save")');
    await expect(page.locator('button:has-text("Edit")')).toBeVisible({ timeout: 5_000 });
    await page.close();
  });

  test('Alice assigns finance domain to herself', async ({ browser }) => {
    const page = await spPage(browser, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/${process.env.E2E_GROUP_ID}`);
    await expect(page.locator('table')).toBeVisible();

    // Find Alice's row and click Edit
    const aliceRow = page.locator('tr', { has: page.locator('text=Alice') });
    await aliceRow.locator('button:has-text("Edit")').click();

    await page.fill('input[placeholder*="finance"]', 'finance');
    await page.click('button:has-text("+ Add")');
    await page.click('button:has-text("Save")');
    await expect(page.locator('button:has-text("Edit")')).toBeVisible({ timeout: 5_000 });
    await page.close();
  });

  test('Alice configures group limits from profile', async ({ browser }) => {
    const page = await spPage(browser, aliceKey);
    await page.goto(`${SP_URL}/dashboard/groups/${process.env.E2E_GROUP_ID}?tab=limits`);

    // Add a profile
    await page.click('button:has-text("Add Profile Limits")');
    await expect(page.locator('#profile-select')).toBeVisible({ timeout: 5_000 });
    await page.click('button:has-text("Add"):not(:has-text("Profile"))');

    // Should load profile fields from boundsSchema
    await expect(page.locator('.card code.mono').first()).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  test('Alice deletes the group', async ({ browser }) => {
    const page = await spPage(browser, aliceKey);
    const groupId = process.env.E2E_GROUP_ID!;
    await page.goto(`${SP_URL}/dashboard/groups/${groupId}?tab=settings`);

    // Type confirmation
    await page.fill('input[placeholder*="Delete group"]', 'Delete group E2E Test Team');
    await page.click('button:has-text("Delete Group")');

    // Should redirect to groups list
    await page.waitForURL(/\/dashboard\/groups$/, { timeout: 10_000 });
    await page.close();
  });
});
