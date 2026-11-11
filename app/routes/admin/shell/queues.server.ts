/**
 * What is waiting for this employee — the shell's notifications slot, the beads on queue rows in the navigation and
 * the "waiting for you" list on the admin home (DESIGN.md §10: "a red dot means exactly one thing: something is
 * waiting for a human").
 *
 * Only real counts, each shown only to employees who hold the permission to act on it:
 *   proofs    transfer payments whose proof waits for verification     orders.payment.verify
 *   refunds   refunds waiting for a second person's approval            orders.refund.approve (not the employee's own:
 *                                                                        the requester may never approve, §refunds)
 * plus notices about the employee's own account (two-step verification off, few recovery codes left).
 *
 * Read-only; one batched round trip. Queue screens belong to their modules (05 orders) — until they exist the links
 * lead to the module's page in the shell, which says so.
 */
import { and, count, eq, isNull, ne, or } from "drizzle-orm";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { can } from "~/server/actor";
import type { Db } from "~/server/db.server";
import { employees, payments, refunds } from "~/server/db/schema";
import { canSeeModule } from "./access.server";

export type ShellQueue = { id: "proofs" | "refunds"; module: "orders"; count: number; href: string };
export type ShellNotice = { id: "mfa_off" | "recovery_low"; href: string; count?: number };
export type ShellWaiting = { queues: ShellQueue[]; notices: ShellNotice[]; total: number };

/** At or below this many unused recovery codes the employee is reminded to make new ones. */
export const RECOVERY_CODES_LOW = 3;

export async function loadWaiting(db: Db, session: EmployeeSession): Promise<ShellWaiting> {
  const { actor, employee } = session;
  const wantsProofs = can(actor, "orders.payment.verify") && canSeeModule(actor, "orders");
  const wantsRefunds = can(actor, "orders.refund.approve") && canSeeModule(actor, "orders");

  const [proofRows, refundRows, accountRows] = await db.batch([
    db
      .select({ n: count() })
      .from(payments)
      .where(wantsProofs ? eq(payments.status, "pending_verification") : eq(payments.id, "")),
    db
      .select({ n: count() })
      .from(refunds)
      .where(wantsRefunds ? and(eq(refunds.status, "pending"), or(isNull(refunds.createdBy), ne(refunds.createdBy, employee.id))) : eq(refunds.id, "")),
    db.select({ recoveryCodes: employees.recoveryCodes }).from(employees).where(eq(employees.id, employee.id)).limit(1),
  ]);

  const queues: ShellQueue[] = [];
  const proofs = proofRows[0]?.n ?? 0;
  const pendingRefunds = refundRows[0]?.n ?? 0;
  if (wantsProofs && proofs > 0) queues.push({ id: "proofs", module: "orders", count: proofs, href: "/admin/orders" });
  if (wantsRefunds && pendingRefunds > 0) queues.push({ id: "refunds", module: "orders", count: pendingRefunds, href: "/admin/orders" });

  const notices: ShellNotice[] = [];
  if (!employee.totpEnabled) notices.push({ id: "mfa_off", href: "/admin/me#two-step" });
  else {
    const left = accountRows[0]?.recoveryCodes?.length ?? 0;
    if (left <= RECOVERY_CODES_LOW) notices.push({ id: "recovery_low", href: "/admin/me#two-step", count: left });
  }

  return { queues, notices, total: queues.reduce((sum, queue) => sum + queue.count, 0) };
}
