/**
 * Commerce core, part 2 — orders: placeOrder (guest checkout, required Iraq delivery fields,
 * preferences, consent, payment methods, wallet, totals_changed, idempotency incl. two concurrent
 * submissions), the order state machine and its side effects (stock commit with serials,
 * warranties, revenue and COGS postings, cancellation releases and the refund path, parcels that
 * come back), and the shopper-facing reads (customer, access token, guest lookup, my orders).
 * Real local D1 (tests/helpers/db.ts).
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken, sha256Hex } from "~/lib/ids";
import { systemActor, type Actor } from "~/server/actor";
import {
  auditEvents,
  cartItems,
  carts,
  consents,
  couponRedemptions,
  coupons,
  guestContacts,
  journalEntries,
  journalLines,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  products,
  refunds,
  serials,
  stockLevels,
  stockMovements,
  stockReservations,
  usedUnits,
  variants,
  walletLedger,
  warranties,
} from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID, accountId, districtId, governorateId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { setSetting } from "~/server/settings.server";
import { addToCart, applyCoupon, getCartCount, getCartView } from "~/server/services/cart.server";
import { assignSerialsStatements, receiveStock, releaseOrderReservations } from "~/server/services/inventory/stock.server";
import { ORDER_TRANSITIONS, addMonthsBaghdad, getOrderByAccessToken, getOrderForCustomer, listOrdersForCustomer, lookupGuestOrder, transitionOrder } from "~/server/services/orders/manage.server";
import { CheckoutError, lineName, placeOrder, type CheckoutInput, type CheckoutWho } from "~/server/services/orders/place.server";
import { recordCodCollection } from "~/server/services/payments/payments.server";
import { approveRefund } from "~/server/services/refunds.server";
import { creditWallet, getWalletBalance } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;

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
  "orders.refund.create",
  "orders.refund.approve",
  "shipping.attempt.manage",
  "returns.rma.approve",
  "customers.wallet.adjust",
];
const staff = (permissions: Permission[] = ALL, id = staffId): Actor => ({ kind: "employee", id, permissions: new Set(permissions) });
const system = systemActor("test.orders");

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

/** A cart holding these lines; returns the cookie token. */
async function cartWith(lines: { variantId: string; qty: number }[], customerId: string | null = null): Promise<string> {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "en" }, { variantId: line.variantId, qty: line.qty }, NOW)).cartToken;
  return token as string;
}

const BAGHDAD = governorateId("baghdad");

async function expectedTotal(cartToken: string, customerId: string | null = null, governorate = BAGHDAD) {
  return (await getCartView(t.db, { cartToken, customerId, locale: "en", governorateId: governorate }, NOW)).totalIqd;
}

function who(cartToken: string | null, customerId: string | null = null, overrides: Partial<CheckoutWho> = {}): CheckoutWho {
  return { cartToken, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live", ...overrides };
}

async function input(cartToken: string, overrides: Partial<CheckoutInput> = {}, customerId: string | null = null): Promise<CheckoutInput> {
  return {
    idempotencyKey: randomToken(),
    phone: make.phone(),
    governorateId: BAGHDAD,
    districtId: districtId("baghdad", "karrada"),
    areaText: "الكرادة داخل",
    addressText: "شارع 62، قرب الجسر المعلق، عمارة 4، الطابق الثاني",
    marketingConsent: false,
    paymentMethod: "cod",
    expectedTotalIqd: await expectedTotal(cartToken, customerId, (overrides.governorateId as string | undefined) ?? BAGHDAD),
    ...overrides,
  };
}

async function level(variantId: string) {
  return t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
}

async function orderRow(orderId: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!row) throw new Error("order missing");
  return row;
}

async function countOrders() {
  return Number((await t.db.select({ n: sql<number>`count(*)` }).from(orders).get())?.n ?? 0);
}

/** A simple guest COD order of one product; returns everything a test needs. */
async function codOrder(options: { priceIqd?: number; qty?: number; stock?: number } = {}) {
  const product = await make.product({ priceIqd: options.priceIqd ?? 300_000, stock: options.stock ?? 5 });
  const token = await cartWith([{ variantId: product.variantId, qty: options.qty ?? 1 }]);
  const body = await input(token);
  const placed = await placeOrder(t.db, who(token), body, NOW);
  return { product, token, body, placed };
}

// ───────────────────────────────────────────────────────────────── placing

describe("placeOrder — guest checkout", () => {
  test("a guest buys without an account: cash on delivery, address and preferences stored, stock held, cart emptied", async () => {
    const product = await make.product({ priceIqd: 749_000, stock: 4 });
    const token = await cartWith([{ variantId: product.variantId, qty: 2 }]);
    const body = await input(token, { contactName: "علي حسن", phone: "0770 123 4567", notes: "اتصل قبل الوصول", preferredDay: "2026-11-12", preferredWindow: "evening" });
    expect(body.expectedTotalIqd).toBe(2 * 749_000 + 5_000);

    const placed = await placeOrder(t.db, who(token), body, NOW);
    expect(placed).toMatchObject({ paymentStatus: "cod_due", totalIqd: 1_503_000, replayed: false });
    expect(placed.ref).toMatch(/^TT-[2-9A-HJ-NP-Z]{8}$/);
    expect(placed.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const order = await orderRow(placed.orderId);
    expect(order).toMatchObject({
      channel: "web",
      status: "new",
      paymentStatus: "cod_due",
      paymentMethod: "cod",
      customerId: null,
      contactName: "علي حسن",
      contactPhoneE164: "+9647701234567",
      governorateId: BAGHDAD,
      districtId: districtId("baghdad", "karrada"),
      areaText: "الكرادة داخل",
      notes: "اتصل قبل الوصول",
      preferredDay: "2026-11-12",
      preferredWindow: "evening",
      marketingConsent: false,
      isDemo: false,
      subtotalIqd: 1_498_000,
      discountIqd: 0,
      shippingIqd: 5_000,
      taxIqd: 0,
      totalIqd: 1_503_000,
      paidIqd: 0,
      placedAt: NOW,
    });
    // Only the hash of the confirmation link's token is stored; the key is stored hashed too.
    expect(order.accessTokenHash).toBe(await sha256Hex(placed.accessToken));
    expect(JSON.stringify(order)).not.toContain(placed.accessToken);
    expect(order.idempotencyKey).not.toBe(body.idempotencyKey);
    const contact = await t.db.select().from(guestContacts).where(eq(guestContacts.id, order.guestContactId as string)).get();
    expect(contact).toMatchObject({ phoneE164: "+9647701234567", name: "علي حسن" });

    const lines = await t.db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ variantId: product.variantId, sku: product.sku, unitPriceIqd: 749_000, qty: 2, discountIqd: 0, totalIqd: 1_498_000, refundedQty: 0 });
    expect(lines[0].nameSnapshot.ar).toBe("جهاز للاختبار");

    const [payment] = await t.db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(payment).toMatchObject({ method: "cod", status: "pending", amountIqd: 1_503_000, idempotencyKey: `order:${order.id}:payment`, verifiedBy: null });

    expect(await level(product.variantId)).toMatchObject({ onHand: 4, reserved: 2 });
    const holds = await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.id));
    expect(holds.map((row) => ({ qty: row.qty, status: row.status, expiresAt: row.expiresAt }))).toEqual([{ qty: 2, status: "active", expiresAt: null }]);

    const cart = await t.db.select().from(carts).where(eq(carts.tokenHash, await sha256Hex(token))).get();
    expect(cart?.convertedOrderId).toBe(order.id);
    expect(await t.db.select().from(cartItems).where(eq(cartItems.cartId, cart!.id))).toEqual([]);
    expect(await getCartCount(t.db, { cartToken: token, customerId: null })).toBe(0);

    const events = await t.db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
    expect(events.map((event) => [event.kind, event.actorKind])).toEqual([["placed", "guest"]]);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, order.id), eq(auditEvents.action, "orders.order.place"))).get();
    expect(audit?.actorKind).toBe("guest");
    // No consent was given, so none is recorded.
    expect(await t.db.select().from(consents).where(eq(consents.subjectId, order.guestContactId as string))).toEqual([]);
  });

  test("required fields: phone, governorate, area and a detailed address; nothing is written when they are missing", async () => {
    const product = await make.product({ priceIqd: 100_000, stock: 3 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const before = await countOrders();
    const base = await input(token);

    const missing = await failureOf(placeOrder(t.db, who(token), { ...base, phone: "", areaText: "", addressText: "" }, NOW));
    expect(missing).toMatchObject({ code: "invalid", status: 400 });
    expect(missing.fields).toMatchObject({ phone: "required", areaText: "required", addressText: "too_short" });
    const noGovernorate = await failureOf(placeOrder(t.db, who(token), { ...base, governorateId: undefined as unknown as string }, NOW));
    expect(noGovernorate.fields).toMatchObject({ governorateId: "required" });

    expect((await failureOf(placeOrder(t.db, who(token), { ...base, phone: "12345" }, NOW))).fields).toEqual({ phone: "phone_invalid" });
    expect((await failureOf(placeOrder(t.db, who(token), { ...base, districtId: districtId("basra", "zubair") }, NOW))).fields).toEqual({ districtId: "district_invalid" });
    expect((await failureOf(placeOrder(t.db, who(token), { ...base, preferredDay: "2026-11-01" }, NOW))).fields).toEqual({ preferredDay: "preferred_day_invalid" });
    expect((await failureOf(placeOrder(t.db, who(token), { ...base, preferredDay: "2027-01-30" }, NOW))).fields).toEqual({ preferredDay: "preferred_day_invalid" });
    expect((await failureOf(placeOrder(t.db, who(token), { ...base, governorateId: "gov_atlantis" }, NOW))).code).toBe("shipping_unavailable");

    expect(await countOrders()).toBe(before);
    expect(await level(product.variantId)).toMatchObject({ reserved: 0 });
    // Arabic-Indic digits and the international form are the same phone.
    const placed = await placeOrder(t.db, who(token), { ...base, phone: "+964 ٧٧٠ ١٢٣ ٤٥٦٨" }, NOW);
    expect((await orderRow(placed.orderId)).contactPhoneE164).toBe("+9647701234568");
  });

  test("marketing consent is only stored when the shopper ticks it; demo mode flags the order", async () => {
    const product = await make.product({ priceIqd: 90_000, stock: 2 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const placed = await placeOrder(t.db, who(token, null, { storeMode: "demo", ip: "198.51.100.4" }), await input(token, { marketingConsent: true }), NOW);
    const order = await orderRow(placed.orderId);
    expect(order).toMatchObject({ marketingConsent: true, isDemo: true });
    const consent = await t.db.select().from(consents).where(eq(consents.subjectId, order.guestContactId as string)).get();
    expect(consent).toMatchObject({ subjectType: "guest_contact", kind: "marketing", granted: true, source: "checkout" });
  });

  test("a total that changed since the shopper looked: 409 totals_changed with the fresh cart, nothing written", async () => {
    const product = await make.product({ priceIqd: 200_000, stock: 2 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const body = await input(token);
    // The price goes up after the shopper reviewed the order.
    await t.db.update(variants).set({ priceIqd: 210_000 }).where(eq(variants.id, product.variantId));
    const before = await countOrders();
    let caught: unknown;
    try {
      await placeOrder(t.db, who(token), body, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CheckoutError);
    expect(caught).toMatchObject({ code: "totals_changed", status: 409 });
    expect((caught as CheckoutError).cart?.totalIqd).toBe(215_000);
    expect(await countOrders()).toBe(before);
    expect(await level(product.variantId)).toMatchObject({ reserved: 0 });
    const placed = await placeOrder(t.db, who(token), { ...body, expectedTotalIqd: 215_000 }, NOW);
    expect(placed.totalIqd).toBe(215_000);
  });

  test("a payment method switched off in settings cannot be chosen", async () => {
    const product = await make.product({ priceIqd: 50_000, stock: 2 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    await setSetting(t.db, system, "payments.zaincash", { enabled: false, number: "07719061852" }, "اختبار إيقاف زين كاش", NOW);
    try {
      const failure = await failureOf(placeOrder(t.db, who(token), await input(token, { paymentMethod: "zaincash" }), NOW));
      expect(failure).toMatchObject({ code: "payment_method_unavailable", status: 409, fields: { paymentMethod: "payment_method_unavailable" } });
    } finally {
      await setSetting(t.db, system, "payments.zaincash", { enabled: true, number: "07719061852" }, "إعادة تفعيل زين كاش", NOW);
    }
  });

  test("bank transfer: awaiting payment, the payment row waits for a proof, stock is held until the proof window ends", async () => {
    const product = await make.product({ priceIqd: 120_000, stock: 2 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const placed = await placeOrder(t.db, who(token), await input(token, { paymentMethod: "bank_transfer" }), NOW);
    expect(placed.paymentStatus).toBe("unpaid");
    const order = await orderRow(placed.orderId);
    expect(order).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", paymentDueAt: NOW + 24 * HOUR });
    expect(await t.db.select({ status: payments.status, method: payments.method }).from(payments).where(eq(payments.orderId, order.id))).toEqual([{ status: "pending", method: "bank_transfer" }]);
    expect((await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.id)))[0]).toMatchObject({ status: "active", expiresAt: NOW + 24 * HOUR });

    // The confirmation page shows where to send the money — from settings.
    const view = await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "ar", NOW);
    expect(view?.payment).toMatchObject({
      method: "bank_transfer",
      status: "unpaid",
      amountDueIqd: 125_000,
      dueAt: NOW + 24 * HOUR,
      instructions: { method: "bank_transfer", accountNumber: "9269317427", recipientName: "علي خليفة" },
      proof: { status: "none" },
      canUploadProof: true,
    });
  });

  test("a cart whose every line sold out or went off sale is cart_blocked (with the cart, lines marked); only a cart with no lines is cart_empty", async () => {
    // The last unit goes to the first shopper; the second shopper's only line is now sold out.
    const last = await make.product({ priceIqd: 90_000, stock: 1 });
    const firstToken = await cartWith([{ variantId: last.variantId, qty: 1 }]);
    const lateToken = await cartWith([{ variantId: last.variantId, qty: 1 }]);
    const lateBody = await input(lateToken);
    await placeOrder(t.db, who(firstToken), await input(firstToken), NOW);
    const before = await countOrders();
    const soldOut = await failureOf(placeOrder(t.db, who(lateToken), lateBody, NOW));
    expect(soldOut).toBeInstanceOf(CheckoutError);
    expect(soldOut).toMatchObject({ code: "cart_blocked", status: 409 });
    expect((soldOut as CheckoutError).cart).toMatchObject({ blocked: true, lines: [{ variantId: last.variantId, problem: "out_of_stock" }] });

    // Every line off sale (the product was archived): blocked as well.
    const archived = await make.product({ priceIqd: 40_000, stock: 3 });
    const archivedToken = await cartWith([{ variantId: archived.variantId, qty: 1 }]);
    const archivedBody = await input(archivedToken);
    await t.db.update(products).set({ status: "archived" }).where(eq(products.id, archived.productId));
    expect(await failureOf(placeOrder(t.db, who(archivedToken), archivedBody, NOW))).toMatchObject({ code: "cart_blocked", cart: { lines: [{ problem: "unavailable" }] } });

    // No cart behind the cookie, or a cart without lines: cart_empty.
    expect(await failureOf(placeOrder(t.db, who(randomToken()), { ...lateBody, idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "cart_empty", status: 409 });
    const [emptied] = await t.db.select({ id: carts.id }).from(carts).where(eq(carts.tokenHash, await sha256Hex(archivedToken)));
    await t.db.delete(cartItems).where(eq(cartItems.cartId, emptied.id));
    expect(await failureOf(placeOrder(t.db, who(archivedToken), { ...archivedBody, idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "cart_empty" });
    expect(await countOrders()).toBe(before);
  });

  test("an order line's name never says the product's name twice", async () => {
    const named = async (name: { ar: string; en?: string; ckb?: string }, title: { ar: string; en?: string; ckb?: string } | null) => {
      const product = await make.product({ priceIqd: 70_000, stock: 2 });
      await t.db.update(products).set({ name }).where(eq(products.id, product.productId));
      await t.db.update(variants).set({ title }).where(eq(variants.id, product.variantId));
      const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
      const placed = await placeOrder(t.db, who(token), await input(token), NOW);
      const [line] = await t.db.select({ name: orderItems.nameSnapshot }).from(orderItems).where(eq(orderItems.orderId, placed.orderId));
      return line.name;
    };
    // The variant title already names the product: it is the whole name.
    expect(
      await named(
        { ar: "Resident Evil Requiem", en: "Resident Evil Requiem", ckb: "Resident Evil Requiem" },
        { ar: "Resident Evil Requiem لجهاز PS5", en: "Resident Evil Requiem for PS5", ckb: "Resident Evil Requiem بۆ PS5" },
      ),
    ).toEqual({ ar: "Resident Evil Requiem لجهاز PS5", en: "Resident Evil Requiem for PS5", ckb: "Resident Evil Requiem بۆ PS5" });
    // The title opens with the product's short name: only its detail follows the product's name.
    expect(
      await named({ ar: "يد التحكم اللاسلكية DualSense", en: "DualSense Wireless Controller", ckb: "کۆنتڕۆڵەری بێتەلی DualSense" }, { ar: "DualSense – أبيض", en: "DualSense – White", ckb: "DualSense – سپی" }),
    ).toEqual({ ar: "يد التحكم اللاسلكية DualSense — أبيض", en: "DualSense Wireless Controller — White", ckb: "کۆنتڕۆڵەری بێتەلی DualSense — سپی" });
    // A plain title is joined as before; a locale without its own title borrows the Arabic one.
    expect(await named({ ar: "بلايستيشن 5 سليم", en: "PlayStation 5 Slim" }, { ar: "نسخة الأقراص" })).toEqual({ ar: "بلايستيشن 5 سليم — نسخة الأقراص", en: "PlayStation 5 Slim — نسخة الأقراص" });
    // Whole words only: "PS5" in a title is not the product "PS".
    expect(lineName({ ar: "PS" }, { ar: "PS5 – أسود" })).toEqual({ ar: "PS — PS5 – أسود" });
    expect(lineName({ ar: "FC 26", en: "FC 26" }, { ar: "EA SPORTS FC 26  لجهاز PS5", en: "EA Sports fc 26 for PS5" })).toEqual({ ar: "EA SPORTS FC 26  لجهاز PS5", en: "EA Sports fc 26 for PS5" });
    expect(lineName({ ar: "جهاز" }, null)).toEqual({ ar: "جهاز" });
  });
});

describe("placeOrder — wallet", () => {
  test("guests cannot pay from a wallet (403); an account cannot overdraw it, and a failed wallet order leaves nothing behind", async () => {
    const product = await make.product({ priceIqd: 400_000, stock: 3 });
    const guestToken = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const guest = await failureOf(placeOrder(t.db, who(guestToken), await input(guestToken, { paymentMethod: "wallet" }), NOW));
    expect(guest).toMatchObject({ code: "wallet_requires_account", status: 403 });

    const customerId = await make.customer();
    await creditWallet(t.db, staff(), { customerId, amountIqd: 100_000, kind: "topup", reason: "شحن تجريبي للمحفظة", idempotencyKey: randomToken(), fundedBy: "cash" }, NOW);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const before = await countOrders();
    const poor = await failureOf(placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW));
    expect(poor).toMatchObject({ code: "wallet_insufficient", status: 409 });
    // The overdraft trigger rolled the WHOLE order back: no order, no hold, the cart untouched, the ledger untouched.
    expect(await countOrders()).toBe(before);
    expect(await level(product.variantId)).toMatchObject({ reserved: 0 });
    const cart = await t.db.select().from(carts).where(eq(carts.tokenHash, await sha256Hex(token))).get();
    expect(cart?.convertedOrderId).toBeNull();
    expect(await getCartCount(t.db, { cartToken: token, customerId })).toBe(1);
    expect(await getWalletBalance(t.db, customerId)).toBe(100_000);
  });

  test("a signed-in customer pays from the wallet: confirmed and paid in the same batch as the ledger debit and its journal entry", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, staff(), { customerId, amountIqd: 500_000, kind: "topup", reason: "شحن تجريبي للمحفظة", idempotencyKey: randomToken(), fundedBy: "bank_clearing" }, NOW);
    const product = await make.product({ priceIqd: 150_000, stock: 2 });
    const token = await cartWith([{ variantId: product.variantId, qty: 2 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW);
    expect(placed).toMatchObject({ paymentStatus: "paid", totalIqd: 305_000 });
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidIqd: 305_000, confirmedAt: NOW, customerId, guestContactId: null });
    expect(await getWalletBalance(t.db, customerId)).toBe(195_000);
    const debit = await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, `order:${placed.orderId}:wallet`)).get();
    expect(debit).toMatchObject({ customerId, amountIqd: -305_000, kind: "purchase", refType: "order", refId: placed.orderId });
    const [payment] = await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId));
    expect(payment).toMatchObject({ method: "wallet", status: "paid", amountIqd: 305_000, walletLedgerId: debit?.id });
    const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `payment:${payment.id}:received`)).get();
    const lines = await t.db.select({ accountId: journalLines.accountId, debit: journalLines.debitIqd, credit: journalLines.creditIqd }).from(journalLines).where(eq(journalLines.entryId, entry!.id));
    expect(lines).toEqual(
      expect.arrayContaining([
        { accountId: accountId("wallet_liability"), debit: 305_000, credit: 0 },
        { accountId: accountId("cod_receivable"), debit: 0, credit: 305_000 },
      ]),
    );
  });
});

describe("placeOrder — idempotency", () => {
  test("a retry with the same key returns the first result and writes nothing twice; another shopper cannot replay it", async () => {
    const product = await make.product({ priceIqd: 80_000, stock: 5 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const body = await input(token);
    const first = await placeOrder(t.db, who(token), body, NOW);
    const again = await placeOrder(t.db, who(token), body, NOW + 1000);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await t.db.select().from(payments).where(eq(payments.orderId, first.orderId))).toHaveLength(1);
    expect(await level(product.variantId)).toMatchObject({ reserved: 1 });

    const strangerToken = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    expect(await failureOf(placeOrder(t.db, who(strangerToken), body, NOW))).toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  test("two submissions at the same moment (double click) create ONE order, one payment and one stock hold", async () => {
    const product = await make.product({ priceIqd: 60_000, stock: 5 });
    const token = await cartWith([{ variantId: product.variantId, qty: 2 }]);
    const body = await input(token);
    const results = await Promise.all([placeOrder(t.db, who(token), body, NOW), placeOrder(t.db, who(token), body, NOW)]);
    expect(results[0].ref).toBe(results[1].ref);
    expect(results[0].accessToken).toBe(results[1].accessToken);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    const placed = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, results[0].ref));
    expect(placed).toHaveLength(1);
    expect(await t.db.select().from(payments).where(eq(payments.orderId, placed[0].id))).toHaveLength(1);
    expect(await level(product.variantId)).toMatchObject({ onHand: 5, reserved: 2 });
    expect(await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed[0].id))).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── transitions

describe("transitionOrder", () => {
  test("the state machine: allowed moves only, payment moves refused, permissions enforced, repeats harmless", async () => {
    expect(ORDER_TRANSITIONS.new).toEqual(["confirmed", "cancelled"]);
    const { placed } = await codOrder();
    expect(await failureOf(transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW))).toMatchObject({ code: "transition_not_allowed", status: 409 });
    expect(await failureOf(transitionOrder(t.db, staff([]), placed.orderId, "confirmed", {}, NOW))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await failureOf(transitionOrder(t.db, { kind: "customer", id: "cus_x" }, placed.orderId, "confirmed", {}, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(transitionOrder(t.db, staff(), "ord_missing", "confirmed", {}, NOW))).toMatchObject({ code: "not_found", status: 404 });

    await transitionOrder(t.db, staff(["orders.order.update"]), placed.orderId, "confirmed", {}, NOW + 1000);
    await transitionOrder(t.db, staff(["orders.order.update"]), placed.orderId, "confirmed", {}, NOW + 2000);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "confirmed", confirmedAt: NOW + 1000 });
    const events = await t.db.select({ kind: orderEvents.kind, data: orderEvents.data, actorKind: orderEvents.actorKind, actorId: orderEvents.actorId }).from(orderEvents).where(eq(orderEvents.orderId, placed.orderId));
    expect(events.filter((event) => event.kind === "status_changed")).toEqual([{ kind: "status_changed", data: { from: "new", to: "confirmed", reason: null }, actorKind: "employee", actorId: staffId }]);
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, placed.orderId), eq(auditEvents.action, "orders.order.confirm")))).toHaveLength(1);

    const transfer = await make.product({ priceIqd: 70_000, stock: 2 });
    const token = await cartWith([{ variantId: transfer.variantId, qty: 1 }]);
    const pending = await placeOrder(t.db, who(token), await input(token, { paymentMethod: "zaincash" }), NOW);
    expect(await failureOf(transitionOrder(t.db, staff(), pending.orderId, "payment_review", {}, NOW))).toMatchObject({ code: "transition_payment_driven" });
    // Cancelling needs a reason.
    expect((await failureOf(transitionOrder(t.db, staff(), pending.orderId, "cancelled", {}, NOW))).fields).toEqual({ reason: "required" });
  });

  test("ship needs every serial scanned; shipping commits the stock at FIFO cost; delivery starts warranties and books revenue and COGS", async () => {
    const product = await make.product({ priceIqd: 900_000, trackSerials: true });
    await t.db.update(products).set({ warrantyMonths: 12 }).where(eq(products.id, product.productId));
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 700_000, serials: [`SN-${product.sku}-A`, `SN-${product.sku}-B`], ref: "test-receipt" }, NOW);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const placed = await placeOrder(t.db, who(token), await input(token), NOW);
    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW);
    await transitionOrder(t.db, staff(), placed.orderId, "preparing", {}, NOW);

    const shipFailure = await failureOf(transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW));
    expect(shipFailure).toMatchObject({ code: "serials_required", status: 409, fields: { items: "serials_required" } });
    expect(await level(product.variantId)).toMatchObject({ onHand: 2, reserved: 1 });

    const [line] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
    const serial = await t.db.select().from(serials).where(eq(serials.serial, `SN-${product.sku}-A`)).get();
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: line.id, serialIds: [serial!.id], actor: staff(), now: NOW }));
    await transitionOrder(t.db, staff(["orders.fulfillment.ship"]), placed.orderId, "shipped", {}, NOW + HOUR);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "shipped", shippedAt: NOW + HOUR });
    expect(await level(product.variantId)).toMatchObject({ onHand: 1, reserved: 0 });
    const sale = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, placed.orderId), eq(stockMovements.kind, "sale")));
    expect(sale.map((row) => [row.qtyDelta, row.unitCostIqd])).toEqual([[-1, 700_000]]);
    expect((await t.db.select({ status: serials.status }).from(serials).where(eq(serials.id, serial!.id)).get())?.status).toBe("sold");

    const deliveredAt = NOW + 2 * 24 * HOUR;
    await transitionOrder(t.db, staff(["orders.fulfillment.deliver"]), placed.orderId, "delivered", {}, deliveredAt);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "delivered", deliveredAt });
    const warranty = await t.db.select().from(warranties).where(eq(warranties.orderItemId, line.id));
    expect(warranty).toEqual([expect.objectContaining({ serialId: serial!.id, startsAt: deliveredAt, endsAt: addMonthsBaghdad(deliveredAt, 12), status: "active", phoneE164: (await orderRow(placed.orderId)).contactPhoneE164 })]);

    const postings = await t.db
      .select({ key: journalEntries.idempotencyKey, account: journalLines.accountId, debit: journalLines.debitIqd, credit: journalLines.creditIqd })
      .from(journalEntries)
      .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalEntries.refType, "order"), eq(journalEntries.refId, placed.orderId)));
    expect(postings).toEqual(
      expect.arrayContaining([
        { key: `order:${placed.orderId}:sale`, account: accountId("cod_receivable"), debit: 905_000, credit: 0 },
        { key: `order:${placed.orderId}:sale`, account: accountId("sales_revenue"), debit: 0, credit: 900_000 },
        { key: `order:${placed.orderId}:sale`, account: accountId("shipping_income"), debit: 0, credit: 5_000 },
        { key: `order:${placed.orderId}:cogs`, account: accountId("cogs"), debit: 700_000, credit: 0 },
        { key: `order:${placed.orderId}:cogs`, account: accountId("inventory"), debit: 0, credit: 700_000 },
      ]),
    );
    expect(postings).toHaveLength(5);

    // The courier hands over the cash: the receivable is settled.
    await recordCodCollection(t.db, staff(["orders.payment.record"]), placed.orderId, 905_000, deliveredAt + HOUR);
    expect(await orderRow(placed.orderId)).toMatchObject({ paymentStatus: "paid", paidIqd: 905_000 });
    const receivable = await t.db.all<{ balance: number }>(sql`
      SELECT coalesce(sum(l.debit_iqd), 0) - coalesce(sum(l.credit_iqd), 0) AS balance
      FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
      WHERE l.account_id = ${accountId("cod_receivable")} AND (e.ref_id = ${placed.orderId} OR e.ref_id IN (SELECT id FROM payments WHERE order_id = ${placed.orderId}))`);
    expect(Number(receivable[0].balance)).toBe(0);
  });

  test("an order that no longer holds its stock cannot ship", async () => {
    const { placed, product } = await codOrder();
    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW);
    await releaseOrderReservations(t.db, system, placed.orderId, "test: released by hand", NOW);
    expect(await failureOf(transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW))).toMatchObject({ code: "stock_not_reserved", status: 409 });
    expect(await level(product.variantId)).toMatchObject({ onHand: 5, reserved: 0 });
    expect((await orderRow(placed.orderId)).status).toBe("confirmed");
  });

  test("cancel releases the stock, frees the coupon, cancels the unpaid payment and records the reason", async () => {
    const product = await make.product({ priceIqd: 250_000, stock: 3 });
    const code = `CANCEL${make.next("C").slice(-4)}`;
    await t.db.insert(coupons).values({ id: `cpn_${code}`, code, kind: "fixed", value: 10_000, isActive: true, createdAt: NOW });
    const token = await cartWith([{ variantId: product.variantId, qty: 2 }]);
    await applyCoupon(t.db, { cartToken: token, customerId: null }, code, NOW);
    const placed = await placeOrder(t.db, who(token), await input(token), NOW);
    expect(await orderRow(placed.orderId)).toMatchObject({ discountIqd: 10_000, couponCode: code });
    expect(await level(product.variantId)).toMatchObject({ reserved: 2 });

    await transitionOrder(t.db, staff(["orders.order.cancel"]), placed.orderId, "cancelled", { reason: "العميل ألغى هاتفياً" }, NOW + HOUR);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "cancelled", cancelledAt: NOW + HOUR, cancelReason: "العميل ألغى هاتفياً", paymentStatus: "unpaid" });
    expect(await level(product.variantId)).toMatchObject({ onHand: 3, reserved: 0 });
    expect((await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, placed.orderId))).map((row) => row.status)).toEqual(["released"]);
    expect((await t.db.select().from(couponRedemptions).where(eq(couponRedemptions.orderId, placed.orderId)).get())?.voidedAt).toBe(NOW + HOUR);
    expect((await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId)).get())?.status).toBe("cancelled");
    const view = await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "en", NOW);
    expect(view).toMatchObject({ status: "cancelled", payment: { amountDueIqd: 0 } });
    expect(view?.timeline.map((entry) => entry.kind)).toEqual(["placed", "cancelled"]);
  });

  test("cancelling while packing puts the scanned serials back in stock and releases their link (history kept)", async () => {
    const product = await make.product({ priceIqd: 650_000, trackSerials: true });
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 1, unitCostIqd: 500_000, serials: [`SN-${product.sku}-P`], ref: "test-receipt" }, NOW);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const placed = await placeOrder(t.db, who(token), await input(token), NOW);
    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW);
    await transitionOrder(t.db, staff(), placed.orderId, "preparing", {}, NOW);
    const [line] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
    const serial = (await t.db.select().from(serials).where(eq(serials.serial, `SN-${product.sku}-P`)).get())!;
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: line.id, serialIds: [serial.id], actor: staff(), now: NOW }));
    expect((await t.db.select({ status: serials.status }).from(serials).where(eq(serials.id, serial.id)).get())?.status).toBe("sold");

    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "طلب العميل الإلغاء أثناء التجهيز" }, NOW + HOUR);
    expect((await t.db.select({ status: serials.status }).from(serials).where(eq(serials.id, serial.id)).get())?.status).toBe("in_stock");
    expect(await t.db.select({ releasedAt: orderItemSerials.releasedAt }).from(orderItemSerials).where(eq(orderItemSerials.serialId, serial.id))).toEqual([{ releasedAt: NOW + HOUR }]);
    expect(await level(product.variantId)).toMatchObject({ onHand: 1, reserved: 0 });
  });

  test("cancelling a paid order starts the refund path: a pending refund that a second person issues", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, staff(), { customerId, amountIqd: 300_000, kind: "topup", reason: "شحن تجريبي للمحفظة", idempotencyKey: randomToken(), fundedBy: "cash" }, NOW);
    const product = await make.product({ priceIqd: 95_000, stock: 2 });
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
    const placed = await placeOrder(t.db, who(token, customerId), await input(token, { paymentMethod: "wallet" }, customerId), NOW);
    expect(await getWalletBalance(t.db, customerId)).toBe(200_000);

    await transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "نفد المنتج من المورد" }, NOW + HOUR);
    const order = await orderRow(placed.orderId);
    expect(order).toMatchObject({ status: "cancelled", paymentStatus: "paid", paidIqd: 100_000 });
    const refund = await t.db.select().from(refunds).where(eq(refunds.orderId, placed.orderId)).get();
    expect(refund).toMatchObject({ status: "pending", method: "original", amountIqd: 100_000, createdBy: staffId });

    expect(await failureOf(approveRefund(t.db, staff(), refund!.id, { approve: true }, NOW + 2 * HOUR))).toMatchObject({ code: "approver_is_requester", status: 403 });
    await approveRefund(t.db, staff(ALL, otherStaffId), refund!.id, { approve: true }, NOW + 2 * HOUR);
    expect(await getWalletBalance(t.db, customerId)).toBe(300_000);
    expect(await orderRow(placed.orderId)).toMatchObject({ paymentStatus: "refunded", refundedIqd: 100_000 });
  });

  test("a parcel that comes back undelivered: goods restocked, the cash-on-delivery payment cancelled", async () => {
    const { placed, product } = await codOrder({ qty: 2, stock: 4 });
    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW);
    await transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW);
    expect(await level(product.variantId)).toMatchObject({ onHand: 2, reserved: 0 });
    expect((await failureOf(transitionOrder(t.db, staff(), placed.orderId, "returned", {}, NOW))).fields).toEqual({ reason: "required" });
    expect(await failureOf(transitionOrder(t.db, staff(["orders.order.update"]), placed.orderId, "returned", { reason: "رفض الاستلام" }, NOW))).toMatchObject({ code: "forbidden" });

    await transitionOrder(t.db, staff(["shipping.attempt.manage"]), placed.orderId, "returned", { reason: "العميل رفض الاستلام" }, NOW + HOUR);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "returned", paymentStatus: "unpaid" });
    expect(await level(product.variantId)).toMatchObject({ onHand: 4, reserved: 0 });
    expect((await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId)).get())?.status).toBe("cancelled");
    const back = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, placed.orderId), eq(stockMovements.kind, "return")));
    expect(back.reduce((sum, row) => sum + row.qtyDelta, 0)).toBe(2);
    // Nothing was delivered, so nothing was recognised: no revenue entry.
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `order:${placed.orderId}:sale`))).toEqual([]);
  });
});

describe("transitionOrder — returned after delivery", () => {
  test("is a status change only: goods and money go through the refund flow with inspection", async () => {
    const { placed, product } = await codOrder({ qty: 1, stock: 2 });
    for (const to of ["confirmed", "shipped", "delivered"] as const) await transitionOrder(t.db, staff(), placed.orderId, to, {}, NOW);
    expect(await failureOf(transitionOrder(t.db, staff(["shipping.attempt.manage"]), placed.orderId, "returned", { reason: "أعاد العميل الطلب" }, NOW))).toMatchObject({ code: "forbidden" });
    await transitionOrder(t.db, staff(["returns.rma.approve"]), placed.orderId, "returned", { reason: "أعاد العميل الطلب كاملاً" }, NOW + HOUR);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "returned", paymentStatus: "cod_due" });
    expect(await level(product.variantId)).toMatchObject({ onHand: 1, reserved: 0 });
    expect(await failureOf(transitionOrder(t.db, staff(), placed.orderId, "cancelled", { reason: "متأخر جداً" }, NOW))).toMatchObject({ code: "transition_not_allowed" });
  });
});

// ───────────────────────────────────────────────────────────────── reads

describe("reads", () => {
  test("a customer sees their own orders only, newest first, in pages", async () => {
    const customerId = await make.customer();
    const someoneElse = await make.customer();
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const product = await make.product({ priceIqd: 10_000 * (i + 1), stock: 1 });
      const token = await cartWith([{ variantId: product.variantId, qty: 1 }], customerId);
      refs.push((await placeOrder(t.db, who(token, customerId), await input(token, {}, customerId), NOW + i * 1000)).ref);
    }
    expect(await getOrderForCustomer(t.db, customerId, refs[0].toLowerCase(), "en")).toMatchObject({ ref: refs[0], status: "new" });
    expect(await getOrderForCustomer(t.db, someoneElse, refs[0], "en")).toBeNull();

    const first = await listOrdersForCustomer(t.db, customerId, "en", { limit: 2 });
    expect(first.total).toBe(3);
    expect(first.items.map((item) => item.ref)).toEqual([refs[2], refs[1]]);
    expect(first.items[0]).toMatchObject({ status: "new", paymentStatus: "cod_due", paymentMethod: "cod", itemCount: 1, firstItemName: "Test console", isDemo: false });
    const second = await listOrdersForCustomer(t.db, customerId, "en", { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.ref)).toEqual([refs[0]]);
    expect(second.nextCursor).toBeNull();
    expect((await listOrdersForCustomer(t.db, someoneElse, "en")).items).toEqual([]);
  });

  test("the confirmation link needs the right token; the view carries no cost data and masks the phone", async () => {
    const product = await make.product({ priceIqd: 333_000, stock: 2 });
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 1, unitCostIqd: 271_828, ref: "cost-probe" }, NOW);
    const token = await cartWith([{ variantId: product.variantId, qty: 1 }]);
    const placed = await placeOrder(t.db, who(token), await input(token, { phone: "07719061899" }), NOW);
    expect(await getOrderByAccessToken(t.db, placed.ref, randomToken(), "ar")).toBeNull();
    expect(await getOrderByAccessToken(t.db, "TT-NOPE2345", placed.accessToken, "ar")).toBeNull();
    const view = await getOrderByAccessToken(t.db, placed.ref, placed.accessToken, "ar", NOW);
    expect(view).toMatchObject({ ref: placed.ref, contact: { phoneMasked: "0771 ••• ••99" }, delivery: { governorate: "بغداد", district: "الكرادة" } });
    const json = JSON.stringify(view);
    expect(json).not.toContain("271828");
    expect(json).not.toMatch(/cost/i);
    expect(json).not.toContain("+9647719061899");
  });

  test("guest lookup needs the reference AND the phone, answers wrong ref and wrong phone identically, and is rate-limited", async () => {
    const { placed, body } = await codOrder();
    const localPhone = `0${String(body.phone).slice(4)}`;
    const ctx = { ip: "203.0.113.50", locale: "en" as const };
    expect(await lookupGuestOrder(t.db, { ref: placed.ref.toLowerCase(), phone: localPhone }, ctx, NOW)).toMatchObject({ ref: placed.ref });
    const wrongPhone = await lookupGuestOrder(t.db, { ref: placed.ref, phone: "07809999999" }, ctx, NOW);
    const wrongRef = await lookupGuestOrder(t.db, { ref: "TT-ZZZZ2345", phone: localPhone }, ctx, NOW);
    expect(wrongPhone).toBeNull();
    expect(wrongRef).toBeNull();
    expect(await failureOf(lookupGuestOrder(t.db, { ref: placed.ref, phone: "123" }, ctx, NOW))).toMatchObject({ code: "invalid", fields: { phone: "phone_invalid" } });

    // 10 lookups per IP per 15 minutes: 3 used above, the 11th is refused.
    for (let i = 0; i < 7; i++) await lookupGuestOrder(t.db, { ref: "TT-ZZZZ2346", phone: localPhone }, ctx, NOW);
    expect(await failureOf(lookupGuestOrder(t.db, { ref: placed.ref, phone: localPhone }, ctx, NOW))).toMatchObject({ code: "rate_limited", status: 429 });
  });
});

// ───────────────────────────────────────────────────────────────── with the demo catalogue

describe("with the demo catalogue", () => {
  beforeAll(async () => {
    await seedDemo(t.db, NOW);
  });

  test("a used device: reserved at checkout, sold at shipping (serial attached), its warranty in days starts at delivery", async () => {
    // Chosen by properties, not by a demo slug: a listed unit with a serial, a warranty and a known cost.
    const unit = await t.db
      .select()
      .from(usedUnits)
      .where(and(eq(usedUnits.status, "listed"), sql`${usedUnits.serialId} IS NOT NULL`, sql`${usedUnits.warrantyDays} > 0`, sql`${usedUnits.acquisitionCostIqd} IS NOT NULL`))
      .limit(1)
      .get();
    expect(unit).toBeDefined();
    const added = await addToCart(t.db, { cartToken: null, customerId: null, locale: "en" }, { usedUnitId: unit!.id }, NOW);
    const placed = await placeOrder(t.db, who(added.cartToken), await input(added.cartToken), NOW);
    expect((await t.db.select({ status: usedUnits.status }).from(usedUnits).where(eq(usedUnits.id, unit!.id)).get())?.status).toBe("reserved");

    await transitionOrder(t.db, staff(), placed.orderId, "confirmed", {}, NOW);
    await transitionOrder(t.db, staff(), placed.orderId, "shipped", {}, NOW);
    expect((await t.db.select({ status: usedUnits.status }).from(usedUnits).where(eq(usedUnits.id, unit!.id)).get())?.status).toBe("sold");
    await transitionOrder(t.db, staff(), placed.orderId, "delivered", {}, NOW + HOUR);
    const [warranty] = await t.db.select().from(warranties).where(eq(warranties.usedUnitId, unit!.id));
    expect(warranty).toMatchObject({ serialId: unit!.serialId, startsAt: NOW + HOUR, endsAt: NOW + HOUR + unit!.warrantyDays * 24 * HOUR });
    // Cost of goods of a used unit = its acquisition cost.
    const cogs = await t.db
      .select({ debit: journalLines.debitIqd })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalEntries.idempotencyKey, `order:${placed.orderId}:cogs`), eq(journalLines.accountId, accountId("cogs"))))
      .get();
    expect(cogs?.debit).toBe(unit!.acquisitionCostIqd);
  });
});
