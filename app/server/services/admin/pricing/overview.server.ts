/**
 * The pricing module's front page (admin 03): what waits for this employee and the state of the price book —
 * each figure only for those allowed to see it (cost-based counts need cost.read / profit.read).
 */
import { and, eq, sql } from "drizzle-orm";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { landedCosts, priceChanges, priceLists, receipts } from "~/server/db/schema";
import { actorId, assertPricing, canAny, fieldAccess } from "./access";
import { storeRateAt } from "./fx.server";
import { countDecidable, countSkuRows, type PriceFilters } from "./prices.server";
import { countUsedDecidable, SPECIAL_READERS } from "./special.server";

export type PricingOverview = {
  /** Requests this employee may decide (never their own). */
  decidable: number;
  /** Used-device prices this employee may decide (never their own). */
  usedDecidable: number;
  /** This employee's own requests still waiting. */
  mine: number;
  /** Requests waiting in total (anyone may see that changes are waiting). */
  pending: number;
  skus: number;
  onSale: number;
  /** cost.read only. */
  noCost?: number;
  /** profit.read only. */
  belowMin?: number;
  belowTarget?: number;
  fx: { iqdPerUnit: number; source: string; isDemo: boolean; effectiveAt: number } | null;
  activeLists: number;
  /** Landed-cost access only: bills on draft receipts not yet spread over the lines. */
  billsToAllocate?: number;
};

const filters = (view: PriceFilters["view"]): PriceFilters => ({ q: "", kind: null, platform: null, status: null, view, sort: "sku", dir: "asc", page: 1 });

export async function getPricingOverview(db: Db, actor: Actor, now: number): Promise<PricingOverview> {
  assertPricing(actor);
  const access = fieldAccess(actor);
  const me = actorId(actor);
  const undecided = sql`not exists (select 1 from price_changes d where d.request_id = ${priceChanges.id})`;
  const [decidable, usedDecidable, pendingRows, skus, onSale, fx, lists] = await Promise.all([
    countDecidable(db, actor),
    countUsedDecidable(db, actor),
    db
      .select({ total: sql<number>`count(*)`, mine: sql<number>`coalesce(sum(case when ${priceChanges.requestedBy} = ${me ?? ""} then 1 else 0 end), 0)` })
      .from(priceChanges)
      .where(and(eq(priceChanges.status, "pending"), undecided)),
    countSkuRows(db, filters("all")),
    countSkuRows(db, filters("on_sale")),
    storeRateAt(db, "USD", now),
    db
      .select({ total: sql<number>`count(*)` })
      .from(priceLists)
      .where(and(eq(priceLists.isActive, true), sql`(${priceLists.startsAt} is null or ${priceLists.startsAt} <= ${now})`, sql`(${priceLists.endsAt} is null or ${priceLists.endsAt} > ${now})`)),
  ]);
  const overview: PricingOverview = {
    decidable,
    usedDecidable,
    mine: Number(pendingRows[0]?.mine ?? 0),
    pending: Number(pendingRows[0]?.total ?? 0),
    skus,
    onSale,
    fx: fx ? { iqdPerUnit: fx.iqdPerUnit, source: fx.source, isDemo: fx.isDemo, effectiveAt: fx.effectiveAt } : null,
    activeLists: Number(lists[0]?.total ?? 0),
  };
  if (access.cost) overview.noCost = await countSkuRows(db, filters("no_cost"));
  if (access.profit) {
    overview.belowMin = await countSkuRows(db, filters("below_min"));
    overview.belowTarget = await countSkuRows(db, filters("below_target"));
  }
  if (access.cost && canAny(actor, ["pricing.cost.update", "purchasing.landed_cost.allocate"])) {
    const [row] = await db
      .select({ total: sql<number>`count(*)` })
      .from(landedCosts)
      .innerJoin(receipts, eq(receipts.id, landedCosts.receiptId))
      .where(and(eq(landedCosts.status, "draft"), eq(receipts.status, "draft")));
    overview.billsToAllocate = Number(row?.total ?? 0);
  }
  return overview;
}

/** Which of the module's pages this employee may open (the services check again). */
export function pricingPages(actor: Actor) {
  const access = fieldAccess(actor);
  return {
    skus: true,
    changes: true,
    landed: access.cost && canAny(actor, ["pricing.cost.update", "purchasing.landed_cost.allocate"]),
    lists: canAny(actor, ["pricing.price_list.manage", "pricing.price.update", "pricing.price.approve", "pricing.discount.override", "pricing.simulation.run"]),
    simulate: can(actor, "pricing.simulation.run"),
    special: canAny(actor, SPECIAL_READERS),
    fx: true,
  };
}
export type PricingPages = ReturnType<typeof pricingPages>;
