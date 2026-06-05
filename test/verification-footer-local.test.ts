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

const FOOTER_MARKER = '— Sent by an AI agent via Suveren';
const RECEIPT_LINK = /\/r\/([0-9a-fA-F-]{36})/;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);
const gw = new GatewayClient(GW_URL);

let user: { id: string; name: string; email: string; did: string; apiKey: string };
let personalGroupId: string;
let boundsHash: string;
let contextHash: string;
let frameHash: string;
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
    frameHash = result.frame_hash;
    expect(frameHash).toBeTruthy();
  });

  it('configures the gateway and pushes gate content', async () => {
    await gw.configure({ sessionCookie: 'footer-local-test', apiKey: user.apiKey });
    await gw.pushGateContent({ frameHash, boundsHash, contextHash, context: CONTEXT }, EXEC_PATH, GATE_CONTENT);
  });

  it('adds the LOCAL records integration gated under publish', async () => {
    const result = await gw.addIntegration({
      id: 'records',
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
          get_record: { category: 'read' },
          list_records: { category: 'read' },
          search_records: { category: 'read' },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.tools.some((t) => t.startsWith('records__'))).toBe(true);
    await sleep(1_000);
  });

  it('connects the MCP client', async () => {
    await sleep(3_000);
    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    const client = new Client({ name: 'hap-footer-local-e2e', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    mcpClient = client;
    const { tools } = await client.listTools();
    expect(tools.filter((t) => t.name.startsWith('records__')).length).toBeGreaterThan(0);
  });
});

describe('Footer — end to end', () => {
  let recordId: string;
  let receiptId: string;

  it('a gated write under a Category-A profile gets the verification footer in its content', async () => {
    const result = await mcpClient.callTool({
      name: 'records__create_record',
      arguments: { type: 'note', title: 'Launch announcement', content: 'We shipped Level 2 content binding today.' },
    });
    if (result.isError) {
      console.error('[Footer-local E2E] error:', (result.content as Array<{ text?: string }>)[0]?.text);
    }
    expect(result.isError).not.toBe(true);

    const record = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    recordId = record.id;
    expect(record.content).toContain(FOOTER_MARKER);

    const match = RECEIPT_LINK.exec(record.content as string);
    expect(match).not.toBeNull();
    receiptId = match![1];
  });

  it('the footer survives storage (read-back shows the same footer + link)', async () => {
    const result = await mcpClient.callTool({ name: 'records__get_record', arguments: { id: recordId } });
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
