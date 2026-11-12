/**
 * ACCEPTANCE — the client's brief §14 (checkout, shipping, wallet, transfers, retries) and §12 (the cart's failure
 * states), proven through the same server path the storefront's checkout action uses (placeCheckout → placeOrder, the
 * proof endpoint, guest tracking) against a real local D1. Staff decisions are made by actors holding exactly the
 * permissions of a built-in role (defaultRolePermissions), so "the role that owns it" is the role of docs/ARCHITECTURE.
 * docs/ACCEPTANCE.md maps every test name here to its brief criterion. The browser half of the same criteria is
 * proven by the puppeteer flows listed there (flow-checkout.mjs, flow-cart.mjs, …).
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import type { Actor } from "~/server/actor";
import { coupons, loyaltyLedger, orders, payments, paymentProofs, products, stockLevels, walletLedger } from "~/server/db/schema";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, type DefaultRoleKey } from "~/server/permissions";
import { kvBlobStore } from "~/server/storage.server";
import { setOverrideFee, setOverridesEnabled } from "~/server/services/admin/shipping/zones.server";
import { addToCart, applyCoupon, changeLineQty, getCartView } from "~/server/services/cart.server";
import type { CheckoutWho } from "~/server/services/orders/place.server";
import { verifyPayment } from "~/server/services/payments/payments.server";
import { getShippingFee } from "~/server/services/shipping/fees.server";
import { creditWallet, getWalletBalance } from "~/server/services/wallet.server";
import { draftToForm, EMPTY_DRAFT, newAttemptKey } from "~/routes/storefront/checkout/checkout-form";
import { findOrderForShopper, loadCheckoutData, placeCheckout, trackOrder } from "~/routes/storefront/checkout/checkout.server";
import { handleProofUpload } from "~/routes/storefront/checkout/proof.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const BAGHDAD = governorateId("baghdad");

let t: TestDb;
let make: Fixtures;
const staffIds = new Map<DefaultRoleKey, string>();

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  for (const role of ["owner", "manager", "finance", "fulfillment", "support", "cashier"] as const) staffIds.set(role, await make.employee());
});
afterAll(async () => {
  await t?.dispose();
});

/** An employee holding exactly the default permissions of a built-in role. */
const as = (role: DefaultRoleKey): Actor => ({ kind: "employee", id: staffIds.get(role)!, permissions: defaultRolePermissions(role) });
const who = (cartToken: string | null, customerId: string | null = null): CheckoutWho => ({ cartToken, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "demo" });
const typed = (e164: string) => `0${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}`;
const count = async (table: typeof orders | typeof walletLedger | typeof payments) => Number((await t.db.select({ n: sql<number>`count(*)` }).from(table).get())?.n ?? 0);

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const app = toAppError(error);
    if (!app) throw error;
    return app;
  }
  throw new Error("expected a refusal");
}

async function cartWith(options: { stock?: number; qty?: number; priceIqd?: number; customerId?: string | null; governorate?: string } = {}) {
  const product = await make.product({ stock: options.stock ?? 5, priceIqd: options.priceIqd ?? 250_000 });
  const customerId = options.customerId ?? null;
  const { cartToken } = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: product.variantId, qty: options.qty ?? 1 }, NOW);
  const view = await getCartView(t.db, { cartToken, customerId, locale: "ar", governorateId: options.governorate ?? BAGHDAD }, NOW);
  return { product, cartToken, view };
}

function form(totalIqd: number, overrides: Record<string, string> = {}): FormData {
  const values: Record<string, string> = {
    ...draftToForm(
      { ...EMPTY_DRAFT, phone: typed(make.phone()), governorateId: BAGHDAD, districtId: districtId("baghdad", "karrada"), areaText: "الكرادة داخل", addressText: "شارع 62، قرب جامع الكرادة، دار 14", paymentMethod: "cod" },
      { idempotencyKey: newAttemptKey(), expectedTotalIqd: totalIqd },
    ),
    ...overrides,
  };
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body;
}

async function orderRow(ref: string) {
  const row = await t.db.select().from(orders).where(eq(orders.ref, ref)).get();
  if (!row) throw new Error(`order ${ref} missing`);
  return row;
}

/** A tiny real PNG (the proof endpoint checks magic bytes). */
function png(seed = "x"): { bytes: Uint8Array; name: string; type: string } {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
  const bytes = new Uint8Array([...Buffer.from(base64, "base64"), ...Buffer.from(seed)]);
  return { bytes, name: "receipt.png", type: "image/png" };
}
function proofRequest(fields: Record<string, string>, file = png()): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  body.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return new Request("http://localhost/api/upload/proof", { method: "POST", body });
}
const upload = (fields: Record<string, string>, file = png(), now = NOW) => handleProofUpload({ db: t.db, store: kvBlobStore(t.kv), customerId: null, ip: null, locale: "ar", now }, proofRequest(fields, file));

// ───────────────────────────────────────────────────────────────── §14.1

describe("§14.1 a guest can purchase without registering", () => {
  test("acceptance 14.1a: guest order with phone, governorate, area and address; notes and preferred time optional and kept", async () => {
    const cart = await cartWith();
    const result = await placeCheckout(t.db, who(cart.cartToken), form(cart.view.totalIqd, { notes: "اتصل قبل الوصول", preferredWindow: "evening" }), NOW);
    expect(result).toMatchObject({ ok: true, replayed: false });
    if (!result.ok) return;
    const row = await orderRow(result.ref);
    expect(row).toMatchObject({ customerId: null, governorateId: BAGHDAD, districtId: districtId("baghdad", "karrada"), areaText: "الكرادة داخل", notes: "اتصل قبل الوصول", preferredWindow: "evening", marketingConsent: false, paymentStatus: "cod_due", isDemo: true });
    expect(row.guestContactId).not.toBeNull();
    expect(row.contactPhoneE164).toMatch(/^\+9647\d{9}$/);
    // without notes or a time it is placed just the same
    const bare = await cartWith();
    expect(await placeCheckout(t.db, who(bare.cartToken), form(bare.view.totalIqd, { notes: "", preferredWindow: "" }), NOW)).toMatchObject({ ok: true });
  });

  test("acceptance 14.1b: each required field is asked for by name; a refused form places nothing", async () => {
    const cart = await cartWith();
    const before = await count(orders);
    for (const [field, value, code] of [
      ["phone", "", "required"],
      ["phone", "0770 12", "phone_invalid"],
      ["governorateId", "", null],
      ["areaText", "", "required"],
      // an empty or too short address is refused as too short (the full address needs a few words)
      ["addressText", "", null],
      ["addressText", "دار", "too_short"],
    ] as const) {
      const answer = await placeCheckout(t.db, who(cart.cartToken), form(cart.view.totalIqd, { [field]: value }), NOW);
      expect(answer.ok, field).toBe(false);
      if (answer.ok) continue;
      expect(answer.status, field).toBe(400);
      expect(Object.keys(answer.fields ?? {}), field).toContain(field);
      if (code) expect(answer.fields?.[field], field).toBe(code);
    }
    expect(await count(orders)).toBe(before);
  });

  test("acceptance 14.1c: the confirmation opens with its token; guest tracking needs the reference AND the phone", async () => {
    const cart = await cartWith();
    const phone = make.phone();
    const placed = await placeCheckout(t.db, who(cart.cartToken), form(cart.view.totalIqd, { phone: typed(phone) }), NOW);
    if (!placed.ok) throw new Error(placed.code);
    expect(await findOrderForShopper(t.db, { ref: placed.ref, token: placed.accessToken, customerId: null, locale: "ar", now: NOW })).toMatchObject({ access: "token", order: { ref: placed.ref } });
    expect(await findOrderForShopper(t.db, { ref: placed.ref, token: null, customerId: null, locale: "ar", now: NOW })).toBeNull();
    const track = (ref: string, number: string) => {
      const body = new FormData();
      body.set("ref", ref);
      body.set("phone", number);
      return trackOrder(t.db, body, { ip: "198.51.100.20", locale: "ar" }, NOW);
    };
    expect(await track(placed.ref, typed(phone))).toMatchObject({ ok: true, order: { ref: placed.ref } });
    const wrongPhone = await track(placed.ref, "0780 999 9999");
    const wrongRef = await track("TT-ZZZZ9999", typed(phone));
    expect(wrongPhone).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(wrongRef).toMatchObject({ ok: false, code: "not_found", status: 404 });
    // the phone alone never finds an order: there is no lookup by phone without a reference
    expect(await track("", typed(phone))).toMatchObject({ ok: false });
  });
});

// ───────────────────────────────────────────────────────────────── §14.2

describe("§14.2 every governorate applies exactly 5,000 IQD shipping unless an override is explicitly enabled", () => {
  test("acceptance 14.2a: all governorates at 5,000 — on the checkout page, in the cart and on a placed order to each one", async () => {
    const page = await loadCheckoutData(t.db, { locale: "ar", now: NOW, customerId: null });
    expect(page.governorates.length).toBeGreaterThanOrEqual(18);
    for (const governorate of page.governorates) {
      expect(governorate.feeIqd, governorate.id).toBe(5_000);
      expect(await getShippingFee(t.db, governorate.id)).toBe(5_000);
      const district = page.districts[governorate.id]?.[0]?.id ?? "";
      const cart = await cartWith({ priceIqd: 100_000, governorate: governorate.id });
      expect(cart.view.shippingIqd, governorate.id).toBe(5_000);
      const placed = await placeCheckout(t.db, who(cart.cartToken), form(cart.view.totalIqd, { governorateId: governorate.id, districtId: district }), NOW);
      expect(placed.ok, `${governorate.id}: ${placed.ok ? "" : placed.code}`).toBe(true);
      if (!placed.ok) continue;
      const row = await orderRow(placed.ref);
      expect(row.shippingIqd, governorate.id).toBe(5_000);
      expect(row.totalIqd).toBe(row.subtotalIqd - row.discountIqd + 5_000);
    }
  });

  test("acceptance 14.2b: an override is ignored until an employee with the permission switches overrides on; off again → 5,000", async () => {
    const basra = governorateId("basra");
    // a fulfillment employee may not set fees; a manager may
    expect((await failure(setOverrideFee(t.db, as("fulfillment"), { governorateId: basra, feeIqd: 7_000, expectedIqd: null, reason: "طرق البصرة" }, NOW))).status).toBe(403);
    const set = await setOverrideFee(t.db, as("manager"), { governorateId: basra, feeIqd: 7_000, expectedIqd: null, reason: "طرق البصرة" }, NOW);
    expect(set.applies).toBe(false);
    expect(await getShippingFee(t.db, basra)).toBe(5_000);
    expect((await failure(setOverridesEnabled(t.db, as("fulfillment"), { enabled: true, expected: false, reason: "تفعيل رسوم المحافظات" }, NOW))).status).toBe(403);
    await setOverridesEnabled(t.db, as("manager"), { enabled: true, expected: false, reason: "تفعيل رسوم المحافظات" }, NOW);
    try {
      expect(await getShippingFee(t.db, basra)).toBe(7_000);
      expect(await getShippingFee(t.db, BAGHDAD)).toBe(5_000);
    } finally {
      await setOverridesEnabled(t.db, as("manager"), { enabled: false, expected: true, reason: "إيقاف رسوم المحافظات" }, NOW + 1);
    }
    expect(await getShippingFee(t.db, basra)).toBe(5_000);
  });
});

// ───────────────────────────────────────────────────────────────── §14.3

describe("§14.3 wallet: deducted only in one atomic ledger transaction; never a guest, never another user's wallet", () => {
  async function fundedCustomer(amountIqd: number) {
    const customerId = await make.customer();
    await creditWallet(t.db, as("finance"), { customerId, amountIqd, kind: "adjustment", reason: "رصيد فحص القبول", idempotencyKey: `acc-${randomToken()}` }, NOW);
    return customerId;
  }

  test("acceptance 14.3a: a signed-in customer pays from the wallet: one purchase row in the order's batch, balance down by exactly the total", async () => {
    const customerId = await fundedCustomer(600_000);
    const cart = await cartWith({ customerId, priceIqd: 250_000 });
    const placed = await placeCheckout(t.db, who(cart.cartToken, customerId), form(cart.view.totalIqd, { paymentMethod: "wallet" }), NOW);
    expect(placed).toMatchObject({ ok: true });
    if (!placed.ok) return;
    const row = await orderRow(placed.ref);
    expect(row).toMatchObject({ customerId, paymentStatus: "paid", paidIqd: row.totalIqd });
    expect(await getWalletBalance(t.db, customerId)).toBe(600_000 - row.totalIqd);
    const debit = await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.refId, row.id))).all();
    expect(debit).toHaveLength(1);
    expect(debit[0]).toMatchObject({ amountIqd: -row.totalIqd, kind: "purchase" });
    // the wallet payment row points at that ledger row
    const payment = await t.db.select().from(payments).where(eq(payments.orderId, row.id)).get();
    expect(payment).toMatchObject({ method: "wallet", status: "paid", amountIqd: row.totalIqd, walletLedgerId: debit[0].id });
  });

  test("acceptance 14.3b: an insufficient balance is refused — nothing debited, no order", async () => {
    const customerId = await fundedCustomer(100_000);
    const cart = await cartWith({ customerId, priceIqd: 250_000 });
    const [ordersBefore, ledgerBefore] = [await count(orders), await count(walletLedger)];
    const answer = await placeCheckout(t.db, who(cart.cartToken, customerId), form(cart.view.totalIqd, { paymentMethod: "wallet" }), NOW);
    expect(answer).toMatchObject({ ok: false, code: "wallet_insufficient" });
    expect(await count(orders)).toBe(ordersBefore);
    expect(await count(walletLedger)).toBe(ledgerBefore);
    expect(await getWalletBalance(t.db, customerId)).toBe(100_000);
  });

  test("acceptance 14.3c: two wallet orders at once that the balance covers only once: exactly one is placed, never an overdraft", async () => {
    const customerId = await fundedCustomer(300_000);
    const a = await cartWith({ customerId, priceIqd: 200_000 });
    // a second device of the same customer (a guest cart until it is ordered)
    const b = await cartWith({ priceIqd: 200_000 });
    const results = await Promise.all([
      placeCheckout(t.db, who(a.cartToken, customerId), form(a.view.totalIqd, { paymentMethod: "wallet" }), NOW),
      placeCheckout(t.db, who(b.cartToken, customerId), form(b.view.totalIqd, { paymentMethod: "wallet" }), NOW),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(refused && !refused.ok ? refused.code : null).toMatch(/wallet_insufficient|totals_changed/);
    expect(await getWalletBalance(t.db, customerId)).toBe(300_000 - 205_000);
    expect(await getWalletBalance(t.db, customerId)).toBeGreaterThanOrEqual(0);
  });

  test("acceptance 14.3d: a guest cannot pay with a wallet; a posted customer id is ignored — only the session's wallet is used", async () => {
    const victim = await fundedCustomer(900_000);
    const guestCart = await cartWith();
    expect(await placeCheckout(t.db, who(guestCart.cartToken), form(guestCart.view.totalIqd, { paymentMethod: "wallet", customerId: victim }), NOW)).toMatchObject({ ok: false, code: "wallet_requires_account", status: 403 });
    const me = await fundedCustomer(400_000);
    const mine = await cartWith({ customerId: me, priceIqd: 250_000 });
    const placed = await placeCheckout(t.db, who(mine.cartToken, me), form(mine.view.totalIqd, { paymentMethod: "wallet", customerId: victim }), NOW);
    expect(placed.ok).toBe(true);
    expect(await getWalletBalance(t.db, victim)).toBe(900_000);
    expect(await getWalletBalance(t.db, me)).toBe(400_000 - 255_000);
  });
});

// ───────────────────────────────────────────────────────────────── §14.4

describe("§14.4 Mastercard / Zain Cash transfers need amount and proof and stay pending until a person approves", () => {
  async function transferOrder(method: "bank_transfer" | "zaincash") {
    const cart = await cartWith({ priceIqd: 150_000 });
    const placed = await placeCheckout(t.db, who(cart.cartToken), form(cart.view.totalIqd, { paymentMethod: method }), NOW);
    if (!placed.ok) throw new Error(placed.code);
    const row = await orderRow(placed.ref);
    const payment = (await t.db.select().from(payments).where(eq(payments.orderId, row.id)).get())!;
    return { ...placed, row, payment };
  }

  for (const method of ["bank_transfer", "zaincash"] as const) {
    test(`acceptance 14.4a (${method}): unpaid until a proof with the amount; pending verification after it; paid only by an employee with orders.payment.verify`, async () => {
      const order = await transferOrder(method);
      expect(order.row).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", paidIqd: 0 });
      // no amount → refused, nothing stored
      expect(await upload({ ref: order.ref, t: order.accessToken })).toMatchObject({ status: 400, body: { fields: { declaredAmountIqd: "required" } } });
      expect((await orderRow(order.ref)).paymentStatus).toBe("unpaid");
      // amount + image → pending verification, never paid
      expect(await upload({ ref: order.ref, t: order.accessToken, declaredAmountIqd: String(order.row.totalIqd), reference: "ACC-1" })).toEqual({ status: 200, body: { ok: true } });
      expect(await orderRow(order.ref)).toMatchObject({ status: "payment_review", paymentStatus: "pending_verification", paidIqd: 0 });
      // roles without the permission (and the shopper) cannot approve
      for (const role of ["fulfillment", "support", "cashier"] as const) expect((await failure(verifyPayment(t.db, as(role), order.payment.id, { approve: true }, NOW + HOUR))).status, role).toBe(403);
      expect((await failure(verifyPayment(t.db, { kind: "customer", id: "cus_x" } as Actor, order.payment.id, { approve: true }, NOW + HOUR))).status).toBe(403);
      expect((await orderRow(order.ref)).paymentStatus).toBe("pending_verification");
      // finance approves: paid, with the verifier and the time recorded
      expect(await verifyPayment(t.db, as("finance"), order.payment.id, { approve: true }, NOW + HOUR)).toMatchObject({ status: "paid" });
      expect(await orderRow(order.ref)).toMatchObject({ paymentStatus: "paid", status: "confirmed", paidIqd: order.row.totalIqd });
      expect(await t.db.select().from(payments).where(eq(payments.id, order.payment.id)).get()).toMatchObject({ status: "paid", verifiedBy: staffIds.get("finance") });
    });
  }

  test("acceptance 14.4b: a declared amount that differs needs the override permission; a rejected proof is corrected and re-reviewed", async () => {
    const order = await transferOrder("bank_transfer");
    expect((await upload({ ref: order.ref, t: order.accessToken, declaredAmountIqd: String(order.row.totalIqd - 50_000) }, png("short"))).status).toBe(200);
    // finance holds no orders.payment.override in its default role: the mismatch is refused
    expect(await failure(verifyPayment(t.db, as("finance"), order.payment.id, { approve: true }, NOW + HOUR))).toMatchObject({ code: "amount_mismatch", status: 403 });
    await verifyPayment(t.db, as("finance"), order.payment.id, { approve: false, note: "المبلغ في الإيصال أقل من المطلوب" }, NOW + HOUR);
    expect(await orderRow(order.ref)).toMatchObject({ paymentStatus: "rejected" });
    const view = await findOrderForShopper(t.db, { ref: order.ref, token: order.accessToken, customerId: null, locale: "ar", now: NOW + HOUR });
    expect(view?.order.payment).toMatchObject({ canUploadProof: true, proof: { status: "rejected", rejectReason: "المبلغ في الإيصال أقل من المطلوب" } });
    expect((await upload({ ref: order.ref, t: order.accessToken, declaredAmountIqd: String(order.row.totalIqd) }, png("full"), NOW + 2 * HOUR)).status).toBe(200);
    expect(await verifyPayment(t.db, as("finance"), order.payment.id, { approve: true }, NOW + 3 * HOUR)).toMatchObject({ status: "paid" });
    const proofs = await t.db.select({ status: paymentProofs.status }).from(paymentProofs).where(eq(paymentProofs.paymentId, order.payment.id)).all();
    expect(proofs.map((p) => p.status).sort()).toEqual(["approved", "rejected"]);
  });
});

// ───────────────────────────────────────────────────────────────── §12 cart failure states

describe("§12 the cart's failure states", () => {
  test("acceptance 12.cart: unavailable item, sold out, more than in stock, the line cap, and a sold-out race at checkout", async () => {
    const draft = await make.product({ stock: 5 });
    await t.db.update(products).set({ status: "draft" }).where(eq(products.id, draft.productId));
    expect(await failure(addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: draft.variantId, qty: 1 }, NOW))).toMatchObject({ code: "unavailable" });
    const soldOut = await make.product({ stock: 0 });
    expect(await failure(addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: soldOut.variantId, qty: 1 }, NOW))).toMatchObject({ code: "out_of_stock" });
    // more than in stock: the line is kept at what can be sold, and one more is refused by name
    const two = await make.product({ stock: 2 });
    const owner = { cartToken: null as string | null, customerId: null, locale: "ar" as const };
    const added = await addToCart(t.db, owner, { variantId: two.variantId, qty: 1 }, NOW);
    const line = added.view.lines[0];
    const clamped = await changeLineQty(t.db, { ...owner, cartToken: added.cartToken }, line.id, 3, NOW);
    expect(clamped.view.lines[0].qty).toBe(2);
    expect(await failure(addToCart(t.db, { ...owner, cartToken: added.cartToken }, { variantId: two.variantId, qty: 1 }, NOW))).toMatchObject({ code: "insufficient_stock" });
    // the per-line cap (10)
    const many = await make.product({ stock: 100 });
    const ten = await addToCart(t.db, owner, { variantId: many.variantId, qty: 10 }, NOW);
    expect(await failure(addToCart(t.db, { ...owner, cartToken: ten.cartToken }, { variantId: many.variantId, qty: 1 }, NOW))).toMatchObject({ code: "max_qty_reached" });

    // the last unit sold to someone else between the cart and the checkout
    const last = await make.product({ stock: 1, priceIqd: 120_000 });
    const first = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: last.variantId, qty: 1 }, NOW);
    const second = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: last.variantId, qty: 1 }, NOW);
    const total = (await getCartView(t.db, { cartToken: first.cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW)).totalIqd;
    expect((await placeCheckout(t.db, who(first.cartToken), form(total), NOW)).ok).toBe(true);
    const late = await placeCheckout(t.db, who(second.cartToken), form(total), NOW);
    expect(late).toMatchObject({ ok: false, status: 409 });
    if (!late.ok) expect(late.cart?.lines[0]?.problem).toBe("out_of_stock");
    const level = await t.db.select().from(stockLevels).where(eq(stockLevels.variantId, last.variantId)).get();
    expect(level!.onHand - level!.reserved).toBeGreaterThanOrEqual(0);
  });

  test("acceptance 12.coupon: a rejected coupon says why and changes nothing; a valid one lowers the total and is recorded on the order", async () => {
    await t.db.insert(coupons).values({ id: "cpn_acc_min", code: "ACCMIN", kind: "fixed", value: 10_000, minSubtotalIqd: 1_000_000, isActive: true, createdAt: NOW - HOUR });
    await t.db.insert(coupons).values({ id: "cpn_acc_old", code: "ACCOLD", kind: "fixed", value: 10_000, endsAt: NOW - HOUR, isActive: true, createdAt: NOW - 2 * HOUR });
    await t.db.insert(coupons).values({ id: "cpn_acc_ok", code: "ACC10", kind: "percent", value: 1_000, maxDiscountIqd: 20_000, isActive: true, createdAt: NOW - HOUR });
    const cart = await cartWith({ priceIqd: 150_000 });
    const request = { cartToken: cart.cartToken, customerId: null, locale: "ar" as const, governorateId: BAGHDAD };
    for (const [code, reason] of [["ACCMIN", "min_subtotal"], ["ACCOLD", "expired"], ["NOPE99", "not_found"]] as const) {
      const view = await applyCoupon(t.db, request, code, NOW).catch((error) => error);
      const app = toAppError(view);
      if (app) expect(app.code).toBe(`coupon_${reason}`);
      else expect(view.coupon?.issue?.reason ?? view.couponIssue?.reason).toBe(reason);
      expect((await getCartView(t.db, request, NOW)).totalIqd).toBe(cart.view.totalIqd);
    }
    const applied = await applyCoupon(t.db, request, "ACC10", NOW);
    expect(applied.totalIqd).toBe(150_000 - 15_000 + 5_000);
    const placed = await placeCheckout(t.db, who(cart.cartToken), form(applied.totalIqd), NOW);
    if (!placed.ok) throw new Error(placed.code);
    expect(await orderRow(placed.ref)).toMatchObject({ discountIqd: 15_000, couponId: "cpn_acc_ok", totalIqd: 140_000 });
  });

  test("acceptance 12.points: points lower a signed-in customer's total — never beyond the balance; a guest cannot redeem", async () => {
    const customerId = await make.customer();
    await t.db.insert(loyaltyLedger).values({ id: `lyl_acc_${randomToken().slice(0, 10)}`, customerId, points: 1_000, kind: "earn", refType: "test", refId: null, reason: "acceptance", expiresAt: NOW + 300 * 24 * HOUR, actorKind: "system", actorId: "acceptance", idempotencyKey: `acc:${randomToken()}`, at: NOW });
    const cart = await cartWith({ customerId, priceIqd: 100_000 });
    const view = await getCartView(t.db, { cartToken: cart.cartToken, customerId, locale: "ar", governorateId: BAGHDAD, redeemPoints: 5_000 }, NOW);
    expect(view.points).toMatchObject({ balance: 1_000, used: 1_000 });
    const discount = view.discounts.find((d) => d.kind === "points");
    expect(discount?.amountIqd).toBeGreaterThan(0);
    expect(await placeCheckout(t.db, who(cart.cartToken), form(view.totalIqd, { redeemPoints: "1000" }), NOW)).toMatchObject({ ok: false, code: "points_requires_account" });
    const placed = await placeCheckout(t.db, who(cart.cartToken, customerId), form(view.totalIqd, { redeemPoints: "1000" }), NOW);
    expect(placed).toMatchObject({ ok: true });
    if (!placed.ok) return;
    expect(await orderRow(placed.ref)).toMatchObject({ discountIqd: discount!.amountIqd, totalIqd: 100_000 - discount!.amountIqd + 5_000 });
    const balance = Number((await t.db.select({ n: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)` }).from(loyaltyLedger).where(eq(loyaltyLedger.customerId, customerId)).get())?.n);
    expect(balance).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── §14.12 retries

describe("§14.12 no duplicated order or payment on retries", () => {
  test("acceptance 14.12-retry: the same attempt twice, and two concurrent submissions of it, place ONE order with ONE payment", async () => {
    const cart = await cartWith();
    const body = form(cart.view.totalIqd, { paymentMethod: "bank_transfer" });
    const [ordersBefore, paymentsBefore] = [await count(orders), await count(payments)];
    const results = await Promise.all([placeCheckout(t.db, who(cart.cartToken), body, NOW), placeCheckout(t.db, who(cart.cartToken), body, NOW)]);
    const again = await placeCheckout(t.db, who(cart.cartToken), body, NOW + 5_000);
    const refs = new Set([...results, again].filter((r) => r.ok).map((r) => (r.ok ? r.ref : "")));
    expect(refs.size).toBe(1);
    expect(await count(orders)).toBe(ordersBefore + 1);
    expect(await count(payments)).toBe(paymentsBefore + 1);
    // a proof sent twice (a double tap) is one proof under review
    const [ref] = [...refs];
    const token = (results.find((r) => r.ok) as { accessToken: string }).accessToken;
    const row = await orderRow(ref);
    const first = await upload({ ref, t: token, declaredAmountIqd: String(row.totalIqd) }, png("one"));
    const second = await upload({ ref, t: token, declaredAmountIqd: String(row.totalIqd) }, png("one"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await t.db.select().from(paymentProofs).innerJoin(payments, eq(payments.id, paymentProofs.paymentId)).where(eq(payments.orderId, row.id)).all()).toHaveLength(1);
  });
});
