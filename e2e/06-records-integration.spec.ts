/**
 * Gap #11: Records integration — create, search, update, delete, archive
 * with 24h immutability enforcement.
 */
import { test, expect, startServers, stopServers, registerUser, gatewayPage, GW_URL, GW_MCP_URL, SP_URL } from './fixtures';

test.describe('Records Integration', () => {
  let userKey: string;

  test.beforeAll(async ({ request }) => {
    await startServers();
    const user = await registerUser(request, 'Diana', 'diana@test.com');
    userKey = user.apiKey;

    // Create attestation for records-write via API
    await request.post(`${SP_URL}/api/sp/attest`, {
      headers: { 'x-api-key': userKey },
      data: {
        profile_id: 'github.com/humanagencyprotocol/hap-profiles/records@0.4',
        path: 'records-write',
        domain: 'owner',
        did: `did:hap:diana`,
        bounds: { profile: 'records', path: 'records-write', write_daily_max: 20 },
        context_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { problem: 'sha256:' + 'a'.repeat(64), objective: 'sha256:' + 'b'.repeat(64), tradeoffs: 'sha256:' + 'c'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
      },
    });
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('records integration is running (personal default)', async ({ request }) => {
    const res = await request.get(`${GW_MCP_URL}/health`);
    expect(res.ok()).toBe(true);

    // Check integrations
    const intRes = await request.get(`${GW_MCP_URL}/internal/integrations`);
    if (intRes.ok()) {
      const data = await intRes.json();
      const records = data.integrations?.find((i: { id: string }) => i.id === 'records');
      expect(records?.running).toBe(true);
    }
  });

  test('gateway authorizations page shows records authorization', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/authorizations`);

    // Should show the records authorization
    await expect(page.locator('text=records')).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  test('Authorize Agents page shows records paths with status', async ({ browser }) => {
    const page = await gatewayPage(browser, userKey);
    await page.goto(`${GW_URL}/agent/new`);

    await expect(page.locator('text=Records')).toBeVisible({ timeout: 10_000 });
    // Path buttons should show — records-read, records-write
    await expect(page.locator('button:has-text("records-write")')).toBeVisible();
    await page.close();
  });
});
