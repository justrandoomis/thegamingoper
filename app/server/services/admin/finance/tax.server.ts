/**
 * Admin 10.08 — tax configuration and the tax report (finance.tax.manage).
 *
 * What is true for this store today, and what the screen says plainly: NO tax rate is configured (none is seeded —
 * which taxes apply to the store in Iraq is the owner's decision with their accountant, not something the software
 * invents). Prices are tax-inclusive, checkout adds no tax, and the chart of accounts has no tax-liability account
 * (postSale refuses an order carrying tax). So a rate configured here is REPORTED — the tax contained in the prices of
 * the delivered sales it covers — and never added at checkout nor posted to the journal.
 *
 *   tax included in a price = round(price × rate / (10,000 + rate))      (rate in basis points)
 *
 * The base is the line totals (after line discounts) of the orders delivered in the range whose product kind and
 * channel the rate covers; order-level discounts and refunds of the range are shown beside it for the accountant,
 * not spread over the lines.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { L10n, Locale } from "~/lib/locales";
import { pick } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { ORDER_CHANNELS, PRODUCT_KINDS, taxRates, type TaxRate } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { revenueRecognised, type RevenueSection } from "~/server/services/accounting/reports.server";
import { employeeNames } from "./shared.server";
import { isDay, dayStart, latinDigits, type RangeFilter } from "./types";

export const TAX_ERROR_KEYS = ["tax_code_taken", "tax_rate_changed", "tax_rate_invalid"] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const num = (value: unknown) => Number(value ?? 0);

export type TaxScope = { productKinds?: string[]; channels?: string[] };

export type TaxRateRow = {
  id: string;
  code: string;
  name: string;
  nameL10n: L10n;
  rateBps: number;
  isInclusive: boolean;
  scope: TaxScope;
  isActive: boolean;
  effectiveAt: number | null;
  updatedBy: string | null;
  updatedAt: number;
};

function scopeOf(row: TaxRate): TaxScope {
  const raw = (row.appliesTo ?? {}) as Record<string, unknown>;
  const kinds = Array.isArray(raw.productKinds) ? raw.productKinds.filter((k): k is string => typeof k === "string" && (PRODUCT_KINDS as readonly string[]).includes(k)) : [];
  const channels = Array.isArray(raw.channels) ? raw.channels.filter((c): c is string => typeof c === "string" && (ORDER_CHANNELS as readonly string[]).includes(c)) : [];
  return { ...(kinds.length ? { productKinds: kinds } : {}), ...(channels.length ? { channels } : {}) };
}

export async function listTaxRates(db: Db, actor: Actor, locale: Locale): Promise<TaxRateRow[]> {
  assertCan(actor, "finance.tax.manage");
  const rows = await db.select().from(taxRates).orderBy(taxRates.code);
  const names = await employeeNames(db, rows.map((row) => row.updatedBy));
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: pick(row.name, locale),
    nameL10n: row.name,
    rateBps: row.rateBps,
    isInclusive: row.isInclusive,
    scope: scopeOf(row),
    isActive: row.isActive,
    effectiveAt: row.effectiveAt,
    updatedBy: row.updatedBy ? (names.get(row.updatedBy) ?? null) : null,
    updatedAt: row.updatedAt,
  }));
}

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);

export const SaveTaxRateInput = z.object({
  id: z.preprocess(blank, z.string().regex(ID, "invalid").optional()),
  // digits typed on an Arabic or Kurdish keyboard read as digits
  code: z.preprocess((value) => (typeof value === "string" ? latinDigits(value) : value), z.string({ error: "required" }).trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,23}$/, "invalid")),
  nameAr: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  nameEn: z.preprocess(blank, z.string().trim().max(80, "too_long").optional()),
  rateBps: z.number({ error: (issue) => (issue.input === undefined ? "required" : "tax_rate_invalid") }).int("tax_rate_invalid").min(0, "tax_rate_invalid").max(10_000, "tax_rate_invalid"),
  productKinds: z.array(z.enum(PRODUCT_KINDS)).max(PRODUCT_KINDS.length).default([]),
  channels: z.array(z.enum(ORDER_CHANNELS)).max(ORDER_CHANNELS.length).default([]),
  isActive: z.boolean(),
  /** "YYYY-MM-DD" (Baghdad) from which the rate applies; empty = from the start. */
  effectiveFrom: z.preprocess(blank, z.string().refine((value) => isDay(value), "invalid").optional()),
  reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long"),
  /** The row's `updated_at` when the form was opened (stale-tab guard). */
  expectedUpdatedAt: z.preprocess(blank, z.number().int().optional()),
});
export type SaveTaxRateInput = z.input<typeof SaveTaxRateInput>;

/**
 * Adds or changes a tax rate (finance.tax.manage). Every rate is included in prices (checkout adds none). A change made
 * from a stale page is refused (tax_rate_changed). Audited with before/after and the reason.
 */
export async function saveTaxRate(db: Db, actor: Actor, raw: SaveTaxRateInput, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "finance.tax.manage");
  const input = SaveTaxRateInput.parse(raw);
  const name: L10n = { ar: input.nameAr, ...(input.nameEn ? { en: input.nameEn } : {}) };
  const appliesTo: TaxScope = { ...(input.productKinds.length ? { productKinds: input.productKinds } : {}), ...(input.channels.length ? { channels: input.channels } : {}) };
  const effectiveAt = input.effectiveFrom ? dayStart(input.effectiveFrom) : null;
  const updatedBy = actor.kind === "employee" ? actor.id : null;
  const values = { code: input.code, name, rateBps: input.rateBps, isInclusive: true, appliesTo: Object.keys(appliesTo).length ? appliesTo : null, isActive: input.isActive, effectiveAt, updatedBy, updatedAt: now };
  try {
    if (input.id) {
      const current = await db.select().from(taxRates).where(eq(taxRates.id, input.id)).get();
      if (!current) throw notFound("tax_rate");
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) throw new AppError("tax_rate_changed", 409);
      await runBatch(db, [
        db
          .update(taxRates)
          .set(values)
          .where(sql`${taxRates.id} = ${current.id} AND ${taxRates.updatedAt} = ${current.updatedAt}`),
        expectChanged(db, 1, { code: "TAX_RATE_CHANGED", detail: current.id }),
        auditStatement(db, {
          actor,
          action: "finance.tax.update",
          entityType: "tax_rate",
          entityId: current.id,
          before: { code: current.code, rateBps: current.rateBps, appliesTo: current.appliesTo, isActive: current.isActive, effectiveAt: current.effectiveAt },
          after: { code: values.code, rateBps: values.rateBps, appliesTo: values.appliesTo, isActive: values.isActive, effectiveAt: values.effectiveAt },
          reason: input.reason,
          at: now,
        }),
      ]);
      return { id: current.id, created: false };
    }
    const id = `tax_${input.code.toLowerCase()}`;
    await runBatch(db, [
      db.insert(taxRates).values({ id, ...values }),
      auditStatement(db, { actor, action: "finance.tax.create", entityType: "tax_rate", entityId: id, after: { code: values.code, rateBps: values.rateBps, appliesTo: values.appliesTo, isActive: values.isActive, effectiveAt: values.effectiveAt }, reason: input.reason, at: now }),
    ]);
    return { id, created: true };
  } catch (error) {
    const info = mapDbError(error);
    if (info?.code === "TAX_RATE_CHANGED") throw new AppError("tax_rate_changed", 409);
    if (info?.kind === "unique") throw new AppError("tax_code_taken", 409, { fields: { code: "tax_code_taken" } });
    throw error;
  }
}

export type TaxReportRow = { rate: TaxRateRow; baseIqd: number; lines: number; taxIqd: number; /** the rate started after the range began */ partial: boolean };

export type TaxReport = {
  configured: boolean;
  rows: TaxReportRow[];
  /** Revenue the journal recognised in the range (all products), for the accountant. */
  revenue: RevenueSection;
  /** Line totals of every order delivered in the range (the widest possible base). */
  deliveredLinesIqd: number;
};

/** Tax contained in a tax-inclusive amount. */
export function taxIncluded(amountIqd: number, rateBps: number): number {
  if (rateBps <= 0 || amountIqd === 0) return 0;
  return Math.round((amountIqd * rateBps) / (10_000 + rateBps));
}

/** The tax report of the range: for each active rate, the sales it covers and the tax those prices contain. */
export async function taxReport(db: Db, actor: Actor, range: RangeFilter, locale: Locale): Promise<TaxReport> {
  assertCan(actor, "finance.tax.manage");
  const rates = await listTaxRates(db, actor, locale);
  const demo = range.demo ? sql`1 = 1` : sql`o.is_demo = 0`;
  const baseFor = async (scope: TaxScope, from: number): Promise<{ base: number; lines: number }> => {
    const parts: SQL[] = [sql`o.delivered_at >= ${from}`, sql`o.delivered_at < ${range.toMs}`, demo];
    if (scope.productKinds?.length)
      parts.push(
        sql`p.kind IN (${sql.join(
          scope.productKinds.map((kind) => sql`${kind}`),
          sql`, `,
        )})`,
      );
    if (scope.channels?.length)
      parts.push(
        sql`o.channel IN (${sql.join(
          scope.channels.map((channel) => sql`${channel}`),
          sql`, `,
        )})`,
      );
    const rows = await db.all<{ base: number; lines: number }>(sql`
      SELECT coalesce(sum(i.total_iqd), 0) AS base, count(*) AS lines FROM order_items AS i JOIN orders AS o ON o.id = i.order_id
      LEFT JOIN variants AS v ON v.id = i.variant_id LEFT JOIN products AS p ON p.id = v.product_id
      WHERE ${sql.join(parts, sql` AND `)}`);
    return { base: num(rows[0]?.base), lines: num(rows[0]?.lines) };
  };
  const active = rates.filter((rate) => rate.isActive && (rate.effectiveAt === null || rate.effectiveAt < range.toMs));
  const rows: TaxReportRow[] = [];
  for (const rate of active) {
    const from = Math.max(range.fromMs, rate.effectiveAt ?? range.fromMs);
    const { base, lines } = await baseFor(rate.scope, from);
    rows.push({ rate, baseIqd: base, lines, taxIqd: taxIncluded(base, rate.rateBps), partial: from > range.fromMs });
  }
  const [revenue, all] = await Promise.all([revenueRecognised(db, { from: range.fromMs, to: range.toMs, includeDemo: range.demo }), baseFor({}, range.fromMs)]);
  return { configured: rates.length > 0, rows, revenue, deliveredLinesIqd: all.base };
}
