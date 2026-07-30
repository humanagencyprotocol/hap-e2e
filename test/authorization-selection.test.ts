/**
 * Authorization Selection — Gateway E2E (acceptance spec for Finding B, §7 of
 * doc/read-bounds-enforcement-plan.md).
 *
 * THE GAP UNDER TEST
 * When more than one authorization matches a single action (same profile,
 * overlapping scope), today's gateway takes the FIRST authorization that passes
 * verification, in cache (Map insertion) order — with no preference for
 * specificity or commitment mode. Consequence: an approval requirement you set
 * can be silently bypassed by an overlapping no-approval grant, and vice versa;
 * the outcome is order-dependent.
 *
 * THE TARGET BEHAVIOR (most-specific-wins + fail-safe fallback)
 *   1. If one matching authority is strictly more specific (its scope is
 *      contained in the others'), it wins — the deliberate exception.
 *   2. If no single authority is strictly most-specific (partial overlap,
 *      neither nested), fall back to REQUIRING APPROVAL if any matching
 *      authority requires it. Ambiguity must never silently weaken.
 *
 * WHY CRM / customers@0.4
 * Real MCP server (@humanagencyp/crm-mcp), NO credentials, and a real scope
 * dimension (contact_type, subset) that create_contact enforces — so the
 * GENERIC selection logic is exercised without Gmail. The mechanism is
 * profile-agnostic; email/calendar would behave identically.
 *
 * STATUS: red now (the fix is unimplemented), green once §7.4a lands. Each
 * scenario runs in its OWN isolated stack (own SP + gateway + user) so grants
 * from one scenario can't leak into another's selection.
 *
 * Run:  npx vitest run test/authorization-selection.test.ts
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

// ── Constants ─────────────────────────────────────────────────────────────────

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/customers@0.4';
const PROFILE_SHORT = 'customers';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

const BOUNDS_KEY_ORDER = ['profile', 'write_daily_max', 'delete_daily_max'];
const CONTEXT_KEY_ORDER = ['contact_type'];

// Bounds are identical across grants — scope (contact_type) and commitment mode
// are the only variables, so selection, not bounds, decides the outcome.
const BOUNDS = { profile: PROFILE_ID, write_daily_max: 10, delete_daily_max: 5 };

// crm-mcp toolGating: create_contact maps arg `type` → context field
// `contact_type`, so the gateway enforces the subset scope on it.
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

// ── Per-scenario isolated stack ───────────────────────────────────────────────

interface Grant {
  /** contact_type scope (comma-separated subset), e.g. "customer,lead". */
  contactType: string;
  mode: 'automatic' | 'review';
  intent: string;
}

interface Stack {
  pm: ProcessManager;
  client: Client;
}

/**
 * Boot an isolated SP + gateway + user, submit the given grants (in order),
 * register the CRM integration, and connect an MCP client. Returns the process
 * manager (for teardown) and a connected client.
 */
async function bootScenario(spPort: number, gwPort: number, grants: Grant[]): Promise<Stack> {
  const pm = new ProcessManager();
  const spUrl = `http://localhost:${spPort}`;
  const gwUrl = `http://localhost:${gwPort}`;
  const sp = new SPClient(spUrl);
  const gw = new GatewayClient(gwUrl);

  pm.buildGateway();
  await pm.startSP(spPort);

  const user = await sp.register('Selection E2E', `selection-e2e-${spPort}-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const did = user.user.did;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({ port: gwPort, spUrl, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: `selection-e2e-${spPort}`, apiKey });

  const boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
  const executionContextHash = hashExecutionContext({ contact_type: 'customer', write_count_daily: BOUNDS.write_daily_max });

  for (const grant of grants) {
    const context = { contact_type: grant.contactType };
    const contextHash = computeContextHash(context, CONTEXT_KEY_ORDER);
    const gateContent = { intent: grant.intent };

    const att = await sp.submitAttestation(apiKey, {
      profile_id: PROFILE_ID,
      group_id: groupId,
      bounds: BOUNDS,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      domain: 'owner',
      did,
      commitment_mode: grant.mode,
      gate_content_hashes: hashGateContent(gateContent),
      execution_context_hash: executionContextHash,
    });

    await gw.pushGateContent(
      { authorizationId: att.authorization_id, boundsHash, contextHash, context },
      PROFILE_ID,
      gateContent,
    );
  }

  await sleep(500);

  const added = await gw.addIntegration(CRM_INTEGRATION);
  expect(added.ok).toBe(true);
  expect(added.tools.some((t: string) => t.startsWith('crm__'))).toBe(true);

  // crm-mcp is spawned via npx (download + init) — give it time to come up.
  await sleep(5_000);

  const client = new Client({ name: 'hap-selection-e2e', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(`${gwUrl}/sse`)));

  return { pm, client };
}

/** Call create_contact and return the tool result text. */
async function createContact(client: Client, name: string, type: string): Promise<string> {
  const result = await client.callTool({ name: 'crm__create_contact', arguments: { name, type } });
  return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
}

const isProposal = (text: string): boolean => /Awaiting commitment/i.test(text) && /Proposal ID/i.test(text);

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 1 — specificity precedence: a no-approval exception is honored.
//   broad  {customer,lead}  review     (general rule: everything needs approval)
//   specific {customer}     automatic  (deliberate carve-out: customers are fine)
//   action: create_contact(customer)  → specific ⊂ broad → specific wins → EXECUTES
// ═════════════════════════════════════════════════════════════════════════════

describe('Selection — most-specific-wins: exception honored', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await bootScenario(17210, 17211, [
      { contactType: 'customer,lead', mode: 'review', intent: 'BROAD: all contact ops require my approval.' },
      { contactType: 'customer', mode: 'automatic', intent: 'SPECIFIC: customer contacts are pre-approved.' },
    ]);
  }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('runs automatically under the more-specific grant (no proposal)', async () => {
    const text = await createContact(stack.client, 'Selection Customer', 'customer');
    // TARGET (§7.2): the specific automatic grant wins → executed, no approval.
    // TODAY: first-pass-wins may pick the broad review grant → proposal (that
    // non-determinism is the bug this asserts against).
    expect(isProposal(text)).toBe(false);
    expect(text).toContain('Selection Customer');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 2 — SECURITY-CRITICAL: an approval requirement is NOT bypassed.
//   broad  {customer,lead}  automatic  (general rule: contacts run immediately)
//   specific {customer}     review     (deliberate restriction: customers need approval)
//   action: create_contact(customer)  → specific ⊂ broad → specific wins → PROPOSAL
// ═════════════════════════════════════════════════════════════════════════════

describe('Selection — most-specific-wins: approval NOT bypassed', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await bootScenario(17220, 17221, [
      { contactType: 'customer,lead', mode: 'automatic', intent: 'BROAD: contact ops run immediately.' },
      { contactType: 'customer', mode: 'review', intent: 'SPECIFIC: customer contacts require my approval.' },
    ]);
  }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('routes to approval under the more-specific grant (proposal, not execution)', async () => {
    const text = await createContact(stack.client, 'Restricted Customer', 'customer');
    // TARGET (§7.2): the specific review grant wins → proposal; approval enforced.
    // TODAY: first-pass-wins may pick the broad automatic grant → silent execute
    // = the approval bypass. This is the finding, made into a regression guard.
    expect(isProposal(text)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 3 — fail-safe fallback on incomparable (partial) overlap.
//   grant X {customer,vip}     automatic
//   grant Y {customer,partner} review
//   action: create_contact(customer) → both admit, neither nested → incomparable
//                                     → fail-safe → PROPOSAL (Y requires approval)
// ═════════════════════════════════════════════════════════════════════════════

describe('Selection — incomparable overlap falls back to approval', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await bootScenario(17230, 17231, [
      { contactType: 'customer,vip', mode: 'automatic', intent: 'X: VIP + customer, immediate.' },
      { contactType: 'customer,partner', mode: 'review', intent: 'Y: partner + customer, needs approval.' },
    ]);
  }, 180_000);
  afterAll(async () => {
    try { await stack?.client.close(); } catch { /* ignore */ }
    await stack?.pm.killAll();
  }, 30_000);

  it('requires approval when no single grant is strictly most-specific', async () => {
    const text = await createContact(stack.client, 'Ambiguous Customer', 'customer');
    // TARGET (§7.2 fail-safe): neither grant contains the other → cannot pick a
    // deliberate exception → require approval because Y does. TODAY: first-pass
    // -wins may execute under X → weakening. Fail-safe closes that.
    expect(isProposal(text)).toBe(true);
  });
});
