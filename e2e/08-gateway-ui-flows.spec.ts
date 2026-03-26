/**
 * Gap #10: UI-specific flows — Authorize Agents page path buttons,
 * step indicator, mobile menu, sidebar status dots, integrations page.
 */
import { test, expect, startServers, stopServers, registerUser, gatewayPage, GW_URL } from './fixtures';

test.describe('Gateway UI Flows', () => {
  let userKey: string;

  test.beforeAll(async ({ request }) => {
    await startServers();
    const user = await registerUser(request, 'Eve', 'eve@test.com');
    userKey = user.apiKey;
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('dashboard loads with sections', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(GW_URL);
    await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  test('authorize agents page shows profiles with path buttons', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/agent/new`);

    // Should see profile cards
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 10_000 });

    // Each card should have path buttons with colored dots
    const pathButtons = page.locator('button:has-text("-")'); // paths have dashes
    await expect(pathButtons.first()).toBeVisible({ timeout: 5_000 });

    // Click a path button — should expand with description + Create Authorization
    await pathButtons.first().click();
    await expect(page.locator('button:has-text("Create Authorization")')).toBeVisible({ timeout: 3_000 });

    await page.close();
  });

  test('gate wizard step indicator shows labeled steps', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/agent/new`);

    // Click a path and start the wizard
    const pathButton = page.locator('button:has-text("-write")').first();
    if (await pathButton.isVisible()) {
      await pathButton.click();
      await page.click('button:has-text("Create Authorization")');

      // Step indicator should show labels
      await expect(page.locator('text=Bounds')).toBeVisible({ timeout: 5_000 });
      // Cancel button on the right
      await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
    }

    await page.close();
  });

  test('integrations page shows running integrations', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/integrations`);

    // Should see integration cards (CRM and Records auto-registered in personal mode)
    await expect(page.locator('text=Running')).toBeVisible({ timeout: 15_000 });

    await page.close();
  });

  test('AI Assistant page loads', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/settings`);

    // Should see "AI Assistant" heading (renamed from Settings)
    await expect(page.locator('h1:has-text("AI Assistant")')).toBeVisible({ timeout: 5_000 });
    await page.close();
  });

  test('sidebar shows nav items with status dots', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(GW_URL);

    // Sidebar should be visible on desktop
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5_000 });

    // Should have key nav items
    await expect(page.locator('.sidebar-item:has-text("Integrations")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("AI Assistant")')).toBeVisible();
    await expect(page.locator('.sidebar-item:has-text("Agent Authorizations")')).toBeVisible();

    await page.close();
  });

  test('mobile menu opens on small viewport', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 }, // iPhone-sized
      baseURL: GW_URL,
    });
    const page = await context.newPage();

    // Login
    const res = await page.request.post(`${GW_URL}/auth/login`, { data: { apiKey: userKey } });
    if (res.ok()) {
      const setCookie = res.headers()['set-cookie'] ?? '';
      const match = setCookie.match(/hap-session=([^;]+)/);
      if (match) {
        await context.addCookies([{ name: 'hap-session', value: match[1], domain: 'localhost', path: '/' }]);
      }
    }

    await page.goto(GW_URL);

    // Sidebar should be hidden on mobile
    await expect(page.locator('.sidebar')).not.toBeVisible();

    // Hamburger menu should be visible
    const menuBtn = page.locator('.mobile-menu-btn');
    await expect(menuBtn).toBeVisible({ timeout: 5_000 });

    // Click to open mobile menu
    await menuBtn.click();
    await expect(page.locator('.mobile-menu-panel')).toBeVisible();

    // Should contain nav items
    await expect(page.locator('.mobile-menu-item:has-text("Dashboard")')).toBeVisible();
    await expect(page.locator('.mobile-menu-item:has-text("Integrations")')).toBeVisible();

    await page.close();
  });
});
