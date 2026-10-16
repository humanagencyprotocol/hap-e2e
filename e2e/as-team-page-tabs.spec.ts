/**
 * AS team page — every tab renders, in a real browser, with team settings saved.
 *
 * Why this exists: the Profiles tab crashed on suveren.ai for every team
 * (React #310: a hook after an early return, suveren-as #92). It typechecked,
 * built and passed every API-level team test, because nothing ever opened the
 * page — the crash only happens once the tab has loaded its data and renders
 * a second time. So each tab here is opened, waited on until its loaded
 * content shows, and fails on any uncaught page error or the error boundary.
 *
 * Caps are saved through the API first so the Profiles tab renders filled-in
 * cap rows (numeric and enum), not just empty cards.
 */
import { test, expect, SP_URL, signInToSP, latestProfileId } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

type AsUser = { id: string; apiKey: string; name: string };

async function registerAsUser(request: APIRequestContext, name: string): Promise<AsUser> {
  const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID()}@test.local`;
  const res = await request.post(`${SP_URL}/api/auth/register`, { data: { name, email } });
  if (!res.ok()) throw new Error(`register ${name} failed: ${res.status()} ${await res.text()}`);
  const body = await res.json() as { apiKey: string; user: { id: string } };
  return { id: body.user.id, apiKey: body.apiKey, name };
}

/** Uncaught errors and React errors in the page. Prefetch aborts on navigation are not errors. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('Failed to fetch RSC payload') || t.includes('404')) return;
    errors.push(`console: ${t.slice(0, 300)}`);
  });
  return errors;
}

test.describe('AS team page tabs (#92)', () => {
  test('admin opens every tab of a team with caps saved — no crash', async ({ page, request }) => {
    const admin = await registerAsUser(request, 'Tabs Admin');
    const teamName = `Tabs ${Date.now()}`;
    const created = await request.post(`${SP_URL}/api/groups`, {
      headers: { 'x-api-key': admin.apiKey },
      data: { name: teamName },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { group } = await created.json() as { group: { id: string } };

    // A numeric cap on each, plus an enum cap on email (read_access) — the
    // two cap shapes the Profiles tab renders differently.
    const caps: Record<string, Record<string, number | string>> = {
      [latestProfileId('email')]: { read_access: 'none', send_daily_max: 20 },
      [latestProfileId('charge')]: { amount_max: 100 },
      [latestProfileId('customers')]: { write_daily_max: 10 },
    };
    for (const [profileId, profileCaps] of Object.entries(caps)) {
      const r = await request.put(
        `${SP_URL}/api/groups/${group.id}/profile-config/${encodeURIComponent(profileId)}`,
        { headers: { 'x-api-key': admin.apiKey }, data: { approvers: [admin.id], caps: profileCaps } },
      );
      expect(r.ok(), `${profileId}: ${await r.text()}`).toBe(true);
    }

    const errors = collectPageErrors(page);
    await signInToSP(page, admin.apiKey);

    // Each tab: the text that only appears once its data has loaded.
    const tabs: Array<{ tab: string; loaded: RegExp | string }> = [
      { tab: '', loaded: admin.name },
      { tab: 'profiles', loaded: 'Enable a profile for this team' },
      { tab: 'activity', loaded: /Activity/ },
      { tab: 'delete', loaded: `Delete team ${teamName}` },
    ];
    for (const { tab, loaded } of tabs) {
      const url = `${SP_URL}/dashboard/groups/${group.id}${tab ? `?tab=${tab}` : ''}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await expect(page.getByText(loaded).first(), `tab "${tab || 'members'}" loaded`).toBeVisible({ timeout: 15_000 });
      if (tab === 'profiles') {
        // The crash came on the render AFTER loading: wait for the cards.
        await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 15_000 });
        await expect(page.locator('.card h3').first()).toBeVisible();
      }
      await expect(page.getByText('Something went wrong'), `tab "${tab || 'members'}" error boundary`).toHaveCount(0);
      expect(errors, `tab "${tab || 'members'}" page errors`).toEqual([]);
    }
  });
});
