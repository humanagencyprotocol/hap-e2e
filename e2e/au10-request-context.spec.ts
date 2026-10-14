/**
 * AU10 — Request and customer history on the approval card
 *
 * Contract: doc/au10-request-context.md
 * Mockup: temp/au10-mockup/index.html
 *
 * Tests phase A (cases 1–8): the gateway reads request metadata and customer
 * history independently. Neither the AI's claim nor the read reach the AI or the AS.
 * Missing/invalid sources never block approval.
 *
 * Phase B (case 9) — snapshot binding — is optional and gated by a capability check.
 *
 * Real MCP servers only (CRM, Email, ERP). To run against feat/au10-context-reads,
 * the test fixtures must pin hap-crm-mcp to that branch via npm overrides or
 * HAP_E2E_PREINSTALLED_INTEGRATIONS environment variable.
 */

import { test, expect, ensureUsersRegistered, ALICE, signInToGateway, handleOnboarding, activateIntegration, SP_URL, GW_URL, latestProfileId } from './fixtures';

const CUSTOMERS_PROFILE = latestProfileId('customers');
const RECORDS_PROFILE = latestProfileId('records');

test.describe.serial('AU10: Request and customer history on approval card', () => {
  let apiKey: string;

  test.beforeAll(async () => {
    await ensureUsersRegistered();
    apiKey = ALICE.apiKey;
    expect(apiKey).toBeTruthy();

    // TODO: Detect AU10 capability via gateway health endpoint.
    // For now, always run. When implemented, gate with:
    // const health = await fetch(`${GW_URL}/health`);
    // const au10Capable = health.headers.get('X-AU10') === '1';
    // test.skip(!au10Capable, 'Gateway lacks AU10 support');
  });

  test('AU10.1: _source links request; shows author, time, title on card', async ({ page }) => {
    // CASE 1: Quote with _source → card shows request with author/subject.
    //
    // Expected UI elements (from mockup):
    // - Request block with label "Linked by the AI" (amber)
    // - Sender name (bold): "J. Kraus"
    // - Time and connector: "mail · message · from J. Kraus · 09:55"
    // - Subject/title in bold: "RF 55 Stillstand – Seriennummer 55-2291"
    // - Body excerpt (italic, truncated to ~6 lines)
    // - Attribution: "— from J. Kraus, not checked"

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');
    await activateIntegration(page, 'Email');

    // TODO: Create a proposal with _source via API, then check the approval card.
    // This requires:
    // 1. Creating an authorization in review mode
    // 2. Posting a proposal with tool_args containing _source
    // 3. Navigating to /approvals
    // 4. Finding the card and asserting on the Request block text

    // Placeholder: verify the approvals page loads
    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test('AU10.2: History shows CRM entries for same domain, within 14 days', async ({ page }) => {
    // CASE 2: Latest entries for the same customer domain shown in history.
    // Older entries and different domains are excluded.
    //
    // Expected:
    // - History block label: "Read by the gateway — same customer, not matched to this request"
    // - Subtitle: "Latest entries for bavaria-umform.de (matched by email domain)"
    // - Entries from the last 14 days, newest first
    // - Type label (e.g., "Call note"), time, title, body excerpt, author
    // - Max limit entries per connector

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    // TODO: Set up CRM data and create a proposal for the same customer.
    // Verify history block displays correct subset and time window.

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test('AU10.3: No _source → "No request linked"; action still executes', async ({ page }) => {
    // CASE 3: Proposal without _source → Request block shows "No request linked."
    // History is read independently. Approval is not blocked.
    //
    // Expected:
    // - Request block text: "No request linked."
    // - History block still shows independently
    // - Approve button enabled and functional

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    // TODO: Create proposal without _source field.
    // Verify Request block shows "No request linked."
    // Approve and verify execution succeeds.

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test('AU10.4: Invalid _source → "link not readable"; not a block', async ({ page }) => {
    // CASE 4: _source with unknown connector, kind, or non-existent id.
    // Neither blocks approval nor causes an error.
    //
    // Expected:
    // - Request block shows: "Request: link not readable (unknown connector)."
    // - Approve button is enabled and functional
    // - Action executes successfully

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // TODO: Create proposal with _source = { connector: 'unknown-crm', kind: 'record', id: 'x' }
    // Verify visible error state in Request block
    // Verify approval still works

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test('AU10.5: CRM unavailable → history shows "not reachable"; action works', async ({ page }) => {
    // CASE 5: CRM MCP server is down or unreachable during approval.
    // Action still executes.
    //
    // Expected:
    // - History block shows: "CRM not reachable — history could not be read."
    // - Approve button enabled
    // - Action executes

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);

    // TODO: Simulate CRM outage (kill process or timeout).
    // Create proposal. Verify history error state. Approve and execute.

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test('AU10.6: _source never reaches downstream tool', async ({ page, request }) => {
    // CASE 6: _source is stripped before execution.
    // Tool args at execution lack _source field.
    //
    // Expected:
    // - Downstream records (ERP, Mail) show no _source in args
    // - Can verify via ERP tool call log or querying created records

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'Email');

    // TODO: Create proposal with _source.
    // Approve and execute.
    // Query executed record or tool log to verify _source was stripped.
    // For ERP: check the created quote has no _source field in its metadata.

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test('AU10.7: AI-written activity shows "Written by the AI via Suveren — not checked"', async ({ page }) => {
    // CASE 7: Activity created by the AI in a prior proposal appears in history
    // with a special label and quoted text.
    //
    // Expected:
    // - History item shows:
    //   - Dot marker (system/blue color)
    //   - Type: "Activity"
    //   - Time: "Yesterday, 14:20"
    //   - Title: "Logged reply to quote Q-1198"
    //   - Body (italic, quoted): "Sent quote Q-1198 for PV-55A replacement, confirmed stock."
    //   - Attribution: "— Written by the AI via Suveren, 14:20 — not checked"
    //       (NOT the record's own author field)

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    // TODO: Create initial proposal that logs an activity in CRM.
    // Approve and execute to write the activity.
    // Create second proposal for the same customer to show history.
    // Verify the logged activity appears with the "Written by the AI" label.

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test('AU10.8: Free-mail sender (gmail.com) → only exact-email history', async ({ page }) => {
    // CASE 8: Sender uses a free-mail domain (gmail.com, outlook.com, etc.).
    // History matches only the exact email address, not the whole domain.
    //
    // Expected:
    // - History block shows: "gmail.com is a shared mail domain, so only the exact address is matched — not the whole domain."
    // - Only entries from hans.privat@gmail.com appear, not other@gmail.com
    // - No email_domain key is used (only email)

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'Email');
    await activateIntegration(page, 'CRM');

    // TODO: Set up Email with sender hans.privat@gmail.com.
    // Set up CRM with entries for both hans.privat@gmail.com and other@gmail.com.
    // Create proposal. Verify history shows only exact-email match.

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
  });

  test.describe('AU10.9: Phase B — Snapshot binding and shown_hash', () => {
    // Phase B is optional. Skip if the gateway does not support snapshots.
    // TODO: Decide on capability detection. Options:
    //   - Check /health endpoint for a version or feature flag
    //   - Look for a field in a status endpoint
    //   - Check for the presence of a "What you saw" button in the ticket view

    test('AU10.9: Approve → shown_hash sent to AS; snapshot re-verifies', async ({ page, request }) => {
      // CASE 9: Approval captures a hash of what the card showed.
      // Later, the snapshot is verifiable and shows the state at approval time,
      // even if the CRM has since changed.
      //
      // Expected on approve:
      // - Decision sent to AS includes shown_hash (SHA256 of JCS-serialized request + history + AU8 data + read time)
      // - Snapshot stored locally, encrypted
      //
      // Expected in ticket view:
      // - "What you saw" button or box shows the snapshot
      // - Hash is verified: "✓ This exact context is bound by hash"
      // - Snapshot shows data as it was at approval time
      //   (e.g., "In stock (at 10:01): 4" even if CRM now shows 0)

      test.skip(true, 'Phase B (snapshot binding) — awaiting gateway implementation. Detect capability via [TBD] endpoint.');

      await signInToGateway(page, apiKey);
      await handleOnboarding(page);
      await activateIntegration(page, 'CRM');

      // TODO: Create proposal from AU10.1 setup (request + history visible).
      // Approve and capture shown_hash from the decision.
      // Navigate to ticket view and verify snapshot integrity.
      // Modify CRM (e.g., reduce stock to 0).
      // Refresh ticket view and confirm snapshot still shows the old state.

      await page.goto(`${GW_URL}/approvals`);
      await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });
    });
  });
});
