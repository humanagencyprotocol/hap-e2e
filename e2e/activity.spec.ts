import { test, expect, ALICE, authenticatedPage, SP_URL } from './fixtures';

test.describe('Activity & Attestation Pages', () => {
  test('/dashboard/activity page loads', async ({ browser }) => {
    const page = await authenticatedPage(browser, ALICE.apiKey);

    await page.goto(`${SP_URL}/dashboard/activity`);
    // v0.7 words on the AS dashboard: receipts are "tickets".
    await expect(page.locator('h1')).toContainText('Tickets');
    // Windowed walk: empty state reads "No mandate tickets in the last 30 days."
    await expect(page.locator('text=No mandate tickets').or(page.locator('table'))).toBeVisible({ timeout: 10_000 });

    await page.context().close();
  });

  test('/dashboard/attestations page loads', async ({ browser }) => {
    const page = await authenticatedPage(browser, ALICE.apiKey);

    await page.goto(`${SP_URL}/dashboard/attestations`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    await expect(
      page.locator('table').or(page.locator('text=No mandates found'))
    ).toBeVisible({ timeout: 10_000 });

    await page.context().close();
  });

  test('group Activity tab loads', async ({ browser }) => {
    const page = await authenticatedPage(browser, ALICE.apiKey);

    const res = await page.request.get(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': ALICE.apiKey },
    });
    const { groups } = await res.json();
    expect(groups.length).toBeGreaterThan(0);

    const group = groups[0];
    await page.goto(`${SP_URL}/dashboard/groups/${group.id}?tab=activity`);
    // Activity tab should show receipts or empty state
    await expect(
      page.locator('text=Executions').or(page.locator('text=receipts')).or(page.locator('text=Activity')).first()
    ).toBeVisible({ timeout: 10_000 });

    await page.context().close();
  });
});
