/**
 * Team approval + intent sharing (Phase 4a).
 *
 * Exercises the multi-party / above-cap authority flow end to end against the
 * real Authority Server — the scenarios the rest of the suite didn't cover:
 *
 *  1. A team admin sets a profile-config CAP + APPROVERS.
 *  2. A team member creates an authorization ABOVE the cap → it's accepted but
 *     flagged above_cap, and carries E2EE intent (ciphertext + per-approver keys).
 *  3. INTENT SHARING: an approver can fetch the encrypted intent; an outsider
 *     (not an approver) is denied.
 *  4. TEAM APPROVAL: when the member's action would exceed the bound, the
 *     receipt escalates to 409 approval_required (routed to the approvers)
 *     instead of a hard 403. A proposal is created, the approver approves it,
 *     and the proposal commits (a receipt is issued).
 *
 * Only the AS is needed (no gateway).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient, mintAuthorizationId } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeScopeHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AS_DIR } from '../src/helpers/as-dir.js';

// TR5/TR6 (suveren-as #86): cumulative team caps escalate from the first write
// over the cap. An AS checkout before it escalated only past the mandate's own
// bound. Detected from the AS source (same gate as team-roles-caps.test.ts).
const PROFILE_CONFIG_ROUTE = join(AS_DIR, 'src', 'app', 'api', 'groups', '[id]', 'profile-config', '[profileId]', 'route.ts');
const hasTeamRolesCaps =
  existsSync(PROFILE_CONFIG_ROUTE) && readFileSync(PROFILE_CONFIG_ROUTE, 'utf8').includes('grantors');

const SP_PORT = 15300;
const SP_URL = `http://localhost:${SP_PORT}`;
const PROFILE_ID = PROFILE_V07.customers;
const PROFILES_DIR = `${process.cwd()}/../hap-profiles`;

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

let adminKey = '';
let adminId = '';
let agentKey = '';
let agentId = '';
let agentDid = '';
let outsiderKey = '';
let groupId = '';
let authorizationId = '';

// Above the cap (write_daily_max cap is 1) so the authority is flagged above_cap.
const BOUNDS = {
  profile: PROFILE_ID, read_access: 'unlimited', export_access: 'none',
  write_daily_max: 2, delete_daily_max: 1, setup_daily_max: 0,
};
const INTENT = {
  intent_ciphertext: 'BASE64_CIPHERTEXT_e2e==',
  // encrypted_keys is keyed by approver userId — filled in once admin is registered.
  encrypted_keys: {} as Record<string, { ct: string; enc: string }>,
  approvers_frozen: [] as string[],
};

async function api(method: string, path: string, apiKey: string, body?: unknown) {
  const res = await fetch(`${SP_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

const writeReceipt = () =>
  sp.postTicket(agentKey, {
    authorizationId,
    profileId: PROFILE_ID,
    action: 'crm__create_contact',
    actionType: 'write',
    executionContext: { action_type: 'write' },
  });

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const admin = await sp.register('Team Admin', `admin-team-${Date.now()}@test.local`);
  adminKey = admin.apiKey;
  adminId = admin.user.id;

  const agent = await sp.register('Team Agent', `agent-team-${Date.now()}@test.local`);
  agentKey = agent.apiKey;
  agentId = agent.user.id;
  agentDid = agent.user.did;

  const outsider = await sp.register('Outsider', `outsider-team-${Date.now()}@test.local`);
  outsiderKey = outsider.apiKey;

  // Admin creates the team; agent joins.
  const grp = await sp.createGroup(adminKey, 'Approval Test Team');
  groupId = grp.group.id;
  await sp.joinGroup(agentKey, grp.inviteCode, adminKey);

  // Admin configures the profile: cap write_daily_max at 1, with the admin AND
  // the agent as approvers.
  //
  // The agent is in the list because in a team group the AS now refuses an
  // attest from anyone who is not a configured approver for that profile (403
  // OWNER_NOT_APPROVER) — membership alone is not authority to grant. The agent
  // runs the ceremony below, so it must be named here or the whole scenario
  // stops at its first request. Being allowed to GRANT is a separate question
  // from the cap: the cap still limits what may be granted without escalation,
  // which is what the rest of this file exercises.
  await sp.setProfileConfig(adminKey, groupId, PROFILE_ID, {
    approvers: [adminId, agentId],
    caps: { write_daily_max: 1 },
  });

  // The agent's authorization shares its intent with the admin (approver).
  INTENT.encrypted_keys = { [adminId]: { ct: 'CT_FOR_ADMIN==', enc: 'ENC_FOR_ADMIN==' } };
  INTENT.approvers_frozen = [adminId];
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

// ── 1. Above-cap attestation (accepted, flagged, with shared intent) ──────────

describe('Above-cap authorization with shared intent', () => {
  it('accepts an above-cap team authorization and flags it above_cap', async () => {
    const res = await api('POST', '/api/as/mandate', agentKey, {
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      profile_id: PROFILE_ID,
      profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR),
      group_id: groupId,
      bounds: BOUNDS,
      // bounds_hash omitted → AS computes it
      scope_hash: computeScopeHash({}, []),
      domain: agentId, // team: resolved domain is the member's userId
      did: agentDid,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: "Manage customer records on the team's behalf." }),
      execution_context_hash: hashExecutionContext({ action_type: 'write' }),
      ...INTENT,
    });

    expect(res.status).toBe(201);
    expect(res.body.above_cap).toBe(true);
    authorizationId = res.body.authorization_id as string;
    expect(authorizationId).toBeTruthy();
  });
});

// ── 2. Intent sharing (E2EE) ──────────────────────────────────────────────────

describe('Intent sharing', () => {
  it('lets an approver fetch the encrypted intent', async () => {
    const res = await api('GET', `/api/authorizations/${encodeURIComponent(authorizationId)}/intent`, adminKey);
    expect(res.status).toBe(200);
    // The approver receives the ciphertext + their own wrapped key.
    expect(JSON.stringify(res.body)).toContain('CT_FOR_ADMIN');
  });

  it('denies a non-approver outsider', async () => {
    const res = await api('GET', `/api/authorizations/${encodeURIComponent(authorizationId)}/intent`, outsiderKey);
    expect(res.status).toBe(403);
  });
});

// ── 2b. Intent-disclosure C2 binding (the AS rejects a tampered disclosure) ────

describe('Intent disclosure — C2 binding', () => {
  const attestWithIntent = (overrides: Record<string, unknown>) =>
    api('POST', '/api/as/mandate', agentKey, {
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      profile_id: PROFILE_ID,
      profile_hash: profileHashFor(PROFILE_ID, PROFILES_DIR),
      group_id: groupId,
      bounds: BOUNDS,
      scope_hash: computeScopeHash({}, []),
      domain: agentId,
      did: agentDid,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: "Manage customer records on the team's behalf." }),
      execution_context_hash: hashExecutionContext({ action_type: 'write' }),
      ...INTENT,
      ...overrides,
    });

  it('rejects an attestation whose intent_disclosure_hash does not match', async () => {
    const res = await attestWithIntent({ intent_disclosure_hash: 'sha256:deadbeef' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('intent_disclosure_hash');
  });

  it('rejects encrypted_keys carrying a recipient not in approvers_frozen', async () => {
    const res = await attestWithIntent({
      encrypted_keys: { ...INTENT.encrypted_keys, 'ghost-user': { ct: 'X==', enc: 'Y==' } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ghost-user');
  });
});

// ── 3. Team approval: escalate → approve → commit ─────────────────────────────

describe('Team approval (above-cap escalation)', () => {
  it('allows actions up to the bound, then escalates to approval_required', async () => {
    // The team's configured cap is write_daily_max: 1 (the mandate's OWN bound
    // is 2 — the outer, hard ceiling). TR5/TR6 (suveren-as PR #86) made the
    // above-cap check dispatch through checkBound itself, so this CUMULATIVE
    // team cap now actually governs starting from the second write — it did
    // not before (content/0.7/review.md's "emails per day" example: a
    // cumulative team cap used to be checked only per-transaction, so the
    // first two writes both cleared the per-transaction check and only the
    // THIRD write — exceeding the mandate's own bound of 2 — ever escalated).
    // First write stays within the team's cap (1).
    expect((await writeReceipt()).status).toBe(201);
    // Before TR5/TR6 the cumulative team cap was not checked, so the second
    // write still passed and only the third (past the mandate's own bound of
    // 2) escalated.
    if (!hasTeamRolesCaps) expect((await writeReceipt()).status).toBe(201);

    // Second write exceeds the CUMULATIVE team cap (1). Because the authority
    // is above-cap AND the profile has approvers, it escalates to 409 (not a
    // hard 403).
    const escalated = await writeReceipt();
    expect(escalated.status).toBe(409);
    const errors = escalated.body.errors as Array<Record<string, unknown>>;
    expect(errors[0].code).toBe('APPROVAL_REQUIRED');
    expect(errors[0].field).toBe('write_daily_max');
    // The escalation routes to EXACTLY the configured approver set — both
    // entries, in configured order. (It was [adminId] before the agent had to
    // be a configured approver in order to grant at all.)
    expect(errors[0].approvers).toEqual([adminId, agentId]);
  });

  it('routes a proposal to the approver, who approves it → committed', async () => {
    // The gateway would create this on the 409; we create it directly.
    const created = await api('POST', '/api/proposals', agentKey, {
      authorization_id: authorizationId,
      profile_id: PROFILE_ID,
      tool: 'crm__create_contact',
      tool_args: { name: 'Escalated Contact' },
      execution_context: { action_type: 'write' },
      pending_approvers: [adminId],
    });
    expect(created.status).toBe(201);
    const proposalId = (created.body.proposal as { id: string }).id;
    expect(proposalId).toBeTruthy();

    // The approver approves; with the only approver signed off, it commits.
    const approved = await api('POST', `/api/proposals/${proposalId}/approve`, adminKey);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('committed');
  });

  it('does not let a non-approver approve', async () => {
    const created = await api('POST', '/api/proposals', agentKey, {
      authorization_id: authorizationId,
      profile_id: PROFILE_ID,
      tool: 'crm__create_contact',
      tool_args: { name: 'Another Contact' },
      execution_context: { action_type: 'write' },
      pending_approvers: [adminId],
    });
    const proposalId = (created.body.proposal as { id: string }).id;

    const res = await api('POST', `/api/proposals/${proposalId}/approve`, outsiderKey);
    expect(res.status).not.toBe(200);
  });
});
