/**
 * Exactly-once execution — one ticket, one execution, pinned end to end.
 *
 * The protocol guarantees one TICKET per logical execution (Cumulative
 * Tracking rule 5). On 2026-09-04 that held perfectly and the tool still ran
 * twice: two triggers inside one gateway process (the control-plane's
 * post-resolve nudge and the 5 s poll) both requested a ticket for the same
 * committed proposal; the AS replayed the original to the second caller, as
 * the spec says a same-caller retry must receive; and nothing on the gateway
 * side knew the tool had already been called. Two workflow dispatches, one
 * receipt id, a duplicate stopped only by the deploy host's 409.
 *
 * This test recreates the collision deliberately — several nudges and agent
 * checks fired at once, plus the poll loop — against a real AS, a real
 * gateway, and a real CRM MCP server, and asserts on the EFFECT: one row in
 * the CRM database. The AS-side count (one receipt) is asserted too, but
 * that is the half that already worked; the effect is the point.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ProcessManager } from '../src/helpers/process-manager';
import { SPClient } from '../src/helpers/sp-client';
import { GatewayClient } from '../src/helpers/gateway-client';
import { computeBoundsHash, hashGateContent, hashExecutionContext } from '../src/helpers/crypto';

const SP_PORT = 16410;
const GW_PORT = 16440;

const pm = new ProcessManager();
let sp: SPClient;
let gw: GatewayClient;
let apiKey: string;
let userDid: string;
let groupId: string;
let mcpClient: Client;
let dataDir: string;

const PROFILE = 'github.com/humanagencyprotocol/hap-profiles/customers@0.4';

/** Count CRM contacts by exact name — the real downstream effect. */
function contactsNamed(name: string): number {
  const db = join(dataDir, 'crm.db');
  if (!existsSync(db)) return 0;
  // sqlite3 is present on macOS and on ubuntu-latest runners. If it is not,
  // fail loudly: a test that cannot count effects must not pass.
  const out = execFileSync('sqlite3', [db, `SELECT COUNT(*) FROM contacts WHERE name = '${name}';`], {
    encoding: 'utf8',
  });
  return parseInt(out.trim(), 10);
}

function journalRowsFor(proposalId: string): Array<{ ticketId: string; state: string }> {
  const file = join(dataDir, 'execution-journal.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    entries: Array<{ ticketId: string; proposalId?: string; state: string }>;
  };
  return parsed.entries.filter(e => e.proposalId === proposalId);
}

async function callCheckPending(proposalId: string): Promise<string> {
  const result = await mcpClient.callTool({
    name: 'check-pending-commitments',
    arguments: { proposal_id: proposalId },
  });
  return (result.content as Array<{ text: string }>)[0].text;
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  sp = new SPClient(`http://localhost:${SP_PORT}`);
  const user = await sp.register('OnceUser', `onceuser-${Date.now()}@test.com`);
  apiKey = user.apiKey;
  userDid = user.user.did;
  groupId = await sp.getPersonalGroupId(apiKey);

  dataDir = pm.getDataDir();
  await pm.startGateway({
    port: GW_PORT,
    spUrl: `http://localhost:${SP_PORT}`,
    spApiKey: apiKey,
    profilesDir: `${process.cwd()}/../hap-profiles`,
  });
  gw = new GatewayClient(`http://localhost:${GW_PORT}`);
  await gw.configure({ sessionCookie: `api-key=${apiKey}`, apiKey });

  // Review-mode grant under the customers profile → every write is a proposal.
  const bounds = { profile: PROFILE, write_daily_max: 10, delete_daily_max: 5 };
  const boundsHash = computeBoundsHash(bounds, ['profile', 'write_daily_max', 'delete_daily_max']);
  const contextHash = computeBoundsHash({}, []);
  const att = await sp.submitAttestation(apiKey, {
    profile_id: PROFILE,
    group_id: groupId,
    domain: 'owner',
    did: userDid,
    bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    gate_content_hashes: hashGateContent({ intent: 'test' }),
    execution_context_hash: hashExecutionContext({ profile: PROFILE, domain: 'owner' }),
    commitment_mode: 'review',
  });
  await gw.pushGateContent(
    { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
    PROFILE,
    { intent: 'test' },
  );

  await gw.waitForIntegration('crm');
  await new Promise(r => setTimeout(r, 2_000));

  const transport = new SSEClientTransport(new URL(`http://localhost:${GW_PORT}/sse`));
  mcpClient = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(transport);
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* */ } }
  await pm.killAll();
});

describe('Exactly-once execution under concurrent triggers', () => {
  const NAME = `Once Contact ${Date.now()}`;
  let proposalId: string;

  it('a review-mode write becomes a proposal and has no effect yet', async () => {
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: { name: NAME, type: 'customer' },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Awaiting commitment');
    proposalId = text.match(/Proposal ID: ([a-f0-9]+)/)![1];
    expect(contactsNamed(NAME)).toBe(0);
  });

  it('commit, then hit it from every trigger at once — the effect happens exactly once', async () => {
    const res = await fetch(`http://localhost:${SP_PORT}/api/proposals/${proposalId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ action: 'commit', domain: 'owner' }),
    });
    expect(res.ok).toBe(true);
    expect((await res.json()).status).toBe('committed');

    // The collision, on purpose: the control-plane's nudge (three of them),
    // the agent asking twice, and the poll loop ticking underneath.
    const nudge = () =>
      fetch(`http://localhost:${GW_PORT}/internal/run-committed`, { method: 'POST' }).then(r => r.status);
    const results = await Promise.all([
      nudge(),
      nudge(),
      nudge(),
      callCheckPending(proposalId),
      callCheckPending(proposalId),
    ]);
    expect(results.slice(0, 3)).toEqual([200, 200, 200]);

    // Let the poll loop take at least one more pass over an already-executed
    // proposal (it polls every 5 s) before counting.
    await new Promise(r => setTimeout(r, 7_000));

    // 1. THE assertion: one contact.
    expect(contactsNamed(NAME)).toBe(1);

    // 2. The gateway's own record: one journal row, done.
    const rows = journalRowsFor(proposalId);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('done');

    // 3. The AS's record: one receipt for this proposal. (This half already
    //    held on 2026-09-04 — it is here so a regression on either side shows.)
    const { receipts } = await sp.getGroupReceipts(apiKey, groupId);
    const forProposal = receipts.filter(r => r.proposalId === proposalId);
    expect(forProposal).toHaveLength(1);
    expect(forProposal[0].id).toBe(rows[0].ticketId);

    // 4. Every later check reports "executed" and refuses to run it again.
    const later = await callCheckPending(proposalId);
    expect(later).toMatch(/already been EXECUTED/);
    expect(contactsNamed(NAME)).toBe(1);
  }, 30_000);
});
