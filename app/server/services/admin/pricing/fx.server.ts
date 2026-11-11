/**
 * The store's exchange rate (admin 03, used by settings 22.01): IQD per one USD, dated. Shoppers see prices
 * converted at the newest rate whose `effective_at` has passed (app/server/shell.server.ts); payable amounts are
 * always IQD. Rates are never edited: a new rate is a new row, so the history stays exact. Purchase costs keep the
 * rate of their own purchase (variant_costs.fx_rate_micros) — this rate is only their default.
 *
 *   await setFxRate(db, actor, { iqdPerUnit: 1310, source: "سعر السوق في بغداد", effective: "now", reason, idempotencyKey }, now);
 *
 * Needs pricing.fx_rate.manage. Error codes: forbidden (403), invalid (400; fields iqdPerUnit, source, effectiveAt,
 * reason), rate_unchanged (409).
 */
import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { employees, fxRates } from "~/server/db/schema";
import { isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid } from "~/server/errors";
import { actorId, assertPricing } from "./access";
import { parseDecimal } from "./rules";

/** Quotes the store keeps a rate for. Only the US dollar today (the storefront's second currency). */
export const FX_QUOTES = ["USD"] as const;
export type FxQuote = (typeof FX_QUOTES)[number];

const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 90 * 86_400_000;

/** "2026-11-12T09:30" typed in Baghdad time → epoch ms; null when it is not such a value. */
export function parseBaghdadDateTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = "00", mi = "00"] = match;
  const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - BAGHDAD_OFFSET_MS;
  const check = new Date(at + BAGHDAD_OFFSET_MS);
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  return at;
}

/** "YYYY-MM-DD" of an instant in Baghdad. */
export const baghdadDate = (at: number) => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

export type FxRateView = { id: string; quote: string; iqdPerUnit: number; source: string; isDemo: boolean; effectiveAt: number; createdAt: number; createdBy: { id: string; name: string } | null };

export type FxOverview = { current: FxRateView | null; scheduled: FxRateView[]; history: FxRateView[]; canManage: boolean };

/** The rate in force at `at` (newest effective_at ≤ at), or null when none was ever set. */
export async function storeRateAt(db: Db, quote: string, at: number) {
  return db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.quote, quote), lte(fxRates.effectiveAt, at)))
    .orderBy(desc(fxRates.effectiveAt), desc(fxRates.createdAt))
    .get();
}

export async function getFxOverview(db: Db, actor: Actor, now: number, quote: FxQuote = "USD"): Promise<FxOverview> {
  assertPricing(actor);
  const [current, scheduled, history] = await Promise.all([
    storeRateAt(db, quote, now),
    db.select().from(fxRates).where(and(eq(fxRates.quote, quote), gt(fxRates.effectiveAt, now))).orderBy(fxRates.effectiveAt),
    db.select().from(fxRates).where(eq(fxRates.quote, quote)).orderBy(desc(fxRates.effectiveAt), desc(fxRates.createdAt)).limit(50),
  ]);
  const people = [...new Set([current, ...scheduled, ...history].map((row) => row?.createdBy).filter((id): id is string => Boolean(id)))];
  const names = people.length ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, people)) : [];
  const view = (row: typeof fxRates.$inferSelect): FxRateView => ({
    id: row.id,
    quote: row.quote,
    iqdPerUnit: row.iqdPerUnit,
    source: row.source,
    isDemo: row.isDemo,
    effectiveAt: row.effectiveAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy ? { id: row.createdBy, name: names.find((entry) => entry.id === row.createdBy)?.name ?? row.createdBy } : null,
  });
  return { current: current ? view(current) : null, scheduled: scheduled.map(view), history: history.map(view), canManage: can(actor, "pricing.fx_rate.manage") };
}

export const FxRateInput = z.object({
  quote: z.enum(FX_QUOTES, { error: "invalid" }).default("USD"),
  iqdPerUnit: z.preprocess(
    (value) => (typeof value === "string" ? (value.trim() === "" ? undefined : (parseDecimal(value, 0) ?? Number.NaN)) : value),
    z
      .number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") })
      .int("invalid")
      .min(100, "rate_out_of_range")
      .max(100_000, "rate_out_of_range"),
  ),
  source: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  /** "now", or a Baghdad date-time "YYYY-MM-DDTHH:mm" up to 90 days ahead (never in the past). */
  effective: z.string().trim().default("now"),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});

/** Adds a rate (now or scheduled). A repeat with the same idempotency key returns the first row. */
export async function setFxRate(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string; effectiveAt: number; replayed: boolean }> {
  assertCan(actor, "pricing.fx_rate.manage");
  const input = FxRateInput.parse(raw);
  let effectiveAt = now;
  if (input.effective !== "now" && input.effective !== "") {
    const parsed = parseBaghdadDateTime(input.effective);
    if (parsed === null) throw invalid({ effective: "invalid" });
    // A minute of slack for the time it takes to fill the form; never backdated, at most 90 days ahead.
    if (parsed < now - 60_000) throw invalid({ effective: "effective_past" });
    if (parsed > now + MAX_AHEAD_MS) throw invalid({ effective: "effective_far" });
    effectiveAt = Math.max(parsed, now);
  }
  const who = actor.kind === "employee" ? actor.id : actor.kind === "system" ? actor.job : "unknown";
  const id = `fxr_${(await sha256Hex(`${who}:${input.idempotencyKey}`)).slice(0, 26)}`;
  const existing = await db.select({ id: fxRates.id, effectiveAt: fxRates.effectiveAt }).from(fxRates).where(eq(fxRates.id, id)).get();
  if (existing) return { id: existing.id, effectiveAt: existing.effectiveAt, replayed: true };
  const before = await storeRateAt(db, input.quote, effectiveAt);
  if (before && before.iqdPerUnit === input.iqdPerUnit && before.source === input.source && effectiveAt === now) throw new AppError("rate_unchanged", 409, { fields: { iqdPerUnit: "rate_unchanged" } });
  try {
    await runBatch(db, [
      db.insert(fxRates).values({ id, quote: input.quote, iqdPerUnit: input.iqdPerUnit, source: input.source, isDemo: false, effectiveAt, createdBy: actorId(actor), createdAt: now }),
      auditStatement(db, {
        actor,
        action: "pricing.fx_rate.set",
        entityType: "fx_rate",
        entityId: id,
        summary: `${input.quote} ${input.iqdPerUnit}`,
        before: before ? { quote: before.quote, iqdPerUnit: before.iqdPerUnit, source: before.source, effectiveAt: before.effectiveAt } : null,
        after: { quote: input.quote, iqdPerUnit: input.iqdPerUnit, source: input.source, effectiveAt },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "fx_rates.id")) return { id, effectiveAt, replayed: true };
    throw error;
  }
  return { id, effectiveAt, replayed: false };
}
