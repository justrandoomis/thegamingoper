/**
 * What is waiting for this employee — the shell's notifications slot, the beads on queue rows in the navigation and
 * the "waiting for you" list on the admin home (DESIGN.md §10: "a red dot means exactly one thing: something is
 * waiting for a human").
 *
 * Only real counts, each shown only to employees who hold the permission to act on it, and never something the
 * employee may not decide themselves (two-person rules):
 *   proofs     transfer payments whose proof waits for verification      orders.payment.verify      /admin/orders/proofs
 *   refunds    refunds waiting for a second person's approval             orders.refund.approve      /admin/orders/refunds
 *              (not the employee's own: the requester may never approve)
 *   prices     price changes waiting for a decision (not the employee's   pricing.price.approve      /admin/pricing/changes
 *              own request; cuts that need the override right only for
 *              holders of pricing.discount.override — countDecidable)
 *   counts     stock counts submitted for approval that the employee      inventory.count.approve    /admin/inventory/counts?status=review
 *              neither started nor counted a line of (now or before a
 *              colleague re-counted it — the counts service's rule)
 *   transfers  transfers between locations on their way                  inventory.transfer.receive /admin/inventory/transfers?status=in_transit
 * plus notices about the employee's own account (two-step verification off, few recovery codes left).
 *
 * Read-only; one batched round trip, plus the pricing module's own count in parallel.
 */
import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { can } from "~/server/actor";
import type { Db } from "~/server/db.server";
import { cycleCounts, employees, payments, refunds, stockTransfers } from "~/server/db/schema";
import { countDecidable } from "~/server/services/admin/pricing/prices.server";
import { canSeeModule } from "./access.server";

export type ShellQueueId = "proofs" | "refunds" | "prices" | "counts" | "transfers";
export type ShellQueue = { id: ShellQueueId; module: "orders" | "pricing" | "inventory"; count: number; href: string };
export type ShellNotice = { id: "mfa_off" | "recovery_low"; href: string; count?: number };
export type ShellWaiting = { queues: ShellQueue[]; notices: ShellNotice[]; total: number };

/** The page each queue opens: the module's own queue screen. */
export const QUEUE_HREF: Record<ShellQueueId, string> = {
  proofs: "/admin/orders/proofs",
  refunds: "/admin/orders/refunds",
  prices: "/admin/pricing/changes",
  counts: "/admin/inventory/counts?status=review",
  transfers: "/admin/inventory/transfers?status=in_transit",
};

/** At or below this many unused recovery codes the employee is reminded to make new ones. */
export const RECOVERY_CODES_LOW = 3;

export async function loadWaiting(db: Db, session: EmployeeSession): Promise<ShellWaiting> {
  const { actor, employee } = session;
  const wantsProofs = can(actor, "orders.payment.verify") && canSeeModule(actor, "orders");
  const wantsRefunds = can(actor, "orders.refund.approve") && canSeeModule(actor, "orders");
  const wantsPrices = can(actor, "pricing.price.approve") && canSeeModule(actor, "pricing");
  const wantsCounts = can(actor, "inventory.count.approve") && canSeeModule(actor, "inventory");
  const wantsTransfers = can(actor, "inventory.transfer.receive") && canSeeModule(actor, "inventory");

  // The two-person rule of counts (app/server/services/admin/inventory/counts.server.ts, tookPart): an employee who
  // started a count, or recorded any of its lines — now, or before a colleague re-counted them (the audit trail
  // keeps that) — is never asked to approve it.
  const tookPart = sql`(${cycleCounts.startedBy} IS ${employee.id}
    OR EXISTS (SELECT 1 FROM cycle_count_lines AS l WHERE l.count_id = ${cycleCounts.id} AND l.counted_by IS ${employee.id})
    OR EXISTS (SELECT 1 FROM audit_events AS a WHERE a.entity_type = 'cycle_count' AND a.entity_id = ${cycleCounts.id}
               AND a.action = 'inventory.count.record' AND a.actor_kind = 'employee' AND a.actor_id = ${employee.id}))`;

  const [[proofRows, refundRows, countRows, transferRows, accountRows], decidablePrices] = await Promise.all([
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
    wantsPrices ? countDecidable(db, actor) : Promise.resolve(0),
  ]);

  const counted: Array<[ShellQueueId, ShellQueue["module"], boolean, number]> = [
    ["proofs", "orders", wantsProofs, proofRows[0]?.n ?? 0],
    ["refunds", "orders", wantsRefunds, refundRows[0]?.n ?? 0],
    ["prices", "pricing", wantsPrices, Number(decidablePrices) || 0],
    ["counts", "inventory", wantsCounts, countRows[0]?.n ?? 0],
    ["transfers", "inventory", wantsTransfers, transferRows[0]?.n ?? 0],
  ];
  const queues: ShellQueue[] = counted
    .filter(([, , wanted, n]) => wanted && n > 0)
    .map(([id, module, , n]) => ({ id, module, count: n, href: QUEUE_HREF[id] }));

  const notices: ShellNotice[] = [];
  if (!employee.totpEnabled) notices.push({ id: "mfa_off", href: "/admin/me#two-step" });
  else {
    const left = accountRows[0]?.recoveryCodes?.length ?? 0;
    if (left <= RECOVERY_CODES_LOW) notices.push({ id: "recovery_low", href: "/admin/me#two-step", count: left });
  }

  return { queues, notices, total: queues.reduce((sum, queue) => sum + queue.count, 0) };
}
