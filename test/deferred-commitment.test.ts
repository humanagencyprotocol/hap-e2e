/**
 * Deferred Commitment Tests — verifies the propose/commit flow via MCP.
 *
 * Agent calls tool → gateway creates proposal → user commits → auto-execution.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ProcessManager } from '../src/helpers/process-manager';
import { SPClient } from '../src/helpers/sp-client';
import { GatewayClient } from '../src/helpers/gateway-client';
import { computeBoundsHash, hashGateContent, hashExecutionContext } from '../src/helpers/crypto';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles';

const PROFILES_DIR = `${process.cwd()}/../hap-profiles`;

const SP_PORT = 16400;
const GW_PORT = 16430;
const pm = new ProcessManager();
let sp: SPClient;
let gw: GatewayClient;
let apiKey: string;
let userDid: string;
let mcpClient: Client;
let boundsHash: string;
let groupId: string;

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  sp = new SPClient(`http://localhost:${SP_PORT}`);

  const user = await sp.register('DeferUser', `deferuser-${Date.now()}@test.com`);
  apiKey = user.apiKey;
  userDid = user.user.did;
  groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({
    port: GW_PORT,
    spUrl: `http://localhost:${SP_PORT}`,
    spApiKey: apiKey,
    profilesDir: `${process.cwd()}/../hap-profiles`,
  });
  gw = new GatewayClient(`http://localhost:${GW_PORT}`);
  await gw.configure({ sessionCookie: `api-key=${apiKey}`, apiKey });

  // Create authorization with deferred commitment
  const profile = PROFILE_V07.customers;
  const path = profile;
  const bounds = {
    profile, read_access: 'unlimited', export_access: 'none',
    write_daily_max: 10, delete_daily_max: 5, setup_daily_max: 0,
  };
  boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max']);
  const contextHash = computeBoundsHash({}, []);
  const gateHashes = hashGateContent({ intent: 'test' }); // customers profile uses the intent gate
  const ecHash = hashExecutionContext({ profile, domain: 'owner' });

  const att = await sp.submitMandate(apiKey, {
    profile_id: profile,
    profile_hash: profileHashFor(profile, PROFILES_DIR),
    group_id: groupId,
    domain: 'owner',
    did: userDid,
    bounds,
    bounds_hash: boundsHash,
    scope_hash: contextHash,
    gate_content_hashes: gateHashes,
    execution_context_hash: ecHash,
    commitment_mode: 'review',
  });

  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
    path,
    { intent: 'test' },
  );

  // The crm tools must exist before the MCP client connects and snapshots the
  // tool list. A fixed sleep used to suffice only because installs blocked the
  // event loop; now that they are async (needed on Windows, and to keep the
  // server responsive), a cold npm install of crm-mcp runs ~12s.
  await gw.waitForIntegration('crm');
  await new Promise(r => setTimeout(r, 2_000));

  const transport = new SSEClientTransport(new URL(`http://localhost:${GW_PORT}/sse`));
  mcpClient = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
}, 120_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* */ } }
  await pm.killAll();
});

describe('Deferred Commitment', () => {
  let proposalId: string;

  it('tool call with deferred commitment returns proposal', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: { name: 'Deferred Contact', type: 'customer' },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Awaiting commitment');
    expect(text).toContain('Proposal ID');

    // Extract proposal ID
    const match = text.match(/Proposal ID: ([a-f0-9]+)/);
    expect(match).toBeTruthy();
    proposalId = match![1];
  });

  it('check-pending-commitments shows the proposal', async () => {
    const result = await mcpClient.callTool({
      name: 'check-pending-commitments',
      arguments: { proposal_id: proposalId },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/pending/i); // wording moved to 'PENDING' in gateway 08d9360 (2026-08-03)
  });

  it('commit the proposal via SP API', async () => {
    const res = await fetch(`http://localhost:${SP_PORT}/api/proposals/${proposalId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ action: 'commit', domain: 'owner' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('committed');
  });

  it('auto-execution runs within 10 seconds', async () => {
    // Wait for the auto-execution poll loop (5s interval)
    await new Promise(r => setTimeout(r, 10_000));

    // Check proposal status
    const result = await mcpClient.callTool({
      name: 'check-pending-commitments',
      arguments: { proposal_id: proposalId },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    // Should show executed or the proposal should be gone from pending
    expect(text).toMatch(/executed|not found/i);
  }, 15_000);

  it('immediate commitment tool call executes directly', async () => {
    // Create a new authorization WITHOUT deferred commitment for records
    const profile = PROFILE_V07.records;
    const path = profile;
    const bounds = { profile, read_access: 'unlimited', write_daily_max: 10, delete_access: 'allowed', archive_access: 'allowed' };
    const bh = computeBoundsHash(bounds, ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access']);
    const ch = computeBoundsHash({}, []);
    const gh = hashGateContent({ intent: 'test' });
    const eh = hashExecutionContext({ profile, domain: 'owner' });

    const att2 = await sp.submitMandate(apiKey, {
      profile_id: profile,
      profile_hash: profileHashFor(profile, PROFILES_DIR),
      group_id: groupId,
      domain: 'owner',
      did: userDid,
      bounds,
      bounds_hash: bh,
      scope_hash: ch,
      gate_content_hashes: gh,
      execution_context_hash: eh,
      commitment_mode: 'automatic', // immediate
    });

    await gw.pushGateContent(
      { authorizationId: att2.authorization_id, boundsHash: bh, contextHash: ch, context: {} },
      path,
      { intent: 'test' },
    );

    await new Promise(r => setTimeout(r, 2_000));

    // Reconnect to get updated tools
    await mcpClient.close();
    const transport = new SSEClientTransport(new URL(`http://localhost:${GW_PORT}/sse`));
    mcpClient = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);

    // Records tool should execute immediately (no proposal)
    const result = await mcpClient.callTool({
      name: 'records__create_record',
      arguments: { type: 'note', title: 'Test Note', content: 'Immediate execution' },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Test Note');
    expect(text).not.toContain('Awaiting commitment');
  });
});
