/**
 * Gap #2, #3, #4: Deferred commitment — attest with defer_commitment,
 * agent tool call creates proposal, user commits or rejects.
 */
import { test, expect, startServers, stopServers, registerUser, gatewayPage, SP_URL, GW_URL, GW_MCP_URL } from './fixtures';

test.describe('Deferred Commitment', () => {
  let userKey: string;
  let userDid: string;
  let userId: string;

  test.beforeAll(async ({ request }) => {
    await startServers();

    const user = await registerUser(request, 'Charlie', 'charlie@test.com');
    userKey = user.apiKey;
    userDid = user.did;
    userId = user.id;
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('create attestation with deferred commitment via gateway UI', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/agent/new`);

    // Select a profile — look for Records or Customers
    await expect(page.locator('.card')).toBeVisible({ timeout: 10_000 });

    // Click on a path button (e.g., records-write or customers-write)
    const pathButton = page.locator('button:has-text("-write")').first();
    await pathButton.click();

    // Click Create Authorization
    await page.click('button:has-text("Create Authorization")');

    // Gate wizard: set bounds
    await expect(page.locator('.step-circle.current')).toBeVisible({ timeout: 5_000 });
    // Fill in numeric bound if visible
    const boundInput = page.locator('input[type="number"]').first();
    if (await boundInput.isVisible()) {
      await boundInput.fill('10');
    }
    await page.click('button:has-text("Confirm")');

    // Gate questions: Problem
    await page.fill('textarea', 'E2E test deferred commitment');
    await page.click('button:has-text("Continue")');

    // Objective
    await page.fill('textarea', 'Test per-action review flow');
    await page.click('button:has-text("Continue")');

    // Tradeoffs
    await page.fill('textarea', 'Accepting test risks');
    await page.click('button:has-text("Continue")');

    // Review page — select "Commit Per Action"
    await expect(page.locator('text=Commit Per Action')).toBeVisible({ timeout: 5_000 });
    await page.click('text=Commit Per Action');

    // Click Authorize
    await page.click('button:has-text("Authorize")');

    // Success
    await expect(page.locator('text=Attestation Committed')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Per Action')).toBeVisible();

    await page.close();
  });

  test('authorization shows Per Action badge on authorizations page', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/authorizations`);

    await expect(page.locator('text=Per Action')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });
});
