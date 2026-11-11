/**
 * Commerce core, part 1 — the cart and coupons: lazy creation and the hashed token (compatible with
 * the shell's badge count), re-pricing and problems on every read, clamping, used-unit rules, coupon
 * edge cases and dropping, guest-cart merge on sign-in. Real local D1 (tests/helpers/db.ts).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import type { RequestCtx } from "~/server/context.server";
import { systemActor } from "~/server/actor";
import {
  bundleItems,
  cartItems,
  carts,
  categories,
  costLayers,
  couponRedemptions,
  coupons,
  customerSegmentMembers,
  customerSegments,
  customers,
  governorates,
  platforms,
  products,
  stockLevels,
  usedUnits,
  variants,
  type NewCoupon,
} from "~/server/db/schema";
import { demoId, demoSerialsOf, seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID, governorateId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { assignSerialsStatements, commitOrderReservations, reserveStatements, reserveUsedUnitStatements } from "~/server/services/inventory/stock.server";
import {
  MAX_LINE_QTY,
  addToCart,
  applyCoupon,
  changeLineQty,
  getCartCount,
  getCartView,
  getCheckoutCart,
  isCartToken,
  mergeGuestCart,
  removeLine,
  setLineQty,
  type CartViewData,
} from "~/server/services/cart.server";
import { evaluateCoupon, normalizeCouponCode } from "~/server/services/coupons.server";
import { loadShellData } from "~/server/shell.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t.dispose();
});

const guest = (cartToken: string | null = null) => ({ cartToken, customerId: null, locale: "en" as const });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

async function setStock(variantId: string, onHand: number, reserved = 0) {
  await t.db.update(stockLevels).set({ onHand, reserved }).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));
}

async function storedQty(lineId: string) {
  return (await t.db.select({ qty: cartItems.qty }).from(cartItems).where(eq(cartItems.id, lineId)).get())?.qty;
}

let couponCounter = 0;
async function coupon(overrides: Partial<NewCoupon> = {}) {
  const id = newId("cpn");
  const code = overrides.code ?? `TEST${++couponCounter}`;
  await t.db.insert(coupons).values({ id, code, kind: "fixed", value: 10_000, isActive: true, createdAt: NOW, ...overrides });
  return { id, code };
}

/** A minimal request context for the shell loader (cookies only). */
function shellCtx(cookies: Record<string, string>): RequestCtx {
  return { cookie: (name: string) => cookies[name] ?? null, setCookie: () => {}, now: NOW, isDev: true, locale: "ar", ip: null, userAgent: "", requestId: "test" } as unknown as RequestCtx;
}

const lineOf = (view: CartViewData, variantId: string) => view.lines.find((line) => line.variantId === variantId && line.kind === "variant");

// ───────────────────────────────────────────────────────────────── identity

describe("cart identity", () => {
  test("the cart is created on the first add; only the token's hash is stored, and the shell counts it", async () => {
    const p = await make.product({ priceIqd: 120_000, stock: 5 });
    expect(await getCartView(t.db, guest(), NOW)).toMatchObject({ id: null, lines: [], count: 0, totalIqd: 0, shippingIqd: null });

    const first = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 2 }, NOW);
    expect(isCartToken(first.cartToken)).toBe(true);
    expect(first.added).toBe(2);
    const row = await t.db.select().from(carts).where(eq(carts.id, first.view.id as string)).get();
    expect(row?.tokenHash).toBe(await sha256Hex(first.cartToken));
    expect(JSON.stringify(row)).not.toContain(first.cartToken);

    expect(first.view).toMatchObject({ count: 2, subtotalIqd: 240_000, discountIqd: 0, shippingIqd: 5_000, totalIqd: 245_000, blocked: false, coupon: null, couponIssue: null });
    expect(first.view.lines[0]).toMatchObject({ kind: "variant", variantId: p.variantId, usedUnitId: null, href: expect.stringMatching(/^\/p\//), name: "Test console", qty: 2, maxQty: 5, unitPriceIqd: 120_000, lineTotalIqd: 240_000, stock: "in_stock", problem: null });

    // A second add uses the same cart and the same token.
    const second = await addToCart(t.db, guest(first.cartToken), { variantId: p.variantId, qty: 1 }, NOW);
    expect(second.cartToken).toBe(first.cartToken);
    expect(second.view.id).toBe(first.view.id);
    expect(second.view.count).toBe(3);

    // shell.server finds it by the cookie: SUM(qty) of the hashed token.
    expect((await loadShellData(shellCtx({ tt_cart: first.cartToken }), t.db)).cart).toEqual({ count: 3 });
    expect(await getCartCount(t.db, guest(first.cartToken))).toBe(3);
    expect(await getCartCount(t.db, guest(randomToken()))).toBe(0);
    expect(await getCartView(t.db, guest("not a token"), NOW)).toMatchObject({ id: null });
  });

  test("a converted cart is not reused", async () => {
    const p = await make.product({ stock: 5 });
    const first = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 1 }, NOW);
    await t.db.update(carts).set({ convertedOrderId: "ord_done" }).where(eq(carts.id, first.view.id as string));
    expect((await getCartView(t.db, guest(first.cartToken), NOW)).id).toBeNull();
    const next = await addToCart(t.db, guest(first.cartToken), { variantId: p.variantId, qty: 1 }, NOW);
    expect(next.cartToken).not.toBe(first.cartToken);
    expect(next.view.id).not.toBe(first.view.id);
  });

  test("a customer's cart is never shown to a guest holding its cookie", async () => {
    const p = await make.product({ stock: 5 });
    const customerId = await make.customer();
    const mine = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: p.variantId, qty: 1 }, NOW);
    expect((await getCartView(t.db, { cartToken: mine.cartToken, customerId, locale: "ar" }, NOW)).count).toBe(1);
    expect((await getCartView(t.db, guest(mine.cartToken), NOW)).id).toBeNull();
    const strangers = await addToCart(t.db, guest(mine.cartToken), { variantId: p.variantId, qty: 1 }, NOW);
    expect(strangers.view.id).not.toBe(mine.view.id);
    expect((await getCartView(t.db, { cartToken: null, customerId, locale: "ar" }, NOW)).id).toBe(mine.view.id);
  });

  test("a signed-in customer reaches their cart without the cookie; adding hands this device a new token", async () => {
    const p = await make.product({ stock: 5 });
    const customerId = await make.customer();
    const first = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: p.variantId, qty: 1 }, NOW);
    const otherDevice = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: p.variantId, qty: 1 }, NOW + 1);
    expect(otherDevice.view.id).toBe(first.view.id);
    expect(otherDevice.cartToken).not.toBe(first.cartToken);
    expect(otherDevice.view.count).toBe(2);
    expect(await getCartCount(t.db, { cartToken: otherDevice.cartToken, customerId })).toBe(2);
    // The old token no longer opens it on its own (the first device falls back to the customer lookup).
    expect((await getCartView(t.db, guest(first.cartToken), NOW)).id).toBeNull();
    // The contract functions never re-key: a change reached through the customer keeps the token.
    const hash = (await t.db.select({ h: carts.tokenHash }).from(carts).where(eq(carts.id, first.view.id as string)).get())?.h;
    await setLineQty(t.db, { cartToken: null, customerId, locale: "ar" }, otherDevice.view.lines[0].id, 1, NOW + 2);
    expect((await t.db.select({ h: carts.tokenHash }).from(carts).where(eq(carts.id, first.view.id as string)).get())?.h).toBe(hash);
    const viaRoute = await changeLineQty(t.db, { cartToken: null, customerId, locale: "ar" }, otherDevice.view.lines[0].id, 2, NOW + 3, { rekey: true });
    expect(viaRoute.cartToken).not.toBeNull();
    expect(await getCartCount(t.db, guest(viaRoute.cartToken))).toBe(0); // owned by the customer: a guest lookup does not count it
    expect(await getCartCount(t.db, { cartToken: viaRoute.cartToken, customerId })).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────── re-pricing and problems

describe("re-pricing on every read", () => {
  test("a changed price is used and flagged; touching the line acknowledges it", async () => {
    const p = await make.product({ priceIqd: 100_000, stock: 5 });
    const { cartToken, view } = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 2 }, NOW);
    await t.db.update(variants).set({ priceIqd: 90_000 }).where(eq(variants.id, p.variantId));
    const after = await getCartView(t.db, guest(cartToken), NOW);
    expect(lineOf(after, p.variantId)).toMatchObject({ unitPriceIqd: 90_000, lineTotalIqd: 180_000, problem: "price_changed" });
    expect(after).toMatchObject({ subtotalIqd: 180_000, totalIqd: 185_000, blocked: false });
    const touched = await setLineQty(t.db, guest(cartToken), view.lines[0].id, 2, NOW);
    expect(lineOf(touched, p.variantId)?.problem).toBeNull();
  });

  test("more in the cart than can be sold: the view clamps, a read never writes, the next change stores it", async () => {
    const p = await make.product({ priceIqd: 50_000, stock: 5 });
    const other = await make.product({ stock: 5 });
    const { cartToken, view } = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 5 }, NOW);
    await setStock(p.variantId, 5, 3);
    const after = await getCartView(t.db, guest(cartToken), NOW);
    expect(lineOf(after, p.variantId)).toMatchObject({ qty: 2, maxQty: 2, lineTotalIqd: 100_000, problem: "qty_reduced", stock: "low_stock" });
    expect(after).toMatchObject({ count: 2, subtotalIqd: 100_000, blocked: false });
    expect(await storedQty(view.lines[0].id)).toBe(5);
    await addToCart(t.db, guest(cartToken), { variantId: other.variantId, qty: 1 }, NOW);
    expect(await storedQty(view.lines[0].id)).toBe(2);
  });

  test("out of stock and unavailable lines block checkout and leave the totals", async () => {
    const gone = await make.product({ priceIqd: 70_000, stock: 2 });
    const archived = await make.product({ priceIqd: 30_000, stock: 2 });
    const off = await make.product({ priceIqd: 20_000, stock: 2 });
    const fine = await make.product({ priceIqd: 10_000, stock: 2 });
    let token: string | null = null;
    for (const p of [gone, archived, off, fine]) token = (await addToCart(t.db, guest(token), { variantId: p.variantId, qty: 1 }, NOW)).cartToken;
    await setStock(gone.variantId, 0);
    await t.db.update(products).set({ status: "archived" }).where(eq(products.id, archived.productId));
    await t.db.update(variants).set({ isActive: false }).where(eq(variants.id, off.variantId));
    const view = await getCartView(t.db, guest(token), NOW);
    expect(lineOf(view, gone.variantId)).toMatchObject({ problem: "out_of_stock", stock: "out_of_stock", maxQty: 0 });
    expect(lineOf(view, archived.variantId)).toMatchObject({ problem: "unavailable", maxQty: 0 });
    expect(lineOf(view, off.variantId)).toMatchObject({ problem: "unavailable" });
    expect(lineOf(view, fine.variantId)?.problem).toBeNull();
    expect(view).toMatchObject({ blocked: true, subtotalIqd: 10_000, totalIqd: 15_000, count: 4 });

    expect(await failureOf(addToCart(t.db, guest(token), { variantId: gone.variantId, qty: 1 }, NOW))).toMatchObject({ code: "out_of_stock", status: 409 });
    expect(await failureOf(addToCart(t.db, guest(token), { variantId: archived.variantId, qty: 1 }, NOW))).toMatchObject({ code: "unavailable", status: 409 });
    expect(await failureOf(addToCart(t.db, guest(token), { variantId: "var_missing", qty: 1 }, NOW))).toMatchObject({ code: "not_found", status: 404 });
    const goneLine = lineOf(view, gone.variantId)?.id as string;
    expect(await failureOf(setLineQty(t.db, guest(token), goneLine, 1, NOW))).toMatchObject({ code: "out_of_stock" });
    const cleared = await removeLine(t.db, guest(token), goneLine, NOW);
    expect(lineOf(cleared, gone.variantId)).toBeUndefined();
  });

  test("a line holds at most 10 units and never more than the stock", async () => {
    const big = await make.product({ priceIqd: 1_000, stock: 50 });
    const first = await addToCart(t.db, guest(), { variantId: big.variantId, qty: 8 }, NOW);
    const more = await addToCart(t.db, guest(first.cartToken), { variantId: big.variantId, qty: 5 }, NOW);
    expect(more.added).toBe(2);
    expect(lineOf(more.view, big.variantId)?.qty).toBe(MAX_LINE_QTY);
    expect(await failureOf(addToCart(t.db, guest(first.cartToken), { variantId: big.variantId, qty: 1 }, NOW))).toMatchObject({ code: "max_qty_reached" });
    expect(await failureOf(addToCart(t.db, guest(first.cartToken), { variantId: big.variantId, qty: 11 }, NOW))).toMatchObject({ code: "invalid", status: 400, fields: { qty: "too_big" } });
    expect(await failureOf(setLineQty(t.db, guest(first.cartToken), more.view.lines[0].id, 11, NOW))).toMatchObject({ code: "invalid" });

    const few = await make.product({ stock: 3 });
    const capped = await addToCart(t.db, guest(), { variantId: few.variantId, qty: 5 }, NOW);
    expect(capped.added).toBe(3);
    expect(lineOf(capped.view, few.variantId)).toMatchObject({ qty: 3, maxQty: 3 });
    expect(await failureOf(addToCart(t.db, guest(capped.cartToken), { variantId: few.variantId, qty: 1 }, NOW))).toMatchObject({ code: "insufficient_stock" });
    const set = await setLineQty(t.db, guest(capped.cartToken), capped.view.lines[0].id, 9, NOW);
    expect(lineOf(set, few.variantId)?.qty).toBe(3);
    const removed = await setLineQty(t.db, guest(capped.cartToken), capped.view.lines[0].id, 0, NOW);
    expect(removed.lines).toHaveLength(0);
    expect(await failureOf(setLineQty(t.db, guest(capped.cartToken), capped.view.lines[0].id, 1, NOW))).toMatchObject({ code: "not_found", status: 404 });
    // Removing something already gone is fine.
    expect((await removeLine(t.db, guest(capped.cartToken), capped.view.lines[0].id, NOW)).lines).toHaveLength(0);
  });

  test("validation: exactly one of variantId / usedUnitId", async () => {
    expect(await failureOf(addToCart(t.db, guest(), { qty: 1 }, NOW))).toMatchObject({ code: "invalid", fields: { variantId: "required" } });
    expect(await failureOf(addToCart(t.db, guest(), { variantId: "var_a", usedUnitId: "usd_b" }, NOW))).toMatchObject({ code: "invalid" });
    expect(await failureOf(addToCart(t.db, guest(), { variantId: "'; DROP TABLE carts; --" }, NOW))).toMatchObject({ code: "invalid" });
  });

  test("a bundle is sold by complete sets of its components", async () => {
    const consoleItem = await make.product({ stock: 3 });
    const game = await make.product({ kind: "game", stock: 1 });
    const bundle = await make.product({ priceIqd: 700_000, stock: 0 });
    await t.db.insert(bundleItems).values([
      { bundleVariantId: bundle.variantId, componentVariantId: consoleItem.variantId, qty: 1 },
      { bundleVariantId: bundle.variantId, componentVariantId: game.variantId, qty: 1 },
    ]);
    const { view } = await addToCart(t.db, guest(), { variantId: bundle.variantId, qty: 2 }, NOW);
    expect(lineOf(view, bundle.variantId)).toMatchObject({ qty: 1, maxQty: 1, unitPriceIqd: 700_000, stock: "low_stock" });
  });
});

// ───────────────────────────────────────────────────────────────── used units

describe("used units in the cart", () => {
  async function usedUnit(status: "listed" | "ready" | "reserved" = "listed", priceIqd = 400_000) {
    const p = await make.product({ trackSerials: true });
    const id = newId("usd");
    await t.db.insert(usedUnits).values({ id, slug: make.next("used-unit"), variantId: p.variantId, grade: "A", priceIqd, status, isDemo: true, createdAt: NOW, updatedAt: NOW });
    return { id, variantId: p.variantId };
  }

  test("a listed unit goes in once, with qty 1", async () => {
    const unit = await usedUnit();
    const first = await addToCart(t.db, guest(), { usedUnitId: unit.id }, NOW);
    expect(first.view.lines[0]).toMatchObject({ kind: "used_unit", usedUnitId: unit.id, variantId: unit.variantId, qty: 1, maxQty: 1, unitPriceIqd: 400_000, href: expect.stringMatching(/^\/used\//), optionsLabel: "A", problem: null });
    const again = await addToCart(t.db, guest(first.cartToken), { usedUnitId: unit.id }, NOW);
    expect(again.added).toBe(0);
    expect(again.view.lines).toHaveLength(1);
    expect(await failureOf(addToCart(t.db, guest(first.cartToken), { usedUnitId: unit.id, qty: 2 }, NOW))).toMatchObject({ code: "invalid", fields: { qty: "invalid" } });
    expect(await failureOf(setLineQty(t.db, guest(first.cartToken), first.view.lines[0].id, 2, NOW))).toMatchObject({ code: "invalid" });
  });

  test("only listed units can be added; a unit that stops being listed is unavailable", async () => {
    const notYet = await usedUnit("ready");
    expect(await failureOf(addToCart(t.db, guest(), { usedUnitId: notYet.id }, NOW))).toMatchObject({ code: "unavailable", status: 409 });
    expect(await failureOf(addToCart(t.db, guest(), { usedUnitId: "usd_missing" }, NOW))).toMatchObject({ code: "not_found" });
    const unit = await usedUnit();
    const { cartToken } = await addToCart(t.db, guest(), { usedUnitId: unit.id }, NOW);
    await t.db.update(usedUnits).set({ status: "reserved" }).where(eq(usedUnits.id, unit.id));
    const view = await getCartView(t.db, guest(cartToken), NOW);
    expect(view.lines[0]).toMatchObject({ problem: "unavailable", maxQty: 0, stock: "out_of_stock" });
    expect(view).toMatchObject({ blocked: true, subtotalIqd: 0, shippingIqd: null, totalIqd: 0 });
  });

  test("a used unit's price change is flagged", async () => {
    const unit = await usedUnit("listed", 300_000);
    const { cartToken } = await addToCart(t.db, guest(), { usedUnitId: unit.id }, NOW);
    await t.db.update(usedUnits).set({ priceIqd: 280_000 }).where(eq(usedUnits.id, unit.id));
    expect((await getCartView(t.db, guest(cartToken), NOW)).lines[0]).toMatchObject({ unitPriceIqd: 280_000, problem: "price_changed" });
  });
});

// ───────────────────────────────────────────────────────────────── shipping in the view

describe("shipping in the cart", () => {
  test("estimate before a governorate is chosen, the fee after, null where not served", async () => {
    const p = await make.product({ priceIqd: 10_000, stock: 5 });
    const { cartToken } = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 1 }, NOW);
    expect((await getCartView(t.db, guest(cartToken), NOW)).shippingIqd).toBe(5_000);
    expect((await getCartView(t.db, { ...guest(cartToken), governorateId: governorateId("nineveh") }, NOW)).shippingIqd).toBe(5_000);
    await t.db.update(governorates).set({ isActive: false }).where(eq(governorates.id, governorateId("anbar")));
    try {
      const view = await getCartView(t.db, { ...guest(cartToken), governorateId: governorateId("anbar") }, NOW);
      expect(view).toMatchObject({ shippingIqd: null, totalIqd: 10_000 });
    } finally {
      await t.db.update(governorates).set({ isActive: true }).where(eq(governorates.id, governorateId("anbar")));
    }
  });
});

// ───────────────────────────────────────────────────────────────── coupons

describe("coupon evaluation", () => {
  const line = (variantId: string, unitPriceIqd: number, qty = 1) => ({ variantId, unitPriceIqd, qty });

  test("codes are matched case-insensitively and normalized", async () => {
    expect(normalizeCouponCode("  demo 10 ")).toBe("DEMO10");
    expect(normalizeCouponCode("ab٣")).toBe("AB3");
    expect(normalizeCouponCode("")).toBeNull();
    expect(normalizeCouponCode("x".repeat(65))).toBeNull();
    const p = await make.product();
    const { code } = await coupon({ code: "SPRING5", kind: "fixed", value: 5_000 });
    expect(await evaluateCoupon(t.db, { code: "spring5", subtotalIqd: 100_000, lines: [line(p.variantId, 100_000)] }, NOW)).toMatchObject({ ok: true, code, discountIqd: 5_000 });
    expect(await evaluateCoupon(t.db, { code: "nope", subtotalIqd: 100_000, lines: [line(p.variantId, 100_000)] }, NOW)).toEqual({ ok: false, reason: "not_found" });
  });

  test("switched off, not started, expired", async () => {
    const p = await make.product();
    const lines = [line(p.variantId, 100_000)];
    const off = await coupon({ isActive: false });
    const future = await coupon({ startsAt: NOW + DAY });
    const past = await coupon({ endsAt: NOW });
    const window = await coupon({ startsAt: NOW - DAY, endsAt: NOW + 1 });
    expect(await evaluateCoupon(t.db, { code: off.code, subtotalIqd: 100_000, lines }, NOW)).toEqual({ ok: false, reason: "not_found" });
    expect(await evaluateCoupon(t.db, { code: future.code, subtotalIqd: 100_000, lines }, NOW)).toEqual({ ok: false, reason: "not_started" });
    expect(await evaluateCoupon(t.db, { code: past.code, subtotalIqd: 100_000, lines }, NOW)).toEqual({ ok: false, reason: "expired" });
    expect((await evaluateCoupon(t.db, { code: window.code, subtotalIqd: 100_000, lines }, NOW)).ok).toBe(true);
  });

  test("percent in basis points, rounded half up, capped; fixed never exceeds the subtotal", async () => {
    const p = await make.product();
    const tenPercent = await coupon({ kind: "percent", value: 1_000, maxDiscountIqd: 25_000 });
    const odd = await coupon({ kind: "percent", value: 1_250 });
    const big = await coupon({ kind: "fixed", value: 50_000 });
    expect(await evaluateCoupon(t.db, { code: tenPercent.code, subtotalIqd: 120_000, lines: [line(p.variantId, 120_000)] }, NOW)).toMatchObject({ ok: true, discountIqd: 12_000 });
    expect(await evaluateCoupon(t.db, { code: tenPercent.code, subtotalIqd: 749_000, lines: [line(p.variantId, 749_000)] }, NOW)).toMatchObject({ ok: true, discountIqd: 25_000 });
    // 12.5% of 1,004 = 125.5 → 126
    expect(await evaluateCoupon(t.db, { code: odd.code, subtotalIqd: 1_004, lines: [line(p.variantId, 1_004)] }, NOW)).toMatchObject({ ok: true, discountIqd: 126 });
    expect(await evaluateCoupon(t.db, { code: big.code, subtotalIqd: 30_000, lines: [line(p.variantId, 30_000)] }, NOW)).toMatchObject({ ok: true, discountIqd: 30_000 });
  });

  test("minimum subtotal and empty carts", async () => {
    const p = await make.product();
    const min = await coupon({ minSubtotalIqd: 100_000 });
    expect(await evaluateCoupon(t.db, { code: min.code, subtotalIqd: 99_999, lines: [line(p.variantId, 99_999)] }, NOW)).toEqual({ ok: false, reason: "min_subtotal" });
    expect((await evaluateCoupon(t.db, { code: min.code, subtotalIqd: 100_000, lines: [line(p.variantId, 100_000)] }, NOW)).ok).toBe(true);
    expect(await evaluateCoupon(t.db, { code: min.code, subtotalIqd: 0, lines: [] }, NOW)).toEqual({ ok: false, reason: "not_applicable" });
  });

  test("usage limits count live redemptions; per customer by customer id OR phone", async () => {
    const p = await make.product();
    const lines = [line(p.variantId, 100_000)];
    const limited = await coupon({ usageLimit: 2, perCustomerLimit: 1 });
    const customerId = await make.customer();
    const phone = (await t.db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, customerId)).get())?.phone as string;
    const redeem = async (who: { customerId?: string | null; phoneE164?: string | null }, voidedAt: number | null = null) => {
      const order = await make.order([{ variantId: p.variantId, sku: p.sku }]);
      await t.db.insert(couponRedemptions).values({ id: newId("crd"), couponId: limited.id, orderId: order.orderId, customerId: who.customerId ?? null, phoneE164: who.phoneE164 ?? null, amountIqd: 10_000, at: NOW, voidedAt });
    };
    await redeem({ phoneE164: phone }, NOW); // voided: does not count
    expect((await evaluateCoupon(t.db, { code: limited.code, subtotalIqd: 100_000, lines, customerId }, NOW)).ok).toBe(true);
    await redeem({ phoneE164: phone }); // as a guest, with the same phone
    expect(await evaluateCoupon(t.db, { code: limited.code, subtotalIqd: 100_000, lines, customerId, phoneE164: phone }, NOW)).toEqual({ ok: false, reason: "customer_limit" });
    expect(await evaluateCoupon(t.db, { code: limited.code, subtotalIqd: 100_000, lines, phoneE164: phone }, NOW)).toEqual({ ok: false, reason: "customer_limit" });
    // Unknown shopper (no id, no phone yet): the per-customer limit cannot be checked, it applies provisionally.
    expect((await evaluateCoupon(t.db, { code: limited.code, subtotalIqd: 100_000, lines }, NOW)).ok).toBe(true);
    await redeem({ customerId: await make.customer() });
    expect(await evaluateCoupon(t.db, { code: limited.code, subtotalIqd: 100_000, lines }, NOW)).toEqual({ ok: false, reason: "usage_limit" });
  });

  test("category (with sub-categories), platform and kind conditions; the discount covers eligible lines only", async () => {
    const platformId = newId("plt");
    await t.db.insert(platforms).values({ id: platformId, slug: make.next("platform"), name: { ar: "منصة" } });
    const parent = newId("cat");
    const child = newId("cat");
    await t.db.insert(categories).values([
      { id: parent, slug: make.next("cat"), name: { ar: "أب" } },
      { id: child, parentId: parent, slug: make.next("cat"), name: { ar: "ابن" } },
    ]);
    const inChild = await make.product({ kind: "controller" });
    await t.db.update(products).set({ categoryId: child, platformId }).where(eq(products.id, inChild.productId));
    const elsewhere = await make.product({ kind: "console" });
    const lines = [line(inChild.variantId, 40_000, 2), line(elsewhere.variantId, 500_000)];
    const subtotal = 580_000;

    const byCategory = await coupon({ kind: "percent", value: 1_000, conditions: { categoryIds: [parent] } });
    expect(await evaluateCoupon(t.db, { code: byCategory.code, subtotalIqd: subtotal, lines }, NOW)).toMatchObject({ ok: true, discountIqd: 8_000 });
    const byPlatform = await coupon({ kind: "fixed", value: 100_000, conditions: { platformIds: [platformId] } });
    expect(await evaluateCoupon(t.db, { code: byPlatform.code, subtotalIqd: subtotal, lines }, NOW)).toMatchObject({ ok: true, discountIqd: 80_000 });
    const byKind = await coupon({ conditions: { productKinds: ["headset"] } });
    expect(await evaluateCoupon(t.db, { code: byKind.code, subtotalIqd: subtotal, lines }, NOW)).toEqual({ ok: false, reason: "not_applicable" });
    const minQty = await coupon({ conditions: { categoryIds: [child], minQty: 3 } });
    expect(await evaluateCoupon(t.db, { code: minQty.code, subtotalIqd: subtotal, lines }, NOW)).toEqual({ ok: false, reason: "not_applicable" });
    const posOnly = await coupon({ conditions: { channels: ["pos"] } });
    expect(await evaluateCoupon(t.db, { code: posOnly.code, subtotalIqd: subtotal, lines }, NOW)).toEqual({ ok: false, reason: "not_applicable" });
    expect((await evaluateCoupon(t.db, { code: posOnly.code, subtotalIqd: subtotal, lines, channel: "pos" }, NOW)).ok).toBe(true);
  });

  test("segments and first-order-only coupons", async () => {
    const p = await make.product();
    const lines = [line(p.variantId, 100_000)];
    const segmentId = newId("seg");
    await t.db.insert(customerSegments).values({ id: segmentId, key: make.next("segment"), name: { ar: "شريحة" }, isDynamic: false, createdAt: NOW, updatedAt: NOW });
    const member = await make.customer();
    await t.db.insert(customerSegmentMembers).values({ segmentId, customerId: member, addedAt: NOW });
    const vip = await coupon({ conditions: { segmentIds: [segmentId] } });
    expect((await evaluateCoupon(t.db, { code: vip.code, subtotalIqd: 100_000, lines, customerId: member }, NOW)).ok).toBe(true);
    expect(await evaluateCoupon(t.db, { code: vip.code, subtotalIqd: 100_000, lines, customerId: await make.customer() }, NOW)).toEqual({ ok: false, reason: "not_applicable" });
    expect(await evaluateCoupon(t.db, { code: vip.code, subtotalIqd: 100_000, lines }, NOW)).toEqual({ ok: false, reason: "not_applicable" });

    const welcome = await coupon({ conditions: { firstOrderOnly: true } });
    const returning = await make.customer();
    expect((await evaluateCoupon(t.db, { code: welcome.code, subtotalIqd: 100_000, lines, customerId: returning }, NOW)).ok).toBe(true);
    await make.order([{ variantId: p.variantId, sku: p.sku }], { customerId: returning });
    expect(await evaluateCoupon(t.db, { code: welcome.code, subtotalIqd: 100_000, lines, customerId: returning }, NOW)).toEqual({ ok: false, reason: "not_applicable" });
  });
});

describe("coupons on the cart", () => {
  test("applied, re-evaluated on every read, dropped with a reason, back when the cart qualifies again", async () => {
    const pricey = await make.product({ priceIqd: 80_000, stock: 5 });
    const cheap = await make.product({ priceIqd: 30_000, stock: 5 });
    const { code } = await coupon({ kind: "percent", value: 1_000, minSubtotalIqd: 100_000 });
    const a = await addToCart(t.db, guest(), { variantId: pricey.variantId, qty: 1 }, NOW);
    expect(await failureOf(applyCoupon(t.db, guest(a.cartToken), code, NOW))).toMatchObject({ code: "coupon_min_subtotal", status: 409, fields: { code: "coupon_min_subtotal" } });
    const b = await addToCart(t.db, guest(a.cartToken), { variantId: cheap.variantId, qty: 1 }, NOW);
    const applied = await applyCoupon(t.db, guest(b.cartToken), code.toLowerCase(), NOW);
    expect(applied).toMatchObject({ coupon: { code }, couponIssue: null, subtotalIqd: 110_000, discountIqd: 11_000, totalIqd: 104_000 });

    const cheapLine = applied.lines.find((entry) => entry.variantId === cheap.variantId)?.id as string;
    const dropped = await removeLine(t.db, guest(b.cartToken), cheapLine, NOW);
    expect(dropped).toMatchObject({ coupon: null, discountIqd: 0, couponIssue: { code, reason: "min_subtotal" }, totalIqd: 85_000 });
    expect((await t.db.select({ code: carts.couponCode }).from(carts).where(eq(carts.id, dropped.id as string)).get())?.code).toBe(code);

    const back = await addToCart(t.db, guest(b.cartToken), { variantId: cheap.variantId, qty: 1 }, NOW);
    expect(back.view).toMatchObject({ coupon: { code }, discountIqd: 11_000, couponIssue: null });

    const removed = await applyCoupon(t.db, guest(b.cartToken), null, NOW);
    expect(removed).toMatchObject({ coupon: null, couponIssue: null, discountIqd: 0 });
  });

  test("a coupon gone for good is shown as such, then removed by the next change", async () => {
    const p = await make.product({ priceIqd: 100_000, stock: 5 });
    const other = await make.product({ stock: 5 });
    const { id, code } = await coupon({ kind: "fixed", value: 5_000 });
    const { cartToken } = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 1 }, NOW);
    await applyCoupon(t.db, guest(cartToken), code, NOW);
    await t.db.update(coupons).set({ endsAt: NOW + DAY }).where(eq(coupons.id, id));
    const later = await getCartView(t.db, guest(cartToken), NOW + 2 * DAY);
    expect(later).toMatchObject({ coupon: null, discountIqd: 0, couponIssue: { code, reason: "expired" } });
    await addToCart(t.db, guest(cartToken), { variantId: other.variantId, qty: 1 }, NOW + 2 * DAY);
    expect((await getCartView(t.db, guest(cartToken), NOW + 2 * DAY)).couponIssue).toBeNull();
    expect(await failureOf(applyCoupon(t.db, guest(cartToken), "UNKNOWN-CODE", NOW))).toMatchObject({ code: "coupon_not_found" });
    expect(await failureOf(applyCoupon(t.db, guest(), code, NOW))).toMatchObject({ code: "coupon_not_applicable" });
  });

  test("checkout pricing carries the coupon id and line snapshots", async () => {
    const p = await make.product({ priceIqd: 200_000, stock: 5 });
    const { id, code } = await coupon({ kind: "fixed", value: 15_000 });
    const { cartToken } = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 2 }, NOW);
    await applyCoupon(t.db, guest(cartToken), code, NOW);
    const checkout = await getCheckoutCart(t.db, { ...guest(cartToken), governorateId: governorateId("basra") }, NOW);
    expect(checkout.coupon).toEqual({ couponId: id, code, discountIqd: 15_000 });
    expect(checkout.view).toMatchObject({ subtotalIqd: 400_000, discountIqd: 15_000, shippingIqd: 5_000, totalIqd: 390_000 });
    expect(checkout.lines[0]).toMatchObject({ purchasable: true, sku: p.sku, productId: p.productId, name: { ar: "جهاز للاختبار", en: "Test console" } });
  });
});

// ───────────────────────────────────────────────────────────────── merge on sign-in

describe("mergeGuestCart", () => {
  test("folds the customer's other cart into the cookie's cart and adopts it", async () => {
    const a = await make.product({ priceIqd: 10_000, stock: 50 });
    const b = await make.product({ priceIqd: 20_000, stock: 50 });
    const customerId = await make.customer();
    const { code } = await coupon({ kind: "fixed", value: 1_000 });

    const old = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: a.variantId, qty: 9 }, NOW - DAY);
    await addToCart(t.db, { cartToken: old.cartToken, customerId, locale: "ar" }, { variantId: b.variantId, qty: 1 }, NOW - DAY);
    await applyCoupon(t.db, { cartToken: old.cartToken, customerId, locale: "ar" }, code, NOW - DAY);

    const guestCart = await addToCart(t.db, guest(), { variantId: a.variantId, qty: 3 }, NOW);
    await mergeGuestCart(t.db, { cartToken: guestCart.cartToken, customerId }, NOW);

    const merged = await getCartView(t.db, { cartToken: guestCart.cartToken, customerId, locale: "ar" }, NOW);
    expect(merged.id).toBe(guestCart.view.id);
    expect(lineOf(merged, a.variantId)?.qty).toBe(MAX_LINE_QTY);
    expect(lineOf(merged, b.variantId)?.qty).toBe(1);
    expect(merged.coupon?.code).toBe(code);
    expect(await t.db.select().from(carts).where(eq(carts.id, old.view.id as string))).toHaveLength(0);
    expect((await t.db.select({ customerId: carts.customerId }).from(carts).where(eq(carts.id, guestCart.view.id as string)).get())?.customerId).toBe(customerId);
    // Signed in elsewhere without the cookie, the customer reaches the same cart.
    expect((await getCartView(t.db, { cartToken: null, customerId, locale: "ar" }, NOW)).id).toBe(guestCart.view.id);
  });

  test("leaves a cart that belongs to someone else alone, and does nothing without a cookie", async () => {
    const p = await make.product({ stock: 5 });
    const owner = await make.customer();
    const intruder = await make.customer();
    const theirs = await addToCart(t.db, { cartToken: null, customerId: owner, locale: "ar" }, { variantId: p.variantId, qty: 1 }, NOW);
    await mergeGuestCart(t.db, { cartToken: theirs.cartToken, customerId: intruder }, NOW);
    expect((await t.db.select({ customerId: carts.customerId }).from(carts).where(eq(carts.id, theirs.view.id as string)).get())?.customerId).toBe(owner);
    await expect(mergeGuestCart(t.db, { cartToken: null, customerId: owner }, NOW)).resolves.toBeUndefined();
  });

  test("a lone guest cart is simply adopted", async () => {
    const p = await make.product({ stock: 5 });
    const customerId = await make.customer();
    const g = await addToCart(t.db, guest(), { variantId: p.variantId, qty: 2 }, NOW);
    await mergeGuestCart(t.db, { cartToken: g.cartToken, customerId }, NOW);
    expect(await getCartCount(t.db, { cartToken: null, customerId })).toBe(2);
    expect(await getCartCount(t.db, guest(g.cartToken))).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── the demo catalogue, end to end

describe("with the demo catalogue", () => {
  beforeAll(async () => {
    await seedDemo(t.db, NOW);
  });

  test("bundle + used unit + DEMO10: priced, reserved (components), packed (component serial), shipped (FIFO)", async () => {
    const bundleId = demoId.variant("NSW2-BUNDLE-MKW");
    const consoleId = demoId.variant("NSW2-CON-256");
    const gameId = demoId.variant("NSW2-MKW");
    const usedId = demoId.usedUnit("used-ps5-slim-disc-01");
    const levelOf = async (variantId: string) => t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
    const consoleBefore = await levelOf(consoleId);
    const gameBefore = await levelOf(gameId);
    const sets = Math.min(consoleBefore?.onHand ?? 0, gameBefore?.onHand ?? 0);

    const first = await addToCart(t.db, guest(), { variantId: bundleId, qty: 1 }, NOW);
    expect(lineOf(first.view, bundleId)).toMatchObject({ unitPriceIqd: 765_000, maxQty: Math.min(MAX_LINE_QTY, sets), problem: null });
    await addToCart(t.db, guest(first.cartToken), { usedUnitId: usedId }, NOW);
    const used = await t.db.select().from(usedUnits).where(eq(usedUnits.id, usedId)).get();
    const withCoupon = await applyCoupon(t.db, guest(first.cartToken), "demo10", NOW);
    const subtotal = 765_000 + (used?.priceIqd ?? 0);
    expect(withCoupon).toMatchObject({ subtotalIqd: subtotal, discountIqd: Math.min(25_000, Math.round(subtotal / 10)), coupon: { code: "DEMO10" }, blocked: false });

    const checkout = await getCheckoutCart(t.db, { ...guest(first.cartToken), governorateId: governorateId("erbil") }, NOW);
    expect(checkout.view.totalIqd).toBe(subtotal - checkout.view.discountIqd + 5_000);
    const order = await make.order(
      checkout.lines.map((entry) => ({ variantId: entry.line.variantId as string, sku: entry.sku, qty: entry.line.qty, unitPriceIqd: entry.line.unitPriceIqd, usedUnitId: entry.line.usedUnitId ?? undefined })),
    );
    const actor = systemActor("test.checkout");
    await runBatch(t.db, [
      ...reserveStatements(t.db, { orderId: order.orderId, lines: checkout.lines.filter((entry) => entry.line.kind === "variant").map((entry) => ({ variantId: entry.line.variantId as string, qty: entry.line.qty })), expiresAt: null, actor, now: NOW }),
      ...reserveUsedUnitStatements(t.db, { usedUnitId: usedId, orderId: order.orderId, now: NOW }),
    ]);
    expect((await levelOf(consoleId))?.reserved).toBe((consoleBefore?.reserved ?? 0) + 1);
    expect((await levelOf(gameId))?.reserved).toBe((gameBefore?.reserved ?? 0) + 1);
    expect((await levelOf(bundleId))?.reserved).toBe(0);
    // The cart now offers one set fewer; the used unit, now reserved, is unavailable in it.
    const after = await getCartView(t.db, guest(first.cartToken), NOW);
    expect(lineOf(after, bundleId)?.maxQty).toBe(Math.min(MAX_LINE_QTY, sets - 1));
    expect(after.lines.find((entry) => entry.kind === "used_unit")?.problem).toBe("unavailable");

    // Packing: the bundle line takes the serial of its console component.
    const bundleItemId = order.itemIds[checkout.lines.findIndex((entry) => entry.line.variantId === bundleId && entry.line.kind === "variant")];
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: bundleItemId, serialIds: [demoId.serial(demoSerialsOf("NSW2-CON-256", 4)[0])], actor, now: NOW }));

    // Shipping: FIFO cost of the components' opening layers + the used unit's acquisition cost.
    const layerCost = async (variantId: string) => (await t.db.select().from(costLayers).where(eq(costLayers.variantId, variantId)).get())?.unitCostIqd ?? 0;
    const expectedCogs = (await layerCost(consoleId)) + (await layerCost(gameId)) + (used?.acquisitionCostIqd ?? 0);
    const shipped = await commitOrderReservations(t.db, actor, order.orderId, NOW + 1);
    expect(shipped).toEqual({ reservations: 2, units: 2, usedUnits: 1, cogsIqd: expectedCogs, unitsWithoutLayer: 0 });
    expect(await levelOf(consoleId)).toMatchObject({ onHand: (consoleBefore?.onHand ?? 0) - 1, reserved: consoleBefore?.reserved ?? 0 });
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, usedId)).get())?.status).toBe("sold");
  });
});
