/**
 * Admin 15.06 — one view of approvals across modules. Decisions are never made here: every row links to the module
 * screen where that decision is taken (with that module's own permission, two-person rule and confirm dialog).
 *
 *   waiting for me     the admin bell's own queues (app/routes/admin/shell/queues.server.ts, loadWaiting — called by
 *                      the route, read-only), so this page and the bell never count differently; plus the module's own
 *                      leave requests and payroll runs this employee may decide
 *   my requests        what this employee asked for that still waits for someone else: `approvals` rows they
 *                      requested (price changes, refunds, purchase orders, wallet adjustments, settings, advances …)
 *                      and their own leave requests
 *   across the store   (staff.approval.read) every pending `approvals` row by kind — how many, the oldest, who asked,
 *                      which permission decides — WITHOUT the request's payload (amounts, costs and prices stay with
 *                      the module that shows them to who may see them)
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, leaveRequests, payrollItems, payrollRuns } from "~/server/db/schema";
import { forbidden } from "~/server/errors";
import { APPROVAL_KINDS as PROMOTION_APPROVAL_KINDS } from "../promotions/types";
import { leaveRecorders } from "./leave.server";
import { isDemoRun, runInvolved, runRef } from "./payroll.server";
import { actorId, assertAny, branchLimit, byView, peopleById, reachSql } from "./shared.server";
import { ADVANCE_APPROVAL_KIND, type ByView } from "./types";

/** Where the decision on each kind of `approvals` row is taken (the module's own screen). */
export function approvalHref(kind: string, entityType: string | null, entityId: string | null): string | null {
  switch (kind) {
    case "refund":
      return "/admin/orders/refunds";
    case "price_change":
      return "/admin/pricing/changes";
    case "used_price":
      return "/admin/pricing/special";
    case "purchase_order":
      return entityId ? `/admin/purchasing/orders/${encodeURIComponent(entityId)}` : "/admin/purchasing/orders?view=pending_approval";
    case "wallet_topup":
      return entityId ? `/admin/finance/wallets/topups/${encodeURIComponent(entityId)}` : "/admin/finance/wallets";
    case "wallet_adjustment":
      return "/admin/finance/wallets?tab=adjustments";
    case "settings":
      return entityType === "setting" && entityId ? `/admin/settings/keys/${encodeURIComponent(entityId)}` : "/admin/settings/changes";
    case ADVANCE_APPROVAL_KIND:
      return "/admin/staff/payroll/advances";
    default:
      return PROMOTION_KINDS.has(kind) ? "/admin/promotions/approvals" : null;
  }
}

/** The kinds the promotions module asks a second person for (its own list); decided on its approvals screen. */
const PROMOTION_KINDS: ReadonlySet<string> = new Set(PROMOTION_APPROVAL_KINDS);

/** The module an approval kind belongs to (its name comes from the admin's `modules.<slug>`). */
export function approvalModule(kind: string): string | null {
  switch (kind) {
    case "refund":
      return "orders";
    case "price_change":
    case "used_price":
      return "pricing";
    case "purchase_order":
      return "purchasing";
    case "wallet_topup":
    case "wallet_adjustment":
      return "finance";
    case "settings":
      return "settings";
    case ADVANCE_APPROVAL_KIND:
      return "staff";
    default:
      return PROMOTION_KINDS.has(kind) ? "promotions" : null;
  }
}

export type MyRequest = { id: string; kind: string; module: string | null; createdAt: number; reason: string | null; href: string | null };
export type StaffDecision = { kind: "leave" | "payroll_run"; id: string; label: string; createdAt: number; href: string };

/** This module's own decisions waiting for this employee: leave requests to decide, payroll runs to approve or pay. */
export async function staffDecisions(db: Db, actor: Actor): Promise<StaffDecision[]> {
  const me = actorId(actor);
  if (!me) return [];
  const out: StaffDecision[] = [];
  if (can(actor, "staff.leave.approve")) {
    // decideLeave's rules: never one's own leave, nor leave one recorded for someone, nor someone out of a limited approver's branch
    const rows = await db
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.status, "pending"), sql`${leaveRequests.employeeId} <> ${me}`, reachSql(actor, leaveRequests.employeeId)))
      .orderBy(asc(leaveRequests.createdAt))
      .limit(50);
    const [people, recorders] = await Promise.all([peopleById(db, rows.map((row) => row.employeeId)), leaveRecorders(db, rows.map((row) => row.id))]);
    for (const row of rows) {
      if (recorders.get(row.id) === me) continue;
      out.push({ kind: "leave", id: row.id, label: people.get(row.employeeId)?.name ?? row.employeeId, createdAt: row.createdAt, href: "/admin/staff/leave" });
    }
  }
  // a payroll run covers every branch: not a decision for someone limited to one
  if (can(actor, "staff.payroll.approve") && !branchLimit(actor)) {
    const runs = await db.select().from(payrollRuns).where(inArray(payrollRuns.status, ["draft", "approved"])).orderBy(asc(payrollRuns.createdAt));
    const paysMe = runs.length
      ? new Set((await db.select({ runId: payrollItems.runId }).from(payrollItems).where(and(inArray(payrollItems.runId, runs.map((run) => run.id)), eq(payrollItems.employeeId, me)))).map((row) => row.runId))
      : new Set<string>();
    for (const run of runs) {
      if (run.status === "draft") {
        // approveRun refuses a participant, a salary changer and anyone the run pays: not a decision waiting for them
        const involved = await runInvolved(db, run);
        if (involved.ids.has(me) || paysMe.has(run.id)) continue;
      }
      out.push({ kind: "payroll_run", id: run.id, label: `${runRef(run)}${isDemoRun(run.id) ? " · demo" : ""}`, createdAt: run.createdAt, href: `/admin/staff/payroll/${run.id}` });
    }
  }
  return out;
}

/** What this employee asked for that still waits for someone else. */
export async function myRequests(db: Db, actor: Actor): Promise<MyRequest[]> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const [rows, leave] = await Promise.all([
    db.select().from(approvals).where(and(eq(approvals.requestedBy, me), eq(approvals.status, "pending"))).orderBy(desc(approvals.createdAt)).limit(50),
    db.select().from(leaveRequests).where(and(eq(leaveRequests.employeeId, me), eq(leaveRequests.status, "pending"))).orderBy(desc(leaveRequests.createdAt)).limit(20),
  ]);
  return [
    ...rows.map((row) => ({ id: row.id, kind: row.kind, module: approvalModule(row.kind), createdAt: row.createdAt, reason: row.reason, href: approvalHref(row.kind, row.entityType, row.entityId) })),
    ...leave.map((row) => ({ id: row.id, kind: "leave", module: "staff", createdAt: row.createdAt, reason: row.reason, href: "/admin/staff/me#leave" })),
  ].sort((a, b) => b.createdAt - a.createdAt);
}

export type StoreApprovals = {
  byKind: { kind: string; module: string | null; count: number; oldestAt: number; href: string | null }[];
  rows: { id: string; kind: string; module: string | null; requestedBy: ByView; requiredPermission: string | null; createdAt: number; expiresAt: number | null; href: string | null }[];
  leavePending: number;
  runsAwaiting: number;
};

/** Every pending `approvals` row of the store (staff.approval.read) — kind, who asked, since when; never the payload. */
export async function storeApprovals(db: Db, actor: Actor, locale: Locale): Promise<StoreApprovals> {
  assertAny(actor, ["staff.approval.read"]);
  void locale;
  const [grouped, rows, leave, runs] = await Promise.all([
    db
      .select({ kind: approvals.kind, count: sql<number>`count(*)`, oldestAt: sql<number>`min(${approvals.createdAt})` })
      .from(approvals)
      .where(eq(approvals.status, "pending"))
      .groupBy(approvals.kind),
    db
      .select({ id: approvals.id, kind: approvals.kind, entityType: approvals.entityType, entityId: approvals.entityId, requestedBy: approvals.requestedBy, requiredPermission: approvals.requiredPermission, createdAt: approvals.createdAt, expiresAt: approvals.expiresAt })
      .from(approvals)
      .where(eq(approvals.status, "pending"))
      .orderBy(asc(approvals.createdAt))
      .limit(60),
    db.select({ n: sql<number>`count(*)` }).from(leaveRequests).where(eq(leaveRequests.status, "pending")).get(),
    db.select({ n: sql<number>`count(*)` }).from(payrollRuns).where(inArray(payrollRuns.status, ["draft", "approved"])).get(),
  ]);
  const people = await peopleById(db, rows.map((row) => row.requestedBy));
  return {
    byKind: grouped.map((row) => ({ kind: row.kind, module: approvalModule(row.kind), count: Number(row.count), oldestAt: Number(row.oldestAt), href: approvalHref(row.kind, null, null) })).sort((a, b) => a.oldestAt - b.oldestAt),
    rows: rows.map((row) => ({ id: row.id, kind: row.kind, module: approvalModule(row.kind), requestedBy: byView(people, row.requestedBy), requiredPermission: row.requiredPermission, createdAt: row.createdAt, expiresAt: row.expiresAt, href: approvalHref(row.kind, row.entityType, row.entityId) })),
    leavePending: Number(leave?.n ?? 0),
    runsAwaiting: Number(runs?.n ?? 0),
  };
}
