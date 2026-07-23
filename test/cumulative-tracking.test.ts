/**
 * Cumulative Tracking Tests — verifies daily/monthly limits are enforced.
 *
 * Uses CRM integration with write_daily_max bounds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ProcessManager } from '../src/helpers/process-manager';
import { SPClient } from '../src/helpers/sp-client';
import { GatewayClient } from '../src/helpers/gateway-client';
import { computeBoundsHash, hashGateContent, hashExecutionContext } from '../src/helpers/crypto';

const SP_PORT = 16300;
const GW_PORT = 16330;
const pm = new ProcessManager();
let sp: SPClient;
let gw: GatewayClient;
let apiKey: string;
let userDid: string;
let groupId: string;
let mcpClient: Client;

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  sp = new SPClient(`http://localhost:${SP_PORT}`);

  const user = await sp.register('CumUser', `cumuser-${Date.now()}@test.com`);
  apiKey = user.apiKey;
  userDid = user.user.did;

  // Get auto-provisioned personal group (allows lazy profile enable)
  groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({
    port: GW_PORT,
    spUrl: `http://localhost:${SP_PORT}`,
    spApiKey: apiKey,
    profilesDir: `${process.cwd()}/../hap-profiles`,
  });
  gw = new GatewayClient(`http://localhost:${GW_PORT}`);
  await gw.configure({ sessionCookie: `api-key=${apiKey}`, apiKey });

  // Create authorization with write_daily_max = 3, delete_daily_max = 1
  const profile = 'github.com/humanagencyprotocol/hap-profiles/customers@0.5';
  const path = profile;
  // read_access is required for the CRM read gate; it exists only from
  // customers@0.5 onward.
  const bounds = { profile: 'github.com/humanagencyprotocol/hap-profiles/customers@0.5', read_access: 'unlimited', write_daily_max: 3, delete_daily_max: 1 };
  const boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'write_daily_max', 'delete_daily_max']);
  const contextHash = computeBoundsHash({}, []);
  const gateHashes = hashGateContent({ intent: 'test' });
  const ecHash = hashExecutionContext({ profile, domain: 'owner' });

  const att = await sp.submitAttestation(apiKey, {
    profile_id: profile,
    group_id: groupId,
    domain: 'owner',
    did: userDid,
    bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    gate_content_hashes: gateHashes,
    execution_context_hash: ecHash,
    commitment_mode: 'automatic',
  });

  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
    path,
    { intent: 'test' },
  );

  // Add CRM integration with action_type in staticExecution
  await gw.addIntegration({
    id: 'crm',
    name: 'CRM',
    command: 'npx',
    args: ['-y', '@humanagencyp/crm-mcp@latest'],
    envKeys: {},
    profile: 'customers',
    enabled: true,
    toolGating: {
      default: {
        executionMapping: {},
        staticExecution: { contact_type: 'customer' },
      },
      overrides: {
        create_contact: { executionMapping: { type: 'contact_type' }, staticExecution: { action_type: 'write' } },
        update_contact: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        delete_contact: { executionMapping: {}, staticExecution: { action_type: 'delete' } },
        log_activity: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        create_deal: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        update_deal: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        create_task: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        complete_task: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        // F9: synthetic test manifest — these reads aren't what this test
        // exercises (it tests cumulative WRITE bounds), so declare an explicit
        // governance exemption rather than the real read_access gate.
        find_contacts: { category: 'read', readGovernance: 'none' },
        get_timeline: { category: 'read', readGovernance: 'none' },
        get_pipeline: { category: 'read', readGovernance: 'none' },
        list_tasks: { category: 'read', readGovernance: 'none' },
        export_crm: { category: 'read', readGovernance: 'none' },
      },
    },
  });

  // Poll for real readiness rather than guessing a duration. A cold
  // `npm install` of crm-mcp was measured at ~12s — it only fits inside a fixed
  // sleep when npm's cache is warm, so this passes locally and flakes on CI,
  // which is the worst version of the bug.
  await gw.waitForIntegration('crm');

  const transport = new SSEClientTransport(new URL(`http://localhost:${GW_PORT}/sse`));
  mcpClient = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
}, 120_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* */ } }
  await pm.killAll();
});

describe('Cumulative Tracking', () => {
  it('1st write succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: { name: 'Contact 1', type: 'customer' },
    });
    if (result.isError) console.error("TOOL_ERR:", JSON.stringify(result.content)); expect(result.isError).toBeFalsy();
  });

  it('2nd write succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: { name: 'Contact 2', type: 'customer' },
    });
    if (result.isError) console.error("TOOL_ERR:", JSON.stringify(result.content)); expect(result.isError).toBeFalsy();
  });

  it('3rd write succeeds (at limit)', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: { name: 'Contact 3', type: 'customer' },
    });
    if (result.isError) console.error("TOOL_ERR:", JSON.stringify(result.content)); expect(result.isError).toBeFalsy();
  });

  it('4th write blocked (exceeds write_daily_max=3)', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: { name: 'Contact 4', type: 'customer' },
    });
    // Should be blocked by SP receipt pre-flight or gatekeeper
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text.toLowerCase()).toMatch(/limit|blocked|exceed/);
  });

  it('read tools still work after write limit', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__find_contacts',
      arguments: {},
    });
    if (result.isError) console.error("TOOL_ERR:", JSON.stringify(result.content)); expect(result.isError).toBeFalsy();
  });
});
