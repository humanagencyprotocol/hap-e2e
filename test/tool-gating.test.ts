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
let mcpClient: Client;

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  sp = new SPClient(`http://localhost:${SP_PORT}`);

  // Register user
  const reg = await sp.register('GateUser', 'gateuser@test.com');
  apiKey = reg.apiKey;
  userId = reg.user.id;
  userDid = reg.user.did;

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

  // Wait for integrations to start (npx download)
  await new Promise(r => setTimeout(r, 10_000));
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
        name: 'crm___create_contact',
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
    const profile = 'github.com/humanagencyprotocol/hap-profiles/customers@0.4';
    const path = 'customers-write';
    const bounds = { profile, path, write_daily_max: 5, delete_daily_max: 2 };
    const boundsHash = computeBoundsHash(bounds, ['profile', 'path', 'write_daily_max', 'delete_daily_max']);
    const contextHash = computeBoundsHash({}, []);
    const gateHashes = hashGateContent({ intent: 'test' });
    const ecHash = hashExecutionContext({ profile, path, domain: 'owner' });

    // Attest
    await sp.submitAttestation(apiKey, {
      profile_id: profile,
      path,
      domain: 'owner',
      did: userDid,
      bounds,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      gate_content_hashes: gateHashes,
      execution_context_hash: ecHash,
    });

    // Push gate content
    await gw.pushGateContent(
      { boundsHash, contextHash, context: {} },
      path,
      { intent: 'test' },
    );

    // Wait for tool refresh
    await new Promise(r => setTimeout(r, 3_000));

    // Re-connect to get updated tool list
    await mcpClient.close();
    mcpClient = await connectMCP();

    // CRM read tool should now work
    const result = await mcpClient.callTool({
      name: 'crm___find_contacts',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  });

  it('write tool within bounds succeeds', async () => {
    const result = await mcpClient.callTool({
      name: 'crm___create_contact',
      arguments: { name: 'Test Contact', type: 'customer' },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Test Contact');
  });
});
