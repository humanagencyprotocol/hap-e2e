/**
 * Authorization Selection — Genericity proof (Finding B, §7 + §7.3 of
 * doc/read-bounds-enforcement-plan.md).
 *
 * The selection logic must be PROFILE-AGNOSTIC: driven by each profile's
 * declared contextSchema, with no hardcoded field names. authorization-
 * selection.test.ts proves most-specific-wins on the customers profile
 * (scope field: contact_type). This file proves the SAME engine behaves
 * correctly on a SECOND, structurally different profile — records@0.4 — which
 * has a different bounds schema and, crucially, NO contextSchema at all.
 *
 * With no scope dimension, no grant can ever be "more specific" than another,
 * so every overlap is incomparable → the fail-safe branch (§7.2) must fire:
 * require approval if any matching authority requires it. This validates the
 * §7.3 per-profile-applicability claim ("records → every overlap resolves via
 * fail-safe") on a real server, and shows incomparability reached by a
 * different route (no scope, vs. customers' partial-scope overlap) yields the
 * same safe outcome from the same code.
 *
 * Real @humanagencyp/records-mcp (local SQLite) — no credentials, no external
 * side effects even on the current buggy path (a write just lands in an
 * ephemeral test DB).
 *
 * STATUS: red now (fix unimplemented), green once §7.4a lands.
 *
 * Run:  npx vitest run test/authorization-selection-generic.test.ts
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

const SP_PORT = 17240;
const GW_PORT = 17241;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/records@0.4';
const PROFILE_SHORT = 'records';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');

// records@0.4 bounds schema — deliberately different shape from customers, and
// there is NO contextSchema (empty context), which is the whole point.
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];
const BOUNDS = {
  profile: PROFILE_ID,
  read_access: 'unlimited',
  write_daily_max: 10,
  delete_access: 'allowed',
  archive_access: 'allowed',
};

const RECORDS_INTEGRATION = {
  id: 'records',
  name: 'Records',
  command: 'npx',
  args: ['-y', '@humanagencyp/records-mcp@latest'],
  envKeys: {},
  profile: PROFILE_SHORT,
  enabled: true,
  toolGating: {
    default: { executionMapping: {}, staticExecution: {} },
    overrides: {
      create_record: { executionMapping: {}, staticExecution: { action_type: 'write' } },
      list_records: { category: 'read' },
      get_record: { category: 'read' },
      search_records: { category: 'read' },
    },
  },
};

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
let mcpClient: Client;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isProposal = (text: string): boolean => /Awaiting commitment/i.test(text) && /Proposal ID/i.test(text);

// ── Setup: two records grants (no scope), automatic then review ───────────────

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const user = await sp.register('Generic Selection E2E', `generic-selection-${Date.now()}@test.local`);
  const apiKey = user.apiKey;
  const did = user.user.did;
  const groupId = await sp.getPersonalGroupId(apiKey);

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir: PROFILES_DIR });
  await gw.configure({ sessionCookie: 'generic-selection-e2e', apiKey });

  const boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash({}, []); // records has no context schema
  const executionContextHash = hashExecutionContext({ profile: PROFILE_ID, domain: 'owner' });

  // Two grants under records@0.4. No scope → neither can be "more specific".
  // Submitted automatic-first so that today's first-pass-wins deterministically
  // picks the automatic grant and executes (the bug); the fix must fail-safe to
  // the review grant instead.
  const grants: Array<{ mode: 'automatic' | 'review'; intent: string }> = [
    { mode: 'automatic', intent: 'GENERIC-X: records writes run immediately.' },
    { mode: 'review', intent: 'GENERIC-Y: records writes require my approval.' },
  ];

  for (const g of grants) {
    const att = await sp.submitAttestation(apiKey, {
      profile_id: PROFILE_ID,
      group_id: groupId,
      bounds: BOUNDS,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      domain: 'owner',
      did,
      commitment_mode: g.mode,
      gate_content_hashes: hashGateContent({ intent: g.intent }),
      execution_context_hash: executionContextHash,
    });
    await gw.pushGateContent(
      { authorizationId: att.authorization_id, boundsHash, contextHash, context: {} },
      PROFILE_ID,
      { intent: g.intent },
    );
  }

  await sleep(500);

  const added = await gw.addIntegration(RECORDS_INTEGRATION);
  expect(added.ok).toBe(true);
  expect(added.tools.some((t: string) => t.startsWith('records__'))).toBe(true);

  await sleep(5_000); // npx download + records-mcp init

  mcpClient = new Client({ name: 'hap-generic-selection-e2e', version: '0.1.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

// ═════════════════════════════════════════════════════════════════════════════

describe('Genericity — records profile (no scope) falls back to approval', () => {
  it('requires approval when no scope makes any grant more specific', async () => {
    const result = await mcpClient.callTool({
      name: 'records__create_record',
      arguments: { type: 'note', title: 'Generic Selection Note', content: 'x' },
    });
    const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

    // TARGET (§7.2 fail-safe, §7.3 records row): no context schema → both grants
    // incomparable → cannot pick a deliberate exception → require approval
    // because the review grant matches. Proves the SAME generic engine that does
    // most-specific-wins on customers/contact_type degrades safely here.
    // TODAY: first-pass-wins picks the automatic grant → executes (weakening).
    expect(isProposal(text)).toBe(true);
  });
});
