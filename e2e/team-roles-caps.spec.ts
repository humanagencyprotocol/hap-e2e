/**
 * Team roles, caps and read limits — gateway side (TR5/TR6/TR7).
 *
 * suveren-gateway draft PR #119 (branch feat/team-roles-caps-ui) against
 * suveren-as #86 (feat/team-roles-caps, merged to main) + #87
 * (fix/profile-config-compat, merged to main): grantor vs approver roles,
 * hard vs approval-kind caps in the mandate editor, the above-cap approval
 * card (including "you can't approve your own action"), and the team read
 * ceiling (min(local, signed) in team mode only).
 *
 * Written from the task's own decisions and the SIGNED-OFF mockup
 * (temp/team-caps-mockup/index.html, screens 2 and 3) — not from reading
 * suveren-gateway's implementation. One reconciliation between the two
 * sources was necessary and is recorded where it happens below (the
 * "Tom's own card" scenario).
 *
 * Real stack throughout: a real Authority Server, a real gateway built from
 * source, a real CRM MCP connector (local SQLite, no credentials), and (TR7
 * only, credential-gated) a real Gmail connector. No mocks.
 *
 * ── Feature gate ───────────────────────────────────────────────────────────
 * Skips loudly (not silently) when this gateway checkout predates #119 — two
 * markers, same style as the AS-side team-roles-caps.test.ts gate: the
 * team-caps module must exist, and the approval card must carry the
 * proposer-exclusion test id.
 *
 * ── The "Tom (grantor only)" reconciliation ─────────────────────────────────
 * The task brief describes Tom as "grantor only" (not an approver). But the
 * mockup's own note for screen 3 state B says "Tom is also on the approver
 * list for this profile" — and reading the shipped code
 * (apps/mcp-server/src/lib/tool-proxy.ts, the APPROVAL_REQUIRED branch)
 * shows why BOTH are true at once without contradiction: the gateway always
 * puts the proposal's own CREATOR at the front of `pendingApprovers`,
 * regardless of the team's configured approver list (decision #4, "above-cap
 * = everyone reviews, creator included"). So Tom never needs to be a
 * CONFIGURED team approver (he isn't, here — `approvers: [lisa, andreas]`
 * only) for his own proposal to still name him in pendingApprovers and for
 * the AS to still refuse his own approval (APPROVER_IS_PROPOSER). That is
 * exactly the mockup's screen 3 state B, reached without putting Tom in the
 * team's approver configuration at all.
 *
 * ── Multi-user / one shared gateway ─────────────────────────────────────────
 * This harness runs ONE gateway (fixed ports) for the whole Playwright run.
 * Signing in as a different API key wipes local gateway data for the
 * previous one (signInToGateway's "different account" flow) — so Lisa can
 * never get her own browser session on this gateway without destroying
 * Tom's. Per the task brief: Lisa approves via the Authority Server's own
 * API directly (the real endpoint a second gateway would call anyway), and
 * Tom's own card is checked in the UI instead.
 *
 * ── Test order, and two real defects this file found ────────────────────────
 * The "mandate editor" scenario (screen 2) runs LAST in this file, not
 * first, and deliberately OUTSIDE the escalation/approval `.serial` chain.
 * It documents a genuine race-condition defect in GateWizardPage/
 * BoundsEditor (see its own comment) and is EXPECTED TO FAIL against the
 * current #119 code — reported, not worked around (task instructions: a
 * gateway defect is reported, never silently patched around in the test).
 * Playwright discards and restarts the WORKER PROCESS after a failing test,
 * which drops this file's top-level `let` state (`tom`, `groupId`, …) for
 * whatever runs next — so the escalation chain (which needs that state, and
 * is NOT itself expected to fail at `setup`) runs BEFORE the known-failing
 * test, never after it. The mandate the escalation chain needs is created
 * directly via the Authority Server API instead of through the broken UI
 * step — see that test's own comment.
 *
 * FIXED 2026-10-15 (was: a production security regression — see
 * suveren-as's fix/review-above-cap-bypass branch and
 * apps/mcp-server/src/lib/attestation-cache.ts's matching gateway fix):
 * the escalation chain's SECOND test ("a first write succeeds; a second...
 * should escalate") used to document that an above-cap mandate's
 * commitment_mode was unconditionally promoted to `review_above_cap`, which
 * the Authority Server unconditionally paired with
 * `deferred_commitment_domains` — forcing the real gateway through the
 * DOMAIN-deferred commit path for every single call, including a bypass
 * where the mandate OWNER could commit his own domain proposal and clear
 * the team's cap without any above-cap approver ever seeing it. Both the
 * Authority Server (mandate/route.ts never defers a domain for
 * review_above_cap now; ticket/route.ts's cap check is skipped only for a
 * proposal actually cleared by the required distinct above-cap approvers)
 * and the gateway (`isCommitmentDowngrade` no longer treats a
 * review_above_cap authority's absent deferred domain as a downgrade — it
 * is the correct, expected shape) are fixed at the root. The test below now
 * exercises the REAL flow: the first (within-cap) write executes directly,
 * with no proposal at all; the second (over-cap) write produces a genuine
 * above-cap proposal naming Lisa/Andreas (and Tom, as creator) — never
 * something Tom can clear by himself.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { GatewayClient } from '../src/helpers/gateway-client.js';
import { computeScopeHash, computeBoundsHash, hashGateContent } from '../src/helpers/crypto.js';
import { DatabaseSync } from 'node:sqlite';
import {
  test, expect,
  SP_URL, GW_URL, GW_MCP_URL, INTERNAL_SECRET,
  latestProfileId,
  signInToGateway, handleOnboarding, activateIntegration,
  spApiAttest, gatewayDataDir,
} from './fixtures';
import type { APIRequestContext } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GW_DIR = join(__dirname, '..', '..', 'suveren-gateway');

// ── Feature gate: skip only when #119's gateway source is absent ───────────
const TEAM_CAPS_FILE = join(GW_DIR, 'apps', 'ui', 'src', 'lib', 'team-caps.ts');
const APPROVER_CARD_FILE = join(GW_DIR, 'apps', 'ui', 'src', 'components', 'ApproverProposalCard.tsx');
const hasTeamRolesCapsUi =
  existsSync(TEAM_CAPS_FILE) &&
  existsSync(APPROVER_CARD_FILE) &&
  readFileSync(APPROVER_CARD_FILE, 'utf8').includes('cant-approve-own-action');

const CUSTOMERS_ID = latestProfileId('customers');

// ── AS helpers (no wrapper in e2e/fixtures.ts for groups/profile-config —
// same raw-fetch style spApiAttest/spApiReceipt already use) ───────────────

interface AsUser { id: string; did: string; apiKey: string; name: string }

async function registerAsUser(request: APIRequestContext, name: string): Promise<AsUser> {
  const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID()}@test.local`;
  const res = await request.post(`${SP_URL}/api/auth/register`, { data: { name, email } });
  if (!res.ok()) throw new Error(`register ${name} failed: ${res.status()} ${await res.text()}`);
  const body = await res.json() as { apiKey: string; user: { id: string; did: string } };
  return { id: body.user.id, did: body.user.did, apiKey: body.apiKey, name };
}

async function createTeam(request: APIRequestContext, admin: AsUser, name: string): Promise<{ groupId: string; inviteCode: string }> {
  const res = await request.post(`${SP_URL}/api/groups`, {
    headers: { 'x-api-key': admin.apiKey },
    data: { name },
  });
  if (!res.ok()) throw new Error(`createGroup failed: ${res.status()} ${await res.text()}`);
  const body = await res.json() as { group: { id: string; inviteCode: string } };
  return { groupId: body.group.id, inviteCode: body.group.inviteCode };
}

/** Join + the admin's confirmation (WS0, 2026-10-11 — joins are requests, not
 *  immediate membership). One at a time: the confirm-by-listing step assumes
 *  exactly one pending request. */
async function joinTeamConfirmed(request: APIRequestContext, member: AsUser, admin: AsUser, groupId: string, inviteCode: string): Promise<void> {
  const joinRes = await request.post(`${SP_URL}/api/groups/join`, {
    headers: { 'x-api-key': member.apiKey },
    data: { inviteCode },
  });
  if (!joinRes.ok()) throw new Error(`join failed for ${member.name}: ${joinRes.status()} ${await joinRes.text()}`);
  if (joinRes.status() === 200) return; // older AS — joined immediately

  const listRes = await request.get(`${SP_URL}/api/groups/${groupId}/requests`, {
    headers: { 'x-api-key': admin.apiKey },
  });
  if (!listRes.ok()) throw new Error(`list join requests failed: ${listRes.status()}`);
  const { requests } = await listRes.json() as { requests: Array<{ userId: string }> };
  const pending = requests.find(r => r.userId === member.id);
  if (!pending) throw new Error(`no pending join request found for ${member.name}`);
  const confirmRes = await request.post(`${SP_URL}/api/groups/${groupId}/requests/${pending.userId}`, {
    headers: { 'x-api-key': admin.apiKey },
    data: { action: 'confirm' },
  });
  if (!confirmRes.ok()) throw new Error(`confirm join failed for ${member.name}: ${confirmRes.status()} ${await confirmRes.text()}`);
}

type CapsBody = Record<string, number | string | { value: number | string; kind: 'hard' | 'approval' }>;

async function putProfileConfig(
  request: APIRequestContext,
  admin: AsUser,
  groupId: string,
  profileId: string,
  config: { grantors?: string[] | 'all'; approvers: string[]; approvals?: number; caps?: CapsBody },
): Promise<void> {
  const res = await request.put(`${SP_URL}/api/groups/${groupId}/profile-config/${encodeURIComponent(profileId)}`, {
    headers: { 'x-api-key': admin.apiKey },
    data: config,
  });
  if (!res.ok()) throw new Error(`putProfileConfig failed: ${res.status()} ${await res.text()}`);
}

async function getProposalsForApprover(request: APIRequestContext, apiKey: string): Promise<Array<Record<string, unknown>>> {
  const res = await request.get(`${SP_URL}/api/proposals?approver=me`, { headers: { 'x-api-key': apiKey } });
  if (!res.ok()) throw new Error(`getProposalsForApprover failed: ${res.status()}`);
  const body = await res.json() as { proposals?: Array<Record<string, unknown>> };
  return body.proposals ?? [];
}

/** registers a fresh team (Tom/Lisa/Andreas) with the exact TR5 config this
 *  whole file exercises. Called from each top-level describe below (not a
 *  shared `beforeAll`) so that EITHER one is independently runnable and
 *  neither depends on file-level `let` state surviving a worker restart
 *  caused by a DIFFERENT describe's failure (see the file header). */
async function setUpTeam(request: APIRequestContext): Promise<{ tom: AsUser; lisa: AsUser; andreas: AsUser; groupId: string }> {
  const tom = await registerAsUser(request, 'Tom');
  const lisa = await registerAsUser(request, 'Lisa');
  const andreas = await registerAsUser(request, 'Andreas');

  const team = await createTeam(request, andreas, `TR5 Gateway Team ${Date.now()}`);
  const groupId = team.groupId;
  await joinTeamConfirmed(request, tom, andreas, groupId, team.inviteCode);
  await joinTeamConfirmed(request, lisa, andreas, groupId, team.inviteCode);

  // Tom is the ONLY grantor (may create mandates); Lisa and Andreas are the
  // ONLY approvers (may clear an above-cap proposal). Neither role implies
  // the other — TR5's whole point. Tom is not a configured approver here;
  // see the file header for why he still appears on his own proposal card.
  await putProfileConfig(request, andreas, groupId, CUSTOMERS_ID, {
    grantors: [tom.id],
    approvers: [lisa.id, andreas.id],
    // approvals omitted — defaults to 1.
    caps: {
      write_daily_max: { value: 1, kind: 'approval' },
      read_access: { value: 'none', kind: 'hard' },
      delete_daily_max: { value: 2, kind: 'hard' },
    },
  });
  return { tom, lisa, andreas, groupId };
}

test.describe('Team roles, caps and read limits — gateway (#119)', () => {
  test.skip(!hasTeamRolesCapsUi, 'suveren-gateway checkout predates #119 (feat/team-roles-caps-ui) — team-caps.ts or the proposer-exclusion UI marker is missing.');

  // ── Escalation, approval card, execution — screen 3 of the signed-off
  //    mockup. Genuinely sequential (shared mcpClient/proposalId), so a
  //    single `.serial` block; no step here is expected to fail, so no
  //    worker restart risk for the chain itself.
  test.describe.serial('escalation + approval', () => {
    let tom: AsUser;
    let lisa: AsUser;
    let andreas: AsUser;
    let groupId: string;
    let mcpClient: Client;
    let proposalId: string;

    test('setup: a team with a grantor-only member and two approvers, then Tom\'s above-cap mandate', async ({ request, page }) => {
      ({ tom, lisa, andreas, groupId } = await setUpTeam(request));

      // Sign Tom's browser in FIRST — pushGateContent below asks the MCP
      // server to look the mandate up on the Authority Server using the
      // CURRENTLY signed-in session; with nobody signed in yet it 401s.
      await signInToGateway(page, tom.apiKey);
      await handleOnboarding(page);

      // The mandate the gateway's OWN mandate editor should produce for
      // these bounds (see the "mandate editor" test at the end of this file
      // for the race that currently stops the UI from doing this itself) —
      // created directly against the real Authority Server, the same call
      // the gateway would have made on "Sign mandate".
      //
      // The AS only ever sees `scope_hash` (E2EE by design — "Encrypted on
      // your device, never sent to the Authority Server") — the GATEKEEPER
      // enforces the real scope (contact_type) locally, from content pushed
      // to it directly, which the UI wizard would normally do on submit.
      // Bypassing the UI here (the broken step) means doing that push too —
      // same two-step shape crm-lifecycle.test.ts uses.
      const scopeContext = { contact_type: 'customer' };
      const contextHash = computeScopeHash(scopeContext, ['contact_type']);
      const INTENT = "Manage customer records on the team's behalf, above the daily team cap when approved.";

      const sessionRes = await request.post(`${SP_URL}/api/auth/session`, { headers: { 'x-api-key': tom.apiKey } });
      const { user } = await sessionRes.json() as { user: { did: string } };
      const mandate = await spApiAttest(request, tom.apiKey, {
        profile_id: CUSTOMERS_ID,
        group_id: groupId,
        domain: tom.id,
        did: user.did,
        bounds: { profile: CUSTOMERS_ID, read_access: 'none', export_access: 'none', write_daily_max: 2, delete_daily_max: 2, setup_daily_max: 0 },
        scope_hash: contextHash,
        gate_content_hashes: hashGateContent({ intent: INTENT }),
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'automatic',
      });
      expect(mandate.above_cap).toBe(true); // write_daily_max=2 exceeds the approval cap (1)
      expect(mandate.commitment_mode).toBe('review_above_cap');

      const gw = new GatewayClient(GW_MCP_URL, INTERNAL_SECRET);
      await gw.pushGateContent(
        { authorizationId: mandate.authorization_id as string, contextHash, context: scopeContext },
        CUSTOMERS_ID,
        { intent: INTENT },
      );
    });

    test("Tom's agent (real CRM connector): a first write succeeds; a second, over the team cap, should escalate to an above-cap proposal", async ({ page }) => {
      // Signs Tom's browser in too — later steps in this chain need it, and
      // the gateway's attestation cache resolves tool calls by the
      // CURRENTLY signed-in session.
      await signInToGateway(page, tom.apiKey);
      await handleOnboarding(page);
      // CRM is `personalDefault: true`, but after other specs switched
      // accounts on the shared gateway it may not be installed for Tom —
      // activate it explicitly (a no-op when it is already running).
      await activateIntegration(page, 'CRM');
      const transport = new SSEClientTransport(new URL(`${GW_MCP_URL}/sse`));
      mcpClient = new Client({ name: 'tr5-tom-agent', version: '0.1.0' }, { capabilities: {} });
      await mcpClient.connect(transport);

      await expect(async () => {
        const { tools } = await mcpClient.listTools();
        expect(tools.some(t => t.name === 'crm__create_contact')).toBe(true);
      }).toPass({ timeout: 30_000 });

      // FIXED 2026-10-15 (was a KNOWN GATEWAY/AS INTEGRATION DEFECT — see the
      // file header): a team-promoted review_above_cap mandate no longer
      // defers commitment to the owner's own domain at all, so the first
      // (within-cap) write executes DIRECTLY — a real ticket, no proposal of
      // any kind, no domain-commit step. Only the SECOND (over-cap) write
      // produces a proposal, and it is a genuine above-cap one (pendingApprovers
      // naming Lisa/Andreas/Tom), which only Lisa or Andreas can clear — never
      // something Tom can commit to himself.
      const first = await mcpClient.callTool({
        name: 'crm__create_contact',
        arguments: { name: 'TR5 Contact A', email: 'tr5-a@example.com', type: 'customer' },
      });
      expect(first.isError).not.toBe(true);
      const firstText = (first.content as Array<{ text: string }>)[0].text;
      // No proposal at all for the within-cap write — this is the direct
      // regression check for the fix (the old, buggy code always produced a
      // "Proposal ID:" here, for every call, regardless of the cap).
      expect(firstText).not.toMatch(/Proposal ID:/);
      const contactA = JSON.parse(firstText.slice(firstText.indexOf('{'))) as { id: string; name: string };
      expect(contactA.id).toBeTruthy();
      expect(contactA.name).toBe('TR5 Contact A'); // within the team cap (1/day) — a real contact, executed immediately.

      // Second write: exceeds the cumulative team cap (now at 1/1) — escalates
      // to an above-cap proposal naming Lisa/Andreas (APPROVAL_REQUIRED),
      // directly in the tool call's own result (no check-pending-commitments
      // round-trip needed — there was nothing deferred to check).
      const second = await mcpClient.callTool({
        name: 'crm__create_contact',
        arguments: { name: 'TR5 Contact B', email: 'tr5-b@example.com', type: 'customer' },
      });
      const secondText = (second.content as Array<{ text: string }>)[0].text;
      expect(secondText).toMatch(/Approval required/i);
      const match = secondText.match(/Proposal ID:\s*([^\s.]+)/);
      expect(match).toBeTruthy();
      proposalId = match![1];
    });

    // ── Approval card — signed-off mockup, screen 3 ─────────────────────────

    test("Lisa's view: 'Needs 1 approval from…' and the over-the-limit reason (checked via the AS, no second gateway)", async ({ request }) => {
      const lisaProposals = await getProposalsForApprover(request, lisa.apiKey);
      const proposal = lisaProposals.find(p => p.id === proposalId);
      expect(proposal, 'Lisa must be a pending approver on this proposal').toBeTruthy();
      const pendingApprovers = (proposal as { pendingApprovers?: string[] }).pendingApprovers ?? [];
      expect(pendingApprovers).toContain(lisa.id);
      expect(pendingApprovers).toContain(andreas.id);
      // Never yourself (TR5): the proposer is not one of the approvers.
      expect(pendingApprovers).not.toContain(tom.id);
    });

    test("Tom's own card: he sees his proposal waiting on others, and cannot approve it", async ({ page }) => {
      await signInToGateway(page, tom.apiKey);
      await handleOnboarding(page);
      // In-app navigation: a full reload (page.goto) drops the session.
      await page.click('.sidebar-item:has-text("Pending Approvals")');
      await page.waitForURL('**/approvals');
      // Tom is not an approver of his own action: it waits on others.
      await page.click('.nav-tab:has-text("Awaiting others")');

      const card = page.locator('.id-card', { hasText: /Needs 1 approval from/ }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });

      await expect(card).toContainText(/Needs 1 approval from/);
      await expect(card.getByTestId('above-cap-reason')).toContainText(/Above the team limit/i);

      // D3 (signed-off mockup, screen 3 state B): never yourself. Replaced,
      // not just disabled, so the reason is visible.
      await expect(card.getByTestId('cant-approve-own-action')).toContainText(/You can.t approve your own action/);
      await expect(card.locator('button:has-text("Approve")')).toHaveCount(0);
    });

    // ── Lisa approves via the Authority Server directly (one shared
    //    gateway — see the file header) — the SAME endpoint a second
    //    gateway would call.

    test('one approval from Lisa is enough (approvals defaults to 1); the proposer never counts', async ({ request }) => {
      const res = await request.post(`${SP_URL}/api/proposals/${encodeURIComponent(proposalId)}/approve`, {
        headers: { 'x-api-key': lisa.apiKey },
      });
      expect(res.ok()).toBe(true);
      const body = await res.json() as { status: string; approvedCount?: number; requiredApprovals?: number };
      expect(body.status).toBe('committed');
      expect(body.approvedCount).toBe(1);
      expect(body.requiredApprovals).toBe(1);
    });

    test("Tom's agent executes the committed proposal — a real second CRM contact now exists", async () => {
      const result = await mcpClient.callTool({
        name: 'check-pending-commitments',
        arguments: { proposal_id: proposalId },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/committed and executed/i);
      expect(text).toContain('TR5 Contact B');
      expect(text).toContain('tr5-b@example.com');
      await mcpClient.close();
    });
  });

  // ── Team read ceiling (TR7) — credential-gated (real Gmail connector) ─────
  //
  // No non-credentialed connector in this workspace declares an age
  // dimension: customers@* has only a binary read_access switch (exercised
  // above as the hard-cap case); CRM's and Records' manifests never declare
  // `readPolicy`/`read.ageField`. Only gmail.json wires `read_max_age_days`
  // (ageField: "read_age_days", resultDatePath: "internalDate") to a real
  // age check on `get_message` — and Gmail needs a real account. Self-skips
  // without credentials, same convention as email-lifecycle.test.ts /
  // email-read-age.test.ts (README "Credential-gated suites") — loud, not
  // silent, and reported as not-run rather than claimed covered.
  //
  // The refusal/success contrast additionally needs a KNOWN message id in
  // the test mailbox older than the 30-day signed ceiling — same
  // GMAIL_OLD_MESSAGE_ID convention email-read-age.test.ts already uses,
  // because no fixture here can seed real Gmail content. Without it, the
  // mandate/mode setup still runs (proving the plumbing works) but the one
  // assertion that needs mailbox content skips individually, loudly.
  test.describe.serial('TR7 — team read ceiling: min(local, signed) in team mode, local wins in personal mode', () => {
    // Our own email connector (simulation), not Gmail: it runs in CI. Its
    // get_message is age-checked per item (received_at) since gateway #116.
    const EMAIL_ID = latestProfileId('email');
    const EMAIL_KEY_ORDER = ['profile', 'read_access', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'setup_daily_max'];
    const gw = new GatewayClient(GW_MCP_URL, INTERNAL_SECRET);

    async function emailMandate(request: APIRequestContext, user: AsUser, forGroupId: string): Promise<void> {
      const sessionRes = await request.post(`${SP_URL}/api/auth/session`, { headers: { 'x-api-key': user.apiKey } });
      const { user: sessionUser } = await sessionRes.json() as { user: { did: string } };
      const intent = 'TR7: read the shared inbox, at most 30 days back.';
      const bounds = { profile: EMAIL_ID, read_access: 'unlimited', recipient_max: 1, send_daily_max: 0, read_max_age_days: 30, setup_daily_max: 2 };
      const boundsHash = computeBoundsHash(bounds, EMAIL_KEY_ORDER);
      const scopeHash = computeScopeHash({}, []);
      const mandate = await spApiAttest(request, user.apiKey, {
        profile_id: EMAIL_ID, group_id: forGroupId, domain: user.id, did: sessionUser.did,
        bounds, bounds_hash: boundsHash, scope_hash: scopeHash,
        gate_content_hashes: hashGateContent({ intent }),
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'automatic',
      });
      expect(mandate.authorization_id).toBeTruthy();
      await gw.pushGateContent({ authorizationId: mandate.authorization_id as string, boundsHash, contextHash: scopeHash, context: {} }, EMAIL_ID, { intent });
    }

    /** Seeds one message through the connector and backdates it 40 days in
     *  the connector's own database (the simulation ignores package dates). */
    async function oldMessageId(client: Client): Promise<string> {
      // The connector keeps its data between tests on the shared gateway.
      await client.callTool({ name: 'mail__clear_simulation', arguments: {} });
      const load = await client.callTool({ name: 'mail__load_simulation', arguments: { package: {
        name: 'TR7 Co', currency: 'EUR',
        customers: [{ id: 'cust-1', name: 'Old Customer GmbH', email: 'old@old-customer.example', credit_limit: 1000 }],
        products: [{ id: 'item-1', sku: 'X-1', name: 'Item', list_price: 10, stock: 1 }],
        cases: [{ id: 'c1', request: { from: { name: 'Old Customer', email: 'old@old-customer.example' }, subject: 'TR7 old message', body: 'Hello.' }, reply: { subject: 'Re', body: 'Ok' } }],
      } } });
      expect(load.isError, JSON.stringify(load.content)).toBeFalsy();
      const listed = await client.callTool({ name: 'mail__list_messages', arguments: { folder: 'inbox' } });
      const inbox = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{ id: string; subject: string }>;
      const id = inbox.find(m => m.subject === 'TR7 old message')!.id;
      const db = new DatabaseSync(join(gatewayDataDir(), 'email.db'));
      db.prepare('UPDATE messages SET received_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * 86_400_000).toISOString(), id);
      db.close();
      return id;
    }

    test('TEAM mode: a local window far wider than the signed 30-day ceiling does not win — an old message is refused', async ({ request, page }) => {
      const { tom, andreas, lisa, groupId } = await setUpTeam(request);
      // The team enables the email profile for Tom, with a hard 30-day read cap.
      await putProfileConfig(request, andreas, groupId, EMAIL_ID, {
        grantors: [tom.id], approvers: [lisa.id, andreas.id],
        caps: { read_max_age_days: { value: 30, kind: 'hard' } },
      });
      await signInToGateway(page, tom.apiKey);
      await handleOnboarding(page);
      await activateIntegration(page, 'Email (simulation)');
      await emailMandate(request, tom, groupId);
      // Local window wide open (365 days): without TR7 it alone would allow the read.
      expect((await gw.setReadPolicy('mail', 365)).ok).toBe(true);

      const client = new Client({ name: 'tr7-tom-agent', version: '0.1.0' }, { capabilities: {} });
      await client.connect(new SSEClientTransport(new URL(`${GW_MCP_URL}/sse`)));
      try {
        const id = await oldMessageId(client);
        const res = await client.callTool({ name: 'mail__get_message', arguments: { id } });
        expect(res.isError, 'the signed 30-day team ceiling must win over the local 365 days').toBe(true);
        expect((res.content as Array<{ text: string }>)[0]?.text ?? '').toMatch(/30-day/);
      } finally {
        await client.close();
      }
    });

    test('PERSONAL mode: a different, never-teamed user is governed by the local window alone, even beyond the signed value', async ({ request, page }) => {
      const solo = await registerAsUser(request, 'Solo Reader');
      await signInToGateway(page, solo.apiKey);
      await handleOnboarding(page);
      await activateIntegration(page, 'Email (simulation)');
      const groupsRes = await request.get(`${SP_URL}/api/groups`, { headers: { 'x-api-key': solo.apiKey } });
      const { groups } = await groupsRes.json() as { groups: Array<{ id: string; allowLazyEnable?: boolean; isPersonal?: boolean }> };
      const personal = groups.find(g => g.allowLazyEnable || g.isPersonal) ?? groups[0];
      await emailMandate(request, solo, personal.id);
      expect((await gw.setReadPolicy('mail', 365)).ok).toBe(true);

      const client = new Client({ name: 'tr7-solo-agent', version: '0.1.0' }, { capabilities: {} });
      await client.connect(new SSEClientTransport(new URL(`${GW_MCP_URL}/sse`)));
      try {
        const id = await oldMessageId(client);
        // Rule 8 (unchanged by TR7): personally, the local window governs.
        const res = await client.callTool({ name: 'mail__get_message', arguments: { id } });
        expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  // ── Mandate editor (Tom) — signed-off mockup, screen 2 ────────────────────
  //
  // Runs LAST and independently (not .serial with anything) — see the file
  // header: it documents a real, reproducible gateway race-condition defect
  // and is EXPECTED TO FAIL against the current #119 code.
  test('mandate editor: hard cap clamps, approval cap allows above with a note, hard enum is disabled', async ({ page, request }) => {
    const { tom } = await setUpTeam(request);

    await signInToGateway(page, tom.apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    await page.waitForLoadState('networkidle');
    await page.click('.sidebar-item:has-text("Mandates")');
    await page.waitForURL('**/mandates**');
    await page.click('button:has-text("New mandate")');
    await page.waitForSelector('.profile-grid', { timeout: 10_000 });

    const crmCard = page.locator('.card', { has: page.locator('text=CRM') }).first();
    await crmCard.locator('button:has-text("Give a mandate")').click();
    await page.waitForURL(url => url.toString().includes('/mandates/new/intent'), { timeout: 10_000 });

    // ── Hard numeric cap (delete_daily_max, cap=2): pre-filled AT the cap
    //    (no seed existed) and the stepper's "+" cannot go past it.
    //
    // KNOWN GATEWAY DEFECT (reported, not worked around here — see the PR
    // description this commit ships with): GateWizardPage fetches `profile`
    // (gates BoundsEditor's first mount) and the team `profileConfig` (3
    // parallel calls: profile-config + group + users) independently. When
    // the profileConfig fetch resolves AFTER `profile` — plausible, since it
    // is the slower of the two — BoundsEditor has already mounted and
    // computed `initialBoundsValues` from a still-null profileConfig, and
    // its `useState(initialBoundsValues)` initializer never re-runs once
    // profileConfig arrives (React only calls a useState initializer once,
    // on mount; there is no `key` on <BoundsEditor> or an effect that
    // re-seeds). The live, per-render `capStates` (cap notes, `capMax`,
    // `enumAllowedFrom`) DO reflect the loaded profileConfig correctly — so
    // the UI shows the right notes and constraints while the actual
    // `boundsValues` stays at its stale, UNCAPPED seed. Observed
    // deterministically across three separate runs, including once with an
    // extra 5s wait inserted before this very assertion (to rule out "just
    // needs longer" — the value never self-corrects): `delete_daily_max`
    // renders `value=""` (should be the hard-capped "2") with `max="2"`
    // correctly applied; `read_access` (a <select>, hard-capped to "none")
    // renders with "unlimited" SELECTED even though that very `<option>` is
    // itself `disabled` by the same live cap check — a value the team's
    // hard cap forbids, sitting in a control the person cannot fix because
    // it is disabled. Submitting from this state would ask the Authority
    // Server to sign an above-hard-cap mandate, which it refuses (422
    // cap_exceeded) — a confusing dead end a page reload silently works
    // around, but the mandate editor should never reach.
    const deleteInput = page.locator('#bounds-field-delete_daily_max');
    await expect(deleteInput).toHaveValue('2', { timeout: 10_000 });
    const deleteIncrement = deleteInput.locator('xpath=following-sibling::button[contains(@class,"stepper-increment")]');
    await expect(deleteIncrement).toBeDisabled();
    await expect(page.getByTestId('cap-note-delete_daily_max')).toContainText('Team limit 2');

    // ── Hard enum cap (read_access, cap=none): the signed-off mockup's
    //    "Disabled by your team's policy" wording; select is fully disabled
    //    because only one option ("none") remains choosable.
    const readAccessSelect = page.locator('#bounds-field-read_access');
    await expect(readAccessSelect).toBeDisabled();
    await expect(readAccessSelect).toHaveValue('none');
    await expect(page.getByTestId('cap-note-read_access')).toContainText(/Disabled by your team.s policy/);
    await expect(page.getByTestId('cap-note-read_access')).toContainText('none');

    // ── Approval-kind cap (write_daily_max, cap=1): NOT clamped — Tom can
    //    set it above the cap, and the field explains where it goes.
    const writeInput = page.locator('#bounds-field-write_daily_max');
    await writeInput.fill('2');
    await expect(writeInput).toHaveValue('2');
    const writeNote = page.getByTestId('cap-note-write_daily_max');
    await expect(writeNote).toContainText(/goes to/);
    await expect(writeNote).toContainText(/for approval/);
    await expect(writeNote).toContainText('1'); // the cap value

    // Continue is NOT blocked — only a HARD violation blocks it, and nothing
    // here is hard-violating (delete/read_access are already at their caps).
    await expect(page.locator('button:has-text("Next: Problem Statement")')).toBeEnabled();
    await page.click('button:has-text("Next: Problem Statement")');

    await page.waitForSelector('.intent-textarea', { timeout: 5_000 });
    await page.fill('.intent-textarea', "Manage customer records on the team's behalf, above the daily team cap when approved.");
    await page.locator('button:has-text("Continue to Review")').click();

    await page.waitForURL(url => url.toString().includes('/mandates/new/sign'), { timeout: 10_000 });
    await page.locator('button', { hasText: 'Automatic' }).click();
    await page.locator('input[placeholder*="e.g."]').fill('Team CRM ops (above cap)');
    await page.locator('button', { hasText: /^Sign mandate/ }).last().click();
    await page.waitForURL(url => url.toString().includes('/mandates'), { timeout: 15_000 });
  });
});
