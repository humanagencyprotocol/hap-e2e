/**
 * WS0–WS2 (suveren-as docs/work-plan.md "an account is Personal OR in one
 * team"): joining a team is a request the team admin confirms; on confirm the
 * account moves and its Personal mandates end (kept); while in a team Personal
 * is paused; leaving makes Personal usable again. Real stack: Authority Server,
 * the whole gateway with the records connector, a real browser on suveren.ai's
 * dashboard for the person's and the admin's screens.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { chromium, type Browser, type Page } from '@playwright/test';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { AS_DIR } from '../src/helpers/as-dir.js';
import {
  ControlPlaneClient, RECORDS_DIST, RECORDS_INTEGRATION, RECORDS_PROFILE_ID,
  grantRecordsMandate, newSecret, startControlPlane, startMcpServer, textOf, type StackOptions,
} from '../src/helpers/gateway-stack.js';

const AS_PORT = 19870;
const CP_PORT = 19871;
const MCP_PORT = 19872;
const AS_URL = `http://localhost:${AS_PORT}`;
/** Only meaningful against an AS that has WS0 (join requests). */
const available = existsSync(RECORDS_DIST)
  && existsSync(join(AS_DIR, 'src', 'app', 'api', 'groups', '[id]', 'requests', 'route.ts'));

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-ws-'));
const stack: StackOptions = {
  dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL,
  extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1' },
};
const cp = new ControlPlaneClient(`http://localhost:${CP_PORT}`);
const mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`, stack.secret);

type User = { apiKey: string; user: { id: string; did: string } };
let anna: User; // team admin
let bernd: User; // Personal, then asks to join
let team: { group: { id: string; name: string }; inviteCode: string };
let personalMandate: string;
let agent: Client;
let browser: Browser;
const TEAM_NAME = `WS Team ${Date.now()}`;

async function as(u: User, method: string, path: string, body?: unknown) {
  const res = await fetch(`${AS_URL}${path}`, {
    method, headers: { 'X-API-Key': u.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

async function mine(u: User): Promise<string[]> {
  const r = await as(u, 'GET', '/api/mandates/mine');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const list = (r.body.mandates ?? r.body.authorizations ?? []) as Array<{ authorization_id?: string; authorizationId?: string; id?: string }>;
  return list.map((m) => m.authorization_id ?? m.authorizationId ?? m.id ?? '');
}

async function dashboard(u: User): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${AS_URL}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[name="apiKey"]').fill(u.apiKey);
  await page.locator('form:has(input[name="apiKey"]) button[type="submit"]').click();
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 45_000 });
  return page;
}

async function writeRecord(title: string) {
  const r = await agent.callTool({ name: 'records__create_record', arguments: { type: 'note', title, content: title } });
  return { denied: r.isError === true, text: textOf(r) };
}

describe.skipIf(!available)('an account is Personal or in one team (real stack + browser)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    await pm.startSP(AS_PORT);
    anna = await sp.register('Anna Admin', `ws-anna-${Date.now()}@test.local`);
    bernd = await sp.register('Bernd Member', `ws-bernd-${Date.now()}@test.local`);
    team = await sp.createGroup(anna.apiKey, TEAM_NAME) as typeof team;

    // Bernd's gateway, with a Personal records mandate (automatic).
    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
    expect((await cp.login(bernd.apiKey)).status).toBe(200);
    await mcpInternal.addIntegration(RECORDS_INTEGRATION as Parameters<GatewayClient['addIntegration']>[0]);
    await mcpInternal.waitForIntegration('records');
    const g = await grantRecordsMandate(sp, { apiKey: bernd.apiKey, did: bernd.user.did, intent: 'E2E: personal notes.', mode: 'automatic' });
    personalMandate = g.authorizationId;
    await mcpInternal.pushGateContent({ authorizationId: g.authorizationId, boundsHash: g.boundsHash, contextHash: g.scopeHash, context: {} }, RECORDS_PROFILE_ID, g.gateContent);
    await new Promise((r) => setTimeout(r, 1_500));
    agent = new Client({ name: 'ws-agent', version: '1.0.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  }, 300_000);

  afterAll(async () => {
    if (agent) await agent.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('Personal works before anything happens', async () => {
    expect(await mine(bernd)).toContain(personalMandate);
    const r = await writeRecord(`before ${Date.now()}`);
    expect(r.denied, r.text).toBe(false);
  }, 60_000);

  it('the join screen shows what ends; "Ask to join" only creates a request — Personal keeps working', async () => {
    const page = await dashboard(bernd);
    try {
      await page.goto(`${AS_URL}/dashboard/groups/join`, { waitUntil: 'networkidle' });
      await page.locator('input[name="inviteCode"]').fill(team.inviteCode);
      await page.locator('form:has(input[name="inviteCode"]) button[type="submit"]').click();
      await page.getByText(/Your personal mandates end/i).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Ask to join' }).click();
      await page.getByText(`Request sent to team ${TEAM_NAME}`).waitFor({ timeout: 20_000 });
    } finally { await page.close(); }

    // Backend truth: a request, not a membership.
    const me = await as(bernd, 'GET', '/api/groups/me');
    expect(me.body.pendingRequest?.groupId).toBe(team.group.id);
    expect(me.body.group?.id ?? null).not.toBe(team.group.id);
    expect(await mine(bernd)).toContain(personalMandate);
    const r = await writeRecord(`pending ${Date.now()}`);
    expect(r.denied, r.text).toBe(false);
  }, 120_000);

  it('only the admin can confirm', async () => {
    const r = await as(bernd, 'POST', `/api/groups/${team.group.id}/requests/${bernd.user.id}`, { action: 'confirm' });
    expect(r.status).toBe(403);
  }, 30_000);

  it('the admin confirms on the Members page; Bernd moves and his Personal mandate ends (kept)', async () => {
    const page = await dashboard(anna);
    try {
      await page.goto(`${AS_URL}/dashboard/groups/${team.group.id}`, { waitUntil: 'networkidle' });
      await page.getByText('Requests to join').waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Confirm' }).click();
      // Backend truth first.
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        const me = await as(bernd, 'GET', '/api/groups/me');
        if (me.body.group?.id === team.group.id) break;
        await new Promise((r) => setTimeout(r, 750));
      }
    } finally { await page.close(); }

    const me = await as(bernd, 'GET', '/api/groups/me');
    expect(me.body.group?.id).toBe(team.group.id);
    expect(me.body.pendingRequest ?? null).toBeNull();
    // Ended but kept: no longer listed for the gateway, still readable as revoked.
    expect(await mine(bernd)).not.toContain(personalMandate);
    const status = await as(bernd, 'GET', `/api/mandates?authorization_id=${personalMandate}`);
    expect(status.status).toBe(200);
    expect(status.body.revoked).toBe(true);
  }, 120_000);

  it('the gateway can no longer act on the ended Personal mandate', async () => {
    const r = await writeRecord(`after ${Date.now()}`);
    expect(r.denied, r.text).toBe(true);
  }, 60_000);

  it('Personal is paused: a new Personal mandate is refused, naming the team', async () => {
    let err = '';
    try {
      await grantRecordsMandate(sp, { apiKey: bernd.apiKey, did: bernd.user.did, intent: 'E2E: should be refused.', mode: 'automatic' });
    } catch (e) { err = String(e); }
    expect(err).toMatch(/PERSONAL_PAUSED/);
    expect(err).toContain(TEAM_NAME);
  }, 60_000);

  it('after leaving the team, Personal works again', async () => {
    const left = await as(bernd, 'POST', `/api/groups/${team.group.id}/leave`);
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    const g = await grantRecordsMandate(sp, { apiKey: bernd.apiKey, did: bernd.user.did, intent: 'E2E: personal again.', mode: 'automatic' });
    expect(await mine(bernd)).toContain(g.authorizationId);
  }, 60_000);

  it('a request can be withdrawn; nothing changes', async () => {
    const other = await sp.register('Carla', `ws-carla-${Date.now()}@test.local`);
    const page = await dashboard(other);
    try {
      await page.goto(`${AS_URL}/dashboard/groups/join`, { waitUntil: 'networkidle' });
      await page.locator('input[name="inviteCode"]').fill(team.inviteCode);
      await page.locator('form:has(input[name="inviteCode"]) button[type="submit"]').click();
      await page.getByRole('button', { name: 'Ask to join' }).click();
      await page.getByRole('button', { name: 'Withdraw request' }).click();
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        if (((await as(other, 'GET', '/api/groups/me')).body.pendingRequest ?? null) === null) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally { await page.close(); }
    expect((await as(other, 'GET', '/api/groups/me')).body.pendingRequest ?? null).toBeNull();
    const reqs = await as(anna, 'GET', `/api/groups/${team.group.id}/requests`);
    expect(reqs.body.requests.map((r: { userId: string }) => r.userId)).not.toContain(other.user.id);
  }, 120_000);
});
