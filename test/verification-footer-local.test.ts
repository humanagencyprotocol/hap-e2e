/**
 * Verification footer — happy-path E2E WITHOUT Gmail credentials.
 *
 * The footer is integration-agnostic: the gateway injects it into any Category-A
 * (communicative) profile's content field, regardless of which MCP server backs
 * the tool. Every *real* Category-A integration (gmail, calendar, linkedin)
 * needs OAuth — which is why verification-footer.test.ts auto-skips in CI. This
 * test exercises the SAME gateway footer code with NO credentials by gating the
 * local records MCP's `create_record` under the `publish` profile: the gateway
 * appends the footer to the record's `content`, the store persists it, and we
 * read it back and verify the embedded /r/<id> receipt on the AS.
 *
 * It is a deliberately synthetic wiring (records-as-publish-target) — the point
 * is the footer + receipt loop, which is identical to the real email/post path.
 * The Gmail test remains the product-path test; this is its creds-free sibling.
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

const SP_PORT = 17130;
const GW_PORT = 17062;
const SP_URL = `http://localhost:${SP_PORT}`;
const GW_URL = `http://localhost:${GW_PORT}`;

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/publish@0.4';
const PROFILE_SHORT = 'publish';
const EXEC_PATH = PROFILE_ID;

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILES_DIR = join(ROOT, 'hap-profiles');
const RECORDS_DIST = join(ROOT, 'hap-records-mcp', 'dist', 'index.js');

const BOUNDS_KEY_ORDER = ['profile', 'post_daily_max', 'post_monthly_max'];
const BOUNDS = { profile: PROFILE_ID, post_daily_max: 10, post_monthly_max: 50 };

const CONTEXT_KEY_ORDER = ['allowed_platforms', 'content_type', 'audience'];
const CONTEXT = { allowed_platforms: 'linkedin', content_type: 'text', audience: 'public' };

const GATE_CONTENT = { intent: 'E2E: verification-footer (creds-free) — bounded public publishing.' };

// Publish profile → verb "Published"; ASCII "--" separator (mojibake-immune);
// "Receipt:" label — the receipt is the precondition proof, not a "Verify" CTA.
const FOOTER_MARKER = '-- Published by an AI agent via Suveren. Receipt:';
// Constant second line promoting the protocol — present on every footer.
// Footer v1.1 wording (suveren-gateway e56555b shortened it). Source of truth:
// apps/mcp-server/src/lib/receipt-footer.ts — keep this in step with it.
const HAP_LINE = '-- Suveren implements HAP, the open Human Agency Protocol: https://www.humanagencyprotocol.org/';
const RECEIPT_LINK = /\/r\/([0-9a-fA-F-]{36})/;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; name: string; email: string; did: string; apiKey: string };
let personalGroupId: string;
let boundsHash: string;
let contextHash: string;
let authorizationId: string;
let mcpClient: Client;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  execSync('npm run build', { cwd: join(ROOT, 'hap-records-mcp'), stdio: 'pipe', timeout: 120_000 });
  pm.buildGateway();
  await pm.startSP(SP_PORT);
  const result = await sp.register('Footer Local Test', `footer-local-${Date.now()}@test.local`);
  user = { ...result.user, apiKey: result.apiKey };
  personalGroupId = await sp.getPersonalGroupId(user.apiKey);
  await pm.startGateway({ port: GW_PORT, spUrl: SP_URL, spApiKey: user.apiKey, profilesDir: PROFILES_DIR });
}, 240_000);

afterAll(async () => {
  if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  await pm.killAll();
}, 30_000);

describe('Setup', () => {
  it('submits an automatic-mode publish attestation', async () => {
    const gateContentHashes = hashGateContent(GATE_CONTENT);
    const executionContextHash = hashExecutionContext({
      allowed_platforms: 'linkedin', content_type: 'text', audience: 'public',
      post_count_daily: BOUNDS.post_daily_max, post_count_monthly: BOUNDS.post_monthly_max,
    });
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
      gate_content_hashes: gateContentHashes,
      execution_context_hash: executionContextHash,
    });
    authorizationId = result.authorization_id;
    expect(authorizationId).toBeTruthy();
  });

  it('configures the gateway and pushes gate content', async () => {
    await gw.configure({ sessionCookie: 'footer-local-test', apiKey: user.apiKey });
    await gw.pushGateContent({ authorizationId, boundsHash, contextHash, context: CONTEXT }, EXEC_PATH, GATE_CONTENT);
  });

  it('adds the LOCAL records integration gated under publish', async () => {
    const result = await gw.addIntegration({
      id: 'recordspublish',
      name: 'Records',
      command: 'node',
      args: [RECORDS_DIST],
      envKeys: {},
      profile: PROFILE_SHORT,
      enabled: true,
      toolGating: {
        default: { executionMapping: {}, staticExecution: { allowed_platforms: 'linkedin', content_type: 'text', audience: 'public', action_type: 'post' } },
        overrides: {
          create_record: { executionMapping: {}, staticExecution: { allowed_platforms: 'linkedin', content_type: 'text', audience: 'public', action_type: 'post' } },
          // Read tools must declare governance (F9) or they are denied. The
          // publish profile has no read model — the records store is only a
          // sink here, read back to prove the footer survived storage — so an
          // explicit, reasoned exemption is the honest declaration rather than
          // inventing a bound this profile does not define.
          get_record: {
            category: 'read',
            readGovernance: 'none',
            readGovernanceReason:
              'Test harness reads back its own just-written record to verify the footer persisted. The publish profile defines no read bounds; nothing user-owned is exposed.',
          },
          list_records: {
            category: 'read',
            readGovernance: 'none',
            readGovernanceReason: 'As get_record — harness read-back only, under a profile with no read model.',
          },
          search_records: {
            category: 'read',
            readGovernance: 'none',
            readGovernanceReason: 'As get_record — harness read-back only, under a profile with no read model.',
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.tools.some((t) => t.startsWith('recordspublish__'))).toBe(true);
    await sleep(1_000);
  });

  it('connects the MCP client', async () => {
    await sleep(3_000);
    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    const client = new Client({ name: 'hap-footer-local-e2e', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    mcpClient = client;
    const { tools } = await client.listTools();
    expect(tools.filter((t) => t.name.startsWith('recordspublish__')).length).toBeGreaterThan(0);
  });
});

describe('Footer — end to end', () => {
  let recordId: string;
  let receiptId: string;

  it('a gated write under a Category-A profile gets the verification footer in its content', async () => {
    const result = await mcpClient.callTool({
      name: 'recordspublish__create_record',
      arguments: { type: 'note', title: 'Launch announcement', content: 'We shipped Level 2 content binding today.' },
    });
    if (result.isError) {
      console.error('[Footer-local E2E] error:', (result.content as Array<{ text?: string }>)[0]?.text);
    }
    expect(result.isError).not.toBe(true);

    const record = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    recordId = record.id;
    expect(record.content).toContain(FOOTER_MARKER);
    expect(record.content).toContain(HAP_LINE);

    const match = RECEIPT_LINK.exec(record.content as string);
    expect(match).not.toBeNull();
    receiptId = match![1];
  });

  it('the footer survives storage (read-back shows the same footer + link)', async () => {
    const result = await mcpClient.callTool({ name: 'recordspublish__get_record', arguments: { id: recordId } });
    expect(result.isError).not.toBe(true);
    const record = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(record.content).toContain(FOOTER_MARKER);
    expect(record.content).toContain(`/r/${receiptId}`);
  });

  it('the embedded receipt verifies on the AS (signatureValid)', async () => {
    const res = await fetch(`${SP_URL}/api/as/public-receipt/${receiptId}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { signatureValid: boolean; profileId: string };
    expect(view.signatureValid).toBe(true);
    expect(view.profileId).toMatch(/publish/);
  });
});
