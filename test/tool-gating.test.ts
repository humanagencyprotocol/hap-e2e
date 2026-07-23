/**
 * Tool Gating Tests — verifies MCP tools are enabled/disabled based on authorization state.
 *
 * Uses CRM integration (personal mode auto-registered).
 * Connects via MCP SSE client to test actual tool call responses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ProcessManager } from '../src/helpers/process-manager';
import { SPClient } from '../src/helpers/sp-client';
import { GatewayClient } from '../src/helpers/gateway-client';
import { computeBoundsHash, hashGateContent, hashExecutionContext } from '../src/helpers/crypto';

const SP_PORT = 16200;
const GW_PORT = 16230;
const pm = new ProcessManager();
let sp: SPClient;
let gw: GatewayClient;
let apiKey: string;
let userId: string;
let userDid: string;
let groupId: string;
let mcpClient: Client;

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  sp = new SPClient(`http://localhost:${SP_PORT}`);

  // Register user
  const reg = await sp.register('GateUser', `gateuser-${Date.now()}@test.com`);
  apiKey = reg.apiKey;
  userId = reg.user.id;
  userDid = reg.user.did;
  groupId = await sp.getPersonalGroupId(apiKey);

  // Start gateway with personal mode
  await pm.startGateway({
    port: GW_PORT,
    spUrl: `http://localhost:${SP_PORT}`,
    spApiKey: apiKey,
    profilesDir: `${process.cwd()}/../hap-profiles`,
  });
  gw = new GatewayClient(`http://localhost:${GW_PORT}`);

  // Configure gateway session
  await gw.configure({ sessionCookie: `api-key=${apiKey}`, apiKey });

  // Wait for the CRM integration to actually be RUNNING. A fixed sleep used to
  // work only because the gateway installed integrations with a blocking
  // execSync; now that install is async (needed for a responsive event loop and
  // for spawning npm correctly on Windows), a cold npm install of crm-mcp takes
  // ~12s and overruns any hardcoded wait.
  await gw.waitForIntegration('crm');
}, 120_000);

afterAll(async () => {
  if (mcpClient) {
    try { await mcpClient.close(); } catch { /* */ }
  }
  await pm.killAll();
});

async function connectMCP(): Promise<Client> {
  const transport = new SSEClientTransport(new URL(`http://localhost:${GW_PORT}/sse`));
  const client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe('Tool Gating', () => {
  it('lists tools shows admin tools', async () => {
    mcpClient = await connectMCP();
    const tools = await mcpClient.listTools();
    const toolNames = tools.tools.map(t => t.name);
    expect(toolNames).toContain('list-authorizations');
    expect(toolNames).toContain('list-integrations');
    expect(toolNames).toContain('check-pending-commitments');
  });

  it('list-integrations shows running CRM', async () => {
    const result = await mcpClient.callTool({ name: 'list-integrations', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('crm');
  });

  it('CRM tool call without authorization is blocked', async () => {
    // CRM tools are disabled when no authorization exists
    let blocked = false;
    try {
      const result = await mcpClient.callTool({
        name: 'crm__create_contact',
        arguments: { name: 'Test' },
      });
      // Tool is disabled — either throws or returns error
      if (result.isError) blocked = true;
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  it('tool enabled after creating authorization', async () => {
    // customers@0.5: the CRM read gate binds to `read_access`, which exists
    // only from 0.5 onward (crm.json gates reads on it, F9). Under a 0.4
    // grant every CRM read fails closed, so find_contacts below could never
    // succeed. keyOrder must match the profile's boundsSchema.keyOrder so the
    // Authority Server hashes identically.
    const profile = 'github.com/humanagencyprotocol/hap-profiles/customers@0.5';
    const path = profile;
    const bounds = { profile, read_access: 'unlimited', write_daily_max: 5, delete_daily_max: 2 };
    const boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'write_daily_max', 'delete_daily_max']);
    const contextHash = computeBoundsHash({}, []);
    const gateHashes = hashGateContent({ intent: 'test' });
    const ecHash = hashExecutionContext({ profile, domain: 'owner' });

    // Attest
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

    // Push gate content keyed by the per-ceremony authorizationId from the attest response
    await gw.pushGateContent(
      { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
      path,
      { intent: 'test' },
    );

    // Wait for gate content to be processed and tools to refresh
    await new Promise(r => setTimeout(r, 5_000));

    // Re-connect to get updated tool list
    await mcpClient.close();
    mcpClient = await connectMCP();

    // Check tools are now available
    const tools = await mcpClient.listTools();
    const crmTools = tools.tools.filter(t => t.name.startsWith('crm__'));
    if (crmTools.length === 0) {
      console.error('No CRM tools enabled. Total tools:', tools.tools.length,
        'names:', tools.tools.map(t => t.name).join(', '));
    }

    // CRM read tool should now work
    const result = await mcpClient.callTool({
      name: 'crm__find_contacts',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  });

  it('write tool within bounds succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: { name: 'Test Contact', type: 'customer' },
    });
    if (result.isError) {
      console.error('Write tool error:', JSON.stringify(result.content));
    }
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Test Contact');
  });
});
