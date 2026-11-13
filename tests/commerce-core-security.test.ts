/**
 * Commerce core, 2026-11-12 — the SECOND ADVERSARIAL REVIEW (security, privacy and honesty) of promotions at checkout,
 * the wallet, digital codes and the new account pages (tests/commerce-promotions.test.ts is the build's own file,
 * tests/commerce-promotions-adversarial.test.ts the first review's: money and races).
 *
 * Every attack runs the way a browser's request runs where a route exists: through the real root middleware (CSRF
 * check, request context, security headers) into the real route modules, against a throw-away local D1 + KV
 * (tests/helpers/db.ts). Rate-limit and guessing attacks run ONLY here, never against the shared dev server. Each test
 * states the CORRECT behaviour; what got through was fixed in the commerce core and its routes, never here.
 *
 * What got through, and where it was fixed (proof: the session scratchpad's work/f2-core-sec/attacks-before-fix.txt):
 *   · an ACCOUNT's order revealed its codes to its confirmation link — the link the checkout landed every shopper on,
 *     kept in the browser's history, working after sign-out on a shared device        orders/digital.server.ts (+ the
 *     order page's «سجّل الدخول لعرض الرموز»: checkout.server.ts codesNeedSignIn, order.tsx, DigitalCodes.tsx)
 *   · a signed-in shopper's checkout landed on the token link too                     routes/storefront/checkout/checkout.tsx
 *   · a cancelled order — or a parcel refused at the door — kept its referral: the code's use was never given back,
 *     so ten abandoned cash-on-delivery orders (a guest, any ten numbers) used up a friend's public code for everyone
 *     until staff rejected each referral by hand                                       orders/promotions.server.ts
 *   · a referral code checked through POST /api/cart (any intent with `referral=`) was not counted: the per-address
 *     budget of the GET (20 a minute) had a second door three times as wide (the cart's 60 changes)   routes/api/cart.ts
 *   · the checkout asked about a referral code in a GET URL (logs keep URLs)         routes/api/cart.ts (intent=price),
 *                                                                                    checkout.tsx
 *   · a checkout refused for a total sent wrong on purpose answered whether the TYPED number owns a referral code or
 *     was referred before, with nothing placed                                         orders/place.server.ts
 *   · a signed-in customer who opened someone else's order with its link and revealed its code was recorded as an
 *     anonymous guest: the audit trail lost who saw the code                           orders/digital.server.ts
 *   · (honesty: the page rendered by the server, and the browser) a revoked code said «مع الاسترداد» on a cancelled
 *     order whose refund still waited                                                  checkout/components/DigitalCodes.tsx
 *
 * What held is kept as tests (the rest of this file): the codes' access rule, loader data, caching, CSRF, the account
 * pages' ownership, the guessing budgets of gift cards and privacy requests, error bodies.
 */
import { and, eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import { newId, randomToken } from "~/lib/ids";
import type { Actor } from "~/server/actor";
import { loader as cartLoader, action as cartAction } from "~/routes/api/cart";
import { action as checkoutAction } from "~/routes/storefront/checkout/checkout";
import OrderPage, { action as orderAction, loader as orderLoader } from "~/routes/storefront/checkout/order";
import { action as trackAction } from "~/routes/storefront/checkout/track";
import { action as accountOrderAction, loader as accountOrderLoader } from "~/routes/storefront/account/order";
import { action as rewardsAction, loader as rewardsLoader } from "~/routes/storefront/account/rewards";
import { action as privacyAction, loader as privacyLoader } from "~/routes/storefront/account/privacy";
import { action as walletAction } from "~/routes/storefront/account/wallet";
import { CUSTOMER_COOKIE, signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { encryptSecret } from "~/server/crypto.server";
import { auditEvents, customers, digitalCodes, files, giftCards, orderItems, payments, privacyRequests, referralCodes, referralRedemptions } from "~/server/db/schema";
import { districtId, governorateId } from "~/server/db/seed/reference";
import type { Permission } from "~/server/permissions";
import { CART_COOKIE } from "~/server/shell.server";
import { toAppError, type AppError } from "~/server/errors";
import { issueGiftCard } from "~/server/services/admin/promotions/giftcards.server";
import { issueReferralCode, rejectReferral } from "~/server/services/admin/promotions/referrals.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { REVEAL_LIMIT } from "~/server/services/orders/digital.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { submitPaymentProof, verifyPayment } from "~/server/services/payments/payments.server";
import { creditWallet } from "~/server/services/wallet.server";
import { TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const SITE = "http://localhost:5173";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The routes read the clock (ctx.now = Date.now()); the rows they meet are written a little before. */
const NOW = Date.now() - 30 * MINUTE;
const BAGHDAD = governorateId("baghdad");
const KARRADA = districtId("baghdad", "karrada");

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
  await t?.dispose();
});

const ALL: Permission[] = [
  "orders.order.update",
  "orders.order.cancel",
  "orders.fulfillment.pack",
  "orders.fulfillment.ship",
  "orders.fulfillment.deliver",
  "orders.payment.record",
  "orders.payment.verify",
  "shipping.attempt.manage",
  "customers.wallet.adjust",
  "promotions.referral.manage",
  "promotions.gift_card.issue",
  "promotions.gift_card.manage",
];
const staff = (id = staffId, permissions: Permission[] = ALL): Actor => ({ kind: "employee", id, permissions: new Set(permissions) });

// ───────────────────────────────────────────────────────────────── harness (the storefront review's, trimmed)

let counter = 0;
/** A fresh documentation-range IPv4 address, so per-IP limits never leak between tests. */
const freshIp = () => {
  counter++;
  return `203.0.${113 + Math.floor(counter / 250) % 10}.${(counter % 250) + 1}`;
};

/**
 * Budgets count in fixed windows aligned to the clock (ratelimit.server: ⌊now ⁄ window⌋). A burst that crosses a
 * window's end splits its count over two windows, and the request past the budget is not refused — on a busy machine
 * the 21 referral checks of a minute's budget took seconds and now and then did (client round 1, wave C: a flake, not a
 * hole). A burst starts in a window with room for it: when less than `needMs` of this one is left, wait for the next.
 */
async function windowWithRoom(windowSec: number, needMs = 30_000): Promise<void> {
  const ms = windowSec * 1000;
  const left = ms - (Date.now() % ms);
  if (left < needMs) await new Promise((resolve) => setTimeout(resolve, left + 50));
}
/** A test that may wait for a fresh minute before its burst (windowWithRoom). */
const BURST_BUDGET = { timeout: 120_000 } as const;

function context(options: { cookies?: Record<string, string>; ip?: string | null } = {}): { ctx: RequestCtx; setCookies: string[] } {
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `core-sec-${++counter}`,
    nonce: "test-nonce",
    origin: SITE,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: options.ip === undefined ? freshIp() : options.ip,
    country: "IQ",
    userAgent: "Mozilla/5.0 (core security review)",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "live",
    cookie: (name) => jar.get(name) ?? null,
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

type Handler = (args: never) => unknown;
type HitInit = {
  method?: string;
  form?: Record<string, string>;
  cookies?: Record<string, string>;
  params?: Record<string, string>;
  ip?: string | null;
  /** Origin header for non-GET requests; null sends none. Default: the site itself. */
  origin?: string | null;
  headers?: Record<string, string>;
};
type Hit = { status: number; headers: Headers; location: string | null; body: unknown; error?: unknown };
type DataWithInit = { type?: string; data: unknown; init?: { status?: number; headers?: HeadersInit } | null };
const isDataWithInit = (value: unknown): value is DataWithInit => typeof value === "object" && value !== null && "data" in value && "init" in value;

function asResponse(value: unknown): { response: Response; body: unknown } {
  if (value instanceof Response) return { response: value, body: null };
  if (isDataWithInit(value)) {
    const init = value.init ?? {};
    return { response: new Response(JSON.stringify(value.data ?? null), { status: init.status ?? 200, headers: init.headers }), body: value.data };
  }
  return { response: new Response(JSON.stringify(value ?? null), { status: 200, headers: { "Content-Type": "application/json" } }), body: value };
}

/** One request through the root middleware into `handler` (a loader or an action of a route module). */
async function hit(path: string, handler: Handler, init: HitInit = {}): Promise<Hit> {
  const method = init.method ?? (init.form ? "POST" : "GET");
  const headers = new Headers(init.headers);
  const ip = init.ip === undefined ? freshIp() : init.ip;
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (init.cookies) headers.set("Cookie", Object.entries(init.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
  if (method !== "GET" && method !== "HEAD" && init.origin !== null) headers.set("Origin", init.origin ?? SITE);
  const body = init.form ? new URLSearchParams(init.form) : null;
  const request = new Request(`${SITE}${path}`, { method, headers, body });
  const routerContext = new RouterContextProvider();
  const url = new URL(request.url);
  let inner: unknown;
  let innerError: unknown;
  let response: Response;
  try {
    response = (await requestContextMiddleware({ request, context: routerContext, url, pattern: path, params: init.params ?? {} } as never, async () => {
      try {
        inner = await (handler as (args: unknown) => unknown)({ request, context: routerContext, params: init.params ?? {}, url, pattern: path });
      } catch (thrown) {
        if (thrown instanceof Response || isDataWithInit(thrown)) inner = thrown;
        else {
          innerError = thrown;
          return new Response("unexpected", { status: 500 });
        }
      }
      return asResponse(inner).response;
    })) as Response;
  } catch (thrown) {
    const converted = asResponse(thrown);
    return { status: converted.response.status, headers: converted.response.headers, location: converted.response.headers.get("Location"), body: converted.body };
  }
  return { status: response.status, headers: response.headers, location: response.headers.get("Location"), body: asResponse(inner).body, error: innerError };
}

/** The cookies a browser keeps after these Set-Cookie headers. */
function jarAfter(setCookies: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const serialized of setCookies) {
    const [pair, ...attributes] = serialized.split(/;\s*/);
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    const value = decodeURIComponent(pair.slice(at + 1));
    if (attributes.some((attribute) => attribute.toLowerCase() === "max-age=0")) delete jar[name];
    else jar[name] = value;
  }
  return jar;
}

/** A customer with a password, signed in: their id, phone and cookie jar. */
async function customerWithSession(): Promise<{ id: string; phone: string; jar: Record<string, string> }> {
  const phone = make.phone();
  const req = context();
  const session = await signUpCustomer(req.ctx, t.db, { phone, password: `pw-${randomToken(12)}`, name: "زبون مراجعة الأمان" });
  return { id: session.customer.id, phone, jar: jarAfter(req.setCookies) };
}

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

// ───────────────────────────────────────────────────────────────── fixtures

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
    .select({ id: digitalCodes.id, status: digitalCodes.status, revealCount: digitalCodes.revealCount, revealedAt: digitalCodes.revealedAt })
    .from(digitalCodes)
    .innerJoin(orderItems, eq(orderItems.id, digitalCodes.orderItemId))
    .where(eq(orderItems.orderId, orderId));

const revealAudits = (codeId: string) => t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "orders.digital_code.reveal"), eq(auditEvents.entityId, codeId)));

async function proofFile(): Promise<string> {
  const id = newId("fil");
  await t.db.insert(files).values({ id, storageKey: `prv/${id}.jpg`, visibility: "private", kind: "payment_proof", mime: "image/jpeg", bytes: 40_000, sha256: randomToken().toLowerCase(), createdAt: NOW });
  return id;
}

function checkoutFields(phone: string, overrides: Partial<CheckoutInput> = {}): Omit<CheckoutInput, "expectedTotalIqd"> {
  return {
    idempotencyKey: randomToken(),
    phone,
    governorateId: BAGHDAD,
    districtId: KARRADA,
    areaText: "الكرادة داخل",
    addressText: "شارع 62، قرب الجسر المعلق، عمارة 4",
    marketingConsent: false,
    paymentMethod: "cod",
    ...overrides,
  };
}

/** A guest's order for these lines (one variant each); returns what placeOrder returned and the phone. */
async function guestOrder(lines: { variantId: string; qty?: number }[], overrides: Partial<CheckoutInput> = {}, at = NOW) {
  let cartToken: string | null = null;
  for (const line of lines) cartToken = (await addToCart(t.db, { cartToken, customerId: null, locale: "ar" }, { variantId: line.variantId, qty: line.qty ?? 1 }, at)).cartToken;
  const view = await getCartView(t.db, { cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD, referralCode: overrides.referralCode ?? null }, at);
  const phone = overrides.phone ?? make.phone();
  const placed = await placeOrder(t.db, { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(phone, overrides), expectedTotalIqd: view.totalIqd }, at);
  return { ...placed, phone, cartToken };
}

/** A guest's PAID digital order (a transfer, its proof approved): its token and its delivered code's id. */
async function paidGuestDigitalOrder(code: string) {
  const product = await digitalProduct([code]);
  const placed = await guestOrder([{ variantId: product.variantId }], { paymentMethod: "bank_transfer" });
  const total = (await t.db.select({ amount: payments.amountIqd }).from(payments).where(eq(payments.orderId, placed.orderId)).get())?.amount ?? 0;
  await submitPaymentProof(t.db, { orderRef: placed.ref, accessToken: placed.accessToken }, { fileId: await proofFile(), declaredAmountIqd: total }, NOW + MINUTE);
  const pay = (await t.db.select().from(payments).where(eq(payments.orderId, placed.orderId)).get())!;
  await verifyPayment(t.db, staff(otherStaffId, ["orders.payment.verify"]), pay.id, { approve: true }, NOW + 2 * MINUTE);
  const codes = await codesOf(placed.orderId);
  expect(codes.map((row) => row.status)).toEqual(["delivered"]);
  return { ...placed, codeId: codes[0]!.id, product };
}

/** A signed-in customer's wallet-paid digital order (paid when placed). */
async function paidCustomerDigitalOrder(customer: { id: string }, code: string) {
  const product = await digitalProduct([code]);
  await creditWallet(t.db, staff(), { customerId: customer.id, amountIqd: 100_000, kind: "topup", reason: "شحن للاختبار", idempotencyKey: `test:${randomToken()}` }, NOW - HOUR);
  const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: customer.id, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
  const view = await getCartView(t.db, { cartToken, customerId: customer.id, locale: "ar", governorateId: BAGHDAD }, NOW);
  const placed = await placeOrder(t.db, { cartToken, customer: { id: customer.id }, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(make.phone(), { paymentMethod: "wallet" }), expectedTotalIqd: view.totalIqd }, NOW);
  const codes = await codesOf(placed.orderId);
  expect(codes.map((row) => row.status)).toEqual(["delivered"]);
  return { ...placed, codeId: codes[0]!.id };
}

const revealForm = (codeId: string, token?: string): Record<string, string> => ({ intent: "reveal", codeId, ...(token ? { t: token } : {}) });

/** The order page as the server renders it (checkout-flow's stub), from what its loader answered. */
function renderOrderPage(url: string, loaderData: unknown): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "order/:ref", Component: OrderPage as never }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [url],
      hydrationData: {
        loaderData: {
          root: { locale: "ar", dir: "rtl", fx: null, origin: "https://tamtamgames.com", i18n: messagesFor("ar", "common", "ui", "ui-card", "ui-shop", "ui-overlays") },
          page: { ...(loaderData as Record<string, unknown>), recommendations: null } as never,
        },
      },
    }),
  );
}

// ───────────────────────────────────────────────────────────────── 1. digital codes

describe("digital codes — only to the buyer, only after payment, never in page data, never stored, every reveal audited", () => {
  test("a guest's paid code opens with the order's own link only: no token, another order's token, a signed-in stranger, /track — the same 404, nothing revealed, nothing audited", async () => {
    const order = await paidGuestDigitalOrder("PSN-SEC-GUEST-0001");
    const other = await paidGuestDigitalOrder("PSN-SEC-OTHER-0002");
    const stranger = await customerWithSession();
    const path = `/order/${order.ref}`;
    const attempts: Hit[] = [
      await hit(path, orderAction, { form: revealForm(order.codeId), params: { ref: order.ref } }),
      await hit(path, orderAction, { form: revealForm(order.codeId, other.accessToken), params: { ref: order.ref } }),
      // a near miss: the real token with its last character changed (never the same character by chance)
      await hit(path, orderAction, { form: revealForm(order.codeId, `${order.accessToken.slice(0, -1)}${order.accessToken.endsWith("A") ? "B" : "A"}`), params: { ref: order.ref } }),
      await hit(path, orderAction, { form: revealForm(order.codeId), params: { ref: order.ref }, cookies: stranger.jar }),
      // the other order's own link, asking for THIS order's code
      await hit(`/order/${other.ref}`, orderAction, { form: revealForm(order.codeId, other.accessToken), params: { ref: other.ref } }),
      // the stranger's account page, with this order's reference
      await hit(`/account/orders/${order.ref}`, accountOrderAction, { form: revealForm(order.codeId), params: { ref: order.ref }, cookies: stranger.jar }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(404);
      expect(JSON.stringify(attempt.body)).not.toContain("PSN-SEC-GUEST");
    }
    // /track (reference + phone) shows the order read-only: a reveal posted there is a lookup, never a code
    const tracked = await hit("/track", trackAction, { form: { intent: "reveal", codeId: order.codeId, ref: order.ref, phone: order.phone } });
    expect(tracked.status).toBe(200);
    expect(JSON.stringify(tracked.body)).not.toContain("PSN-SEC-GUEST");
    expect((await codesOf(order.orderId))[0]).toMatchObject({ revealCount: 0, revealedAt: null });
    expect(await revealAudits(order.codeId)).toHaveLength(0);

    // the link itself: the code, never stored by a cache, audited with the address and without the code
    const ip = freshIp();
    const shown = await hit(path, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref }, ip });
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ ok: true, codeId: order.codeId, code: "PSN-SEC-GUEST-0001" });
    expect(shown.headers.get("Cache-Control")).toBe("no-store");
    const audits = await revealAudits(order.codeId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: "guest", ip });
    expect(JSON.stringify(audits[0])).not.toContain("PSN-SEC-GUEST");
  });

  test("the order page's data, the account's order page and /track never carry a code — before or after it was revealed", async () => {
    const customer = await customerWithSession();
    const order = await paidCustomerDigitalOrder(customer, "XBX-SEC-DATA-0003");
    const pages = async () => [
      await hit(`/order/${order.ref}?t=${order.accessToken}`, orderLoader, { params: { ref: order.ref } }),
      await hit(`/order/${order.ref}`, orderLoader, { params: { ref: order.ref }, cookies: customer.jar }),
      await hit(`/account/orders/${order.ref}`, accountOrderLoader, { params: { ref: order.ref }, cookies: customer.jar }),
    ];
    for (const page of await pages()) {
      expect(page.status).toBe(200);
      expect(page.headers.get("Cache-Control")).toBe("no-store");
      const text = JSON.stringify(page.body);
      expect(text).toContain(order.codeId);
      expect(text).not.toContain("XBX-SEC-DATA");
    }
    const shown = await hit(`/account/orders/${order.ref}`, accountOrderAction, { form: revealForm(order.codeId), params: { ref: order.ref }, cookies: customer.jar });
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ ok: true, code: "XBX-SEC-DATA-0003" });
    expect(shown.headers.get("Cache-Control")).toBe("no-store");
    for (const page of await pages()) expect(JSON.stringify(page.body)).not.toContain("XBX-SEC-DATA");
  });

  test("before payment there is nothing to open: no code lines in the page, and an unsold code's id is the same 404", async () => {
    const product = await digitalProduct(["PSN-SEC-UNPAID-0004"]);
    const unsold = (await t.db.select({ id: digitalCodes.id }).from(digitalCodes).where(eq(digitalCodes.variantId, product.variantId)).get())!.id;
    const order = await guestOrder([{ variantId: product.variantId }], { paymentMethod: "zaincash" });
    const page = await hit(`/order/${order.ref}?t=${order.accessToken}`, orderLoader, { params: { ref: order.ref } });
    expect((page.body as { found: { order: { digital: unknown[] } } }).found.order.digital).toEqual([]);
    const asked = await hit(`/order/${order.ref}`, orderAction, { form: revealForm(unsold, order.accessToken), params: { ref: order.ref } });
    expect(asked.status).toBe(404);
    expect(JSON.stringify(asked.body)).not.toContain("PSN-SEC-UNPAID");
  });

  test("a reveal from another site, or by a method other than POST from another site, is refused before the route runs", async () => {
    const order = await paidGuestDigitalOrder("PSN-SEC-CSRF-0005");
    for (const origin of ["https://evil.example", "null"]) {
      const refused = await hit(`/order/${order.ref}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref }, origin });
      expect(refused.status).toBe(403);
    }
    const noOrigin = await hit(`/order/${order.ref}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref }, origin: null, headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(noOrigin.status).toBe(403);
    const put = await hit(`/order/${order.ref}`, orderAction, { method: "PUT", form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref }, origin: "https://evil.example" });
    expect(put.status).toBe(403);
    expect((await codesOf(order.orderId))[0]?.revealCount).toBe(0);
  });

  test("a buyer's reveals are counted per order: the one after the limit within the hour is 429 and shows nothing", BURST_BUDGET, async () => {
    const order = await paidGuestDigitalOrder("PSN-SEC-LIMIT-0006");
    await windowWithRoom(REVEAL_LIMIT.windowSec);
    for (let i = 0; i < REVEAL_LIMIT.limit; i++) {
      const shown = await hit(`/order/${order.ref}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref } });
      expect(shown.status).toBe(200);
    }
    const refused = await hit(`/order/${order.ref}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref } });
    expect(refused.status).toBe(429);
    expect(JSON.stringify(refused.body)).not.toContain("PSN-SEC-LIMIT");
    expect(await revealAudits(order.codeId)).toHaveLength(REVEAL_LIMIT.limit);
  });

  test("an ACCOUNT's order shows its codes to its signed-in owner only: its confirmation link (in the browser's history, still working after sign-out on a shared device) opens the order, never the codes", async () => {
    const owner = await customerWithSession();
    const order = await paidCustomerDigitalOrder(owner, "PSN-SEC-SHARED-0010");
    // the next person on the device: no session, the link from the history
    const fromHistory = await hit(`/order/${order.ref}?t=${order.accessToken}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref } });
    expect(fromHistory.status).toBe(404);
    expect(JSON.stringify(fromHistory.body)).not.toContain("PSN-SEC-SHARED");
    // the page still opens (the link's job), and says the codes need the owner's sign-in
    const page = await hit(`/order/${order.ref}?t=${order.accessToken}`, orderLoader, { params: { ref: order.ref } });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ codesSignIn: true });
    // another signed-in customer with the link: the same
    const other = await customerWithSession();
    expect((await hit(`/order/${order.ref}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref }, cookies: other.jar })).status).toBe(404);
    expect((await codesOf(order.orderId))[0]?.revealCount).toBe(0);
    // the owner, signed in — on the same page or in the account
    const ownPage = await hit(`/order/${order.ref}?t=${order.accessToken}`, orderLoader, { params: { ref: order.ref }, cookies: owner.jar });
    expect(ownPage.body).toMatchObject({ codesSignIn: false });
    const shown = await hit(`/order/${order.ref}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref }, cookies: owner.jar });
    expect(shown.body).toMatchObject({ ok: true, code: "PSN-SEC-SHARED-0010" });
    // a guest's order has no account to sign in to: its link is what opens its codes
    const guest = await paidGuestDigitalOrder("PSN-SEC-SHARED-0011");
    expect((await hit(`/order/${guest.ref}?t=${guest.accessToken}`, orderLoader, { params: { ref: guest.ref } })).body).toMatchObject({ codesSignIn: false });
  });

  test("the order page says what is true: an account's codes opened by its link say «sign in» and offer no reveal; a cancelled order's revoked code never claims a refund", async () => {
    const owner = await customerWithSession();
    // an account's paid order, opened with its link by nobody signed in
    const open = await paidCustomerDigitalOrder(owner, "PSN-SEC-PAGE-0012");
    const linked = await hit(`/order/${open.ref}?t=${open.accessToken}`, orderLoader, { params: { ref: open.ref } });
    const signInHtml = renderOrderPage(`/order/${open.ref}?t=${open.accessToken}`, linked.body);
    expect(signInHtml).toContain("هذا الطلب مرتبط بحساب");
    expect(signInHtml).toContain(`/account/login?next=${encodeURIComponent(`/order/${open.ref}`)}`);
    expect(signInHtml).not.toContain("اعرض الرمز");
    // the same order cancelled after payment (its refund waits for a second person): the code is revoked
    const cancelled = await paidCustomerDigitalOrder(owner, "PSN-SEC-PAGE-0013");
    await transitionOrder(t.db, staff(), cancelled.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW + MINUTE);
    const page = await hit(`/order/${cancelled.ref}`, orderLoader, { params: { ref: cancelled.ref }, cookies: owner.jar });
    const html = renderOrderPage(`/order/${cancelled.ref}`, page.body);
    expect(html).toContain("أُلغي هذا الرمز لأن الطلب أُلغي أو أُعيد.");
    expect(html).not.toContain("مع الاسترداد");
    expect(html).not.toContain("PSN-SEC-PAGE");
  });

  test("a signed-in shopper lands on their order without the link's token (nothing in the browser's history opens it after sign-out); a guest gets the link", async () => {
    const product = await make.product({ stock: 10, priceIqd: 21_000 });
    const form = (total: number): Record<string, string> => ({
      idempotencyKey: randomToken(),
      phone: make.phone(),
      governorateId: BAGHDAD,
      districtId: KARRADA,
      areaText: "الكرادة داخل",
      addressText: "شارع 62، قرب الجسر المعلق، عمارة 4",
      paymentMethod: "cod",
      expectedTotalIqd: String(total),
    });
    const customer = await customerWithSession();
    const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: customer.id, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
    const view = await getCartView(t.db, { cartToken, customerId: customer.id, locale: "ar", governorateId: BAGHDAD }, NOW);
    const signedIn = await hit("/checkout", checkoutAction, { form: form(view.totalIqd), cookies: { ...customer.jar, [CART_COOKIE]: cartToken } });
    expect(signedIn.status).toBe(302);
    expect(signedIn.location).toMatch(/^\/order\/TT-[A-Z0-9]+$/);
    const guestCart = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
    const guestView = await getCartView(t.db, { cartToken: guestCart.cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW);
    const guest = await hit("/checkout", checkoutAction, { form: form(guestView.totalIqd), cookies: { [CART_COOKIE]: guestCart.cartToken } });
    expect(guest.status).toBe(302);
    expect(guest.location).toMatch(/^\/order\/TT-[A-Z0-9]+\?t=[A-Za-z0-9_-]{43}$/);
  });

  test("a signed-in customer who opens someone else's order with its link and reveals its code is named in the audit trail (with how they got in)", async () => {
    const order = await paidGuestDigitalOrder("PSN-SEC-WHO-0007");
    const friend = await customerWithSession();
    const shown = await hit(`/order/${order.ref}`, orderAction, { form: revealForm(order.codeId, order.accessToken), params: { ref: order.ref }, cookies: friend.jar });
    expect(shown.status).toBe(200);
    const [audit] = await revealAudits(order.codeId);
    expect(audit).toMatchObject({ actorKind: "customer", actorId: friend.id });
    expect((audit?.after as { access?: string } | null)?.access).toBe("link");
    // the owner of an account order revealing from the account says so too
    const owner = await customerWithSession();
    const own = await paidCustomerDigitalOrder(owner, "PSN-SEC-WHO-0008");
    await hit(`/account/orders/${own.ref}`, accountOrderAction, { form: revealForm(own.codeId), params: { ref: own.ref }, cookies: owner.jar });
    const [ownAudit] = await revealAudits(own.codeId);
    expect(ownAudit).toMatchObject({ actorKind: "customer", actorId: owner.id });
    expect((ownAudit?.after as { access?: string } | null)?.access).toBe("account");
  });
});

// ───────────────────────────────────────────────────────────────── 2. referral codes

describe("referral codes — guessing is budgeted at every door, and an order that never happened gives its use back", () => {
  async function referralCode(maxUses: number): Promise<{ code: string; referrerId: string; codeId: string }> {
    const referrerId = await make.customer();
    const issued = await issueReferralCode(t.db, staff(), { customerId: referrerId, maxUses }, NOW - DAY);
    return { code: issued.code, referrerId, codeId: issued.codeId };
  }

  test("codes asked about through POST /api/cart count against the same per-address budget as the GET: 20 a minute, whichever the door", BURST_BUDGET, async () => {
    const product = await make.product({ stock: 5, priceIqd: 40_000 });
    const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
    const cookies = { [CART_COOKIE]: cartToken };
    // the POST alone: the 21st code checked from one address in a minute is refused, whatever the intent
    const ip = freshIp();
    await windowWithRoom(60);
    const answers: number[] = [];
    for (let i = 0; i < 21; i++) answers.push((await hit("/api/cart", cartAction, { form: { intent: "coupon", code: "", referral: `TTGUESS${String(i).padStart(2, "0")}` }, cookies, ip })).status);
    expect(answers.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(answers[20]).toBe(429);
    // and the two doors share the budget: twenty GETs, then a POST from the same address is refused
    const shared = freshIp();
    await windowWithRoom(60);
    for (let i = 0; i < 20; i++) expect((await hit(`/api/cart?referral=TTSHARE${i}`, cartLoader, { cookies, ip: shared })).status).toBe(200);
    const post = await hit("/api/cart", cartAction, { form: { intent: "coupon", code: "", referral: "TTSHAREXX" }, cookies, ip: shared });
    expect(post.status).toBe(429);
    expect(post.headers.get("Retry-After")).not.toBeNull();
    // a cart change WITHOUT a code is not a check: it never meets the referral budget
    expect((await hit("/api/cart", cartAction, { form: { intent: "coupon", code: "" }, cookies, ip: shared })).status).toBe(200);
  });

  test("a code the checkout asks about travels in a body, never in a URL: POST intent=price answers the priced cart, changes nothing and counts as a check", BURST_BUDGET, async () => {
    const { code } = await referralCode(5);
    const product = await make.product({ stock: 5, priceIqd: 35_000 });
    const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 2 }, NOW);
    const cookies = { [CART_COOKIE]: cartToken };
    const before = await getCartView(t.db, { cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW);
    const ip = freshIp();
    await windowWithRoom(60);
    const priced = await hit("/api/cart", cartAction, { form: { intent: "price", governorateId: BAGHDAD, referral: code }, cookies, ip });
    expect(priced.status).toBe(200);
    expect(priced.body).toMatchObject({ ok: true, cart: { totalIqd: before.totalIqd, referral: { code, status: "ok" } } });
    expect(priced.headers.get("Set-Cookie")).toBeNull();
    expect(priced.headers.get("Cache-Control")).toBe("no-store");
    const after = await getCartView(t.db, { cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW);
    expect(after).toEqual(before);
    // it is a check like any other: 19 more from the address, then the next one waits
    for (let i = 0; i < 19; i++) expect((await hit("/api/cart", cartAction, { form: { intent: "price", referral: `TTPRICE${i}` }, cookies, ip })).status).toBe(200);
    expect((await hit("/api/cart", cartAction, { form: { intent: "price", referral: "TTPRICEXX" }, cookies, ip })).status).toBe(429);
  });

  test("a cancelled order gives its referral back: the code's use is free again and the referral is closed — abandoned orders cannot use up a friend's public code", async () => {
    const { code, codeId } = await referralCode(1);
    const product = await make.product({ stock: 10, priceIqd: 60_000 });
    // a guest (any number) places a cash-on-delivery order with the public code and never answers
    const abandoned = await guestOrder([{ variantId: product.variantId }], { referralCode: code });
    expect((await t.db.select({ uses: referralCodes.uses }).from(referralCodes).where(eq(referralCodes.id, codeId)).get())?.uses).toBe(1);
    // the real friend is refused while it stands
    expect((await failureOf(guestOrder([{ variantId: product.variantId }], { referralCode: code }))).code).toBe("referral_cap_reached");
    // staff cancel the fake order: the use comes back, the referral is closed with the reason
    await transitionOrder(t.db, staff(), abandoned.orderId, "cancelled", { reason: "لا يرد على الهاتف" }, NOW + HOUR);
    expect((await t.db.select({ uses: referralCodes.uses }).from(referralCodes).where(eq(referralCodes.id, codeId)).get())?.uses).toBe(0);
    const closed = await t.db.select().from(referralRedemptions).where(eq(referralRedemptions.orderId, abandoned.orderId)).get();
    expect(closed?.status).toBe("rejected");
    expect(closed?.rejectReason).toContain(abandoned.ref);
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "promotions.referral.reject"), eq(auditEvents.entityId, closed!.id)))).toHaveLength(1);
    // the friend's order now records the referral
    const friend = await guestOrder([{ variantId: product.variantId }], { referralCode: code }, NOW + 2 * HOUR);
    expect((await t.db.select().from(referralRedemptions).where(eq(referralRedemptions.orderId, friend.orderId)).get())?.status).toBe("pending");
    expect((await t.db.select({ uses: referralCodes.uses }).from(referralCodes).where(eq(referralCodes.id, codeId)).get())?.uses).toBe(1);
  });

  test("a checkout refused for its total never says whether the TYPED number owns the code or was referred before: testing numbers against a public code costs an order each", async () => {
    const { code, referrerId } = await referralCode(10);
    const referrerPhone = (await t.db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, referrerId)).get())!.phone;
    const product = await make.product({ stock: 10, priceIqd: 45_000 });
    // a number that was referred once already
    const referred = await guestOrder([{ variantId: product.variantId }], { referralCode: code });
    const probe = async (phone: string) => {
      const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
      const failure = await failureOf(placeOrder(t.db, { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(phone, { referralCode: code }), expectedTotalIqd: 1 }, NOW));
      expect(failure.code).toBe("totals_changed");
      return (failure as AppError & { cart?: { referral?: { code: string; status: string } | null } | null }).cart?.referral ?? null;
    };
    // the refusal shows the code as the cart page does — known and open — whichever number was typed
    for (const phone of [referrerPhone, referred.phone, make.phone()]) expect(await probe(phone)).toEqual({ code, status: "ok" });
    // the order itself still refuses the owner's number on the field (that answer costs a full, correct checkout)
    const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
    const view = await getCartView(t.db, { cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW);
    const own = await failureOf(placeOrder(t.db, { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(referrerPhone, { referralCode: code }), expectedTotalIqd: view.totalIqd }, NOW));
    expect(own).toMatchObject({ code: "referral_self", fields: { referralCode: "referral_self" } });
  });

  test("a parcel refused at the door (shipped → returned) gives its referral back like a cancellation — once, even when module 08 rejected it first", async () => {
    const { code, codeId } = await referralCode(2);
    const product = await make.product({ stock: 10, priceIqd: 70_000 });
    const refused = await guestOrder([{ variantId: product.variantId }], { referralCode: code });
    const rejectedFirst = await guestOrder([{ variantId: product.variantId }], { referralCode: code });
    expect((await t.db.select({ uses: referralCodes.uses }).from(referralCodes).where(eq(referralCodes.id, codeId)).get())?.uses).toBe(2);
    await transitionOrder(t.db, staff(), refused.orderId, "confirmed", {}, NOW + MINUTE);
    await transitionOrder(t.db, staff(), refused.orderId, "shipped", {}, NOW + 2 * MINUTE);
    await transitionOrder(t.db, staff(), refused.orderId, "returned", { reason: "رفض الاستلام عند الباب" }, NOW + 3 * MINUTE);
    expect((await t.db.select({ uses: referralCodes.uses }).from(referralCodes).where(eq(referralCodes.id, codeId)).get())?.uses).toBe(1);
    expect((await t.db.select().from(referralRedemptions).where(eq(referralRedemptions.orderId, refused.orderId)).get())?.status).toBe("rejected");
    // module 08's reviewer rejected the other one by hand (uses − 1), then the order is cancelled: nothing twice
    const row = (await t.db.select().from(referralRedemptions).where(eq(referralRedemptions.orderId, rejectedFirst.orderId)).get())!;
    await rejectReferral(t.db, staff(), { referralId: row.id, reason: "نفس العنوان" }, NOW + 4 * MINUTE);
    expect((await t.db.select({ uses: referralCodes.uses }).from(referralCodes).where(eq(referralCodes.id, codeId)).get())?.uses).toBe(0);
    await transitionOrder(t.db, staff(), rejectedFirst.orderId, "cancelled", { reason: "إحالة مرفوضة" }, NOW + 5 * MINUTE);
    expect((await t.db.select({ uses: referralCodes.uses }).from(referralCodes).where(eq(referralCodes.id, codeId)).get())?.uses).toBe(0);
    expect((await t.db.select().from(referralRedemptions).where(eq(referralRedemptions.id, row.id)).get())?.rejectReason).toBe("نفس العنوان");
  });
});

// ───────────────────────────────────────────────────────────────── 3. the account pages: ownership, budgets, CSRF

describe("the account's new pages — only one's own points, codes, wallet and requests; guessing budgets per account AND per address", () => {
  test("a signed-in customer's rewards, privacy and order pages show their own rows only; another customer's order and its code are the same 404 as none", async () => {
    const alice = await customerWithSession();
    const bob = await customerWithSession();
    const aliceOrder = await paidCustomerDigitalOrder(alice, "PSN-SEC-ALICE-0009");
    const aliceCode = (await hit("/account/rewards", rewardsAction, { form: { intent: "referral" }, cookies: alice.jar })).body as { code: string };
    const aliceRequest = (await hit("/account/privacy", privacyAction, { form: { kind: "export", details: "", attempt: `alice${randomToken(8)}` }, cookies: alice.jar })).body as { ref: string };
    expect(aliceCode.code).toMatch(/^TT/);
    expect(aliceRequest.ref).toMatch(/^PR-/);

    const bobRewards = JSON.stringify((await hit("/account/rewards", rewardsLoader, { cookies: bob.jar })).body);
    const bobPrivacy = JSON.stringify((await hit("/account/privacy", privacyLoader, { cookies: bob.jar })).body);
    expect(bobRewards).not.toContain(aliceCode.code);
    expect(bobRewards).not.toContain(aliceOrder.ref);
    expect(bobPrivacy).not.toContain(aliceRequest.ref);
    const page = await hit(`/account/orders/${aliceOrder.ref}`, accountOrderLoader, { params: { ref: aliceOrder.ref }, cookies: bob.jar });
    const none = await hit("/account/orders/TT-NOSUCH99", accountOrderLoader, { params: { ref: "TT-NOSUCH99" }, cookies: bob.jar });
    expect(page.status).toBe(404);
    expect(page.body).toEqual(none.body);
    // the referral and privacy forms take no one else's id: a posted customerId or phone changes nothing
    const posted = await hit("/account/privacy", privacyAction, { form: { kind: "delete", details: "", attempt: `bob${randomToken(8)}`, customerId: alice.id, phone: alice.phone }, cookies: bob.jar });
    expect(posted.status).toBe(200);
    const filed = await t.db.select().from(privacyRequests).where(eq(privacyRequests.ref, (posted.body as { ref: string }).ref)).get();
    expect(filed?.customerId).toBe(bob.id);
  });

  test("a guest reaching the account's new forms is sent to sign in, and nothing is written", async () => {
    const before = await t.db.select({ n: sql<number>`count(*)` }).from(privacyRequests).get();
    const forms: [string, Handler, Record<string, string>][] = [
      ["/account/rewards", rewardsAction, { intent: "referral" }],
      ["/account/privacy", privacyAction, { kind: "export", details: "", attempt: randomToken(10) }],
      ["/account/wallet", walletAction, { intent: "gift_check", code: "ABCD-EFGH-2345-6789" }],
      ["/account/orders/TT-ABCD2345", accountOrderAction, { intent: "reveal", codeId: "dgc_x" }],
    ];
    for (const [path, handler, form] of forms) {
      const answer = await hit(path, handler, { form, params: { ref: "TT-ABCD2345" } });
      expect(answer.status).toBe(302);
      expect(answer.location).toContain("/account/login");
    }
    expect((await t.db.select({ n: sql<number>`count(*)` }).from(privacyRequests).get())?.n).toBe(before?.n);
  });

  test("the new forms refuse another site's post before they run", async () => {
    const customer = await customerWithSession();
    const forms: [string, Handler, Record<string, string>][] = [
      ["/account/rewards", rewardsAction, { intent: "referral" }],
      ["/account/privacy", privacyAction, { kind: "delete", details: "", attempt: randomToken(10) }],
      ["/account/wallet", walletAction, { intent: "gift_redeem", code: "ABCD-EFGH-2345-6789", idempotencyKey: randomToken(10) }],
      ["/api/cart", cartAction, { intent: "coupon", code: "", points: "500", referral: "TTABCDEF" }],
    ];
    for (const [path, handler, form] of forms) {
      const answer = await hit(path, handler, { form, cookies: customer.jar, origin: "https://evil.example" });
      expect(answer.status).toBe(403);
    }
    expect(await t.db.select().from(privacyRequests).where(eq(privacyRequests.customerId, customer.id))).toHaveLength(0);
    expect(await t.db.select().from(referralCodes).where(eq(referralCodes.customerId, customer.id))).toHaveLength(0);
  });

  test("gift-card guesses share one budget per address: a second (free) account on the same line gets no fresh tries", BURST_BUDGET, async () => {
    const ip = freshIp();
    const first = await customerWithSession();
    const second = await customerWithSession();
    await windowWithRoom(10 * 60);
    const guess = (jar: Record<string, string>) => hit("/account/wallet", walletAction, { form: { intent: "gift_check", code: `ABCD-EFGH-${randomToken(8).toUpperCase().replace(/[^A-Z2-9]/g, "Q").slice(0, 4)}-2345` }, cookies: jar, ip });
    for (let i = 0; i < 10; i++) expect((await guess(first.jar)).status).toBe(404);
    const refused = await guess(second.jar);
    expect(refused.status).toBe(429);
    // and a real card checked from there is refused too (the budget is spent, nothing is said about the card)
    const issued = await issueGiftCard(t.db, staff(), TEST_VARS.DATA_KEY, { amountIqd: 25_000, expiresOn: null, note: "تعويض", idempotencyKey: randomToken(12) }, NOW);
    const real = await hit("/account/wallet", walletAction, { form: { intent: "gift_check", code: issued.code ?? "" }, cookies: second.jar, ip });
    expect(real.status).toBe(429);
    expect(JSON.stringify(real.body)).not.toContain("25000");
    expect((await t.db.select({ status: giftCards.status }).from(giftCards).where(eq(giftCards.id, issued.cardId!)).get())?.status).toBe("active");
    // the code is never written anywhere readable: its audit events carry the last four characters at most
    const trail = JSON.stringify(await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, issued.cardId!)));
    expect(trail).not.toContain((issued.code ?? "").replace(/-/g, ""));
    expect(trail).not.toContain(issued.code ?? "--");
  });

  test("privacy requests are budgeted per address too, and a refusal never says what is already open", async () => {
    const ip = freshIp();
    const accounts = [await customerWithSession(), await customerWithSession()];
    const file = (jar: Record<string, string>, kind: string) => hit("/account/privacy", privacyAction, { form: { kind, details: "", attempt: randomToken(12) }, cookies: jar, ip });
    const first = await file(accounts[0]!.jar, "export");
    expect(first.status).toBe(200);
    const again = await file(accounts[0]!.jar, "export");
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, code: "privacy_open_exists" });
    expect(JSON.stringify(again.body)).not.toContain((first.body as { ref: string }).ref);
    await file(accounts[0]!.jar, "rectify"); // invalid: a correction needs its details — not counted
    await file(accounts[0]!.jar, "delete");
    await file(accounts[1]!.jar, "export");
    await file(accounts[1]!.jar, "delete");
    // five filings from this address today (the invalid one was never counted): the sixth, from either account, waits
    const refused = await file(accounts[1]!.jar, "rectify");
    expect([400, 429]).toContain(refused.status);
    const sixth = await hit("/account/privacy", privacyAction, { form: { kind: "rectify", details: "اسمي مكتوب خطأ", attempt: randomToken(12) }, cookies: accounts[1]!.jar, ip });
    expect(sixth.status).toBe(429);
  });

  test("points belong to a signed-in customer: a guest's cart prices none and a guest's checkout asking for them is refused", async () => {
    const product = await make.product({ stock: 5, priceIqd: 50_000 });
    const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
    const priced = await hit(`/api/cart?points=4000&governorateId=${BAGHDAD}`, cartLoader, { cookies: { [CART_COOKIE]: cartToken } });
    expect(priced.body).toMatchObject({ ok: true, cart: { points: null, discountIqd: 0 } });
    const view = await getCartView(t.db, { cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW);
    const refused = await failureOf(placeOrder(t.db, { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(make.phone(), { redeemPoints: 4000 }), expectedTotalIqd: view.totalIqd }, NOW));
    expect(refused.code).toBe("points_requires_account");
    const split = await failureOf(placeOrder(t.db, { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" }, { ...checkoutFields(make.phone(), { walletIqd: 10_000 }), expectedTotalIqd: view.totalIqd }, NOW));
    expect(split.code).toBe("wallet_requires_account");
  });
});
