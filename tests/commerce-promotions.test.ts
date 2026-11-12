/**
 * Commerce core, 2026-11-12 — promotions at checkout (flash prices and their allowance, module 08's automatic rules,
 * the membership discount and free delivery, redeemed points, referral codes), every amount as charged on the order,
 * gift cards redeemed into the wallet, wallet split payments, wallet transfers and payouts (module 07's merge and
 * erasure), digital codes of paid orders, the buy-back of a sold serial (module 13), and the odds and ends (demo lines
 * never "low stock", CartLine.productId / optionValue, checkout.reservation_minutes). Real local D1.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type Actor } from "~/server/actor";
import { encryptSecret } from "~/server/crypto.server";
import {
  auditEvents,
  coupons,
  customers,
  digitalCodes,
  files,
  flashSaleItems,
  flashSales,
  giftCards,
  journalEntries,
  loyaltyLedger,
  membershipTiers,
  memberships,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  promotions,
  referralCodes,
  referralRedemptions,
  serials,
  stockLevels,
  stockReservations,
  walletLedger,
  warranties,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { setSetting } from "~/server/settings.server";
import { mergeCustomers, planMerge } from "~/server/services/admin/customers/merge.server";
import { createPrivacyRequest } from "~/server/services/admin/customers/privacy.server";
import { giftCodeHash, redeemGiftCard } from "~/server/services/admin/promotions/giftcards.server";
import { issueReferralCode } from "~/server/services/admin/promotions/referrals.server";
import { addToCart, getCartView, optionValueOf } from "~/server/services/cart.server";
import { releaseSoldSerialStatements } from "~/server/services/inventory/stock.server";
import { revealOrderCode } from "~/server/services/orders/digital.server";
import { getOrderByAccessToken, transitionOrder } from "~/server/services/orders/manage.server";
import { CheckoutError, placeOrder, type CheckoutInput, type CheckoutWho } from "~/server/services/orders/place.server";
import { applyDiscounts, flashLineCap, restoredPointsFor } from "~/server/services/orders/promotions";
import { submitPaymentProof, verifyPayment } from "~/server/services/payments/payments.server";
import { approveRefund, createRefund } from "~/server/services/refunds.server";
import { creditWallet, decideWalletPayout, getWalletBalance, requestWalletPayout, walletTransferStatements } from "~/server/services/wallet.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BAGHDAD = governorateId("baghdad");

let t: TestDb;
let make: Fixtures;
let staffId: string;
let otherStaffId: string;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  staffId = await make.employee();
  otherStaffId = await make.employee();
});
afterAll(async () => {
  await t.dispose();
});

const ALL: Permission[] = [
  "orders.order.update",
  "orders.order.cancel",
  "orders.fulfillment.pack",
  "orders.fulfillment.ship",
  "orders.fulfillment.deliver",
  "orders.payment.record",
  "orders.payment.verify",
  "orders.refund.create",
  "orders.refund.approve",
  "customers.wallet.adjust",
  "customers.customer.merge",
  "customers.customer.read",
  "customers.wallet.read",
  "devices.tradein.payout",
];
const staff = (id = staffId, permissions: Permission[] = ALL): Actor => ({ kind: "employee", id, permissions: new Set(permissions) });

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

async function cartWith(lines: { variantId: string; qty: number }[], customerId: string | null = null): Promise<string> {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "en" }, { variantId: line.variantId, qty: line.qty }, NOW)).cartToken;
  return token as string;
}

function who(cartToken: string | null, customerId: string | null = null): CheckoutWho {
  return { cartToken, customer: customerId ? { id: customerId } : null, locale: "en", ip: null, storeMode: "live" };
}

async function input(cartToken: string, overrides: Partial<CheckoutInput> = {}, customerId: string | null = null): Promise<CheckoutInput> {
  const view = await getCartView(t.db, { cartToken, customerId, locale: "en", governorateId: BAGHDAD, redeemPoints: overrides.redeemPoints ?? 0, referralCode: overrides.referralCode ?? null }, NOW);
  return {
    idempotencyKey: randomToken(),
    phone: make.phone(),
    governorateId: BAGHDAD,
    districtId: districtId("baghdad", "karrada"),
    areaText: "الكرادة داخل",
    addressText: "شارع 62، قرب الجسر المعلق، عمارة 4",
    marketingConsent: false,
    paymentMethod: "cod",
    expectedTotalIqd: view.totalIqd,
    ...overrides,
  };
}

async function orderOf(orderId: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!row) throw new Error("order missing");
  return row;
}

async function flashSale(variantId: string, options: { salePriceIqd: number; qtyLimit?: number | null; perCustomerLimit?: number | null; isDemo?: boolean }) {
  const saleId = newId("fls");
  const itemId = newId("fli");
  await runBatch(t.db, [
    t.db.insert(flashSales).values({ id: saleId, slug: `sale-${saleId}`, name: { ar: "عرض الجمعة", en: "Friday deal" }, startsAt: NOW - HOUR, endsAt: NOW + DAY, status: "scheduled", isDemo: options.isDemo ?? false, createdAt: NOW - DAY }),
    t.db.insert(flashSaleItems).values({ id: itemId, flashSaleId: saleId, variantId, salePriceIqd: options.salePriceIqd, qtyLimit: options.qtyLimit ?? null, qtySold: 0, perCustomerLimit: options.perCustomerLimit ?? null }),
  ]);
  return { saleId, itemId };
}

const qtySold = async (itemId: string) => (await t.db.select({ n: flashSaleItems.qtySold }).from(flashSaleItems).where(eq(flashSaleItems.id, itemId)).get())?.n;
const points = async (customerId: string) => Number((await t.db.select({ n: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)` }).from(loyaltyLedger).where(eq(loyaltyLedger.customerId, customerId)).get())?.n ?? 0);

async function rule(values: Partial<typeof promotions.$inferInsert> & Pick<typeof promotions.$inferInsert, "kind">) {
  const id = newId("prm");
  await t.db.insert(promotions).values({ id, name: { ar: "عرض تلقائي", en: "Automatic deal" }, isActive: true, createdAt: NOW - DAY, updatedAt: NOW - DAY, priority: 0, stackable: false, ...values });
  return id;
}

async function coupon(code: string, values: Partial<typeof coupons.$inferInsert> = {}) {
  const id = newId("cpn");
  await t.db.insert(coupons).values({ id, code, kind: "fixed", value: 10_000, isActive: true, createdAt: NOW - DAY, ...values });
  return id;
}

async function member(customerId: string, benefits: { discountBps?: number; freeShipping?: boolean }) {
  const tierId = newId("tier");
  const membershipId = newId("mbr");
  await runBatch(t.db, [
    t.db.insert(membershipTiers).values({ id: tierId, key: `gold-${tierId}`, name: { ar: "ذهبي", en: "Gold" }, benefits, isActive: true }),
    t.db.insert(memberships).values({ id: membershipId, customerId, tierId, status: "active", startsAt: NOW - DAY, endsAt: NOW + 30 * DAY, source: "grant", createdAt: NOW - DAY }),
  ]);
  return { tierId, membershipId };
}

async function earnPoints(customerId: string, n: number) {
  await t.db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId, points: n, kind: "earn", refType: "test", refId: null, reason: "test", expiresAt: NOW + 300 * DAY, actorKind: "system", actorId: "test", idempotencyKey: `test:${randomToken()}`, at: NOW - DAY });
}

async function proofFile(): Promise<string> {
  const id = newId("fil");
  await t.db.insert(files).values({ id, storageKey: `prv/${id}.jpg`, visibility: "private", kind: "payment_proof", mime: "image/jpeg", bytes: 40_000, sha256: randomToken().toLowerCase(), createdAt: NOW });
  return id;
}

async function promotionsRecord(orderId: string) {
  return (await t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.kind, "promotions"))).get())?.data as Record<string, unknown> | undefined;
}

// ───────────────────────────────────────────────────────────────── the pure rules

describe("promotions — the pure rules", () => {
  test("flashLineCap: the allowance left and the shopper's limit; a demo sale prices demo goods only; a sale price must be lower", () => {
    const offer = { itemId: "i", saleId: "s", label: "x", salePriceIqd: 80, left: 3, perCustomerLeft: 2, perCustomerLimit: 2, endsAt: 1, isDemo: false };
    expect(flashLineCap(offer, 100, false)).toBe(2);
    expect(flashLineCap({ ...offer, perCustomerLeft: null }, 100, false)).toBe(3);
    expect(flashLineCap({ ...offer, left: 0 }, 100, false)).toBe(0);
    expect(flashLineCap({ ...offer, isDemo: true }, 100, false)).toBe(0);
    expect(flashLineCap({ ...offer, isDemo: true }, 100, true)).toBe(2);
    expect(flashLineCap({ ...offer, salePriceIqd: 100 }, 100, false)).toBe(0);
    expect(flashLineCap(null, 100, false)).toBe(0);
  });

  test("applyDiscounts: stackable rules with the coupon, a better non-stackable rule alone, the member within the limits, points within the goods, free delivery", () => {
    const line = { lineId: "l", variantId: "v", productId: "p", platformId: null, categoryChain: [], kind: "console", isDemo: false, qty: 1, unitPriceIqd: 100_000 };
    const terms = (over: Record<string, unknown>) => ({ kind: "percent" as const, value: 1_000, tiers: [], bogo: null, maxDiscountIqd: null, stackable: true, priority: 0, startsAt: null, endsAt: null, scope: { platformIds: [], categoryIds: [], productKinds: [], segmentIds: [], channels: [], minSubtotalIqd: null, minQty: null }, ...over });
    const base = { lines: [line], subtotalIqd: 100_000, shippingFeeIqd: 5_000, segmentIds: new Set<string>(), limits: { percentBps: 2_000, perOrderIqd: 50_000 }, now: NOW, member: null, points: null };
    // a stackable 10 % with a 5,000 coupon: both
    const stacked = applyDiscounts({ ...base, coupon: { couponId: "c", code: "SAVE", label: "SAVE", discountIqd: 5_000 }, rules: [{ id: "r1", label: "10%", isDemo: false, terms: terms({}) }] });
    expect(stacked.discounts.map((entry) => [entry.kind, entry.amountIqd])).toEqual([["rule", 10_000], ["coupon", 5_000]]);
    expect(stacked.discountIqd).toBe(15_000);
    // a non-stackable 20 % beats rules+coupon (15,000): alone, and the coupon is said to be dropped
    const single = applyDiscounts({ ...base, coupon: { couponId: "c", code: "SAVE", label: "SAVE", discountIqd: 5_000 }, rules: [{ id: "r1", label: "10%", isDemo: false, terms: terms({}) }, { id: "r2", label: "20%", isDemo: false, terms: terms({ value: 2_000, stackable: false }) }] });
    expect(single.discounts.map((entry) => [entry.kind, entry.amountIqd])).toEqual([["rule", 20_000]]);
    expect(single.couponDropped).toEqual({ ruleLabel: "20%" });
    expect(single.coupon).toBeNull();
    // a member's 30 % is applied within the limit in force (20 %), on what the rules left; points never past the goods
    const vip = applyDiscounts({ ...base, coupon: null, rules: [], member: { membershipId: "m", tierId: "t", label: "Gold", discountBps: 3_000, freeShipping: true }, points: { balance: 100_000, pointValueIqd: 10, requested: 100_000 } });
    expect(vip.discounts.map((entry) => [entry.kind, entry.amountIqd])).toEqual([["member", 20_000], ["points", 80_000]]);
    expect(vip.pointsUsed).toBe(8_000);
    expect(vip.discountIqd).toBe(100_000);
    expect(vip.shippingIqd).toBe(0);
    expect(vip.shippingWaiver).toMatchObject({ by: "member", feeIqd: 5_000, waivedIqd: 5_000 });
    // a demo rule never discounts real goods
    expect(applyDiscounts({ ...base, coupon: null, rules: [{ id: "d", label: "demo", isDemo: true, terms: terms({}) }] }).discountIqd).toBe(0);
  });

  test("restoredPointsFor: a refund's share of the redeemed points, all with the last of the money, never more than is left", () => {
    expect(restoredPointsFor({ redeemedPoints: 1_000, restoredSoFar: 0, refundIqd: 45_000, paidIqd: 90_000, full: false })).toBe(500);
    expect(restoredPointsFor({ redeemedPoints: 1_000, restoredSoFar: 500, refundIqd: 45_000, paidIqd: 90_000, full: true })).toBe(500);
    expect(restoredPointsFor({ redeemedPoints: 1_000, restoredSoFar: 1_000, refundIqd: 1, paidIqd: 90_000, full: true })).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── flash sales

describe("flash prices at checkout", () => {
  test("the sale's price while its allowance and the shopper's limit cover the line; placeOrder claims the units; the next shopper sees what is left", async () => {
    const product = await make.product({ priceIqd: 100_000, stock: 10 });
    const sale = await flashSale(product.variantId, { salePriceIqd: 80_000, qtyLimit: 3, perCustomerLimit: 2 });
    // three asked; the line holds the two the shopper's limit covers (the cart stores what it can sell)
    const token = await cartWith([{ variantId: product.variantId, qty: 3 }]);
    const view = await getCartView(t.db, { cartToken: token, customerId: null, locale: "en", governorateId: BAGHDAD }, NOW);
    const line = view.lines[0]!;
    expect(line).toMatchObject({ unitPriceIqd: 80_000, qty: 2, maxQty: 2, problem: null, productId: product.productId });
    expect(line.flash).toMatchObject({ salePriceIqd: 80_000, regularPriceIqd: 100_000, label: "Friday deal", cap: 2 });
    expect(view.totalIqd).toBe(165_000);

    const phone = make.phone();
    const placed = await placeOrder(t.db, who(token), await input(token, { phone }), NOW);
    const items = await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
    expect(items.map((item) => [item.unitPriceIqd, item.qty, item.totalIqd])).toEqual([[80_000, 2, 160_000]]);
    expect(await qtySold(sale.itemId)).toBe(2);
    const record = await promotionsRecord(placed.orderId);
    expect(record?.flash).toEqual([expect.objectContaining({ itemId: sale.itemId, units: 2, salePriceIqd: 80_000, regularPriceIqd: 100_000, orderItemId: items[0]!.id })]);

    // the same number again: its limit is used up — the regular price
    const again = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const sameNumber = await placeOrder(t.db, who(again), await input(again, { phone, expectedTotalIqd: 105_000 }), NOW);
    expect((await t.db.select().from(orderItems).where(eq(orderItems.orderId, sameNumber.orderId)).get())?.unitPriceIqd).toBe(100_000);
    // another shopper: one unit is left in the allowance
    const other = await cartWith([{ variantId: product.variantId, qty: 2 }]);
    expect((await getCartView(t.db, { cartToken: other, customerId: null, locale: "en" }, NOW)).lines[0]).toMatchObject({ qty: 1, unitPriceIqd: 80_000 });
  });

  test("never above the allowance: two carts priced while one unit was left — the second order is refused with totals_changed, and a cancellation gives the units back", async () => {
    const product = await make.product({ priceIqd: 200_000, stock: 10 });
    const sale = await flashSale(product.variantId, { salePriceIqd: 150_000, qtyLimit: 1 });
    const first = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const second = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const firstInput = await input(first);
    const secondInput = await input(second);
    expect(secondInput.expectedTotalIqd).toBe(155_000);
    const placed = await placeOrder(t.db, who(first), firstInput, NOW);
    const refused = await failureOf(placeOrder(t.db, who(second), secondInput, NOW));
    expect(refused.code).toBe("totals_changed");
    expect((refused as CheckoutError).cart?.lines[0]?.unitPriceIqd).toBe(200_000);
    expect(await qtySold(sale.itemId)).toBe(1);

    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون" }, NOW + HOUR);
    expect(await qtySold(sale.itemId)).toBe(0);
    expect((await getCartView(t.db, { cartToken: second, customerId: null, locale: "en" }, NOW + 2 * HOUR)).lines[0]?.unitPriceIqd).toBe(150_000);
  });
});

// ───────────────────────────────────────────────────────────────── rules, coupon, membership, points, referral

describe("discounts at checkout", () => {
  // the rules of this block apply to headsets only (the other tests' goods are consoles and digital codes)
  const HEADSETS = { productKinds: ["headset"] };
  afterEach(async () => {
    await t.db.update(promotions).set({ isActive: false });
  });

  test("module 08's rules: a stackable rule adds to the coupon, a better non-stackable rule drops it (not_combinable), a free-delivery rule waives the fee; the order records each as charged", async () => {
    const product = await make.product({ kind: "headset", priceIqd: 400_000, stock: 10 });
    const ruleId = await rule({ kind: "percent", value: 500, stackable: true, priority: 5, scope: HEADSETS });
    const shipId = await rule({ kind: "free_shipping", stackable: true, scope: HEADSETS });
    await coupon("STACK10", { value: 10_000 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const { applyCoupon } = await import("~/server/services/cart.server");
    const view = await applyCoupon(t.db, { cartToken: token, customerId: null, locale: "en", governorateId: BAGHDAD }, "stack10", NOW);
    expect(view.discounts).toEqual([
      expect.objectContaining({ kind: "rule", amountIqd: 20_000 }),
      expect.objectContaining({ kind: "coupon", code: "STACK10", amountIqd: 10_000 }),
    ]);
    expect(view.discountIqd).toBe(30_000);
    expect(view.shippingWaiver).toMatchObject({ by: "rule", feeIqd: 5_000, waivedIqd: 5_000 });
    expect(view.shippingIqd).toBe(0);
    expect(view.totalIqd).toBe(370_000);

    const placed = await placeOrder(t.db, who(token), await input(token), NOW);
    const order = await orderOf(placed.orderId);
    expect(order).toMatchObject({ subtotalIqd: 400_000, discountIqd: 30_000, shippingIqd: 0, totalIqd: 370_000, couponCode: "STACK10" });
    const record = await promotionsRecord(placed.orderId);
    expect(record?.discounts).toEqual([expect.objectContaining({ kind: "rule", ruleId, amountIqd: 20_000 }), expect.objectContaining({ kind: "coupon", code: "STACK10", amountIqd: 10_000 })]);
    expect(record?.shipping).toMatchObject({ by: "rule", ruleId: shipId, waivedIqd: 5_000 });
    // the order page shows the same lines (OrderView.adjustments)
    const viewed = await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW);
    expect(viewed?.adjustments?.discounts.map((entry) => [entry.kind, entry.amountIqd])).toEqual([["rule", 20_000], ["coupon", 10_000]]);
    expect(viewed?.adjustments?.shippingWaiver).toMatchObject({ waivedIqd: 5_000 });

    // a better non-stackable rule: the coupon is kept on the cart but not applied, and said so
    await rule({ kind: "percent", value: 2_000, stackable: false, priority: 1, scope: HEADSETS });
    const other = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const dropped = await applyCoupon(t.db, { cartToken: other, customerId: null, locale: "en" }, "STACK10", NOW);
    expect(dropped.coupon).toBeNull();
    expect(dropped.couponIssue).toMatchObject({ code: "STACK10", reason: "not_combinable" });
    expect(dropped.discounts.map((entry) => [entry.kind, entry.amountIqd])).toEqual([["rule", 80_000]]);
  });

  test("a VIP member gets the tier's discount — within the store's limits — and free delivery", async () => {
    const product = await make.product({ priceIqd: 300_000, stock: 5 });
    const customerId = await make.customer();
    await member(customerId, { discountBps: 3_000, freeShipping: true });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const view = await getCartView(t.db, { cartToken: token, customerId, locale: "en", governorateId: BAGHDAD }, NOW);
    // 30 % asked by the tier, 20 % applied (promotions.discount_limits: 20 %, 50,000 per order)
    expect(view.discounts).toEqual([expect.objectContaining({ kind: "member", label: "Gold", bps: 2_000, amountIqd: 50_000 })]);
    expect(view.shippingIqd).toBe(0);
    expect(view.totalIqd).toBe(250_000);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, {}, customerId), NOW);
    expect(await orderOf(placed.orderId)).toMatchObject({ discountIqd: 50_000, shippingIqd: 0, totalIqd: 250_000 });
    expect((await promotionsRecord(placed.orderId))?.shipping).toMatchObject({ by: "member", waivedIqd: 5_000 });
  });

  test("points: redeemed by signed-in customers, never more than the balance, a 'redeem' row in the order batch; cancelling gives them back", async () => {
    const product = await make.product({ priceIqd: 100_000, stock: 5 });
    const customerId = await make.customer();
    await earnPoints(customerId, 1_500);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const view = await getCartView(t.db, { cartToken: token, customerId, locale: "en", governorateId: BAGHDAD, redeemPoints: 5_000 }, NOW);
    expect(view.points).toEqual({ balance: 1_500, pointValueIqd: 10, used: 1_500, max: 1_500 });
    expect(view.discounts).toEqual([{ kind: "points", points: 1_500, amountIqd: 15_000 }]);
    // a guest asking for points gets none
    expect((await getCartView(t.db, { cartToken: token, customerId: null, locale: "en", redeemPoints: 10 }, NOW)).points).toBeNull();
    expect((await failureOf(placeOrder(t.db, who(token), await input(token, { redeemPoints: 10 }), NOW))).code).toBe("points_requires_account");

    const body = await input(token, { redeemPoints: 1_500 }, customerId);
    expect(body.expectedTotalIqd).toBe(90_000);
    // points spent meanwhile: the order is priced again with what is left — the total moved (the overdraft trigger
    // holds the same line inside the batch, for a spend that lands between the pricing and the write)
    await t.db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId, points: -1_000, kind: "adjust", refType: "manual", refId: null, reason: "test", actorKind: "system", actorId: "test", idempotencyKey: `test:${randomToken()}`, at: NOW });
    const moved = await failureOf(placeOrder(t.db, who(token, customerId), body, NOW));
    expect(moved.code).toBe("totals_changed");
    expect((moved as CheckoutError).cart?.points).toMatchObject({ balance: 500, used: 500 });
    await t.db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId, points: 1_000, kind: "adjust", refType: "manual", refId: null, reason: "test", actorKind: "system", actorId: "test", idempotencyKey: `test:${randomToken()}`, at: NOW });
    const placed = await placeOrder(t.db, who(token, customerId), { ...body, idempotencyKey: randomToken() }, NOW);
    expect(await points(customerId)).toBe(0);
    expect(await orderOf(placed.orderId)).toMatchObject({ discountIqd: 15_000, totalIqd: 90_000 });
    expect(await t.db.select().from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, `loyalty:redeem:${placed.orderId}`)).get()).toMatchObject({ points: -1_500, kind: "redeem", refType: "order", refId: placed.orderId });

    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون" }, NOW + HOUR);
    expect(await points(customerId)).toBe(1_500);
    // cancelling twice gives nothing twice (the transition is a no-op; the row's key is unique)
    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون" }, NOW + 2 * HOUR);
    expect(await points(customerId)).toBe(1_500);
  });

  test("two orders spending the same points at once: one of them, the other is refused (points_insufficient) and writes nothing", async () => {
    const product = await make.product({ priceIqd: 100_000, stock: 10 });
    const customerId = await make.customer();
    await earnPoints(customerId, 1_000);
    // two carts on two devices (each a guest cart until it is ordered), both priced with the whole balance
    const first = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const second = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const [a, b] = await Promise.all([input(first, { redeemPoints: 1_000 }, customerId), input(second, { redeemPoints: 1_000 }, customerId)]);
    expect(a.expectedTotalIqd).toBe(95_000);
    const results = await Promise.allSettled([placeOrder(t.db, who(first, customerId), a, NOW), placeOrder(t.db, who(second, customerId), b, NOW)]);
    const codes = results.map((result) => (result.status === "fulfilled" ? "placed" : toAppError(result.reason)?.code)).sort();
    // the loser met the overdraft trigger inside its batch (points_insufficient) — or, when it priced after the winner
    // wrote, saw the points gone (totals_changed); either way exactly one order spent them
    expect(codes[0]).toBe("placed");
    expect(["points_insufficient", "totals_changed"]).toContain(codes[1]);
    expect(await points(customerId)).toBe(0);
    expect(Number((await t.db.select({ n: sql<number>`count(*)` }).from(loyaltyLedger).where(and(eq(loyaltyLedger.customerId, customerId), eq(loyaltyLedger.kind, "redeem"))).get())?.n)).toBe(1);
  });

  test("a refund after points gives back its share — and never more than was paid", async () => {
    const product = await make.product({ priceIqd: 100_000, stock: 5 });
    const customerId = await make.customer();
    await earnPoints(customerId, 1_000);
    await creditWallet(t.db, staff(), { customerId, amountIqd: 200_000, kind: "adjustment", reason: "اختبار", idempotencyKey: `test:${randomToken()}` }, NOW);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const body = await input(token, { redeemPoints: 1_000, paymentMethod: "wallet" }, customerId);
    expect(body.expectedTotalIqd).toBe(95_000);
    const placed = await placeOrder(t.db, who(token, customerId), body, NOW);
    const payment = await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId)).get();
    // more than was paid: refused by the database's bound, whatever the discount
    expect((await failureOf(createRefund(t.db, staff(), { orderId: placed.orderId, paymentId: payment!.id, amountIqd: 100_000, method: "wallet", reason: "اختبار" }, NOW))).code).toBe("refund_exceeds_payment");
    const half = await createRefund(t.db, staff(), { orderId: placed.orderId, paymentId: payment!.id, amountIqd: 47_500, method: "wallet", reason: "نصف الطلب" }, NOW);
    await approveRefund(t.db, staff(otherStaffId), half.refundId, { approve: true }, NOW);
    expect(await points(customerId)).toBe(500);
    const rest = await createRefund(t.db, staff(), { orderId: placed.orderId, paymentId: payment!.id, amountIqd: 47_500, method: "wallet", reason: "الباقي" }, NOW);
    await approveRefund(t.db, staff(otherStaffId), rest.refundId, { approve: true }, NOW);
    expect(await points(customerId)).toBe(1_000);
  });

  test("a referral code typed at checkout is recorded with the order; the shopper's own code and an unknown one are refused on their field", async () => {
    const product = await make.product({ priceIqd: 50_000, stock: 5 });
    const referrer = await make.customer();
    const code = await issueReferralCode(t.db, { kind: "customer", id: referrer }, { customerId: referrer }, NOW);
    expect(code.code).toMatch(/^[A-Z2-9]{6,}$/);
    // a customer asks only for their own code
    expect((await failureOf(issueReferralCode(t.db, { kind: "customer", id: referrer }, { customerId: await make.customer() }, NOW))).code).toBe("forbidden");

    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const unknown = await failureOf(placeOrder(t.db, who(token), await input(token, { referralCode: "NOPE-0000" }), NOW));
    expect(unknown).toMatchObject({ code: "referral_code_unknown", fields: { referralCode: "referral_code_unknown" } });
    const self = await failureOf(placeOrder(t.db, who(token, referrer), await input(token, { referralCode: code.code }, referrer), NOW));
    expect(self.fields).toEqual({ referralCode: "referral_self" });

    const phone = make.phone();
    const placed = await placeOrder(t.db, who(token), await input(token, { referralCode: code.code.toLowerCase(), phone }), NOW);
    expect(await t.db.select().from(referralRedemptions).where(eq(referralRedemptions.orderId, placed.orderId)).get()).toMatchObject({ referredPhoneE164: phone, status: "pending" });
    expect((await t.db.select().from(referralCodes).where(eq(referralCodes.code, code.code)).get())?.uses).toBe(1);
    expect((await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW))?.adjustments?.referralCode).toBe(code.code);
  });
});

// ───────────────────────────────────────────────────────────────── gift cards and the wallet

describe("gift cards and the wallet", () => {
  test("a customer redeems a card into their own wallet through the module's guarded redemption, then pays with it; never twice, never into another wallet", async () => {
    const customerId = await make.customer();
    const code = "GIFT-ABCD-2345-6789";
    const cardId = newId("gfc");
    await t.db.insert(giftCards).values({ id: cardId, codeHash: await giftCodeHash(code), codeHint: "6789", amountIqd: 60_000, status: "active", createdAt: NOW - DAY });
    const me: Actor = { kind: "customer", id: customerId };
    expect((await failureOf(redeemGiftCard(t.db, me, { code, customerId: await make.customer(), idempotencyKey: randomToken() }, NOW))).code).toBe("forbidden");
    const redeemed = await redeemGiftCard(t.db, me, { code, customerId, idempotencyKey: randomToken() }, NOW);
    expect(redeemed).toMatchObject({ cardId, amountIqd: 60_000, replayed: false });
    expect(await getWalletBalance(t.db, customerId)).toBe(60_000);
    expect((await failureOf(redeemGiftCard(t.db, me, { code, customerId, idempotencyKey: randomToken() }, NOW))).code).toBe("gift_card_used");

    const product = await make.product({ priceIqd: 55_000, stock: 2 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW);
    expect(placed.paymentStatus).toBe("paid");
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
  });

  test("a split payment: part from the wallet (trade-in store credit included), the rest cash on delivery or by transfer", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, staff(), { customerId, amountIqd: 120_000, kind: "trade_in_credit", reason: "استبدال جهاز", idempotencyKey: `test:${randomToken()}` }, NOW);
    const product = await make.product({ priceIqd: 300_000, stock: 5 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    // a guest cannot split; the wallet part must be below the total
    expect((await failureOf(placeOrder(t.db, who(token), await input(token, { walletIqd: 1_000 }), NOW))).code).toBe("wallet_requires_account");
    expect((await failureOf(placeOrder(t.db, who(token, customerId), await input(token, { walletIqd: 305_000 }, customerId), NOW))).fields).toEqual({ walletIqd: "wallet_split_invalid" });
    expect((await failureOf(placeOrder(t.db, who(token, customerId), await input(token, { walletIqd: 150_000 }, customerId), NOW))).code).toBe("wallet_insufficient");

    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { walletIqd: 120_000 }, customerId), NOW);
    expect(placed.paymentStatus).toBe("cod_due");
    const order = await orderOf(placed.orderId);
    expect(order).toMatchObject({ status: "new", paymentMethod: "cod", paidIqd: 120_000, totalIqd: 305_000 });
    const rows = await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    expect(rows.map((row) => [row.method, row.status, row.amountIqd]).sort()).toEqual([["cod", "pending", 185_000], ["wallet", "paid", 120_000]]);
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `payment:${rows.find((row) => row.method === "wallet")!.id}:received`)).get()).toBeDefined();
    const viewed = await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW);
    expect(viewed?.walletPaidIqd).toBe(120_000);
    expect(viewed?.payment.amountDueIqd).toBe(185_000);

    // a transfer split: the proof covers the rest; verifying it pays the order in full
    await creditWallet(t.db, staff(), { customerId, amountIqd: 50_000, kind: "topup", reason: "شحن", idempotencyKey: `test:${randomToken()}` }, NOW);
    const second = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const transfer = await placeOrder(t.db, who(second, customerId), await input(second, { walletIqd: 50_000, paymentMethod: "bank_transfer" }, customerId), NOW);
    expect(transfer.paymentStatus).toBe("unpaid");
    const due = (await getOrderByAccessToken(t.db, transfer.ref, transfer.accessToken, "en", NOW))?.payment.amountDueIqd;
    expect(due).toBe(255_000);
    await submitPaymentProof(t.db, { orderRef: transfer.ref, customerId }, { fileId: await proofFile(), declaredAmountIqd: 255_000 }, NOW + HOUR);
    const pay = (await t.db.select().from(payments).where(and(eq(payments.orderId, transfer.orderId), eq(payments.method, "bank_transfer"))).get())!;
    await verifyPayment(t.db, staff(otherStaffId, ["orders.payment.verify"]), pay.id, { approve: true }, NOW + 2 * HOUR);
    expect(await orderOf(transfer.orderId)).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidIqd: 305_000 });

    // a cancelled split order: the wallet part waits as a pending refund (the core's refund path)
    const third = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    await creditWallet(t.db, staff(), { customerId, amountIqd: 10_000, kind: "topup", reason: "شحن", idempotencyKey: `test:${randomToken()}` }, NOW);
    const cancelled = await placeOrder(t.db, who(third, customerId), await input(third, { walletIqd: 10_000 }, customerId), NOW);
    await transitionOrder(t.db, staff(), cancelled.orderId, "cancelled", { reason: "طلب الزبون" }, NOW + HOUR);
    expect((await t.db.select().from(payments).where(eq(payments.orderId, cancelled.orderId))).map((row) => [row.method, row.status]).sort()).toEqual([["cod", "cancelled"], ["wallet", "paid"]]);
  });

  test("a transfer between two wallets (module 07's merge): the duplicate's money moves, the duplicate is left at exactly 0", async () => {
    const keep = await make.customer({ email: "same@tamtam.test" });
    const dup = await make.customer({ email: "same@tamtam.test" });
    await creditWallet(t.db, staff(), { customerId: dup, amountIqd: 7_350, kind: "adjustment", reason: "تعويض", idempotencyKey: `test:${randomToken()}` }, NOW);
    // the builder refuses the same wallet twice, and an overdraft is the trigger's
    expect(() => walletTransferStatements(t.db, { transferId: "x", fromCustomerId: keep, toCustomerId: keep, amountIqd: 1, reason: "x", actor: staff(), now: NOW })).toThrow();
    expect(mapCode(await failureOf(runBatch(t.db, walletTransferStatements(t.db, { transferId: "too-much", fromCustomerId: dup, toCustomerId: keep, amountIqd: 9_000, reason: "x", actor: staff(), now: NOW }))))).toBeTruthy();

    const plan = await planMerge(t.db, staff(), { keepId: keep, mergeId: dup }, NOW);
    expect(plan.blockers).toEqual([]);
    await mergeCustomers(t.db, staff(), { keepId: keep, mergeId: dup, method: "call_both_numbers", verification: "اتصلت بالرقمين وأكد صاحبهما", reason: "حساب مكرر", fingerprint: plan.fingerprint }, NOW);
    expect(await getWalletBalance(t.db, dup)).toBe(0);
    expect(await getWalletBalance(t.db, keep)).toBe(7_350);
    const rows = await t.db.select().from(walletLedger).where(eq(walletLedger.refType, "wallet_transfer"));
    expect(rows.filter((row) => row.refId === `merge:${dup}`).map((row) => [row.customerId === dup ? "dup" : "keep", row.amountIqd]).sort()).toEqual([["dup", -7_350], ["keep", 7_350]]);
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "customers.wallet.transfer"), eq(auditEvents.entityId, keep))).get()).toBeDefined();
  });

  test("a payout needs a reason and a second person (module 07's erasure): asked by one, paid by another, posted, the wallet emptied", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, staff(), { customerId, amountIqd: 25_000, kind: "adjustment", reason: "تعويض", idempotencyKey: `test:${randomToken()}` }, NOW);
    const asked = await requestWalletPayout(t.db, staff(), { customerId, amountIqd: 25_000, method: "cash", reason: "طلب حذف الحساب", idempotencyKey: randomToken() }, NOW);
    expect((await failureOf(requestWalletPayout(t.db, staff(), { customerId, amountIqd: 1_000, method: "cash", reason: "مرة ثانية", idempotencyKey: randomToken() }, NOW))).code).toBe("wallet_payout_pending");
    expect((await failureOf(decideWalletPayout(t.db, staff(), { approvalId: asked.approvalId, approve: true }, NOW))).code).toBe("approver_is_requester");
    const paid = await decideWalletPayout(t.db, staff(otherStaffId), { approvalId: asked.approvalId, approve: true }, NOW);
    expect(paid).toMatchObject({ status: "paid", replayed: false });
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    const entry = await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, `wallet_payout:${asked.approvalId}`)).get();
    expect(entry).toMatchObject({ amountIqd: -25_000, kind: "adjustment", refType: "wallet_payout" });
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `wallet:${entry!.id}`)).get()).toBeDefined();
    expect(await decideWalletPayout(t.db, staff(otherStaffId), { approvalId: asked.approvalId, approve: true }, NOW)).toMatchObject({ status: "paid", replayed: true });
    // a bank transfer needs its reference; a payout above the balance is refused when it is asked
    await creditWallet(t.db, staff(), { customerId, amountIqd: 5_000, kind: "adjustment", reason: "تعويض", idempotencyKey: `test:${randomToken()}` }, NOW);
    expect((await failureOf(requestWalletPayout(t.db, staff(), { customerId, amountIqd: 6_000, method: "cash", reason: "أكثر من الرصيد", idempotencyKey: randomToken() }, NOW))).code).toBe("wallet_insufficient");
    const bank = await requestWalletPayout(t.db, staff(), { customerId, amountIqd: 5_000, method: "bank_transfer", reason: "تحويل للزبون", idempotencyKey: randomToken() }, NOW);
    expect((await failureOf(decideWalletPayout(t.db, staff(otherStaffId), { approvalId: bank.approvalId, approve: true }, NOW))).fields).toEqual({ reference: "reference_required" });
    await decideWalletPayout(t.db, staff(otherStaffId), { approvalId: bank.approvalId, approve: true, reference: "TRX-555" }, NOW);
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
  });

  test("a customer files a privacy request for their own account (module 07's service), never for someone else's", async () => {
    const customerId = await make.customer();
    const me: Actor = { kind: "customer", id: customerId };
    const opened = await createPrivacyRequest(t.db, me, { customerId, kind: "export", idempotencyKey: `acct:${customerId}:${randomToken()}` }, NOW);
    expect(opened.ref).toMatch(/^PR-/);
    expect((await failureOf(createPrivacyRequest(t.db, me, { customerId: await make.customer(), kind: "delete", idempotencyKey: randomToken() }, NOW))).code).toBe("forbidden");
    expect((await failureOf(createPrivacyRequest(t.db, me, { phone: "07701234567", kind: "delete", idempotencyKey: randomToken() }, NOW))).code).toBe("forbidden");
  });
});

function mapCode(error: AppError | unknown): string | null {
  const appError = toAppError(error);
  return appError?.code ?? (error instanceof Error ? error.message : null);
}

// ───────────────────────────────────────────────────────────────── digital codes

describe("digital codes of paid orders", () => {
  async function digitalProduct(codes: string[], options: { isDemo?: boolean } = {}) {
    const product = await make.product({ kind: "digital", priceIqd: 25_000, stock: 10 });
    for (const code of codes) {
      const id = newId("dgc");
      await t.db.insert(digitalCodes).values({ id, variantId: product.variantId, codeEnc: await encryptSecret(code, TEST_VARS.DATA_KEY, `digital_code:${id}`), codeHash: randomToken(), status: "available", isDemo: options.isDemo ?? false, createdAt: NOW - DAY });
    }
    return product;
  }

  test("a wallet-paid digital line gets one code per unit in the order batch; the buyer reveals it with the order's token (audited); a refund revokes it", async () => {
    const product = await digitalProduct(["PSN-AAAA-1111", "PSN-BBBB-2222", "PSN-CCCC-3333"]);
    const customerId = await make.customer();
    await creditWallet(t.db, staff(), { customerId, amountIqd: 100_000, kind: "topup", reason: "شحن", idempotencyKey: `test:${randomToken()}` }, NOW);
    const token = await cartWith([{ variantId: product.variantId, qty: 2 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW);
    const view = await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW);
    expect(view?.digital).toHaveLength(1);
    const line = view!.digital![0]!;
    expect(line.codes.map((code) => code.status)).toEqual(["delivered", "delivered"]);
    expect(line.pending).toBe(0);
    expect(JSON.stringify(view)).not.toContain("PSN-");

    const order = await orderOf(placed.orderId);
    const shown = await revealOrderCode(t.db, TEST_VARS.DATA_KEY, { order, codeId: line.codes[0]!.id, actor: { kind: "customer", id: customerId } }, NOW);
    expect(shown.code).toMatch(/^PSN-/);
    expect((await t.db.select().from(digitalCodes).where(eq(digitalCodes.id, line.codes[0]!.id)).get())?.revealedAt).toBe(NOW);
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "orders.digital_code.reveal"), eq(auditEvents.entityId, line.codes[0]!.id))).get()).toBeDefined();
    // another order's code is the same 404 as none
    const other = { id: newId("ord"), ref: "TT-OTHER234" };
    expect((await failureOf(revealOrderCode(t.db, TEST_VARS.DATA_KEY, { order: other, codeId: line.codes[0]!.id, actor: { kind: "guest" } }, NOW))).code).toBe("not_found");

    const item = (await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId)).get())!;
    const payment = (await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId)).get())!;
    const refund = await createRefund(t.db, staff(), { orderId: placed.orderId, paymentId: payment.id, items: [{ orderItemId: item.id, qty: 1 }], amountIqd: 25_000, method: "wallet", reason: "رمز معطوب" }, NOW);
    await approveRefund(t.db, staff(otherStaffId), refund.refundId, { approve: true }, NOW);
    const after = (await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW))!.digital![0]!;
    expect(after.codes.map((code) => code.status).sort()).toEqual(["delivered", "revoked"]);
  });

  test("a transfer order gets its codes only when the transfer is verified; fewer codes than units leave the rest pending", async () => {
    const product = await digitalProduct(["XBX-ONE-0001"]);
    const token = await cartWith([{ variantId: product.variantId, qty: 2 }]);
    const placed = await placeOrder(t.db, who(token), await input(token, { paymentMethod: "zaincash" }), NOW);
    expect((await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW))?.digital).toEqual([]);
    await submitPaymentProof(t.db, { orderRef: placed.ref, accessToken: placed.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 55_000 }, NOW + HOUR);
    const pay = (await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId)).get())!;
    await verifyPayment(t.db, staff(otherStaffId, ["orders.payment.verify"]), pay.id, { approve: true }, NOW + 2 * HOUR);
    const line = (await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW))!.digital![0]!;
    expect(line.codes).toHaveLength(1);
    expect(line.pending).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── odds and ends

describe("core odds and ends", () => {
  test("a sold serial bought back: in stock again at the new location, its order line released, its warranty void (module 13's payout calls this)", async () => {
    const product = await make.product({ priceIqd: 500_000, trackSerials: true });
    const serialId = newId("ser");
    const order = await make.order([{ ...product, qty: 1 }]);
    await runBatch(t.db, [
      t.db.insert(serials).values({ id: serialId, serial: `SN-${randomToken(6)}`, variantId: product.variantId, status: "sold", createdAt: NOW, updatedAt: NOW }),
      t.db.insert(orderItemSerials).values({ orderItemId: order.itemIds[0]!, serialId, attachedAt: NOW }),
      t.db.insert(warranties).values({ id: newId("wty"), orderItemId: order.itemIds[0]!, serialId, startsAt: NOW, endsAt: NOW + 365 * DAY, status: "active", createdAt: NOW }),
    ]);
    await runBatch(t.db, releaseSoldSerialStatements(t.db, { serialId, variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, source: "trade_in", sourceRef: "tri_x", costIqd: 300_000, notes: "TI-X", voidReason: "traded_in:TI-X", now: NOW }));
    expect(await t.db.select().from(serials).where(eq(serials.id, serialId)).get()).toMatchObject({ status: "in_stock", source: "trade_in", costIqd: 300_000, locationId: DEFAULT_LOCATION_ID });
    expect((await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.serialId, serialId)).get())?.releasedAt).toBe(NOW);
    expect((await t.db.select().from(warranties).where(eq(warranties.serialId, serialId)).get())?.status).toBe("void");
    // not sold any more: the guard refuses a second buy-back
    expect(String(await runBatch(t.db, releaseSoldSerialStatements(t.db, { serialId, variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, source: "trade_in", sourceRef: "tri_y", costIqd: 1, notes: null, voidReason: "x", now: NOW })).catch((error: unknown) => error))).toContain("SERIAL_CHANGED");
  });

  test("a demo line never says low stock; a line carries its product and its option value", async () => {
    const product = await make.product({ priceIqd: 50_000, stock: 1, isDemo: true });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const line = (await getCartView(t.db, { cartToken: token, customerId: null, locale: "en" }, NOW)).lines[0]!;
    expect(line.stock).toBe("in_stock");
    expect(line.productId).toBe(product.productId);
    expect(optionValueOf("Nintendo Switch 2", "Nintendo Switch 2 — International")).toBe("International");
    expect(optionValueOf("DualSense", "Red")).toBe("Red");
    expect(optionValueOf("DualSense", "DualSense")).toBeNull();
    const real = await make.product({ priceIqd: 50_000, stock: 1 });
    const realToken = await cartWith([{ variantId: real.variantId, qty: 1 }]);
    expect((await getCartView(t.db, { cartToken: realToken, customerId: null, locale: "en" }, NOW)).lines[0]?.stock).toBe("low_stock");
  });

  test("checkout.reservation_minutes: a transfer order's stock is held for the proof window, never shorter than the store's reservation time", async () => {
    await setSetting(t.db, systemActor("test"), "checkout.transfer_proof_hours", 1, "test: a short proof window", NOW);
    await setSetting(t.db, systemActor("test"), "checkout.reservation_minutes", 180, "test: a long hold", NOW);
    const product = await make.product({ priceIqd: 40_000, stock: 3 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const placed = await placeOrder(t.db, who(token), await input(token, { paymentMethod: "bank_transfer" }), NOW);
    const order = await orderOf(placed.orderId);
    expect(order.paymentDueAt).toBe(NOW + HOUR);
    const reservation = await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, placed.orderId)).get();
    expect(reservation?.expiresAt).toBe(NOW + 180 * 60_000);
    await setSetting(t.db, systemActor("test"), "checkout.reservation_minutes", 30, "test: back to the default", NOW);
    await setSetting(t.db, systemActor("test"), "checkout.transfer_proof_hours", 24, "test: back to the default", NOW);
    void stockLevels;
  });
});
