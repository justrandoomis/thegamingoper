/**
 * Switch bundle builder — the store side (docs/switch-builder.md §5).
 * STUB written by the lead so importers work while the commerce owner builds it; keep these signatures.
 */
import type { Locale } from "~/lib/locales";
import type { BuilderCatalog, BuilderPlan, BuilderQuote, LibraryExtras, LibraryGameId } from "~/lib/switch-builder/types";
import type { Db } from "~/server/db.server";

/** What TamTam sells for the builder right now: consoles, cards, cartridges, eShop cards (no stock counts leave). */
export async function loadBuilderCatalog(_db: Db, _locale: Locale, _now: number): Promise<BuilderCatalog> {
  return { devices: { "switch-oled": null, switch: null, "switch-lite": null }, cards: {}, cartridges: {}, eshop: { sold: false, denominations: [] } };
}

/** A plan sent by the browser (JSON), checked; null when it is not a valid plan. */
export function parsePlan(_raw: unknown): BuilderPlan | null {
  return null;
}

/** The review step's lines and totals for a plan (prices and availability read now; the cart prices the order). */
export async function quoteBuilderPlan(_db: Db, _locale: Locale, _plan: BuilderPlan, _extras: Record<LibraryGameId, LibraryExtras>, _now: number): Promise<BuilderQuote> {
  return { lines: [], totalIqd: 0, digital: { pricedCents: 0, pricedCount: 0, unpricedIds: [], cardsCents: 0, cardsSold: false }, notSold: [] };
}
