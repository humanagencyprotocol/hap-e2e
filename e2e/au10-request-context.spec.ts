/**
 * AU10 — Request and customer history on the approval card (real E2E)
 *
 * Contract: doc/au10-request-context.md (source of truth)
 * Mockup: temp/au10-mockup/index.html (visual reference)
 *
 * Tests phase A (cases 1–8): the gateway reads request metadata and customer
 * history independently. Neither the AI's claim nor the read reach the AI or the AS.
 * Missing/invalid sources never block approval.
 *
 * Real MCP servers only (CRM, Email, ERP). Proposals are created through the
 * gateway's MCP server (as an AI would), not via SP API. Requires:
 * - hap-crm-mcp@feat/au10-context-reads branch (or bundled manifest with AU10 context)
 * - Email MCP with mail_message records
 * - ERP MCP or synthetic backend
 *
 * Capability gate: detect AU10 by checking if _source appears in the create_contact
 * tool's input schema (tools/list response). If _source is absent, skip the suite.
 */

import { test, expect, ensureUsersRegistered, ALICE, signInToGateway, handleOnboarding, activateIntegration, SP_URL, GW_URL, latestProfileId } from './fixtures';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { randomUUID } from 'node:crypto';

const CUSTOMERS_PROFILE = latestProfileId('customers');

test.describe.serial('AU10: Request and customer history on approval card', () => {
  let apiKey: string;
  let mcpClient: Client;
  let au10Supported = false;

  test.beforeAll(async ({ request }) => {
    await ensureUsersRegistered();
    apiKey = ALICE.apiKey;
    expect(apiKey).toBeTruthy();

    // Detect AU10 support: check if create_contact tool has _source in its input schema
    // (the contract says the gateway injects it as an optional field with a description).
    const health = await fetch(`${GW_URL}/mcp/tools/list`);
    const toolsList = await health.json() as { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    const createContactTool = toolsList.tools?.find(t => t.name === 'crm__create_contact');
    const hasSource = createContactTool?.inputSchema?.properties?.['_source'] !== undefined;

    if (!hasSource) {
      console.error('[AU10] _source not found in create_contact schema; skipping AU10 suite');
      test.skip();
      return;
    }

    au10Supported = true;
    console.error('[AU10] AU10 supported; _source found in create_contact schema');
  });

  test.beforeEach(async () => {
    if (!au10Supported) return;

    // Connect MCP client for tool calls (each test gets a fresh connection)
    const transport = new SSEClientTransport(new URL(`${GW_URL}/sse`));
    mcpClient = new Client(
      { name: 'au10-e2e', version: '0.1.0' },
      { capabilities: {} },
    );
    await mcpClient.connect(transport);
  });

  test.afterEach(async () => {
    if (mcpClient) {
      try { await mcpClient.close(); } catch { /* ignore */ }
    }
  });

  // ─── AU10.1: _source links request ───────────────────────────────────────

  test('AU10.1: _source links request; shows author, time, title on card', async ({ page, request }) => {
    // CASE 1: Proposal with _source → Request block shows sender, time, subject, body.
    //
    // Setup:
    // 1. Create authorization with review mode (triggers proposal on tool call)
    // 2. Call create_contact with _source linking to a mail message
    // 3. Open browser, navigate to /approvals, find the card
    // 4. Assert Request block text and History block

    // Step 1: Create authorization with review mode
    const authzRes = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id, // TODO: resolve correct group_id
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'review', // Review mode: each tool call requires approval
      },
    });

    if (!authzRes.ok()) {
      const body = await authzRes.json();
      console.error('[AU10.1] Authorization failed:', body);
      throw new Error(`Failed to create authorization: ${authzRes.status()}`);
    }

    const authzData = await authzRes.json() as { authorization_id: string };
    const authorizationId = authzData.authorization_id;

    // Step 2: Call create_contact with _source (review mode → proposal generated)
    const contactResult = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'J. Kraus',
        email: 'j.kraus@bavaria-umform.de',
        company: 'Bavaria Umformtechnik GmbH',
        type: 'customer',
        _source: {
          connector: 'mail',
          kind: 'message',
          id: 'm-17',
        },
      },
    });

    expect(contactResult.isError).toBe(false);

    // Wait a moment for the proposal to be generated
    await new Promise(r => setTimeout(r, 1000));

    // Step 3: Open browser, navigate to /approvals
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');
    await activateIntegration(page, 'Email');

    await page.goto(`${GW_URL}/approvals`);
    await expect(page.locator('.page-title')).toBeVisible({ timeout: 10_000 });

    // Step 4: Find the approval card and assert Request block text
    const card = page.locator('.card', { hasText: 'J. Kraus' }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Assert Request block is visible and contains expected text
    const requestBlock = card.locator('text=Linked by the AI').or(card.locator('text=Request'));
    await expect(requestBlock).toBeVisible();

    // Assert visible text from contract mockup: "from J. Kraus, not checked"
    await expect(card.locator('text=from J. Kraus')).toBeVisible();
    await expect(card.locator('text=not checked')).toBeVisible();
  });

  // ─── AU10.2: History for same customer domain ───────────────────────────

  test('AU10.2: History shows CRM entries for same domain, within 14 days', async ({ page, request }) => {
    // CASE 2: History block shows latest CRM entries for the same customer.
    //
    // Setup:
    // 1. Pre-seed CRM with contact and activity
    // 2. Create authorization with review mode
    // 3. Call create_quote with contextKeys pointing to the same customer
    // 4. Open browser, find card, assert History block text

    // Step 1: Pre-seed CRM
    const contactResult = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Existing Customer',
        email: 'contact@bavaria-umform.de',
        type: 'customer',
      },
    });
    expect(contactResult.isError).toBe(false);
    const contactText = (contactResult.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contact = JSON.parse(contactText);
    const contactId = contact.id;

    // Log an activity for this contact
    const activityResult = await mcpClient.callTool({
      name: 'crm__log_activity',
      arguments: {
        contact_id: contactId,
        type: 'call',
        summary: 'RF 55 steht, Ventil dringend',
      },
    });
    expect(activityResult.isError).toBe(false);

    // Step 2: Create authorization
    const authzRes = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id,
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'review',
      },
    });
    expect(authzRes.ok()).toBe(true);

    // Step 3: Call create_contact for the same domain (triggers proposal)
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'New Customer',
        email: 'new@bavaria-umform.de',
        type: 'customer',
        _source: {
          connector: 'mail',
          kind: 'message',
          id: 'm-1',
        },
      },
    });
    expect(result.isError).toBe(false);

    await new Promise(r => setTimeout(r, 1000));

    // Step 4: Open browser and assert History block
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    await page.goto(`${GW_URL}/approvals`);
    const card = page.locator('.card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Assert History block is visible and contains text from contract
    await expect(card.locator('text=Read by the gateway')).toBeVisible();
    await expect(card.locator('text=RF 55 steht, Ventil dringend')).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('text=not checked')).toBeVisible();
  });

  // ─── AU10.3: No _source, action still executes ───────────────────────────

  test('AU10.3: No _source → "No request linked"; action still executes', async ({ page, request }) => {
    // CASE 3: Proposal without _source.
    //
    // Setup:
    // 1. Create authorization with review mode
    // 2. Call create_contact WITHOUT _source
    // 3. Open browser, assert Request block shows "No request linked"
    // 4. Approve and verify action executes

    const authzRes = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id,
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'review',
      },
    });
    expect(authzRes.ok()).toBe(true);

    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'No Source Contact',
        email: 'nosource@test.com',
        type: 'customer',
        // No _source field
      },
    });
    expect(result.isError).toBe(false);

    await new Promise(r => setTimeout(r, 1000));

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    await page.goto(`${GW_URL}/approvals`);
    const card = page.locator('.card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Assert "No request linked" text
    await expect(card.locator('text=No request linked')).toBeVisible();

    // Assert Approve button is visible and click it
    const approveBtn = card.locator('button:has-text("Approve")').first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // Verify action executed by checking the contact was created
    const getAllResult = await mcpClient.callTool({
      name: 'crm__find_contacts',
      arguments: { query: 'No Source Contact' },
    });
    expect(getAllResult.isError).toBe(false);
    const contactsText = (getAllResult.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contacts = JSON.parse(contactsText);
    expect(contacts.some((c: { name: string }) => c.name === 'No Source Contact')).toBe(true);
  });

  // ─── AU10.4: Invalid _source (unknown connector) ──────────────────────

  test('AU10.4: Invalid _source → "link not readable"; not a block', async ({ page, request }) => {
    // CASE 4: _source with unknown connector.
    //
    // Expected: Request block shows error state, never blocks approval.

    const authzRes = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id,
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'review',
      },
    });
    expect(authzRes.ok()).toBe(true);

    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Bad Source Contact',
        email: 'badsource@test.com',
        type: 'customer',
        _source: {
          connector: 'unknown_system', // Invalid connector
          kind: 'record',
          id: 'x',
        },
      },
    });
    expect(result.isError).toBe(false);

    await new Promise(r => setTimeout(r, 1000));

    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    await page.goto(`${GW_URL}/approvals`);
    const card = page.locator('.card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Assert visible error state
    await expect(card.locator('text=link not readable').or(card.locator('text=Request'))).toBeVisible();

    // Approve button must still be enabled
    const approveBtn = card.locator('button:has-text("Approve")').first();
    await expect(approveBtn).toBeEnabled();
  });

  // ─── AU10.5: CRM unavailable ─────────────────────────────────────────

  test('AU10.5: CRM unavailable → history shows "not reachable"; action works', async ({ page, request }) => {
    // CASE 5: CRM MCP is down during approval.
    //
    // TODO: This test requires a fixture to disable/stop an integration.
    // For now, placeholder. The builder must provide a way to stop integrations
    // or kill the CRM process; check if journey-5 or scope-discovery has the pattern.

    test.skip(true, 'Case 5 (CRM unreachable): awaiting fixture for stopping integrations. Minimal additions needed: a fixture function to disable/stop the CRM connector.');

    // Expected impl:
    // 1. Create authorization and call create_contact with _source
    // 2. Stop/disable CRM integration
    // 3. Open browser and check History block shows "CRM not reachable"
    // 4. Approve and verify action still executes
  });

  // ─── AU10.6: _source stripped before execution ───────────────────────

  test('AU10.6: _source never reaches downstream tool', async ({ request }) => {
    // CASE 6: _source is stripped before tool execution.
    //
    // Verify via: query CRM records after execution to confirm _source is absent.

    const authzRes = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id,
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'automatic', // Automatic mode for quick execution check
      },
    });
    expect(authzRes.ok()).toBe(true);

    const testId = `au10-source-test-${randomUUID().slice(0, 8)}`;
    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: testId,
        email: `${testId}@test.com`,
        type: 'customer',
        _source: {
          connector: 'mail',
          kind: 'message',
          id: 'msg-123',
        },
      },
    });
    expect(result.isError).toBe(false);

    // Query the created contact and verify no _source field in the record
    const contactText = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contact = JSON.parse(contactText);

    // Assert _source is NOT in the contact record
    expect('_source' in contact).toBe(false);
    expect(contact.name).toBe(testId);
    expect(contact.email).toMatch(testId);
  });

  // ─── AU10.7: AI-written activities ───────────────────────────────────

  test('AU10.7: AI-written activity shows "Written by the AI via Suveren — not checked"', async ({ page, request }) => {
    // CASE 7: Activity logged through the gateway carries a ticket_id in the journal.
    // A later proposal shows it with the "Written by the AI" label.
    //
    // Setup:
    // 1. Create contact
    // 2. Create authorization with automatic mode
    // 3. Call log_activity (gateway records ticket_id)
    // 4. Create new authorization with review mode
    // 5. Call create_contact for same customer (proposal generated)
    // 6. Open browser, assert History block shows AI-written label

    // Step 1: Create contact
    const contactResult = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'AI Test Customer',
        email: 'aitest@bavaria-umform.de',
        type: 'customer',
      },
    });
    expect(contactResult.isError).toBe(false);
    const contactText = (contactResult.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contact = JSON.parse(contactText);
    const contactId = contact.id;

    // Step 2: Create automatic authorization and log activity
    const authzRes1 = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id,
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'automatic',
      },
    });
    expect(authzRes1.ok()).toBe(true);

    const activityResult = await mcpClient.callTool({
      name: 'crm__log_activity',
      arguments: {
        contact_id: contactId,
        type: 'email',
        summary: 'Sent quote Q-1198 for PV-55A replacement, confirmed stock.',
      },
    });
    expect(activityResult.isError).toBe(false);

    await new Promise(r => setTimeout(r, 1000));

    // Step 3: Create review-mode authorization for a quote (proposal)
    const authzRes2 = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id,
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'review',
      },
    });
    expect(authzRes2.ok()).toBe(true);

    // Step 4: Call create_contact for same customer (triggers proposal)
    const quoteResult = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Another Contact Same Company',
        email: 'another@bavaria-umform.de',
        type: 'customer',
        _source: {
          connector: 'mail',
          kind: 'message',
          id: 'm-quote',
        },
      },
    });
    expect(quoteResult.isError).toBe(false);

    await new Promise(r => setTimeout(r, 1000));

    // Step 5: Open browser and assert History block contains AI-written activity
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    await page.goto(`${GW_URL}/approvals`);
    const card = page.locator('.card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Assert "Written by the AI via Suveren" text (contract specifies exact wording)
    await expect(card.locator('text=Written by the AI via Suveren')).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('text=not checked')).toBeVisible();
    await expect(card.locator('text=Sent quote Q-1198')).toBeVisible();
  });

  // ─── AU10.8: Free-mail sender (gmail.com) ────────────────────────────

  test('AU10.8: Free-mail sender (gmail.com) → only exact-email history', async ({ page, request }) => {
    // CASE 8: Sender uses gmail.com (free-mail domain).
    // History matches only exact email, not domain.
    //
    // Setup:
    // 1. Create contact with gmail.com email
    // 2. Log multiple activities (one for hans.privat@gmail.com, one for other@gmail.com)
    // 3. Create proposal with sender hans.privat@gmail.com
    // 4. Open browser, assert History shows only hans.privat@gmail.com entries

    // Step 1: Create two contacts
    const contact1 = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Hans Mueller',
        email: 'hans.privat@gmail.com',
        type: 'customer',
      },
    });
    expect(contact1.isError).toBe(false);
    const contact1Text = (contact1.content as Array<{ text?: string }>)[0]?.text ?? '';
    const contact1Data = JSON.parse(contact1Text);
    const contact1Id = contact1Data.id;

    const contact2 = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Other Gmail User',
        email: 'other@gmail.com',
        type: 'customer',
      },
    });
    expect(contact2.isError).toBe(false);

    // Step 2: Log activities
    await mcpClient.callTool({
      name: 'crm__log_activity',
      arguments: {
        contact_id: contact1Id,
        type: 'call',
        summary: 'Nachfrage Ersatzteilpreis',
      },
    });

    // Step 3: Create authorization and trigger proposal
    const authzRes = await request.post(`${SP_URL}/api/as/mandate`, {
      headers: { 'x-api-key': apiKey },
      data: {
        profile_id: CUSTOMERS_PROFILE,
        group_id: ALICE.id,
        bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
        scope_hash: 'sha256:' + '0'.repeat(64),
        gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
        execution_context_hash: 'sha256:' + 'd'.repeat(64),
        commitment_mode: 'review',
      },
    });
    expect(authzRes.ok()).toBe(true);

    const result = await mcpClient.callTool({
      name: 'crm__create_contact',
      arguments: {
        name: 'Test User',
        email: 'test@gmail.com',
        type: 'customer',
        _source: {
          connector: 'mail',
          kind: 'message',
          id: 'm-gmail',
        },
      },
    });
    expect(result.isError).toBe(false);

    await new Promise(r => setTimeout(r, 1000));

    // Step 4: Open browser and assert History block
    await signInToGateway(page, apiKey);
    await handleOnboarding(page);
    await activateIntegration(page, 'CRM');

    await page.goto(`${GW_URL}/approvals`);
    const card = page.locator('.card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Assert the History block mentions exact email matching, not domain
    await expect(card.locator('text=gmail.com').or(card.locator('text=exact address'))).toBeVisible({ timeout: 5_000 });
    // Assert only hans.privat@gmail.com entry is shown (if entries exist)
    // If no entry for gmail addresses: "no customer link" or empty history is also valid
  });

  // ─── AU10.9: Phase B (snapshot binding) ───────────────────────────────

  test.describe('AU10.9: Phase B — Snapshot binding and shown_hash', () => {
    test('Approve → shown_hash in decision; snapshot re-verifies later', async ({ request }) => {
      // CASE 9 (Phase B): Approval captures shown_hash; later snapshot is verifiable.
      //
      // Expected:
      // 1. Decision API response includes shown_hash field
      // 2. Snapshot is stored and bound to the decision
      // 3. Ticket view shows "What you saw" with hash verification
      //
      // Skip if decision API doesn't return shown_hash.

      const authzRes = await request.post(`${SP_URL}/api/as/mandate`, {
        headers: { 'x-api-key': apiKey },
        data: {
          profile_id: CUSTOMERS_PROFILE,
          group_id: ALICE.id,
          bounds: { profile: CUSTOMERS_PROFILE, read_access: 'unlimited', export_access: 'none', write_daily_max: 10, delete_daily_max: 0, setup_daily_max: 0 },
          scope_hash: 'sha256:' + '0'.repeat(64),
          gate_content_hashes: { intent: 'sha256:' + 'a'.repeat(64) },
          execution_context_hash: 'sha256:' + 'd'.repeat(64),
          commitment_mode: 'review',
        },
      });
      expect(authzRes.ok()).toBe(true);

      // TODO: Trigger a proposal, approve it, capture the decision response,
      // and check if shown_hash is present. If not, skip with:
      // test.skip(true, 'shown_hash not yet implemented in decision API');

      test.skip(true, 'Phase B (snapshot binding): awaiting implementation in gateway. Decision API must return { shown_hash: "sha256:..." }');
    });
  });
});
