/**
 * v0.7 wire switch — the hard-switch behaviours the plan calls out by name
 * (suveren-as/docs/v07-wire-plan.md, "Phase 4 — hap-e2e"):
 *
 *   - POST /api/as/receipt answers 410 (the gateway too old — update story).
 *   - A mandate request naming only pre-0.7 supported_versions is refused
 *     with VERSION_UNSUPPORTED (the "re-approve this mandate" path).
 *   - A revoked authorization cannot be renewed — revocation is permanent.
 *   - A profile whose appliesTo names an action type outside its own
 *     actionTypes registry is refused at mandate time (PROFILE_INVALID).
 *   - A custody archive entry — the Gatekeeper's own durable copy of a
 *     complete signed ticket (receipt-archive.ts) — verifies OFFLINE with
 *     its stored issuer key, using hap-core's verifyTicketSignature exactly
 *     the way any third-party holder would, not this AS's own shortcuts.
 *
 * The last one is the real end-to-end proof of the central invariant on the
 * custody side: mandate ceremony -> AS issues a mandate -> a real gated tool
 * call through the real gateway -> AS issues a ticket -> the records
 * connector executes -> the gateway's own ticket archive holds the entry,
 * and it verifies with nothing but the issuer key it stored at archive time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { verifyTicketSignature, type TicketPayload } from '@humanagencyp/hap-core';

import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient } from '../src/helpers/sp-client.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import {
  ROOT, RECORDS_DIST, RECORDS_INTEGRATION, grantRecordsMandate,
} from '../src/helpers/gateway-stack.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';
import { computeBoundsHash, computeScopeHash, hashGateContent, hashExecutionContext } from '../src/helpers/crypto.js';
// Gateway-internal: the same ReceiptArchive class and hex->did:key helper the
// real gateway process uses — reading the SAME on-disk file a real tool call
// just wrote, from this test process, is exactly how an operator's own
// export tooling would read it.
import { ReceiptArchive } from '../../suveren-gateway/apps/mcp-server/src/lib/receipt-archive.ts';
import { issuerFromPublicKeyHex } from '../../suveren-gateway/apps/mcp-server/src/lib/issuer-from-hex.ts';

const PROFILES_DIR = join(ROOT, 'hap-profiles');

describe('POST /api/as/receipt is retired (v0.7 hard switch)', () => {
  const pm = new ProcessManager();
  let sp: SPClient;
  const PORT = 18910;

  beforeAll(async () => {
    await pm.startSP(PORT);
    sp = new SPClient(`http://localhost:${PORT}`);
  }, 60_000);

  afterAll(async () => { await pm.killAll(); });

  it('answers 410 with code VERSION_UNSUPPORTED and names the replacement path', async () => {
    const user = await sp.register('Retired Receipt', `retired-receipt-${Date.now()}@test.local`);
    const r = await sp.postReceiptRetired(user.apiKey, { authorizationId: 'authz_00000000-0000-0000-0000-000000000000', profileId: 'x', action: 'x', actionType: 'x' });
    expect(r.status).toBe(410);
    expect((r.body.errors as Array<{ code: string }>)?.[0]?.code).toBe('VERSION_UNSUPPORTED');
    expect(JSON.stringify(r.body)).toContain('/api/as/ticket');
  });
});

describe('A pre-0.7 mandate request is refused with VERSION_UNSUPPORTED', () => {
  const pm = new ProcessManager();
  let sp: SPClient;
  const PORT = 18911;

  beforeAll(async () => {
    await pm.startSP(PORT);
    sp = new SPClient(`http://localhost:${PORT}`);
  }, 60_000);

  afterAll(async () => { await pm.killAll(); });

  it('a gateway offering only ["0.6"] is told to re-approve, not signed a mandate', async () => {
    const user = await sp.register('Old Gateway', `old-gateway-${Date.now()}@test.local`);
    const groupId = await sp.getPersonalGroupId(user.apiKey);
    const profile = PROFILE_V07.records;
    const r = await sp.submitMandateRaw(user.apiKey, {
      supported_versions: ['0.6'],
      profile_id: profile,
      profile_hash: profileHashFor(profile, PROFILES_DIR),
      group_id: groupId,
      bounds: { profile, read_access: 'unlimited', write_daily_max: 5, delete_access: 'none', archive_access: 'none' },
      bounds_hash: computeBoundsHash(
        { profile, read_access: 'unlimited', write_daily_max: 5, delete_access: 'none', archive_access: 'none' },
        ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'],
      ),
      scope_hash: computeScopeHash({}, []),
      domain: 'owner',
      did: user.user.did,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: 'pre-0.7 gateway e2e' }),
      execution_context_hash: hashExecutionContext({ profile, domain: 'owner' }),
    });
    expect(r.status).toBe(426);
    expect(r.body.errors as unknown).toBeTruthy();
    expect((r.body.errors as Array<{ code: string }>)[0].code).toBe('VERSION_UNSUPPORTED');
    expect(JSON.stringify(r.body).toLowerCase()).toMatch(/re-approve|update the gateway/);
  });
});

describe('A revoked authorization cannot be renewed', () => {
  const pm = new ProcessManager();
  let sp: SPClient;
  const PORT = 18912;

  beforeAll(async () => {
    await pm.startSP(PORT);
    sp = new SPClient(`http://localhost:${PORT}`);
  }, 60_000);

  afterAll(async () => { await pm.killAll(); });

  it('revocation is permanent — a renew attempt on a revoked grant is refused AUTHZ_REVOKED, never a fresh mandate', async () => {
    const user = await sp.register('Revoke Renew', `revoke-renew-${Date.now()}@test.local`);
    const groupId = await sp.getPersonalGroupId(user.apiKey);
    const profile = PROFILE_V07.records;
    const bounds = { profile, read_access: 'unlimited', write_daily_max: 5, delete_access: 'none', archive_access: 'none' };
    const boundsKeyOrder = ['profile', 'read_access', 'write_daily_max', 'delete_access', 'archive_access'];
    const body = {
      profile_id: profile,
      profile_hash: profileHashFor(profile, PROFILES_DIR),
      group_id: groupId,
      bounds,
      bounds_hash: computeBoundsHash(bounds, boundsKeyOrder),
      scope_hash: computeScopeHash({}, []),
      domain: 'owner',
      did: user.user.did,
      commitment_mode: 'automatic' as const,
      gate_content_hashes: hashGateContent({ intent: 'revoke-then-renew e2e' }),
      execution_context_hash: hashExecutionContext({ profile, domain: 'owner' }),
    };
    const att = await sp.submitMandate(user.apiKey, body);

    await sp.revokeAuthorization(user.apiKey, att.authorization_id, 'e2e: revoke then attempt renew');

    const renewed = await sp.submitMandateRaw(user.apiKey, { ...body, authorization_id: att.authorization_id, renew: true });
    expect(renewed.status).toBe(409);
    expect((renewed.body.errors as Array<{ code: string }>)[0].code).toBe('AUTHZ_REVOKED');

    // Not just refused — genuinely never renewed: the AS's own record of
    // this authorization must still show it revoked afterward.
    const status = await sp.getAuthorizationStatus(user.apiKey, att.authorization_id);
    expect(JSON.stringify(status.body).toLowerCase()).toContain('revoked');
  });
});

describe('A profile whose appliesTo names an unregistered action type is refused at mandate time', () => {
  const pm = new ProcessManager();
  let sp: SPClient;
  const PORT = 18913;

  beforeAll(async () => {
    await pm.startSP(PORT);
    sp = new SPClient(`http://localhost:${PORT}`);
  }, 60_000);

  afterAll(async () => { await pm.killAll(); });

  it('PROFILE_INVALID — appliesTo names an action type outside boundsSchema.actionTypes', async () => {
    const user = await sp.register('Bad AppliesTo', `bad-appliesto-${Date.now()}@test.local`);

    const badProfile = {
      id: 'e2e-bad-appliesto',
      name: 'E2E bad appliesTo fixture',
      version: '1.0',
      description: 'Throwaway community profile: appliesTo names an action type the registry does not declare.',
      boundsSchema: {
        // "write" is the only registered action type; the bound below
        // claims to apply to "delete" too, which is NOT in this list.
        actionTypes: ['write'],
        keyOrder: ['profile', 'write_daily_max'],
        fields: {
          profile: { type: 'string', required: true },
          write_daily_max: {
            type: 'number',
            required: true,
            displayName: 'Daily write limit',
            description: 'E2E fixture bound.',
            boundType: { kind: 'cumulative_count', window: 'daily' },
            appliesTo: ['write', 'delete'],
          },
        },
      },
      executionContextSchema: { fields: {} },
      requiredGates: ['intent'],
      ttl: { default: 3600, max: 86400 },
    };

    // The AS validates a community profile's shape at AUTHORING time (POST
    // /api/profiles), before it could ever be resolved for a mandate —
    // createProfile() throws on a non-2xx; assert on the refusal itself.
    let error: Error | undefined;
    try {
      await sp.createProfile(user.apiKey, badProfile);
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'a profile whose appliesTo names an unregistered action type must be refused').toBeDefined();
    expect(error!.message).toMatch(/PROFILE_INVALID/);
    expect(error!.message).toContain('appliesTo');
    expect(error!.message).toContain('delete');
    expect(error!.message).toContain('actionTypes');
  });
});

describe('A custody archive entry verifies offline with its stored issuer key', () => {
  const pm = new ProcessManager();
  let sp: SPClient;
  let mcpInternal: GatewayClient;
  let agent: Client;
  const SP_PORT = 18920;
  const MCP_PORT = 18922;
  const dataDir = pm.getDataDir();

  async function createRecord(title: string) {
    return agent.callTool({ name: 'records__create_record', arguments: { type: 'note', title, content: 'custody archive e2e' } });
  }

  beforeAll(async () => {
    if (!existsSync(RECORDS_DIST)) {
      execSync('npm run build', { cwd: join(ROOT, 'hap-records-mcp'), stdio: 'pipe', timeout: 120_000 });
    }
    pm.buildGateway();
    await pm.startSP(SP_PORT);
    sp = new SPClient(`http://localhost:${SP_PORT}`);

    const user = await sp.register('Custody Archive', `custody-archive-${Date.now()}@test.local`);
    const groupId = await sp.getPersonalGroupId(user.apiKey);

    await pm.startGateway({ port: MCP_PORT, spUrl: `http://localhost:${SP_PORT}`, spApiKey: user.apiKey, profilesDir: PROFILES_DIR });
    mcpInternal = new GatewayClient(`http://localhost:${MCP_PORT}`);
    // No control-plane pairing in this test -- same direct-configure pattern
    // as-outage-fail-closed.test.ts uses. No vault key is ever pushed, so the
    // receipt archive stays plaintext on disk and this test can read it
    // directly, exactly as an operator's own offline export tooling would.
    await mcpInternal.configure({ sessionCookie: `api-key=${user.apiKey}`, apiKey: user.apiKey });

    const grantResult = await grantRecordsMandate(sp, {
      apiKey: user.apiKey, did: user.user.did, intent: 'custody archive e2e', mode: 'automatic', groupId,
    });

    await mcpInternal.pushGateContent(
      { authorizationId: grantResult.authorizationId, boundsHash: grantResult.boundsHash, contextHash: grantResult.scopeHash, context: {} },
      PROFILE_V07.records,
      grantResult.gateContent,
    );
    await mcpInternal.addIntegration(RECORDS_INTEGRATION);
    await mcpInternal.waitForIntegration('records');

    agent = new Client({ name: 'custody-archive-e2e', version: '0.1.0' }, { capabilities: {} });
    await agent.connect(new SSEClientTransport(new URL(`http://localhost:${MCP_PORT}/sse`)));
  }, 180_000);

  afterAll(async () => {
    if (agent) { try { await agent.close(); } catch { /* ignore */ } }
    await pm.killAll();
  }, 30_000);

  it('a real gated write archives a complete, independently-verifiable ticket', async () => {
    const result = await createRecord('custody-archive-proof');
    expect(result.isError).toBeFalsy();

    // Read the SAME on-disk archive a real export/report tool would — a
    // fresh ReceiptArchive instance over the gateway's own data dir, from
    // this test process, with no cooperation from either server.
    const archive = new ReceiptArchive(dataDir);
    expect(archive.isLocked()).toBe(false); // no vault key was ever set this run -> plaintext
    const entries = archive.getReceipts();
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[entries.length - 1];

    expect(typeof entry.asPublicKey).toBe('string');
    expect(entry.asPublicKey.length).toBeGreaterThan(0);

    const issuer = issuerFromPublicKeyHex(entry.asPublicKey);
    // Exactly what a third-party holder does (protocol.md -> Ticket
    // Verification): canonicalize minus signature, verify against the
    // issuer's key -- no AS cooperation, no AS-side field-stripping helper.
    await expect(
      verifyTicketSignature(entry.receipt as unknown as TicketPayload, { trustedIssuers: [issuer] }),
    ).resolves.toBeUndefined();
    expect((entry.receipt as Record<string, unknown>).issuer).toBe(issuer);
  }, 60_000);
});
