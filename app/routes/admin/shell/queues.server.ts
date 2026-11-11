/**
 * What is waiting for this employee — the shell's notifications slot, the beads on queue rows in the navigation and
 * the "waiting for you" list on the admin home (DESIGN.md §10: "a red dot means exactly one thing: something is
 * waiting for a human").
 *
 * Only real counts, each shown only to employees who hold the permission to act on it and may see its module, and
 * never something the employee may not decide themselves (two-person rules). The page each one opens: queueHref — a
 * list that shows the counted rows to that employee (tests/admin-shell.test.ts "truth" opens each one and compares).
 *
 *   id                  module      permission to act            what is counted
 *   proofs              orders      orders.payment.verify        transfer payments whose proof waits for verification
 *   refunds             orders      orders.refund.approve        refunds waiting for a second person's approval, not
 *                                                                the employee's own — RMA refunds included, so the
 *                                                                returns module adds no refund queue (no double count)
 *   failed_deliveries   shipping    shipping.attempt.manage      parcels whose delivery failed, waiting for "try
 *                                   (+ shipping.shipment.read)   again" or "send back" (countFailedDeliveries)
 *   cod_settlements     shipping    shipping.cod.settle          carrier settlements submitted for reconciliation; one
 *                                                                with a difference never to whoever created, corrected
 *                                                                or submitted it, one carrying cash still to record only
 *                                                                with orders.payment.record (countSettlementsToReconcile)
 *   rmas                returns     returns.rma.approve          returns waiting for a decision, never one the
 *                                   (+ returns.rma.read)         employee opened (the returns module's queueCounts)
 *   inspections         returns     returns.rma.inspect          returns received, waiting for inspection (queueCounts)
 *                                   (+ returns.rma.read)         — without .read the returns list shows only one's own
 *   prices              pricing     pricing.price.approve        price changes waiting for a decision (not the
 *                                                                employee's own request; cuts that need the override
 *                                                                right only for its holders — countDecidable)
 *   counts              inventory   inventory.count.approve      stock counts submitted for approval that the employee
 *                                                                neither started nor counted a line of (now or before a
 *                                                                colleague re-counted it — the counts service's rule)
 *   transfers           inventory   inventory.transfer.receive   transfers between locations on their way
 *   po_approvals        purchasing  purchasing.po.approve        orders above the spending limit, never one the
 *                                   (+ cost.read, po.read)       employee asked for, created, edited or submitted;
 *                                                                branch limits (purchasingQueueCounts, which the
 *                                                                module's home reads too)
 *   stuck_receipts      purchasing  purchasing.receipt.create    receipts whose posting stopped and may be resumed now
 *   invoice_mismatches  purchasing  purchasing.invoice.manage    supplier invoices the three-way match flagged
 *                                   (+ cost.read)
 *   topups              finance     customers.wallet.adjust      wallet top-ups waiting for a decision, not those the
 *                                   (+ finance.wallet.read)      employee already gave the first approval (walletQueue)
 *   adjustments         finance     customers.wallet.adjust      wallet adjustments waiting for a second person, never
 *                                   (+ finance.wallet.read)      the employee's own request (walletQueue)
 *   expenses            finance     finance.expense.manage       draft expenses the employee may approve: not their own
 *                                                                above the limit (countDecidableExpenses) — of any
 *                                                                month, demo ones too, so the link opens the drafts of
 *                                                                the longest range the list shows, demo rows included
 * plus notices about the employee's own account (two-step verification off, few recovery codes left).
 *
 * Read-only and quick: the shell's own counts in one batched round trip, and at the same time (never one after the
 * other) each module's own count function, asked only of the employees it concerns — the modules keep their rules, so
 * the shell and the module's own screens never count differently. A module whose count fails is logged and shows no
 * queue; the other queues and the page still load.
 */
import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { can } from "~/server/actor";
import type { Db } from "~/server/db.server";
import { cycleCounts, employees, payments, refunds, stockTransfers } from "~/server/db/schema";
import type { Permission } from "~/server/permissions";
import { countDecidableExpenses } from "~/server/services/admin/finance/expense-views.server";
import { baghdadDay, dayStart, DAY_MS, MAX_RANGE_DAYS, rangeSearch } from "~/server/services/admin/finance/types";
import { walletQueue } from "~/server/services/admin/finance/wallets.server";
import { countDecidable } from "~/server/services/admin/pricing/prices.server";
import { purchasingQueueCounts } from "~/server/services/admin/purchasing/alerts.server";
import { queueCounts as returnsQueueCounts } from "~/server/services/admin/returns/rma.server";
import { countSettlementsToReconcile } from "~/server/services/admin/shipping/cod.server";
import { countFailedDeliveries } from "~/server/services/admin/shipping/shipments.server";
import { canSeeModule } from "./access.server";

export type ShellQueueId =
  | "proofs"
  | "refunds"
  | "failed_deliveries"
  | "cod_settlements"
  | "rmas"
  | "inspections"
  | "prices"
  | "counts"
  | "transfers"
  | "po_approvals"
  | "stuck_receipts"
  | "invoice_mismatches"
  | "topups"
  | "adjustments"
  | "expenses";
/** The module a queue belongs to (its navigation row carries the bead). */
export type ShellQueueModule = "orders" | "shipping" | "returns" | "pricing" | "inventory" | "purchasing" | "finance";
export type ShellQueue = { id: ShellQueueId; module: ShellQueueModule; count: number; href: string };
export type ShellNotice = { id: "mfa_off" | "recovery_low"; href: string; count?: number };
export type ShellWaiting = { queues: ShellQueue[]; notices: ShellNotice[]; total: number };

/** The page each queue opens: the module's own queue screen (queueHref adds what depends on the day). */
export const QUEUE_HREF: Record<ShellQueueId, string> = {
  proofs: "/admin/orders/proofs",
  refunds: "/admin/orders/refunds",
  failed_deliveries: "/admin/shipping/attempts",
  cod_settlements: "/admin/shipping/cod?status=submitted",
  rmas: "/admin/returns?view=decide",
  inspections: "/admin/returns?view=inspect",
  prices: "/admin/pricing/changes",
  counts: "/admin/inventory/counts?status=review",
  transfers: "/admin/inventory/transfers?status=in_transit",
  po_approvals: "/admin/purchasing/orders?view=pending_approval",
  stuck_receipts: "/admin/purchasing/receipts?state=posting",
  invoice_mismatches: "/admin/purchasing/invoices?status=mismatch",
  topups: "/admin/finance/wallets?status=pending_verification",
  adjustments: "/admin/finance/wallets?tab=adjustments",
  expenses: "/admin/finance/expenses",
};

/**
 * The link of a queue at `now`. The expense list opens on this month's real expenses, while countDecidableExpenses
 * counts every draft — last month's, a demo one — so the link names the list's longest range up to today (Baghdad
 * days, MAX_RANGE_DAYS) and asks for demo rows too: the drafts it lists are the drafts the bell counted. Built with the
 * finance module's own rangeSearch, so the list reads the URL as it writes it.
 */
export function queueHref(id: ShellQueueId, now: number): string {
  if (id !== "expenses") return QUEUE_HREF[id];
  const to = baghdadDay(now);
  const from = baghdadDay(dayStart(to) - (MAX_RANGE_DAYS - 1) * DAY_MS);
  return `${QUEUE_HREF.expenses}${rangeSearch({ period: null, from, to, demo: true }, { status: "draft" })}`;
}

/** At or below this many unused recovery codes the employee is reminded to make new ones. */
export const RECOVERY_CODES_LOW = 3;

/**
 * A module's own counts, or null when they fail: one module's broken query must not take every admin page down (the
 * layout answers 503 when the shell's data fails). Logged; that module then shows no queue at all.
 */
async function moduleCounts<T>(module: ShellQueueModule, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    console.error(`[admin] the ${module} queues failed; the shell shows none of them`, error);
    return null;
  }
}

/** `now` decides the time-bound rules (an expense approved alone in the last 24 hours, a receipt posting's lease). */
export async function loadWaiting(db: Db, session: EmployeeSession, now: number = Date.now()): Promise<ShellWaiting> {
  const { actor, employee } = session;
  const asks = (permission: Permission, module: ShellQueueModule) => can(actor, permission) && canSeeModule(actor, module);
  const wantsProofs = asks("orders.payment.verify", "orders");
  const wantsRefunds = asks("orders.refund.approve", "orders");
  const wantsFailedDeliveries = asks("shipping.attempt.manage", "shipping");
  const wantsSettlements = asks("shipping.cod.settle", "shipping");
  // The returns list (and an RMA's page) shows every RMA only with returns.rma.read; one who may only open RMAs sees
  // their own, never one to decide or inspect — so no returns queue without it.
  const readsReturns = can(actor, "returns.rma.read");
  const wantsRmas = asks("returns.rma.approve", "returns") && readsReturns;
  const wantsInspections = asks("returns.rma.inspect", "returns") && readsReturns;
  const wantsPrices = asks("pricing.price.approve", "pricing");
  const wantsCounts = asks("inventory.count.approve", "inventory");
  const wantsTransfers = asks("inventory.transfer.receive", "inventory");
  const wantsPoApprovals = asks("purchasing.po.approve", "purchasing") && can(actor, "purchasing.po.read");
  const wantsStuckReceipts = asks("purchasing.receipt.create", "purchasing");
  const wantsMismatches = asks("purchasing.invoice.manage", "purchasing");
  const wantsWallet = asks("customers.wallet.adjust", "finance") && can(actor, "finance.wallet.read");
  const wantsExpenses = asks("finance.expense.manage", "finance");

  // The two-person rule of counts (app/server/services/admin/inventory/counts.server.ts, tookPart): an employee who
  // started a count, or recorded any of its lines — now, or before a colleague re-counted them (the audit trail
  // keeps that) — is never asked to approve it.
  const tookPart = sql`(${cycleCounts.startedBy} IS ${employee.id}
    OR EXISTS (SELECT 1 FROM cycle_count_lines AS l WHERE l.count_id = ${cycleCounts.id} AND l.counted_by IS ${employee.id})
    OR EXISTS (SELECT 1 FROM audit_events AS a WHERE a.entity_type = 'cycle_count' AND a.entity_id = ${cycleCounts.id}
               AND a.action = 'inventory.count.record' AND a.actor_kind = 'employee' AND a.actor_id = ${employee.id}))`;

  // Everything at once: the batch and each module's own counts (a module's functions run side by side too).
  const [[proofRows, refundRows, countRows, transferRows, accountRows], prices, shipping, rma, purchasing, finance] = await Promise.all([
    db.batch([
      db
        .select({ n: count() })
        .from(payments)
        .where(wantsProofs ? eq(payments.status, "pending_verification") : eq(payments.id, "")),
      db
        .select({ n: count() })
        .from(refunds)
        .where(wantsRefunds ? and(eq(refunds.status, "pending"), or(isNull(refunds.createdBy), ne(refunds.createdBy, employee.id))) : eq(refunds.id, "")),
      db
        .select({ n: count() })
        .from(cycleCounts)
        .where(wantsCounts ? and(eq(cycleCounts.status, "review"), sql`NOT ${tookPart}`) : eq(cycleCounts.id, "")),
      db
        .select({ n: count() })
        .from(stockTransfers)
        .where(wantsTransfers ? eq(stockTransfers.status, "in_transit") : eq(stockTransfers.id, "")),
      db.select({ recoveryCodes: employees.recoveryCodes }).from(employees).where(eq(employees.id, employee.id)).limit(1),
    ]),
    wantsPrices ? moduleCounts("pricing", () => countDecidable(db, actor)) : null,
    wantsFailedDeliveries || wantsSettlements
      ? moduleCounts("shipping", async () => {
          const [failed, settlements] = await Promise.all([wantsFailedDeliveries ? countFailedDeliveries(db, actor) : null, wantsSettlements ? countSettlementsToReconcile(db, actor) : null]);
          return { failed, settlements };
        })
      : null,
    wantsRmas || wantsInspections ? moduleCounts("returns", () => returnsQueueCounts(db, actor, now)) : null,
    wantsPoApprovals || wantsStuckReceipts || wantsMismatches ? moduleCounts("purchasing", () => purchasingQueueCounts(db, actor, now)) : null,
    wantsWallet || wantsExpenses
      ? moduleCounts("finance", async () => {
          const [wallet, expenses] = await Promise.all([wantsWallet ? walletQueue(db, actor) : null, wantsExpenses ? countDecidableExpenses(db, actor, now) : null]);
          return { wallet, expenses };
        })
      : null,
  ]);

  // In navigation order (sales, stock, money). A module's count is null where its own rule says the employee cannot act.
  const counted: Array<[ShellQueueId, ShellQueueModule, boolean, number | null | undefined]> = [
    ["proofs", "orders", wantsProofs, proofRows[0]?.n],
    ["refunds", "orders", wantsRefunds, refundRows[0]?.n],
    ["failed_deliveries", "shipping", wantsFailedDeliveries, shipping?.failed],
    ["cod_settlements", "shipping", wantsSettlements, shipping?.settlements],
    ["rmas", "returns", wantsRmas, rma?.decide],
    ["inspections", "returns", wantsInspections, rma?.inspect],
    ["prices", "pricing", wantsPrices, prices],
    ["counts", "inventory", wantsCounts, countRows[0]?.n],
    ["transfers", "inventory", wantsTransfers, transferRows[0]?.n],
    ["po_approvals", "purchasing", wantsPoApprovals, purchasing?.approvals],
    ["stuck_receipts", "purchasing", wantsStuckReceipts, purchasing?.stuck],
    ["invoice_mismatches", "purchasing", wantsMismatches, purchasing?.mismatch],
    ["topups", "finance", wantsWallet, finance?.wallet?.topups],
    ["adjustments", "finance", wantsWallet, finance?.wallet?.adjustments],
    ["expenses", "finance", wantsExpenses, finance?.expenses],
  ];
  const queues: ShellQueue[] = [];
  for (const [id, module, wanted, raw] of counted) {
    const n = Number(raw ?? 0) || 0;
    if (wanted && n > 0) queues.push({ id, module, count: n, href: queueHref(id, now) });
  }

  const notices: ShellNotice[] = [];
  if (!employee.totpEnabled) notices.push({ id: "mfa_off", href: "/admin/me#two-step" });
  else {
    const left = accountRows[0]?.recoveryCodes?.length ?? 0;
    if (left <= RECOVERY_CODES_LOW) notices.push({ id: "recovery_low", href: "/admin/me#two-step", count: left });
  }

  return { queues, notices, total: queues.reduce((sum, queue) => sum + queue.count, 0) };
}
