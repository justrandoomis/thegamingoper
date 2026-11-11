/**
 * Discount simulation (admin 03.06; blueprint acceptance #4): what a discount does to the NET profit of every SKU in
 * a selection — net price after the discount, minus refunds (the SKU's own refund history or an assumption), payment
 * or channel fees, the commission rules that apply (staff module 15, commission_rules), and the landed cost — before
 * and after, per unit and over the stock on hand. Nothing is written.
 *
 *   const result = await simulateDiscount(db, actor, parseSimulation(url.searchParams), locale, now);
 *
 * Needs pricing.simulation.run. Landed cost only with cost.read; profit, margins and totals only with profit.read —
 * without them the simulation still shows what the shopper pays. A SKU without a cost has no profit: it is counted
 * and named, never shown as 0. Commissions use the rules that apply to everyone (no employee or role), the most
 * specific match first (category, then product kind, then all), the higher rate on a tie.
 */
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { pick } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { commissionRules, PRODUCT_KINDS, type ProductKind } from "~/server/db/schema";
import { fieldAccess, type FieldAccess } from "./access";
import { salesFor } from "./facts.server";
import { platformOptions, querySkuRows, type PriceFilters } from "./prices.server";
import { BPS, DAY_MS, parseDecimal, parsePercentBps, simulateUnit, type DiscountKind } from "./rules";

export const REFUND_BASES = ["history", "none", "assume"] as const;
export type RefundBasis = (typeof REFUND_BASES)[number];
export const SIM_CHANNELS = ["web", "pos"] as const;
export type SimChannel = (typeof SIM_CHANNELS)[number];

/** Refund history is read over this many days. */
export const REFUND_HISTORY_DAYS = 180;
/** At most this many SKUs are simulated at once (the selection's first ones, in SKU order). */
export const SIM_MAX_ROWS = 500;
export const SIM_PAGE_SIZE = 50;

export type SimulationParams = {
  q: string;
  kind: ProductKind | null;
  platform: string | null;
  discountKind: DiscountKind;
  /** Basis points for "percent", IQD for "fixed". */
  discountValue: number;
  /** The typed values, to refill the form. */
  discountText: string;
  channel: SimChannel;
  refunds: RefundBasis;
  refundBps: number;
  refundText: string;
  feeBps: number;
  feeText: string;
  page: number;
  /** False until a discount is entered: the page shows the form only. */
  ready: boolean;
};

export function parseSimulation(params: URLSearchParams): { params: SimulationParams; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const discountKind: DiscountKind = params.get("dk") === "fixed" ? "fixed" : "percent";
  const discountText = (params.get("dv") ?? "").trim().slice(0, 20);
  let discountValue = 0;
  if (discountText) {
    const parsed = discountKind === "percent" ? parsePercentBps(discountText) : parseDecimal(discountText, 0);
    if (parsed === null) errors.dv = "invalid";
    else if (discountKind === "percent" && (parsed <= 0 || parsed > 9_000)) errors.dv = "discount_range";
    else if (discountKind === "fixed" && parsed <= 0) errors.dv = "discount_range";
    else discountValue = parsed;
  }
  const refunds = (REFUND_BASES as readonly string[]).includes(params.get("rb") ?? "") ? (params.get("rb") as RefundBasis) : "history";
  const refundText = (params.get("rr") ?? "").trim().slice(0, 10);
  let refundBps = 0;
  if (refunds === "assume") {
    const parsed = parsePercentBps(refundText);
    if (parsed === null || parsed > 5_000) errors.rr = "refund_range";
    else refundBps = parsed;
  }
  const feeText = (params.get("fee") ?? "").trim().slice(0, 10);
  let feeBps = 0;
  if (feeText) {
    const parsed = parsePercentBps(feeText);
    if (parsed === null || parsed > 3_000) errors.fee = "fee_range";
    else feeBps = parsed;
  }
  const kind = params.get("kind");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    params: {
      q: (params.get("q") ?? "").trim().slice(0, 100),
      kind: kind && (PRODUCT_KINDS as readonly string[]).includes(kind) ? (kind as ProductKind) : null,
      platform: params.get("platform")?.trim().slice(0, 60) || null,
      discountKind,
      discountValue,
      discountText,
      channel: params.get("ch") === "pos" ? "pos" : "web",
      refunds,
      refundBps,
      refundText,
      feeBps,
      feeText,
      page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000) : 1,
      ready: discountValue > 0 && Object.keys(errors).length === 0,
    },
    errors,
  };
}

export type SimSide = { profitIqd: number | null; marginBps: number | null; state: "ok" | "below_target" | "below_min" | "loss" | "no_cost" };

export type SimRow = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  priceIqd: number;
  onHand: number;
  discountIqd: number;
  netPriceIqd: number;
  refund: { rateBps: number; source: "history" | "no_history" | "none" | "assumed"; unitsSold: number };
  commission: { salesBps: number; profitBps: number; rule: string | null };
  feeBps: number;
  /** cost.read only. */
  landedIqd?: number | null;
  /** profit.read only. */
  before?: SimSide;
  after?: SimSide;
};

export type SimTotals = {
  skus: number;
  units: number;
  retailBeforeIqd: number;
  retailAfterIqd: number;
  /** profit.read only; over the SKUs that have a cost (see `uncosted`). */
  profitBeforeIqd?: number;
  profitAfterIqd?: number;
  uncostedSkus?: number;
  belowMinAfter?: number;
  lossAfter?: number;
};

export type SimulationResult = {
  rows: SimRow[];
  page: number;
  pageCount: number;
  totals: SimTotals;
  /** True when the selection had more than SIM_MAX_ROWS SKUs and only the first ones were simulated. */
  truncated: boolean;
  access: FieldAccess;
  rulesFound: number;
  platforms: { id: string; slug: string; name: string }[];
};

type Rule = typeof commissionRules.$inferSelect;

/** The commission rule that applies to a SKU sold on a channel (everyone's rules only). */
export function commissionFor(rules: readonly Rule[], kind: ProductKind, categoryId: string | null): Rule | null {
  const matching = rules.filter((rule) => (rule.categoryId === null || rule.categoryId === categoryId) && (rule.productKind === "*" || rule.productKind === kind));
  if (matching.length === 0) return null;
  const rank = (rule: Rule) => (rule.categoryId !== null ? 2 : 0) + (rule.productKind !== "*" ? 1 : 0);
  return matching.sort((a, b) => rank(b) - rank(a) || b.rateBps - a.rateBps)[0];
}

function sideState(profitIqd: number | null, marginBpsValue: number | null, minBps: number | null, targetBps: number | null): SimSide["state"] {
  if (profitIqd === null) return "no_cost";
  if (profitIqd < 0) return "loss";
  if (minBps !== null && (marginBpsValue ?? -Infinity) < minBps) return "below_min";
  if (targetBps !== null && (marginBpsValue ?? -Infinity) < targetBps) return "below_target";
  return "ok";
}

/** Every row of the selection (up to SIM_MAX_ROWS) with the totals. */
async function runSimulation(db: Db, actor: Actor, params: SimulationParams, locale: Locale, now: number): Promise<Omit<SimulationResult, "page" | "pageCount">> {
  assertCan(actor, "pricing.simulation.run");
  const access = fieldAccess(actor);
  const filters: PriceFilters = { q: params.q, kind: params.kind, platform: params.platform, status: null, view: "all", sort: "sku", dir: "asc", page: 1 };
  const [raw, platforms] = await Promise.all([querySkuRows(db, filters, locale, SIM_MAX_ROWS + 1), platformOptions(db, locale)]);
  const truncated = raw.length > SIM_MAX_ROWS;
  const selection = raw.slice(0, SIM_MAX_ROWS);
  const rules = await db
    .select()
    .from(commissionRules)
    .where(
      and(
        eq(commissionRules.isActive, true),
        isNull(commissionRules.employeeId),
        isNull(commissionRules.roleId),
        or(isNull(commissionRules.channel), eq(commissionRules.channel, params.channel)),
        or(isNull(commissionRules.startsAt), lte(commissionRules.startsAt, now)),
        or(isNull(commissionRules.endsAt), gt(commissionRules.endsAt, now)),
      ),
    );
  const sales = params.refunds === "history" && params.ready ? await salesFor(db, selection.map((row) => row.variantId), now - REFUND_HISTORY_DAYS * DAY_MS) : new Map();

  const totals: SimTotals = { skus: selection.length, units: 0, retailBeforeIqd: 0, retailAfterIqd: 0 };
  let profitBefore = 0;
  let profitAfter = 0;
  let uncosted = 0;
  let belowMin = 0;
  let loss = 0;
  const rows: SimRow[] = selection.map((row) => {
    const rule = commissionFor(rules, row.kind, row.categoryId);
    const commission = { salesBps: rule && rule.basis === "sales" ? rule.rateBps : 0, profitBps: rule && rule.basis === "profit" ? rule.rateBps : 0 };
    const history = sales.get(row.variantId);
    const refund: SimRow["refund"] =
      params.refunds === "assume"
        ? { rateBps: params.refundBps, source: "assumed", unitsSold: history?.unitsSold ?? 0 }
        : params.refunds === "none"
          ? { rateBps: 0, source: "none", unitsSold: 0 }
          : history && history.unitsSold > 0
            ? { rateBps: Math.round((history.unitsRefunded * BPS) / history.unitsSold), source: "history", unitsSold: history.unitsSold }
            : { rateBps: 0, source: "no_history", unitsSold: 0 };
    const unit = simulateUnit({
      priceIqd: row.priceIqd,
      landedIqd: row.basis ? row.basis.landedIqd : null,
      discount: { kind: params.discountKind, value: params.discountValue },
      refundRateBps: refund.rateBps,
      commission,
      feeBps: params.feeBps,
    });
    const minBps = row.basis?.minMarginBps ?? null;
    const targetBps = row.basis?.targetMarginBps ?? null;
    const before: SimSide = { profitIqd: unit.before.profitIqd, marginBps: unit.before.marginBps, state: sideState(unit.before.profitIqd, unit.before.marginBps, minBps, targetBps) };
    const after: SimSide = { profitIqd: unit.after.profitIqd, marginBps: unit.after.marginBps, state: sideState(unit.after.profitIqd, unit.after.marginBps, minBps, targetBps) };
    const stock = Math.max(0, row.onHand);
    totals.units += stock;
    totals.retailBeforeIqd += stock * unit.before.netPriceIqd;
    totals.retailAfterIqd += stock * unit.after.netPriceIqd;
    if (unit.after.profitIqd === null || unit.before.profitIqd === null) uncosted++;
    else {
      profitBefore += stock * unit.before.profitIqd;
      profitAfter += stock * unit.after.profitIqd;
    }
    if (after.state === "below_min") belowMin++;
    if (after.state === "loss") loss++;
    const out: SimRow = {
      variantId: row.variantId,
      productId: row.productId,
      sku: row.sku,
      name: pick(row.name, locale),
      priceIqd: row.priceIqd,
      onHand: row.onHand,
      discountIqd: unit.after.discountIqd,
      netPriceIqd: unit.after.netPriceIqd,
      refund,
      commission: { ...commission, rule: rule ? rule.name : null },
      feeBps: params.feeBps,
    };
    if (access.cost) out.landedIqd = row.basis ? row.basis.landedIqd : null;
    if (access.profit) {
      out.before = before;
      out.after = after;
    }
    return out;
  });
  if (access.profit) Object.assign(totals, { profitBeforeIqd: profitBefore, profitAfterIqd: profitAfter, uncostedSkus: uncosted, belowMinAfter: belowMin, lossAfter: loss });
  return { rows, totals, truncated, access, rulesFound: rules.length, platforms };
}

/** One page of the simulation (SIM_PAGE_SIZE rows) with the totals of the whole selection. */
export async function simulateDiscount(db: Db, actor: Actor, params: SimulationParams, locale: Locale, now: number): Promise<SimulationResult> {
  const result = await runSimulation(db, actor, params, locale, now);
  const pageCount = Math.max(1, Math.ceil(result.rows.length / SIM_PAGE_SIZE));
  const page = Math.min(params.page, pageCount);
  return { ...result, rows: result.rows.slice((page - 1) * SIM_PAGE_SIZE, page * SIM_PAGE_SIZE), page, pageCount };
}

/** Every simulated row (not paged), for the CSV export. */
export async function simulateAll(db: Db, actor: Actor, params: SimulationParams, locale: Locale, now: number): Promise<SimulationResult> {
  const result = await runSimulation(db, actor, params, locale, now);
  return { ...result, page: 1, pageCount: 1 };
}
