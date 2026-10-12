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

    await alice.click('button:has-text("Go to Team")');
    await alice.waitForURL(/\/dashboard\/groups\/[^/?]+/, { timeout: 15_000 });
    // Group name renders in a subheading paragraph (the h1 is the viewer's role).
    await expect(alice.getByText('Test Operations').first()).toBeVisible({ timeout: 10_000 });

    const groupUrl = alice.url();
    const groupId = groupUrl.split('/dashboard/groups/')[1]?.split('?')[0];
    expect(groupId).toBeTruthy();

    // Step 2: Bob asks to join. Since WS0 the invite code alone does not make
    // him a member: enter code → preview → "Ask to join" → a pending request.
    const bob = await authenticatedPage(browser, BOB.apiKey);

    await bob.goto(`${SP_URL}/dashboard/groups/join`);
    await bob.fill('input#inviteCode', inviteCode);
    await bob.click('button:has-text("Continue")');
    await expect(bob.getByText('Join team Test Operations?')).toBeVisible({ timeout: 10_000 });
    await bob.click('button:has-text("Ask to join")');
    await expect(bob.getByText('Request sent to team Test Operations')).toBeVisible({ timeout: 10_000 });
    await expect(bob.locator('button:has-text("Withdraw request")')).toBeVisible();

    // Not a member yet: the team is not in Bob's groups until the admin confirms.
    const bobBefore = await bob.request.get(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': BOB.apiKey },
    });
    expect(bobBefore.ok()).toBe(true);
    expect((await bobBefore.json()).groups.some((g: { id: string }) => g.id === groupId)).toBe(false);

    // Step 3: Alice (the admin) confirms the request on the Members page
    await alice.goto(`${SP_URL}/dashboard/groups/${groupId}`);
    const requests = alice.locator('.card', { hasText: 'Requests to join' });
    await expect(requests).toBeVisible({ timeout: 10_000 });
    await expect(requests.getByText(BOB.name)).toBeVisible();
    await requests.locator('button:has-text("Confirm")').click();
    await expect(requests).toBeHidden({ timeout: 10_000 });

    // Step 4: Alice sees Bob in members
    await alice.goto(`${SP_URL}/dashboard/groups/${groupId}`);
    await expect(alice.locator('table')).toBeVisible();
    await expect(alice.locator('table').locator(`text=${BOB.name}`)).toBeVisible();

    // Bob now lands in the team
    await bob.goto(`${SP_URL}/dashboard/groups/${groupId}`);
    await expect(bob.getByText('Test Operations').first()).toBeVisible({ timeout: 10_000 });

    // Step 5: Activity tab loads
    await alice.click('a:has-text("Activity")');
    await expect(alice.locator('text=No execution receipts').or(alice.locator('table'))).toBeVisible({ timeout: 10_000 });

    // Step 6: Both see the group via API
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
