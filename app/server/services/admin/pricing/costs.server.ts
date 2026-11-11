/**
 * Purchase cost and margin rules of a SKU (admin 03.01, 03.02 per unit, 03.03) — the protected `variant_costs` row.
 *
 *   await setVariantCost(db, actor, { variantId, currency: "USD", unitCost: "249.99", fxRate: "1310", fxDate: "2026-11-10",
 *                                     extrasIqd: "6,500", reason, expectedUpdatedAt }, now);
 *   await setMarginRules(db, actor, { variantId, minMargin: "8", targetMargin: "17", reason }, now);
 *   await setMarginRulesBulk(db, actor, { variantIds, minMargin, targetMargin, reason }, now);
 *
 * COST (pricing.cost.update + cost.read): the supplier currency, the unit cost in it, the dated rate (IQD per unit;
 * the store's USD rate of that day is the default), and the per-unit freight, customs, fees and commissions →
 * landed cost per unit = purchase cost in IQD (exact, rounded half up) + those. Receipt-level bills are spread on
 * the landed-cost page instead (landed.server.ts). The form carries the row's `updated_at`: someone else's newer
 * edit is never overwritten silently (`cost_changed`). Saving identical values changes nothing.
 *
 * MARGINS (pricing.margin.manage + profit.read): minimum margin (a price under it needs pricing.discount.override
 * from a second person, 03.03/03.05) and target margin (the suggestion's starting point, 03.08), 0–95 %,
 * minimum ≤ target. A SKU needs a cost row first: a margin without a cost means nothing.
 *
 * Pricing decisions use this landed cost; the cost of goods sold uses each receipt's FIFO layers (commerce core).
 * Error codes: forbidden (403), not_found (404), invalid (400), cost_changed (409), no_cost_row (409).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { employees, variantCosts, variants } from "~/server/db/schema";
import { expectThat, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { actorId } from "./access";
import { chunks, openLayersFor } from "./facts.server";
import { baghdadDate, storeRateAt } from "./fx.server";
import { BPS, COST_CURRENCIES, isCostCurrency, MAX_PRICE_IQD, parseDecimal, parsePercentBps, parseRateMicros, purchaseCostIqd, type CostCurrency } from "./rules";

const text = (max: number) => z.string().trim().max(max, "too_long");

export const CostInput = z.object({
  variantId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  currency: z.string({ error: "required" }).trim().toUpperCase().refine(isCostCurrency, "invalid"),
  unitCost: z.union([z.string(), z.number()], { error: "required" }),
  fxRate: z.union([z.string(), z.number()]).optional(),
  fxDate: text(10).optional(),
  extrasIqd: z.union([z.string(), z.number()]).optional(),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
  /** The row's updated_at when the form was opened; "" / 0 for a SKU without a cost row yet. */
  expectedUpdatedAt: z.union([z.string(), z.number()]).optional(),
});

export type CostPlan = {
  currency: CostCurrency;
  unitCostMinor: number;
  fxRateMicros: number;
  fxDate: string | null;
  purchaseIqd: number;
  extrasIqd: number;
  landedIqd: number;
};

/** Turns the typed form into exact integers, or throws `invalid` with every field that is wrong. */
export function planCost(raw: z.output<typeof CostInput>, now: number): CostPlan {
  const fields: Record<string, string> = {};
  const currency = raw.currency as CostCurrency;
  const decimals = COST_CURRENCIES[currency];
  const unitCostMinor = parseDecimal(raw.unitCost, decimals);
  if (raw.unitCost === "" || raw.unitCost === undefined) fields.unitCost = "required";
  else if (unitCostMinor === null) fields.unitCost = decimals === 0 ? "whole_number" : "invalid";
  let fxRateMicros = 1_000_000;
  let fxDate: string | null = raw.fxDate ? raw.fxDate : null;
  if (currency !== "IQD") {
    const rate = raw.fxRate === undefined || raw.fxRate === "" ? null : parseRateMicros(raw.fxRate);
    if (raw.fxRate === undefined || raw.fxRate === "") fields.fxRate = "required";
    else if (rate === null || rate <= 0) fields.fxRate = "invalid";
    else fxRateMicros = rate;
    if (!fxDate) fields.fxDate = "required";
  }
  if (fxDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fxDate) || Number.isNaN(Date.parse(`${fxDate}T00:00:00Z`))) fields.fxDate = "invalid";
    else if (fxDate > baghdadDate(now)) fields.fxDate = "date_future";
  }
  const extras = raw.extrasIqd === undefined || raw.extrasIqd === "" ? 0 : parseDecimal(raw.extrasIqd, 0);
  if (extras === null) fields.extrasIqd = "whole_number";
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const purchaseIqd = purchaseCostIqd(unitCostMinor!, decimals, fxRateMicros);
  const landedIqd = purchaseIqd + extras!;
  if (landedIqd <= 0) throw invalid({ unitCost: "too_small" });
  if (landedIqd > MAX_PRICE_IQD) throw invalid({ unitCost: "too_big" });
  return { currency, unitCostMinor: unitCostMinor!, fxRateMicros, fxDate, purchaseIqd, extrasIqd: extras!, landedIqd };
}

/** The store's rate for a currency on a day (IQD per unit × 10⁶), when it keeps one — the cost form's default. */
export async function defaultRateMicros(db: Db, currency: string, date: string): Promise<number | null> {
  if (currency === "IQD") return 1_000_000;
  const endOfDay = Date.parse(`${date}T23:59:59Z`) - 3 * 60 * 60 * 1000;
  const row = Number.isNaN(endOfDay) ? null : await storeRateAt(db, currency, endOfDay);
  return row ? row.iqdPerUnit * 1_000_000 : null;
}

function costGuard(db: Db, variantId: string, expected: number): BatchStatement {
  return expectThat(db, sql`coalesce((select updated_at from variant_costs where variant_id = ${variantId}), 0) = ${expected}`, { code: "COST_CHANGED", detail: variantId });
}

/** Records the purchase and landed cost of a SKU. Returns the computed amounts; `changed: false` when nothing differed. */
export async function setVariantCost(db: Db, actor: Actor, raw: unknown, now: number): Promise<CostPlan & { changed: boolean }> {
  assertCan(actor, "pricing.cost.update");
  assertCan(actor, "cost.read");
  const input = CostInput.parse(raw);
  const plan = planCost(input, now);
  const variant = await db.select({ id: variants.id, sku: variants.sku }).from(variants).where(eq(variants.id, input.variantId)).get();
  if (!variant) throw notFound("variant");
  const current = await db.select().from(variantCosts).where(eq(variantCosts.variantId, variant.id)).get();
  const expected = Number(input.expectedUpdatedAt ?? 0) || 0;
  const same =
    current &&
    current.currency === plan.currency &&
    current.unitCostMinor === plan.unitCostMinor &&
    current.fxRateMicros === plan.fxRateMicros &&
    (current.fxDate ?? null) === plan.fxDate &&
    current.landedCostIqd === plan.landedIqd;
  // The cost already is what the form says (a double submit, or the same values from someone else): nothing to do.
  if (same) return { ...plan, changed: false };
  if ((current?.updatedAt ?? 0) !== expected) throw new AppError("cost_changed", 409, { detail: variant.id });
  const values = { currency: plan.currency, unitCostMinor: plan.unitCostMinor, fxRateMicros: plan.fxRateMicros, fxDate: plan.fxDate, landedCostIqd: plan.landedIqd, updatedBy: actorId(actor), updatedAt: now };
  await runBatch(db, [
    costGuard(db, variant.id, expected),
    db
      .insert(variantCosts)
      .values({ variantId: variant.id, ...values })
      .onConflictDoUpdate({ target: variantCosts.variantId, set: values }),
    auditStatement(db, {
      actor,
      action: "pricing.cost.update",
      entityType: "variant",
      entityId: variant.id,
      summary: variant.sku,
      before: current
        ? { currency: current.currency, unitCostMinor: current.unitCostMinor, fxRateMicros: current.fxRateMicros, fxDate: current.fxDate, landedCostIqd: current.landedCostIqd }
        : null,
      after: { currency: plan.currency, unitCostMinor: plan.unitCostMinor, fxRateMicros: plan.fxRateMicros, fxDate: plan.fxDate, purchaseIqd: plan.purchaseIqd, extrasIqd: plan.extrasIqd, landedCostIqd: plan.landedIqd },
      reason: input.reason,
      at: now,
    }),
  ]).catch((error) => {
    throw toAppError(error) ?? error;
  });
  return { ...plan, changed: true };
}

const MAX_MARGIN_BPS = 9_500;

export const MarginInput = z.object({
  variantId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  minMargin: z.union([z.string(), z.number()]).optional(),
  targetMargin: z.union([z.string(), z.number()]).optional(),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
});

/** "8.5" / 850 / "" → basis points or null (empty = no rule), with field errors. */
export function planMargins(raw: { minMargin?: string | number; targetMargin?: string | number }): { minBps: number | null; targetBps: number | null } {
  const fields: Record<string, string> = {};
  const read = (value: string | number | undefined, field: string): number | null => {
    if (value === undefined || value === "") return null;
    const bps = typeof value === "number" ? value : parsePercentBps(value);
    if (bps === null || !Number.isSafeInteger(bps) || bps < 0 || bps > MAX_MARGIN_BPS) {
      fields[field] = "margin_range";
      return null;
    }
    return bps;
  };
  const minBps = read(raw.minMargin, "minMargin");
  const targetBps = read(raw.targetMargin, "targetMargin");
  if (minBps !== null && targetBps !== null && targetBps < minBps) fields.targetMargin = "target_below_min";
  if (Object.keys(fields).length > 0) throw invalid(fields);
  return { minBps, targetBps };
}

/** Sets the minimum and target margin of one SKU (it must have a cost row). */
export async function setMarginRules(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "pricing.margin.manage");
  assertCan(actor, "profit.read");
  const input = MarginInput.parse(raw);
  const { minBps, targetBps } = planMargins(input);
  const current = await db.select().from(variantCosts).where(eq(variantCosts.variantId, input.variantId)).get();
  if (!current) {
    const exists = await db.select({ id: variants.id }).from(variants).where(eq(variants.id, input.variantId)).get();
    if (!exists) throw notFound("variant");
    throw new AppError("no_cost_row", 409, { detail: input.variantId });
  }
  if (current.minMarginBps === minBps && current.targetMarginBps === targetBps) return { changed: false };
  await runBatch(db, [
    db
      .update(variantCosts)
      .set({ minMarginBps: minBps, targetMarginBps: targetBps, updatedBy: actorId(actor), updatedAt: now })
      .where(eq(variantCosts.variantId, input.variantId)),
    auditStatement(db, {
      actor,
      action: "pricing.margin.update",
      entityType: "variant",
      entityId: input.variantId,
      before: { minMarginBps: current.minMarginBps, targetMarginBps: current.targetMarginBps },
      after: { minMarginBps: minBps, targetMarginBps: targetBps },
      reason: input.reason,
      at: now,
    }),
  ]);
  return { changed: true };
}

export const BulkMarginInput = z.object({
  variantIds: z.array(z.string().trim().min(1).max(120)).min(1, "required").max(200, "too_big"),
  minMargin: z.union([z.string(), z.number()]).optional(),
  targetMargin: z.union([z.string(), z.number()]).optional(),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
});

/**
 * The same margin rules for many SKUs at once (one batch, one audit event listing every SKU with its old rules).
 * SKUs without a cost row are skipped and counted.
 */
export async function setMarginRulesBulk(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ updated: number; skipped: number }> {
  assertCan(actor, "pricing.margin.manage");
  assertCan(actor, "profit.read");
  const input = BulkMarginInput.parse(raw);
  const { minBps, targetBps } = planMargins(input);
  const ids = [...new Set(input.variantIds)];
  const rows: (typeof variantCosts.$inferSelect)[] = [];
  for (const part of chunks(ids)) rows.push(...(await db.select().from(variantCosts).where(inArray(variantCosts.variantId, part))));
  const targets = rows.filter((row) => row.minMarginBps !== minBps || row.targetMarginBps !== targetBps);
  if (targets.length === 0) return { updated: 0, skipped: ids.length - rows.length };
  await runBatch(db, [
    ...chunks(targets.map((row) => row.variantId)).map((part) =>
      db.update(variantCosts).set({ minMarginBps: minBps, targetMarginBps: targetBps, updatedBy: actorId(actor), updatedAt: now }).where(and(inArray(variantCosts.variantId, part))),
    ),
    auditStatement(db, {
      actor,
      action: "pricing.margin.bulk_update",
      entityType: "variant",
      entityId: null,
      summary: `${targets.length} SKUs`,
      before: targets.map((row) => ({ variantId: row.variantId, minMarginBps: row.minMarginBps, targetMarginBps: row.targetMarginBps })),
      after: { minMarginBps: minBps, targetMarginBps: targetBps },
      reason: input.reason,
      at: now,
    }),
  ]);
  return { updated: targets.length, skipped: ids.length - rows.length };
}

/** Margin rules as a percent, for forms ("8.5"); empty when not set. */
export const marginText = (bps: number | null) => (bps === null ? "" : String(bps / 100));

export { BPS };

export type CostDetail = {
  row: {
    currency: string;
    unitCostMinor: number;
    decimals: number;
    fxRateMicros: number | null;
    fxDate: string | null;
    purchaseIqd: number | null;
    landedCostIqd: number;
    /** landed − purchase: freight, customs, fees and commissions per unit (null when the purchase cost cannot be computed). */
    extrasIqd: number | null;
    minMarginBps: number | null;
    targetMarginBps: number | null;
    updatedAt: number;
    updatedBy: { id: string; name: string } | null;
  } | null;
  layers: { id: string; qtyRemaining: number; qtyReceived: number; unitCostIqd: number; receivedAt: number; source: string }[];
  /** The store's USD rate today (IQD per USD × 10⁶), the form's default. */
  usdRateMicros: number | null;
  today: string;
};

/** The cost row with its parts, the FIFO layers still holding stock and today's store rate. Needs cost.read. */
export async function getCostDetail(db: Db, actor: Actor, variantId: string, now: number): Promise<CostDetail> {
  assertCan(actor, "cost.read");
  const row = await db.select().from(variantCosts).where(eq(variantCosts.variantId, variantId)).get();
  const today = baghdadDate(now);
  const [layers, usdRateMicros, who] = await Promise.all([
    openLayersFor(db, variantId),
    defaultRateMicros(db, "USD", today),
    row?.updatedBy ? db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.id, row.updatedBy)).get() : Promise.resolve(undefined),
  ]);
  let detail: CostDetail["row"] = null;
  if (row) {
    const decimals = isCostCurrency(row.currency) ? COST_CURRENCIES[row.currency] : 2;
    const purchaseIqd = row.fxRateMicros !== null || row.currency === "IQD" ? purchaseCostIqd(row.unitCostMinor, decimals, row.fxRateMicros ?? 1_000_000) : null;
    detail = {
      currency: row.currency,
      unitCostMinor: row.unitCostMinor,
      decimals,
      fxRateMicros: row.fxRateMicros,
      fxDate: row.fxDate,
      purchaseIqd,
      landedCostIqd: row.landedCostIqd,
      extrasIqd: purchaseIqd === null ? null : row.landedCostIqd - purchaseIqd,
      minMarginBps: row.minMarginBps,
      targetMarginBps: row.targetMarginBps,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy ? { id: row.updatedBy, name: who?.name ?? row.updatedBy } : null,
    };
  }
  return { row: detail, layers: layers.map((layer) => ({ ...layer, source: String(layer.source) })), usdRateMicros, today };
}
