/**
 * Commitment execution result retention — Gateway E2E (gateway PR #115,
 * fix/keep-execution-result).
 *
 * THE GAP: a review-mode proposal's gateway-committed execution lost its
 * result — the local journal/result were never persisted past the single
 * return value of the call that ran it, so a LATER
 * check-pending-commitments(proposal_id) call answered "already EXECUTED ...
 * the gateway did not retain its output" even on SUCCESS. A failed execution
 * (the connector itself refusing, isError) was already journaled 'failed'
 * and excluded from the local execution-log count, but its error text was
 * not retained for that later call either, and there was no regression test
 * for either case.
 *
 * TARGET:
 *   - success: a SECOND check-pending-commitments(proposal_id) call returns
 *     the tool's actual retained result, not "did not retain its output";
 *   - failure (the real connector returns isError AFTER approval): recorded
 *     as failed (never executed), a SECOND check-pending-commitments call
 *     still reports the failure with the connector's own error text, and the
 *     local execution log does NOT count it — proven black-box via
 *     list-authorizations' consumption display (fed by the LOCAL execution
 *     log, not the Authority Server's own cumulative reservation, which by
 *     design still counts a failed attempt — see the PR's commit message).
 *
 * Real Authority Server + real gateway + real @humanagencyp/crm-mcp
 * (customers is personalDefault, auto-installed from the shipped manifest).
 *
 * Run: npx vitest run test/commitment-execution-result.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeScopeHash,
} from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const EXECUTION_RESULT_STORE_SRC = join(
  ROOT, 'suveren-gateway', 'apps', 'mcp-server', 'src', 'lib', 'execution-result-store.ts',
);

// Feature gate: PR #115 adds this file. Detected from the gateway's own
// source rather than a version string.
const available = existsSync(EXECUTION_RESULT_STORE_SRC);

const SP_PORT = 19160;
const GW_PORT = 19161;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = PROFILE_V07.customers;
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'export_access', 'write_daily_max', 'delete_daily_max', 'setup_daily_max'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
let apiKey: string;
let userDid: string;
let mcpClient: Client;

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { isError: r.isError === true, text };
}

function extractProposalId(text: string): string {
  const m = text.match(/Proposal ID:\s*([^\s.]+)/);
  expect(m, `a "Proposal ID: ..." line in: ${text}`).toBeTruthy();
  return m![1];
}

async function commitProposal(proposalId: string): Promise<void> {
  const res = await fetch(`${SP_URL}/api/proposals/${proposalId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ action: 'commit', domain: 'owner' }),
  });
  expect(res.ok).toBe(true);
}

/** The "Daily write limit" consumption figure from list-authorizations(domain:
 *  "customers") — fed by the gateway's own LOCAL execution log, which is the
 *  thing under test here (distinct from the Authority Server's own
 *  cumulative reservation at ticket issuance, which by PR #115's own design
 *  decision is NOT rolled back on a failed execution). */
async function writeUsage(): Promise<number> {
  const { text } = await call('list-authorizations', { domain: 'customers' });
  const m = text.match(/Daily write limit:\s*(\d+)\s*\/\s*\d+/);
  expect(m, `a "Daily write limit: n / m" line in: ${text}`).toBeTruthy();
  return Number(m![1]);
}

describe.skipIf(!available)('Commitment execution result retention (review mode, real AS + gateway + crm-mcp)', () => {
  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    const reg = await sp.register('ExecResult E2E', `exec-result-${Date.now()}@test.local`);
    apiKey = reg.apiKey;
    userDid = reg.user.did;
    const groupId = await sp.getPersonalGroupId(apiKey);

    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'exec-result-e2e', apiKey });

    const bounds = {
      profile: PROFILE_ID,
      read_access: 'unlimited',
      export_access: 'none',
      write_daily_max: 10,
      delete_daily_max: 5,
      setup_daily_max: 0,
    };
    const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
    const contextHash = computeScopeHash({}, []);
    const gateContent = { intent: 'E2E review-mode customers mandate for execution-result retention.' };

    const att = await sp.submitMandate(apiKey, {
      profile_id: PROFILE_ID,
      profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR),
      group_id: groupId,
      domain: 'owner',
      did: userDid,
      bounds,
      bounds_hash: boundsHash,
      scope_hash: contextHash,
      gate_content_hashes: hashGateContent(gateContent),
      execution_context_hash: hashExecutionContext({ profile: PROFILE_ID, domain: 'owner' }),
      commitment_mode: 'review',
    });
    await gw.pushGateContent(
      { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
      PROFILE_ID,
      gateContent,
    );

    await gw.waitForIntegration('crm');
    await sleep(1_000);

    mcpClient = new Client({ name: 'exec-result-e2e', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
  }, 180_000);

  afterAll(async () => {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await pm.killAll();
  }, 30_000);

  // ── Success path ────────────────────────────────────────────────────────

  let contactName: string;
  let contactId: string;

  it('a review-mode write, approved, returns the tool result on the FIRST execute call', async () => {
    contactName = `Success Contact ${Date.now()}`;
    const proposed = await call('crm__create_contact', { name: contactName, type: 'customer' });
    expect(proposed.isError).not.toBe(true);
    expect(proposed.text).toContain('Awaiting commitment');
    const proposalId = extractProposalId(proposed.text);

    await commitProposal(proposalId);

    const first = await call('check-pending-commitments', { proposal_id: proposalId });
    expect(first.isError).not.toBe(true);
    expect(first.text).toContain('committed and executed');
    expect(first.text).toContain('Result:');
    expect(first.text).toContain(contactName);
    const resultJson = first.text.slice(first.text.indexOf('Result:') + 'Result:'.length).trim();
    contactId = JSON.parse(resultJson).id;
    expect(contactId).toBeTruthy();

    // ── This is the actual regression: a SECOND call must not say the
    // gateway "did not retain its output" on a SUCCESSFUL execution.
    const second = await call('check-pending-commitments', { proposal_id: proposalId });
    expect(second.isError).not.toBe(true);
    expect(second.text).not.toContain('did not retain its output');
    expect(second.text).toContain('approved and executed');
    expect(second.text).toContain('Result:');
    expect(second.text).toContain(contactName);
  }, 30_000);

  // ── Failure path ────────────────────────────────────────────────────────
  //
  // crm-mcp@1.5.0 added optimistic-concurrency `revision` checks (stale-update
  // protection, same mechanism as the ERP connector's quote revisions) —
  // update_contact now requires the contact's CURRENT revision and refuses,
  // naming both revisions, if it does not match. A freshly created contact
  // starts at revision 1; declaring revision 2 is deterministically wrong and
  // isError AFTER approval — exactly the real-connector-refusal case #115
  // must retain and not count.

  it('a review-mode write the connector refuses (isError, stale revision) after approval is recorded as FAILED, not executed, not counted locally', async () => {
    const baselineUsage = await writeUsage();

    const read = await call('crm__get_contact', { id: contactId });
    expect(read.isError).not.toBe(true);
    const currentRevision = JSON.parse(read.text).revision;
    expect(currentRevision).toBe(1);
    const wrongRevision = currentRevision + 1;

    const proposed = await call('crm__update_contact', {
      id: contactId, revision: wrongRevision, contact_type: 'customer', name: 'Should never apply',
    });
    expect(proposed.isError).not.toBe(true);
    expect(proposed.text).toContain('Awaiting commitment');
    const proposalId = extractProposalId(proposed.text);

    await commitProposal(proposalId);

    const first = await call('check-pending-commitments', { proposal_id: proposalId });
    expect(first.isError).toBe(true);
    expect(first.text).toContain('refused to run it');
    expect(first.text).toContain('nothing was done');
    // Names BOTH revisions — the actual (1) and the one declared (2).
    expect(first.text).toContain(`is at revision ${currentRevision}`);
    expect(first.text).toContain(`revision ${wrongRevision}`);
    expect(first.text).not.toContain('Should never apply');

    // The content must genuinely not have changed.
    const stillOld = await call('crm__get_contact', { id: contactId });
    expect(JSON.parse(stillOld.text).name).toBe(contactName);
    expect(JSON.parse(stillOld.text).revision).toBe(currentRevision);

    // The local execution log must NOT have counted this failed attempt —
    // proven via list-authorizations' own consumption display, fed by the
    // LOCAL execution log (not the Authority Server's cumulative
    // reservation, which the PR deliberately leaves in place).
    const afterFirst = await writeUsage();
    expect(afterFirst).toBe(baselineUsage);

    // ── The actual regression for the failure path: a SECOND call must
    // still say it failed, with the connector's own error text, not
    // silently flip to "executed" or drop the reason.
    const second = await call('check-pending-commitments', { proposal_id: proposalId });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('refused to run it');
    expect(second.text).toContain(`is at revision ${currentRevision}`);
    expect(second.text).toContain(`revision ${wrongRevision}`);

    const afterSecond = await writeUsage();
    expect(afterSecond).toBe(baselineUsage);
  }, 30_000);
});
