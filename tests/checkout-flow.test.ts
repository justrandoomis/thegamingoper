/**
 * The checkout area (app/routes/storefront/checkout, POST /api/upload/proof) against a real local D1 + KV:
 *
 *   · the page's own rules (pure): Iraq-aware phone messages, step checks, amounts, references, the form it posts
 *   · placing an order the way the checkout action does (placeCheckout → placeOrder): guest COD, the confirmation link,
 *     a double submit, totals changed (the fresh cart comes back), field errors, wallet for guests, a sold-out race
 *   · the transfer proof endpoint (handleProofUpload): access by token / owner, private storage with the metadata
 *     removed, the order moving to "pending verification", refusals that store nothing, a rejected proof replaced,
 *     the upload window, and an answer that never reveals a duplicate
 *   · guest tracking: the same answer for a wrong reference and a wrong phone
 *   · the checkout page's data, and one guest order over the demo catalogue (a product chosen by its properties)
 *
 * Commerce rules themselves are tested by their owners (tests/commerce-*.test.ts); this file checks that the pages
 * call them the right way and show their refusals as the contract says.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Actor } from "~/server/actor";
import { files, orders, paymentProofs, payments, products, stockLevels, variants } from "~/server/db/schema";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { seedDemo } from "~/server/db/seed/demo";
import type { Permission } from "~/server/permissions";
import { kvBlobStore } from "~/server/storage.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import type { CheckoutWho } from "~/server/services/orders/place.server";
import { verifyPayment } from "~/server/services/payments/payments.server";
import {
  attemptFor,
  cleanOrderRef,
  draftToForm,
  EMPTY_DRAFT,
  issuesFromServer,
  newAttemptKey,
  OTHER_DISTRICT,
  parseAmountInput,
  phoneIssue,
  stepOf,
  validateStep,
  type ValidationContext,
} from "~/routes/storefront/checkout/checkout-form";
import { confirmationPath, findOrderForShopper, loadCheckoutData, placeCheckout, trackOrder } from "~/routes/storefront/checkout/checkout.server";
import { handleProofUpload, MAX_PROOF_BODY_BYTES } from "~/routes/storefront/checkout/proof.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;

let t: TestDb;
let make: Fixtures;
let verifierId: string;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  verifierId = await make.employee();
});
afterAll(async () => {
  await t.dispose();
});

const verifier = (): Actor => ({ kind: "employee", id: verifierId, permissions: new Set<Permission>(["orders.payment.verify"]) });
const who = (cartToken: string | null, customerId: string | null = null): CheckoutWho => ({ cartToken, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "demo" });
/** "+9647712345678" → "0771 234 5678", the way a shopper types it. */
const typed = (e164: string) => {
  const n = e164.replace(/^\+964/, "0");
  return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
};

/** A cart holding `qty` of a fresh stocked product; returns the token and the total for Baghdad. */
async function cartWith(options: { stock?: number; qty?: number; priceIqd?: number; customerId?: string | null } = {}) {
  const product = await make.product({ stock: options.stock ?? 5, priceIqd: options.priceIqd ?? 250_000 });
  const customerId = options.customerId ?? null;
  const { cartToken } = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: product.variantId, qty: options.qty ?? 1 }, NOW);
  const view = await getCartView(t.db, { cartToken, customerId, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  return { product, cartToken, totalIqd: view.totalIqd };
}

/** The form the checkout page posts (the same fields draftToForm writes). */
function checkoutForm(totalIqd: number, overrides: Record<string, string> = {}): FormData {
  const values: Record<string, string> = {
    ...draftToForm(
      {
        ...EMPTY_DRAFT,
        phone: typed(make.phone()),
        governorateId: governorateId("baghdad"),
        districtId: districtId("baghdad", "karrada"),
        areaText: "الكرادة داخل",
        addressText: "شارع 62، قرب جامع الكرادة، دار 14",
        paymentMethod: "cod",
      },
      { idempotencyKey: newAttemptKey(), expectedTotalIqd: totalIqd },
    ),
    ...overrides,
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

async function placed(method: "cod" | "bank_transfer" | "zaincash" | "wallet" = "cod", options: { customerId?: string | null } = {}) {
  const cart = await cartWith({ customerId: options.customerId ?? null });
  const phone = typed(make.phone());
  const result = await placeCheckout(t.db, who(cart.cartToken, options.customerId ?? null), checkoutForm(cart.totalIqd, { paymentMethod: method, phone }), NOW);
  if (!result.ok) throw new Error(`placing failed: ${result.code}`);
  return { ...result, phone, cart };
}

// ───────────────────────────────────────────────────────────────── a real PNG, with metadata that must not survive

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array([...Buffer.from(type, "latin1"), ...data]);
  const crc = crc32(body) >>> 0;
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc);
  return out;
}
/** A 1×1 RGB PNG with a tEXt chunk (a place name and GPS text, as phones write). */
function pngWithMetadata(marker = "GPS 33.3152N 44.3661E"): Uint8Array {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const idat = new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  const text = new Uint8Array([...Buffer.from("Comment\0", "latin1"), ...Buffer.from(marker, "latin1")]);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk("IHDR", ihdr), ...pngChunk("tEXt", text), ...pngChunk("IDAT", idat), ...pngChunk("IEND", new Uint8Array())]);
}

function proofRequest(fields: Record<string, string>, file?: { bytes: Uint8Array; name: string; type: string }): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  // A copy backed by a plain ArrayBuffer (what BlobPart accepts).
  if (file) form.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return new Request("http://localhost/api/upload/proof", { method: "POST", body: form });
}

const deps = (overrides: Partial<Parameters<typeof handleProofUpload>[0]> = {}) => ({ db: t.db, store: kvBlobStore(t.kv), customerId: null, ip: null, locale: "ar" as const, now: NOW, ...overrides });
const countFiles = async () => Number((await t.db.select({ n: sql<number>`count(*)` }).from(files).get())?.n ?? 0);
const png = (marker?: string) => ({ bytes: pngWithMetadata(marker), name: "receipt.png", type: "image/png" });

// ───────────────────────────────────────────────────────────────── pure rules

describe("checkout form rules", () => {
  test("phone numbers: Iraq-aware, with the exact problem", () => {
    expect(phoneIssue("")).toEqual({ code: "required" });
    expect(phoneIssue("0770 123 4567")).toBeNull();
    expect(phoneIssue("٠٧٧٠١٢٣٤٥٦٧")).toBeNull();
    expect(phoneIssue("+964 770 123 4567")).toBeNull();
    expect(phoneIssue("009647701234567")).toBeNull();
    expect(phoneIssue("0770 123 456")).toEqual({ code: "short", count: 1 });
    expect(phoneIssue("077012")).toEqual({ code: "short", count: 5 });
    expect(phoneIssue("+964 770 12")).toEqual({ code: "short", count: 5 });
    expect(phoneIssue("077012345678")).toEqual({ code: "long", count: 1 });
    expect(phoneIssue("0700 123 4567")).toEqual({ code: "range" });
    expect(phoneIssue("1234")).toEqual({ code: "prefix" });
    expect(phoneIssue("07ab")).toEqual({ code: "chars" });
  });

  test("the address step asks for phone, governorate, district (or 'not in the list'), area and full address", () => {
    const context: ValidationContext = { districtIds: ["dst_baghdad_karrada"], days: ["2026-11-10"], methods: ["cod"], walletEnough: false };
    expect(Object.keys(validateStep("address", EMPTY_DRAFT, context)).sort()).toEqual(["addressText", "areaText", "districtId", "governorateId", "phone"]);
    const filled = { ...EMPTY_DRAFT, phone: "07701234567", governorateId: "gov_baghdad", districtId: OTHER_DISTRICT, areaText: "الكرادة", addressText: "شارع 62 دار 14" };
    expect(validateStep("address", filled, context)).toEqual({});
    expect(validateStep("address", { ...filled, addressText: "دار" }, context)).toEqual({ addressText: { code: "too_short" } });
    expect(validateStep("address", { ...filled, preferredDay: "2027-01-01" }, context)).toEqual({ preferredDay: { code: "invalid" } });
    // A governorate without districts in the list does not ask for one.
    expect(validateStep("address", { ...filled, districtId: "" }, { ...context, districtIds: [] })).toEqual({});
    expect(validateStep("payment", filled, context)).toEqual({ paymentMethod: { code: "required" } });
    expect(validateStep("payment", { ...filled, paymentMethod: "wallet" }, { ...context, methods: ["cod", "wallet"] })).toEqual({ paymentMethod: { code: "wallet_insufficient" } });
  });

  test("amounts, references, steps and the posted form", () => {
    expect(parseAmountInput("1,250,000")).toBe(1_250_000);
    expect(parseAmountInput("١٢٥٠٠٠٠")).toBe(1_250_000);
    expect(parseAmountInput("12.5")).toBeNull();
    expect(parseAmountInput("0")).toBeNull();
    expect(parseAmountInput("abc")).toBeNull();
    expect(cleanOrderRef(" tt-7k4m2q9x ")).toBe("TT-7K4M2Q9X");
    expect(cleanOrderRef("7K4M2Q9X")).toBeNull();
    expect(stepOf("?step=payment")).toBe("payment");
    expect(stepOf("?step=pay")).toBe("address");
    const form = draftToForm({ ...EMPTY_DRAFT, districtId: OTHER_DISTRICT, marketingConsent: false }, { idempotencyKey: "k".repeat(22), expectedTotalIqd: 5000 });
    expect(form).toMatchObject({ districtId: "", marketingConsent: "", expectedTotalIqd: "5000", intent: "place" });
    expect(issuesFromServer({ phone: "phone_invalid", nonsense: "x" })).toEqual({ phone: { code: "server.phone_invalid" } });
    expect(newAttemptKey()).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
  });

  test("an attempt key stays with its cart", () => {
    const stored = { key: "k".repeat(22), submittedKey: "k".repeat(22), cartId: "crt_A" };
    const fresh = () => "f".repeat(22);
    // Same cart (a reload, Back): the same attempt — a retry can never place a second order.
    expect(attemptFor(stored, "crt_A", fresh)).toEqual({ key: stored.key, submittedKey: stored.submittedKey });
    // The cart became an order (no open cart): keep the key, so "show my order" can ask for that order.
    expect(attemptFor(stored, null, fresh)).toEqual({ key: stored.key, submittedKey: stored.submittedKey });
    // A new cart since: a new attempt (the old key already placed an order for other goods).
    expect(attemptFor(stored, "crt_B", fresh)).toEqual({ key: fresh(), submittedKey: null });
  });
});

// ───────────────────────────────────────────────────────────────── placing

describe("placing an order (the checkout action's path)", () => {
  test("a guest pays on delivery: no account, the confirmation link opens the order", async () => {
    const cart = await cartWith();
    const form = checkoutForm(cart.totalIqd, { notes: "اتصل قبل الوصول", preferredWindow: "evening", contactName: "سارة" });
    const result = await placeCheckout(t.db, who(cart.cartToken), form, NOW);
    expect(result).toMatchObject({ ok: true, replayed: false });
    if (!result.ok) return;
    expect(confirmationPath(result.ref, result.accessToken)).toBe(`/order/${result.ref}?t=${result.accessToken}`);
    const found = await findOrderForShopper(t.db, { ref: result.ref.toLowerCase(), token: result.accessToken, customerId: null, locale: "ar", now: NOW });
    expect(found?.access).toBe("token");
    expect(found?.order).toMatchObject({ status: "new", payment: { method: "cod", status: "cod_due" }, delivery: { preferredWindow: "evening", notes: "اتصل قبل الوصول" }, contact: { name: "سارة" } });
    expect(found?.order.totals.shippingIqd).toBe(5_000);
    // Without the token (or with a wrong one) the order does not open.
    expect(await findOrderForShopper(t.db, { ref: result.ref, token: null, customerId: null, locale: "ar", now: NOW })).toBeNull();
    expect(await findOrderForShopper(t.db, { ref: result.ref, token: "x".repeat(43), customerId: null, locale: "ar", now: NOW })).toBeNull();
    // Marketing consent was not ticked, so none is stored on the order.
    const row = await t.db.select({ consent: orders.marketingConsent }).from(orders).where(eq(orders.ref, result.ref)).get();
    expect(row?.consent).toBe(false);
  });

  test("a double submit (the same attempt key twice) places one order", async () => {
    const cart = await cartWith();
    const form = checkoutForm(cart.totalIqd);
    const first = await placeCheckout(t.db, who(cart.cartToken), form, NOW);
    const second = await placeCheckout(t.db, who(cart.cartToken), form, NOW + 1_000);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second).toMatchObject({ ref: first.ref, accessToken: first.accessToken, replayed: true });
  });

  test("a total the shopper did not see is refused with the fresh cart", async () => {
    const cart = await cartWith({ priceIqd: 300_000 });
    const result = await placeCheckout(t.db, who(cart.cartToken), checkoutForm(cart.totalIqd - 10_000), NOW);
    expect(result).toMatchObject({ ok: false, code: "totals_changed", status: 409 });
    if (result.ok) return;
    expect(result.cart?.totalIqd).toBe(cart.totalIqd);
    // Confirming again with the total now shown works.
    const again = await placeCheckout(t.db, who(cart.cartToken), checkoutForm(cart.totalIqd), NOW);
    expect(again.ok).toBe(true);
  });

  test("field problems come back per field; wallet needs an account", async () => {
    const cart = await cartWith();
    const countOrders = async () => Number((await t.db.select({ n: sql<number>`count(*)` }).from(orders).get())?.n ?? 0);
    const before = await countOrders();
    expect(await placeCheckout(t.db, who(cart.cartToken), checkoutForm(cart.totalIqd, { phone: "0770 12" }), NOW)).toMatchObject({ ok: false, code: "invalid", status: 400, fields: { phone: "phone_invalid" } });
    expect(await placeCheckout(t.db, who(cart.cartToken), checkoutForm(cart.totalIqd, { areaText: "" }), NOW)).toMatchObject({ ok: false, code: "invalid", fields: { areaText: "required" } });
    expect(await placeCheckout(t.db, who(cart.cartToken), checkoutForm(cart.totalIqd, { districtId: districtId("basra", "zubair") }), NOW)).toMatchObject({ ok: false, fields: { districtId: "district_invalid" } });
    expect(await placeCheckout(t.db, who(cart.cartToken), checkoutForm(cart.totalIqd, { paymentMethod: "wallet" }), NOW)).toMatchObject({ ok: false, code: "wallet_requires_account", status: 403 });
    // Nothing was placed by any of these.
    expect(await countOrders()).toBe(before);
  });

  test("the last unit sold to someone else first: the second shopper gets their cart back, marked", async () => {
    const product = await make.product({ stock: 1, priceIqd: 120_000 });
    const first = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
    const second = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
    const total = (await getCartView(t.db, { cartToken: first.cartToken, customerId: null, locale: "ar", governorateId: governorateId("baghdad") }, NOW)).totalIqd;
    expect((await placeCheckout(t.db, who(first.cartToken), checkoutForm(total), NOW)).ok).toBe(true);
    const late = await placeCheckout(t.db, who(second.cartToken), checkoutForm(total), NOW);
    expect(late.ok).toBe(false);
    if (late.ok) return;
    // The core says "nothing purchasable is left" (cart_empty) when every line is sold out, or cart_blocked /
    // insufficient_stock otherwise — always with the cart as it is now, so the page can show the sold-out line.
    expect(["cart_empty", "cart_blocked", "insufficient_stock"]).toContain(late.code);
    expect(late.status).toBe(409);
    expect(late.cart?.blocked).toBe(true);
    expect(late.cart?.lines[0]?.problem).toBe("out_of_stock");
  });
});

// ───────────────────────────────────────────────────────────────── the transfer proof

describe("POST /api/upload/proof", () => {
  test("a guest's transfer proof is stored privately without its metadata, and the order waits for a person", async () => {
    const order = await placed("bank_transfer");
    const before = await countFiles();
    const answer = await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "٢٥٥,٠٠٠", reference: "TX-88231", note: "حوّلت من مصرف الرافدين" }, png()));
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(await countFiles()).toBe(before + 1);

    const row = await t.db.select().from(orders).where(eq(orders.ref, order.ref)).get();
    expect(row).toMatchObject({ status: "payment_review", paymentStatus: "pending_verification" });
    const payment = await t.db.select().from(payments).where(eq(payments.orderId, row!.id)).get();
    const proof = await t.db.select().from(paymentProofs).where(eq(paymentProofs.paymentId, payment!.id)).get();
    expect(proof).toMatchObject({ status: "submitted", declaredAmountIqd: 255_000, reference: "TX-88231" });
    const file = await t.db.select().from(files).where(eq(files.id, proof!.fileId)).get();
    expect(file).toMatchObject({ visibility: "private", kind: "payment_proof", mime: "image/png", ownerType: "payment_proof", ownerId: proof!.id });
    expect(file!.storageKey.startsWith("prv_")).toBe(true);
    const stored = await kvBlobStore(t.kv).get(file!.storageKey);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!.bytes).includes(Buffer.from("GPS"))).toBe(false);

    // The page now says "pending verification" — never paid.
    const view = await findOrderForShopper(t.db, { ref: order.ref, token: order.accessToken, customerId: null, locale: "ar", now: NOW });
    expect(view?.order.payment).toMatchObject({ status: "pending_verification", canUploadProof: false, proof: { status: "submitted", declaredAmountIqd: 255_000 } });
  });

  test("refusals store nothing: wrong token, no amount, not an image, too large, a proof already under review, a COD order", async () => {
    const order = await placed("zaincash");
    const before = await countFiles();
    expect(await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: "x".repeat(43), declaredAmountIqd: "255000" }, png()))).toMatchObject({ status: 404, body: { ok: false, code: "not_found" } });
    expect(await handleProofUpload(deps(), proofRequest({ ref: "TT-NOPE1234", t: order.accessToken, declaredAmountIqd: "255000" }, png()))).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken }, png()))).toMatchObject({ status: 400, body: { code: "invalid", fields: { declaredAmountIqd: "required" } } });
    expect(await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "12.5" }, png()))).toMatchObject({ status: 400, body: { fields: { declaredAmountIqd: "invalid" } } });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "255000" }, { bytes: svg, name: "receipt.jpg", type: "image/jpeg" }))).toMatchObject({ status: 415, body: { code: "upload_type" } });
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    huge.set(pngWithMetadata().subarray(0, 8));
    expect(await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "255000" }, { bytes: huge, name: "big.png", type: "image/png" }))).toMatchObject({ status: 413, body: { code: "upload_too_large" } });
    const declaredHuge = new Request("http://localhost/api/upload/proof", { method: "POST", body: "x", headers: { "Content-Length": String(MAX_PROOF_BODY_BYTES + 1) } });
    expect(await handleProofUpload(deps(), declaredHuge)).toMatchObject({ status: 413, body: { code: "upload_too_large" } });
    expect(await countFiles()).toBe(before);

    // One proof goes through; a second one while it is reviewed is refused before anything is stored.
    expect((await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "255000" }, png("first")))).status).toBe(200);
    const afterFirst = await countFiles();
    expect(await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "255000" }, png("second")))).toMatchObject({ status: 409, body: { code: "proof_not_expected" } });
    expect(await countFiles()).toBe(afterFirst);

    const cod = await placed("cod");
    expect(await handleProofUpload(deps(), proofRequest({ ref: cod.ref, t: cod.accessToken, declaredAmountIqd: "255000" }, png()))).toMatchObject({ status: 409, body: { code: "proof_not_expected" } });
  });

  test("a rejected proof can be replaced; a reused picture is flagged for staff, never in the answer", async () => {
    const order = await placed("bank_transfer");
    const picture = png("same picture");
    expect((await handleProofUpload(deps(), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: "100000" }, picture))).status).toBe(200);
    const row = await t.db.select().from(orders).where(eq(orders.ref, order.ref)).get();
    const payment = await t.db.select().from(payments).where(eq(payments.orderId, row!.id)).get();
    await verifyPayment(t.db, verifier(), payment!.id, { approve: false, note: "المبلغ في الصورة لا يطابق المطلوب" }, NOW + HOUR);

    const view = await findOrderForShopper(t.db, { ref: order.ref, token: order.accessToken, customerId: null, locale: "ar", now: NOW + HOUR });
    expect(view?.order).toMatchObject({ status: "awaiting_payment", payment: { canUploadProof: true, proof: { status: "rejected", rejectReason: "المبلغ في الصورة لا يطابق المطلوب" } } });

    const again = await handleProofUpload(deps({ now: NOW + 2 * HOUR }), proofRequest({ ref: order.ref, t: order.accessToken, declaredAmountIqd: String(order.cart.totalIqd) }, picture));
    expect(again).toEqual({ status: 200, body: { ok: true } });
    const latest = await t.db.select().from(paymentProofs).where(and(eq(paymentProofs.paymentId, payment!.id), eq(paymentProofs.status, "submitted"))).get();
    expect(latest?.duplicateOf).not.toBeNull();
  });

  test("the signed-in owner needs no token; the upload window closes", async () => {
    const customerId = await make.customer();
    const order = await placed("zaincash", { customerId });
    expect(await handleProofUpload(deps({ customerId }), proofRequest({ ref: order.ref, declaredAmountIqd: "255000" }, png()))).toEqual({ status: 200, body: { ok: true } });
    // Another customer's session sees nothing.
    const stranger = await make.customer();
    const other = await placed("zaincash", { customerId });
    expect(await handleProofUpload(deps({ customerId: stranger }), proofRequest({ ref: other.ref, declaredAmountIqd: "255000" }, png()))).toMatchObject({ status: 404, body: { code: "not_found" } });

    const late = await placed("bank_transfer");
    expect(await handleProofUpload(deps({ now: NOW + 25 * HOUR }), proofRequest({ ref: late.ref, t: late.accessToken, declaredAmountIqd: "255000" }, png()))).toMatchObject({ status: 409, body: { code: "payment_window_closed" } });
  });
});

// ───────────────────────────────────────────────────────────────── tracking

describe("guest tracking", () => {
  const form = (ref: string, phone: string) => {
    const data = new FormData();
    data.set("ref", ref);
    data.set("phone", phone);
    return data;
  };

  test("reference and phone together; a wrong half gives the same answer either way", async () => {
    const order = await placed("cod");
    const ctx = { ip: "198.51.100.7", locale: "en" as const };
    const found = await trackOrder(t.db, form(order.ref.toLowerCase(), order.phone), ctx, NOW);
    expect(found).toMatchObject({ ok: true, order: { ref: order.ref, status: "new" } });

    const wrongPhone = await trackOrder(t.db, form(order.ref, "0780 999 9999"), ctx, NOW);
    const wrongRef = await trackOrder(t.db, form("TT-ZZZZ9999", order.phone), ctx, NOW);
    const strip = (result: typeof wrongPhone) => (result.ok ? result : { ok: result.ok, code: result.code, status: result.status, fields: result.fields });
    expect(strip(wrongPhone)).toEqual({ ok: false, code: "not_found", status: 404, fields: undefined });
    expect(strip(wrongRef)).toEqual(strip(wrongPhone));
    expect(await trackOrder(t.db, form(order.ref, "123"), ctx, NOW)).toMatchObject({ ok: false, code: "invalid", status: 400, fields: { phone: "phone_invalid" } });
  });
});

// ───────────────────────────────────────────────────────────────── page data and the demo catalogue

describe("the checkout page's data", () => {
  test("19 governorates at the flat fee, their districts, the enabled methods and the transfer details from settings", async () => {
    const page = await loadCheckoutData(t.db, { locale: "ar", now: NOW, customerId: null });
    expect(page.governorates).toHaveLength(19);
    expect(page.governorates.every((g) => g.feeIqd === 5_000)).toBe(true);
    expect(page.governorates.every((g) => (page.districts[g.id] ?? []).length > 0)).toBe(true);
    expect(page.methods).toEqual({ cod: true, wallet: true, bankTransfer: true, zaincash: true });
    expect(page.transfer).toEqual({ accountNumber: "9269317427", recipientName: "علي خليفة", zaincashNumber: "07719061852" });
    expect(page.proofHours).toBe(24);
    expect(page.walletBalanceIqd).toBeNull();
    expect(page.days.map((d) => d.rel)).toEqual(["today", "tomorrow", "after"]);
    expect(page.days[0]?.value).toBe(new Date(NOW + 3 * HOUR).toISOString().slice(0, 10));
    const customerId = await make.customer();
    expect((await loadCheckoutData(t.db, { locale: "en", now: NOW, customerId })).walletBalanceIqd).toBe(0);
  });
});

describe("with the demo catalogue", () => {
  beforeAll(async () => {
    await seedDemo(t.db, NOW);
  });

  test("a guest buys an in-stock catalogue item by Zain Cash and uploads the proof", async () => {
    // Chosen by its properties: a published, active, default variant with stock to sell — not by a slug or SKU.
    const pick = await t.db
      .select({ variantId: variants.id })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(stockLevels, eq(stockLevels.variantId, variants.id))
      .where(and(eq(products.status, "published"), eq(variants.isActive, true), eq(variants.isDefault, true), gt(sql`${stockLevels.onHand} - ${stockLevels.reserved}`, 2)))
      .limit(1)
      .get();
    expect(pick).toBeDefined();
    const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ckb" }, { variantId: pick!.variantId, qty: 2 }, NOW);
    const view = await getCartView(t.db, { cartToken, customerId: null, locale: "ckb", governorateId: governorateId("erbil") }, NOW);
    const form = checkoutForm(view.totalIqd, { paymentMethod: "zaincash", governorateId: governorateId("erbil"), districtId: districtId("erbil", "erbil"), areaText: "عەنکاوە" });
    const result = await placeCheckout(t.db, { ...who(cartToken), locale: "ckb" }, form, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = await findOrderForShopper(t.db, { ref: result.ref, token: result.accessToken, customerId: null, locale: "ckb", now: NOW });
    expect(before?.order).toMatchObject({ isDemo: true, status: "awaiting_payment", payment: { method: "zaincash", amountDueIqd: view.totalIqd, instructions: { method: "zaincash", number: "07719061852" } } });
    expect(before?.order.lines[0]?.qty).toBe(2);
    const answer = await handleProofUpload(deps({ locale: "ckb" }), proofRequest({ ref: result.ref, t: result.accessToken, declaredAmountIqd: String(view.totalIqd) }, png()));
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    const after = await findOrderForShopper(t.db, { ref: result.ref, token: result.accessToken, customerId: null, locale: "ckb", now: NOW });
    expect(after?.order).toMatchObject({ status: "payment_review", payment: { status: "pending_verification" } });
  });
});
