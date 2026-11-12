/**
 * Admin 01.02 — the urgent action centre: four tiles, each the module's OWN list for this employee, read through that
 * module's service with exactly the filter its link opens — so the number on the tile is the number of rows the list
 * shows them (the shell's "truth" rule), with the module's permissions, branch limits and field rules applied by the
 * module itself (masked phones, no cost). The first rows come along as a preview.
 *
 *   late_orders          orders.order.read            listOrders, flag "late" (the orders module's late rules:
 *                                                     proof waiting, COD not confirmed, not shipped, not delivered,
 *                                                     pre-order overdue) → /admin/orders?flag=late&sort=placed_asc
 *   unmatched_payments   finance.settlement.reconcile listStatementLines, status "unmatched", the list's longest range
 *                                                     (400 Baghdad days up to today) → /admin/finance/settlements?…
 *   low_stock            inventory.stock.read         listStock, state "low" (available, at or under the reorder point
 *                                                     or the default) → /admin/inventory/stock?state=low&sort=available
 *   critical_tickets     support.ticket.read          listInbox, open tickets of priority "urgent", soonest due first;
 *                                                     + the inbox's "late" view (tickets and repairs past their due
 *                                                     time) → /admin/support?priority=urgent&sort=due · ?view=late
 *
 * Each needs dashboard.alerts.read too. What waits for the employee's own decision (proofs, refunds, approvals…) is
 * the shell's bell (shell/queues.server.ts), which the page reads from the layout's data — no second count here.
 * Each tile is its own call, streamed on its own: a slow module never holds the others.
 */
import type { Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { listStatementLines } from "~/server/services/admin/finance/settlements.server";
import { baghdadDay, dayStart, DAY_MS, MAX_RANGE_DAYS, parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import { listStock, parseStockFilters } from "~/server/services/admin/inventory/stock.server";
import { listOrders } from "~/server/services/admin/orders/list.server";
import { LATE_RULES, listSearch, parseListFilters } from "~/server/services/admin/orders/types";
import { listInbox } from "~/server/services/admin/support/inbox.server";
import { inboxSearch, parseInboxFilters } from "~/server/services/admin/support/types";
import type { AlertTile } from "./types";

/** Rows shown under a tile. */
export const ALERT_PREVIEW = 3;

/** Late orders, oldest first (orders.order.read). */
export async function lateOrdersAlert(db: Db, actor: Actor, locale: Locale, now: number): Promise<AlertTile> {
  assertCan(actor, "dashboard.alerts.read");
  const filters = parseListFilters(new URLSearchParams("flag=late&sort=placed_asc"));
  const page = await listOrders(db, actor, filters, locale, now);
  return {
    id: "late_orders",
    count: page.total,
    href: `/admin/orders${listSearch(filters)}`,
    rows: page.rows.slice(0, ALERT_PREVIEW).map((row) => ({
      key: row.id,
      label: row.ref,
      text: null,
      code: row.flags.find((flag) => LATE_RULES.includes(flag)) ?? null,
      amountIqd: row.totalIqd,
      qty: null,
      at: row.placedAt,
      href: `/admin/orders/${encodeURIComponent(row.ref)}`,
      isDemo: row.isDemo,
    })),
    extra: null,
  };
}

/** The statement range the tile opens: the settlements list's longest range, up to today (Baghdad). */
export function unmatchedRange(now: number) {
  const to = baghdadDay(now);
  const from = baghdadDay(dayStart(to) - (MAX_RANGE_DAYS - 1) * DAY_MS);
  return parseRange(new URLSearchParams({ from, to }), now);
}

/** Imported bank, Zain Cash and carrier statement lines that match no recorded payment (finance.settlement.reconcile). */
export async function unmatchedPaymentsAlert(db: Db, actor: Actor, now: number): Promise<AlertTile> {
  assertCan(actor, "dashboard.alerts.read");
  const range = unmatchedRange(now);
  const page = await listStatementLines(db, actor, { ...range, source: null, status: "unmatched", q: "", page: 1 });
  return {
    id: "unmatched_payments",
    count: page.total,
    href: `/admin/finance/settlements${rangeSearch(range, { status: "unmatched" })}`,
    rows: page.rows.slice(0, ALERT_PREVIEW).map((row) => ({
      key: row.id,
      label: row.reference ?? row.counterparty ?? "",
      text: row.counterparty && row.reference ? row.counterparty : null,
      code: row.source,
      amountIqd: row.amountIqd,
      qty: null,
      at: row.occurredAt,
      href: `/admin/finance/settlements/${encodeURIComponent(row.id)}`,
      isDemo: false,
    })),
    extra: null,
  };
}

/** SKUs whose available stock is low, the lowest first (inventory.stock.read). */
export async function lowStockAlert(db: Db, actor: Actor, locale: Locale): Promise<AlertTile> {
  assertCan(actor, "dashboard.alerts.read");
  const filters = parseStockFilters(new URLSearchParams("state=low&sort=available"));
  const page = await listStock(db, actor, filters, locale);
  return {
    id: "low_stock",
    count: page.total,
    href: "/admin/inventory/stock?state=low&sort=available",
    rows: page.rows.slice(0, ALERT_PREVIEW).map((row) => ({
      key: row.id,
      label: row.sku,
      text: row.name,
      code: null,
      amountIqd: null,
      qty: row.available,
      at: null,
      href: `/admin/inventory/stock/${encodeURIComponent(row.id)}`,
      isDemo: false,
    })),
    extra: null,
  };
}

/** Open urgent tickets, soonest due first, and everything past its due time (support.ticket.read). */
export async function criticalTicketsAlert(db: Db, actor: Actor, now: number): Promise<AlertTile> {
  assertCan(actor, "dashboard.alerts.read");
  const filters = parseInboxFilters(new URLSearchParams("priority=urgent&sort=due"));
  const page = await listInbox(db, actor, filters, now);
  return {
    id: "critical_tickets",
    count: page.total,
    href: `/admin/support${inboxSearch(filters)}`,
    rows: page.rows.slice(0, ALERT_PREVIEW).map((row) => ({
      key: row.id,
      label: row.ref,
      text: row.title,
      code: row.due?.late ? "late" : row.priority,
      amountIqd: null,
      qty: null,
      at: row.due?.at ?? row.createdAt,
      href: row.kind === "repair" ? `/admin/support/repairs/${encodeURIComponent(row.ref)}` : `/admin/support/tickets/${encodeURIComponent(row.ref)}`,
      isDemo: row.isDemo,
    })),
    extra: { count: page.counts.late, href: `/admin/support${inboxSearch({ view: "late" })}` },
  };
}
