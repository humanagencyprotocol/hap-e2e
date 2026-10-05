/**
 * The setup guides on the real stack (simulation setup S10): real AS, the gateway
 * in simulation mode with the published connectors it installs itself.
 *
 * - without a delegation mandate the guide tool is not listed and a call is refused;
 * - with one (read access), the topic list comes in order and every guide starts
 *   with the language rule and the systems actually connected — the installed
 *   connectors with their profiles and action types, read from the gateway;
 * - a guide in the override folder (SUVEREN_GUIDES_DIR) replaces the default.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

const SP_PORT = 18600;
const GW_PORT = 18601;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;
const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const DELEGATION = 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1';
const available = existsSync(join(PROFILES_DIR, 'delegation', '0.1.profile.json'))
  && existsSync(join(ROOT, 'suveren-gateway', 'content', 'guides'));

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const overrideDir = mkdtempSync(join(tmpdir(), 'hap-e2e-guides-'));
const prev = { sim: process.env.SUVEREN_SIMULATION, guides: process.env.SUVEREN_GUIDES_DIR };
let agent: Client;
/** Grants the delegation mandate — run in the second test, the first checks the tool without it. */
let grantGuides: () => Promise<void>;

async function reconnect() {
  if (agent) { try { await agent.close(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 1_500));
  agent = new Client({ name: 'setup-agent', version: '1.0.0' }, { capabilities: {} });
  await agent.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}

async function guide(topic?: string) {
  const r = await agent.callTool({ name: 'setup__get_guide', arguments: topic ? { topic } : {} });
  return { denied: r.isError === true, text: (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n') };
}

describe.skipIf(!available)('setup guides (real AS + gateway in simulation mode)', () => {
  beforeAll(async () => {
    process.env.SUVEREN_SIMULATION = '1';
    process.env.SUVEREN_GUIDES_DIR = overrideDir;
    writeFileSync(join(overrideDir, 'risks.md'), '# Risks\n\nACME house rules for test runs.\n\nNever test on Fridays.');
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('Guides E2E', `guides-${Date.now()}@test.local`);
    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: reg.apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'guides-e2e', apiKey: reg.apiKey });
    await gw.waitForIntegration('erp');
    await gw.waitForIntegration('crm');
    await reconnect();

    const groupId = await sp.getPersonalGroupId(reg.apiKey);
    const bounds = { profile: DELEGATION, read_access: 'unlimited', brief_daily_max: 0, mandate_daily_max: 0 };
    const boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'brief_daily_max', 'mandate_daily_max']);
    const contextHash = computeContextHash({}, []);
    const gate = { intent: 'E2E: read the setup guides.' };
    grantGuides = async () => {
      const att = await sp.submitAttestation(reg.apiKey, {
        profile_id: DELEGATION, group_id: groupId, bounds, bounds_hash: boundsHash, context_hash: contextHash,
        domain: 'owner', did: reg.user.did, commitment_mode: 'review',
        gate_content_hashes: hashGateContent(gate), execution_context_hash: hashExecutionContext({ g: 1 }),
      });
      await gw.pushGateContent({ authorizationId: att.authorization_id, boundsHash, contextHash, context: {} }, DELEGATION, gate);
    };
  }, 300_000);

  afterAll(async () => {
    if (agent) { try { await agent.close(); } catch { /* ignore */ } }
    await pm.killAll();
    rmSync(overrideDir, { recursive: true, force: true });
    for (const [k, v] of [['SUVEREN_SIMULATION', prev.sim], ['SUVEREN_GUIDES_DIR', prev.guides]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 30_000);

  it('without a delegation mandate: not listed, and a call is refused', async () => {
    expect((await agent.listTools()).tools.map((t) => t.name)).not.toContain('setup__get_guide');
    expect((await guide()).denied).toBe(true);
  });

  it('with one: the topics in order, each guide headed by the language rule and the connected systems', async () => {
    await grantGuides();
    await reconnect();
    expect((await agent.listTools()).tools.map((t) => t.name)).toContain('setup__get_guide');

    const list = await guide();
    expect(list.denied, list.text).toBe(false);
    expect(list.text).toMatch(/1\. \*\*interview\*\*[\s\S]*2\. \*\*package\*\*[\s\S]*3\. \*\*mandates\*\*/);

    const mandates = await guide('mandates');
    expect(mandates.text.split('\n')[0]).toMatch(/This guide is in English/);
    // The systems the gateway installed itself (personal defaults), with what they can do.
    // (a connector names its profile as its manifest does — short name or full id)
    expect(mandates.text).toMatch(/\*\*erp\*\* — profile `[^`]*sales[^`]*`; action types [^\n]*`quote`, `send`, `order`/);
    expect(mandates.text).toMatch(/\*\*crm\*\* — profile `[^`]*customers[^`]*`/);
    expect(mandates.text).not.toMatch(/\*\*setup\*\* —/);
    expect(mandates.text).toMatch(/## Ask first/);
  }, 60_000);

  it('a guide in the override folder replaces the default', async () => {
    const risks = await guide('risks');
    expect(risks.text).toMatch(/Never test on Fridays/);
    expect(risks.text).not.toMatch(/The client remembers earlier runs/);
  });
});
