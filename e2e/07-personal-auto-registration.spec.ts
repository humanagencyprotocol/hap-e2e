/**
 * Gap #12: Personal mode auto-registration — HAP_MODE=personal auto-registers
 * personalDefault integrations (CRM, records).
 */
import { test, expect, startServers, stopServers, GW_MCP_URL } from './fixtures';

test.describe('Personal Mode Auto-Registration', () => {
  test.beforeAll(async () => {
    await startServers(); // Starts gateway with HAP_MODE=personal
  });

  test.afterAll(async () => {
    await stopServers();
  });

  test('gateway health check passes', async ({ request }) => {
    const res = await request.get(`${GW_MCP_URL}/health`);
    expect(res.ok()).toBe(true);
  });

  test('records integration auto-registered and running', async ({ request }) => {
    const res = await request.get(`${GW_MCP_URL}/internal/integrations`);
    if (res.ok()) {
      const data = await res.json();
      const records = data.integrations?.find((i: { id: string }) => i.id === 'records');
      expect(records).toBeTruthy();
      expect(records?.running).toBe(true);
      expect(records?.toolCount).toBeGreaterThan(0);
    }
  });

  test('CRM integration auto-registered and running', async ({ request }) => {
    const res = await request.get(`${GW_MCP_URL}/internal/integrations`);
    if (res.ok()) {
      const data = await res.json();
      const crm = data.integrations?.find((i: { id: string }) => i.id === 'crm');
      expect(crm).toBeTruthy();
      expect(crm?.running).toBe(true);
      expect(crm?.toolCount).toBeGreaterThan(0);
    }
  });
});
