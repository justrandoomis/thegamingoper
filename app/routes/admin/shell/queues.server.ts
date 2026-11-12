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
 *   pos_shifts          pos         pos.shift.review             counted shifts with a difference nobody approved yet,
 *                                                                never one the employee opened or closed, within their
 *                                                                branch (countReviewable, the module's own tab count)
 *   privacy_requests    customers   customers.privacy.manage     privacy requests still open (export, erasure,
 *                                                                correction, unsubscribe — privacyCounts.open; nobody
 *                                                                files their own: staff open them for the customer)
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
 *   tradein_inspections devices     devices.tradein.inspect      trade-in requests still to inspect, booked or not
 *   tradein_offers      devices     devices.tradein.offer        inspected trade-ins without an open offer (an offer
 *                                                                past its date included)
 *   tradein_payouts     devices     devices.tradein.payout or    accepted offers this employee can move on (+ a
 *                                   devices.ownership.verify     permission that opens the trade-in list): the data wipe
 *                                                                with ownership.verify while it is not confirmed, the
 *                                                                payout with tradein.payout once it is — never their own
 *                                                                offer that only a second person may pay (payoutsWhere,
 *                                                                the trade-in page's rules; the module's card counts
 *                                                                every accepted one — asked of the devices owner)
 *   used_inspections    devices     devices.used.inspect         used units to inspect or re-inspect, their branch's
 *   used_listings       devices     devices.used.list            used units ready and not listed, their branch's — the
 *                                                                other four devices queues are deviceQueueCounts, the
 *                                                                counts of the module's own cards (each shares its
 *                                                                list's filter)
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
 *                                                                month (an open one: a closed month refuses the
 *                                                                posting), demo ones too, so the link opens the drafts
 *                                                                of the longest range the list shows, demo rows included
 *   signin_alerts       security    security.auth_event.read     abnormal sign-in alerts of the last 24 hours (alertCount,
 *                                                                the module's front-page card and its sign-ins page)
 *   access_reviews      security    security.access_review       roles whose periodic access review is due — never
 *                                   .perform                     reviewed, or not within ACCESS_REVIEW_INTERVAL_DAYS
 *                                                                (reviewsDue, the module's front-page card)
 *   settings_changes    settings    settings.change.approve      settings change requests this employee may decide:
 *                                   (+ settings.read)            never their own, not expired, only keys they may change
 *                                                                (countDecidableSettingChanges)
 * plus notices about the employee's own account (two-step verification off, few recovery codes left).
 *
 * Not in the bell: the security module's flagged refunds (unreviewedCount) — that count includes refunds the reviewer
 * asked for or approved, which reviewRefund refuses them, and reads every refund of 90 days to count (asked of the
 * security owner, docs/areas/admin-shell.md); a devices offer waiting for the customer's answer (nobody here decides).
 *
 * Read-only and quick: the shell's own counts in one batched round trip, and at the same time (never one after the
 * other) each module's own count function, asked only of the employees it concerns — the modules keep their rules, so
 * the shell and the module's own screens never count differently. A module whose count fails is logged and shows no
 * queue; the other queues and the page still load.
 */
import { and, count, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db.server";
import { cycleCounts, employees, payments, refunds, stockTransfers, tradeIns } from "~/server/db/schema";
import type { Permission } from "~/server/permissions";
import { privacyCounts } from "~/server/services/admin/customers/privacy.server";
import { deviceQueueCounts, viewWhere as tradeInViewWhere } from "~/server/services/admin/devices/tradeins.server";
import { countDecidableExpenses } from "~/server/services/admin/finance/expense-views.server";
import { baghdadDay, dayStart, DAY_MS, MAX_RANGE_DAYS, rangeSearch } from "~/server/services/admin/finance/types";
import { walletQueue } from "~/server/services/admin/finance/wallets.server";
import { countReviewable } from "~/server/services/admin/pos/shifts.server";
import { countDecidable } from "~/server/services/admin/pricing/prices.server";
import { purchasingQueueCounts } from "~/server/services/admin/purchasing/alerts.server";
import { queueCounts as returnsQueueCounts } from "~/server/services/admin/returns/rma.server";
import { reviewsDue } from "~/server/services/admin/security/retention.server";
import { alertCount } from "~/server/services/admin/security/signins.server";
import { ACCESS_REVIEW_INTERVAL_DAYS } from "~/server/services/admin/security/types";
import { countDecidableSettingChanges } from "~/server/services/admin/settings/changes.server";
import { countSettlementsToReconcile } from "~/server/services/admin/shipping/cod.server";
import { countFailedDeliveries } from "~/server/services/admin/shipping/shipments.server";
import { canSeeModule } from "./access.server";

export type ShellQueueId =
  | "proofs"
  | "refunds"
  | "pos_shifts"
  | "privacy_requests"
  | "failed_deliveries"
  | "cod_settlements"
  | "rmas"
  | "inspections"
  | "prices"
  | "counts"
  | "transfers"
  | "tradein_inspections"
  | "tradein_offers"
  | "tradein_payouts"
  | "used_inspections"
  | "used_listings"
  | "po_approvals"
  | "stuck_receipts"
  | "invoice_mismatches"
  | "topups"
  | "adjustments"
  | "expenses"
  | "signin_alerts"
  | "access_reviews"
  | "settings_changes";
/** The module a queue belongs to (its navigation row carries the bead). */
export type ShellQueueModule = "orders" | "pos" | "customers" | "shipping" | "returns" | "pricing" | "inventory" | "devices" | "purchasing" | "finance" | "security" | "settings";
export type ShellQueue = { id: ShellQueueId; module: ShellQueueModule; count: number; href: string };
export type ShellNotice = { id: "mfa_off" | "recovery_low"; href: string; count?: number };
export type ShellWaiting = { queues: ShellQueue[]; notices: ShellNotice[]; total: number };

/** The page each queue opens: the module's own queue screen (queueHref adds what depends on the day). */
export const QUEUE_HREF: Record<ShellQueueId, string> = {
  proofs: "/admin/orders/proofs",
  refunds: "/admin/orders/refunds",
  pos_shifts: "/admin/pos/shifts?state=review",
  privacy_requests: "/admin/customers/privacy",
  failed_deliveries: "/admin/shipping/attempts",
  cod_settlements: "/admin/shipping/cod?status=submitted",
  rmas: "/admin/returns?view=decide",
  inspections: "/admin/returns?view=inspect",
  prices: "/admin/pricing/changes",
  counts: "/admin/inventory/counts?status=review",
  transfers: "/admin/inventory/transfers?status=in_transit",
  tradein_inspections: "/admin/devices/trade-ins?view=new",
  tradein_offers: "/admin/devices/trade-ins?view=inspected",
  tradein_payouts: "/admin/devices/trade-ins?view=accepted",
  used_inspections: "/admin/devices/used?view=todo",
  used_listings: "/admin/devices/used?view=ready",
  po_approvals: "/admin/purchasing/orders?view=pending_approval",
  stuck_receipts: "/admin/purchasing/receipts?state=posting",
  invoice_mismatches: "/admin/purchasing/invoices?status=mismatch",
  topups: "/admin/finance/wallets?status=pending_verification",
  adjustments: "/admin/finance/wallets?tab=adjustments",
  expenses: "/admin/finance/expenses",
  signin_alerts: "/admin/security/sign-ins?window=24h",
  access_reviews: "/admin/security/retention#reviews",
  settings_changes: "/admin/settings/changes",
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

/** Who may open the trade-in list (devices' tradeins.server READERS): devices.ownership.verify alone does not. */
const TRADE_IN_READERS: readonly Permission[] = ["devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"];

/**
 * The accepted trade-ins (the list's own "accepted" view, tradeInViewWhere) this employee can move on, by the trade-in
 * page's rules (devices tradeins.server: getTradeInDetail's `can.wipe` and payoutBlockers, enforced by confirmWipe and
 * payOut):
 *   · the data wipe — devices.ownership.verify — while it is not confirmed;
 *   · the payout — devices.tradein.payout — once it is, never the employee's own offer that a second person must pay
 *     (payoutNeedsSecond: above the guide's suggestion, without a suggestion, or on a guide the offerer set themselves,
 *     all read from the trade-in's latest `offered` event, ordered as lastOfferEvent orders them).
 * The module's own card (deviceQueueCounts.toPay) counts every accepted trade-in for either permission, so it can ask
 * someone for a wipe they cannot confirm, a payout before the wipe, or their own offer — the bell does not (asked of the
 * devices owner to count the same way). Null when the employee holds neither permission.
 */
export function payoutsWhere(actor: Actor, employeeId: string, now: number): SQL | null {
  const wipes = can(actor, "devices.ownership.verify");
  const pays = can(actor, "devices.tradein.payout");
  if (!wipes && !pays) return null;
  const ownOfferForASecondPayer = sql`(${tradeIns.offeredBy} = ${employeeId} AND ${tradeIns.finalOfferIqd} IS NOT NULL AND coalesce((
      SELECT CASE
        WHEN json_extract(e.data, '$.guideBy') = ${tradeIns.offeredBy} THEN 1
        WHEN json_type(e.data, '$.suggestedIqd') IS NOT 'integer' THEN 1
        WHEN ${tradeIns.finalOfferIqd} > json_extract(e.data, '$.suggestedIqd') THEN 1
        ELSE 0
      END
      FROM trade_in_events AS e WHERE e.trade_in_id = ${tradeIns.id} AND e.kind = 'offered' ORDER BY e.at DESC, e.id DESC LIMIT 1), 1) = 1)`;
  const steps: SQL[] = [];
  if (wipes) steps.push(sql`coalesce(${tradeIns.dataWiped}, 0) = 0`);
  if (pays) steps.push(sql`(${tradeIns.dataWiped} = 1 AND NOT ${ownOfferForASecondPayer})`);
  return and(tradeInViewWhere("accepted", now), or(...steps)) as SQL;
}

/**
 * `now` decides the time-bound rules (an expense approved alone in the last 24 hours, a receipt posting's lease, an
 * offer or a settings request past its date, the alerts' 24 hours, a review that is due): the request's clock
 * (ctx.now — shell.server.ts passes it), the real clock only when no request is behind the call.
 */
export async function loadWaiting(db: Db, session: EmployeeSession, now: number = Date.now()): Promise<ShellWaiting> {
  const { actor, employee } = session;
  const asks = (permission: Permission, module: ShellQueueModule) => can(actor, permission) && canSeeModule(actor, module);
  const wantsProofs = asks("orders.payment.verify", "orders");
  const wantsRefunds = asks("orders.refund.approve", "orders");
  const wantsShifts = asks("pos.shift.review", "pos");
  const wantsPrivacy = asks("customers.privacy.manage", "customers");
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
  const wantsTradeinInspections = asks("devices.tradein.inspect", "devices");
  const wantsTradeinOffers = asks("devices.tradein.offer", "devices");
  // Accepted trade-ins wait for the wipe (ownership.verify) or the payout; their list needs a trade-in permission.
  const wantsTradeinPayouts = (asks("devices.tradein.payout", "devices") || asks("devices.ownership.verify", "devices")) && canAny(actor, TRADE_IN_READERS);
  const wantsUsedInspections = asks("devices.used.inspect", "devices");
  const wantsUsedListings = asks("devices.used.list", "devices");
  const wantsDevices = wantsTradeinInspections || wantsTradeinOffers || wantsTradeinPayouts || wantsUsedInspections || wantsUsedListings;
  const wantsPoApprovals = asks("purchasing.po.approve", "purchasing") && can(actor, "purchasing.po.read");
  const wantsStuckReceipts = asks("purchasing.receipt.create", "purchasing");
  const wantsMismatches = asks("purchasing.invoice.manage", "purchasing");
  const wantsWallet = asks("customers.wallet.adjust", "finance") && can(actor, "finance.wallet.read");
  const wantsExpenses = asks("finance.expense.manage", "finance");
  const wantsAlerts = asks("security.auth_event.read", "security");
  const wantsAccessReviews = asks("security.access_review.perform", "security");
  // The requests are listed on /admin/settings/changes, which needs settings.read.
  const wantsSettingChanges = asks("settings.change.approve", "settings") && can(actor, "settings.read");

  // The two-person rule of counts (app/server/services/admin/inventory/counts.server.ts, tookPart): an employee who
  // started a count, or recorded any of its lines — now, or before a colleague re-counted them (the audit trail
  // keeps that) — is never asked to approve it.
  const tookPart = sql`(${cycleCounts.startedBy} IS ${employee.id}
    OR EXISTS (SELECT 1 FROM cycle_count_lines AS l WHERE l.count_id = ${cycleCounts.id} AND l.counted_by IS ${employee.id})
    OR EXISTS (SELECT 1 FROM audit_events AS a WHERE a.entity_type = 'cycle_count' AND a.entity_id = ${cycleCounts.id}
               AND a.action = 'inventory.count.record' AND a.actor_kind = 'employee' AND a.actor_id = ${employee.id}))`;

  // Everything at once: the batch and each module's own counts (a module's functions run side by side too).
  const [[proofRows, refundRows, countRows, transferRows, accountRows], prices, shipping, rma, purchasing, finance, shifts, privacy, devices, security, settingChanges] = await Promise.all([
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
    wantsShifts ? moduleCounts("pos", () => countReviewable(db, actor)) : null,
    wantsPrivacy ? moduleCounts("customers", () => privacyCounts(db, actor, now)) : null,
    wantsDevices
      ? moduleCounts("devices", async () => {
          // the module's own counts, but the payouts by what this employee can do there (payoutsWhere) — side by side
          const payouts = wantsTradeinPayouts ? payoutsWhere(actor, employee.id, now) : null;
          const [counts, toPay] = await Promise.all([
            deviceQueueCounts(db, actor, now),
            payouts
              ? db
                  .select({ n: count() })
                  .from(tradeIns)
                  .where(payouts)
                  .get()
                  .then((row) => Number(row?.n ?? 0))
              : null,
          ]);
          return { ...counts, toPay };
        })
      : null,
    wantsAlerts || wantsAccessReviews
      ? moduleCounts("security", async () => {
          const [alerts, reviews] = await Promise.all([wantsAlerts ? alertCount(db, actor, now) : null, wantsAccessReviews ? reviewsDue(db, now, ACCESS_REVIEW_INTERVAL_DAYS) : null]);
          return { alerts, reviews };
        })
      : null,
    wantsSettingChanges ? moduleCounts("settings", () => countDecidableSettingChanges(db, actor, now)) : null,
  ]);

  // In navigation order (sales, stock, money, team, system). A module's count is null where its own rule says the
  // employee cannot act.
  const counted: Array<[ShellQueueId, ShellQueueModule, boolean, number | null | undefined]> = [
    ["proofs", "orders", wantsProofs, proofRows[0]?.n],
    ["refunds", "orders", wantsRefunds, refundRows[0]?.n],
    ["pos_shifts", "pos", wantsShifts, shifts],
    ["privacy_requests", "customers", wantsPrivacy, privacy?.open],
    ["failed_deliveries", "shipping", wantsFailedDeliveries, shipping?.failed],
    ["cod_settlements", "shipping", wantsSettlements, shipping?.settlements],
    ["rmas", "returns", wantsRmas, rma?.decide],
    ["inspections", "returns", wantsInspections, rma?.inspect],
    ["prices", "pricing", wantsPrices, prices],
    ["counts", "inventory", wantsCounts, countRows[0]?.n],
    ["transfers", "inventory", wantsTransfers, transferRows[0]?.n],
    ["tradein_inspections", "devices", wantsTradeinInspections, devices?.toInspect],
    ["tradein_offers", "devices", wantsTradeinOffers, devices?.toOffer],
    ["tradein_payouts", "devices", wantsTradeinPayouts, devices?.toPay],
    ["used_inspections", "devices", wantsUsedInspections, devices?.unitsToInspect],
    ["used_listings", "devices", wantsUsedListings, devices?.toList],
    ["po_approvals", "purchasing", wantsPoApprovals, purchasing?.approvals],
    ["stuck_receipts", "purchasing", wantsStuckReceipts, purchasing?.stuck],
    ["invoice_mismatches", "purchasing", wantsMismatches, purchasing?.mismatch],
    ["topups", "finance", wantsWallet, finance?.wallet?.topups],
    ["adjustments", "finance", wantsWallet, finance?.wallet?.adjustments],
    ["expenses", "finance", wantsExpenses, finance?.expenses],
    ["signin_alerts", "security", wantsAlerts, security?.alerts],
    ["access_reviews", "security", wantsAccessReviews, security?.reviews],
    ["settings_changes", "settings", wantsSettingChanges, settingChanges],
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
