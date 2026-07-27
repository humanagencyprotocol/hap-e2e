/**
 * Read authorization — fail-closed enforcement, end to end on the real stack.
 *
 * Until now the read model was proven only by unit tests inside the gateway.
 * That left the most important question unanswered: does a read actually get
 * BLOCKED when it runs through a real Authority Server, a real gateway, a real
 * attestation, and a real MCP server? This test answers it with no external
 * credentials — the records MCP is local SQLite over stdio, and the AS runs on
 * in-memory storage.
 *
 * The read model has exactly two ways to permit a read, and everything else
 * must deny (HAP §3.0 genericity contract, F9):
 *
 *   • a STATIC GATE  — the tool names a bound (`boundField`) that the grant
 *     must carry with a specific value (`requiredValue`);
 *   • a READ ADAPTER — the tool declares how to narrow/verify results
 *     (age window, resource scope). Not exercised here: no credential-free
 *     integration ships an age bound; that path stays unit-covered.
 *
 * A read tool declaring neither is UNGOVERNED and is denied — that is what
 * stops a future connector from silently opting out of the model by omission.
 *
 * One authorization is issued (read_access: "unlimited") and the SAME real
 * records MCP is registered with four differently-gated read tools, so each
 * case differs only in its declared governance:
 *
 *   list_records   gate satisfied            → PERMITTED
 *   get_record     no governance declared    → DENIED (F9)
 *   search_records gate value mismatch       → DENIED
 *   export_records gate names a bound the
 *                  grant does not carry      → DENIED (missing ⇒ blocked,
 *                                              never "skip the check")
 *
 * The last case is the one worth having: a bound that is absent must fail
 * CLOSED. Treating "no such bound" as "nothing to enforce" is the difference
 * between a read model and a suggestion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { hashGateContent, hashExecutionContext, computeBoundsHash, computeContextHash } from '../src/helpers/crypto.js';

// ── Constants ─────────────────────────────────────────────

const SP_PORT = 17140;
const GW_PORT = 17072;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/records@0.4';
const PROFILE_SHORT = 'records';
const EXEC_PATH = PROFILE_ID;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const RECORDS_DIST = join(ROOT, 'hap-records-mcp', 'dist', 'index.js');

// records boundsSchema keyOrder (hap-profiles/records/0.4.profile.json).
const BOUNDS_KEY_ORDER = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];

// The grant deliberately carries FULL read access. Every denial below is
// therefore attributable to the tool's declared governance, not to a stingy
// authorization — which is the whole point: authority alone does not grant a
// read; the tool must also declare how that read is governed.
const BOUNDS = {
  profile: PROFILE_ID,
  read_access: 'unlimited',
  write_daily_max: 5,
  delete_access: 'none',
  archive_access: 'none',
};

// records has no contextSchema → empty context.
const CONTEXT: Record<string, string> = {};
const CONTEXT_KEY_ORDER: string[] = [];

const GATE_CONTENT = {
  intent: 'E2E: read authorization — prove reads fail closed unless governance is declared and satisfied.',
};

// A bound name that exists in NO profile, so the grant cannot carry it. The
// gate must treat "absent" as blocked rather than as nothing-to-check.
const ABSENT_BOUND = 'read_export_access';

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; did: string; apiKey: string };
let personalGroupId: string;
let boundsHash: string;
let contextHash: string;
let authorizationId: string;
let mcpClient: Client;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Call a gated tool and report whether the gateway refused it. */
async function callRead(tool: string, args: Record<string, unknown> = {}) {
  const result = await mcpClient.callTool({ name: tool, arguments: args });
  const text = (result.content as Array<{ text?: string }> | undefined)
    ?.map((c) => c.text ?? '')
    .join('\n') ?? '';
  return { denied: result.isError === true, text };
}

// ══════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════

beforeAll(async () => {
  // Real MCP server, built from local source — never a mock.
  console.error('[READ E2E] Building local records MCP...');
  execSync('npm run build', { cwd: join(ROOT, 'hap-records-mcp'), stdio: 'pipe', timeout: 120_000 });

  pm.buildGateway();
  await pm.startSP(SP_PORT);

  const result = await sp.register('Read Authorization Test', `read-e2e-${Date.now()}@test.local`);
  user = { ...result.user, apiKey: result.apiKey };
  personalGroupId = await sp.getPersonalGroupId(user.apiKey);

  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: user.apiKey, profilesDir: PROFILES_DIR });
}, 240_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

// ══════════════════════════════════════════════════════════
// Setup
// ══════════════════════════════════════════════════════════

describe('Setup', () => {
  it('issues a records authorization with full read access', async () => {
    boundsHash = computeBoundsHash(BOUNDS, BOUNDS_KEY_ORDER);
    contextHash = computeContextHash(CONTEXT, CONTEXT_KEY_ORDER);

    const result = await sp.submitAttestation(user.apiKey, {
      profile_id: PROFILE_ID,
      group_id: personalGroupId,
      bounds: BOUNDS,
      bounds_hash: boundsHash,
      context_hash: contextHash,
      domain: 'owner',
      did: user.did,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent(GATE_CONTENT),
      execution_context_hash: hashExecutionContext({ write_count_daily: BOUNDS.write_daily_max }),
    });

    authorizationId = result.authorization_id;
    expect(authorizationId).toBeTruthy();
  });

  it('configures the gateway and pushes gate content', async () => {
    await gw.configure({ sessionCookie: 'read-e2e-test', apiKey: user.apiKey });
    await gw.pushGateContent({ authorizationId, boundsHash, contextHash, context: CONTEXT }, EXEC_PATH, GATE_CONTENT);
  });

  it('registers the real records MCP with four differently-gated read tools', async () => {
    const result = await gw.addIntegration({
      id: 'records',
      name: 'Records',
      command: 'node',
      args: [RECORDS_DIST],
      envKeys: {},
      profile: PROFILE_SHORT,
      enabled: true,
      toolGating: {
        default: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        overrides: {
          // Governed by a static gate the grant satisfies.
          list_records: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
          // Governance declared nowhere → ungoverned.
          get_record: { category: 'read' },
          // Governed, but demands a value the grant does not have.
          search_records: { category: 'read', boundField: 'read_access', requiredValue: 'none' },
          // Governed by a bound that exists in no profile → absent from the grant.
          export_records: { category: 'read', boundField: ABSENT_BOUND, requiredValue: 'allowed' },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.tools.some((t) => t.startsWith('records__'))).toBe(true);
    await sleep(1_000);
  });

  it('connects an MCP client', async () => {
    await sleep(3_000);
    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    mcpClient = new Client({ name: 'read-e2e-agent', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    const tools = await mcpClient.listTools();
    expect(tools.tools.some((t) => t.name.startsWith('records__'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// Enforcement
// ══════════════════════════════════════════════════════════

describe('Read authorization — fail closed', () => {
  it('PERMITS a read whose static gate the grant satisfies', async () => {
    const { denied, text } = await callRead('records__list_records');
    if (denied) console.error('[READ E2E] unexpected denial:', text);
    expect(denied).toBe(false);
  });

  it('DENIES a read tool that declares no governance at all (F9)', async () => {
    // Full read authority is granted; the tool still cannot be read, because
    // it never declared how reading it is governed. This is the property that
    // keeps a future connector from bypassing the model by omission.
    const { denied, text } = await callRead('records__get_record', { id: 'any-id' });
    console.error('[READ E2E] ungoverned read denial:', text.slice(0, 200));
    expect(denied).toBe(true);
  });

  it('DENIES a read whose gate demands a value the grant does not have', async () => {
    const { denied, text } = await callRead('records__search_records', { query: 'anything' });
    console.error('[READ E2E] value-mismatch denial:', text.slice(0, 200));
    expect(denied).toBe(true);
  });

  it('DENIES a read gated on a bound the grant does not carry (missing ⇒ blocked)', async () => {
    // The dangerous alternative is treating an unknown bound as "nothing to
    // enforce", which would turn every typo in a manifest into an open door.
    const { denied, text } = await callRead('records__export_records');
    console.error('[READ E2E] absent-bound denial:', text.slice(0, 200));
    expect(denied).toBe(true);
  });

  it('keeps denying the ungoverned read on repeat calls (no first-call-only gate)', async () => {
    const first = await callRead('records__get_record', { id: 'any-id' });
    const second = await callRead('records__get_record', { id: 'any-id' });
    expect(first.denied).toBe(true);
    expect(second.denied).toBe(true);
  });
});
