/**
 * Commerce core, 2026-11-12 — the FIRST ADVERSARIAL REVIEW (money and races) of promotions at checkout, wallet split
 * payments, wallet transfers and payouts, and digital codes (tests/commerce-promotions.test.ts is the build's own file).
 *
 * Every test states the CORRECT behaviour; each attack that got through was fixed in the commerce core, never here.
 * Races are deterministic: interleave() runs a second request exactly before the n-th db.batch() of a service — between
 * its read and its write (the technique of tests/commerce-adversarial.test.ts).
 *
 * What got through, and where it was fixed:
 *   · a refund of the wallet part of a split order (cash still to collect) gave back ALL the redeemed points and marked
 *     the order refunded, so the cash on delivery could never be recorded            refunds.server.ts, promotions.server.ts
 *   · two refunds that completed an order, approved at the same moment, each thought it was not the last: points lost
 *     to rounding, digital codes left "delivered" on a fully refunded order          refunds.server.ts, promotions.server.ts, digital.server.ts
 *   · a cash-on-delivery parcel refused at the door (shipped → returned) kept the customer's redeemed points and the
 *     sale's flash units                                                              orders/manage.server.ts, promotions.server.ts
 *   · an order edit kept an automatic offer's discount after the line it was given for was removed, and an edit that
 *     re-priced the coupon left the order page's discount lines adding up to another amount   orders/edit.server.ts, promotions.server.ts, view.server.ts
 *   · a cancelled order still revealed its digital codes while its refund waited      orders/digital.server.ts
 *   · a refund of the unit still WAITING for its code revoked the code already delivered   orders/digital.server.ts
 *   · a demo coupon discounted real goods                                             coupons.server.ts (+ edit.server.ts)
 *   · walletTransferStatements moved demo money into a real wallet                    wallet.server.ts
 *   · a refund issued into the wallet of an erased customer                           refunds.server.ts
 *   · an order paid entirely by points and free delivery (total 0) by cash on delivery stayed "cash due" for ever —
 *     nothing could ever be collected, its digital code never came                    orders/place.server.ts
 *
 * Real local D1 (tests/helpers/db.ts). Every test walks whole orders through the database (cart → order → delivery,
 * refunds), so it takes seconds alone and several times that on a busy machine (the full suite beside other work): the
 * suites run with a budget of BUDGET per test and "28 seeded carts" with its own (client round 1, wave C — they timed out
 * at the 30-second default while the machine was busy). A timeout here is never a finding; the assertions are.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type Actor } from "~/server/actor";
import { encryptSecret } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import {
  couponRedemptions,
  coupons,
  customers,
  digitalCodes,
  flashSaleItems,
  flashSales,
  journalEntries,
  journalLines,
  loyaltyLedger,
  membershipTiers,
  memberships,
  orderEvents,
  orderItems,
  orders,
  payments,
  promotions,
  referralCodes,
  referralRedemptions,
  refunds,
  shippingRates,
  walletLedger,
} from "~/server/db/schema";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { setSetting } from "~/server/settings.server";
import { mergeCustomers, planMerge } from "~/server/services/admin/customers/merge.server";
import { issueReferralCode } from "~/server/services/admin/promotions/referrals.server";
import { addToCart, applyCoupon, getCartView } from "~/server/services/cart.server";
import { revealOrderCode } from "~/server/services/orders/digital.server";
import { editOrder, planOrderEdit } from "~/server/services/orders/edit.server";
import { getOrderByAccessToken, transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder, type CheckoutInput, type CheckoutWho } from "~/server/services/orders/place.server";
import { recordCodCollection } from "~/server/services/payments/payments.server";
import { approveRefund, createRefund } from "~/server/services/refunds.server";
import { creditWallet, decideWalletPayout, getWalletBalance, requestWalletPayout, walletTransferStatements } from "~/server/services/wallet.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BAGHDAD = governorateId("baghdad");
/** Per-test budget of every suite here (file header): about 3–5× what a test takes on a busy machine. */
const BUDGET = { timeout: 90_000 } as const;
/** "28 seeded carts": 28 orders, a quarter of them delivered and posted — ~15 s alone. */
const SEEDED_CARTS_BUDGET = { timeout: 180_000 } as const;

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
  "shipping.attempt.manage",
  "customers.wallet.adjust",
  "customers.wallet.read",
  "customers.customer.merge",
  "customers.customer.read",
];
const staff = (id = staffId, permissions: Permission[] = ALL): Actor => ({ kind: "employee", id, permissions: new Set(permissions) });

// ───────────────────────────────────────────────────────────────── helpers

async function failureOf(promise: PromiseLike<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

/** The same database, with `hook` run right before the `call`-th db.batch() the service makes (between its read and its write). */
function interleave(db: Db, call: number, hook: () => Promise<unknown>) {
  let calls = 0;
  let outcome: { ok: true } | { ok: false; error: unknown } | null = null;
  const batch = async (statements: unknown) => {
    calls += 1;
    if (calls === call) {
      try {
        await hook();
        outcome = { ok: true };
      } catch (error) {
        outcome = { ok: false, error };
      }
    }
    return (db.batch as unknown as (items: unknown) => Promise<unknown>).call(db, statements);
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") return batch;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
  return { db: proxy, outcome: () => outcome };
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
  return checkoutInput(view.totalIqd, overrides);
}

/** The checkout's form for the total the review showed (a test that has just read that review passes its total). */
function checkoutInput(expectedTotalIqd: number, overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    idempotencyKey: randomToken(),
    phone: make.phone(),
    governorateId: BAGHDAD,
    districtId: districtId("baghdad", "karrada"),
    areaText: "الكرادة داخل",
    addressText: "شارع 62، قرب الجسر المعلق، عمارة 4",
    marketingConsent: false,
    paymentMethod: "cod",
    expectedTotalIqd,
    ...overrides,
  };
}

async function orderOf(orderId: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!row) throw new Error("order missing");
  return row;
}

const points = async (customerId: string) => Number((await t.db.select({ n: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)` }).from(loyaltyLedger).where(eq(loyaltyLedger.customerId, customerId)).get())?.n ?? 0);
const qtySold = async (itemId: string) => (await t.db.select({ n: flashSaleItems.qtySold }).from(flashSaleItems).where(eq(flashSaleItems.id, itemId)).get())?.n;
const paymentsOf = (orderId: string) => t.db.select().from(payments).where(eq(payments.orderId, orderId));

async function earnPoints(customerId: string, n: number) {
  await t.db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId, points: n, kind: "earn", refType: "test", refId: null, reason: "test", expiresAt: NOW + 300 * DAY, actorKind: "system", actorId: "test", idempotencyKey: `test:${randomToken()}`, at: NOW - DAY });
}

async function topUp(customerId: string, amountIqd: number) {
  await creditWallet(t.db, staff(), { customerId, amountIqd, kind: "topup", reason: "شحن للاختبار", idempotencyKey: `test:${randomToken()}` }, NOW - HOUR);
}

async function flashSale(variantId: string, options: { salePriceIqd: number; qtyLimit?: number | null }) {
  const saleId = newId("fls");
  const itemId = newId("fli");
  await runBatch(t.db, [
    t.db.insert(flashSales).values({ id: saleId, slug: `sale-${saleId}`, name: { ar: "عرض الجمعة", en: "Friday deal" }, startsAt: NOW - HOUR, endsAt: NOW + 30 * DAY, status: "scheduled", isDemo: false, createdAt: NOW - DAY }),
    t.db.insert(flashSaleItems).values({ id: itemId, flashSaleId: saleId, variantId, salePriceIqd: options.salePriceIqd, qtyLimit: options.qtyLimit ?? null, qtySold: 0, perCustomerLimit: null }),
  ]);
  return { saleId, itemId };
}

async function member(customerId: string, benefits: { discountBps?: number; freeShipping?: boolean }) {
  const tierId = newId("tier");
  await runBatch(t.db, [
    t.db.insert(membershipTiers).values({ id: tierId, key: `gold-${tierId}`, name: { ar: "ذهبي", en: "Gold" }, benefits, isActive: true }),
    t.db.insert(memberships).values({ id: newId("mbr"), customerId, tierId, status: "active", startsAt: NOW - DAY, endsAt: NOW + 60 * DAY, source: "grant", createdAt: NOW - DAY }),
  ]);
}

async function digitalProduct(codes: string[], priceIqd = 30_000) {
  const product = await make.product({ kind: "digital", priceIqd, stock: 20 });
  for (const code of codes) {
    const id = newId("dgc");
    await t.db.insert(digitalCodes).values({ id, variantId: product.variantId, codeEnc: await encryptSecret(code, TEST_VARS.DATA_KEY, `digital_code:${id}`), codeHash: randomToken(), status: "available", isDemo: false, createdAt: NOW - DAY });
  }
  return product;
}

const codesOf = (orderId: string) =>
  t.db
    .select({ id: digitalCodes.id, status: digitalCodes.status, orderItemId: digitalCodes.orderItemId })
    .from(digitalCodes)
    .innerJoin(orderItems, eq(orderItems.id, digitalCodes.orderItemId))
    .where(eq(orderItems.orderId, orderId));

/** Refund (pending above the threshold) and approve by a second person. */
async function refundAndApprove(orderId: string, paymentId: string, amountIqd: number, extra: Partial<Parameters<typeof createRefund>[2]> = {}) {
  const created = await createRefund(t.db, staff(), { orderId, paymentId, amountIqd, method: "wallet", reason: "اختبار الاسترداد", ...extra }, NOW + HOUR);
  if (created.status === "pending") await approveRefund(t.db, staff(otherStaffId), created.refundId, { approve: true }, NOW + HOUR);
  return created.refundId;
}

// ───────────────────────────────────────────────────────────────── totals: every discount adds up

describe("totals — every discount, the points, the flash price and the delivery waiver add up to what is charged and posted", BUDGET, () => {
  afterEach(async () => {
    await t.db.update(promotions).set({ isActive: false });
  });

  test("a cart with a flash line, a stackable rule, a coupon, a member's discount, points and free delivery: the order, its record, its redemption rows and the delivery posting agree to the dinar", async () => {
    const headset = await make.product({ kind: "headset", priceIqd: 187_350, stock: 10 });
    const flashed = await make.product({ kind: "headset", priceIqd: 99_990, stock: 10 });
    const sale = await flashSale(flashed.variantId, { salePriceIqd: 77_777, qtyLimit: 5 });
    await t.db.insert(promotions).values({ id: newId("prm"), name: { ar: "خصم السماعات", en: "Headsets 7.5%" }, kind: "percent", value: 750, stackable: true, priority: 3, scope: { productKinds: ["headset"] }, isActive: true, createdAt: NOW - DAY, updatedAt: NOW - DAY });
    const code = `ODD${randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
    await t.db.insert(coupons).values({ id: newId("cpn"), code, kind: "percent", value: 333, isActive: true, createdAt: NOW - DAY });
    const customerId = await make.customer();
    await member(customerId, { discountBps: 1_250, freeShipping: true });
    await earnPoints(customerId, 777);

    const token = await cartWith([{ variantId: headset.variantId, qty: 2 }, { variantId: flashed.variantId, qty: 3 }], customerId);
    await applyCoupon(t.db, { cartToken: token, customerId, locale: "en" }, code, NOW);
    const view = await getCartView(t.db, { cartToken: token, customerId, locale: "en", governorateId: BAGHDAD, redeemPoints: 777 }, NOW);
    const sum = (list: { amountIqd: number }[]) => list.reduce((total, entry) => total + entry.amountIqd, 0);
    expect(view.subtotalIqd).toBe(2 * 187_350 + 3 * 77_777);
    expect(sum(view.discounts)).toBe(view.discountIqd);
    expect(view.discounts.map((entry) => entry.kind)).toEqual(["rule", "coupon", "member", "points"]);
    expect(view.totalIqd).toBe(view.subtotalIqd - view.discountIqd + (view.shippingIqd ?? 0));
    for (const amount of [view.subtotalIqd, view.discountIqd, view.totalIqd, ...view.discounts.map((entry) => entry.amountIqd)]) expect(Number.isSafeInteger(amount)).toBe(true);

    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { redeemPoints: 777 }, customerId), NOW);
    const order = await orderOf(placed.orderId);
    expect(order).toMatchObject({ subtotalIqd: view.subtotalIqd, discountIqd: view.discountIqd, shippingIqd: 0, totalIqd: view.totalIqd });
    const items = await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
    expect(items.reduce((total, item) => total + item.totalIqd, 0)).toBe(order.subtotalIqd);
    const record = (await t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, placed.orderId), eq(orderEvents.kind, "promotions"))).get())?.data as { discounts: { kind: string; amountIqd: number; points?: number }[]; shipping: { waivedIqd: number; feeIqd: number } | null; flash: { units: number }[] };
    expect(sum(record.discounts)).toBe(order.discountIqd);
    expect(record.shipping).toMatchObject({ feeIqd: 5_000, waivedIqd: 5_000 });
    expect(record.flash.map((claim) => claim.units)).toEqual([3]);
    expect(await qtySold(sale.itemId)).toBe(3);
    const redeemed = record.discounts.find((entry) => entry.kind === "points");
    expect((await t.db.select().from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, `loyalty:redeem:${placed.orderId}`)).get())?.points).toBe(-(redeemed?.points ?? 0));
    const couponLine = record.discounts.find((entry) => entry.kind === "coupon");
    expect((await t.db.select().from(couponRedemptions).where(eq(couponRedemptions.orderId, placed.orderId)).get())?.amountIqd).toBe(couponLine?.amountIqd);

    // delivered: the sale posting carries the same discount, revenue and delivery income, balanced
    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW + HOUR);
    await transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW + 2 * HOUR);
    await recordCodCollection(t.db, staff(), placed.orderId, order.totalIqd, NOW + 3 * HOUR);
    await transitionOrder(t.db, staff(), placed.orderId, "delivered", {}, NOW + 3 * HOUR);
    const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `order:${placed.orderId}:sale`)).get();
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entry!.id));
    const debit = lines.reduce((total, line) => total + (line.debitIqd ?? 0), 0);
    const credit = lines.reduce((total, line) => total + (line.creditIqd ?? 0), 0);
    expect(debit).toBe(credit);
    expect(lines.find((line) => line.accountId === "acc_sales_discounts")?.debitIqd).toBe(order.discountIqd);
    expect(lines.find((line) => line.accountId === "acc_sales_revenue")?.creditIqd).toBe(order.subtotalIqd);
  });
});

// ───────────────────────────────────────────────────────────────── refunds after a redemption

describe("refunds after points — never more back than the share, the last one gives back the rest, exactly once", BUDGET, () => {
  test("a refund of the wallet part of a split order while its cash is still to collect gives back only that refund's share of the points, and the cash can still be recorded", async () => {
    const customerId = await make.customer();
    await earnPoints(customerId, 1_000);
    await topUp(customerId, 100_000);
    const product = await make.product({ priceIqd: 300_000, stock: 5 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    // 300,000 − 10,000 (1,000 points) + 5,000 delivery = 295,000: 100,000 from the wallet, 195,000 cash on delivery
    const body = await input(token, { redeemPoints: 1_000, walletIqd: 100_000 }, customerId);
    expect(body.expectedTotalIqd).toBe(295_000);
    const placed = await placeOrder(t.db, who(token, customerId), body, NOW);
    expect(await points(customerId)).toBe(0);
    const wallet = (await paymentsOf(placed.orderId)).find((row) => row.method === "wallet")!;

    // before delivery, a goodwill refund as large as the wallet part (the cash on delivery stays as agreed)
    await refundAndApprove(placed.orderId, wallet.id, 100_000);
    // its share of the order, not all of the points: ⌊1,000 × 100,000 / 295,000⌋
    expect(await points(customerId)).toBe(338);
    // the order still waits for its cash: delivered and collected as usual
    expect((await orderOf(placed.orderId)).paymentStatus).toBe("cod_due");
    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW + 2 * HOUR);
    await transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW + 3 * HOUR);
    await recordCodCollection(t.db, staff(), placed.orderId, 195_000, NOW + 4 * HOUR);
    expect(await orderOf(placed.orderId)).toMatchObject({ paidIqd: 295_000, refundedIqd: 100_000, paymentStatus: "partially_refunded" });
    // the rest refunded later: the rest of the points, never more than were redeemed
    const cod = (await paymentsOf(placed.orderId)).find((row) => row.method === "cod")!;
    await refundAndApprove(placed.orderId, cod.id, 195_000);
    expect(await points(customerId)).toBe(1_000);
    expect((await orderOf(placed.orderId)).paymentStatus).toBe("refunded");
  });

  test("a cancelled split order is not 'cash due' any more: what the wallet paid waits for its refund (paid), then refunded", async () => {
    const customerId = await make.customer();
    await topUp(customerId, 40_000);
    const product = await make.product({ priceIqd: 150_000, stock: 5 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { walletIqd: 40_000 }, customerId), NOW);
    expect((await orderOf(placed.orderId)).paymentStatus).toBe("cod_due");
    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW + HOUR);
    // nothing is due on a cancelled order; the wallet's 40,000 waits for its refund
    expect(await orderOf(placed.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "paid", paidIqd: 40_000 });
    const pending = (await t.db.select().from(refunds).where(eq(refunds.orderId, placed.orderId)).get())!;
    await approveRefund(t.db, staff(otherStaffId), pending.id, { approve: true }, NOW + 2 * HOUR);
    expect(await orderOf(placed.orderId)).toMatchObject({ paymentStatus: "refunded", refundedIqd: 40_000 });
    expect(await getWalletBalance(t.db, customerId)).toBe(40_000);
  });

  test("two refunds that complete an order, approved at the same moment: all the points come back and every digital code is revoked", async () => {
    const customerId = await make.customer();
    await earnPoints(customerId, 1_000);
    await topUp(customerId, 200_000);
    const product = await digitalProduct(["RACE-0001", "RACE-0002", "RACE-0003"], 30_000);
    const token = await cartWith([{ variantId: product.variantId, qty: 3 }], customerId);
    // 90,000 − 10,000 + 5,000 = 85,000, paid from the wallet; three codes delivered
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { redeemPoints: 1_000, paymentMethod: "wallet" }, customerId), NOW);
    expect((await orderOf(placed.orderId)).totalIqd).toBe(85_000);
    expect((await codesOf(placed.orderId)).map((code) => code.status)).toEqual(["delivered", "delivered", "delivered"]);
    const payment = (await paymentsOf(placed.orderId))[0]!;

    await refundAndApprove(placed.orderId, payment.id, 30_000);
    const second = await createRefund(t.db, staff(), { orderId: placed.orderId, paymentId: payment.id, amountIqd: 30_000, method: "wallet", reason: "الجزء الثاني" }, NOW + HOUR);
    const third = await createRefund(t.db, staff(), { orderId: placed.orderId, paymentId: payment.id, amountIqd: 25_000, method: "wallet", reason: "الجزء الثالث" }, NOW + HOUR);
    // two approvers at once: the third is issued between the second's read and its write
    const raced = interleave(t.db, 1, () => approveRefund(t.db, staff(otherStaffId), third.refundId, { approve: true }, NOW + 2 * HOUR));
    await approveRefund(raced.db, staff(otherStaffId), second.refundId, { approve: true }, NOW + 2 * HOUR);
    expect(raced.outcome()).toEqual({ ok: true });

    expect(await orderOf(placed.orderId)).toMatchObject({ refundedIqd: 85_000, paymentStatus: "refunded" });
    expect(await points(customerId)).toBe(1_000);
    expect((await codesOf(placed.orderId)).map((code) => code.status)).toEqual(["revoked", "revoked", "revoked"]);
    expect(await getWalletBalance(t.db, customerId)).toBe(200_000);
  });

  test("points given back on an order whose account was merged meanwhile go to the account that holds the order now, not to the merged-away one", async () => {
    const keep = await make.customer({ email: "same-person@tamtam.test" });
    const dup = await make.customer({ email: "same-person@tamtam.test" });
    await earnPoints(dup, 1_000);
    const product = await make.product({ priceIqd: 80_000, stock: 5 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], dup);
    // every point spent on an open order: the duplicate holds none, so module 07 may merge it
    const placed = await placeOrder(t.db, who(token, dup), await input(token, { redeemPoints: 1_000 }, dup), NOW);
    const plan = await planMerge(t.db, staff(), { keepId: keep, mergeId: dup }, NOW);
    expect(plan.blockers).toEqual([]);
    await mergeCustomers(t.db, staff(), { keepId: keep, mergeId: dup, method: "call_both_numbers", verification: "اتصلت بالرقمين وأكد صاحبهما", reason: "حساب مكرر", fingerprint: plan.fingerprint }, NOW + HOUR);
    expect((await orderOf(placed.orderId)).customerId).toBe(keep);

    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW + 2 * HOUR);
    expect(await points(keep)).toBe(1_000);
    expect(await points(dup)).toBe(0);
  });

  test("a cash-on-delivery parcel refused at the door (shipped → returned, nothing paid): the redeemed points and the flash units come back — once", async () => {
    const customerId = await make.customer();
    await earnPoints(customerId, 1_000);
    const product = await make.product({ priceIqd: 120_000, stock: 5 });
    const sale = await flashSale(product.variantId, { salePriceIqd: 100_000, qtyLimit: 3 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { redeemPoints: 1_000 }, customerId), NOW);
    expect(await points(customerId)).toBe(0);
    expect(await qtySold(sale.itemId)).toBe(1);

    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW + HOUR);
    await transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW + 2 * HOUR);
    await transitionOrder(t.db, staff(), placed.orderId, "returned", { reason: "رفض الزبون الاستلام" }, NOW + 3 * HOUR);
    expect(await points(customerId)).toBe(1_000);
    expect(await qtySold(sale.itemId)).toBe(0);
    // the same move again changes nothing
    await transitionOrder(t.db, staff(), placed.orderId, "returned", { reason: "رفض الزبون الاستلام" }, NOW + 4 * HOUR);
    expect(await points(customerId)).toBe(1_000);
    expect(await qtySold(sale.itemId)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── order edits after a discount

describe("order edits after a discount — never a discount the goods left do not earn, and the order page adds up", BUDGET, () => {
  afterEach(async () => {
    await t.db.update(promotions).set({ isActive: false });
  });

  test("removing the line an automatic offer was given for does not leave the offer's discount on the rest", async () => {
    const headset = await make.product({ kind: "headset", priceIqd: 400_000, stock: 5 });
    const consoleUnit = await make.product({ kind: "console", priceIqd: 500_000, stock: 5 });
    await t.db.insert(promotions).values({ id: newId("prm"), name: { ar: "خصم السماعات", en: "Headsets 10%" }, kind: "percent", value: 1_000, stackable: true, priority: 1, scope: { productKinds: ["headset"] }, isActive: true, createdAt: NOW - DAY, updatedAt: NOW - DAY });
    const token = await cartWith([{ variantId: headset.variantId, qty: 1 }, { variantId: consoleUnit.variantId, qty: 1 }]);
    const placed = await placeOrder(t.db, who(token), await input(token), NOW);
    expect(await orderOf(placed.orderId)).toMatchObject({ subtotalIqd: 900_000, discountIqd: 40_000, totalIqd: 865_000 });
    const headsetLine = (await t.db.select().from(orderItems).where(and(eq(orderItems.orderId, placed.orderId), eq(orderItems.variantId, headset.variantId))).get())!;

    const edit = { lines: [{ orderItemId: headsetLine.id, qty: 0 }], reason: "الزبون لا يريد السماعة" };
    const refused = await failureOf(planOrderEdit(t.db, staff(), placed.orderId, edit));
    expect(refused).toMatchObject({ code: "edit_not_allowed", detail: "promotions" });
    expect((await failureOf(editOrder(t.db, staff(), placed.orderId, { ...edit, idempotencyKey: randomToken() }, NOW + HOUR))).code).toBe("edit_not_allowed");
    // nothing changed: the console never carries the headset's 40,000
    expect(await orderOf(placed.orderId)).toMatchObject({ subtotalIqd: 900_000, discountIqd: 40_000, totalIqd: 865_000 });
  });

  test("an edit that re-prices the coupon: the order page's discount lines add up to what the order now charges", async () => {
    const a = await make.product({ kind: "console", priceIqd: 200_000, stock: 5 });
    const b = await make.product({ kind: "console", priceIqd: 100_000, stock: 5 });
    const code = `TEN${randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
    await t.db.insert(coupons).values({ id: newId("cpn"), code, kind: "percent", value: 1_000, isActive: true, createdAt: NOW - DAY });
    const token = await cartWith([{ variantId: a.variantId, qty: 1 }, { variantId: b.variantId, qty: 1 }]);
    await applyCoupon(t.db, { cartToken: token, customerId: null, locale: "en" }, code, NOW);
    const placed = await placeOrder(t.db, who(token), await input(token), NOW);
    expect(await orderOf(placed.orderId)).toMatchObject({ discountIqd: 30_000, totalIqd: 275_000 });
    const lineB = (await t.db.select().from(orderItems).where(and(eq(orderItems.orderId, placed.orderId), eq(orderItems.variantId, b.variantId))).get())!;

    const preview = await planOrderEdit(t.db, staff(), placed.orderId, { lines: [{ orderItemId: lineB.id, qty: 0 }], reason: "سحب المنتج الثاني" });
    await editOrder(t.db, staff(), placed.orderId, { lines: [{ orderItemId: lineB.id, qty: 0 }], reason: "سحب المنتج الثاني", idempotencyKey: randomToken(), expectedTotalIqd: preview.after.totalIqd }, NOW + HOUR);
    const order = await orderOf(placed.orderId);
    expect(order).toMatchObject({ subtotalIqd: 200_000, discountIqd: 20_000, totalIqd: 185_000 });
    const view = await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW + HOUR);
    expect(view?.adjustments?.discounts.map((entry) => [entry.kind, entry.amountIqd])).toEqual([["coupon", 20_000]]);
    expect((view?.adjustments?.discounts ?? []).reduce((sum, entry) => sum + entry.amountIqd, 0)).toBe(order.discountIqd);
  });

  test("a new governorate on an order whose delivery a capped offer waived: the record says the new fee and what is still waived — and adds up to what is charged", async () => {
    const erbil = governorateId("erbil");
    const rateId = newId("shr");
    await setSetting(t.db, systemActor("test"), "shipping.overrides_enabled", true, "اختبار رسوم أربيل", NOW);
    await t.db.insert(shippingRates).values({ id: rateId, governorateId: erbil, feeIqd: 12_000, isOverride: true, isActive: true, updatedAt: NOW });
    try {
      const headset = await make.product({ kind: "headset", priceIqd: 90_000, stock: 5 });
      await t.db.insert(promotions).values({ id: newId("prm"), name: { ar: "توصيل مجاني", en: "Free delivery" }, kind: "free_shipping", value: null, maxDiscountIqd: 5_000, stackable: true, priority: 1, scope: { productKinds: ["headset"] }, isActive: true, createdAt: NOW - DAY, updatedAt: NOW - DAY });
      const token = await cartWith([{ variantId: headset.variantId, qty: 1 }]);
      const placed = await placeOrder(t.db, who(token), await input(token), NOW);
      expect(await orderOf(placed.orderId)).toMatchObject({ shippingIqd: 0, totalIqd: 90_000 });

      const address = { governorateId: erbil, areaText: "عنكاوة", addressText: "شارع 100، قرب الكنيسة، بناية 3" };
      const preview = await planOrderEdit(t.db, staff(), placed.orderId, { address, reason: "الزبون انتقل إلى أربيل" });
      expect(preview.after.shippingIqd).toBe(7_000);
      await editOrder(t.db, staff(), placed.orderId, { address, reason: "الزبون انتقل إلى أربيل", idempotencyKey: randomToken(), expectedTotalIqd: preview.after.totalIqd }, NOW + HOUR);
      const order = await orderOf(placed.orderId);
      expect(order).toMatchObject({ shippingIqd: 7_000, totalIqd: 97_000 });
      const waiver = (await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW + HOUR))?.adjustments?.shippingWaiver;
      expect(waiver).toMatchObject({ feeIqd: 12_000, waivedIqd: 5_000 });
      expect((waiver?.feeIqd ?? 0) - (waiver?.waivedIqd ?? 0)).toBe(order.shippingIqd);
    } finally {
      await setSetting(t.db, systemActor("test"), "shipping.overrides_enabled", false, "انتهى الاختبار", NOW);
      await t.db.delete(shippingRates).where(eq(shippingRates.id, rateId));
    }
  });
});

// ───────────────────────────────────────────────────────────────── races just before the write

describe("races just before the write batch — a second request between a service's read and its write", BUDGET, () => {
  test("one referral code typed for the same number in two tabs at once: one order records it, the other is refused (referral_phone_used); the code counts one use", async () => {
    const referrer = await make.customer();
    const code = await issueReferralCode(t.db, { kind: "customer", id: referrer }, { customerId: referrer }, NOW);
    const product = await make.product({ priceIqd: 60_000, stock: 5 });
    const phone = make.phone();
    const first = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const second = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const [a, b] = await Promise.all([input(first, { phone, referralCode: code.code }), input(second, { phone, referralCode: code.code })]);
    const raced = interleave(t.db, 1, () => placeOrder(t.db, who(second), b, NOW));
    const refused = await failureOf(placeOrder(raced.db, who(first), a, NOW));
    expect(raced.outcome()).toEqual({ ok: true });
    expect(refused).toMatchObject({ code: "referral_phone_used", fields: { referralCode: "referral_phone_used" } });
    expect((await t.db.select().from(referralCodes).where(eq(referralCodes.code, code.code)).get())?.uses).toBe(1);
    expect((await t.db.select().from(referralRedemptions).where(eq(referralRedemptions.referredPhoneE164, phone))).length).toBe(1);
  });

  test("the last digital code, two paid orders at the same moment: exactly one order gets it, the other waits for a code", async () => {
    const product = await digitalProduct(["LAST-ONE-9999"], 20_000);
    const [buyerA, buyerB] = [await make.customer(), await make.customer()];
    await topUp(buyerA, 50_000);
    await topUp(buyerB, 50_000);
    const cartA = await cartWith([{ variantId: product.variantId, qty: 1 }], buyerA);
    const cartB = await cartWith([{ variantId: product.variantId, qty: 1 }], buyerB);
    const [a, b] = await Promise.all([input(cartA, { paymentMethod: "wallet" }, buyerA), input(cartB, { paymentMethod: "wallet" }, buyerB)]);
    const other: { placed?: Awaited<ReturnType<typeof placeOrder>> } = {};
    const raced = interleave(t.db, 1, async () => {
      other.placed = await placeOrder(t.db, who(cartB, buyerB), b, NOW);
    });
    const placedA = await placeOrder(raced.db, who(cartA, buyerA), a, NOW);
    expect(raced.outcome()).toEqual({ ok: true });
    const codes = await t.db.select().from(digitalCodes).where(eq(digitalCodes.variantId, product.variantId));
    expect(codes).toHaveLength(1);
    expect(codes[0]?.status).toBe("delivered");
    const holder = (await t.db.select({ orderId: orderItems.orderId }).from(orderItems).where(eq(orderItems.id, codes[0]!.orderItemId!)).get())?.orderId;
    expect(holder).toBe(other.placed?.orderId);
    expect((await getOrderByAccessToken(t.db, placedA.ref, placedA.accessToken, "en", NOW))?.digital?.[0]).toMatchObject({ codes: [], pending: 1 });
  });

  test("a payout decided by two approvers at the same moment: paid once, the wallet debited once", async () => {
    const customerId = await make.customer();
    const thirdId = await make.employee();
    await creditWallet(t.db, staff(), { customerId, amountIqd: 30_000, kind: "adjustment", reason: "تعويض", idempotencyKey: `test:${randomToken()}` }, NOW);
    const asked =await requestWalletPayout(t.db, staff(), { customerId, amountIqd: 30_000, method: "cash", reason: "إغلاق الحساب", idempotencyKey: randomToken() }, NOW);
    const raced = interleave(t.db, 1, () => decideWalletPayout(t.db, staff(thirdId), { approvalId: asked.approvalId, approve: true }, NOW));
    const second = await decideWalletPayout(raced.db, staff(otherStaffId), { approvalId: asked.approvalId, approve: true }, NOW).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, code: toAppError(error)?.code }),
    );
    expect(raced.outcome()).toEqual({ ok: true });
    expect(second.ok ? "paid" : second.code).toMatch(/^(change_not_pending|paid)$/);
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    expect((await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.refType, "wallet_payout")))).length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── totals, at random

describe("totals at random — whatever the mix of offers, the order, its record and its postings agree", BUDGET, () => {
  afterEach(async () => {
    await t.db.update(promotions).set({ isActive: false });
  });

  test("28 seeded carts with flash prices, stackable and single offers, free delivery with caps, coupons, members, points", SEEDED_CARTS_BUDGET, async () => {
    // mulberry32: the same carts on every run
    let seed = 0x7a3c_91d5;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
    };
    const between = (low: number, high: number) => low + Math.floor(rand() * (high - low + 1));
    const sum = (list: { amountIqd: number }[]) => list.reduce((total, entry) => total + entry.amountIqd, 0);
    for (let round = 0; round < 28; round++) {
      const lines = await Promise.all(Array.from({ length: between(1, 3) }, async () => ({ product: await make.product({ kind: "headset", priceIqd: between(7_350, 487_650), stock: 20 }), qty: between(1, 3) })));
      const first = lines[0]!;
      const sale = rand() < 0.5 ? await flashSale(first.product.variantId, { salePriceIqd: first.product.priceIqd - between(1, Math.floor(first.product.priceIqd / 3)), qtyLimit: rand() < 0.5 ? null : between(1, 5) }) : null;
      // the last round's offers off and this round's on, in ONE batch (the same draws, in the same order, as one write each)
      const offers: BatchStatement[] = [t.db.update(promotions).set({ isActive: false })];
      const offer = (values: Partial<typeof promotions.$inferInsert> & Pick<typeof promotions.$inferInsert, "kind">) =>
        offers.push(t.db.insert(promotions).values({ id: newId("prm"), name: { ar: "عرض", en: "Offer" }, isActive: true, createdAt: NOW - DAY, updatedAt: NOW - DAY, priority: between(0, 5), stackable: true, scope: { productKinds: ["headset"] }, ...values }));
      if (rand() < 0.6) offer({ kind: "percent", value: between(100, 1_500), stackable: true });
      if (rand() < 0.4) offer({ kind: "fixed", value: between(1_000, 60_000), stackable: false });
      if (rand() < 0.3) offer({ kind: "free_shipping", value: null, maxDiscountIqd: rand() < 0.5 ? null : between(1_000, 5_000) });
      await runBatch(t.db, offers);
      const customerId = await make.customer();
      if (rand() < 0.5) await member(customerId, { discountBps: between(100, 3_000), freeShipping: rand() < 0.5 });
      const balance = rand() < 0.6 ? between(1, 6_000) : 0;
      if (balance > 0) await earnPoints(customerId, balance);
      const token = await cartWith(lines.map((line) => ({ variantId: line.product.variantId, qty: line.qty })), customerId);
      if (rand() < 0.5) {
        const code = `R${round}X${randomToken(5).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`;
        const percent = rand() < 0.5;
        await t.db.insert(coupons).values({ id: newId("cpn"), code, kind: percent ? "percent" : "fixed", value: percent ? between(100, 2_000) : between(1_000, 30_000), maxDiscountIqd: percent && rand() < 0.5 ? between(5_000, 40_000) : null, isActive: true, createdAt: NOW - DAY });
        await applyCoupon(t.db, { cartToken: token, customerId, locale: "en" }, code, NOW).catch(() => undefined);
      }
      const redeem = balance > 0 ? between(0, balance) : 0;
      const view = await getCartView(t.db, { cartToken: token, customerId, locale: "en", governorateId: BAGHDAD, redeemPoints: redeem }, NOW);
      const label = `round ${round}`;
      expect(sum(view.discounts), label).toBe(view.discountIqd);
      expect(view.totalIqd, label).toBe(view.subtotalIqd - view.discountIqd + (view.shippingIqd ?? 0));
      for (const amount of [view.subtotalIqd, view.discountIqd, view.totalIqd, view.shippingIqd ?? 0, ...view.discounts.map((entry) => entry.amountIqd)]) {
        expect(Number.isSafeInteger(amount) && amount >= 0, `${label}: ${amount}`).toBe(true);
      }
      expect(view.discounts.every((entry) => entry.amountIqd > 0), label).toBe(true);
      expect(view.discountIqd, label).toBeLessThanOrEqual(view.subtotalIqd);

      // ordered for the total the review above showed (that read IS the review: the same cart, points and governorate)
      const placed = await placeOrder(t.db, who(token, customerId), checkoutInput(view.totalIqd, { redeemPoints: redeem }), NOW);
      // everything the order wrote, read at once
      const [order, items, recordRow, sold, redeemRow, balanceAfter, redemption] = await Promise.all([
        orderOf(placed.orderId),
        t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId)),
        t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, placed.orderId), eq(orderEvents.kind, "promotions"))).get(),
        sale ? qtySold(sale.itemId) : Promise.resolve(undefined),
        t.db.select().from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, `loyalty:redeem:${placed.orderId}`)).get(),
        points(customerId),
        t.db.select().from(couponRedemptions).where(eq(couponRedemptions.orderId, placed.orderId)).get(),
      ]);
      expect(order, label).toMatchObject({ subtotalIqd: view.subtotalIqd, discountIqd: view.discountIqd, shippingIqd: view.shippingIqd ?? 0, totalIqd: view.totalIqd });
      expect(items.reduce((total, item) => total + item.totalIqd, 0), label).toBe(order.subtotalIqd);
      const record = recordRow?.data as
        | { discounts: { kind: string; amountIqd: number; points?: number }[]; shipping: { feeIqd: number; waivedIqd: number } | null; flash: { units: number; salePriceIqd: number; orderItemId: string }[] }
        | undefined;
      expect(sum(record?.discounts ?? []), label).toBe(order.discountIqd);
      expect(record?.shipping ? record.shipping.feeIqd - record.shipping.waivedIqd : 5_000, label).toBe(order.shippingIqd);
      for (const claim of record?.flash ?? []) {
        const item = items.find((entry) => entry.id === claim.orderItemId);
        expect(item && [item.qty, item.unitPriceIqd], label).toEqual([claim.units, claim.salePriceIqd]);
      }
      if (sale) expect(sold, label).toBe((record?.flash ?? []).reduce((total, claim) => total + claim.units, 0));
      const pointsLine = record?.discounts.find((entry) => entry.kind === "points");
      expect(redeemRow?.points ?? 0, label).toBe(pointsLine?.points ? -pointsLine.points : 0);
      expect(balanceAfter, label).toBe(balance - (pointsLine?.points ?? 0));
      const couponLine = record?.discounts.find((entry) => entry.kind === "coupon");
      expect(redemption?.amountIqd ?? 0, label).toBe(couponLine?.amountIqd ?? 0);

      if (round % 4 === 0 && order.totalIqd > 0) {
        // delivered and collected: the books carry the same numbers, balanced
        await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW + HOUR);
        await transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW + 2 * HOUR);
        await recordCodCollection(t.db, staff(), placed.orderId, order.totalIqd, NOW + 3 * HOUR);
        await transitionOrder(t.db, staff(), placed.orderId, "delivered", {}, NOW + 3 * HOUR);
        const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `order:${placed.orderId}:sale`)).get();
        const postings = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entry!.id));
        const line = (accountId: string, side: "debitIqd" | "creditIqd") => postings.find((row) => row.accountId === accountId)?.[side] ?? 0;
        expect(postings.reduce((total, row) => total + (row.debitIqd ?? 0) - (row.creditIqd ?? 0), 0), label).toBe(0);
        expect([line("acc_sales_revenue", "creditIqd"), line("acc_sales_discounts", "debitIqd"), line("acc_shipping_income", "creditIqd"), line("acc_cod_receivable", "debitIqd")], label).toEqual([order.subtotalIqd, order.discountIqd, order.shippingIqd, order.totalIqd]);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── digital codes

describe("digital codes — shown only for what stays paid, revoked for what is refunded, never the wrong one", BUDGET, () => {
  test("a cancelled order's codes are not revealed while its refund waits", async () => {
    const customerId = await make.customer();
    await topUp(customerId, 100_000);
    const product = await digitalProduct(["CXL-1111"], 25_000);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW);
    const [code] = await codesOf(placed.orderId);
    expect(code?.status).toBe("delivered");

    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW + HOUR);
    // the money is on its way back (a pending refund): the code is no longer the buyer's to see
    expect((await t.db.select().from(refunds).where(eq(refunds.orderId, placed.orderId)).get())?.status).toBe("pending");
    const refused = await failureOf(revealOrderCode(t.db, TEST_VARS.DATA_KEY, { order: await orderOf(placed.orderId), codeId: code!.id, actor: { kind: "customer", id: customerId } }, NOW + 2 * HOUR));
    expect(refused.code).toBe("code_not_revealable");
    expect((await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW + 2 * HOUR))?.digital?.[0]?.pending ?? 0).toBe(0);
    // the cancellation itself revokes the order's codes (an order of 0 has no refund that ever would)
    expect((await codesOf(placed.orderId)).map((row) => row.status)).toEqual(["revoked"]);
  });

  test("an order paid entirely by points and then cancelled: nothing to refund, the points come back, and its code is revoked", async () => {
    const customerId = await make.customer();
    await member(customerId, { freeShipping: true });
    await earnPoints(customerId, 2_000);
    const product = await digitalProduct(["ZERO-CXL-0001"], 20_000);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { redeemPoints: 2_000 }, customerId), NOW);
    expect((await codesOf(placed.orderId)).map((row) => row.status)).toEqual(["delivered"]);
    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW + HOUR);
    expect(await points(customerId)).toBe(2_000);
    expect(await t.db.select().from(refunds).where(eq(refunds.orderId, placed.orderId))).toEqual([]);
    expect((await codesOf(placed.orderId)).map((row) => row.status)).toEqual(["revoked"]);
  });

  test("refunding the unit still waiting for its code keeps the code already delivered", async () => {
    const customerId = await make.customer();
    await topUp(customerId, 100_000);
    // one code for a line of two: one delivered, one waiting
    const product = await digitalProduct(["ONLY-ONE-0001"], 25_000);
    const token = await cartWith([{ variantId: product.variantId, qty: 2 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW);
    const before = (await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW))!.digital![0]!;
    expect(before.codes.map((code) => code.status)).toEqual(["delivered"]);
    expect(before.pending).toBe(1);

    const item = (await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId)).get())!;
    const payment = (await paymentsOf(placed.orderId))[0]!;
    // the store cannot supply the second code: it refunds that unit
    await refundAndApprove(placed.orderId, payment.id, 25_000, { items: [{ orderItemId: item.id, qty: 1 }] });
    const after = (await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW + 2 * HOUR))!.digital![0]!;
    expect(after.codes.map((code) => code.status)).toEqual(["delivered"]);
    expect(after.pending).toBe(0);
    // and the buyer can still see the one unit they paid for
    const shown = await revealOrderCode(t.db, TEST_VARS.DATA_KEY, { order: await orderOf(placed.orderId), codeId: after.codes[0]!.id, actor: { kind: "customer", id: customerId } }, NOW + 2 * HOUR);
    expect(shown.code).toBe("ONLY-ONE-0001");
  });
});

// ───────────────────────────────────────────────────────────────── demo rows and real money

describe("demo rows never touch real money", BUDGET, () => {
  test("a demo coupon never discounts real goods (demo goods still take it)", async () => {
    const code = `DEMOX${randomToken(5).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
    await t.db.insert(coupons).values({ id: newId("cpn"), code, kind: "percent", value: 1_000, isActive: true, isDemo: true, createdAt: NOW - DAY });
    const real = await make.product({ priceIqd: 200_000, stock: 5 });
    const token = await cartWith([{ variantId: real.variantId, qty: 1 }]);
    expect((await failureOf(applyCoupon(t.db, { cartToken: token, customerId: null, locale: "en" }, code, NOW))).code).toBe("coupon_not_applicable");
    const demo = await make.product({ priceIqd: 200_000, stock: 5, isDemo: true });
    const demoToken = await cartWith([{ variantId: demo.variantId, qty: 1 }]);
    expect((await applyCoupon(t.db, { cartToken: demoToken, customerId: null, locale: "en" }, code, NOW)).discountIqd).toBe(20_000);
    // a cart of both: only the demo line counts
    const mixed = await cartWith([{ variantId: demo.variantId, qty: 1 }, { variantId: real.variantId, qty: 1 }]);
    expect((await applyCoupon(t.db, { cartToken: mixed, customerId: null, locale: "en" }, code, NOW)).discountIqd).toBe(20_000);
  });

  test("a wallet transfer never moves a demo account's money into a real wallet (module 07's merge is blocked)", async () => {
    const real = await make.customer({ email: "twin@tamtam.test" });
    const demo = await make.customer({ email: "twin@tamtam.test", isDemo: true });
    await creditWallet(t.db, staff(), { customerId: demo, amountIqd: 40_000, kind: "adjustment", reason: "رصيد تجريبي", idempotencyKey: `test:${randomToken()}` }, NOW);
    const refused = await runBatch(t.db, walletTransferStatements(t.db, { transferId: `t-${randomToken(8)}`, fromCustomerId: demo, toCustomerId: real, amountIqd: 40_000, reason: "نقل", actor: staff(), now: NOW })).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(refused)).toContain("WALLET_DEMO_MISMATCH");
    expect(await getWalletBalance(t.db, real)).toBe(0);
    expect(await getWalletBalance(t.db, demo)).toBe(40_000);

    const plan = await planMerge(t.db, staff(), { keepId: real, mergeId: demo }, NOW);
    const merged = await failureOf(mergeCustomers(t.db, staff(), { keepId: real, mergeId: demo, method: "call_both_numbers", verification: "اتصلت بالرقمين وأكد صاحبهما", reason: "حساب مكرر", fingerprint: plan.fingerprint }, NOW));
    expect(merged.code).toBe("merge_blocked");
    expect(await getWalletBalance(t.db, real)).toBe(0);
    expect((await t.db.select({ status: customers.status }).from(customers).where(eq(customers.id, demo)).get())?.status).toBe("active");
  });
});

// ───────────────────────────────────────────────────────────────── the wallet ledger

describe("the wallet ledger — money goes only to a wallet that can hold it", BUDGET, () => {
  test("a refund is never issued into the wallet of an erased customer (staff refund in cash instead)", async () => {
    const customerId = await make.customer();
    // exactly the order's 75,000: the wallet is empty afterwards (module 07 erases no account holding money)
    await topUp(customerId, 75_000);
    const product = await make.product({ priceIqd: 70_000, stock: 5 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW);
    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW + HOUR);
    const pending = (await t.db.select().from(refunds).where(eq(refunds.orderId, placed.orderId)).get())!;
    // the account is erased meanwhile (module 07: no open order, an empty wallet — the cancelled order's refund still waits)
    await t.db.update(customers).set({ status: "deleted" }).where(eq(customers.id, customerId));

    const refused = await failureOf(approveRefund(t.db, staff(otherStaffId), pending.id, { approve: true }, NOW + 2 * HOUR));
    expect(refused.code).toBe("customer_unavailable");
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    expect((await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.kind, "refund")))).length).toBe(0);
    // the money can still go back by hand
    await approveRefund(t.db, staff(otherStaffId), pending.id, { approve: false, note: "يُعاد نقداً" }, NOW + 2 * HOUR);
    const payment = (await paymentsOf(placed.orderId))[0]!;
    const cash = await createRefund(t.db, staff(), { orderId: placed.orderId, paymentId: payment.id, amountIqd: 75_000, method: "cash", reason: "إعادة نقدية بعد حذف الحساب" }, NOW + 3 * HOUR);
    await approveRefund(t.db, staff(otherStaffId), cash.refundId, { approve: true }, NOW + 3 * HOUR);
    expect((await orderOf(placed.orderId)).paymentStatus).toBe("refunded");
  });
});

// ───────────────────────────────────────────────────────────────── a total of zero

describe("an order paid entirely by points and free delivery", BUDGET, () => {
  test("cash on delivery with nothing to pay: the order is paid when placed (nothing to collect) and its digital code is delivered", async () => {
    const customerId = await make.customer();
    await member(customerId, { freeShipping: true });
    await earnPoints(customerId, 3_000);
    const product = await digitalProduct(["FREE-ZERO-0001"], 25_000);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const body = await input(token, { redeemPoints: 2_500 }, customerId);
    expect(body.expectedTotalIqd).toBe(0);
    const placed = await placeOrder(t.db, who(token, customerId), body, NOW);
    expect(placed.paymentStatus).toBe("paid");
    expect(await orderOf(placed.orderId)).toMatchObject({ totalIqd: 0, paidIqd: 0, paymentStatus: "paid", status: "new" });
    expect((await paymentsOf(placed.orderId)).map((row) => [row.method, row.status, row.amountIqd])).toEqual([["cod", "paid", 0]]);
    expect((await codesOf(placed.orderId)).map((code) => code.status)).toEqual(["delivered"]);
    expect(await points(customerId)).toBe(500);
    // a transfer of nothing is never asked for
    const again = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    await earnPoints(customerId, 2_000);
    const transfer = await failureOf(placeOrder(t.db, who(again, customerId), await input(again, { redeemPoints: 2_500, paymentMethod: "bank_transfer" }, customerId), NOW));
    expect(transfer).toMatchObject({ code: "payment_method_unavailable", fields: { paymentMethod: "payment_method_unavailable" } });
  });
});
