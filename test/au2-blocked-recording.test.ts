/**
 * AU2 (suveren-as/docs/work-plan.md "Added 2026-10-09") — every refusal of a
 * gated tool call is recorded locally, not only reads. This is the real-path
 * check unit tests cannot give: a real gateway process, started from the
 * worktree under test with its own `SUVEREN_DATA_DIR`, refusing a real call
 * (first the local Gatekeeper, then the Authority Server) through a real
 * connector (@humanagencyp/crm-mcp) — then reading the denial log file the
 * gateway process actually wrote.
 *
 * Two refusal kinds exercised here (the other three — simulation, scope,
 * not_authorized — are covered by apps/mcp-server/test/blocked-recording.test.ts
 * in the gateway repo, which this complements rather than repeats):
 *   - 'bound'      — a per_transaction bound the local Gatekeeper refuses
 *                    before the Authority Server is ever contacted.
 *   - 'cumulative' — a cumulative_count bound only the Authority Server
 *                    enforces (hap-core's Gatekeeper MUST NOT enforce
 *                    cumulative bounds locally — protocol.md → *Enforcement
 *                    Authority*), reached by calling through the gateway
 *                    twice against a daily cap of 1.
 *
 * No vault/control-plane pairing happens in this harness (same as the other
 * real-stack suites), so the gateway's DenialLog persists in PLAINTEXT
 * (`denials.json` under its SUVEREN_DATA_DIR) — read directly here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  hashGateContent,
  hashExecutionContext,
  computeBoundsHash,
  computeScopeHash,
  computeProfileHash,
} from '../src/helpers/crypto.js';

const SP_PORT = 18950;
const GW_PORT = 18951;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const BOUNDS_KEY_ORDER = ['profile', 'amount_max', 'write_daily_max'];
const GATE_CONTENT = { intent: 'E2E fixture: AU2 blocked-action recording. Deal value cap 5,000; one write per day.' };

function testProfile(id: string) {
  return {
    id,
    name: 'E2E AU2 blocked-recording fixture',
    version: '1.0',
    description: 'Throwaway community profile for AU2 real-path recording coverage. Not a published hap-profiles profile.',
    boundsSchema: {
      actionTypes: ['write', 'setup'],
      keyOrder: BOUNDS_KEY_ORDER,
      fields: {
        profile: { type: 'string', required: true },
        amount_max: {
          type: 'number',
          required: true,
          displayName: 'Max value per deal',
          description: 'Per-transaction cap (test fixture).',
          unit: 'count',
          boundType: { kind: 'per_transaction', of: 'amount' },
        },
        write_daily_max: {
          type: 'number',
          required: true,
          displayName: 'Daily write limit',
          description: 'Cumulative daily cap — Authority Server only (test fixture).',
          unit: 'count',
          boundType: { kind: 'cumulative_count', window: 'daily' },
          appliesTo: ['write'],
        },
      },
    },
    scopeSchema: { keyOrder: [], fields: {} },
    executionContextSchema: {
      fields: {
        action_type: {
          source: 'declared',
          description: 'write or setup',
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

function crmIntegration(profileShortName: string) {
  return {
    id: 'crm',
    name: 'CRM',
    command: 'npx',
    args: ['-y', '@humanagencyp/crm-mcp@1.4.0'],
    envKeys: {},
    profile: profileShortName,
    enabled: true,
    toolGating: {
      default: { executionMapping: {}, staticExecution: {} },
      overrides: {
        create_contact: { executionMapping: {}, staticExecution: { action_type: 'setup' } },
        create_deal: { executionMapping: { value: 'amount' }, staticExecution: { action_type: 'write' } },
      },
    },
  };
}

interface DenialRecord {
  ts: number; tool: string; integrationId: string; profile: string | null;
  kind?: string; detail: string;
  mandateId?: string; field?: string; value?: number | string; limit?: number | string;
  who?: string; code?: string;
}

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);
const work = mkdtempSync(join(tmpdir(), 'hap-e2e-au2-'));

let mcpClient: Client;
let apiKey: string;
let profileId: string;
let authorizationId: string;
let contactId: string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(tool: string, args: Record<string, unknown>) {
  const r = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (r.content as Array<{ text?: string }>)?.map((c) => c.text ?? '').join('\n') ?? '';
  return { denied: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** Read the gateway process's own plaintext denial log (no vault pairing in
 * this harness, so it is never encrypted) — newest first. */
function readDenials(): DenialRecord[] {
  const path = join(pm.getDataDir(), 'denials.json');
  const data = JSON.parse(readFileSync(path, 'utf-8')) as { records?: DenialRecord[] };
  return [...(data.records ?? [])].sort((a, b) => b.ts - a.ts);
}

beforeAll(async () => {
  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const user = await sp.register('AU2 E2E', `au2-blocked-${Date.now()}@test.local`);
  apiKey = user.apiKey;
  const did = user.user.did;
  const groupId = await sp.getPersonalGroupId(apiKey);

  const created = await sp.createProfile(apiKey, testProfile('au2-blocked-fixture@1.0'));
  profileId = created.profile_id;

  const profilesDir = join(work, 'profiles');
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(join(profilesDir, 'profile.json'), JSON.stringify(testProfile(profileId)));
  writeFileSync(join(profilesDir, 'index.json'), JSON.stringify({
    repository: 'e2e-fixture',
    profiles: { [profileId]: 'profile.json' },
  }));

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: apiKey, profilesDir });
  await gw.configure({ sessionCookie: 'au2-blocked-e2e', apiKey });

  // Per-transaction cap 5,000; cumulative daily cap of exactly 1 write — the
  // SECOND write within the bound must still be refused, by the AS alone.
  const bounds = { profile: profileId, amount_max: 5000, write_daily_max: 1 };
  const boundsHash = computeBoundsHash(bounds, BOUNDS_KEY_ORDER);
  const scopeHash = computeScopeHash({}, []);
  const mandate = await sp.submitMandate(apiKey, {
    profile_id: profileId,
    profile_hash: computeProfileHash({ ...testProfile(profileId), id: profileId }),
    group_id: groupId,
    bounds,
    bounds_hash: boundsHash,
    scope_hash: scopeHash,
    domain: 'owner',
    did,
    commitment_mode: 'automatic',
    gate_content_hashes: hashGateContent(GATE_CONTENT),
    execution_context_hash: hashExecutionContext({ profile: profileId, domain: 'owner' }),
  });
  authorizationId = mandate.authorization_id;
  await gw.pushGateContent({ authorizationId, boundsHash, contextHash: scopeHash, context: {} }, profileId, GATE_CONTENT);

  await sleep(500);

  const shortName = profileId.split('/').pop()!.replace(/@.*$/, '');
  const added = await gw.addIntegration(crmIntegration(shortName));
  expect(added.ok).toBe(true);

  await sleep(5_000); // npx download + crm-mcp init

  mcpClient = new Client({ name: 'hap-au2-blocked-e2e', version: '0.1.0' }, { capabilities: {} });
  await mcpClient.connect(new SSEClientTransport(new URL(`${GW_URL}/sse`)));

  const contactResult = await call('crm__create_contact', { name: 'AU2 Test Contact' });
  expect(contactResult.denied).toBe(false);
  contactId = contactResult.json.id;
}, 180_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
  rmSync(work, { recursive: true, force: true });
}, 30_000);

describe('AU2 — a local bound refusal is recorded by the real gateway process', () => {
  it('REFUSES a deal over the per-transaction bound, and records it (kind "bound")', async () => {
    const r = await call('crm__create_deal', { contact_id: contactId, title: 'Over bound', value: 6000 });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/exceeds|amount_max/i);

    const [latest] = readDenials();
    expect(latest).toBeTruthy();
    expect(latest.kind).toBe('bound');
    expect(latest.who).toBe('gateway');
    expect(latest.code).toBe('BOUND_EXCEEDED');
    expect(latest.field).toBe('amount');
    expect(latest.value).toBe(6000);
    expect(latest.limit).toBe(5000);
    expect(latest.mandateId).toBe(authorizationId);
    expect(latest.integrationId).toBe('crm');
    // Never content: the title/contact text must not appear anywhere in the record.
    expect(JSON.stringify(latest)).not.toContain('Over bound');
  });
});

describe('AU2 — a cumulative refusal from the real Authority Server is recorded by the real gateway process', () => {
  it('admits the first write of the day, then REFUSES the second and records it (kind "cumulative")', async () => {
    const first = await call('crm__create_deal', { contact_id: contactId, title: 'Within bound 1', value: 1000 });
    expect(first.denied).toBe(false);

    const second = await call('crm__create_deal', { contact_id: contactId, title: 'Within bound 2', value: 1000 });
    expect(second.denied).toBe(true);
    expect(second.text).toMatch(/exceeds|write_daily_max|blocked/i);

    const [latest] = readDenials();
    expect(latest).toBeTruthy();
    expect(latest.kind).toBe('cumulative');
    expect(latest.who).toBe('authority-server');
    expect(latest.code).toBe('CUMULATIVE_LIMIT_EXCEEDED');
    expect(latest.mandateId).toBe(authorizationId);
    expect(JSON.stringify(latest)).not.toContain('Within bound 2');
  });
});
