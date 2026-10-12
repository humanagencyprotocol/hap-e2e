/**
 * WS4 (suveren-as docs/work-plan.md "an account is Personal OR in one team"):
 * a gateway installed by the company's IT carries a locked policy value
 * `Team` (registry / policy file, docs/managed-settings.md). Such a gateway
 * only signs in an account that is in that team, and stops when the account
 * leaves it. Real stack: Authority Server + the whole gateway started with a
 * real policy file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import {
  ControlPlaneClient, GW_DIR, newSecret, startControlPlane, startMcpServer, type StackOptions,
} from '../src/helpers/gateway-stack.js';

const AS_PORT = 19880;
const CP_PORT = 19881;
const MCP_PORT = 19882;
const AS_URL = `http://localhost:${AS_PORT}`;
const POLICY = join(GW_DIR, 'apps', 'control-plane', 'src', 'lib', 'policy.ts');
/** Only meaningful against a gateway that knows the `Team` policy value. */
const available = existsSync(POLICY) && readFileSync(POLICY, 'utf8').includes('validateTeamId');

const pm = new ProcessManager();
const sp = new SPClient(AS_URL);
const dataDir = mkdtempSync(join(tmpdir(), 'hap-e2e-managed-team-'));
const policyFile = join(mkdtempSync(join(tmpdir(), 'hap-e2e-policy-')), 'gateway-policy.json');
const cp = new ControlPlaneClient(`http://localhost:${CP_PORT}`);

type User = { apiKey: string; user: { id: string; did: string } };
let tom: User; // team admin
let bernd: User; // team member
let carla: User; // Personal only
let teamId: string;
const TEAM_NAME = `IT Team ${Date.now()}`;

describe.skipIf(!available)('a managed gateway only works for its team (real stack, real policy file)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(AS_PORT);
    tom = await sp.register('Tom Admin', `mt-tom-${Date.now()}@test.local`);
    bernd = await sp.register('Bernd Member', `mt-bernd-${Date.now()}@test.local`);
    carla = await sp.register('Carla Personal', `mt-carla-${Date.now()}@test.local`);
    const team = await sp.createGroup(tom.apiKey, TEAM_NAME) as { group: { id: string }; inviteCode: string };
    teamId = team.group.id;
    await sp.joinGroup(bernd.apiKey, team.inviteCode, tom.apiKey);

    writeFileSync(policyFile, JSON.stringify({ Team: teamId, InstallMethod: 'managed' }));
    const stack: StackOptions = {
      dataDir, ports: { cp: CP_PORT, mcp: MCP_PORT }, secret: newSecret(), asUrl: AS_URL,
      extraEnv: { SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1', SUVEREN_POLICY_FILE: policyFile },
    };
    await startControlPlane(pm, stack);
    await startMcpServer(pm, stack);
  }, 300_000);

  afterAll(async () => {
    await pm.killAll();
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('the team is locked by IT', async () => {
    const h = await cp.health() as unknown as { policyLocked?: string[] };
    expect((h.policyLocked ?? []).map((k) => k.toLowerCase())).toContain('team');
  });

  it('a Personal account is refused at sign-in, naming the team', async () => {
    const r = await cp.login(carla.apiKey);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(JSON.stringify(r.body)).toMatch(/set up by your IT for team/i);
    expect((await cp.health()).vaultUnlocked).toBe(false);
  }, 60_000);

  it('a team member signs in', async () => {
    const r = await cp.login(bernd.apiKey);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await cp.health()).session.state).toBe('active');
  }, 60_000);

  it('leaving the team through the gateway stops it at once', async () => {
    const left = await cp.authed(bernd.apiKey, 'POST', `/api/groups/${teamId}/leave`);
    expect(left.status).toBeLessThan(300);
    const h = await cp.waitForHealth((x) => x.session.state === 'locked', 20_000);
    expect(h.session.state).toBe('locked');
    expect(h.session.lockedReason ?? '').toMatch(/managed-wrong-team/);
  }, 60_000);
});
