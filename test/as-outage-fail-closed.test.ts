/**
 * No receipt, no execution — proven by taking the Authority Server away.
 *
 * This is the protocol's central invariant and the one claim the whole system
 * rests on: "If the AS is unreachable or unresponsive when a receipt is
 * requested, the Gatekeeper MUST block execution. Implementations MUST NOT use
 * a cached prior receipt as a fallback. Implementations MUST NOT have a 'warn
 * and proceed' or 'degraded' mode" (protocol.md → Pre-flight Receipt Request).
 *
 * It was covered only by a gateway unit test with a stubbed client, which
 * proves the branch exists but not that a real gateway, holding a real live
 * authorization and a warm connection to a real downstream MCP server, refuses
 * when the AS actually goes away. Those are different claims: a cache, a
 * retry, or a "last receipt still valid" shortcut would all pass the unit test
 * and fail here.
 *
 * The suite deliberately establishes that the SAME call succeeds first. A test
 * that only shows a failure after an outage cannot distinguish "blocked
 * because the AS is gone" from "blocked for some unrelated reason".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ProcessManager } from '../src/helpers/process-manager';
import { SPClient } from '../src/helpers/sp-client';
import { GatewayClient } from '../src/helpers/gateway-client';
import { computeBoundsHash, hashGateContent, hashExecutionContext } from '../src/helpers/crypto';

const SP_PORT = 16700;
const GW_PORT = 16730;
const PROFILE = 'github.com/humanagencyprotocol/hap-profiles/customers@0.5';

const pm = new ProcessManager();
let sp: SPClient;
let gw: GatewayClient;
let mcpClient: Client;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(c => c.text ?? '').join(' ');
}

async function createContact(name: string) {
  return mcpClient.callTool({
    name: 'crm__create_contact',
    arguments: { name, type: 'customer' },
  });
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  sp = new SPClient(`http://localhost:${SP_PORT}`);

  const user = await sp.register('OutageUser', `outage-${Date.now()}@test.com`);
  const apiKey = user.apiKey;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({
    port: GW_PORT,
    spUrl: `http://localhost:${SP_PORT}`,
    spApiKey: apiKey,
    profilesDir: `${process.cwd()}/../hap-profiles`,
  });
  gw = new GatewayClient(`http://localhost:${GW_PORT}`);
  await gw.configure({ sessionCookie: `api-key=${apiKey}`, apiKey });

  // A deliberately generous daily limit: this suite must fail because the AS
  // is gone, never because a bound ran out.
  const bounds = {
    profile: PROFILE,
    read_access: 'unlimited',
    write_daily_max: 50,
    delete_daily_max: 5,
  };
  const boundsHash = computeBoundsHash(bounds, ['profile', 'read_access', 'write_daily_max', 'delete_daily_max']);
  const contextHash = computeBoundsHash({}, []);

  const att = await sp.submitAttestation(apiKey, {
    profile_id: PROFILE,
    group_id: groupId,
    domain: 'owner',
    did: user.user.did,
    bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    gate_content_hashes: hashGateContent({ intent: 'outage test' }),
    execution_context_hash: hashExecutionContext({ profile: PROFILE, domain: 'owner' }),
    commitment_mode: 'automatic',
  });

  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
    PROFILE,
    { intent: 'outage test' },
  );

  await gw.addIntegration({
    id: 'crm',
    name: 'CRM',
    command: 'npx',
    args: ['-y', '@humanagencyp/crm-mcp@latest'],
    envKeys: {},
    profile: 'customers',
    enabled: true,
    toolGating: {
      default: { executionMapping: {}, staticExecution: { contact_type: 'customer' } },
      overrides: {
        create_contact: {
          executionMapping: { type: 'contact_type' },
          staticExecution: { action_type: 'write' },
        },
        find_contacts: { category: 'read', readGovernance: 'none' },
      },
    },
  });
  await gw.waitForIntegration('crm');

  const transport = new SSEClientTransport(new URL(`http://localhost:${GW_PORT}/sse`));
  mcpClient = new Client({ name: 'outage-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* */ } }
  await pm.killAll();
});

describe('No receipt, no execution — the AS goes away mid-session', () => {
  it('positive control: the write succeeds while the AS is up', async () => {
    const result = await createContact('Before Outage');
    expect(result.isError, textOf(result)).toBeFalsy();
  });

  it('BLOCKS the identical write once the AS is unreachable', async () => {
    // Same gateway, same warm connection, same live authorization, same tool,
    // same arguments — only the Authority Server is gone.
    // Confirms the port stops answering, not merely that a process was
    // signalled — otherwise a surviving server makes every assertion below
    // vacuous, which is precisely how this passed locally and failed on CI.
    await pm.stopProcess('as', { confirmDownUrl: `http://localhost:${SP_PORT}/api/as/pubkey` });

    const result = await createContact('During Outage');

    expect(result.isError, 'the write was allowed to execute with no receipt').toBe(true);
    // The agent must be told why, not handed a generic failure.
    expect(textOf(result).toLowerCase()).toMatch(/unavailable|unreachable|blocked|receipt/);
  }, 60_000);

  it('does not fall back to a cached receipt on the next attempt', async () => {
    // The dangerous shortcut is reusing the receipt from the successful call
    // above. A second blocked attempt shows the first refusal was the rule and
    // not a one-off transient.
    const result = await createContact('Still During Outage');
    expect(result.isError, 'a cached receipt was reused for a new execution').toBe(true);
  }, 60_000);

  it('a READ still works — reads are local by design, and this pins that asymmetry', async () => {
    // Deliberately the opposite assertion to the writes above, and it is the
    // specified behaviour rather than a gap: reads are receiptless, so
    // "enforcement is performed ONLY by the local Gatekeeper, and no other
    // party observes it" (protocol.md → Read Authorization). The Gatekeeper
    // holds a verified attestation locally and needs nothing from the AS to
    // honour a read.
    //
    // Worth pinning in both directions. If a future change made reads depend
    // on the AS, this test fails and the dependency is deliberate rather than
    // accidental. And if the write assertions above ever start passing during
    // an outage, the asymmetry recorded here is what makes that obviously
    // wrong instead of merely different.
    //
    // The accepted cost, stated so nobody rediscovers it as a surprise:
    // revocation is AS-only ("The Gatekeeper has no revocation list"), so
    // while the AS is unreachable a revoked grant keeps permitting reads until
    // its TTL expires. Writes are unaffected — they cannot obtain a receipt.
    const result = await mcpClient.callTool({
      name: 'crm__find_contacts',
      arguments: { query: 'Before' },
    });

    expect(result.isError, `read refused with no AS: ${textOf(result).slice(0, 200)}`).toBeFalsy();
    expect(textOf(result)).toContain('Before Outage');
  }, 60_000);
});
