/**
 * Admin 15.03 — commissions on sales or on realised profit, with deductions for returns.
 *
 * PLANS ARE VERSIONED. A plan is a chain of `commission_rules` rows that share an id stem: the first version is
 * `crl_<id>`, later ones `crl_<id>.v2`, `crl_<id>.v3` … (the stem is the plan's reference — never its name, which can
 * change). A version is never edited: a new rate, basis or scope is a new version that starts now or on a later day,
 * and the version before it ends at that moment; ending a plan sets the end of its latest version. A sale is paid by
 * the version that was in force when it was delivered, so changing a plan never rewrites what was earned.
 *
 * WHO EARNS. The seller of an order is the cashier who rang it up (`orders.cashier_id`); web orders have no seller and
 * earn nothing. The most specific plan in force wins: one for that employee, else one for one of their roles, else
 * one for everyone; inside a level the pricing module's rule (`commissionFor`: category, then product kind, then the
 * higher rate) — the same rule its discount simulator applies. A demo order earns only for a demo employee.
 *
 * WHAT IT IS PAID ON (per order line, only for DELIVERED orders — `delivered_at` set):
 *   sales base  = (line total − its share of the order's discount) × units kept ÷ units sold
 *                 − its share of refunds made without items (price adjustments), never below 0
 *   profit base = sales base − landed unit cost at the sale (`cost_snapshot_iqd`) × units kept
 *   commission  = floor(base × rate), 0 for a base ≤ 0; a profit plan on a line of unknown cost earns nothing and is
 *                 counted as "uncosted" (never a made-up 0 cost)
 * "Units kept" are the units sold minus those refunded with items. Commission rows are append-only by this module:
 * the first computation of a line writes an `earn` row; when a return lands later, the next computation writes the
 * difference as a `clawback` row (negative) in the month it is computed — a payroll run deducts it then.
 *
 * COMPUTING. syncCommissions(period) computes the lines delivered in that month plus every line whose order had a
 * refund paid after its last commission row. Row ids are `com_<order item>_<n>`: two computations at the same moment
 * cannot both write (commission_sync_busy). A payroll run computes its month and the one before before it plans.
 *
 * Field rules: a profit-based plan is created or changed only with profit.read; the base and rate of profit-based
 * rows are absent without profit.read (the amounts — pay — are shown to payroll and commission staff).
 *
 * Errors: forbidden, not_found, invalid (fields), rule_ended, rule_changed, profit_basis_needs_permission (403),
 * commission_sync_busy, employee_inactive.
 */
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { categories, commissionRules, commissions, employeeRoles, roles, type Commission, type CommissionRule } from "~/server/db/schema";
import { chunkRows, expectThat, isDbError, isUniqueViolation, runBatch, type BatchStatement } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { allocateAmount } from "../pricing/rules";
import { commissionFor } from "../pricing/simulate.server";
import { activeEmployee, assertAny, assertReach, branchLimit, cleanLine, employeeOptions, ID, IdSchema, peopleById, personOf, reachSql, Reason, stamp } from "./shared.server";
import {
  baghdadDay,
  CHANNEL_LIST,
  COMMISSION_BASIS_LIST,
  dayStart,
  isDay,
  PAGE_SIZE,
  periodOf,
  periodRange,
  PRODUCT_KIND_LIST,
  RULE_SCOPE_LIST,
  shiftPeriod,
  type CommissionFilters,
  type CommissionLine,
  type CommissionTotals,
  type PersonRef,
  type RuleScopeKey,
  type RulePlanView,
  type RuleVersionView,
} from "./types";

const PLAN_READERS = ["staff.commission.manage", "staff.payroll.read"] as const;
const SYNCERS = ["staff.commission.manage", "staff.payroll.run"] as const;

// ───────────────────────────────────────────────────────────────── versions

/** The plan a rule row belongs to: its id up to ".v<n>". */
export function planIdOf(ruleId: string): string {
  const at = ruleId.lastIndexOf(".v");
  return at > 0 && /^\d+$/.test(ruleId.slice(at + 2)) ? ruleId.slice(0, at) : ruleId;
}

/** The version number of a rule row (1 for the plan's first). */
export function versionOf(ruleId: string): number {
  const at = ruleId.lastIndexOf(".v");
  return at > 0 && /^\d+$/.test(ruleId.slice(at + 2)) ? Number(ruleId.slice(at + 2)) : 1;
}

export function ruleState(rule: Pick<CommissionRule, "startsAt" | "endsAt">, now: number): RuleVersionView["state"] {
  if (rule.startsAt !== null && rule.startsAt > now) return "scheduled";
  if (rule.endsAt !== null && rule.endsAt <= now) return "ended";
  return "current";
}

function scopeOf(rule: Pick<CommissionRule, "employeeId" | "roleId">): RuleScopeKey {
  return rule.employeeId ? "employee" : rule.roleId ? "role" : "everyone";
}

export type PlansView = {
  plans: RulePlanView[];
  roles: { id: string; name: string }[];
  employees: (PersonRef & { status: "active" | "disabled" })[];
  categories: { id: string; name: string }[];
  can: { manage: boolean; profit: boolean };
};

/** Every plan with its versions (newest first); the rate of a profit plan is absent without profit.read. */
export async function listPlans(db: Db, actor: Actor, locale: Locale, now: number): Promise<PlansView> {
  assertAny(actor, PLAN_READERS);
  const profit = can(actor, "profit.read");
  const [rules, roleRows, categoryRows, options] = await Promise.all([
    db.select().from(commissionRules).orderBy(asc(commissionRules.createdAt)),
    db.select({ id: roles.id, name: roles.name }).from(roles).orderBy(asc(roles.key)),
    db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sort)),
    employeeOptions(db, { branchId: branchLimit(actor) }),
  ]);
  const people = await peopleById(db, [...rules.map((rule) => rule.employeeId), ...rules.map((rule) => rule.createdBy)]);
  const roleName = new Map(roleRows.map((row) => [row.id, pick(row.name, locale)]));
  const categoryName = new Map(categoryRows.map((row) => [row.id, pick(row.name, locale)]));
  const view = (rule: CommissionRule): RuleVersionView => ({
    id: rule.id,
    version: versionOf(rule.id),
    name: rule.name,
    basis: rule.basis,
    rateBps: rule.basis === "profit" && !profit ? null : rule.rateBps,
    scope: scopeOf(rule),
    target: rule.employeeId ? (people.get(rule.employeeId)?.name ?? rule.employeeId) : rule.roleId ? (roleName.get(rule.roleId) ?? rule.roleId) : null,
    productKind: rule.productKind,
    category: rule.categoryId ? (categoryName.get(rule.categoryId) ?? rule.categoryId) : null,
    channel: rule.channel === "web" || rule.channel === "pos" ? rule.channel : null,
    startsAt: rule.startsAt,
    endsAt: rule.endsAt,
    createdBy: rule.createdBy ? (people.get(rule.createdBy)?.name ?? null) : null,
    createdAt: rule.createdAt,
    state: ruleState(rule, now),
  });
  const byPlan = new Map<string, CommissionRule[]>();
  for (const rule of rules) byPlan.set(planIdOf(rule.id), [...(byPlan.get(planIdOf(rule.id)) ?? []), rule]);
  const plans: RulePlanView[] = [...byPlan.entries()].map(([planId, versions]) => {
    const sorted = [...versions].sort((a, b) => versionOf(b.id) - versionOf(a.id));
    const current = sorted.find((rule) => ruleState(rule, now) === "current") ?? sorted[0];
    return { planId, current: view(current), versions: sorted.map(view) };
  });
  plans.sort((a, b) => (a.current.state === "ended" ? 1 : 0) - (b.current.state === "ended" ? 1 : 0) || a.current.name.localeCompare(b.current.name, "ar"));
  return {
    plans,
    roles: roleRows.map((row) => ({ id: row.id, name: pick(row.name, locale) })),
    employees: options,
    categories: categoryRows.map((row) => ({ id: row.id, name: pick(row.name, locale) })),
    can: { manage: can(actor, "staff.commission.manage"), profit },
  };
}

const optionalId = IdSchema.nullish().transform((value) => value || null);

const RuleInput = z.object({
  /** Empty: a new plan. Otherwise the plan this is a new version of. */
  planId: z
    .string()
    .regex(/^crl_[A-Za-z0-9]+$/, "invalid")
    .nullish()
    .transform((value) => value || null),
  name: z.string({ error: "required" }).overwrite(cleanLine).min(3, "too_short").max(80, "too_long"),
  basis: z.enum(COMMISSION_BASIS_LIST, { error: "required" }),
  rateBps: z
    .number({ error: "required" })
    .refine((value) => !Number.isNaN(value), "rate_invalid")
    .refine((value) => Number.isInteger(value) && value > 0 && value <= 10_000, "rate_invalid"),
  scope: z.enum(RULE_SCOPE_LIST, { error: "required" }),
  roleId: optionalId,
  employeeId: optionalId,
  productKind: z.enum(["*", ...PRODUCT_KIND_LIST]).default("*"),
  categoryId: optionalId,
  channel: z
    .enum(["", ...CHANNEL_LIST])
    .nullish()
    .transform((value) => (value ? value : null)),
  /** First day it applies (Baghdad); empty = now. Never in the past. */
  startsOn: z
    .string()
    .nullish()
    .transform((value) => value || null)
    .refine((value) => value === null || isDay(value), "invalid"),
  endsOn: z
    .string()
    .nullish()
    .transform((value) => value || null)
    .refine((value) => value === null || isDay(value), "invalid"),
  reason: Reason,
});

/** A new plan, or a new version of one (staff.commission.manage; a profit plan also needs profit.read). */
export async function saveRuleVersion(db: Db, actor: Actor, raw: z.input<typeof RuleInput>, now: number): Promise<{ ruleId: string; planId: string; version: number }> {
  assertAny(actor, ["staff.commission.manage"]);
  const input = RuleInput.parse(raw);
  if (input.basis === "profit" && !can(actor, "profit.read")) throw new AppError("profit_basis_needs_permission", 403);
  const today = baghdadDay(now);
  if (input.startsOn && input.startsOn < today) throw invalid({ startsOn: "rule_start_past" });
  const startsAt = !input.startsOn || input.startsOn === today ? now : dayStart(input.startsOn);
  const endsAt = input.endsOn ? dayStart(input.endsOn) : null;
  if (endsAt !== null && endsAt <= startsAt) throw invalid({ endsOn: "rule_end_before_start" });
  const fields: Record<string, string> = {};
  if (input.scope === "role" && !input.roleId) fields.roleId = "required";
  if (input.scope === "employee" && !input.employeeId) fields.employeeId = "required";
  if (Object.keys(fields).length) throw invalid(fields);
  if (input.scope === "role" && input.roleId) {
    const role = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, input.roleId)).get();
    if (!role) throw invalid({ roleId: "invalid" });
  }
  if (input.scope === "employee" && input.employeeId) assertReach(actor, await activeEmployee(db, input.employeeId));
  if (input.categoryId) {
    const category = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).get();
    if (!category) throw invalid({ categoryId: "invalid" });
  }

  let ruleId: string;
  let planId: string;
  let version: number;
  const statements: BatchStatement[] = [];
  if (input.planId) {
    const versions = await db
      .select()
      .from(commissionRules)
      .where(or(eq(commissionRules.id, input.planId), sql`${commissionRules.id} LIKE ${`${input.planId}.v%`}`));
    if (!versions.length) throw notFound("commission_plan");
    const latest = [...versions].sort((a, b) => versionOf(b.id) - versionOf(a.id))[0];
    // a new version ends the one in force: a profit plan is ended only by who may see profit (as endPlan rules)
    if (latest.basis === "profit" && !can(actor, "profit.read")) throw new AppError("profit_basis_needs_permission", 403);
    if (latest.startsAt !== null && startsAt < latest.startsAt) throw invalid({ startsOn: "rule_start_before_latest" });
    planId = input.planId;
    version = versionOf(latest.id) + 1;
    ruleId = `${planId}.v${version}`;
    statements.push(
      // nobody added a version since the form was read
      expectThat(db, sql`(SELECT count(*) FROM commission_rules WHERE id = ${planId} OR id LIKE ${`${planId}.v%`}) = ${versions.length}`, { code: "RULE_CHANGED", detail: planId }),
      db
        .update(commissionRules)
        .set({ endsAt: startsAt })
        .where(and(eq(commissionRules.id, latest.id), or(isNull(commissionRules.endsAt), sql`${commissionRules.endsAt} > ${startsAt}`))),
    );
  } else {
    planId = newId("crl");
    version = 1;
    ruleId = planId;
  }
  statements.push(
    db.insert(commissionRules).values({
      id: ruleId,
      name: input.name,
      basis: input.basis,
      rateBps: input.rateBps,
      employeeId: input.scope === "employee" ? input.employeeId : null,
      roleId: input.scope === "role" ? input.roleId : null,
      productKind: input.productKind,
      categoryId: input.categoryId,
      channel: input.channel,
      startsAt,
      endsAt,
      isActive: true,
      createdBy: stamp(actor),
      createdAt: now,
    }),
    auditStatement(db, {
      actor,
      action: version === 1 ? "staff.commission.plan_create" : "staff.commission.plan_version",
      entityType: "commission_plan",
      entityId: planId,
      summary: `${input.name} v${version}`,
      after: { ruleId, version, basis: input.basis, rateBps: input.rateBps, scope: input.scope, roleId: input.roleId, employeeId: input.employeeId, productKind: input.productKind, categoryId: input.categoryId, channel: input.channel, startsAt, endsAt },
      reason: input.reason,
      at: now,
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED") || isUniqueViolation(error)) throw new AppError("rule_changed", 409);
    throw error;
  }
  return { ruleId, planId, version };
}

const EndInput = z.object({
  planId: z.string().regex(/^crl_[A-Za-z0-9]+$/, "invalid"),
  endsOn: z
    .string()
    .nullish()
    .transform((value) => value || null)
    .refine((value) => value === null || isDay(value), "invalid"),
  reason: Reason,
});

/** Ends a plan now or on a later day (staff.commission.manage): its latest version stops applying then. */
export async function endPlan(db: Db, actor: Actor, raw: z.input<typeof EndInput>, now: number): Promise<{ endsAt: number }> {
  assertAny(actor, ["staff.commission.manage"]);
  const input = EndInput.parse(raw);
  const versions = await db
    .select()
    .from(commissionRules)
    .where(or(eq(commissionRules.id, input.planId), sql`${commissionRules.id} LIKE ${`${input.planId}.v%`}`));
  if (!versions.length) throw notFound("commission_plan");
  const latest = [...versions].sort((a, b) => versionOf(b.id) - versionOf(a.id))[0];
  if (latest.basis === "profit" && !can(actor, "profit.read")) throw new AppError("profit_basis_needs_permission", 403);
  const today = baghdadDay(now);
  if (input.endsOn && input.endsOn < today) throw invalid({ endsOn: "rule_start_past" });
  let endsAt = !input.endsOn || input.endsOn === today ? now : dayStart(input.endsOn);
  if (latest.startsAt !== null && endsAt < latest.startsAt) endsAt = latest.startsAt;
  if (latest.endsAt !== null && latest.endsAt <= endsAt) throw new AppError("rule_ended", 409);
  try {
    await runBatch(db, [
      db
        .update(commissionRules)
        .set({ endsAt })
        .where(and(eq(commissionRules.id, latest.id), or(isNull(commissionRules.endsAt), sql`${commissionRules.endsAt} > ${endsAt}`))),
      expectThat(db, sql`(SELECT ends_at FROM commission_rules WHERE id = ${latest.id}) = ${endsAt}`, { code: "RULE_CHANGED", detail: latest.id }),
      expectThat(db, sql`(SELECT count(*) FROM commission_rules WHERE id = ${input.planId} OR id LIKE ${`${input.planId}.v%`}) = ${versions.length}`, { code: "RULE_CHANGED", detail: input.planId }),
      auditStatement(db, { actor, action: "staff.commission.plan_end", entityType: "commission_plan", entityId: input.planId, before: { endsAt: latest.endsAt }, after: { ruleId: latest.id, endsAt }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409);
    throw error;
  }
  return { endsAt };
}

// ───────────────────────────────────────────────────────────────── the engine (pure parts)

export type SaleLineFacts = {
  orderItemId: string;
  orderId: string;
  orderRef: string;
  channel: string;
  sellerId: string;
  at: number;
  kind: string;
  categoryId: string | null;
  qty: number;
  refundedQty: number;
  totalIqd: number;
  /** The line's share of the order-level discount. */
  discountShareIqd: number;
  /** The line's share of refunds made without items. */
  amountRefundShareIqd: number;
  /** [P] Landed cost per unit at the sale; null = unknown. */
  unitCostIqd: number | null;
};

/** What the line earns commission on, after discounts and returns (see the file header). */
export function salesBaseOf(line: Pick<SaleLineFacts, "qty" | "refundedQty" | "totalIqd" | "discountShareIqd" | "amountRefundShareIqd">): number {
  const kept = Math.max(0, line.qty - line.refundedQty);
  const net = Math.max(0, line.totalIqd - line.discountShareIqd);
  const before = line.qty > 0 ? Math.floor((net * kept) / line.qty) : 0;
  return Math.max(0, before - line.amountRefundShareIqd);
}

/** The realised profit of the line, or null when its cost is unknown. */
export function profitBaseOf(line: SaleLineFacts): number | null {
  if (line.unitCostIqd === null) return null;
  const kept = Math.max(0, line.qty - line.refundedQty);
  return salesBaseOf(line) - line.unitCostIqd * kept;
}

export function commissionOf(baseIqd: number, rateBps: number): number {
  return baseIqd <= 0 ? 0 : Math.floor((baseIqd * rateBps) / 10_000);
}

/** The plan version that pays a line: the seller's own, else one of their roles', else everyone's (in force at the sale). */
export function ruleForLine(rules: readonly CommissionRule[], line: Pick<SaleLineFacts, "sellerId" | "at" | "channel" | "kind" | "categoryId">, sellerRoleIds: ReadonlySet<string>): CommissionRule | null {
  const live = rules.filter((rule) => rule.isActive && (rule.startsAt === null || rule.startsAt <= line.at) && (rule.endsAt === null || rule.endsAt > line.at) && (rule.channel === null || rule.channel === line.channel));
  const kind = line.kind as Parameters<typeof commissionFor>[1];
  return (
    commissionFor(
      live.filter((rule) => rule.employeeId === line.sellerId),
      kind,
      line.categoryId,
    ) ??
    commissionFor(
      live.filter((rule) => rule.employeeId === null && rule.roleId !== null && sellerRoleIds.has(rule.roleId)),
      kind,
      line.categoryId,
    ) ??
    commissionFor(
      live.filter((rule) => rule.employeeId === null && rule.roleId === null),
      kind,
      line.categoryId,
    )
  );
}

/** Splits `amount` across lines by weight; nothing to split or no weight → zeros. */
function share(amount: number, weights: { id: string; weight: number }[]): Map<string, number> {
  if (amount <= 0 || weights.every((line) => line.weight <= 0)) return new Map(weights.map((line) => [line.id, 0]));
  return allocateAmount(amount, weights);
}

// ───────────────────────────────────────────────────────────────── the engine (computing)

type CandidateRow = {
  orderItemId: string;
  orderId: string;
  orderRef: string;
  channel: string;
  sellerId: string;
  at: number;
  orderIsDemo: number;
  orderDiscountIqd: number;
  kind: string;
  categoryId: string | null;
  qty: number;
  refundedQty: number;
  totalIqd: number;
  unitCostIqd: number | null;
};

/** The order lines a computation of `period` looks at, with the facts the base needs. */
async function candidateLines(db: Db, period: string): Promise<SaleLineFacts[]> {
  const { from, to } = periodRange(period);
  const rows = await db.all<CandidateRow>(sql`
    SELECT oi.id AS orderItemId, oi.order_id AS orderId, o.ref AS orderRef, o.channel AS channel, o.cashier_id AS sellerId,
           o.delivered_at AS at, o.is_demo AS orderIsDemo, o.discount_iqd AS orderDiscountIqd, p.kind AS kind,
           p.category_id AS categoryId, oi.qty AS qty, oi.refunded_qty AS refundedQty, oi.total_iqd AS totalIqd,
           oi.cost_snapshot_iqd AS unitCostIqd
    FROM order_items AS oi
    JOIN orders AS o ON o.id = oi.order_id
    JOIN variants AS v ON v.id = oi.variant_id
    JOIN products AS p ON p.id = v.product_id
    JOIN employees AS e ON e.id = o.cashier_id
    WHERE o.cashier_id IS NOT NULL AND o.delivered_at IS NOT NULL AND o.status IN ('delivered', 'returned')
      AND (o.is_demo = 0 OR e.is_demo = 1)
      AND (
        (o.delivered_at >= ${from} AND o.delivered_at < ${to})
        OR o.id IN (
          SELECT x.order_id FROM (SELECT order_id, max(created_at) AS last FROM commissions GROUP BY order_id) AS x
          WHERE EXISTS (SELECT 1 FROM refunds AS r WHERE r.order_id = x.order_id AND r.status = 'paid' AND r.paid_at > x.last)
        )
      )
    ORDER BY o.delivered_at, oi.id`);
  if (!rows.length) return [];
  const orderIds = [...new Set(rows.map((row) => row.orderId))];
  const amountRefunds = new Map<string, number>();
  for (let at = 0; at < orderIds.length; at += 90) {
    const part = orderIds.slice(at, at + 90);
    const found = await db.all<{ orderId: string; amount: number }>(sql`
      SELECT r.order_id AS orderId, sum(r.amount_iqd) AS amount FROM refunds AS r
      WHERE r.status = 'paid' AND r.order_id IN (${sql.join(
        part.map((id) => sql`${id}`),
        sql`, `,
      )}) AND NOT EXISTS (SELECT 1 FROM refund_items AS ri WHERE ri.refund_id = r.id)
      GROUP BY r.order_id`);
    for (const row of found) amountRefunds.set(row.orderId, Number(row.amount));
  }
  const lines: SaleLineFacts[] = [];
  for (const orderId of orderIds) {
    const mine = rows.filter((row) => row.orderId === orderId);
    const discounts = share(
      Number(mine[0].orderDiscountIqd),
      mine.map((row) => ({ id: row.orderItemId, weight: Number(row.totalIqd) })),
    );
    const before = mine.map((row) => ({ row, base: salesBaseOf({ qty: row.qty, refundedQty: row.refundedQty, totalIqd: row.totalIqd, discountShareIqd: discounts.get(row.orderItemId) ?? 0, amountRefundShareIqd: 0 }) }));
    const refunds = share(
      amountRefunds.get(orderId) ?? 0,
      before.map((item) => ({ id: item.row.orderItemId, weight: item.base })),
    );
    for (const { row } of before) {
      lines.push({
        orderItemId: row.orderItemId,
        orderId: row.orderId,
        orderRef: row.orderRef,
        channel: row.channel,
        sellerId: row.sellerId,
        at: Number(row.at),
        kind: row.kind,
        categoryId: row.categoryId,
        qty: Number(row.qty),
        refundedQty: Number(row.refundedQty),
        totalIqd: Number(row.totalIqd),
        discountShareIqd: discounts.get(row.orderItemId) ?? 0,
        amountRefundShareIqd: refunds.get(row.orderItemId) ?? 0,
        unitCostIqd: row.unitCostIqd === null ? null : Number(row.unitCostIqd),
      });
    }
  }
  return lines;
}

export type SyncResult = { period: string; lines: number; earned: number; clawbacks: number; earnIqd: number; clawbackIqd: number; uncosted: number; noPlan: number; unchanged: number };

/**
 * Computes the commissions of a month (staff.commission.manage or staff.payroll.run), see the file header. Writes only
 * differences: running it twice writes nothing the second time.
 */
export async function syncCommissions(db: Db, actor: Actor, raw: { period: string }, now: number): Promise<SyncResult> {
  assertAny(actor, SYNCERS);
  const period = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "invalid")
    .parse(raw.period);
  if (period > periodOf(now)) throw invalid({ period: "period_future" });
  const lines = await candidateLines(db, period);
  const result: SyncResult = { period, lines: lines.length, earned: 0, clawbacks: 0, earnIqd: 0, clawbackIqd: 0, uncosted: 0, noPlan: 0, unchanged: 0 };
  if (!lines.length) return result;
  const itemIds = lines.map((line) => line.orderItemId);
  const existing: Commission[] = [];
  for (let at = 0; at < itemIds.length; at += 90) {
    existing.push(
      ...(await db
        .select()
        .from(commissions)
        .where(and(inArray(commissions.orderItemId, itemIds.slice(at, at + 90)), ne(commissions.status, "void")))
        .orderBy(asc(commissions.createdAt), asc(commissions.id))),
    );
  }
  const sellers = [...new Set(lines.map((line) => line.sellerId))];
  const [rules, roleRows] = await Promise.all([db.select().from(commissionRules), db.select({ employeeId: employeeRoles.employeeId, roleId: employeeRoles.roleId }).from(employeeRoles).where(inArray(employeeRoles.employeeId, sellers))]);
  const rolesOfSeller = new Map<string, Set<string>>();
  for (const row of roleRows) rolesOfSeller.set(row.employeeId, (rolesOfSeller.get(row.employeeId) ?? new Set()).add(row.roleId));
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const nowPeriod = periodOf(now);
  const inserts: (typeof commissions.$inferInsert)[] = [];
  for (const line of lines) {
    const rows = existing.filter((row) => row.orderItemId === line.orderItemId);
    const first = rows[0];
    const rule = first ? (first.ruleId ? (ruleById.get(first.ruleId) ?? null) : null) : ruleForLine(rules, line, rolesOfSeller.get(line.sellerId) ?? new Set());
    const basis = first ? first.basis : rule?.basis;
    const rateBps = first ? first.rateBps : rule?.rateBps;
    if (!basis || rateBps === undefined) {
      result.noPlan += 1;
      continue;
    }
    const base = basis === "sales" ? salesBaseOf(line) : profitBaseOf(line);
    if (base === null) {
      result.uncosted += 1;
      continue;
    }
    const desired = commissionOf(base, rateBps);
    const have = rows.reduce((sum, row) => sum + row.amountIqd, 0);
    const delta = desired - have;
    if (delta === 0) {
      result.unchanged += 1;
      continue;
    }
    const employeeId = first ? first.employeeId : line.sellerId;
    inserts.push({
      id: `com_${line.orderItemId}_${rows.length + 1}`,
      employeeId,
      orderId: line.orderId,
      orderItemId: line.orderItemId,
      ruleId: rule?.id ?? first?.ruleId ?? null,
      kind: delta > 0 ? "earn" : "clawback",
      basis,
      baseAmountIqd: base,
      rateBps,
      amountIqd: delta,
      status: "accrued",
      payrollRunId: null,
      period: first ? nowPeriod : periodOf(line.at),
      createdAt: now,
    });
    if (delta > 0) {
      result.earned += 1;
      result.earnIqd += delta;
    } else {
      result.clawbacks += 1;
      result.clawbackIqd += -delta;
    }
  }
  if (!inserts.length) return result;
  const chunks = chunkRows(commissions, inserts);
  try {
    for (let at = 0; at < chunks.length; at += 40) {
      const part = chunks.slice(at, at + 40);
      const statements: BatchStatement[] = part.map((rows) => db.insert(commissions).values(rows));
      if (at + 40 >= chunks.length) {
        statements.push(
          auditStatement(db, {
            actor,
            action: "staff.commission.sync",
            entityType: "commission_period",
            entityId: period,
            summary: `${period}: ${result.earned} earned, ${result.clawbacks} clawed back`,
            after: { lines: result.lines, earned: result.earned, clawbacks: result.clawbacks, earnIqd: result.earnIqd, clawbackIqd: result.clawbackIqd, uncosted: result.uncosted, noPlan: result.noPlan },
            at: now,
          }),
        );
      }
      await runBatch(db, statements);
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("commission_sync_busy", 409);
    throw error;
  }
  return result;
}

/** syncCommissions as the scheduled job would run it (the month and the one before). */
export async function syncCommissionsJob(db: Db, actor: Actor, now: number): Promise<SyncResult[]> {
  const period = periodOf(now);
  return [await syncCommissions(db, actor, { period: shiftPeriod(period, -1) }, now), await syncCommissions(db, actor, { period }, now)];
}

// ───────────────────────────────────────────────────────────────── the ledger

export type CommissionLedger = {
  period: string;
  totals: CommissionTotals[];
  sum: { earnIqd: number; clawbackIqd: number; netIqd: number; accruedIqd: number; inRunIqd: number; paidIqd: number };
  lines: CommissionLine[];
  total: number;
  page: number;
  pageCount: number;
  employees: (PersonRef & { status: "active" | "disabled" })[];
  can: { sync: boolean; profit: boolean };
};

/** One month's commissions: per employee and line by line (base and rate of profit rows only with profit.read). */
export async function commissionLedger(db: Db, actor: Actor, filters: CommissionFilters): Promise<CommissionLedger> {
  assertAny(actor, PLAN_READERS);
  const profit = can(actor, "profit.read");
  const where: SQL[] = [eq(commissions.period, filters.period), ne(commissions.status, "void")];
  // an employee limited to a branch sees the commissions of that branch's staff only (the totals too)
  const reach = reachSql(actor, commissions.employeeId);
  if (reach) where.push(reach);
  if (filters.employee) where.push(eq(commissions.employeeId, filters.employee));
  const condition = and(...where);
  const [grouped, rows, count, options] = await Promise.all([
    db
      .select({
        employeeId: commissions.employeeId,
        earn: sql<number>`coalesce(sum(CASE WHEN ${commissions.amountIqd} > 0 THEN ${commissions.amountIqd} ELSE 0 END), 0)`,
        clawback: sql<number>`coalesce(sum(CASE WHEN ${commissions.amountIqd} < 0 THEN -${commissions.amountIqd} ELSE 0 END), 0)`,
        net: sql<number>`coalesce(sum(${commissions.amountIqd}), 0)`,
        accrued: sql<number>`coalesce(sum(CASE WHEN ${commissions.status} = 'accrued' AND ${commissions.payrollRunId} IS NULL THEN ${commissions.amountIqd} ELSE 0 END), 0)`,
        inRun: sql<number>`coalesce(sum(CASE WHEN ${commissions.payrollRunId} IS NOT NULL AND ${commissions.status} <> 'paid' THEN ${commissions.amountIqd} ELSE 0 END), 0)`,
        paid: sql<number>`coalesce(sum(CASE WHEN ${commissions.status} = 'paid' THEN ${commissions.amountIqd} ELSE 0 END), 0)`,
        rows: sql<number>`count(*)`,
      })
      .from(commissions)
      .where(condition)
      .groupBy(commissions.employeeId),
    db
      .select({ row: commissions, orderRef: sql<string>`(SELECT ref FROM orders WHERE id = ${commissions.orderId})` })
      .from(commissions)
      .where(condition)
      .orderBy(desc(commissions.createdAt), asc(commissions.id))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(commissions).where(condition).get(),
    employeeOptions(db, { includeDisabled: true, branchId: branchLimit(actor) }),
  ]);
  const people = await peopleById(db, [...grouped.map((row) => row.employeeId), ...rows.map(({ row }) => row.employeeId)]);
  const totals: CommissionTotals[] = grouped
    .map((row) => ({
      employee: personOf(people, row.employeeId),
      earnIqd: Number(row.earn),
      clawbackIqd: Number(row.clawback),
      netIqd: Number(row.net),
      salesIqd: null,
      profitIqd: null,
      rows: Number(row.rows),
      accruedIqd: Number(row.accrued),
      inRunIqd: Number(row.inRun),
      paidIqd: Number(row.paid),
    }))
    .sort((a, b) => b.netIqd - a.netIqd);
  const sum = totals.reduce(
    (acc, row) => ({ earnIqd: acc.earnIqd + row.earnIqd, clawbackIqd: acc.clawbackIqd + row.clawbackIqd, netIqd: acc.netIqd + row.netIqd, accruedIqd: acc.accruedIqd + row.accruedIqd, inRunIqd: acc.inRunIqd + row.inRunIqd, paidIqd: acc.paidIqd + row.paidIqd }),
    { earnIqd: 0, clawbackIqd: 0, netIqd: 0, accruedIqd: 0, inRunIqd: 0, paidIqd: 0 },
  );
  const total = Number(count?.n ?? 0);
  return {
    period: filters.period,
    totals,
    sum,
    lines: rows.map(({ row, orderRef }) => {
      const hidden = row.basis === "profit" && !profit;
      return {
        id: row.id,
        employee: personOf(people, row.employeeId),
        orderRef: orderRef ?? row.orderId,
        orderId: row.orderId,
        kind: row.kind,
        basis: row.basis,
        baseIqd: hidden ? null : row.baseAmountIqd,
        rateBps: hidden ? null : row.rateBps,
        amountIqd: row.amountIqd,
        status: row.status,
        period: row.period,
        runId: row.payrollRunId,
        createdAt: row.createdAt,
      };
    }),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    employees: options,
    can: { sync: can(actor, "staff.commission.manage") || can(actor, "staff.payroll.run"), profit },
  };
}

/** The signed-in employee's own commissions of a month: amounts per line (profit rows without base or rate). */
export async function myCommissions(db: Db, actor: Actor, period: string): Promise<{ netIqd: number; lines: CommissionLine[] }> {
  const me = actor.kind === "employee" ? actor.id : null;
  if (!me || !ID.test(me)) return { netIqd: 0, lines: [] };
  const rows = await db
    .select({ row: commissions, orderRef: sql<string>`(SELECT ref FROM orders WHERE id = ${commissions.orderId})` })
    .from(commissions)
    .where(and(eq(commissions.employeeId, me), eq(commissions.period, period), ne(commissions.status, "void")))
    .orderBy(desc(commissions.createdAt))
    .limit(100);
  const profit = can(actor, "profit.read");
  const people = await peopleById(db, [me]);
  return {
    netIqd: rows.reduce((sum, { row }) => sum + row.amountIqd, 0),
    lines: rows.map(({ row, orderRef }) => ({
      id: row.id,
      employee: personOf(people, me),
      orderRef: orderRef ?? row.orderId,
      orderId: row.orderId,
      kind: row.kind,
      basis: row.basis,
      baseIqd: row.basis === "profit" && !profit ? null : row.baseAmountIqd,
      rateBps: row.basis === "profit" && !profit ? null : row.rateBps,
      amountIqd: row.amountIqd,
      status: row.status,
      period: row.period,
      runId: row.payrollRunId,
      createdAt: row.createdAt,
    })),
  };
}

