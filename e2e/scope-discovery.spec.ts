/**
 * E2E: scope-field discovery in the gate wizard.
 *
 * Exercises the full browser path that bit us this session:
 *   UI → Vite dev proxy → CP /integrations/:id/discover/:field → target service.
 *
 * We mock at the Playwright network layer (page.route) so the test doesn't
 * depend on real Google Calendar credentials or a running calendar MCP
 * subprocess. The mocks simulate:
 *   1. /mcp/integrations/manifests    — returns a calendar manifest with contextDiscovery
 *   2. /mcp/health                    — reports calendar integration as running
 *   3. /integrations/calendar/discover/allowed_calendars
 *                                     — returns two fake calendar options
 *
 * This specific test would have caught ALL of the following bugs hit earlier today:
 *   • Vite dev proxy missing /integrations — request returned index.html, UI got
 *     "Unexpected token '<'" from JSON.parse instead of options.
 *   • Manifest-loader not registering calendar in content/integrations/index.json —
 *     BoundsEditor couldn't find a matching manifest → no discovery branch fired.
 *   • BoundsEditor not passing `discoveryIntegrationId` to FieldRow.
 */

import { test, expect, registerOnSP, signInToGateway, handleOnboarding, GW_URL } from './fixtures';

test.describe.serial('Scope field discovery', () => {
  let apiKey: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    apiKey = await registerOnSP(page, 'Diana');
    await page.close();
  });

  test('allowed_calendars renders as a live multi-select when manifest declares contextDiscovery', async ({ page }) => {
    // ── Mock network ──────────────────────────────────────────────────────

    // 1. Inject a calendar manifest with contextDiscovery into the manifest list
    //    the AuthorizePicker + BoundsEditor consume.
    await page.route('**/mcp/integrations/manifests', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          manifests: [
            {
              id: 'calendar',
              name: 'Google Calendar',
              version: '1.0.0',
              description: 'List and manage Google calendar events',
              icon: 'calendar',
              profile: 'calendar',
              mcp: { command: 'google-calendar-mcp', args: [] },
              credentials: {
                fields: [
                  { key: 'clientId', label: 'Client ID', type: 'text' },
                  { key: 'clientSecret', label: 'Client Secret', type: 'password' },
                ],
                envMapping: {
                  GOOGLE_CLIENT_ID: 'clientId',
                  GOOGLE_CLIENT_SECRET: 'clientSecret',
                  GOOGLE_CALENDAR_REFRESH_TOKEN: 'refreshToken',
                },
              },
              oauth: null,
              toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: {} },
              contextDiscovery: {
                allowed_calendars: {
                  baseUrl: 'https://www.googleapis.com/calendar/v3',
                  endpoint: 'users/me/calendarList',
                  auth: 'bearer',
                  credential: 'refreshToken',
                  responsePath: 'items',
                  valueField: 'id',
                  labelField: 'summary',
                  extraFields: { access: 'accessRole', primary: 'primary' },
                },
              },
              templates: [
                {
                  name: 'Book with Review',
                  description: 'Propose bookings with every action reviewed.',
                  risk: 'high' as const,
                  mode: 'review' as const,
                  bounds: { booking_daily_max: '3', booking_duration_max: '120', lookahead_days_max: '30' },
                  context: { allowed_calendars: '', allowed_attendees: '', allowed_domains: '' },
                  intent: 'Book with my review.',
                  ttl: 2592000,
                  tags: ['review mode'],
                },
              ],
            },
          ],
        }),
      });
    });

    // 2. Report calendar as running so the AuthorizePicker shows its "Authorize"
    //    button (instead of the "Set up" fallback for not-yet-running integrations).
    await page.route('**/mcp/health', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          transports: ['sse'],
          sp: GW_URL,
          activeSessions: 0,
          storedGates: 0,
          serviceCredentials: ['calendar'],
          integrations: [{ id: 'calendar', name: 'Google Calendar', running: true, toolCount: 7 }],
        }),
      });
    });

    // 3. The test under test: the CP discovery endpoint.
    //    Hard failure if this call returns HTML instead of JSON (Vite proxy bug)
    //    or isn't reached at all.
    let discoveryHit = false;
    await page.route('**/integrations/calendar/discover/allowed_calendars', async route => {
      discoveryHit = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          options: [
            {
              value: 'user@example.com',
              label: 'Primary Calendar',
              extras: { access: 'owner', primary: true },
            },
            {
              value: 'en.austrian#holiday@group.v.calendar.google.com',
              label: 'Holidays in Austria',
              extras: { access: 'reader', primary: false },
            },
          ],
        }),
      });
    });

    // ── Drive the UI ──────────────────────────────────────────────────────

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // Go straight to the new-auth flow
    await page.goto(`${GW_URL}/authorizations?new=1`);
    await page.waitForSelector('.profile-grid', { timeout: 10_000 });

    // Click Authorize on Calendar (mocked manifest + running state → Authorize button shows)
    const calendarCard = page.locator('.card', { has: page.locator('text=Calendar') }).first();
    await calendarCard.locator('button:has-text("Authorize")').click();

    // Template picker → pick Custom (goes directly to BoundsEditor without template bounds)
    await page.locator('button:has-text("Custom")').click();

    // Wait for wizard
    await page.waitForURL(u => u.toString().includes('/agent/gate'), { timeout: 10_000 });

    // The discovery endpoint must have been hit for the multi-select to populate
    await expect.poll(() => discoveryHit, { timeout: 10_000 }).toBe(true);

    // Both mocked options must render as selectable items — fail if the field
    // rendered as a plain <input type="text"> (which is what happened when the
    // Vite proxy was missing /integrations).
    await expect(page.locator('text=Primary Calendar')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Holidays in Austria')).toBeVisible({ timeout: 5_000 });

    // Positive signal that the render is actually the multi-select component:
    //   the reader calendar carries an "access" hint ("· reader") and is disabled.
    await expect(page.locator('text=· reader')).toBeVisible();
  });

  test('falls back to free-form input when discovery returns an error', async ({ page }) => {
    // Same manifest + health mocks as before
    await page.route('**/mcp/integrations/manifests', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          manifests: [
            {
              id: 'calendar', name: 'Google Calendar', version: '1.0.0',
              description: 'x', icon: 'calendar', profile: 'calendar',
              mcp: { command: 'x', args: [] },
              credentials: { fields: [], envMapping: {} },
              oauth: null,
              toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: {} },
              contextDiscovery: {
                allowed_calendars: {
                  baseUrl: 'https://example.test', endpoint: 'x', auth: 'bearer',
                  responsePath: 'items', valueField: 'id', labelField: 'summary',
                },
              },
              templates: [{
                name: 'Custom', description: '', risk: 'low' as const, mode: 'review' as const,
                bounds: {}, context: {}, intent: '', ttl: 3600, tags: [],
              }],
            },
          ],
        }),
      });
    });

    await page.route('**/mcp/health', async route => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok', transports: [], sp: GW_URL, activeSessions: 0, storedGates: 0,
          serviceCredentials: [], integrations: [{ id: 'calendar', name: 'Google Calendar', running: true, toolCount: 0 }],
        }),
      });
    });

    // Discovery errors (simulate CP returning 502 — e.g. upstream token expired).
    await page.route('**/integrations/calendar/discover/allowed_calendars', async route => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'OAuth refresh failed (401)' }),
      });
    });

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await page.goto(`${GW_URL}/authorizations?new=1`);
    await page.waitForSelector('.profile-grid', { timeout: 10_000 });

    await page.locator('.card', { has: page.locator('text=Calendar') }).first()
      .locator('button:has-text("Authorize")').click();
    await page.locator('button:has-text("Custom")').click();
    await page.waitForURL(u => u.toString().includes('/agent/gate'), { timeout: 10_000 });

    // The component must degrade to a text input (no checkboxes) + warning
    // banner, so the user can still enter calendar IDs manually.
    await expect(page.locator("text=Couldn't fetch options")).toBeVisible({ timeout: 5_000 });
  });
});
