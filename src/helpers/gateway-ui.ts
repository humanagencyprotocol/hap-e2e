/**
 * Gateway UI helpers shared by the browser tests — written to work against
 * both the core-objects UI (UI spec §12: approvals and tickets are rows that
 * open in place) and older gateways (every card rendered open).
 */
import type { Locator, Page } from 'playwright';

/**
 * The approval card for `proposalId` on the Approvals page, opened (approval
 * card v3, UI spec §17). Rows in the list carry `data-proposal-id`; the open
 * card is `[data-testid="approval-card"][data-proposal-id]`. From another open
 * card it goes back to the list first. Older gateways: the row that opens in
 * place, or the card that prints "Proposal: <id>".
 */
export async function openApprovalById(page: Page, proposalId: string, timeout = 30_000): Promise<Locator> {
  const card = page.locator(`[data-testid="approval-card"][data-proposal-id="${proposalId}"]`);
  const row = page.locator(`[data-testid="approval-row"][data-proposal-id="${proposalId}"]`);
  const legacy = page.locator('.card', { hasText: proposalId }).first();
  const back = page.getByTestId('back-to-list');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await card.isVisible().catch(() => false)) return card;
    const head = row.locator('.appr-item-head');
    if (await head.count() && !(await row.getAttribute('class').catch(() => ''))?.includes('is-open')) {
      await head.click();
      await card.waitFor({ timeout: 5_000 }).catch(() => {});
      if (await card.isVisible().catch(() => false)) return card;
      if (await row.count()) return row; // older gateway: the row opened in place
    }
    // A different card is open: back to the list (disabled while a decision is out).
    if (await back.isVisible().catch(() => false)) await back.click({ timeout: 10_000 }).catch(() => {});
    else if (await legacy.isVisible().catch(() => false)) return legacy;
    await page.waitForTimeout(400);
  }
  throw new Error(`No approval ${proposalId} on the Approvals page`);
}

/** Tickets page: open every ticket row so each full record is rendered. */
export async function openAllTickets(page: Page): Promise<void> {
  const heads = page.locator('.ticket-obj-card:not(.is-open) .ticket-obj-head');
  for (let guard = 0; guard < 200 && (await heads.count()) > 0; guard++) {
    await heads.first().click();
  }
}
