/**
 * Gateway UI helpers shared by the browser tests — written to work against
 * both the core-objects UI (UI spec §12: approvals and tickets are rows that
 * open in place) and older gateways (every card rendered open).
 */
import type { Locator, Page } from 'playwright';

/**
 * The approval for `proposalId` on the Approvals page, opened. New gateways
 * mark each row with `data-proposal-id` (the card itself no longer prints the
 * id); older ones print "Proposal: <id>" in the card footer.
 */
export async function openApprovalById(page: Page, proposalId: string, timeout = 30_000): Promise<Locator> {
  const row = page.locator(`[data-testid="approval-row"][data-proposal-id="${proposalId}"]`);
  const legacy = page.locator('.card', { hasText: proposalId }).first();
  await row.or(legacy).first().waitFor({ timeout });
  if (await row.count()) {
    if (!(await row.getAttribute('class'))?.includes('is-open')) await row.locator('.appr-item-head').click();
    return row;
  }
  return legacy;
}

/** Tickets page: open every ticket row so each full record is rendered. */
export async function openAllTickets(page: Page): Promise<void> {
  const heads = page.locator('.ticket-obj-card:not(.is-open) .ticket-obj-head');
  for (let guard = 0; guard < 200 && (await heads.count()) > 0; guard++) {
    await heads.first().click();
  }
}
