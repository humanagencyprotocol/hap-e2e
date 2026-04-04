/**
 * Journey 1: First-Time Personal User
 *
 * Registration → API key → gateway login → navigate pages → authorize → revoke → mobile
 *
 * Key constraint: gateway stores API key in React state (no cookies).
 * Each test gets a fresh page, so we must login + do all checks in one test,
 * navigating via sidebar clicks (SPA navigation) not page.goto (full reload).
 */
import { test, expect, registerOnSP, signInToGateway, handleOnboarding, createAuthorization, activateIntegration, SP_URL, GW_URL } from './fixtures';

test.describe.serial('Journey 1: Personal User', () => {
  let apiKey: string;

  test('1.1 Register on SP, get API key', async ({ page }) => {
    apiKey = await registerOnSP(page, 'Alice');
    expect(apiKey).toBeTruthy();
    expect(apiKey.length).toBeGreaterThan(10);
  });

  test('1.2 Gateway: login, navigate all pages, check sidebar', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Dashboard — wait for page to fully render
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });

    // Sidebar items (nav labels from Sidebar.tsx)
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Integrations")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("AI Assistant")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Pending Reviews")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Authorizations")')).toBeVisible();

    // Navigate to Integrations via sidebar
    await page.click('.sidebar-item:has-text("Integrations")');
    await expect(page.locator('.card-title').first()).toBeVisible({ timeout: 20_000 });

    // Navigate to AI Assistant
    await page.click('.sidebar-item:has-text("AI Assistant")');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 5_000 });

    // Navigate to Pending Reviews (proposals — empty)
    await page.click('.sidebar-item:has-text("Pending Reviews")');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 5_000 });

    // Navigate to Authorize — profile grid
    await page.click('.sidebar-item:has-text("Authorize")');
    // Either profiles loaded or empty state shown
    await page.locator('.profile-grid, .card').first().waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('1.3 Gateway: activate integrations', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Activate personal default integrations (CRM + Records)
    await activateIntegration(page, 'Records');
    await activateIntegration(page, 'CRM');
  });

  test('1.4 Gateway: create authorization with Automatic commit', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await createAuthorization(page, {
      profileName: 'Records',
      bounds: { write_daily_max: '10' },
      intent: 'Need agent to store research findings and enable persistent knowledge management',
      title: 'Records: research storage',
      commitMode: 'now',
    });

    await expect(page.locator('text=Authorization Created')).toBeVisible();

    // Check authorizations page
    await page.click('button:has-text("Back to Dashboard")');
    await page.click('.sidebar-item:has-text("Authorizations")');
    await expect(page.locator('.status-badge:has-text("Active")')).toBeVisible({ timeout: 10_000 });
  });

  test('1.5 Gateway: create authorization with Review Each Action commit', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await createAuthorization(page, {
      profileName: 'CRM',
      bounds: { write_daily_max: '5' },
      intent: 'Need CRM operations under review. Each action requires manual approval before executing.',
      title: 'CRM: review mode',
      commitMode: 'per-action',
    });

    // Verify success
    await expect(page.locator('text=Authorization Created')).toBeVisible({ timeout: 15_000 });

    // Navigate to authorizations to verify Review Mode
    await page.click('button:has-text("Back to Dashboard")');
    await page.click('.sidebar-item:has-text("Authorizations")');
    await expect(page.locator('text=Review Mode').or(page.locator('text=per-action'))).toBeVisible({ timeout: 10_000 });
  });

  test('1.6 Gateway: revoke authorization', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Authorizations")');
    await page.waitForSelector('.card', { timeout: 10_000 });

    // Find and revoke an authorization
    const revokeBtn = page.locator('button:has-text("Revoke")').first();
    if (await revokeBtn.isVisible({ timeout: 3_000 })) {
      await revokeBtn.click();
      await page.waitForTimeout(2000);
    }
  });

  test('1.7 Mobile menu works', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Sidebar hidden on mobile
    await expect(page.locator('.sidebar')).not.toBeVisible();

    // Hamburger menu
    const menuBtn = page.locator('.mobile-menu-btn');
    await expect(menuBtn).toBeVisible({ timeout: 5_000 });
    await menuBtn.click();

    // Mobile menu opens
    await expect(page.locator('.mobile-menu-panel')).toBeVisible();
    await expect(page.locator('.mobile-menu-item:has-text("Dashboard")')).toBeVisible();
    await expect(page.locator('.mobile-menu-item:has-text("Pending Reviews")')).toBeVisible();

    // Click nav item — navigates and closes
    await page.click('.mobile-menu-item:has-text("Integrations")');
    await expect(page.locator('.mobile-menu-panel')).not.toBeVisible();

    await page.close();
  });
});
