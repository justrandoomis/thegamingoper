/**
 * Advisory price suggestion (admin 03.08) — deterministic rules over the store's own facts, never a model and never
 * a price change by itself: cost-plus at the SKU's target margin, a market price the employee typed (matched, or one
 * step under it, never under the minimum-margin floor), and a 5 % markdown for slow stock. The employee may send it
 * as a price change (source "suggestion"); that request follows the approval rules of 03.05 like any other.
 * No AI model is configured; when one is, it may only add a reason — the rules stay the floor.
 *
 * Needs pricing.suggestion.read and cost.read (a suggestion is computed from the cost and would reveal it).
 * Margins, floor and target are returned only with profit.read.
 */
import { assertCan, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { notFound } from "~/server/errors";
import { variants } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { fieldAccess } from "./access";
import { costBasisFor, oldestStockDaysFor, onHandFor, salesFor } from "./facts.server";
import { DAY_MS, parseDecimal, SLOW_STOCK_DAYS, suggestPrice, type Suggestion, type SuggestionRule } from "./rules";

export type SuggestionView =
  | { ok: false; reason: "no_cost" | "no_target" }
  | {
      ok: true;
      priceIqd: number;
      currentPriceIqd: number;
      steps: { rule: SuggestionRule; priceIqd: number }[];
      changeBps: number | null;
      inputs: { landedIqd: number; marketIqd: number | null; onHand: number; soldRecently: number; oldestStockDays: number | null; recentDays: number };
      /** profit.read only. */
      margins?: { marginBps: number | null; floorIqd: number; targetIqd: number; minMarginBps: number | null; targetMarginBps: number | null };
    };

/** A typed market price ("715,000"), or null when empty / unreadable / zero. */
export function parseMarket(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = parseDecimal(value, 0);
  return parsed !== null && parsed > 0 && parsed <= 100_000_000 ? parsed : null;
}

export async function suggestForSku(db: Db, actor: Actor, input: { variantId: string; marketIqd: number | null }, now: number): Promise<SuggestionView> {
  assertCan(actor, "pricing.suggestion.read");
  assertCan(actor, "cost.read");
  const variant = await db.select({ id: variants.id, priceIqd: variants.priceIqd }).from(variants).where(eq(variants.id, input.variantId)).get();
  if (!variant) throw notFound("variant");
  const [costs, stock, sales, ages] = await Promise.all([
    costBasisFor(db, [variant.id]),
    onHandFor(db, [variant.id]),
    salesFor(db, [variant.id], now - SLOW_STOCK_DAYS * DAY_MS),
    oldestStockDaysFor(db, [variant.id], now),
  ]);
  const basis = costs.get(variant.id) ?? null;
  if (!basis) return { ok: false, reason: "no_cost" };
  const onHand = stock.get(variant.id) ?? 0;
  const soldRecently = sales.get(variant.id)?.unitsSold ?? 0;
  const oldestStockDays = ages.get(variant.id) ?? null;
  const suggestion: Suggestion = suggestPrice({
    landedIqd: basis.landedIqd,
    minMarginBps: basis.minMarginBps,
    targetMarginBps: basis.targetMarginBps,
    currentPriceIqd: variant.priceIqd,
    marketIqd: input.marketIqd,
    onHand,
    soldRecently,
    oldestStockDays,
  });
  if (!suggestion.ok) return { ok: false, reason: "no_target" };
  const view: SuggestionView = {
    ok: true,
    priceIqd: suggestion.priceIqd,
    currentPriceIqd: variant.priceIqd,
    steps: suggestion.steps,
    changeBps: suggestion.changeBps,
    inputs: { landedIqd: basis.landedIqd, marketIqd: input.marketIqd, onHand, soldRecently, oldestStockDays, recentDays: SLOW_STOCK_DAYS },
  };
  if (fieldAccess(actor).profit) view.margins = { marginBps: suggestion.marginBps, floorIqd: suggestion.floorIqd, targetIqd: suggestion.targetIqd, minMarginBps: basis.minMarginBps, targetMarginBps: basis.targetMarginBps };
  return view;
}
