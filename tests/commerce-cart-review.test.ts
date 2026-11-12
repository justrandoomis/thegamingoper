/**
 * Commerce core — the QA round of the redesigned store (2026-11-12, fix-core): the transaction auditor's two defects.
 *
 *   · A line that sold out while it sat in the cart stays in the cart's count (the badge, «السلة (2)»), and the summary
 *     said «المجموع الفرعي (قطعتان) 55,000 د.ع» for the money of ONE item → `payableCount` (CartViewData): the units the
 *     subtotal is for, beside `count` (what the cart holds).
 *   · The review priced the cart without the number typed in step 1: a once-per-customer coupon that number had used
 *     showed its discount until «أكّد الطلب» answered 409 with the higher total → the cart priced for the typed number
 *     (`CartRequest.phoneE164`; `POST /api/cart` takes `phone` in its BODY — any intent, never a URL), counted against a
 *     per-address budget of its own (the answer says what a number has used), while a referral code's status is still
 *     said without the typed number (security review 2026-11-12: numbers are not tested against a public code for free).
 *
 * Each test failed on the code before the fix. Real local D1 (tests/helpers/db.ts); the route tests run through the real
 * root middleware (CSRF check, request context) into routes/api/cart.ts.
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { formatIraqPhone } from "~/lib/phone";
import { action as cartAction, loader as cartLoader } from "~/routes/api/cart";
import type { Actor } from "~/server/actor";
import { requestContextMiddleware } from "~/server/context.server";
import { carts, coupons, customers, products, stockLevels, type NewCoupon } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { issueReferralCode } from "~/server/services/admin/promotions/referrals.server";
import { PHONE_PRICING_PER_IP, addToCart, applyCoupon, getCartView, getCheckoutCart } from "~/server/services/cart.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { CART_COOKIE } from "~/server/shell.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const SITE = "http://localhost:5173";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The routes read the clock (ctx.now = Date.now()); the rows they meet are written a little before. */
const NOW = Date.now() - 30 * MINUTE;
const BAGHDAD = governorateId("baghdad");
const KARRADA = districtId("baghdad", "karrada");

let t: TestDb;
let make: Fixtures;
let staffId: string;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  staffId = await make.employee();
});
afterAll(async () => {
  await t?.dispose();
});

const guest = (cartToken: string | null = null) => ({ cartToken, customerId: null, locale: "ar" as const });
const staff = (): Actor => ({ kind: "employee", id: staffId, permissions: new Set(["promotions.referral.manage"]) });

async function setStock(variantId: string, onHand: number) {
  await t.db.update(stockLevels).set({ onHand, reserved: 0 }).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));
}

let couponCounter = 0;
async function coupon(overrides: Partial<NewCoupon> = {}) {
  const id = newId("cpn");
  const code = overrides.code ?? `REVIEW${++couponCounter}${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`;
  await t.db.insert(coupons).values({ id, code, kind: "fixed", value: 10_000, isActive: true, createdAt: NOW - DAY, ...overrides });
  return { id, code };
}

function checkoutFields(phone: string, overrides: Partial<CheckoutInput> = {}): Omit<CheckoutInput, "expectedTotalIqd"> {
  return {
    idempotencyKey: randomToken(),
    phone,
    governorateId: BAGHDAD,
    districtId: KARRADA,
    areaText: "الأعظمية",
    addressText: "شارع تجريبي، قرب الجسر، دار 3",
    marketingConsent: false,
    paymentMethod: "cod",
    ...overrides,
  };
}

/** A guest's cart of one unit with the code applied — no number known yet, so a per-customer code applies provisionally. */
async function cartWithCode(variantId: string, code: string): Promise<string> {
  const { cartToken } = await addToCart(t.db, guest(), { variantId, qty: 1 }, NOW);
  await applyCoupon(t.db, guest(cartToken), code, NOW);
  return cartToken;
}

/** That number's cash-on-delivery order of one unit with the code (the real checkout): the number has used it. */
async function orderWithCode(variantId: string, code: string, phone: string) {
  const cartToken = await cartWithCode(variantId, code);
  const view = await getCartView(t.db, { ...guest(cartToken), governorateId: BAGHDAD, phoneE164: phone }, NOW);
  expect(view.coupon?.code).toBe(code);
  return placeOrder(t.db, { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(phone), expectedTotalIqd: view.totalIqd }, NOW);
}

// ───────────────────────────────────────────────────────────────── a request through the root middleware

let counter = 0;
/** A fresh documentation-range IPv4 address, so per-IP limits never leak between tests. */
const freshIp = () => {
  counter++;
  return `198.51.${100 + (Math.floor(counter / 250) % 10)}.${(counter % 250) + 1}`;
};

type Handler = (args: never) => unknown;
type Hit = { status: number; headers: Headers; body: unknown };
type DataWithInit = { data: unknown; init?: { status?: number; headers?: HeadersInit } | null };
const isDataWithInit = (value: unknown): value is DataWithInit => typeof value === "object" && value !== null && "data" in value && "init" in value;

function asResponse(value: unknown): { response: Response; body: unknown } {
  if (value instanceof Response) return { response: value, body: null };
  if (isDataWithInit(value)) {
    const init = value.init ?? {};
    return { response: new Response(JSON.stringify(value.data ?? null), { status: init.status ?? 200, headers: init.headers }), body: value.data };
  }
  return { response: new Response(JSON.stringify(value ?? null), { status: 200, headers: { "Content-Type": "application/json" } }), body: value };
}

/** One request through the root middleware into `handler` (the loader or the action of routes/api/cart.ts). */
async function hit(path: string, handler: Handler, init: { form?: Record<string, string>; cookies?: Record<string, string>; ip?: string } = {}): Promise<Hit> {
  const method = init.form ? "POST" : "GET";
  const headers = new Headers({ "CF-Connecting-IP": init.ip ?? freshIp() });
  if (init.cookies) headers.set("Cookie", Object.entries(init.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
  if (method === "POST") headers.set("Origin", SITE);
  const request = new Request(`${SITE}${path}`, { method, headers, body: init.form ? new URLSearchParams(init.form) : null });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let inner: unknown;
  const response = (await requestContextMiddleware({ request, context, url, pattern: path, params: {} } as never, async () => {
    inner = await (handler as (args: unknown) => unknown)({ request, context, params: {}, url, pattern: path });
    return asResponse(inner).response;
  })) as Response;
  return { status: response.status, headers: response.headers, body: asResponse(inner).body };
}

// ───────────────────────────────────────────────────────────────── 1. the counts

describe("the cart's two counts: what it holds, and what the money is for", () => {
  test("a line that sold out (or went off sale) stays in `count` — the badge, «السلة (n)» — but not in `payableCount`, the units the subtotal is for", async () => {
    const gone = await make.product({ priceIqd: 90_000, stock: 1 });
    const archived = await make.product({ priceIqd: 30_000, stock: 3 });
    const kept = await make.product({ priceIqd: 55_000, stock: 5 });
    const short = await make.product({ priceIqd: 10_000, stock: 5 });
    let token: string | null = null;
    for (const [product, qty] of [[gone, 1], [archived, 1], [kept, 1], [short, 3]] as const) token = (await addToCart(t.db, guest(token), { variantId: product.variantId, qty }, NOW)).cartToken;
    expect(await getCartView(t.db, guest(token), NOW)).toMatchObject({ count: 6, payableCount: 6, subtotalIqd: 205_000, blocked: false });

    // another shopper buys the last unit, staff archive a product, fewer units of one are left than the line holds
    await setStock(gone.variantId, 0);
    await t.db.update(products).set({ status: "archived" }).where(eq(products.id, archived.productId));
    await setStock(short.variantId, 2);
    const view = await getCartView(t.db, guest(token), NOW);
    expect(view.lines.map((line) => line.problem)).toEqual(["out_of_stock", "unavailable", null, "qty_reduced"]);
    // held: 1 + 1 + 1 + 2 (the reduced line shows what can be sold); paid for: 55,000 + 2 × 10,000 — three units
    expect(view).toMatchObject({ blocked: true, count: 5, payableCount: 3, subtotalIqd: 75_000 });
    // the review's summary is priced the same way
    expect((await getCheckoutCart(t.db, { ...guest(token), governorateId: BAGHDAD }, NOW)).view).toMatchObject({ count: 5, payableCount: 3, subtotalIqd: 75_000 });
  });

  test("every line sold out: nothing is paid for (payableCount 0) while the cart still holds them; an empty cart has neither", async () => {
    const only = await make.product({ priceIqd: 40_000, stock: 2 });
    const { cartToken } = await addToCart(t.db, guest(), { variantId: only.variantId, qty: 2 }, NOW);
    await setStock(only.variantId, 0);
    expect(await getCartView(t.db, guest(cartToken), NOW)).toMatchObject({ count: 2, payableCount: 0, subtotalIqd: 0, totalIqd: 0, blocked: true });
    expect(await getCartView(t.db, guest(), NOW)).toMatchObject({ count: 0, payableCount: 0 });
  });
});

// ───────────────────────────────────────────────────────────────── 2. the review, priced for the typed number

describe("the review priced for the number typed in step 1", () => {
  test("a once-per-customer coupon that number already used is refused on the review, with the reason — the total shown is the one the order charges", async () => {
    const game = await make.product({ priceIqd: 99_750, stock: 10 });
    const { code } = await coupon({ kind: "percent", value: 1_000, maxDiscountIqd: 25_000, perCustomerLimit: 1 });
    const used = make.phone();
    await orderWithCode(game.variantId, code, used);

    const cartToken = await cartWithCode(game.variantId, code);
    const request = { ...guest(cartToken), governorateId: BAGHDAD };
    // the cart page knows no number: the code applies provisionally
    expect(await getCartView(t.db, request, NOW)).toMatchObject({ coupon: { code }, discountIqd: 9_975, totalIqd: 94_775, couponIssue: null, payableCount: 1 });
    // the review, priced for the number typed in step 1: no discount, and why
    const review = await getCartView(t.db, { ...request, phoneE164: used }, NOW);
    expect(review).toMatchObject({ coupon: null, discountIqd: 0, discounts: [], totalIqd: 104_750, couponIssue: { code, reason: "customer_limit" } });
    // another number still gets it, and the code stays on the cart (a corrected number gets it back)
    expect(await getCartView(t.db, { ...request, phoneE164: make.phone() }, NOW)).toMatchObject({ coupon: { code }, totalIqd: 94_775 });
    expect((await t.db.select({ code: carts.couponCode }).from(carts).where(eq(carts.id, review.id as string)).get())?.code).toBe(code);
    // «أكّد الطلب» with the total the review showed places the order — no 409
    const placed = await placeOrder(t.db, { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(used), expectedTotalIqd: review.totalIqd }, NOW);
    expect(placed).toMatchObject({ totalIqd: 104_750, replayed: false });
  });

  test("a referral code is still said without the typed number (security review 2026-11-12): the review tests no number against a public code — the order itself still checks it", async () => {
    const referrerId = await make.customer();
    const referrerPhone = (await t.db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, referrerId)).get())!.phone;
    const { code } = await issueReferralCode(t.db, staff(), { customerId: referrerId, maxUses: 5 }, NOW - DAY);
    const game = await make.product({ priceIqd: 45_000, stock: 5 });
    const { cartToken } = await addToCart(t.db, guest(), { variantId: game.variantId, qty: 1 }, NOW);
    const request = { ...guest(cartToken), governorateId: BAGHDAD, phoneE164: referrerPhone, referralCode: code };
    expect((await getCartView(t.db, request, NOW)).referral).toEqual({ code, status: "ok" });
    // what the order is priced with says it for that number — after a correct, complete checkout only
    expect((await getCheckoutCart(t.db, request, NOW)).view.referral).toEqual({ code, status: "referral_self" });
  });
});

// ───────────────────────────────────────────────────────────────── 3. the route: the number in a body, budgeted

describe("POST /api/cart — the number typed at checkout rides in the body", () => {
  async function setup() {
    const game = await make.product({ priceIqd: 99_750, stock: 10 });
    const { code } = await coupon({ kind: "percent", value: 1_000, maxDiscountIqd: 25_000, perCustomerLimit: 1 });
    const used = make.phone();
    await orderWithCode(game.variantId, code, used);
    const cartToken = await cartWithCode(game.variantId, code);
    return { code, used, cartToken, cookies: { [CART_COOKIE]: cartToken } };
  }

  test("any intent is priced for `phone` (intent=price changes nothing); a number in a GET URL is never read; a code applied for that number is refused with its reason", async () => {
    const { code, used, cartToken, cookies } = await setup();
    const ip = freshIp();

    // the review's pricing: the number as typed («0770 …», spaces and all) in the body
    const priced = await hit("/api/cart", cartAction, { form: { intent: "price", governorateId: BAGHDAD, phone: formatIraqPhone(used) }, cookies, ip });
    expect(priced.status).toBe(200);
    expect(priced.body).toMatchObject({ ok: true, cart: { coupon: null, discountIqd: 0, totalIqd: 104_750, couponIssue: { code, reason: "customer_limit" }, count: 1, payableCount: 1 } });
    expect(priced.headers.get("Set-Cookie")).toBeNull();
    expect(priced.headers.get("Cache-Control")).toBe("no-store");
    // nothing changed: the code is still on the cart for any other number
    expect(await getCartView(t.db, { ...guest(cartToken), governorateId: BAGHDAD }, NOW)).toMatchObject({ coupon: { code }, totalIqd: 94_775 });

    // a GET never reads a number from its URL (edge and access logs keep URLs)
    const get = await hit(`/api/cart?governorateId=${BAGHDAD}&phone=${encodeURIComponent(used)}`, cartLoader, { cookies, ip });
    expect(get.body).toMatchObject({ ok: true, cart: { coupon: { code }, totalIqd: 94_775 } });

    // an edit on the review is answered for the number too: the code applied again is refused with its reason
    const again = await hit("/api/cart", cartAction, { form: { intent: "coupon", code, governorateId: BAGHDAD, phone: used }, cookies, ip });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, code: "coupon_customer_limit", fields: { code: "coupon_customer_limit" } });
    const set = await hit("/api/cart", cartAction, { form: { intent: "set", lineId: (priced.body as { cart: { lines: { id: string }[] } }).cart.lines[0]!.id, qty: "1", governorateId: BAGHDAD, phone: used }, cookies, ip });
    expect(set.body).toMatchObject({ ok: true, cart: { coupon: null, couponIssue: { code, reason: "customer_limit" }, totalIqd: 104_750 } });

    // what is not an Iraqi mobile number is no number: priced as without one
    const junk = await hit("/api/cart", cartAction, { form: { intent: "price", governorateId: BAGHDAD, phone: "12345" }, cookies, ip });
    expect(junk.body).toMatchObject({ ok: true, cart: { coupon: { code }, totalIqd: 94_775 } });
  });

  test("numbers asked about from one address are budgeted; past the budget the cart is priced as without a number (the order still checks it); requests without one never count", async () => {
    const { code, used, cookies } = await setup();
    const ip = freshIp();
    const price = (form: Record<string, string>, from = ip) => hit("/api/cart", cartAction, { form: { intent: "price", ...form }, cookies, ip: from });
    // a cart read without a number is no check
    for (let i = 0; i < 3; i++) expect((await price({})).status).toBe(200);
    // Windows are aligned to the clock: a run that crosses a boundary splits its count over two windows, so allow twice
    // the budget plus one (the loop stops at the first answer priced without the number, normally the 21st).
    const { limit } = PHONE_PRICING_PER_IP;
    let checked = 0;
    let blind: unknown = null;
    for (let i = 0; i < 2 * limit + 1; i++) {
      const answer = await price({ phone: used });
      expect(answer.status).toBe(200);
      const cart = (answer.body as { cart: { couponIssue: { reason: string } | null } }).cart;
      if (cart.couponIssue?.reason !== "customer_limit") {
        blind = answer.body;
        break;
      }
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(limit);
    expect(blind).toMatchObject({ ok: true, cart: { coupon: { code }, couponIssue: null, totalIqd: 94_775 } });
    // another address is answered for the number
    expect((await price({ phone: used }, freshIp())).body).toMatchObject({ ok: true, cart: { couponIssue: { code, reason: "customer_limit" } } });
  });
});
