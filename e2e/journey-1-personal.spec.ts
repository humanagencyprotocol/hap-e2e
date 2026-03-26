/**
 * Journey 1: First-Time Personal User
 *
 * Registration → API key → gateway login → navigate pages → authorize → revoke → mobile
 *
 * Key constraint: gateway stores API key in React state (no cookies).
 * Each test gets a fresh page, so we must login + do all checks in one test,
 * navigating via sidebar clicks (SPA navigation) not page.goto (full reload).
 */
import { test, expect, registerOnSP, signInToGateway, handleOnboarding, createAuthorization, SP_URL, GW_URL } from './fixtures';

test.describe.serial('Journey 1: Personal User', () => {
  let apiKey: string;

  test('1.1 Register on SP, get API key, see Docker command', async ({ page }) => {
    apiKey = await registerOnSP(page, 'Alice');
    expect(apiKey).toBeTruthy();
    expect(apiKey.length).toBeGreaterThan(10);

    // Docker command should be visible with HAP_MODE=personal
    const dockerCmd = await page.locator('pre code').textContent();
    expect(dockerCmd).toContain('HAP_MODE=personal');
    expect(dockerCmd).toContain('hap-gateway');
  });

  test('1.2 Gateway: login, navigate all pages, check sidebar', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Dashboard — wait for page to fully render
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=New Agent Authorization')).toBeVisible({ timeout: 5_000 });

    // Sidebar items
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Integrations")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("AI Assistant")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Proposals")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Agent Authorizations")')).toBeVisible();

    // Navigate to Integrations via sidebar
    await page.click('.sidebar-item:has-text("Integrations")');
    // Integrations page loads
    await expect(page.locator('.card-title').first()).toBeVisible({ timeout: 20_000 });

    // Navigate to AI Assistant
    await page.click('.sidebar-item:has-text("AI Assistant")');
    await expect(page.locator('h1:has-text("AI Assistant")')).toBeVisible({ timeout: 5_000 });

    // Navigate to Proposals (empty)
    await page.click('.sidebar-item:has-text("Proposals")');
    await expect(page.locator('h1:has-text("Proposals")')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=No pending proposals')).toBeVisible();

    // Navigate to Authorize Agents — path buttons
    await page.click('.sidebar-item:has-text("Authorize Agents")');
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 10_000 });
    const pathButton = page.locator('button:has-text("-write")').first();
    await expect(pathButton).toBeVisible({ timeout: 5_000 });
    await pathButton.click();
    await expect(page.locator('button:has-text("Create Authorization")')).toBeVisible({ timeout: 3_000 });
  });

  test('1.3 Gateway: create authorization with Commit Now', async ({ page }) => {
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

    await expect(page.locator('text=Attestation Committed')).toBeVisible();

    // Check authorizations page
    await page.click('text=Back to Dashboard');
    await page.click('.sidebar-item:has-text("Agent Authorizations")');
    await expect(page.locator('.status-badge:has-text("Active")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=records-write')).toBeVisible();
  });

  test('1.4 Gateway: create authorization with Commit Per Action', async ({ page }) => {
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

    // Verify success or dashboard shows authorization
    await page.locator('text=Attestation Committed').or(page.locator('text=Active Agent Authorizations')).first().waitFor({ state: 'visible', timeout: 15_000 });

    // Navigate to authorizations to verify Per Action badge
    if (await page.locator('text=Back to Dashboard').isVisible({ timeout: 2_000 })) {
      await page.click('text=Back to Dashboard');
    }
    await page.click('.sidebar-item:has-text("Agent Authorizations")');
    await expect(page.locator('text=Per Action')).toBeVisible({ timeout: 10_000 });
  });

  test('1.5 Gateway: revoke authorization', async ({ page }) => {
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    await page.click('.sidebar-item:has-text("Agent Authorizations")');
    await expect(page.locator('text=records-write')).toBeVisible({ timeout: 10_000 });

    // Expand and revoke
    const authCard = page.locator('.card', { has: page.locator('text=records-write') }).first();
    await authCard.click();
    const revokeBtn = page.locator('button:has-text("Revoke")').first();
    if (await revokeBtn.isVisible({ timeout: 3_000 })) {
      await revokeBtn.click();
      await page.waitForTimeout(2000);
    }
  });

  test('1.6 Mobile menu works', async ({ browser }) => {
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
    await expect(page.locator('.mobile-menu-item:has-text("Proposals")')).toBeVisible();

    // Click nav item — navigates and closes
    await page.click('.mobile-menu-item:has-text("Integrations")');
    await expect(page.locator('.mobile-menu-panel')).not.toBeVisible();

    await page.close();
  });
});
