/**
 * Admin 01.05 — the role cards of the command centre: what concerns the finance manager, the warehouse and support,
 * each only for holders of the permission its module's own screen needs, each figure from that module's own service
 * or from docs/metrics.md:
 *
 *   money   finance.report.read   money held and owed (metrics §5): cash on delivery outstanding, transfers awaiting
 *                                 verification (Σ declared), refunds waiting for a decision; the wallet liability only
 *                                 with finance.wallet.read (Σ wallet ledger, as finance's own home reads it). One batch.
 *   stock   inventory.stock.read  the inventory module's own figures (inventoryOverview — counts to approve only for
 *                                 inventory.count.approve and never one the employee took part in, transfers in transit
 *                                 only for inventory.transfer.receive); orders to pack only for orders.fulfillment.pack,
 *                                 counted with the orders list's own filter (listWhere). The stock value [P] is dropped.
 *   inbox   support.ticket.read   the support inbox's own view counts (inboxCounts): each equals the view its link opens.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { orders, payments, refunds, walletLedger } from "~/server/db/schema";
import { inventoryOverview } from "~/server/services/admin/inventory/analytics.server";
import { listWhere } from "~/server/services/admin/orders/list.server";
import { parseListFilters } from "~/server/services/admin/orders/types";
import { inboxCounts } from "~/server/services/admin/support/inbox.server";
import type { InboxCard, MoneyCard, StockCard } from "./types";

const num = (value: unknown) => Number(value ?? 0);

/** The orders list's "to pack" view: confirmed or being prepared. */
export const TO_PACK_SEARCH = "status=confirmed&status=preparing";

export async function moneyCard(db: Db, actor: Actor, filters: { demo: boolean }): Promise<MoneyCard> {
  assertCan(actor, "finance.report.read");
  const real = filters.demo ? undefined : eq(orders.isDemo, false);
  const withWallet = can(actor, "finance.wallet.read");
  const cod = db
    .select({ n: count(), iqd: sql<number>`coalesce(sum(${payments.amountIqd}), 0)` })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(payments.method, "cod"), eq(payments.status, "pending"), inArray(orders.status, ["shipped", "delivered"]), real));
  const transfers = db
    .select({ n: count(), iqd: sql<number>`coalesce(sum(coalesce(${payments.declaredAmountIqd}, ${payments.amountIqd})), 0)` })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(payments.status, "pending_verification"), real));
  const pending = db
    .select({ n: count(), iqd: sql<number>`coalesce(sum(${refunds.amountIqd}), 0)` })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(and(eq(refunds.status, "pending"), real));
  // the wallet only for who may see it: not even read otherwise (side by side with the batch)
  const [[codRows, transferRows, refundRows], walletIqd] = await Promise.all([
    db.batch([cod, transfers, pending]),
    withWallet
      ? db
          .select({ iqd: sql<number>`coalesce(sum(${walletLedger.amountIqd}), 0)` })
          .from(walletLedger)
          .get()
          .then((row) => num(row?.iqd))
      : Promise.resolve(null),
  ]);
  return {
    codOutstanding: { count: num(codRows[0]?.n), iqd: num(codRows[0]?.iqd) },
    transfersAwaiting: { count: num(transferRows[0]?.n), iqd: num(transferRows[0]?.iqd) },
    refundsPending: { count: num(refundRows[0]?.n), iqd: num(refundRows[0]?.iqd) },
    walletLiability: walletIqd,
    links: {
      // the settlements page shows the same outstanding figure (metrics §5) — with the demo rows the card counted
      cod: can(actor, "finance.settlement.reconcile") ? `/admin/finance/settlements${filters.demo ? "?demo=1" : ""}` : null,
      transfers: can(actor, "orders.payment.verify") ? "/admin/orders/proofs" : null,
      refunds: can(actor, "orders.refund.approve") ? "/admin/orders/refunds" : null,
      wallet: withWallet ? "/admin/finance/wallets" : null,
    },
    demo: filters.demo,
  };
}

export async function stockCard(db: Db, actor: Actor, now: number): Promise<StockCard> {
  assertCan(actor, "inventory.stock.read");
  const packs = can(actor, "orders.order.read") && can(actor, "orders.fulfillment.pack");
  const [overview, toPack] = await Promise.all([
    inventoryOverview(db, actor, now),
    packs
      ? db
          .select({ n: count() })
          .from(orders)
          .where(listWhere(parseListFilters(new URLSearchParams(TO_PACK_SEARCH)), actor, now))
          .get()
          .then((row) => num(row?.n))
      : Promise.resolve(null),
  ]);
  const { totals, decisions, access } = overview;
  return {
    skusInStock: totals.skusInStock,
    available: totals.available,
    incoming: totals.incoming,
    low: totals.low,
    out: totals.out,
    oversold: totals.oversold,
    belowReorder: decisions.belowReorder,
    countsToApprove: access.countApprove ? decisions.countsToApprove : null,
    transfersInTransit: access.transferReceive ? decisions.transfersToReceive : null,
    reservationsExpiring: decisions.reservationsExpiring,
    toPack,
    links: stockLinks(access.countApprove, access.transferReceive, packs),
  };
}

/**
 * The list behind each stock figure, where one counts the same records (tests/admin-dashboard-review.test.ts checks
 * each against its list's total). Units, SKUs with stock, low and below zero have none: the stock list counts every
 * SKU — archived products and inactive variants too — while the overview counts active ones only (asked of the
 * inventory owner); the reorder list counts the overview's SKUs, so "sold out" opens it. The counts to approve open
 * the review list as the inventory home and the bell do (it also shows the counts this employee took part in).
 */
function stockLinks(countApprove: boolean, transferReceive: boolean, packs: boolean): StockCard["links"] {
  return {
    skus: null,
    available: null,
    incoming: null,
    low: null,
    out: "/admin/inventory/reorder?show=out",
    oversold: null,
    belowReorder: "/admin/inventory/reorder?show=below_reorder",
    counts: countApprove ? "/admin/inventory/counts?status=review" : null,
    transfers: transferReceive ? "/admin/inventory/transfers?status=in_transit" : null,
    expiring: "/admin/inventory/reservations?status=expiring",
    toPack: packs ? `/admin/orders?${TO_PACK_SEARCH}` : null,
  };
}

export async function inboxCard(db: Db, actor: Actor, now: number): Promise<InboxCard> {
  assertCan(actor, "support.ticket.read");
  const me = actor.kind === "employee" ? actor.id : "";
  const counts = await inboxCounts(db, me, now);
  return {
    needsReply: counts.needs_reply,
    unassigned: can(actor, "support.ticket.assign") ? counts.unassigned : null,
    late: counts.late,
    escalatedToMe: counts.escalated_me,
    handoffs: counts.handoffs,
    repairs: counts.repairs,
  };
}
