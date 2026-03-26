/**
 * Journey 1: First-Time Personal User
 *
 * Registration → API key → gateway login → integrations → authorize (commit now)
 * → authorize (commit per action) → verify authorizations → revoke → mobile menu
 */
import { test, expect, registerOnSP, signInToGateway, handleOnboarding, createAuthorization, SP_URL, GW_URL } from './fixtures';

test.describe.serial('Journey 1: Personal User', () => {
  let apiKey: string;

  test('1.1 Register on SP, get API key, see Docker command', async ({ page }) => {
    apiKey = await registerOnSP(page, 'Alice');
    expect(apiKey).toBeTruthy();
    expect(apiKey.length).toBeGreaterThan(10);

    // Still on get-started page — Docker command should be visible
    const dockerCmd = await page.locator('pre code').textContent();
    expect(dockerCmd).toContain('HAP_MODE=personal');
    expect(dockerCmd).toContain('hap-gateway');
  });

  test('1.2 Sign in to gateway and see dashboard', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Should be on dashboard with quick actions
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=New Agent Authorization')).toBeVisible({ timeout: 5_000 });
  });

  test('1.5 Integrations page shows running integrations', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/integrations`);
    // Records and CRM should be auto-registered in personal mode
    await expect(page.locator('text=Running')).toBeVisible({ timeout: 20_000 });
  });

  test('1.6 AI Assistant page loads', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/settings`);
    await expect(page.locator('h1:has-text("AI Assistant")')).toBeVisible({ timeout: 5_000 });
  });

  test('1.7 Authorize Agents page shows profiles with path buttons', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/agent/new`);
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 10_000 });

    // Should have path buttons (they contain dashes like records-write)
    const pathButton = page.locator('button:has-text("-write")').first();
    await expect(pathButton).toBeVisible({ timeout: 5_000 });

    // Click to expand — should show description + Create Authorization
    await pathButton.click();
    await expect(page.locator('button:has-text("Create Authorization")')).toBeVisible({ timeout: 3_000 });
  });

  test('1.8 Create authorization with Commit Now', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await createAuthorization(page, {
      pathButtonText: 'records-write',
      bounds: { write_daily_max: '10' },
      problem: 'Need agent to store research findings',
      objective: 'Enable persistent knowledge management',
      tradeoffs: 'Accepting write access to personal records',
      commitMode: 'now',
    });

    // Success
    await expect(page.locator('text=Attestation Committed')).toBeVisible();
  });

  test('1.9 Authorization shows on Authorizations page', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/authorizations`);
    await expect(page.locator('text=Active')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=records-write')).toBeVisible();
  });

  test('1.10 Create authorization with Commit Per Action', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await createAuthorization(page, {
      pathButtonText: 'customers-write',
      bounds: { write_daily_max: '5' },
      problem: 'Need CRM operations under review',
      objective: 'Allow agent to propose CRM changes',
      tradeoffs: 'Each action requires manual approval',
      commitMode: 'per-action',
    });

    // Success with Per Action indicator
    await expect(page.locator('text=Attestation Committed')).toBeVisible();
    await expect(page.locator('text=Per Action')).toBeVisible();
  });

  test('1.11 Per Action badge shows on Authorizations page', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/authorizations`);
    await expect(page.locator('text=Per Action')).toBeVisible({ timeout: 10_000 });
  });

  test('1.12 Sidebar shows nav items', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.sidebar-item:has-text("Integrations")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("AI Assistant")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Proposals")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Agent Authorizations")')).toBeVisible();
  });

  test('1.13 Proposals page loads (empty state)', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/proposals`);
    await expect(page.locator('h1:has-text("Proposals")')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=No pending proposals')).toBeVisible();
  });

  test('1.14 Revoke authorization', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.goto(`${GW_URL}/authorizations`);
    await expect(page.locator('text=records-write')).toBeVisible({ timeout: 10_000 });

    // Expand the records-write authorization
    const authCard = page.locator('.card', { has: page.locator('text=records-write') }).first();
    await authCard.click();

    // Click Revoke
    const revokeBtn = page.locator('button:has-text("Revoke")').first();
    if (await revokeBtn.isVisible({ timeout: 3_000 })) {
      await revokeBtn.click();
      // Wait for status change
      await page.waitForTimeout(2000);
    }
  });

  test('1.15 Mobile menu works', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Sidebar should be hidden
    await expect(page.locator('.sidebar')).not.toBeVisible();

    // Hamburger menu should be visible
    const menuBtn = page.locator('.mobile-menu-btn');
    await expect(menuBtn).toBeVisible({ timeout: 5_000 });
    await menuBtn.click();

    // Mobile menu should open
    await expect(page.locator('.mobile-menu-panel')).toBeVisible();
    await expect(page.locator('.mobile-menu-item:has-text("Dashboard")')).toBeVisible();
    await expect(page.locator('.mobile-menu-item:has-text("Proposals")')).toBeVisible();

    // Click a nav item — should navigate and close menu
    await page.click('.mobile-menu-item:has-text("Integrations")');
    await expect(page.locator('.mobile-menu-panel')).not.toBeVisible();

    await page.close();
  });
});
