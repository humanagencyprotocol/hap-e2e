/**
 * Per-transaction bound requiredFor (v0.8+), on the real stack.
 *
 * A `per_transaction` bound used to be skipped whenever the execution context
 * lacked its `of` field: a cap of 5,000 refused a declared 6,000 but admitted
 * a call declaring no value at all. `requiredFor` closes that — see
 * content/0.7/review.md → "Per-transaction bounds must be able to require
 * their value" and suveren-as/docs/work-plan.md → "Missing value passes a
 * per-transaction bound".
 *
 * No published hap-profiles profile declares `requiredFor` yet (that is
 * Andreas's decision, next version of sales/charge/purchase) — so this test
 * authors its own, throwaway, via the Authority Server's community-profile
 * endpoint (`POST /api/profiles`, capped at a 24h TTL), exactly the mechanism
 * that endpoint exists for. It is governed by the real @humanagencyp/crm-mcp
 * connector (credential-free, local SQLite) through a custom integration added
 * live via `gw.addIntegration` — same pattern as
 * authorization-selection-generic.test.ts, which proves genericity the same
 * way: a second, structurally different, real profile through the same code.
 *
 * Tool choice matters here: `create_deal`'s `value` is a real, OPTIONAL,
 * number-typed argument (crm-mcp's own schema) — so omitting it is a
 * legitimate call the gateway's Zod-derived tool schema accepts, reaching the
 * Gatekeeper with no `amount` in the execution context, exactly the hole this
 * feature closes. `update_deal`'s `title` (a string field) is deliberately
 * mapped onto the same bound's `of` for the non-numeric case — the real-world
 * analogue named on the ledger: "a tool-gating mapping with a mistyped field
 * name... turns a monetary cap into a limit that nothing can exceed." A
 * required, strictly-number-typed argument (e.g. erp-mcp's create_quote
 * `value`) cannot carry a non-numeric value through the gateway's own schema
 * validation at all, which is why this suite does not use one for that case.
 *
 * Two surfaces, both real processes:
 *   - the GATEWAY's local Gatekeeper (hap-core `verify()`, no execution log) —
 *     refuses before ever contacting the AS;
 *   - the AUTHORITY SERVER directly (`POST /api/as/receipt`), bypassing the
 *     gateway, the same way authorization-bounds.test.ts does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const SP_PORT = 18200;
const GW_PORT = 18201;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const BOUNDS_KEY_ORDER = ['profile', 'amount_max'];
const GATE_CONTENT = { intent: 'E2E fixture: per_transaction requiredFor coverage. Deal value cap 5,000, required for write calls.' };

/**
 * An E2E-only profile — not a hap-profiles version bump. `write` is in
 * requiredFor; `delete` and `setup` are in the actionTypes registry but NOT
 * in requiredFor, proving the opt-in is per action type, not per bound.
 */
function testProfile(id: string) {
  return {
    id,
    name: 'E2E requiredFor fixture',
    version: '1.0',
    description: 'Throwaway community profile for per_transaction bound requiredFor coverage. Not a published hap-profiles profile.',
    boundsSchema: {
      actionTypes: ['write', 'delete', 'setup'],
      keyOrder: BOUNDS_KEY_ORDER,
      fields: {
        profile: { type: 'string', required: true },
        amount_max: {
          type: 'number',
          required: true,
          displayName: 'Max value per deal',
          description: 'Per-transaction cap; required for write calls (test fixture).',
          unit: 'count',
          boundType: { kind: 'per_transaction', of: 'amount', requiredFor: ['write'] },
        },
      },
    },
    contextSchema: { keyOrder: [], fields: {} },
    executionContextSchema: {
      fields: {
        action_type: {
          source: 'declared',
          description: 'write, delete or setup',
          required: true,
          constraint: { type: 'string', enforceable: ['enum'] },
        },
        amount: {
          source: 'declared',
          description: 'Declared amount for a write call',
          required: false,
          constraint: { type: 'number', enforceable: ['max'] },
        },
      },
    },
    requiredGates: ['intent'],
    ttl: { default: 3600, max: 86400 },
  };
}

/**
 * A fully custom integration, added live (no manifest file) — mirrors
 * authorization-selection-generic.test.ts's RECORDS_INTEGRATION, same
 * technique applied to crm-mcp. `create_contact` is labelled `setup` (not in
 * requiredFor) purely to mint a contact_id `delete_contact` can act on;
 * nothing about the bound cares what a "setup" action is.
 */
function crmIntegration(profileShortName: string) {
  return {
    id: 'crm',
    name: 'CRM',
    command: 'npx',
    args: ['-y', '@humanagencyp/crm-mcp@latest'],
    envKeys: {},
    profile: profileShortName,
    enabled: true,
    toolGating: {
      default: { executionMapping: {}, staticExecution: {} },
      overrides: {
        create_contact: {
          executionMapping: {},
          staticExecution: { action_type: 'setup' },
        },
        create_deal: {
          executionMapping: { value: 'amount' },
          staticExecution: { action_type: 'write' },
        },
        update_deal: {
          // Deliberately mistyped: title (a string) mapped onto the bound's
          // `of`. This is the realistic shape of the bug requiredFor closes —
          // not a hand-crafted non-numeric value, but a manifest that maps
          // the wrong field onto a bound.
          executionMapping: { title: 'amount' },
          staticExecution: { action_type: 'write' },
        },
        delete_contact: {
          executionMapping: {},
          staticExecution: { action_type: 'delete' },
        },
      },
    },
  };
}

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-required-for-'));

let mcpClient: Client;
let apiKey: string;
let profileId: string; // full community/<userId>/<...>@1.0 id, known only after creation
let authorizationId: string;
let boundsHash: string;
let contactId: string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const user = await sp.register('RequiredFor E2E', `required-for-${Date.now()}@test.local`);
  apiKey = user.apiKey;
  const did = user.user.did;
  const groupId = await sp.getPersonalGroupId(apiKey);

  // 1. Author the throwaway profile ON THE AS (community endpoint). The AS
  // prefixes the given id to community/<userId>/<given id> unless it already
  // starts with community/.
  const created = await sp.createProfile(apiKey, testProfile('required-for-fixture@1.0'));
  profileId = created.profile_id;
  expect(profileId).toMatch(/\/required-for-fixture@1\.0$/);

  // 2. Mirror the SAME profile, under the SAME full id, into a throwaway
  // profilesDir the GATEWAY loads locally — the gateway's Gatekeeper resolves
  // profiles from its own registry (SUVEREN_PROFILES_DIR), not from the AS's
  // community store (which has no reach into the gateway process at all).
  const profilesDir = join(work, 'profiles');
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(join(profilesDir, 'profile.json'), JSON.stringify(testProfile(profileId)));
  writeFileSync(join(profilesDir, 'index.json'), JSON.stringify({
    repository: 'e2e-fixture',
    profiles: { [profileId]: 'profile.json' },
  }));

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir });
  await gw.configure({ sessionCookie: 'required-for-e2e', apiKey });

  // 3. Grant: amount_max = 5,000 (per-transaction cap, required for `write`).
  const bounds = { profile: profileId, amount_max: 5000 };
  boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const contextHash = computeContextHash({}, []);
  const att = await sp.submitAttestation(apiKey, {
    profile_id: profileId,
    group_id: groupId,
    bounds,
    bounds_hash: boundsHash,
    context_hash: contextHash,
    domain: 'owner',
    did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(GATE_CONTENT),
    execution_context_hash: hashExecutionContext({ profile: profileId, domain: 'owner' }),
  });
  authorizationId = att.authorization_id;
  await gw.pushGateContent({ authorizationId, boundsHash, contextHash, context: {} }, profileId, GATE_CONTENT);

  await sleep(500);

  const shortName = profileId.split('/').pop()!.replace(/@.*$/, '');
  const added = await gw.addIntegration(crmIntegration(shortName));
  expect(added.ok).toBe(true);
  expect(added.tools.some((t: string) => t.startsWith('crm__'))).toBe(true);

  await sleep(5_000); // npx download + crm-mcp init

  mcpClient = new Client({ name: 'hap-required-for-e2e', version: '0.1.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));

  // A contact to attach deals to — `setup`, not in requiredFor, never touches amount.
  const contactResult = await call('crm__create_contact', { name: 'RequiredFor Test Contact' });
  expect(contactResult.denied).toBe(false);
  contactId = contactResult.json.id;
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
  rmSync(work, { recursive: true, force: true });
}, 30_000);

// ═══ Gateway (local Gatekeeper, before the AS is ever contacted) ═════════════

describe('Gateway — per_transaction requiredFor (write is listed)', () => {
  it('REFUSES a deal with no value at all — value is a real, optional, numeric arg', async () => {
    const r = await call('crm__create_deal', { contact_id: contactId, title: 'No value' });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/exposes no amount|amount_max/i);
  });

  it('REFUSES a deal whose amount is not a number (mistyped manifest mapping: title → amount)', async () => {
    const r = await call('crm__update_deal', { id: 'does-not-matter', title: 'a lot of money' });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/not a number|amount_max/i);
  });

  it('approves a deal within the bound — a real ticket is issued', async () => {
    const r = await call('crm__create_deal', { contact_id: contactId, title: 'Within bound', value: 4000 });
    expect(r.denied).toBe(false);
    expect(r.json?.id).toEqual(expect.any(String));
  });

  it('still refuses a deal over the bound (control: ordinary enforcement unaffected)', async () => {
    const r = await call('crm__create_deal', { contact_id: contactId, title: 'Over bound', value: 6000 });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/exceeds|amount_max/i);
  });

  it('an unlisted action type (delete) with no amount keeps passing — requiredFor is per action type', async () => {
    const r = await call('crm__delete_contact', { id: contactId });
    expect(r.denied).toBe(false);
  });
});

// ═══ Authority Server, direct — bypassing the gateway entirely ══════════════

describe('Authority Server — per_transaction requiredFor, direct (bypassing the gateway)', () => {
  it('REFUSES a write receipt with no amount: 403 BOUND_EXCEEDED', async () => {
    const result = await sp.postReceipt(apiKey, {
      authorizationId,
      boundsHash,
      profileId,
      action: 'crm__create_deal',
      actionType: 'write',
      executionContext: { action_type: 'write' },
    });
    expect(result.status).toBe(403);
    const err = (result.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('BOUND_EXCEEDED');
    expect(String(err.message)).toMatch(/exposes no amount/i);
  });

  it('REFUSES a write receipt whose amount is not a number: 403 BOUND_EXCEEDED', async () => {
    const result = await sp.postReceipt(apiKey, {
      authorizationId,
      boundsHash,
      profileId,
      action: 'crm__update_deal',
      actionType: 'write',
      executionContext: { action_type: 'write', amount: 'not-a-number' },
    });
    expect(result.status).toBe(403);
    const err = (result.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('BOUND_EXCEEDED');
    expect(String(err.message)).toMatch(/not a number/i);
  });

  it('issues a receipt for a write within the bound', async () => {
    const result = await sp.postReceipt(apiKey, {
      authorizationId,
      boundsHash,
      profileId,
      action: 'crm__create_deal',
      actionType: 'write',
      executionContext: { action_type: 'write', amount: 4000 },
    });
    expect(result.status).toBe(201);
    expect(result.body.receipt).toBeTruthy();
  });

  it('permits a delete receipt with no amount — delete is not in requiredFor', async () => {
    const result = await sp.postReceipt(apiKey, {
      authorizationId,
      boundsHash,
      profileId,
      action: 'crm__delete_contact',
      actionType: 'delete',
      executionContext: { action_type: 'delete' },
    });
    expect(result.status).toBe(201);
    expect(result.body.receipt).toBeTruthy();
  });
});
