/**
 * Admin module 03 "pricing" (owner: admin pricing) — the pure rules and the services under
 * app/server/services/admin/pricing against a real local D1 with the demo catalogue (createTestDb + seedDemo).
 * Fixtures are chosen by their properties or built here; no hard-coded demo slugs.
 *
 *   · rules: margins and floors, approval reasons, the 90-day "was" price rule, exact allocation, exact currency
 *     conversion, the deterministic suggestion, the per-unit simulation, CSV safety
 *   · authorization per role (owner, manager, finance, inventory, cashier, content, custom roles)
 *   · field-level cost hiding (cost.read / profit.read): rows, SKU page, CSV export, simulation, suggestion
 *   · price changes: direct, pending, four eyes, override, one pending per SKU, stale requests, idempotent repeats,
 *     append-only history, audit events
 *   · cost and margin rules (stale-edit guard, bulk), the USD rate, landed-cost allocation on a receipt, price lists
 *     and their resolver, used-unit pricing, route loaders and the CSV resource route behind a real session
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import {
  approvals,
  auditEvents,
  branches,
  employeeRoles,
  fxRates,
  inventoryLocations,
  landedCostAllocations,
  landedCosts,
  priceChanges,
  products,
  purchaseOrders,
  receiptItems,
  receipts,
  rolePermissions,
  roles,
  stockLevels,
  suppliers,
  usedUnits,
  variantCosts,
  variants,
} from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { setMarginRules, setMarginRulesBulk, setVariantCost, getCostDetail } from "~/server/services/admin/pricing/costs.server";
import { toCsv } from "~/server/services/admin/pricing/csv";
import { getFxOverview, setFxRate, storeRateAt } from "~/server/services/admin/pricing/fx.server";
import {
  addLandedCost,
  allocateLandedCost,
  allocationStatements,
  getReceiptLanded,
  listReceiptsForLanded,
  loadBillContext,
  previewAllocation,
  removeLandedCost,
} from "~/server/services/admin/pricing/landed.server";
import { getPriceList, resolveListPrice, savePriceList, setListItem } from "~/server/services/admin/pricing/lists.server";
import { getPricingOverview } from "~/server/services/admin/pricing/overview.server";
import {
  allSkuPrices,
  cancelPriceChange,
  countDecidable,
  decidePriceChange,
  getSkuPricing,
  impactsFor,
  listChanges,
  listSkuPrices,
  parsePriceFilters,
  previewPriceChange,
  requestPriceChange,
} from "~/server/services/admin/pricing/prices.server";
import {
  allocateAmount,
  AllocationError,
  compareAtCheck,
  DAY_MS,
  evaluatePriceChange,
  marginBps,
  parseDecimal,
  planAllocation,
  priceForMargin,
  priceSegments,
  purchaseCostIqd,
  simulateUnit,
  suggestPrice,
} from "~/server/services/admin/pricing/rules";
import { parseSimulation, simulateAll, simulateDiscount } from "~/server/services/admin/pricing/simulate.server";
import { cancelUsedPrice, decideUsedPrice, listBundles, listUsedForPricing, setUsedUnitPrice } from "~/server/services/admin/pricing/special.server";
import { suggestForSku } from "~/server/services/admin/pricing/suggest.server";
import { loader as exportLoader } from "~/routes/admin/pricing/export";
import { action as receiptAction } from "~/routes/admin/pricing/receipt";
import { typedIqd } from "~/routes/admin/pricing/shared";
import { loader as skusLoader } from "~/routes/admin/pricing/skus";
import { loader as specialLoader } from "~/routes/admin/pricing/special";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = Date.UTC(2026, 10, 10, 6, 0, 0);
let clock = NOW;
const tick = () => (clock += 1000);

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb({ now: NOW });
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  await seedDemo(t.db, NOW);
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── helpers

async function failure(run: () => Promise<unknown>): Promise<{ code: string; status: number; fields?: Record<string, string> }> {
  try {
    await run();
  } catch (error) {
    const app = toAppError(error);
    if (!app) throw error;
    return { code: app.code, status: app.status, fields: app.fields };
  }
  throw new Error("expected the call to fail");
}

/** An employee row and an actor holding exactly these permissions. */
async function person(permissions: readonly string[] | DefaultRoleKey, name = "موظف"): Promise<EmployeeActor & { id: string }> {
  const id = await make.employee({ name });
  const held = typeof permissions === "string" ? [...defaultRolePermissions(permissions)] : [...permissions];
  return { kind: "employee", id, permissions: held, label: name };
}

type SkuOptions = { priceIqd?: number; landedIqd?: number | null; minBps?: number | null; targetBps?: number | null; onHand?: number; createdAt?: number; publishedAt?: number | null; kind?: "console" | "game" | "accessory" | "bundle" };

/** A published product with one variant priced, costed and stocked as asked (createdAt back-dated when given). */
async function sku(options: SkuOptions = {}) {
  const productId = newId("prd");
  const variantId = newId("var");
  const code = make.next("PRC");
  const createdAt = options.createdAt ?? NOW;
  const statements = [
    t.db.insert(products).values({ id: productId, slug: make.next("pricing-product"), kind: options.kind ?? "console", name: { ar: "منتج تسعير", en: "Pricing product" }, status: "published", publishedAt: options.publishedAt === undefined ? createdAt : options.publishedAt, createdAt, updatedAt: createdAt }),
    t.db.insert(variants).values({ id: variantId, productId, sku: code, priceIqd: options.priceIqd ?? 100_000, isDefault: true, createdAt, updatedAt: createdAt }),
  ];
  if (options.landedIqd !== null) {
    statements.push(
      t.db.insert(variantCosts).values({ variantId, currency: "IQD", unitCostMinor: options.landedIqd ?? 70_000, fxRateMicros: 1_000_000, landedCostIqd: options.landedIqd ?? 70_000, minMarginBps: options.minBps === undefined ? 800 : options.minBps, targetMarginBps: options.targetBps === undefined ? 1_700 : options.targetBps, updatedAt: createdAt }) as never,
    );
  }
  if (options.onHand !== undefined) statements.push(t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: options.onHand }) as never);
  await runBatch(t.db, statements);
  return { productId, variantId, sku: code };
}

const key = () => `key-${newId("k")}`;
const priceOf = async (variantId: string) => (await t.db.select({ price: variants.priceIqd, compareAt: variants.compareAtIqd }).from(variants).where(eq(variants.id, variantId)).get())!;

// ───────────────────────────────────────────────────────────────── pure rules

describe("rules", () => {
  test("margins are floored and the floor price is the lowest price on the step that keeps the margin", () => {
    expect(marginBps(100_000, 70_000)).toBe(3_000);
    expect(marginBps(99_999, 70_000)).toBe(2_999);
    expect(marginBps(0, 10)).toBeNull();
    expect(marginBps(60_000, 70_000)).toBe(-1_667);
    for (const [cost, bps] of [[70_000, 800], [42_750, 1_700], [1, 0], [988_250, 300], [12_345, 4_999]] as const) {
      const price = priceForMargin(cost, bps);
      expect(price % 250).toBe(0);
      expect(marginBps(price, cost)!).toBeGreaterThanOrEqual(bps);
      expect(marginBps(price - 250, cost) ?? -Infinity).toBeLessThan(bps);
    }
    expect(() => priceForMargin(100, 10_000)).toThrow();
  });

  test("approval reasons: limits, cost floors, unknown cost and clearance", () => {
    const cost = { landedIqd: 70_000, minMarginBps: 800, targetMarginBps: 1_700, source: "own" as const };
    const base = { oldPriceIqd: 100_000, oldCompareAtIqd: null, newCompareAtIqd: null, cost, mode: "standard" as const };
    expect(evaluatePriceChange({ ...base, newPriceIqd: 95_000 }).reasons).toEqual([]);
    expect(evaluatePriceChange({ ...base, newPriceIqd: 90_000 }).reasons).toEqual([]); // exactly 10 %: within the limit
    expect(evaluatePriceChange({ ...base, newPriceIqd: 89_750 }).reasons).toEqual(["drop_over_limit"]);
    const under = evaluatePriceChange({ ...base, newPriceIqd: 75_000 });
    expect(under.reasons).toEqual(["drop_over_limit", "below_min_margin"]);
    expect(under.needsOverride).toBe(true);
    expect(under.floorIqd).toBe(priceForMargin(70_000, 800));
    expect(evaluatePriceChange({ ...base, newPriceIqd: 69_000 }).reasons).toContain("below_cost");
    expect(evaluatePriceChange({ ...base, newPriceIqd: 120_000 }).reasons).toEqual([]);
    expect(evaluatePriceChange({ ...base, newPriceIqd: 95_000, newCompareAtIqd: 100_000 }).reasons).toEqual(["compare_at_new"]);
    expect(evaluatePriceChange({ ...base, oldCompareAtIqd: 110_000, newCompareAtIqd: 110_000, newPriceIqd: 96_000 }).reasons).toEqual([]);
    expect(evaluatePriceChange({ ...base, cost: null, newPriceIqd: 99_750 }).reasons).toEqual(["cost_unknown"]);
    expect(evaluatePriceChange({ ...base, cost: null, newPriceIqd: 100_250 }).reasons).toEqual(["cost_unknown"]); // the profit of any price is unknown
    expect(evaluatePriceChange({ ...base, cost: null, newPriceIqd: 100_000, newCompareAtIqd: null }).reasons).toEqual([]);
    const clearance = evaluatePriceChange({ ...base, newPriceIqd: 72_000, mode: "clearance" });
    expect(clearance.reasons).toEqual(["drop_over_limit", "clearance"]);
    expect(clearance.needsOverride).toBe(false);
    expect(clearance.floorIqd).toBe(70_000);
    expect(evaluatePriceChange({ ...base, newPriceIqd: 69_750, mode: "clearance" }).needsOverride).toBe(true);
  });

  test("a 'was' price must have been charged exactly, for 90 days in a row, while on sale, within a year", () => {
    const created = NOW - 400 * DAY_MS;
    // 100k for 200 days, 90k for 120 days, then 95k (today's price) for 80 days.
    const changes = [
      { at: created + 200 * DAY_MS, oldPriceIqd: 100_000, newPriceIqd: 90_000 },
      { at: created + 320 * DAY_MS, oldPriceIqd: 90_000, newPriceIqd: 95_000 },
    ];
    const segments = priceSegments(95_000, created, changes, NOW);
    expect(segments.map((segment) => segment.priceIqd)).toEqual([100_000, 90_000, 95_000]);
    expect(segments[0].from).toBe(created);
    expect(segments[2].to).toBe(NOW);
    expect(compareAtCheck(90_000, segments, created, NOW)).toEqual({ ok: true, days: 120 });
    expect(compareAtCheck(95_000, segments, created, NOW).ok).toBe(false); // only 80 days so far
    // 100k ended 200 days ago, but only 165 of its days fall inside the last year.
    expect(compareAtCheck(100_000, segments, created, NOW)).toEqual({ ok: true, days: 165 });
    expect(compareAtCheck(100_000, segments, NOW - 100 * DAY_MS, NOW).ok).toBe(false); // not on sale back then
    expect(compareAtCheck(90_000, segments, null, NOW).ok).toBe(false); // never published
    expect(compareAtCheck(91_000, segments, created, NOW).ok).toBe(false); // never charged
  });

  test("allocation adds up to the bill exactly, by value, quantity, weight and by hand", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let round = 0; round < 200; round++) {
      const total = Math.floor(random() * 50_000_000);
      const weights = Array.from({ length: 1 + Math.floor(random() * 9) }, (_, i) => ({ id: `l${i}`, weight: Math.floor(random() * 10_000_000) + 1 }));
      const shares = allocateAmount(total, weights);
      expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(total);
      for (const value of shares.values()) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
    }
    expect([...allocateAmount(100, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }]).values()]).toEqual([34, 33, 33]);
    const lines = [
      { id: "a", qty: 2, unitCostIqd: 100_000, weightGrams: 3_000 },
      { id: "b", qty: 1, unitCostIqd: 50_000, weightGrams: 500 },
      { id: "c", qty: 0, unitCostIqd: 10_000, weightGrams: 100 },
    ];
    expect(planAllocation(50_000, "by_value", lines)).toEqual([
      { lineId: "a", amountIqd: 40_000, perUnitIqd: 20_000 },
      { lineId: "b", amountIqd: 10_000, perUnitIqd: 10_000 },
    ]);
    expect(planAllocation(30_001, "by_qty", lines).map((share) => share.amountIqd)).toEqual([20_001, 10_000]);
    expect(planAllocation(13_000, "by_weight", lines).map((share) => share.amountIqd)).toEqual([12_000, 1_000]);
    expect(planAllocation(10, "manual", lines, { a: 4, b: 6 }).map((share) => share.amountIqd)).toEqual([4, 6]);
    expect(() => planAllocation(10, "manual", lines, { a: 4, b: 5 })).toThrow(AllocationError);
    expect(() => planAllocation(10, "manual", lines, { z: 10 })).toThrow(AllocationError);
    expect(() => planAllocation(10, "by_value", [{ id: "x", qty: 1, unitCostIqd: null, weightGrams: null }])).toThrow(AllocationError);
    expect(() => planAllocation(10, "by_weight", [{ id: "x", qty: 1, unitCostIqd: 1, weightGrams: null }])).toThrow(AllocationError);
  });

  test("supplier currency to dinars is exact; typed decimals accept Arabic digits and refuse ambiguity", () => {
    expect(purchaseCostIqd(24_999, 2, 1_310_000_000)).toBe(327_487); // 249.99 USD × 1310 = 327,486.9
    expect(purchaseCostIqd(5, 2, 1_310_000_000)).toBe(66); // 0.05 × 1310 = 65.5 → half up
    expect(purchaseCostIqd(900_000_000, 2, 1_999_999_999)).toBe(17_999_999_991); // 9,000,000 USD × 1999.999999: exact, no float rounding
    expect(purchaseCostIqd(749_000, 0, 1_000_000)).toBe(749_000);
    expect(parseDecimal("249.99", 2)).toBe(24_999);
    expect(parseDecimal("٢٤٩٫٩٩", 2)).toBe(24_999);
    expect(parseDecimal("1,310", 0)).toBe(1_310);
    expect(parseDecimal("12.345", 2)).toBeNull();
    expect(parseDecimal("-5", 0)).toBeNull();
    expect(parseDecimal("1e5", 0)).toBeNull();
    expect(parseDecimal("", 0)).toBeNull();
  });

  test("the suggestion is deterministic, explains itself and never goes under the floor", () => {
    const base = { landedIqd: 70_000, minMarginBps: 800, targetMarginBps: 1_700, currentPriceIqd: 80_000, marketIqd: null, onHand: 3, soldRecently: 2, oldestStockDays: 10 };
    const target = priceForMargin(70_000, 1_700);
    const floor = priceForMargin(70_000, 800);
    const plain = suggestPrice(base);
    expect(plain).toMatchObject({ ok: true, priceIqd: target, floorIqd: floor, targetIqd: target });
    expect(suggestPrice({ ...base, currentPriceIqd: 99_000 })).toMatchObject({ ok: true, priceIqd: 99_000, steps: [{ rule: "cost_plus" }, { rule: "keep_current" }] });
    expect(suggestPrice({ ...base, marketIqd: 80_100 })).toMatchObject({ ok: true, priceIqd: 80_000, steps: [{ rule: "cost_plus" }, { rule: "market_match" }] });
    expect(suggestPrice({ ...base, marketIqd: 60_000 })).toMatchObject({ ok: true, priceIqd: floor, steps: [{ rule: "cost_plus" }, { rule: "market_below_floor" }] });
    expect(suggestPrice({ ...base, marketIqd: 120_000 })).toMatchObject({ ok: true, priceIqd: 119_750 });
    const slow = suggestPrice({ ...base, currentPriceIqd: 99_000, soldRecently: 0, oldestStockDays: 120 });
    expect(slow.ok && slow.steps.map((step) => step.rule)).toEqual(["cost_plus", "keep_current", "slow_stock"]);
    expect(slow.ok && slow.priceIqd).toBe(94_000);
    expect(suggestPrice({ ...base, targetMarginBps: null })).toEqual({ ok: false, reason: "no_target" });
    expect(suggestPrice(base)).toEqual(suggestPrice(base));
  });

  test("the simulation splits every dinar and never invents a profit without a cost", () => {
    const result = simulateUnit({ priceIqd: 100_000, landedIqd: 70_000, discount: { kind: "percent", value: 1_000 }, refundRateBps: 200, commission: { salesBps: 100, profitBps: 0 }, feeBps: 150 });
    expect(result.before).toEqual({ discountIqd: 0, netPriceIqd: 100_000, refundIqd: 2_000, feeIqd: 1_500, commissionIqd: 1_000, profitIqd: 25_500, marginBps: 2_550 });
    expect(result.after.netPriceIqd).toBe(90_000);
    expect(result.after.profitIqd).toBe(90_000 - 1_800 - 1_350 - 900 - 70_000);
    const fixed = simulateUnit({ priceIqd: 5_000, landedIqd: 4_000, discount: { kind: "fixed", value: 9_000 }, refundRateBps: 0, commission: { salesBps: 0, profitBps: 1_000 }, feeBps: 0 });
    expect(fixed.after.netPriceIqd).toBe(0);
    expect(fixed.after.profitIqd).toBe(-4_000);
    expect(fixed.after.commissionIqd).toBe(0);
    const unknown = simulateUnit({ priceIqd: 5_000, landedIqd: null, discount: { kind: "percent", value: 500 }, refundRateBps: 0, commission: { salesBps: 0, profitBps: 0 }, feeBps: 0 });
    expect(unknown.after.profitIqd).toBeNull();
    expect(unknown.after.marginBps).toBeNull();
  });

  test("CSV: BOM, quoting, and spreadsheet formulas neutralised", () => {
    const csv = toCsv(["a", "b"], [["=HYPERLINK(\"x\")", 5], ["line\nbreak", null], ["+1", -3]]);
    expect(csv.startsWith("﻿a,b\r\n")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")",5`);
    expect(csv).toContain(`"line\nbreak",`);
    expect(csv).toContain("'+1,-3");
  });
});

// ───────────────────────────────────────────────────────────────── authorization and field rules

describe("who sees what", () => {
  test("roles: owner, manager and finance see cost and margins; a pricing role without field rights sees neither; others are refused", async () => {
    const owner = await person("owner");
    const finance = await person("finance");
    const clerk = await person(["pricing.price.update"] satisfies Permission[], "موظف تسعير");
    for (const actor of [owner, finance]) {
      const page = await listSkuPrices(t.db, actor, parsePriceFilters(new URLSearchParams(), { cost: true, profit: true }), "ar");
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.every((row) => row.cost !== undefined && row.margin !== undefined)).toBe(true);
    }
    const clerkPage = await listSkuPrices(t.db, clerk, parsePriceFilters(new URLSearchParams(), { cost: false, profit: false }), "ar");
    // The margin view and sort fall back for someone who may not see margins.
    expect(parsePriceFilters(new URLSearchParams("view=below_min&sort=margin"), { cost: false, profit: false })).toMatchObject({ view: "all", sort: "sku" });
    const json = JSON.stringify(clerkPage);
    expect(clerkPage.rows.length).toBeGreaterThan(0);
    expect(json).not.toMatch(/landed|margin|minBps|targetBps/);
    for (const role of ["cashier", "content", "inventory", "fulfillment", "support"] as const) {
      expect((await failure(() => listSkuPrices(t.db, { kind: "employee", id: `x-${role}`, permissions: [...defaultRolePermissions(role)] }, parsePriceFilters(new URLSearchParams(), { cost: false, profit: false }), "ar"))).status, role).toBe(403);
    }
  });

  test("the SKU page, its cost detail, the suggestion, the CSV rows and the simulation keep cost and profit out for those without the rights", async () => {
    const target = await sku({ priceIqd: 120_000, landedIqd: 80_000, onHand: 4 });
    const clerk = await person(["pricing.price.update", "pricing.simulation.run", "pricing.suggestion.read"] satisfies Permission[]);
    const page = await getSkuPricing(t.db, clerk, target.variantId, "ar", NOW);
    expect(page.cost).toBeUndefined();
    expect(page.margin).toBeUndefined();
    expect((await failure(() => getCostDetail(t.db, clerk, target.variantId, NOW))).status).toBe(403);
    expect((await failure(() => suggestForSku(t.db, clerk, { variantId: target.variantId, marketIqd: null }, NOW))).status).toBe(403);
    const exported = await allSkuPrices(t.db, clerk, parsePriceFilters(new URLSearchParams(`q=${target.sku}`), { cost: false, profit: false }), "ar");
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0].cost).toBeUndefined();
    const { params } = parseSimulation(new URLSearchParams(`q=${target.sku}&dk=percent&dv=10`));
    const simulated = await simulateDiscount(t.db, clerk, params, "ar", NOW);
    expect(simulated.rows[0].landedIqd).toBeUndefined();
    expect(simulated.rows[0].before).toBeUndefined();
    expect(simulated.totals.profitAfterIqd).toBeUndefined();
    const finance = await person("finance");
    const full = await simulateDiscount(t.db, finance, params, "ar", NOW);
    expect(full.rows[0]).toMatchObject({ landedIqd: 80_000, netPriceIqd: 108_000 });
    expect(full.rows[0].after?.profitIqd).toBe(28_000);
    // A cost.read-only role sees the landed cost but no margin.
    const costOnly = await person(["pricing.cost.update", "cost.read"] satisfies Permission[]);
    const costPage = await getSkuPricing(t.db, costOnly, target.variantId, "ar", NOW);
    expect(costPage.cost?.basis?.landedIqd).toBe(80_000);
    expect(costPage.margin).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────── price changes

describe("price changes", () => {
  test("within the limits a change applies at once, with its history row and audit event; a repeat is recognised", async () => {
    const target = await sku({ priceIqd: 100_000, landedIqd: 70_000 });
    const manager = await person("manager", "مدير");
    const idempotencyKey = key();
    const input = { variantId: target.variantId, newPriceIqd: "95,000", newCompareAtIqd: "", reason: "سعر المنافس", idempotencyKey };
    const first = await requestPriceChange(t.db, manager, input, "ar", tick());
    expect(first).toMatchObject({ status: "applied", replayed: false, reasons: [] });
    expect(await priceOf(target.variantId)).toEqual({ price: 95_000, compareAt: null });
    const again = await requestPriceChange(t.db, manager, input, "ar", tick());
    expect(again).toMatchObject({ status: "applied", replayed: true, changeId: first.changeId });
    const rows = await t.db.select().from(priceChanges).where(eq(priceChanges.variantId, target.variantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "applied", oldPriceIqd: 100_000, newPriceIqd: 95_000, requestedBy: manager.id, requestId: null });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, target.variantId), eq(auditEvents.action, "pricing.price.change")));
    expect(audit).toHaveLength(1);
    expect(audit[0].before).toEqual({ priceIqd: 100_000, compareAtIqd: null });
    // History is append-only.
    await expect(t.d1.prepare("UPDATE price_changes SET new_price_iqd = 1 WHERE id = ?").bind(first.changeId).run()).rejects.toThrow(/IMMUTABLE/);
    // Validation: the step, no change, a "was" price that is not higher.
    expect((await failure(() => requestPriceChange(t.db, manager, { ...input, newPriceIqd: "95,100", idempotencyKey: key() }, "ar", tick()))).fields).toEqual({ newPriceIqd: "price_step" });
    expect((await failure(() => requestPriceChange(t.db, manager, { ...input, idempotencyKey: key() }, "ar", tick()))).fields).toEqual({ newPriceIqd: "no_change" });
    expect((await failure(() => requestPriceChange(t.db, manager, { ...input, newPriceIqd: "90,000", newCompareAtIqd: "90,000", idempotencyKey: key() }, "ar", tick()))).fields).toEqual({ newCompareAtIqd: "compare_at_not_higher" });
    expect((await failure(() => requestPriceChange(t.db, manager, { ...input, newPriceIqd: "90,000", reason: "x", idempotencyKey: key() }, "ar", tick()))).fields).toMatchObject({ reason: "reason_short" });
  });

  test("a deep cut waits for a second person; the requester can neither approve nor reject it, another manager can", async () => {
    const target = await sku({ priceIqd: 200_000, landedIqd: 120_000, onHand: 3 });
    const requester = await person("manager", "صاحب الطلب");
    const approver = await person("manager", "المعتمد");
    const request = await requestPriceChange(t.db, requester, { variantId: target.variantId, newPriceIqd: 170_000, reason: "تخفيض موسمي", idempotencyKey: key() }, "ar", tick());
    expect(request).toMatchObject({ status: "pending", reasons: ["drop_over_limit"] });
    expect(await priceOf(target.variantId)).toEqual({ price: 200_000, compareAt: null });
    const approval = await t.db.select().from(approvals).where(eq(approvals.entityId, request.changeId)).get();
    expect(approval).toMatchObject({ kind: "price_change", status: "pending", requestedBy: requester.id, requiredPermission: "pricing.price.approve" });
    expect(await countDecidable(t.db, requester)).toBe(await countDecidable(t.db, approver) - 1);
    // One pending request per SKU.
    expect((await failure(() => requestPriceChange(t.db, approver, { variantId: target.variantId, newPriceIqd: 195_000, reason: "تعديل", idempotencyKey: key() }, "ar", tick()))).code).toBe("change_pending");
    expect((await failure(() => decidePriceChange(t.db, requester, { requestId: request.changeId, decision: "approve" }, "ar", tick()))).code).toBe("approver_is_requester");
    expect((await failure(() => decidePriceChange(t.db, requester, { requestId: request.changeId, decision: "reject", note: "لا" }, "ar", tick()))).code).toBe("approver_is_requester");
    const finance = await person("finance");
    expect((await failure(() => decidePriceChange(t.db, finance, { requestId: request.changeId, decision: "approve" }, "ar", tick()))).status).toBe(403);
    const decided = await decidePriceChange(t.db, approver, { requestId: request.changeId, decision: "approve", note: "موافق" }, "ar", tick());
    expect(decided).toEqual({ status: "applied", replayed: false });
    expect(await priceOf(target.variantId)).toEqual({ price: 170_000, compareAt: null });
    expect(await decidePriceChange(t.db, approver, { requestId: request.changeId, decision: "approve" }, "ar", tick())).toEqual({ status: "applied", replayed: true });
    expect((await failure(() => decidePriceChange(t.db, approver, { requestId: request.changeId, decision: "reject", note: "متأخر" }, "ar", tick()))).code).toBe("change_not_pending");
    expect((await t.db.select().from(approvals).where(eq(approvals.entityId, request.changeId)).get())?.status).toBe("approved");
    const log = await listChanges(t.db, approver, { variantId: target.variantId }, "ar");
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ kind: "request", status: "applied", requestedBy: { id: requester.id, name: "صاحب الطلب" }, decidedBy: { id: approver.id, name: "المعتمد" } });
  });

  test("under the minimum margin the approver also needs the override right; rejections need a reason; requesters withdraw", async () => {
    const target = await sku({ priceIqd: 100_000, landedIqd: 90_000, minBps: 800 });
    const requester = await person("manager");
    const approverOnly = await person(["pricing.price.approve", "profit.read", "cost.read"] satisfies Permission[]);
    const manager = await person("manager");
    const low = await requestPriceChange(t.db, requester, { variantId: target.variantId, newPriceIqd: 95_000, reason: "تصفية سريعة", idempotencyKey: key() }, "ar", tick());
    expect(low).toMatchObject({ status: "pending", reasons: ["below_min_margin"] });
    expect((await failure(() => decidePriceChange(t.db, approverOnly, { requestId: low.changeId, decision: "approve" }, "ar", tick()))).code).toBe("override_required");
    expect((await failure(() => decidePriceChange(t.db, manager, { requestId: low.changeId, decision: "reject", note: "" }, "ar", tick()))).fields).toEqual({ note: "note_required" });
    expect(await decidePriceChange(t.db, manager, { requestId: low.changeId, decision: "reject", note: "الهامش أقل من الحد" }, "ar", tick())).toEqual({ status: "rejected", replayed: false });
    expect(await priceOf(target.variantId)).toEqual({ price: 100_000, compareAt: null });
    // A new request after the rejection; withdrawn by its requester, not by someone else.
    const again = await requestPriceChange(t.db, requester, { variantId: target.variantId, newPriceIqd: 95_000, reason: "محاولة ثانية", idempotencyKey: key() }, "ar", tick());
    expect((await failure(() => cancelPriceChange(t.db, manager, { requestId: again.changeId }, tick()))).code).toBe("not_requester");
    expect(await cancelPriceChange(t.db, requester, { requestId: again.changeId, note: "غيّرت رأيي" }, tick())).toEqual({ status: "cancelled", replayed: false });
    const statuses = (await listChanges(t.db, manager, { variantId: target.variantId }, "ar")).items.map((item) => item.status);
    expect(statuses).toEqual(["cancelled", "rejected"]);
  });

  test("a request whose SKU price moved meanwhile cannot be approved; any price on a SKU without a cost needs approval", async () => {
    const target = await sku({ priceIqd: 300_000, landedIqd: 150_000 });
    const requester = await person("manager");
    const approver = await person("manager");
    const request = await requestPriceChange(t.db, requester, { variantId: target.variantId, newPriceIqd: 250_000, reason: "عرض", idempotencyKey: key() }, "ar", tick());
    await t.db.update(variants).set({ priceIqd: 310_000 }).where(eq(variants.id, target.variantId));
    expect((await failure(() => decidePriceChange(t.db, approver, { requestId: request.changeId, decision: "approve" }, "ar", tick()))).code).toBe("price_changed");
    const uncosted = await sku({ priceIqd: 50_000, landedIqd: null });
    expect(await requestPriceChange(t.db, requester, { variantId: uncosted.variantId, newPriceIqd: 49_750, reason: "تقريب", idempotencyKey: key() }, "ar", tick())).toMatchObject({ status: "pending", reasons: ["cost_unknown"] });
    // A first price for a new catalogue product (price 0 until Pricing sets one) waits too while it has no cost.
    const fresh = await sku({ priceIqd: 0, landedIqd: null });
    expect(await requestPriceChange(t.db, requester, { variantId: fresh.variantId, newPriceIqd: 60_000, reason: "أول سعر", idempotencyKey: key() }, "ar", tick())).toMatchObject({ status: "pending", reasons: ["cost_unknown"] });
  });

  test("a 'was' price is refused unless that price was charged 90 days; accepted ones still need a second person", async () => {
    const fresh = await sku({ priceIqd: 100_000, landedIqd: 60_000 });
    const manager = await person("manager");
    expect((await failure(() => requestPriceChange(t.db, manager, { variantId: fresh.variantId, newPriceIqd: 95_000, newCompareAtIqd: 100_000, reason: "تخفيض", idempotencyKey: key() }, "ar", tick()))).code).toBe("compare_at_not_charged");
    const old = await sku({ priceIqd: 100_000, landedIqd: 60_000, createdAt: NOW - 120 * DAY_MS });
    const preview = await previewPriceChange(t.db, manager, { variantId: old.variantId, newPriceIqd: 95_000, newCompareAtIqd: 100_000, reason: "preview", idempotencyKey: key() }, "ar", NOW);
    expect(preview).toMatchObject({ approval: "required", reasons: ["compare_at_new"], dropBps: 500 });
    const result = await requestPriceChange(t.db, manager, { variantId: old.variantId, newPriceIqd: 95_000, newCompareAtIqd: 100_000, reason: "تخفيض حقيقي", idempotencyKey: key() }, "ar", tick());
    expect(result).toMatchObject({ status: "pending", reasons: ["compare_at_new"] });
    const page = await getSkuPricing(t.db, manager, old.variantId, "ar", NOW);
    expect(page.compareAt.eligibleNow).toBe(true);
    expect(page.pending?.id).toBe(result.changeId);
    // A product that was never published has never been charged.
    const unpublished = await sku({ priceIqd: 100_000, landedIqd: 60_000, createdAt: NOW - 200 * DAY_MS, publishedAt: null });
    await t.db.update(products).set({ status: "draft" }).where(eq(products.id, unpublished.productId));
    expect((await failure(() => requestPriceChange(t.db, manager, { variantId: unpublished.variantId, newPriceIqd: 95_000, newCompareAtIqd: 100_000, reason: "تخفيض", idempotencyKey: key() }, "ar", tick()))).code).toBe("compare_at_not_charged");
    // A variant added last week to an old product has only been charged since last week.
    const young = await sku({ priceIqd: 100_000, landedIqd: 60_000, createdAt: NOW - 300 * DAY_MS });
    await t.db.update(variants).set({ createdAt: NOW - 7 * DAY_MS }).where(eq(variants.id, young.variantId));
    expect((await failure(() => requestPriceChange(t.db, manager, { variantId: young.variantId, newPriceIqd: 95_000, newCompareAtIqd: 100_000, reason: "تخفيض", idempotencyKey: key() }, "ar", tick()))).code).toBe("compare_at_not_charged");
    // Changing the price after a real reduction keeps an existing "was" price without re-checking it.
    const decided = await decidePriceChange(t.db, await person("manager"), { requestId: result.changeId, decision: "approve" }, "ar", tick());
    expect(decided.status).toBe("applied");
    expect(await priceOf(old.variantId)).toEqual({ price: 95_000, compareAt: 100_000 });
    expect(await requestPriceChange(t.db, manager, { variantId: old.variantId, newPriceIqd: 94_000, newCompareAtIqd: 100_000, reason: "تعديل بسيط", idempotencyKey: key() }, "ar", tick())).toMatchObject({ status: "applied", reasons: [] });
  });

  test("clearance prices always take a second person, with the landed cost as their floor", async () => {
    const target = await sku({ priceIqd: 100_000, landedIqd: 80_000, minBps: 1_500, kind: "accessory" });
    const requester = await person("manager");
    const approverNoOverride = await person(["pricing.price.approve", "cost.read", "profit.read"] satisfies Permission[]);
    const small = await requestPriceChange(t.db, requester, { variantId: target.variantId, newPriceIqd: 92_000, mode: "clearance", reason: "تصفية المخزون", idempotencyKey: key() }, "ar", tick());
    expect(small).toMatchObject({ status: "pending", reasons: ["clearance"] });
    // Under the 15 % minimum but above cost: no override needed in clearance mode.
    expect(await decidePriceChange(t.db, approverNoOverride, { requestId: small.changeId, decision: "approve" }, "ar", tick())).toMatchObject({ status: "applied" });
    const views = await listChanges(t.db, requester, { variantId: target.variantId }, "ar");
    expect(views.items[0]).toMatchObject({ mode: "clearance", status: "applied" });
  });
});

// ───────────────────────────────────────────────────────────────── cost, margins, rate

describe("cost, margin rules and the USD rate", () => {
  test("a cost in dollars at a dated rate gives an exact landed cost; a stale form is refused; identical values change nothing", async () => {
    const target = await sku({ landedIqd: null });
    const finance = await person("finance");
    const inventory = await person("inventory");
    const form = { variantId: target.variantId, currency: "USD", unitCost: "249.99", fxRate: "1310", fxDate: "2026-11-09", extrasIqd: "6,500", reason: "فاتورة المورد", expectedUpdatedAt: "0" };
    expect((await failure(() => setVariantCost(t.db, inventory, form, tick()))).status).toBe(403);
    const saved = await setVariantCost(t.db, finance, form, tick());
    expect(saved).toMatchObject({ purchaseIqd: 327_487, extrasIqd: 6_500, landedIqd: 333_987, changed: true });
    const row = (await t.db.select().from(variantCosts).where(eq(variantCosts.variantId, target.variantId)).get())!;
    expect(row).toMatchObject({ currency: "USD", unitCostMinor: 24_999, fxRateMicros: 1_310_000_000, fxDate: "2026-11-09", landedCostIqd: 333_987 });
    expect((await failure(() => setVariantCost(t.db, finance, { ...form, unitCost: "250" }, tick()))).code).toBe("cost_changed");
    expect((await setVariantCost(t.db, finance, { ...form, expectedUpdatedAt: String(row.updatedAt) }, tick())).changed).toBe(false);
    expect((await failure(() => setVariantCost(t.db, finance, { ...form, fxDate: "2030-01-01", expectedUpdatedAt: String(row.updatedAt) }, tick()))).fields).toEqual({ fxDate: "date_future" });
    expect((await failure(() => setVariantCost(t.db, finance, { ...form, currency: "IQD", unitCost: "1.5", expectedUpdatedAt: String(row.updatedAt) }, tick()))).fields).toEqual({ unitCost: "whole_number" });
    const detail = await getCostDetail(t.db, finance, target.variantId, NOW);
    expect(detail.row).toMatchObject({ purchaseIqd: 327_487, extrasIqd: 6_500, landedCostIqd: 333_987 });
  });

  test("margin rules: validated, need a cost row, and set in bulk with one audit event", async () => {
    const a = await sku({ landedIqd: 50_000 });
    const b = await sku({ landedIqd: 60_000 });
    const none = await sku({ landedIqd: null });
    const manager = await person("manager");
    expect((await failure(() => setMarginRules(t.db, manager, { variantId: a.variantId, minMargin: "20", targetMargin: "10", reason: "سياسة" }, tick()))).fields).toEqual({ targetMargin: "target_below_min" });
    expect((await failure(() => setMarginRules(t.db, manager, { variantId: a.variantId, minMargin: "96", targetMargin: "", reason: "سياسة" }, tick()))).fields).toEqual({ minMargin: "margin_range" });
    expect((await failure(() => setMarginRules(t.db, manager, { variantId: none.variantId, minMargin: "5", reason: "سياسة" }, tick()))).code).toBe("no_cost_row");
    expect(await setMarginRules(t.db, manager, { variantId: a.variantId, minMargin: "12.5", targetMargin: "25", reason: "سياسة" }, tick())).toEqual({ changed: true });
    expect((await t.db.select().from(variantCosts).where(eq(variantCosts.variantId, a.variantId)).get())).toMatchObject({ minMarginBps: 1_250, targetMarginBps: 2_500 });
    const bulk = await setMarginRulesBulk(t.db, manager, { variantIds: [a.variantId, b.variantId, none.variantId], minMargin: "10", targetMargin: "20", reason: "سياسة الملحقات" }, tick());
    expect(bulk).toEqual({ updated: 2, skipped: 1 });
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "pricing.margin.bulk_update"));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const content = await person("content");
    expect((await failure(() => setMarginRules(t.db, content, { variantId: a.variantId, minMargin: "1", reason: "سياسة" }, tick()))).status).toBe(403);
    // Margin rules without the right to see profit are refused too (they would reveal it).
    const policyOnly = await person(["pricing.margin.manage"] satisfies Permission[]);
    expect((await failure(() => setMarginRules(t.db, policyOnly, { variantId: a.variantId, minMargin: "1", reason: "سياسة" }, tick()))).status).toBe(403);
  });

  test("the USD rate: only its managers add one, never backdated, repeats recognised, scheduled rates wait their turn", async () => {
    const finance = await person("finance");
    const content = await person("content");
    expect((await failure(() => setFxRate(t.db, content, { iqdPerUnit: "1320", source: "السوق", reason: "تحديث", idempotencyKey: key() }, tick()))).status).toBe(403);
    const k = key();
    const at = tick();
    const first = await setFxRate(t.db, finance, { iqdPerUnit: "1,320", source: "سوق بغداد", reason: "تحديث أسبوعي", idempotencyKey: k }, at);
    expect(first.replayed).toBe(false);
    expect((await setFxRate(t.db, finance, { iqdPerUnit: "1,320", source: "سوق بغداد", reason: "تحديث أسبوعي", idempotencyKey: k }, tick())).replayed).toBe(true);
    expect((await storeRateAt(t.db, "USD", at + 1))?.iqdPerUnit).toBe(1_320);
    expect((await failure(() => setFxRate(t.db, finance, { iqdPerUnit: "1330", source: "سوق بغداد", effective: "2020-01-01T10:00", reason: "تحديث", idempotencyKey: key() }, tick()))).fields).toEqual({ effective: "effective_past" });
    expect((await failure(() => setFxRate(t.db, finance, { iqdPerUnit: "50", source: "سوق بغداد", reason: "تحديث", idempotencyKey: key() }, tick()))).fields).toEqual({ iqdPerUnit: "rate_out_of_range" });
    const later = clock + 2 * DAY_MS;
    const stamp = new Date(later + 3 * 3600_000).toISOString().slice(0, 16);
    await setFxRate(t.db, finance, { iqdPerUnit: "1340", source: "سوق بغداد", effective: stamp, reason: "سعر الأسبوع القادم", idempotencyKey: key() }, tick());
    const overview = await getFxOverview(t.db, finance, clock);
    expect(overview.current?.iqdPerUnit).toBe(1_320);
    expect(overview.scheduled.map((row) => row.iqdPerUnit)).toEqual([1_340]);
    expect(overview.canManage).toBe(true);
    expect(await t.db.select().from(fxRates).where(eq(fxRates.iqdPerUnit, 1_340))).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── landed cost on a receipt

describe("landed cost", () => {
  async function receipt(status: "draft" | "posted" = "draft") {
    const supplierId = newId("sup");
    const poId = newId("po");
    const receiptId = newId("rcp");
    const a = await sku({ priceIqd: 400_000, landedIqd: 300_000 });
    const b = await sku({ priceIqd: 100_000, landedIqd: 70_000 });
    const lineA = newId("rci");
    const lineB = newId("rci");
    await runBatch(t.db, [
      t.db.insert(suppliers).values({ id: supplierId, code: make.next("SUP"), name: "مورد تجريبي", currency: "USD", createdAt: NOW, updatedAt: NOW }) as never,
      t.db.insert(purchaseOrders).values({ id: poId, ref: make.next("PO"), supplierId, currency: "USD", fxRateMicros: 1_300_000_000, createdAt: NOW, updatedAt: NOW }) as never,
      t.db.insert(receipts).values({ id: receiptId, ref: make.next("RC"), poId, supplierId, locationId: DEFAULT_LOCATION_ID, status, receivedAt: NOW, createdAt: NOW }),
      t.db.insert(receiptItems).values({ id: lineA, receiptId, variantId: a.variantId, qtyReceived: 2, qtyAccepted: 2, unitCostMinor: 23_000, unitCostIqd: 299_000 }),
      t.db.insert(receiptItems).values({ id: lineB, receiptId, variantId: b.variantId, qtyReceived: 4, qtyAccepted: 4, unitCostMinor: 5_000, unitCostIqd: 65_000 }),
    ]);
    return { receiptId, lineA, lineB, a, b };
  }

  test("a bill spread by value adds up exactly, updates the lines' and the SKUs' landed costs, and is audited", async () => {
    const r = await receipt();
    const finance = await person("finance");
    const inventory = await person("inventory");
    expect((await failure(() => addLandedCost(t.db, inventory, { receiptId: r.receiptId, kind: "freight", currency: "IQD", amount: "1000", reason: "شحن", idempotencyKey: key() }, tick()))).status).toBe(403);
    const k = key();
    const bill = await addLandedCost(t.db, finance, { receiptId: r.receiptId, kind: "freight", currency: "USD", amount: "120.50", fxRate: "1300", method: "by_value", reason: "شحن جوي", idempotencyKey: k }, tick());
    expect(bill).toMatchObject({ amountIqd: 156_650, replayed: false });
    expect((await addLandedCost(t.db, finance, { receiptId: r.receiptId, kind: "freight", currency: "USD", amount: "120.50", fxRate: "1300", method: "by_value", reason: "شحن جوي", idempotencyKey: k }, tick())).replayed).toBe(true);
    const preview = await previewAllocation(t.db, finance, { landedCostId: bill.landedCostId });
    expect(preview.shares.reduce((sum, share) => sum + share.amountIqd, 0)).toBe(156_650);
    // goods: 2 × 299,000 = 598,000 and 4 × 65,000 = 260,000 → 69.7 % / 30.3 %
    const done = await allocateLandedCost(t.db, finance, { landedCostId: bill.landedCostId, updateVariantCosts: true, reason: "توزيع" }, tick());
    expect(done.shares).toEqual([
      expect.objectContaining({ lineId: r.lineA, amountIqd: 109_180, perUnitIqd: 54_590, landedAfterIqd: 353_590 }),
      expect.objectContaining({ lineId: r.lineB, amountIqd: 47_470, perUnitIqd: 11_868, landedAfterIqd: 76_868 }),
    ]);
    const allocations = await t.db.select().from(landedCostAllocations).where(eq(landedCostAllocations.landedCostId, bill.landedCostId));
    expect(allocations.reduce((sum, row) => sum + row.amountIqd, 0)).toBe(156_650);
    expect((await t.db.select().from(receiptItems).where(eq(receiptItems.id, r.lineA)).get())?.landedUnitCostIqd).toBe(353_590);
    expect((await t.db.select().from(variantCosts).where(eq(variantCosts.variantId, r.a.variantId)).get())).toMatchObject({ landedCostIqd: 353_590, currency: "USD", unitCostMinor: 23_000, fxRateMicros: 1_300_000_000 });
    // Spreading again replaces the shares instead of adding to them.
    await allocateLandedCost(t.db, finance, { landedCostId: bill.landedCostId, updateVariantCosts: false }, tick());
    expect(await t.db.select().from(landedCostAllocations).where(eq(landedCostAllocations.landedCostId, bill.landedCostId))).toHaveLength(2);
    const view = await getReceiptLanded(t.db, finance, r.receiptId, "ar");
    expect(view.bills[0]).toMatchObject({ status: "allocated", amountIqd: 156_650 });
    // Removing the bill takes its shares off the lines.
    await removeLandedCost(t.db, finance, { landedCostId: bill.landedCostId, reason: "فاتورة خاطئة" }, tick());
    expect((await t.db.select().from(receiptItems).where(eq(receiptItems.id, r.lineA)).get())?.landedUnitCostIqd).toBe(299_000);
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, r.receiptId));
    expect(events.map((event) => event.action).sort()).toEqual(["pricing.landed.add", "pricing.landed.allocate", "pricing.landed.allocate", "pricing.landed.remove"]);
  });

  test("a posted receipt is locked; a basis that cannot be used is refused with its reason", async () => {
    const posted = await receipt("posted");
    const finance = await person("finance");
    expect((await failure(() => addLandedCost(t.db, finance, { receiptId: posted.receiptId, kind: "customs", currency: "IQD", amount: "50000", reason: "جمارك", idempotencyKey: key() }, tick()))).code).toBe("receipt_posted");
    const draft = await receipt();
    const bill = await addLandedCost(t.db, finance, { receiptId: draft.receiptId, kind: "freight", currency: "IQD", amount: "9000", method: "by_weight", reason: "شحن", idempotencyKey: key() }, tick());
    expect((await failure(() => allocateLandedCost(t.db, finance, { landedCostId: bill.landedCostId }, tick()))).code).toBe("line_weight_missing");
  });
});

// ───────────────────────────────────────────────────────────────── price lists

describe("price lists", () => {
  test("lists per channel and segment, margin floors on list prices, and the resolver's choice", async () => {
    const manager = await person("manager");
    const priceListOnly = await person(["pricing.price_list.manage"] satisfies Permission[]);
    const target = await sku({ priceIqd: 100_000, landedIqd: 80_000, minBps: 1_000 });
    const web = await savePriceList(t.db, manager, { code: make.next("web").toUpperCase(), nameAr: "أسعار الموقع", channel: "web", priority: "5", isActive: "on", reason: "عرض الموقع" }, "ar", tick());
    const pos = await savePriceList(t.db, manager, { code: make.next("pos").toUpperCase(), nameAr: "أسعار المحل", channel: "pos", priority: "1", isActive: "on", reason: "عرض المحل" }, "ar", tick());
    const code = (await getPriceList(t.db, manager, web.id, "ar", NOW)).list.code;
    expect((await failure(() => savePriceList(t.db, manager, { code, nameAr: "مكرر", isActive: "on", reason: "تكرار" }, "ar", tick()))).code).toBe("code_taken");
    // 87,500 is under the 10 % minimum (floor 89,000): only with the override right.
    expect((await failure(() => setListItem(t.db, priceListOnly, { listId: web.id, sku: target.sku, price: "87,500", reason: "عرض" }, tick()))).code).toBe("override_required");
    await setListItem(t.db, manager, { listId: web.id, sku: target.sku, price: "87,500", reason: "عرض بخسارة هامش مقصودة" }, tick());
    await setListItem(t.db, priceListOnly, { listId: web.id, sku: target.sku, minQty: "3", price: "90,000", reason: "كمية" }, tick());
    await setListItem(t.db, priceListOnly, { listId: pos.id, sku: target.sku, price: "95,000", reason: "المحل" }, tick());
    expect((await failure(() => setListItem(t.db, priceListOnly, { listId: pos.id, sku: "NO-SUCH-SKU", price: "95,000", reason: "المحل" }, tick()))).fields).toEqual({ sku: "sku_unknown" });
    expect((await failure(() => setListItem(t.db, priceListOnly, { listId: pos.id, sku: target.sku, price: "95,000", compareAt: "99,000", reason: "المحل" }, tick()))).fields).toEqual({ compareAt: "compare_at_base_only" });
    const resolve = (channel: string | null, qty: number) => resolveListPrice(t.db, { variantIds: [target.variantId], qty, channel, at: clock });
    expect((await resolve("web", 1)).get(target.variantId)).toMatchObject({ priceIqd: 87_500, listId: web.id });
    expect((await resolve("web", 5)).get(target.variantId)).toMatchObject({ priceIqd: 90_000 });
    expect((await resolve("pos", 1)).get(target.variantId)).toMatchObject({ priceIqd: 95_000, listId: pos.id });
    expect((await resolve(null, 1)).get(target.variantId)).toBeNull();
    const view = await getPriceList(t.db, manager, web.id, "ar", NOW);
    expect(view.items.map((item) => [item.minQty, item.priceIqd, item.margin?.state])).toEqual([
      [1, 87_500, "below_min"],
      [3, 90_000, "below_target"],
    ]);
    const clerk = await person(["pricing.price_list.manage"] satisfies Permission[]);
    const hidden = await getPriceList(t.db, clerk, web.id, "ar", NOW);
    expect(JSON.stringify(hidden.items)).not.toMatch(/margin|landed/);
  });
});

// ───────────────────────────────────────────────────────────────── bundles, used units, simulation, overview

describe("special pricing, simulation and overview", () => {
  test("bundles are priced against their components; used units by unit with their own guards", async () => {
    const manager = await person("manager");
    const bundles = await listBundles(t.db, manager, "ar");
    expect(bundles.bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles.bundles) {
      expect(bundle.separateIqd).toBe(bundle.components.reduce((sum, part) => sum + part.priceIqd * part.qty, 0));
      expect(bundle.savingIqd).toBe(bundle.separateIqd - bundle.priceIqd);
    }
    const used = await listUsedForPricing(t.db, manager, {}, "ar");
    const unit = used.units.find((candidate) => candidate.priceable && candidate.acquisitionCostIqd !== null && candidate.acquisitionCostIqd !== undefined);
    expect(unit).toBeTruthy();
    const usedOnly = await person(["pricing.used.update"] satisfies Permission[]);
    const cost = unit!.acquisitionCostIqd!;
    const below = Math.floor((cost - 1_000) / 250) * 250;
    // Under the acquisition cost: a request for a second person (its cost-based reason hidden from someone without profit.read).
    const waiting = await setUsedUnitPrice(t.db, usedOnly, { usedUnitId: unit!.id, price: below, expectedPriceIqd: unit!.priceIqd, reason: "تصفية" }, tick());
    expect(waiting).toMatchObject({ changed: false, status: "pending" });
    expect(waiting.reasons).not.toContain("below_cost");
    expect(await cancelUsedPrice(t.db, usedOnly, { approvalId: waiting.requestId }, tick())).toEqual({ status: "cancelled", replayed: false });
    expect((await failure(() => setUsedUnitPrice(t.db, usedOnly, { usedUnitId: unit!.id, price: unit!.priceIqd + 250, expectedPriceIqd: unit!.priceIqd + 5_000, reason: "تعديل" }, tick()))).code).toBe("price_changed");
    expect(await setUsedUnitPrice(t.db, usedOnly, { usedUnitId: unit!.id, price: unit!.priceIqd + 250, expectedPriceIqd: unit!.priceIqd, reason: "تعديل بسيط" }, tick())).toMatchObject({ changed: true, status: "applied" });
    await t.db.update(usedUnits).set({ status: "reserved" }).where(eq(usedUnits.id, unit!.id));
    expect((await failure(() => setUsedUnitPrice(t.db, manager, { usedUnitId: unit!.id, price: unit!.priceIqd + 500, expectedPriceIqd: unit!.priceIqd + 250, reason: "تعديل" }, tick()))).code).toBe("unit_not_priceable");
    await t.db.update(usedUnits).set({ status: unit!.status }).where(eq(usedUnits.id, unit!.id));
  });

  test("the simulation reconciles: totals are the sums of the rows over stock, uncosted SKUs counted, never NaN", async () => {
    const finance = await person("finance");
    const { params, errors } = parseSimulation(new URLSearchParams("dk=percent&dv=12.5&rb=assume&rr=2&fee=1.5&ch=web"));
    expect(errors).toEqual({});
    const result = await simulateAll(t.db, finance, params, "ar", NOW);
    expect(result.rows.length).toBe(result.totals.skus);
    let profit = 0;
    let retail = 0;
    let uncosted = 0;
    for (const row of result.rows) {
      expect(Number.isFinite(row.netPriceIqd)).toBe(true);
      retail += Math.max(0, row.onHand) * row.netPriceIqd;
      if (row.after?.profitIqd === null || row.after?.profitIqd === undefined) uncosted++;
      else profit += Math.max(0, row.onHand) * row.after.profitIqd;
    }
    expect(result.totals.retailAfterIqd).toBe(retail);
    expect(result.totals.profitAfterIqd).toBe(profit);
    expect(result.totals.uncostedSkus).toBe(uncosted);
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
    expect(parseSimulation(new URLSearchParams("dk=percent&dv=95")).errors).toEqual({ dv: "discount_range" });
    expect(parseSimulation(new URLSearchParams("dk=fixed&dv=abc")).errors).toEqual({ dv: "invalid" });
    expect(parseSimulation(new URLSearchParams("")).params.ready).toBe(false);
  });

  test("the overview counts only what this employee may see", async () => {
    const owner = await person("owner");
    const clerk = await person(["pricing.price.update"] satisfies Permission[]);
    const full = await getPricingOverview(t.db, owner, NOW);
    expect(full.skus).toBeGreaterThan(200);
    expect(full.belowMin).toBeTypeOf("number");
    expect(full.noCost).toBeTypeOf("number");
    const limited = await getPricingOverview(t.db, clerk, NOW);
    expect(limited.belowMin).toBeUndefined();
    expect(limited.noCost).toBeUndefined();
    expect(limited.billsToAllocate).toBeUndefined();
    expect(limited.decidable).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── routes behind a real session

describe("routes", () => {
  async function signedIn(role: DefaultRoleKey) {
    const password = "pricing-test-password-1";
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next(role)}@pricing.test`;
    const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
    const jar: string[] = [];
    const ctx = {
      requestId: `pricing-${id}`,
      nonce: "n",
      origin: "http://localhost:5173",
      isHttps: false,
      isDev: true,
      now: Date.now(),
      ip: null,
      country: "IQ",
      userAgent: "vitest",
      locale: "ar" as const,
      dir: "rtl" as const,
      prefs: { theme: "system" as const, currency: "IQD" as const, numbering: "latn" as const },
      storeMode: "demo" as const,
      cookie: () => null,
      setCookie: (value: string) => void jar.push(value),
    };
    const result = await signInEmployee(ctx, t.db, { email, password });
    if (result.status !== "signed_in") throw new Error("expected a sign-in");
    const cookie = jar.map((value) => value.split(";")[0]).join("; ");
    return { cookie };
  }

  /** Runs a route loader behind the real root middleware with this session's cookie. */
  async function run<T>(cookie: string, path: string, loader: (args: { request: Request; context: RouterContextProvider; params: Record<string, string> }) => Promise<T>, params: Record<string, string> = {}): Promise<{ value?: T; thrown?: unknown }> {
    const request = new Request(`http://localhost:5173${path}`, { headers: { Cookie: cookie } });
    const context = new RouterContextProvider();
    const out: { value?: T; thrown?: unknown } = {};
    try {
      await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
        out.value = await loader({ request, context, params });
        return new Response("ok");
      });
    } catch (error) {
      out.thrown = error;
    }
    return out;
  }
  const statusOf = (thrown: unknown) => (thrown instanceof Response ? thrown.status : ((thrown as { init?: { status?: number } })?.init?.status ?? 0));

  test("the SKU list loader: 403 for a role without pricing, rows for a manager", async () => {
    const cashier = await signedIn("cashier");
    const denied = await run(cashier.cookie, "/admin/pricing/skus", skusLoader as never);
    expect(statusOf(denied.thrown)).toBe(403);
    const manager = await signedIn("manager");
    const allowed = await run(manager.cookie, "/admin/pricing/skus?view=below_target", skusLoader as never);
    expect(allowed.thrown).toBeUndefined();
    const value = allowed.value as { page: { rows: unknown[]; access: { cost: boolean } } };
    expect(value.page.access.cost).toBe(true);
  });

  test("the CSV export carries cost columns only for those who may see cost", async () => {
    const finance = await signedIn("finance");
    const result = await run(finance.cookie, "/admin/pricing/export/skus", exportLoader as never, { kind: "skus" });
    const response = result.value as Response;
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const text = await response.text();
    expect(text.split("\r\n")[0]).toContain("التكلفة_الواصلة_دينار");
    // The manager role without cost? Every built-in pricing role has it, so build one on the fly through the service layer.
    const clerk = await person(["pricing.price.update"] satisfies Permission[]);
    const rows = await allSkuPrices(t.db, clerk, parsePriceFilters(new URLSearchParams(), { cost: false, profit: false }), "ar");
    expect(rows.rows.every((row) => row.cost === undefined && row.margin === undefined)).toBe(true);
    const cashier = await signedIn("cashier");
    expect(statusOf((await run(cashier.cookie, "/admin/pricing/export/skus", exportLoader as never, { kind: "skus" })).thrown)).toBe(403);
    const unknown = await run(finance.cookie, "/admin/pricing/export/nope", exportLoader as never, { kind: "nope" });
    expect(statusOf(unknown.thrown)).toBe(404);
  });

  test("demo SKU rows counted by the overview match the database", async () => {
    const [{ count }] = await t.db.select({ count: sql<number>`count(*)` }).from(variants);
    const owner = await person("owner");
    expect((await getPricingOverview(t.db, owner, NOW)).skus).toBe(Number(count));
  });
});

// ───────────────────────────────────────────────────────────────── adversarial review (each test failed on the first build)

describe("adversarial review", () => {
  const ORIGIN = "http://localhost:5173";

  /** A signed-in session for an employee holding exactly these permissions (a custom role), optionally limited to a branch. */
  async function sessionWith(permissions: readonly string[], branchId: string | null = null) {
    const password = "pricing-test-password-1";
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next("custom")}@pricing.test`;
    const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations, branchId });
    const role = newId("rol");
    await runBatch(t.db, [
      t.db.insert(roles).values({ id: role, key: make.next("custom-role"), name: { ar: "دور مخصص", en: "Custom role" } }),
      ...permissions.map((permission) => t.db.insert(rolePermissions).values({ roleId: role, permission }) as never),
      t.db.insert(employeeRoles).values({ employeeId: id, roleId: role }) as never,
    ]);
    const jar: string[] = [];
    const ctx = {
      requestId: `pricing-${id}`,
      nonce: "n",
      origin: ORIGIN,
      isHttps: false,
      isDev: true,
      now: Date.now(),
      ip: null,
      country: "IQ",
      userAgent: "vitest",
      locale: "ar" as const,
      dir: "rtl" as const,
      prefs: { theme: "system" as const, currency: "IQD" as const, numbering: "latn" as const },
      storeMode: "demo" as const,
      cookie: () => null,
      setCookie: (value: string) => void jar.push(value),
    };
    const result = await signInEmployee(ctx, t.db, { email, password });
    if (result.status !== "signed_in") throw new Error("expected a sign-in");
    return { id, cookie: jar.map((value) => value.split(";")[0]).join("; ") };
  }

  type RouteFn = (args: { request: Request; context: RouterContextProvider; params: Record<string, string> }) => Promise<unknown>;

  /** A loader (GET) or an action (POST, same-origin form) behind the real root middleware. */
  async function call(cookie: string, path: string, fn: RouteFn, params: Record<string, string>, form?: Record<string, string>) {
    const request = form
      ? new Request(`${ORIGIN}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() })
      : new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
    const context = new RouterContextProvider();
    const out: { value?: unknown; thrown?: unknown } = {};
    try {
      await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
        out.value = await fn({ request, context, params });
        return new Response("ok");
      });
    } catch (error) {
      out.thrown = error;
    }
    return out;
  }
  /** The HTTP status of a thrown or returned Response / data(…, { status }) — 0 when it is neither. */
  const statusOf = (value: unknown) => (value instanceof Response ? value.status : ((value as { init?: { status?: number } } | undefined)?.init?.status ?? 0));

  /** A draft receipt (USD purchase order) with two lines: 2 × A at 299,000 IQD and 4 × B at 65,000 IQD. */
  async function draftReceipt(locationId: string = DEFAULT_LOCATION_ID) {
    const supplierId = newId("sup");
    const poId = newId("po");
    const receiptId = newId("rcp");
    const a = await sku({ priceIqd: 400_000, landedIqd: 300_000 });
    const b = await sku({ priceIqd: 100_000, landedIqd: 70_000 });
    const lineA = newId("rci");
    const lineB = newId("rci");
    await runBatch(t.db, [
      t.db.insert(suppliers).values({ id: supplierId, code: make.next("SUP"), name: "مورد", currency: "USD", createdAt: NOW, updatedAt: NOW }) as never,
      t.db.insert(purchaseOrders).values({ id: poId, ref: make.next("PO"), supplierId, currency: "USD", fxRateMicros: 1_300_000_000, createdAt: NOW, updatedAt: NOW }) as never,
      t.db.insert(receipts).values({ id: receiptId, ref: make.next("RC"), poId, supplierId, locationId, status: "draft", receivedAt: NOW, createdAt: NOW }),
      t.db.insert(receiptItems).values({ id: lineA, receiptId, variantId: a.variantId, qtyReceived: 2, qtyAccepted: 2, unitCostMinor: 23_000, unitCostIqd: 299_000 }),
      t.db.insert(receiptItems).values({ id: lineB, receiptId, variantId: b.variantId, qtyReceived: 4, qtyAccepted: 4, unitCostMinor: 5_000, unitCostIqd: 65_000 }),
    ]);
    return { receiptId, lineA, lineB, a, b };
  }
  const landedOf = async (variantId: string) => (await t.db.select().from(variantCosts).where(eq(variantCosts.variantId, variantId)).get())!;
  const lineLanded = async (lineId: string) => (await t.db.select().from(receiptItems).where(eq(receiptItems.id, lineId)).get())!.landedUnitCostIqd;

  test("a discount limit cannot be sliced: cuts count from the highest price of the last 30 days, and an approved price opens a new window", async () => {
    const requester = await person("manager", "صاحب التخفيضات");
    const approver = await person("manager", "المعتمد");
    const cut = (variantId: string, price: number) => requestPriceChange(t.db, requester, { variantId, newPriceIqd: price, reason: "تخفيض متدرج", idempotencyKey: key() }, "ar", tick());
    const target = await sku({ priceIqd: 100_000, landedIqd: 50_000, minBps: 800 });
    expect(await cut(target.variantId, 90_000)).toMatchObject({ status: "applied" }); // −10 %: inside the limit
    // Another 5 % now is 15 % under what shoppers paid this month: the preview says so, with the price it counts from.
    const preview = await previewPriceChange(t.db, requester, { variantId: target.variantId, newPriceIqd: 85_000, reason: "preview", idempotencyKey: key() }, "ar", clock);
    expect(preview).toMatchObject({ reasons: ["drop_over_limit"], approval: "required", referencePriceIqd: 100_000 });
    const second = await cut(target.variantId, 81_000);
    expect(second).toMatchObject({ status: "pending", reasons: ["drop_over_limit"] });
    expect(await priceOf(target.variantId)).toEqual({ price: 90_000, compareAt: null });
    // The approver sees the same 30-day price in the dialog's impact.
    const views = (await listChanges(t.db, approver, { tab: "pending", variantId: target.variantId }, "ar")).items;
    expect((await impactsFor(t.db, approver, views, clock))[second.changeId]).toMatchObject({ referencePriceIqd: 100_000, referenceDropBps: 1_900 });
    // A second person approved 81,000: the next small cut counts from there and applies at once.
    await decidePriceChange(t.db, approver, { requestId: second.changeId, decision: "approve" }, "ar", tick());
    expect(await cut(target.variantId, 78_000)).toMatchObject({ status: "applied" });
    // Only the last 30 days count: a higher price that ended 40 days ago is history, one that ended 20 days ago is not.
    for (const [daysAgo, expected] of [[40, "applied"], [20, "pending"]] as const) {
      const old = await sku({ priceIqd: 90_000, landedIqd: 50_000, createdAt: NOW - 60 * DAY_MS });
      await t.db.insert(priceChanges).values({ id: newId("pch"), variantId: old.variantId, oldPriceIqd: 100_000, newPriceIqd: 90_000, reason: "تخفيض سابق", status: "applied", createdAt: NOW - daysAgo * DAY_MS });
      expect(await cut(old.variantId, 81_000), `${daysAgo} days`).toMatchObject({ status: expected });
    }
  });

  test("the receipt page acts only on its own bills: a bill id from another receipt is not found there", async () => {
    const session = await sessionWith(["cost.read", "pricing.cost.update"]);
    const finance = await person("finance");
    const here = await draftReceipt();
    const elsewhere = await draftReceipt();
    const bill = await addLandedCost(t.db, finance, { receiptId: elsewhere.receiptId, kind: "freight", currency: "IQD", amount: "12000", method: "by_qty", reason: "شحن", idempotencyKey: key() }, tick());
    for (const intent of ["preview", "allocate", "remove"]) {
      const result = await call(session.cookie, `/admin/pricing/landed/${here.receiptId}`, receiptAction as never, { receiptId: here.receiptId }, { intent, landedCostId: bill.landedCostId, reason: "من صفحة إيصال آخر" });
      expect(statusOf(result.value ?? result.thrown), intent).toBe(404);
    }
    expect(await t.db.select({ status: landedCosts.status }).from(landedCosts).where(eq(landedCosts.id, bill.landedCostId)).get()).toEqual({ status: "draft" });
    expect(await lineLanded(elsewhere.lineA)).toBeNull();
  });

  test("an employee limited to a branch sees and changes only the receipts of that branch", async () => {
    const branchId = newId("brn");
    const locationId = newId("loc");
    await runBatch(t.db, [
      t.db.insert(branches).values({ id: branchId, code: make.next("BR"), name: { ar: "فرع البصرة" }, createdAt: NOW }) as never,
      t.db.insert(inventoryLocations).values({ id: locationId, code: make.next("LOC"), name: "مخزن الفرع", branchId }) as never,
    ]);
    const own = await draftReceipt(locationId);
    const other = await draftReceipt(); // the main warehouse belongs to no branch
    const everywhere = await person("finance");
    const limited = { ...(await person("finance")), branchId };
    const listed = (await listReceiptsForLanded(t.db, limited, {}, "ar")).map((row) => row.id);
    expect(listed).toContain(own.receiptId);
    expect(listed).not.toContain(other.receiptId);
    expect((await failure(() => getReceiptLanded(t.db, limited, other.receiptId, "ar"))).status).toBe(403);
    expect((await failure(() => addLandedCost(t.db, limited, { receiptId: other.receiptId, kind: "customs", currency: "IQD", amount: "5000", reason: "جمارك", idempotencyKey: key() }, tick()))).status).toBe(403);
    const otherBill = await addLandedCost(t.db, everywhere, { receiptId: other.receiptId, kind: "customs", currency: "IQD", amount: "5000", method: "by_qty", reason: "جمارك", idempotencyKey: key() }, tick());
    expect((await failure(() => previewAllocation(t.db, limited, { landedCostId: otherBill.landedCostId }))).status).toBe(403);
    expect((await failure(() => allocateLandedCost(t.db, limited, { landedCostId: otherBill.landedCostId }, tick()))).status).toBe(403);
    expect((await failure(() => removeLandedCost(t.db, limited, { landedCostId: otherBill.landedCostId, reason: "ليس فرعي" }, tick()))).status).toBe(403);
    // Their own branch works as before.
    const ownBill = await addLandedCost(t.db, limited, { receiptId: own.receiptId, kind: "freight", currency: "IQD", amount: "6000", method: "by_qty", reason: "شحن", idempotencyKey: key() }, tick());
    expect((await allocateLandedCost(t.db, limited, { landedCostId: ownBill.landedCostId, updateVariantCosts: false }, tick())).amountIqd).toBe(6_000);
  });

  test("removing a spread bill takes it off the SKU's landed cost too, unless the SKU's cost was changed since", async () => {
    const r = await draftReceipt();
    const finance = await person("finance");
    const bill = await addLandedCost(t.db, finance, { receiptId: r.receiptId, kind: "freight", currency: "IQD", amount: "60000", method: "by_qty", reason: "شحن", idempotencyKey: key() }, tick());
    await allocateLandedCost(t.db, finance, { landedCostId: bill.landedCostId, updateVariantCosts: true, reason: "توزيع" }, tick());
    expect((await landedOf(r.a.variantId)).landedCostIqd).toBe(309_000); // 299,000 + 60,000 ÷ 6 units
    // B's cost is typed in by hand afterwards: removing the bill must not overwrite that.
    const typed = await landedOf(r.b.variantId);
    await setVariantCost(t.db, finance, { variantId: r.b.variantId, currency: "IQD", unitCost: "71000", reason: "فاتورة جديدة", expectedUpdatedAt: String(typed.updatedAt) }, tick());
    await removeLandedCost(t.db, finance, { landedCostId: bill.landedCostId, reason: "فاتورة على الإيصال الخطأ" }, tick());
    expect((await landedOf(r.a.variantId)).landedCostIqd).toBe(299_000);
    expect((await landedOf(r.b.variantId)).landedCostIqd).toBe(71_000);
    const event = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, r.receiptId), eq(auditEvents.action, "pricing.landed.remove"))).get();
    expect(JSON.stringify(event?.after)).toContain(r.a.variantId);
  });

  test("two bills spread at the same moment cannot drop each other's share from the lines", async () => {
    const r = await draftReceipt();
    const finance = await person("finance");
    const one = await addLandedCost(t.db, finance, { receiptId: r.receiptId, kind: "freight", currency: "IQD", amount: "12000", method: "by_qty", reason: "شحن", idempotencyKey: key() }, tick());
    const two = await addLandedCost(t.db, finance, { receiptId: r.receiptId, kind: "customs", currency: "IQD", amount: "6000", method: "by_qty", reason: "جمارك", idempotencyKey: key() }, tick());
    // The first is planned while nothing is spread yet…
    const stale = await loadBillContext(t.db, finance, one.landedCostId);
    const plan = await previewAllocation(t.db, finance, { landedCostId: one.landedCostId });
    // …the second is stored meanwhile…
    await allocateLandedCost(t.db, finance, { landedCostId: two.landedCostId, updateVariantCosts: false }, tick());
    expect(await lineLanded(r.lineA)).toBe(300_000);
    // …so the first, planned without it, is refused instead of writing the lines without the second's share.
    const refused = await failure(() => runBatch(t.db, allocationStatements(t.db, { context: stale, preview: plan, updateVariantCosts: false, costRows: new Map(), actor: finance, reason: "", now: tick() })));
    expect(refused.code).toBe("cost_changed");
    expect(await lineLanded(r.lineA)).toBe(300_000);
    await allocateLandedCost(t.db, finance, { landedCostId: one.landedCostId, updateVariantCosts: false }, tick());
    expect(await lineLanded(r.lineA)).toBe(302_000); // 299,000 + 2,000 + 1,000
  });

  test("the special-pricing loader answers 403 (not a server error) to a pricing role it does not serve", async () => {
    for (const permission of ["pricing.fx_rate.manage", "pricing.price_list.manage"]) {
      const session = await sessionWith([permission]);
      for (const tab of ["bundles", "clearance", "used"]) {
        const result = await call(session.cookie, `/admin/pricing/special?tab=${tab}`, specialLoader as never, {});
        expect(statusOf(result.thrown), `${permission} ${tab}`).toBe(403);
      }
    }
  });

  test("typed amounts accept Arabic-Indic digits and separators on every pricing form", () => {
    expect(typedIqd("٧٣٥٬٠٠٠")).toBe(735_000);
    expect(typedIqd("۱۳۱۰")).toBe(1_310);
    expect(typedIqd(" 1,310 ")).toBe(1_310);
    expect(typedIqd("1310.5")).toBeNull(); // a dinar amount has no fraction: refused, not read as 13,105
    expect(typedIqd("")).toBeNull();
    // No form reads an amount by deleting every character that is not an ASCII digit (Arabic digits vanished, "1310.5" became 13105).
    const folder = fileURLToPath(new URL("../app/routes/admin/pricing/", import.meta.url));
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".tsx"))) {
      expect(readFileSync(`${folder}${file}`, "utf8"), file).not.toMatch(/replace\(\/\[\^\\d\]\/g/);
    }
  });

  test("the same cost or used-unit price sent twice is recognised, not reported as someone else's change", async () => {
    const target = await sku({ landedIqd: null });
    const finance = await person("finance");
    const form = { variantId: target.variantId, currency: "IQD", unitCost: "65,000", reason: "فاتورة المورد", expectedUpdatedAt: "0" };
    expect((await setVariantCost(t.db, finance, form, tick())).changed).toBe(true);
    expect((await setVariantCost(t.db, finance, form, tick())).changed).toBe(false);
    const manager = await person("manager");
    const unit = (await listUsedForPricing(t.db, manager, {}, "ar")).units.find((candidate) => candidate.priceable && !candidate.pending && (candidate.acquisitionCostIqd ?? null) !== null);
    expect(unit).toBeTruthy();
    const send = { usedUnitId: unit!.id, price: unit!.priceIqd + 500, expectedPriceIqd: unit!.priceIqd, reason: "تعديل بعد الفحص" };
    expect(await setUsedUnitPrice(t.db, manager, send, tick())).toMatchObject({ changed: true });
    expect(await setUsedUnitPrice(t.db, manager, send, tick())).toMatchObject({ changed: false });
  });

  test("used-device prices follow the four-eyes rules: a deep cut or a price under acquisition cost waits for someone else", async () => {
    const pricer = await person(["pricing.used.update", "pricing.discount.override", "cost.read", "profit.read"] satisfies Permission[], "مسعّر الأجهزة");
    const approver = await person(["pricing.price.approve", "pricing.used.update"] satisfies Permission[], "المعتمد");
    const overrider = await person("manager", "المدير");
    const units = (await listUsedForPricing(t.db, overrider, {}, "ar")).units.filter((unit) => unit.priceable && !unit.pending && (unit.acquisitionCostIqd ?? null) !== null);
    expect(units.length).toBeGreaterThan(1);
    const [unit, other] = units;
    const cost = unit.acquisitionCostIqd!;
    const belowCost = Math.floor((cost - 1_000) / 250) * 250;
    // Even with the override right, the same person cannot take a device under what the store paid for it.
    const asked = await setUsedUnitPrice(t.db, pricer, { usedUnitId: unit.id, price: belowCost, expectedPriceIqd: unit.priceIqd, reason: "عيب ظهر بعد الفحص" }, tick());
    expect(asked).toMatchObject({ changed: false, status: "pending", reasons: expect.arrayContaining(["below_cost"]) });
    expect((await t.db.select({ price: usedUnits.priceIqd }).from(usedUnits).where(eq(usedUnits.id, unit.id)).get())?.price).toBe(unit.priceIqd);
    const waiting = (await listUsedForPricing(t.db, overrider, {}, "ar")).units.find((candidate) => candidate.id === unit.id)!.pending!;
    expect(waiting).toMatchObject({ toIqd: belowCost, mine: false, needsOverride: true });
    expect((await failure(() => setUsedUnitPrice(t.db, overrider, { usedUnitId: unit.id, price: unit.priceIqd + 250, expectedPriceIqd: unit.priceIqd, reason: "تعديل" }, tick()))).code).toBe("change_pending");
    expect((await failure(() => decideUsedPrice(t.db, pricer, { approvalId: waiting.id, decision: "approve" }, tick()))).status).toBe(403);
    expect((await failure(() => decideUsedPrice(t.db, approver, { approvalId: waiting.id, decision: "approve" }, tick()))).code).toBe("override_required");
    expect(await decideUsedPrice(t.db, overrider, { approvalId: waiting.id, decision: "approve", note: "موافق بعد المعاينة" }, tick())).toEqual({ status: "applied", replayed: false });
    expect((await t.db.select({ price: usedUnits.priceIqd }).from(usedUnits).where(eq(usedUnits.id, unit.id)).get())?.price).toBe(belowCost);
    // A cut of more than 10 % waits too; its requester may withdraw it but never decide it.
    const deep = Math.floor((other.priceIqd * 0.85) / 250) * 250;
    const cut = await setUsedUnitPrice(t.db, approver, { usedUnitId: other.id, price: deep, expectedPriceIqd: other.priceIqd, reason: "تخفيض كبير" }, tick());
    expect(cut).toMatchObject({ changed: false, status: "pending" });
    const request = (await listUsedForPricing(t.db, approver, {}, "ar")).units.find((candidate) => candidate.id === other.id)!.pending!;
    expect(request.mine).toBe(true);
    expect((await failure(() => decideUsedPrice(t.db, approver, { approvalId: request.id, decision: "approve" }, tick()))).code).toBe("approver_is_requester");
    expect(await cancelUsedPrice(t.db, approver, { approvalId: request.id, note: "سحب" }, tick())).toEqual({ status: "cancelled", replayed: false });
    // A small cut applies at once.
    const small = Math.floor((other.priceIqd * 0.95) / 250) * 250;
    if (small > (other.acquisitionCostIqd ?? 0)) expect(await setUsedUnitPrice(t.db, approver, { usedUnitId: other.id, price: small, expectedPriceIqd: other.priceIqd, reason: "تعديل بسيط" }, tick())).toMatchObject({ changed: true, status: "applied" });
    const events = await t.db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, unit.id));
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(["pricing.used.request", "pricing.used.approve"]));
  });

  test("an employee limited to a branch prices only that branch's used devices and edits only that branch's price lists", async () => {
    const branchId = newId("brn");
    const otherBranch = newId("brn");
    const locationId = newId("loc");
    await runBatch(t.db, [
      t.db.insert(branches).values({ id: branchId, code: make.next("BR"), name: { ar: "فرع أربيل" }, createdAt: NOW }) as never,
      t.db.insert(branches).values({ id: otherBranch, code: make.next("BR"), name: { ar: "فرع النجف" }, createdAt: NOW }) as never,
      t.db.insert(inventoryLocations).values({ id: locationId, code: make.next("LOC"), name: "مخزن أربيل", branchId }) as never,
    ]);
    const manager = await person("manager");
    const limited = { ...(await person("manager")), branchId };
    const units = (await listUsedForPricing(t.db, manager, {}, "ar")).units.filter((unit) => unit.priceable && !unit.pending);
    const [here, there] = units;
    await t.db.update(usedUnits).set({ locationId }).where(eq(usedUnits.id, here.id));
    const visible = (await listUsedForPricing(t.db, limited, {}, "ar")).units.map((unit) => unit.id);
    expect(visible).toContain(here.id);
    expect(visible).not.toContain(there.id);
    expect((await failure(() => setUsedUnitPrice(t.db, limited, { usedUnitId: there.id, price: there.priceIqd + 250, expectedPriceIqd: there.priceIqd, reason: "ليس فرعي" }, tick()))).status).toBe(403);
    expect(await setUsedUnitPrice(t.db, limited, { usedUnitId: here.id, price: here.priceIqd + 250, expectedPriceIqd: here.priceIqd, reason: "تعديل في الفرع" }, tick())).toMatchObject({ status: "applied" });
    // A request on another branch's device is not theirs to decide either.
    const request = await setUsedUnitPrice(t.db, manager, { usedUnitId: there.id, price: Math.floor((there.priceIqd * 0.8) / 250) * 250, expectedPriceIqd: there.priceIqd, reason: "تخفيض" }, tick());
    expect((await failure(() => decideUsedPrice(t.db, limited, { approvalId: request.requestId, decision: "reject", note: "ليس من فرعي" }, tick()))).status).toBe(403);
    await cancelUsedPrice(t.db, manager, { approvalId: request.requestId }, tick());
    // Price lists: their branch's lists only (a list for every branch is not theirs either).
    const theirs = await savePriceList(t.db, limited, { code: make.next("ERB").toUpperCase(), nameAr: "أسعار فرع أربيل", branchId, isActive: "on", reason: "قائمة الفرع" }, "ar", tick());
    expect((await failure(() => savePriceList(t.db, limited, { code: make.next("NJF").toUpperCase(), nameAr: "أسعار فرع النجف", branchId: otherBranch, isActive: "on", reason: "قائمة" }, "ar", tick()))).status).toBe(403);
    expect((await failure(() => savePriceList(t.db, limited, { code: make.next("ALL").toUpperCase(), nameAr: "أسعار للجميع", isActive: "on", reason: "قائمة" }, "ar", tick()))).status).toBe(403);
    const global = await savePriceList(t.db, manager, { code: make.next("GLB").toUpperCase(), nameAr: "قائمة عامة", isActive: "on", reason: "قائمة" }, "ar", tick());
    const target = await sku({ priceIqd: 100_000, landedIqd: 60_000 });
    expect((await failure(() => setListItem(t.db, limited, { listId: global.id, sku: target.sku, price: "95,000", reason: "سعر" }, tick()))).status).toBe(403);
    expect(await setListItem(t.db, limited, { listId: theirs.id, sku: target.sku, price: "95,000", reason: "سعر الفرع" }, tick())).toMatchObject({ created: true });
  });

  test("a landed-cost bill beyond any real amount is a field error, not a crash when it is spread", async () => {
    const r = await draftReceipt();
    const finance = await person("finance");
    expect((await failure(() => addLandedCost(t.db, finance, { receiptId: r.receiptId, kind: "customs", currency: "USD", amount: "9999999999999.99", fxRate: "1310", reason: "خطأ طباعي", idempotencyKey: key() }, tick()))).fields).toEqual({ amount: "too_big" });
  });
});
