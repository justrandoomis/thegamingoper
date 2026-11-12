/**
 * What the command centre's header and KPI row link to, for one employee and one set of filters (admin 01.01): the
 * quick actions they really have and the list behind each figure. Server only: it reads permissions; the page gets
 * plain booleans and paths.
 */
import { can, type Actor } from "~/server/actor";
import type { StoreMode } from "~/server/context.server";
import { periodSpans, type DashboardFilters } from "~/server/services/admin/dashboard/types";
import { baghdadDay, rangeSearch } from "~/server/services/admin/finance/types";
import { listSearch, OPEN_STATUSES } from "~/server/services/admin/orders/types";
import { mayOpenReport } from "~/server/services/admin/reports/shared.server";
import type { KpiLinks } from "./components/cards";

/** The header's quick actions, each only for holders of the permission its page's own loader asks for. */
export type QuickActions = { sale: boolean; product: boolean };

export function quickActions(actor: Actor): QuickActions {
  return {
    // /admin/pos/sell (pos.sale.create — routes/admin/pos/sell.tsx)
    sale: can(actor, "pos.sale.create"),
    // /admin/catalog/new (catalog.product.create — routes/admin/catalog/new-product.tsx)
    product: can(actor, "catalog.product.create"),
  };
}

/**
 * Whether the row's "open profit and loss" link is theirs: the net figure needs cost.read + profit.read, the report
 * itself (/admin/finance/reports, 10.06) finance.report.read — a role may hold the first without the second.
 */
export function mayOpenProfitAndLoss(actor: Actor): boolean {
  return can(actor, "finance.report.read");
}

/**
 * The list behind each KPI — only where that list counts the same records:
 *   paid sales, average basket → the sales report (18.01) for the same days and demo choice: they are its own
 *                                operational figures (docs/metrics.md §3); not for a branch (the report has none) and
 *                                only for who may open it (reports.sales.read, the whole company)
 *   new orders, open orders    → the orders list for the same days / the open statuses (orders.order.read); that list
 *                                has no demo filter, so only when the figures include the demo rows or the store is
 *                                live (STORE_MODE: a demo store's orders are all demo), and no branch
 *   net profit                 → profit and loss (10.06, finance.report.read) for the same days and demo choice
 */
export function kpiLinks(actor: Actor, filters: DashboardFilters, storeMode: StoreMode, now: number): KpiLinks {
  const spans = periodSpans(filters.period, now);
  const range = { period: null, from: baghdadDay(spans.current.from), to: baghdadDay(now), demo: filters.demo };
  const wholeStore = filters.branch === null;
  const sameOrders = wholeStore && (filters.demo || storeMode === "live") && can(actor, "orders.order.read");
  return {
    sales: wholeStore && mayOpenReport(actor, "sales") ? `/admin/reports/sales${rangeSearch(range)}` : null,
    orders: sameOrders ? `/admin/orders${listSearch({ from: range.from, to: range.to })}` : null,
    open: sameOrders ? `/admin/orders${listSearch({ status: [...OPEN_STATUSES] })}` : null,
    net: wholeStore && can(actor, "finance.report.read") ? `/admin/finance/reports${rangeSearch(range)}` : null,
  };
}
