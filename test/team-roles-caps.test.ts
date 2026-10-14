/**
 * Team permissions, above-cap approval, read limits (TR5/TR6) — end to end
 * against the real Authority Server.
 *
 * Direction: content/0.7/review.md — "Group roles: who may grant, who
 * approves above the cap" and "A group can cap reads and capability
 * switches" (hap-protocol #14). Implementation: suveren-as draft PR #86
 * (branch feat/team-roles-caps). Written from the DECISIONS (Andreas,
 * 2026-10-14), not from the PR's own code or its unit test
 * (team-roles-caps.test.ts in the suveren-as repo) — this file calls the
 * real running AS over HTTP exactly as a gateway or another conformant
 * client would, the same style as the existing team-approval.test.ts.
 *
 * Three real users (never mocked): a GRANTOR who is the team's sole
 * grantor and never an approver, and two APPROVERS who are never
 * grantors — the minimum shape the task brief asks for. A grantor who is
 * also one of the two approvers is used separately (Profile B below) to
 * exercise the proposer-exclusion rule, which only bites when the overlap
 * exists.
 *
 * What is covered, mapped to the decisions:
 *   1. A grantor who is not an approver can sign; an approver who is not a
 *      grantor cannot (403 OWNER_NOT_APPROVER — wire code unchanged).
 *   2. Hard caps refuse signing: a numeric cap, an enum (capability-switch)
 *      cap — pinning the real, permissive-first `values` order — and an
 *      omitted gatekeeper-enforced (`enforcedBy: "gatekeeper"`) capped
 *      field, which refuses rather than silently filling a default.
 *   3. With NO approvers configured, an 'approval'-kind cap is still
 *      enforced as hard.
 *   4. An approval-kind cap promotes an 'automatic' request to a signed
 *      'review_above_cap' mandate.
 *   5. At ticket time, a CUMULATIVE bound (send_daily_max / write_daily_max
 *      — "emails per day") triggers APPROVAL_REQUIRED, not just a
 *      per-transaction one.
 *   6. A proposal commits only after the configured number of DISTINCT
 *      approvals (N-of-M, tested at N=2 with two different approvers).
 *   7. The proposer's own approval is refused (APPROVER_IS_PROPOSER) and
 *      never counts, even when the proposer is also a configured approver.
 *   8. An approver set that cannot reach the required count without the
 *      proposer refuses the TICKET outright (APPROVAL_IMPOSSIBLE) — no
 *      proposal is ever created.
 *   9. Personal mode, and the pre-existing owner-chosen review_above_cap
 *      (no team governance at all), are untouched — the published v0.7
 *      conformance vector keeps passing.
 *  10. A migrated (pre-TR5) team config — `approvers` only, no `grantors`,
 *      no `approvals` — keeps granting and defaults `approvals` to 1.
 *
 * Only the AS is needed for all of the above (no gateway, no MCP
 * connector) — the same scope as team-approval.test.ts, and the scope the
 * README's "Which layer to put a test in" calls for: the subject under
 * test (grantor/approver roles, cap kinds, N-of-M approval) lives entirely
 * at the Authority Server's HTTP surface, which is reachable directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager } from '../src/helpers/process-manager.js';
import { SPClient, mintAuthorizationId } from '../src/helpers/sp-client.js';
import { hashGateContent, hashExecutionContext, computeScopeHash } from '../src/helpers/crypto.js';
import { PROFILE_V07, profileHashFor } from '../src/helpers/profiles.js';
import { AS_DIR } from '../src/helpers/as-dir.js';

// ── Feature gate: skip only when this AS checkout lacks TR5/TR6 ────────────
// Mirrors ws-account-one-workspace.test.ts's gate (a known route file must
// exist AND mention the new concept) so CI shows a loud skip, never a
// silent false pass, against an AS checkout that predates PR #86.
const PROFILE_CONFIG_ROUTE = join(AS_DIR, 'src', 'app', 'api', 'groups', '[id]', 'profile-config', '[profileId]', 'route.ts');
const hasTeamRolesCaps =
  existsSync(PROFILE_CONFIG_ROUTE) && readFileSync(PROFILE_CONFIG_ROUTE, 'utf8').includes('grantors');

const SP_PORT = 19210; // unused in the suite as of 2026-10-14 (max assigned elsewhere: 18951)
const SP_URL = `http://localhost:${SP_PORT}`;
const PROFILES_DIR = join(process.cwd(), '..', 'hap-profiles');

const EMAIL_ID = PROFILE_V07.email; // email@0.8 — hard enum + hard gatekeeper + approval cumulative
const CUSTOMERS_ID = PROFILE_V07.customers; // customers@0.9 — proposer-overlap + legacy-config
const RECORDS_ID = PROFILE_V07.records; // records@0.6 — no-approvers-hard + impossible-set + personal mode

const pm = new ProcessManager();
const sp = new SPClient(SP_URL);

async function api(method: string, path: string, apiKey: string, body?: unknown) {
  const res = await fetch(`${SP_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as Record<string, unknown> };
}

const putProfileConfig = (
  apiKey: string,
  groupId: string,
  profileId: string,
  config: {
    approvers: string[];
    grantors?: 'all' | string[];
    approvals?: number;
    caps?: Record<string, number | string | { value: number | string; kind: 'hard' | 'approval' }>;
  },
) => api('PUT', `/api/groups/${groupId}/profile-config/${encodeURIComponent(profileId)}`, apiKey, config);

interface User { id: string; did: string; apiKey: string }

let grantor: User;
let approverA: User;
let approverB: User;
let soloOwner: User; // never joins any team — "account is Personal or in one team" (WS0)
                      // means the personal-mode scenario needs its OWN user, not the grantor
let teamGroupId: string; // every team scenario lives here, on a DIFFERENT profile each —
                          // config is keyed per (group, profile), so this is enough isolation

beforeAll(async () => {
  await pm.startSP(SP_PORT);

  const g = await sp.register('Grantor Only', `grantor-tr5-${Date.now()}@test.local`);
  grantor = { id: g.user.id, did: g.user.did, apiKey: g.apiKey };
  const a = await sp.register('Approver A', `approver-a-tr5-${Date.now()}@test.local`);
  approverA = { id: a.user.id, did: a.user.did, apiKey: a.apiKey };
  const b = await sp.register('Approver B', `approver-b-tr5-${Date.now()}@test.local`);
  approverB = { id: b.user.id, did: b.user.did, apiKey: b.apiKey };
  const s = await sp.register('Solo Owner', `solo-owner-tr5-${Date.now()}@test.local`);
  soloOwner = { id: s.user.id, did: s.user.did, apiKey: s.apiKey };

  const team = await sp.createGroup(grantor.apiKey, `TR5 Team ${Date.now()}`);
  teamGroupId = team.group.id;
  await sp.joinGroup(approverA.apiKey, team.inviteCode, grantor.apiKey);
  await sp.joinGroup(approverB.apiKey, team.inviteCode, grantor.apiKey);
}, 60_000);

afterAll(async () => {
  await pm.killAll();
}, 30_000);

// ── 1. Grantors vs approvers, hard caps (email@0.8) ─────────────────────────

describe.skipIf(!hasTeamRolesCaps)('Grantor/approver roles + hard caps (email@0.8)', () => {
  const EMAIL_BASE = {
    profile_id: EMAIL_ID,
    profile_hash: profileHashFor(EMAIL_ID, PROFILES_DIR),
    group_id: '', // filled per call
    domain: 'ignored-for-teams',
    scope_hash: computeScopeHash({}, []),
    commitment_mode: 'automatic' as const,
    gate_content_hashes: hashGateContent({ intent: 'Send email on the team\'s behalf.' }),
    execution_context_hash: hashExecutionContext({ action_type: 'send' }),
  };

  beforeAll(async () => {
    const res = await putProfileConfig(grantor.apiKey, teamGroupId, EMAIL_ID, {
      approvers: [approverA.id, approverB.id],
      grantors: [grantor.id],
      approvals: 2,
      caps: {
        read_access: { value: 'none', kind: 'hard' },
        read_max_age_days: { value: 30, kind: 'approval' }, // gatekeeper-enforced → always hard regardless
        send_daily_max: { value: 2, kind: 'approval' },
      },
    });
    expect(res.status).toBe(200);
  });

  it('an approver who is NOT a grantor cannot sign (403 OWNER_NOT_APPROVER)', async () => {
    const res = await api('POST', '/api/as/mandate', approverA.apiKey, {
      ...EMAIL_BASE,
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      group_id: teamGroupId,
      did: approverA.did,
      bounds: { profile: EMAIL_ID, read_access: 'none', read_max_age_days: 30, send_daily_max: 1, setup_daily_max: 0 },
    });
    expect(res.status).toBe(403);
    expect((res.body.errors as Array<Record<string, unknown>>)[0].code).toBe('OWNER_NOT_APPROVER');
  });

  it('a hard enum cap refuses a more permissive requested value (422 cap_exceeded) — real permissive-first values order', async () => {
    const res = await api('POST', '/api/as/mandate', grantor.apiKey, {
      ...EMAIL_BASE,
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      group_id: teamGroupId,
      did: grantor.did,
      bounds: { profile: EMAIL_ID, read_access: 'unlimited', read_max_age_days: 30, send_daily_max: 1, setup_daily_max: 0 },
    });
    expect(res.status).toBe(422);
    expect((res.body.errors as Array<Record<string, unknown>>)[0].code).toBe('cap_exceeded');
  });

  it('an omitted gatekeeper-enforced capped field refuses signing rather than filling a default (422 cap_exceeded)', async () => {
    const res = await api('POST', '/api/as/mandate', grantor.apiKey, {
      ...EMAIL_BASE,
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      group_id: teamGroupId,
      did: grantor.did,
      bounds: { profile: EMAIL_ID, read_access: 'none', send_daily_max: 1, setup_daily_max: 0 }, // read_max_age_days omitted
    });
    expect(res.status).toBe(422);
    const err = (res.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('cap_exceeded');
    expect(err.field).toBe('read_max_age_days');
  });

  let authorizationIdA = '';

  it('a grantor who is not an approver CAN sign; an approval-kind cap promotes automatic → signed review_above_cap', async () => {
    const res = await api('POST', '/api/as/mandate', grantor.apiKey, {
      ...EMAIL_BASE,
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      group_id: teamGroupId,
      did: grantor.did,
      bounds: { profile: EMAIL_ID, read_access: 'none', read_max_age_days: 30, send_daily_max: 5, setup_daily_max: 0 },
    });
    expect(res.status).toBe(201);
    expect(res.body.above_cap).toBe(true);
    expect(res.body.commitment_mode).toBe('review_above_cap');
    authorizationIdA = res.body.authorization_id as string;
    expect(authorizationIdA).toBeTruthy();
  });

  // ── 2. Ticket escalation (cumulative) + N-of-2 approval ──────────────────

  describe('ticket escalation + N-of-2 distinct approvals', () => {
    const sendTicket = () =>
      sp.postTicket(grantor.apiKey, {
        authorizationId: authorizationIdA,
        profileId: EMAIL_ID,
        action: 'gmail__send_message',
        actionType: 'send',
        executionContext: { action_type: 'send' },
      });

    it('stays within the team cap (2/day) for the first two sends', async () => {
      expect(authorizationIdA).toBeTruthy();
      expect((await sendTicket()).status).toBe(201);
      expect((await sendTicket()).status).toBe(201);
    });

    let proposalId = '';

    it('the third send exceeds the CUMULATIVE team cap → 409 APPROVAL_REQUIRED (not just a per-transaction bound)', async () => {
      const res = await sendTicket();
      expect(res.status).toBe(409);
      const err = (res.body.errors as Array<Record<string, unknown>>)[0];
      expect(err.code).toBe('APPROVAL_REQUIRED');
      expect(err.field).toBe('send_daily_max');
      expect(err.approvers).toEqual([approverA.id, approverB.id]);
    });

    it('a proposal routed to both approvers does NOT commit after only one approval (test 1 of N=2)', async () => {
      const created = await api('POST', '/api/proposals', grantor.apiKey, {
        authorization_id: authorizationIdA,
        profile_id: EMAIL_ID,
        tool: 'gmail__send_message',
        tool_args: { to: 'customer@example.com' },
        execution_context: { action_type: 'send' },
        pending_approvers: [approverA.id, approverB.id],
      });
      expect(created.status).toBe(201);
      proposalId = (created.body.proposal as { id: string }).id;
      expect(proposalId).toBeTruthy();

      const res = await api('POST', `/api/proposals/${proposalId}/approve`, approverA.apiKey);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending'); // 1 of 2 — not enough yet
      expect(res.body.approvedCount).toBe(1);
      expect(res.body.requiredApprovals).toBe(2);
      expect(res.body.remainingApprovers).toEqual([approverB.id]);
    });

    it('the SECOND distinct approval commits it (test 2 of N=2)', async () => {
      const res = await api('POST', `/api/proposals/${proposalId}/approve`, approverB.apiKey);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('committed');
      expect(res.body.approvedCount).toBe(2);
    });

    it('the ticket replayed with the committed proposalId now executes (201)', async () => {
      const res = await sp.postTicket(grantor.apiKey, {
        authorizationId: authorizationIdA,
        profileId: EMAIL_ID,
        action: 'gmail__send_message',
        actionType: 'send',
        executionContext: { action_type: 'send' },
        proposalId,
        // The matched committed proposal's content check: a legacy (non-encrypted)
        // caller matches by the SAME toolArgs the proposal was created with.
        toolArgs: { to: 'customer@example.com' },
      });
      expect(res.status).toBe(201);
    });
  });
});

// ── 3. Proposer exclusion: APPROVER_IS_PROPOSER, never counted (customers@0.9, overlap) ─

describe.skipIf(!hasTeamRolesCaps)('Proposer exclusion — the proposer cannot approve their own above-cap action (customers@0.9)', () => {
  let authorizationIdB = '';

  beforeAll(async () => {
    // The GRANTOR is also one of the two configured approvers here — the
    // overlap case the rule exists for. approvals=1 keeps it solvable once
    // the proposer is excluded (one eligible approver, approverA, remains).
    const cfg = await putProfileConfig(grantor.apiKey, teamGroupId, CUSTOMERS_ID, {
      approvers: [grantor.id, approverA.id],
      grantors: [grantor.id],
      approvals: 1,
      caps: { write_daily_max: { value: 1, kind: 'approval' } },
    });
    expect(cfg.status).toBe(200);

    const res = await api('POST', '/api/as/mandate', grantor.apiKey, {
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      profile_id: CUSTOMERS_ID,
      profile_hash: profileHashFor(CUSTOMERS_ID, PROFILES_DIR),
      group_id: teamGroupId,
      domain: 'ignored-for-teams',
      scope_hash: computeScopeHash({}, []),
      did: grantor.did,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: "Manage customer records on the team's behalf." }),
      execution_context_hash: hashExecutionContext({ action_type: 'write' }),
      bounds: { profile: CUSTOMERS_ID, read_access: 'unlimited', export_access: 'none', write_daily_max: 3, delete_daily_max: 0, setup_daily_max: 0 },
    });
    expect(res.status).toBe(201);
    expect(res.body.above_cap).toBe(true);
    authorizationIdB = res.body.authorization_id as string;
  });

  it('exceeding the cap escalates with BOTH configured approvers named, proposer included', async () => {
    // write_daily_max cap = 1 — the first write stays within it.
    const first = await sp.postTicket(grantor.apiKey, {
      authorizationId: authorizationIdB,
      profileId: CUSTOMERS_ID,
      action: 'crm__create_contact',
      actionType: 'write',
      executionContext: { action_type: 'write' },
    });
    expect(first.status).toBe(201);

    const res = await sp.postTicket(grantor.apiKey, {
      authorizationId: authorizationIdB,
      profileId: CUSTOMERS_ID,
      action: 'crm__create_contact',
      actionType: 'write',
      executionContext: { action_type: 'write' },
    });
    expect(res.status).toBe(409);
    const err = (res.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('APPROVAL_REQUIRED');
    expect(err.approvers).toEqual([grantor.id, approverA.id]);
  });

  it('the proposer (grantor) cannot approve their own proposal: 403 APPROVER_IS_PROPOSER', async () => {
    const created = await api('POST', '/api/proposals', grantor.apiKey, {
      authorization_id: authorizationIdB,
      profile_id: CUSTOMERS_ID,
      tool: 'crm__create_contact',
      tool_args: { name: 'Escalated Contact' },
      execution_context: { action_type: 'write' },
      pending_approvers: [grantor.id, approverA.id],
    });
    expect(created.status).toBe(201);
    const proposalId = (created.body.proposal as { id: string }).id;

    const res = await api('POST', `/api/proposals/${proposalId}/approve`, grantor.apiKey);
    expect(res.status).toBe(403);
    expect((res.body as { errors?: Array<Record<string, unknown>> }).errors?.[0]?.code).toBe('APPROVER_IS_PROPOSER');

    // Never counted: the lone non-proposer approver (approverA) alone is
    // enough to commit (approvals=1), proving the refused attempt above did
    // not consume the one required approval.
    const approved = await api('POST', `/api/proposals/${proposalId}/approve`, approverA.apiKey);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('committed');
    expect(approved.body.approvedCount).toBe(1);
  });
});

// ── 4. No approvers → every cap is hard; an impossible approver set refuses the TICKET, no dead proposal (records@0.6) ─

describe.skipIf(!hasTeamRolesCaps)('No-approvers hard caps + impossible approver set (records@0.6)', () => {
  it('with NO approvers at all, an "approval"-kind cap is still enforced as hard (422 cap_exceeded)', async () => {
    const cfg = await putProfileConfig(grantor.apiKey, teamGroupId, RECORDS_ID, {
      approvers: [],
      grantors: [grantor.id],
      caps: { write_daily_max: { value: 1, kind: 'approval' } }, // stored kind is irrelevant with no approvers
    });
    expect(cfg.status).toBe(200);

    const res = await api('POST', '/api/as/mandate', grantor.apiKey, {
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      profile_id: RECORDS_ID,
      profile_hash: profileHashFor(RECORDS_ID, PROFILES_DIR),
      group_id: teamGroupId,
      domain: 'ignored-for-teams',
      scope_hash: computeScopeHash({}, []),
      did: grantor.did,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: 'Manage records.' }),
      execution_context_hash: hashExecutionContext({ action_type: 'write' }),
      bounds: { profile: RECORDS_ID, read_access: 'unlimited', write_daily_max: 3, delete_access: 'none', archive_access: 'none' },
    });
    expect(res.status).toBe(422);
    expect((res.body.errors as Array<Record<string, unknown>>)[0].code).toBe('cap_exceeded');
  });

  let authorizationIdC = '';

  it('reconfigured with 2 approvers (one is the grantor) needing 2 distinct approvals → ticket refuses APPROVAL_IMPOSSIBLE, no proposal', async () => {
    const cfg = await putProfileConfig(grantor.apiKey, teamGroupId, RECORDS_ID, {
      approvers: [grantor.id, approverA.id],
      grantors: [grantor.id],
      approvals: 2, // excluding the proposer leaves only approverA (1) — short of 2
      caps: { write_daily_max: { value: 1, kind: 'approval' } },
    });
    expect(cfg.status).toBe(200);

    const mandate = await api('POST', '/api/as/mandate', grantor.apiKey, {
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      profile_id: RECORDS_ID,
      profile_hash: profileHashFor(RECORDS_ID, PROFILES_DIR),
      group_id: teamGroupId,
      domain: 'ignored-for-teams',
      scope_hash: computeScopeHash({}, []),
      did: grantor.did,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: 'Manage records.' }),
      execution_context_hash: hashExecutionContext({ action_type: 'write' }),
      bounds: { profile: RECORDS_ID, read_access: 'unlimited', write_daily_max: 3, delete_access: 'none', archive_access: 'none' },
    });
    expect(mandate.status).toBe(201);
    expect(mandate.body.above_cap).toBe(true);
    authorizationIdC = mandate.body.authorization_id as string;

    // First write stays within the team cap (1/day).
    const first = await sp.postTicket(grantor.apiKey, {
      authorizationId: authorizationIdC,
      profileId: RECORDS_ID,
      action: 'create_record',
      actionType: 'write',
      executionContext: { action_type: 'write' },
    });
    expect(first.status).toBe(201);

    // Second write exceeds it — and the only non-proposer approver (1) can
    // never reach the required 2, so the AS refuses outright.
    const second = await sp.postTicket(grantor.apiKey, {
      authorizationId: authorizationIdC,
      profileId: RECORDS_ID,
      action: 'create_record',
      actionType: 'write',
      executionContext: { action_type: 'write' },
    });
    expect(second.status).toBe(403);
    expect((second.body.errors as Array<Record<string, unknown>>)[0].code).toBe('APPROVAL_IMPOSSIBLE');
  });
});

// ── 5. Personal mode / owner-chosen review_above_cap is untouched (records@0.6, no team governance) ─

describe.skipIf(!hasTeamRolesCaps)('Personal mode — owner-chosen review_above_cap (no team governance) keeps working', () => {
  it('the owner naming themself as their own sole above-cap approver still escalates to APPROVAL_REQUIRED, never APPROVAL_IMPOSSIBLE', async () => {
    // soloOwner never joins the team — WS0's "Personal OR one team" rule
    // means this scenario needs its own ungoverned account, not the grantor.
    const personalGroupId = await sp.getPersonalGroupId(soloOwner.apiKey);

    const mandate = await api('POST', '/api/as/mandate', soloOwner.apiKey, {
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      profile_id: RECORDS_ID,
      profile_hash: profileHashFor(RECORDS_ID, PROFILES_DIR),
      group_id: personalGroupId,
      domain: soloOwner.id,
      scope_hash: computeScopeHash({}, []),
      did: soloOwner.did,
      commitment_mode: 'review_above_cap',
      above_cap_caps: { write_daily_max: 1 },
      above_cap_approvers: [soloOwner.id], // the owner names THEMSELF — pre-existing mechanism, untouched by TR5
      gate_content_hashes: hashGateContent({ intent: 'Personal records authority.' }),
      execution_context_hash: hashExecutionContext({ action_type: 'write' }),
      bounds: { profile: RECORDS_ID, read_access: 'unlimited', write_daily_max: 3, delete_access: 'none', archive_access: 'none' },
    });
    expect(mandate.status).toBe(201);
    const authorizationIdPersonal = mandate.body.authorization_id as string;

    const first = await sp.postTicket(soloOwner.apiKey, {
      authorizationId: authorizationIdPersonal,
      profileId: RECORDS_ID,
      action: 'create_record',
      actionType: 'write',
      executionContext: { action_type: 'write' },
    });
    expect(first.status).toBe(201);

    const second = await sp.postTicket(soloOwner.apiKey, {
      authorizationId: authorizationIdPersonal,
      profileId: RECORDS_ID,
      action: 'create_record',
      actionType: 'write',
      executionContext: { action_type: 'write' },
    });
    expect(second.status).toBe(409); // NOT 403 APPROVAL_IMPOSSIBLE — ungoverned, the TR5 rule does not apply
    expect((second.body.errors as Array<Record<string, unknown>>)[0].code).toBe('APPROVAL_REQUIRED');
  });
});

// ── 6. A migrated (pre-TR5) team config keeps granting; approvals defaults to 1 (customers@0.9) ─

describe.skipIf(!hasTeamRolesCaps)('Migrated team config (approvers only, no grantors/approvals field) — migration 012', () => {
  it('a config written the OLD way (bare numeric cap, approvers doubling as grantors) still lets an approver grant, and commits after exactly 1 approval', async () => {
    // Deliberately the pre-TR5 shape: no `grantors`, no `approvals`, and a
    // bare number for the cap (not { value, kind }) — exactly what
    // migration 012 leaves alone (grantors falls back to approvers on read).
    // Uses customers@0.9's delete_daily_max/'delete' — a cumulative field +
    // actionType untouched by any earlier test in this file, so its daily
    // count starts genuinely at zero (cumulative consumption is tracked per
    // domain+profile+actionType and persists across mandates on purpose —
    // reusing write_daily_max/'write' here would inherit the Proposer
    // Exclusion section's leftover count instead of proving this rule).
    const cfg = await putProfileConfig(grantor.apiKey, teamGroupId, CUSTOMERS_ID, {
      approvers: [grantor.id, approverA.id],
      caps: { delete_daily_max: 1 },
    });
    expect(cfg.status).toBe(200);

    const mandate = await api('POST', '/api/as/mandate', grantor.apiKey, {
      authorization_id: mintAuthorizationId(),
      supported_versions: ['0.7'],
      profile_id: CUSTOMERS_ID,
      profile_hash: profileHashFor(CUSTOMERS_ID, PROFILES_DIR),
      group_id: teamGroupId,
      domain: 'ignored-for-teams',
      scope_hash: computeScopeHash({}, []),
      did: grantor.did,
      commitment_mode: 'automatic',
      gate_content_hashes: hashGateContent({ intent: 'Legacy-config customers authority.' }),
      execution_context_hash: hashExecutionContext({ action_type: 'delete' }),
      bounds: { profile: CUSTOMERS_ID, read_access: 'unlimited', export_access: 'none', write_daily_max: 0, delete_daily_max: 3, setup_daily_max: 0 },
    });
    // grantors falls back to approvers → the approver-that-is-also-a-grantor can sign.
    expect(mandate.status).toBe(201);
    expect(mandate.body.above_cap).toBe(true);
    const authorizationIdLegacy = mandate.body.authorization_id as string;

    const first = await sp.postTicket(grantor.apiKey, {
      authorizationId: authorizationIdLegacy,
      profileId: CUSTOMERS_ID,
      action: 'crm__delete_contact',
      actionType: 'delete',
      executionContext: { action_type: 'delete' },
    });
    expect(first.status).toBe(201);

    const escalated = await sp.postTicket(grantor.apiKey, {
      authorizationId: authorizationIdLegacy,
      profileId: CUSTOMERS_ID,
      action: 'crm__delete_contact',
      actionType: 'delete',
      executionContext: { action_type: 'delete' },
    });
    expect(escalated.status).toBe(409);
    const err = (escalated.body.errors as Array<Record<string, unknown>>)[0];
    expect(err.code).toBe('APPROVAL_REQUIRED');
    expect(err.approvers).toEqual([grantor.id, approverA.id]);

    const created = await api('POST', '/api/proposals', grantor.apiKey, {
      authorization_id: authorizationIdLegacy,
      profile_id: CUSTOMERS_ID,
      tool: 'crm__delete_contact',
      tool_args: { id: 'escalated-contact' },
      execution_context: { action_type: 'delete' },
      pending_approvers: [grantor.id, approverA.id],
    });
    expect(created.status).toBe(201);
    const proposalId = (created.body.proposal as { id: string }).id;

    // approvals defaults to 1 — a SINGLE distinct (non-proposer) approval commits it.
    const approved = await api('POST', `/api/proposals/${proposalId}/approve`, approverA.apiKey);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('committed');
    expect(approved.body.requiredApprovals).toBe(1);
    expect(approved.body.approvedCount).toBe(1);
  });
});
