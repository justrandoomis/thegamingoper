/**
 * Admin 03 pricing — the 30-day reference price of a list of SKUs (module follow-up 2026-11-12, asked by admin 08
 * promotions, whose flash check kept its own copy of this query): for each variant, the highest price in force during
 * the drop window (rules.ts DROP_WINDOW_DAYS, restarted at a change a second person approved) — what a price cut is
 * measured from (03.05), never below today's price. Public facts: no cost, no margin.
 *
 *   const reference = await referencePrices(db, variantIds, now);   // Map<variantId, IQD>; unknown ids left out
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "~/server/db/drizzle.server";
import { priceChanges, variants } from "~/server/db/schema";
import { dropReferencePrice, type AppliedChange } from "./rules";

/** The applied price changes of these variants (oldest first), the history the reference is computed from. */
export async function appliedPriceHistory(db: Db, variantIds: readonly string[]): Promise<Map<string, AppliedChange[]>> {
  const out = new Map<string, AppliedChange[]>();
  const ids = [...new Set(variantIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db
      .select({ variantId: priceChanges.variantId, at: priceChanges.createdAt, oldPriceIqd: priceChanges.oldPriceIqd, newPriceIqd: priceChanges.newPriceIqd, approvedBy: priceChanges.approvedBy })
      .from(priceChanges)
      .where(and(inArray(priceChanges.variantId, ids.slice(i, i + 90)), eq(priceChanges.status, "applied")))
      .orderBy(asc(priceChanges.createdAt));
    for (const row of rows) out.set(row.variantId, [...(out.get(row.variantId) ?? []), { at: row.at, oldPriceIqd: row.oldPriceIqd, newPriceIqd: row.newPriceIqd, approved: row.approvedBy !== null }]);
  }
  return out;
}

/** The 30-day reference price of each variant (see the file header). */
export async function referencePrices(db: Db, variantIds: readonly string[], now: number): Promise<Map<string, number>> {
  const ids = [...new Set(variantIds)];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const facts: { id: string; priceIqd: number; createdAt: number }[] = [];
  for (let i = 0; i < ids.length; i += 90) facts.push(...(await db.select({ id: variants.id, priceIqd: variants.priceIqd, createdAt: variants.createdAt }).from(variants).where(inArray(variants.id, ids.slice(i, i + 90)))));
  const history = await appliedPriceHistory(db, ids);
  for (const fact of facts) out.set(fact.id, dropReferencePrice(fact.priceIqd, fact.createdAt, history.get(fact.id) ?? [], now));
  return out;
}
