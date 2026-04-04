import { test, expect, ALICE, BOB, authenticatedPage, SP_URL } from './fixtures';

test.describe('Group Journey', () => {
  test('full collaborative flow: create → join → domains → activity', async ({ browser }) => {
    test.setTimeout(60_000);

    // Step 1: Alice creates a team
    const alice = await authenticatedPage(browser, ALICE.apiKey);

    await alice.goto(`${SP_URL}/dashboard/groups/new`);
    await alice.fill('input#name', 'Test Operations');
    await alice.click('button:has-text("Create Team")');

    await expect(alice.locator('.alert-success')).toBeVisible({ timeout: 15_000 });
    const inviteCode = await alice.locator('input[readonly]').inputValue();
    expect(inviteCode).toBeTruthy();

    await alice.click('text=Go to Team');
    await expect(alice.locator('h1')).toContainText('Test Operations');

    const groupUrl = alice.url();
    const groupId = groupUrl.split('/dashboard/groups/')[1]?.split('?')[0];
    expect(groupId).toBeTruthy();

    // Step 2: Bob joins
    const bob = await authenticatedPage(browser, BOB.apiKey);

    await bob.goto(`${SP_URL}/dashboard/groups/join`);
    await bob.fill('input#inviteCode', inviteCode);
    await bob.click('button:has-text("Join Team")');
    await bob.waitForURL(new RegExp(`/dashboard/groups/${groupId}`), { timeout: 15_000 });
    await expect(bob.locator('h1')).toContainText('Test Operations');

    // Step 3: Alice sees Bob in members
    await alice.goto(`${SP_URL}/dashboard/groups/${groupId}`);
    await expect(alice.locator('table')).toBeVisible();
    await expect(alice.locator(`text=${BOB.name}`)).toBeVisible();

    // Step 4: Activity tab loads
    await alice.click('a:has-text("Activity")');
    await expect(alice.locator('text=No execution receipts').or(alice.locator('table'))).toBeVisible({ timeout: 10_000 });

    // Step 5: Both see the group via API
    const aliceGroups = await alice.request.get(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': ALICE.apiKey },
    });
    expect(aliceGroups.ok()).toBe(true);
    const ag = await aliceGroups.json();
    expect(ag.groups.some((g: { id: string }) => g.id === groupId)).toBe(true);

    const bobGroups = await bob.request.get(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': BOB.apiKey },
    });
    expect(bobGroups.ok()).toBe(true);
    const bg = await bobGroups.json();
    expect(bg.groups.some((g: { id: string }) => g.id === groupId)).toBe(true);

    await alice.close();
    await bob.close();
  });
});
