/**
 * Revoked-mandate fallback — Gateway E2E.
 *
 * THE BUG (suveren-as/docs/work-plan.md "first call after a revoke fails
 * instead of falling back"): when a mandate is revoked and another valid
 * mandate on the same profile exists, the next ticketed call could still
 * select the revoked one. The Authority Server refuses ("revoked"), the
 * gateway purges it from its cache (tool-proxy.ts, 403 path) — and THAT CALL
 * FAILED instead of retrying with the remaining mandate. It only self-healed
 * on the NEXT call. Seen in `test/simulation-setup.test.ts` (setup mandates
 * revoked → work mandates): see the comment on its "switching to work
 * mandates" case.
 *
 * THE FIX: on a stale-mandate refusal (ATTESTATION_REVOKED / ATTESTATION_EXPIRED
 * / ATTESTATION_NOT_FOUND — never a bound/approval refusal), the gateway
 * purges the dead mandate and reruns selection ONCE, in the SAME call, over
 * the remaining locally-passing candidates.
 *
 * THIS SCENARIO: two automatic-mode mandates on customers@0.4, scoped so
 * selection is deterministic regardless of which authorizationId sorts
 * first — NARROW (`contact_type: customer`) is strictly more specific than
 * BROAD (`contact_type: customer,lead`), so most-specific-wins always picks
 * NARROW first (scope-specificity.ts). Revoke NARROW, then make the very next
 * `create_contact(customer)` call:
 *   - it must succeed (not a denial, not a proposal) — BROAD still covers it;
 *   - it must produce EXACTLY ONE receipt, issued against BROAD — proving the
 *     gateway tried NARROW once (refused as revoked), fell back, and the
 *     downstream tool ran only after BROAD's ticket was issued, not twice.
 *
 * Mirrors authorization-selection.test.ts's pattern: real CRM MCP
 * (@humanagencyp/crm-mcp), no credentials, a real scope dimension the
 * connector enforces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeContextHash,
} from '../src/helpers/crypto.js';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/customers@0.4';
const PROFILE_SHORT = 'customers';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const BOUNDS_KEY_ORDER = ['profile', 'write_daily_max', 'delete_daily_max'];
const CONTEXT_KEY_ORDER = ['contact_type'];

// Bounds are identical on both grants — only scope (contact_type) differs, so
// specificity (not bounds) decides which mandate is tried first.
const BOUNDS = { profile: PROFILE_ID, write_daily_max: 10, delete_daily_max: 5 };

const SP_PORT = 17240;
const GW_PORT = 17241;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const CRM_INTEGRATION = {
  id: 'crm',
  name: 'CRM',
  command: 'npx',
  args: ['-y', '@humanagencyp/crm-mcp@latest'],
  envKeys: {},
  profile: PROFILE_SHORT,
  enabled: true,
  toolGating: {
    default: { executionMapping: {}, staticExecution: { contact_type: 'customer' } },
    overrides: {
      create_contact: { executionMapping: { type: 'contact_type' }, staticExecution: { action_type: 'write' } },
      find_contacts: { category: 'read' },
      get_timeline: { category: 'read' },
      get_pipeline: { category: 'read' },
      list_tasks: { category: 'read' },
      export_crm: { category: 'read' },
    },
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isProposal = (text: string): boolean => /Awaiting commitment/i.test(text) && /Proposal ID/i.test(text);
const isDenied = (text: string): boolean =>
  /Blocked|rejected by Gatekeeper|no active authorization/i.test(text);

describe('Revoked-mandate fallback — the very next call succeeds via the remaining mandate', () => {
  const pm = new ProcessManager();
  const sp = new SPClient(SP_URL);
  const gw = new GatewayClient(GW_URL);
  let apiKey: string;
  let did: string;
  let groupId: string;
  let client: Client;
  let narrowId: string;
  let broadId: string;

  beforeAll(async () => {
    pm.buildGateway();
    await pm.startSP(SP_PORT);

    const user = await sp.register('Revoke Fallback E2E', `revoke-fallback-e2e-${Date.now()}@test.local`);
    apiKey = user.apiKey;
    did = user.user.did;
    groupId = await sp.getPersonalGroupId(apiKey);

    await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
    await gw.configure({ sessionCookie: 'revoke-fallback-e2e', apiKey });

    const boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
    const executionContextHash = hashExecutionContext({ contact_type: 'customer', write_count_daily: BOUNDS.write_daily_max });

    async function grant(contactType: string, intent: string): Promise<string> {
      const context = { contact_type: contactType };
      const contextHash = computeContextHash(context, CONTEXT_KEY_ORDER);
      const gateContent = { intent };
      const att = await sp.submitAttestation(apiKey, {
        profile_id: PROFILE_ID,
        group_id: groupId,
        bounds: BOUNDS,
        bounds_hash: boundsHash,
        context_hash: contextHash,
        domain: 'owner',
        did,
        commitment_mode: 'automatic',
        gate_content_hashes: hashGateContent(gateContent),
        execution_context_hash: executionContextHash,
      });
      await gw.pushGateContent(
        { authorizationId: att.authorization_id, boundsHash, contextHash, context },
        PROFILE_ID,
        gateContent,
      );
      return att.authorization_id;
    }

    // NARROW ⊂ BROAD on contact_type → NARROW is strictly more specific →
    // scope-specificity.ts always picks it first for a "customer" action,
    // REGARDLESS of which authorizationId happens to sort first. This is
    // what makes "the gateway tries the dead mandate before falling back"
    // deterministic rather than a coin flip on UUID ordering.
    narrowId = await grant('customer', 'NARROW: customer contacts only, pre-approved.');
    broadId = await grant('customer,lead', 'BROAD: customer + lead contacts, pre-approved.');

    await sleep(500);

    const added = await gw.addIntegration(CRM_INTEGRATION);
    expect(added.ok).toBe(true);
    expect(added.tools.some((t: string) => t.startsWith('crm__'))).toBe(true);

    // crm-mcp is spawned via npx (download + init) — give it time to come up.
    await sleep(5_000);

    client = new Client({ name: 'hap-revoke-fallback-e2e', version: '0.1.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
  }, 180_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    await pm.killAll();
  }, 30_000);

  it('after NARROW is revoked, the very next call succeeds via BROAD with exactly one new receipt', async () => {
    await sp.revokeAuthorization(apiKey, narrowId);

    const before = await sp.getMyReceiptsPage(apiKey, { limit: 50 });
    const beforeIds = new Set(before.receipts.map((r) => String(r.id)));

    const result = await client.callTool({
      name: 'crm__create_contact',
      arguments: { name: 'Fallback Customer', type: 'customer' },
    });
    const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

    // THE FIX: not a denial (the old bug: NARROW was tried, refused as
    // revoked, and the call failed there) and not a proposal (both grants are
    // automatic) — BROAD authorized it after the fallback.
    expect(isDenied(text)).toBe(false);
    expect(isProposal(text)).toBe(false);
    expect(text).toContain('Fallback Customer');

    // EXACTLY ONE new ticket — issued against BROAD, never NARROW (dead), and
    // never two (one per candidate tried) — the downstream tool executes once,
    // only after a ticket was actually issued.
    const after = await sp.getMyReceiptsPage(apiKey, { limit: 50 });
    const newReceipts = after.receipts.filter((r) => !beforeIds.has(String(r.id)));
    expect(newReceipts).toHaveLength(1);
    expect(newReceipts[0].authorizationId).toBe(broadId);
    expect(newReceipts[0].authorizationId).not.toBe(narrowId);
  });
});
