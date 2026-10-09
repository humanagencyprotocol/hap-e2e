/**
 * First contact (real AS + gateway in simulation mode, the connectors it installs itself):
 * what a person's AI sees when it connects and the person asks "how do I start with Suveren?".
 *
 * - no Delegation mandate yet: the session instructions name the one step a person takes —
 *   create a "Delegation" mandate in the gateway, at the gateway's own address — and no
 *   tool is listed that no mandate governs (the old ungated `debug_test_tool`);
 * - with one: the instructions point at `setup__get_guide`, the tool's description says
 *   "start here", and every guide tells the AI where the person approves its proposals;
 * - the getting-started lines never say "simulation" or "test": the working AI reads them too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { localProfilesForAs } from '../src/helpers/local-profiles.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeScopeHash, computeProfileHash } from '../src/helpers/crypto.js';

const SP_PORT = 18620;
const GW_PORT = 18621;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const DELEGATION = 'github.com/humanagencyprotocol/hap-profiles/delegation@0.3';
const available = existsSync(join(PROFILES_DIR, 'delegation', '0.3.profile.json'))
  && existsSync(join(ROOT, 'suveren-gateway', 'content', 'guides'));

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const prevSim = process.env.SUVEREN_SIMULATION;
let agent: Client;
let grantDelegation: () => Promise<void>;

async function reconnect() {
  if (agent) { try { await agent.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 1_500));
  agent = new Client({ name: 'first-contact', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}

function gettingStarted(): string {
  const i = agent.getInstructions() ?? '';
  const at = i.indexOf('=== GETTING STARTED ===');
  return at < 0 ? '' : i.slice(at, i.indexOf('When you receive a task', at));
}

describe.skipIf(!available)('first contact (real AS + gateway in simulation mode)', () => {
  beforeAll(async () => {
    process.env.SUVEREN_SIMULATION = '1';
    pm.buildGateway();

    // Use local profiles (v0.7) instead of github.com/humanagencyprotocol/hap-profiles@main
    const localProfiles = localProfilesForAs(PROFILES_DIR);
    await pm.startSP(SP_PORT, { cwd: localProfiles.cwd, env: localProfiles.env });

    const reg = await sp.register('First Contact E2E', `first-contact-${Date.now()}@test.local`);
    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: reg.apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'first-contact-e2e', apiKey: reg.apiKey });
    await gw.waitForIntegration('erp');
    await gw.waitForIntegration('crm');
    await reconnect();

    // Load profile for profile_hash computation
    const profilePath = join(PROFILES_DIR, 'delegation', '0.3.profile.json');
    const profileJson = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    const profileHash = computeProfileHash(profileJson);

    const groupId = await sp.getPersonalGroupId(reg.apiKey);
    const bounds = { profile: DELEGATION, read_access: 'unlimited', brief_daily_max: 5, mandate_daily_max: 30 };
    const boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max']);
    const scopeHash = computeScopeHash({}, []);
    const gate = { intent: 'E2E: let my AI lead me through the setup.' };
    grantDelegation = async () => {
      const att = await sp.submitMandate(reg.apiKey, {
        profile_id: DELEGATION, group_id: groupId, bounds, bounds_hash: boundsHash, scope_hash: scopeHash,
        profile_hash: profileHash,
        domain: 'owner', did: reg.user.did, commitment_mode: 'review',
        gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ g: 1 }),
      });
      await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, scopeHash, context: {} }, DELEGATION, gate);
    };
  }, 300_000);

  afterAll(async () => {
    if (agent) { try { await agent.close(); } catch { /* ignore */ } }
    await pm.killAll();
    if (prevSim === undefined) delete process.env.SUVEREN_SIMULATION; else process.env.SUVEREN_SIMULATION = prevSim;
  }, 30_000);

  it('no Delegation mandate: the instructions name the one step a person takes; no ungated tool', async () => {
    const section = gettingStarted();
    expect(section).toMatch(/create a "Delegation" mandate in the Suveren Gateway at http:\/\/localhost:\d+/);
    // Always told, in every session: never the gateway page, the key or an approval; only the Suveren tools.
    const instructions = agent.getInstructions() ?? '';
    expect(instructions).toContain('=== RULES ===');
    expect(instructions).toMatch(/Never open or operate the Suveren Gateway's web page/);
    expect(instructions).toMatch(/Never approve a proposal/);
    expect(instructions).toMatch(/No terminal, HTTP or browser calls to the gateway's ports/);
    expect(section).not.toMatch(/simulat|\btest/i);
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('debug_test_tool');
    expect(names).not.toContain('setup__get_guide');
  });

  it('with one: the instructions point at the guide, which says start here and where to approve', async () => {
    await grantDelegation();
    await reconnect();
    const section = gettingStarted();
    expect(section).toContain('call setup__get_guide first and follow its steps in order');
    expect(section).not.toMatch(/simulat|\btest/i);

    const tools = (await agent.listTools()).tools;
    const guideTool = tools.find((t) => t.name === 'setup__get_guide');
    expect(guideTool?.description).toMatch(/Start here when the person asks how to begin with Suveren/);
    expect(tools.map((t) => t.name)).not.toContain('debug_test_tool');

    const r = await agent.callTool({ name: 'setup__get_guide', arguments: {} });
    const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(r.isError).not.toBe(true);
    expect(text).toMatch(/\*\*Approvals:\*\* every mandate and brief you propose waits until the person approves it in the Suveren Gateway at http:\/\/localhost:\d+\/approvals/);
    // The email simulator is installed but not activated here: named, with where to activate it.
    expect(text).toMatch(/\*\*Available but not activated:\*\* [^\n]*Email \(simulation\)/);
    expect(text).toMatch(/Never ask for, read or type the person's API key/);
  });
});
