/**
 * Admin module 08 — what the promotions services share: who may open which section (promotionsAccess), the
 * module's `approvals` rows (one shape for coupons, rules, flash sales, gift cards and point adjustments: the
 * requester never decides their own), names for ids, the audit history of a record, and ids derived from a form key
 * (a double submit finds the first row instead of making a second).
 *
 * Every service checks its permission with assertCan / assertAny BEFORE it reads its input; a route's gate is only
 * the first line.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import { formatIraqPhone, maskPhone } from "~/lib/phone";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, auditEvents, customers, employees, type Approval } from "~/server/db/schema";
import { expectThat } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import type { ApprovalReason, CouponTerms, HistoryRow, PendingChange, PromotionApprovalKind } from "./types";

export const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** Every permission of module 08 (the gate lets an employee in with any one of them). */
export const PROMOTIONS_PERMISSIONS = [
  "promotions.promotion.read",
  "promotions.coupon.manage",
  "promotions.rule.manage",
  "promotions.flash_sale.manage",
  "promotions.loyalty.manage",
  "promotions.loyalty.adjust",
  "promotions.referral.manage",
  "promotions.membership.manage",
  "promotions.gift_card.issue",
  "promotions.gift_card.manage",
  "promotions.experiment.manage",
] as const satisfies readonly Permission[];

/** Reading a section: the module's read permission, or the permission to work on it. */
export const SECTION_READ = {
  coupons: ["promotions.promotion.read", "promotions.coupon.manage"],
  rules: ["promotions.promotion.read", "promotions.rule.manage"],
  flash: ["promotions.promotion.read", "promotions.flash_sale.manage"],
  points: ["promotions.promotion.read", "promotions.loyalty.manage", "promotions.loyalty.adjust"],
  referrals: ["promotions.promotion.read", "promotions.referral.manage"],
  vip: ["promotions.promotion.read", "promotions.membership.manage"],
  giftCards: ["promotions.promotion.read", "promotions.gift_card.issue", "promotions.gift_card.manage"],
  experiments: ["promotions.promotion.read", "promotions.experiment.manage"],
} as const satisfies Record<string, readonly Permission[]>;
export type PromotionsSection = keyof typeof SECTION_READ;

export type PromotionsAccess = Record<PromotionsSection, boolean> & {
  any: boolean;
  coupons_manage: boolean;
  rules_manage: boolean;
  flash_manage: boolean;
  points_manage: boolean;
  points_adjust: boolean;
  referrals_manage: boolean;
  vip_manage: boolean;
  gift_issue: boolean;
  gift_manage: boolean;
  gift_reveal: boolean;
  experiments_manage: boolean;
  override: boolean;
  priceApprove: boolean;
  fullPhone: boolean;
  customers: boolean;
  cost: boolean;
  profit: boolean;
};

export function promotionsAccess(actor: Actor): PromotionsAccess {
  return {
    any: canAny(actor, PROMOTIONS_PERMISSIONS),
    coupons: canAny(actor, SECTION_READ.coupons),
    rules: canAny(actor, SECTION_READ.rules),
    flash: canAny(actor, SECTION_READ.flash),
    points: canAny(actor, SECTION_READ.points),
    referrals: canAny(actor, SECTION_READ.referrals),
    vip: canAny(actor, SECTION_READ.vip),
    giftCards: canAny(actor, SECTION_READ.giftCards),
    experiments: canAny(actor, SECTION_READ.experiments),
    coupons_manage: can(actor, "promotions.coupon.manage"),
    rules_manage: can(actor, "promotions.rule.manage"),
    flash_manage: can(actor, "promotions.flash_sale.manage"),
    points_manage: can(actor, "promotions.loyalty.manage"),
    points_adjust: can(actor, "promotions.loyalty.adjust"),
    referrals_manage: can(actor, "promotions.referral.manage"),
    vip_manage: can(actor, "promotions.membership.manage"),
    gift_issue: can(actor, "promotions.gift_card.issue"),
    gift_manage: can(actor, "promotions.gift_card.manage"),
    gift_reveal: can(actor, "promotions.gift_card.manage") && can(actor, "digital_code.reveal"),
    experiments_manage: can(actor, "promotions.experiment.manage"),
    override: can(actor, "pricing.discount.override"),
    priceApprove: can(actor, "pricing.price.approve"),
    fullPhone: can(actor, "customer.phone.read_full"),
    customers: can(actor, "customers.customer.read"),
    cost: can(actor, "cost.read"),
    profit: can(actor, "cost.read") && can(actor, "profit.read"),
  };
}

/** assertCan for a list of permissions where any one is enough. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) assertCan(actor, permissions[0]);
}

export function actorIdOf(actor: Actor): string {
  return actor.kind === "employee" || actor.kind === "customer" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : "guest";
}

/** An id derived from (employee, form key): the same submit twice names the same row. */
export async function idFromKey(prefix: string, actor: Actor, key: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(`tamtam.promotions.v1|${prefix}|${actorIdOf(actor)}|${key}`)).slice(0, 26)}`;
}

/** Employee id → name. */
export async function employeeNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes(":")))];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, unique.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, row.name);
  }
  return out;
}

export type PhoneLike = { display: string; full: boolean };

/** A phone as this employee may see it: the whole number with customer.phone.read_full, otherwise "0771 ••• ••52". */
export function phoneOf(e164: string | null | undefined, full: boolean): PhoneLike | null {
  if (!e164 || !e164.startsWith("+964")) return null;
  return full ? { display: formatIraqPhone(e164), full: true } : { display: maskPhone(e164), full: false };
}

/** Customer id → name and phone (as this employee may see it). */
export async function customerLabels(db: Db, actor: Actor, ids: Iterable<string | null | undefined>): Promise<Map<string, { name: string | null; phone: PhoneLike | null; status: string; isDemo: boolean }>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0))];
  const full = can(actor, "customer.phone.read_full");
  const out = new Map<string, { name: string | null; phone: PhoneLike | null; status: string; isDemo: boolean }>();
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db.select({ id: customers.id, name: customers.name, phone: customers.phoneE164, status: customers.status, isDemo: customers.isDemo }).from(customers).where(inArray(customers.id, unique.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, { name: row.name, phone: phoneOf(row.phone, full), status: row.status, isDemo: row.isDemo });
  }
  return out;
}

/** The latest audit events of one record (newest first), with the employee's name at the time. */
export async function historyOf(db: Db, entityType: string, entityId: string, limit = 20): Promise<HistoryRow[]> {
  const rows = await db
    .select({ id: auditEvents.id, at: auditEvents.at, action: auditEvents.action, actorLabel: auditEvents.actorLabel, actorId: auditEvents.actorId, reason: auditEvents.reason })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
    .orderBy(desc(auditEvents.seq))
    .limit(limit);
  const names = await employeeNames(
    db,
    rows.filter((row) => !row.actorLabel).map((row) => row.actorId),
  );
  return rows.map((row) => ({ id: row.id, at: row.at, action: row.action, actor: row.actorLabel ?? (row.actorId ? (names.get(row.actorId) ?? null) : null), reason: row.reason }));
}

// ───────────────────────────────────────────────────────────────── approvals

/** Who may decide a module-08 request of each kind (all of them, and never the requester). */
export const DECIDE_PERMISSIONS: Record<PromotionApprovalKind, readonly Permission[]> = {
  coupon: ["promotions.coupon.manage", "pricing.discount.override"],
  promotion_rule: ["promotions.rule.manage", "pricing.discount.override"],
  flash_sale: ["promotions.flash_sale.manage", "pricing.price.approve"],
  gift_card: ["promotions.gift_card.manage"],
  loyalty_adjustment: ["promotions.loyalty.adjust"],
};

/** Whether this employee may decide this request: every permission of its kind (+ its own extra one), not their own. */
export function canDecideApproval(actor: Actor, approval: Pick<Approval, "kind" | "requestedBy" | "requiredPermission">): boolean {
  if (actor.kind !== "employee" || approval.requestedBy === actor.id) return false;
  const needs = DECIDE_PERMISSIONS[approval.kind as PromotionApprovalKind];
  if (!needs || !needs.every((permission) => can(actor, permission))) return false;
  return approval.requiredPermission ? can(actor, approval.requiredPermission as Permission) : true;
}

/** Refuses a decision by the requester (403) or by someone missing a permission of the kind. */
export function assertMayDecide(actor: Actor, approval: Pick<Approval, "kind" | "requestedBy" | "requiredPermission">): void {
  if (actor.kind === "employee" && approval.requestedBy === actor.id) throw new AppError("approver_is_requester", 403);
  for (const permission of DECIDE_PERMISSIONS[approval.kind as PromotionApprovalKind] ?? []) assertCan(actor, permission);
  if (approval.requiredPermission) assertCan(actor, approval.requiredPermission as Permission);
}

/**
 * Inside a request's batch: no other request of this record is waiting (two tabs, two people at once — the check
 * before the batch alone lets both through). Fails with CHANGE_PENDING → `change_pending` (409).
 */
export function noPendingRequest(db: Db, kind: PromotionApprovalKind, entityId: string): BatchStatement {
  return expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ${kind} AND entity_id = ${entityId} AND status = 'pending')`, { code: "CHANGE_PENDING", detail: entityId });
}

/** The pending request of a record (one at a time per record). */
export async function pendingApprovalOf(db: Db, kind: PromotionApprovalKind, entityId: string): Promise<Approval | undefined> {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.kind, kind), eq(approvals.entityId, entityId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt))
    .get();
}

/** Whether a request of this kind with exactly this fingerprint was approved for the record. */
export async function approvedFingerprint(db: Db, kind: PromotionApprovalKind, entityId: string, fingerprint: string): Promise<boolean> {
  const row = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.kind, kind), eq(approvals.entityId, entityId), eq(approvals.status, "approved"), sql`json_extract(${approvals.payload}, '$.fingerprint') = ${fingerprint}`))
    .get();
  return Boolean(row);
}

/** The pending rows of one kind for many records (list pages mark them). */
export async function pendingEntityIds(db: Db, kind: PromotionApprovalKind, entityIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(entityIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db
      .select({ entityId: approvals.entityId })
      .from(approvals)
      .where(and(eq(approvals.kind, kind), eq(approvals.status, "pending"), inArray(approvals.entityId, ids.slice(i, i + 90))));
    for (const row of rows) if (row.entityId) out.add(row.entityId);
  }
  return out;
}

/** A waiting request as the record's page shows it. */
export async function pendingChangeView(db: Db, actor: Actor, approval: Approval | undefined): Promise<PendingChange | null> {
  if (!approval) return null;
  const payload = (approval.payload ?? {}) as { action?: PendingChange["action"]; terms?: CouponTerms; reasons?: ApprovalReason[] };
  const names = await employeeNames(db, [approval.requestedBy]);
  return {
    approvalId: approval.id,
    action: payload.action ?? "update",
    requestedBy: approval.requestedBy,
    requestedByName: names.get(approval.requestedBy) ?? null,
    requestedAt: approval.createdAt,
    reason: approval.reason,
    reasons: payload.reasons ?? [],
    terms: payload.terms ?? null,
    mine: actor.kind === "employee" && approval.requestedBy === actor.id,
    canDecide: canDecideApproval(actor, approval),
  };
}

/** The text a staff member typed, or null. */
export const textOrNull = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

export const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
