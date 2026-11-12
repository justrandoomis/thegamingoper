/**
 * Admin module 01 "dashboard" — who may see which card of the command centre, and the branch a figure is for.
 *
 * Every card needs dashboard.overview.read ("open the dashboard for their role") and its own permission; a card that
 * shows another module's list (an urgent tile, a role card) needs that list's read permission too — the same answer
 * the module's own screen gives, because the tile calls the module's own service (alerts.server.ts, roles.server.ts).
 * The page itself (/admin) is every signed-in employee's home: without dashboard.overview.read it shows only what the
 * shell already knows (what waits for them, their sections).
 *
 *   sales        dashboard.sales.read                                  paid sales, orders, open orders, average basket
 *   result       + cost.read + profit.read                             net profit (finance's profitAndLoss)
 *   alerts       dashboard.alerts.read + the module's read permission  late orders · unmatched payments · low stock ·
 *                                                                      critical tickets
 *   funnel       dashboard.funnel.read                                 carts → orders → paid → delivered
 *   money        finance.report.read                                   cash on delivery outstanding, transfers to verify,
 *                                                                      refunds pending (+ wallet liability: finance.wallet.read)
 *   stock        inventory.stock.read                                  the inventory module's figures (+ to pack: orders.fulfillment.pack)
 *   inbox        support.ticket.read                                   the support inbox's views
 *   activity     dashboard.activity.read                               price changes, returns, approvals — each line by
 *                                                                      its module's read permission (activity.server.ts)
 *   search       dashboard.search.use                                  each group by its module's permission (search.server.ts)
 */
import { asc, eq } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { can, canAll, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { branches } from "~/server/db/schema";
import type { DashboardView, Streamed, ViewAccess } from "./types";

export type DashboardAccess = {
  overview: boolean;
  sales: boolean;
  result: boolean;
  alerts: boolean;
  lateOrders: boolean;
  unmatchedPayments: boolean;
  lowStock: boolean;
  criticalTickets: boolean;
  funnel: boolean;
  money: boolean;
  wallet: boolean;
  stock: boolean;
  toPack: boolean;
  inbox: boolean;
  activity: boolean;
  search: boolean;
};

export function dashboardAccess(actor: Actor): DashboardAccess {
  const overview = can(actor, "dashboard.overview.read");
  const sales = overview && can(actor, "dashboard.sales.read");
  const alerts = overview && can(actor, "dashboard.alerts.read");
  const stock = overview && can(actor, "inventory.stock.read");
  return {
    overview,
    sales,
    result: sales && canAll(actor, ["cost.read", "profit.read"]),
    alerts,
    lateOrders: alerts && can(actor, "orders.order.read"),
    unmatchedPayments: alerts && can(actor, "finance.settlement.reconcile"),
    lowStock: alerts && can(actor, "inventory.stock.read"),
    criticalTickets: alerts && can(actor, "support.ticket.read"),
    funnel: overview && can(actor, "dashboard.funnel.read"),
    money: overview && can(actor, "finance.report.read"),
    wallet: overview && can(actor, "finance.report.read") && can(actor, "finance.wallet.read"),
    stock,
    toPack: stock && canAll(actor, ["orders.order.read", "orders.fulfillment.pack"]),
    inbox: overview && can(actor, "support.ticket.read"),
    activity: overview && can(actor, "dashboard.activity.read"),
    search: can(actor, "dashboard.search.use"),
  };
}

/** The role views this employee has (01.05): a view only when at least one of its cards is theirs. */
export function viewAccess(access: DashboardAccess): ViewAccess {
  return {
    overview: access.overview,
    finance: access.sales || access.money || access.unmatchedPayments,
    warehouse: access.stock || access.lowStock,
    support: access.inbox || access.criticalTickets,
  };
}

/** The view to show: the one asked for when the employee has it, else the overview. */
export function effectiveView(asked: DashboardView, views: ViewAccess): DashboardView {
  return views[asked] ? asked : "overview";
}

/**
 * A card's data as a promise that never rejects: the data, or `{ ok: false }` (logged) — the page then says the part
 * could not be computed, never a 0, and the rest of the page stands. Started at once, awaited by nobody: the loader
 * returns it and React Router streams it.
 */
export function settle<T>(card: string, run: () => Promise<T>): Promise<Streamed<T>> {
  return Promise.resolve()
    .then(run)
    .then(
      (data): Streamed<T> => ({ ok: true, data }),
      (error: unknown): Streamed<T> => {
        console.error(`[dashboard] the ${card} card failed`, error);
        return { ok: false };
      },
    );
}

export type BranchOption = { id: string; code: string; name: string };

/** The active branches (module 21's table), for the branch filter. Empty while the store has none. */
export async function branchOptions(db: Db, locale: Locale): Promise<BranchOption[]> {
  const rows = await db.select({ id: branches.id, code: branches.code, name: branches.name }).from(branches).where(eq(branches.isActive, true)).orderBy(asc(branches.code)).limit(50);
  return rows.map((row) => ({ id: row.id, code: row.code, name: pick(row.name, locale) || row.code }));
}

/**
 * The branch the figures are for: an employee limited to a branch always gets their branch (they cannot ask for the
 * store or another one); anyone else gets the branch they asked for when it exists, else the whole store (null).
 */
export function effectiveBranch(actor: Actor, asked: string | null, options: readonly BranchOption[]): { branch: string | null; locked: boolean } {
  const own = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  if (own) return { branch: own, locked: true };
  return { branch: asked && options.some((option) => option.id === asked) ? asked : null, locked: false };
}
