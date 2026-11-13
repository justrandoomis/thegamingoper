/**
 * Storefront security review (2026-11, owner: security; docs/SECURITY.md "Storefront review 2026-11").
 *
 * Every attack here runs the way a browser's request runs: through the real root middleware (CSRF check, request
 * context, security headers, queued cookies) and the real route modules, against a throw-away local D1 + KV. This file
 * covers the web layer — redirects, sessions, the production switch, cache headers, rate-limit identity, request
 * bodies, the private-file route and the method/CSRF posture of every endpoint. Input validation, IDOR, consent, money
 * and data leaks are in tests/storefront-adversarial-input.test.ts.
 *
 * Rate-limit and brute-force attacks run ONLY here (createTestDb), never against the shared dev server.
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { randomToken, sha256Hex } from "~/lib/ids";
import { action as uploadProofAction, loader as uploadProofLoader } from "~/routes/api/upload-proof";
import { action as uploadTradeInAction, loader as uploadTradeInLoader } from "~/routes/api/upload-tradein";
import { action as apiWishlistAction, loader as apiWishlistLoader } from "~/routes/api/wishlist";
import { action as cartAction } from "~/routes/api/cart";
import { action as eventsAction, loader as eventsLoader } from "~/routes/api/events";
import { loader as filesLoader } from "~/routes/api/files";
import { loader as suggestLoader } from "~/routes/api/search-suggest";
import { loader as healthLoader } from "~/routes/api/health";
import { action as forgotAction, loader as forgotLoader } from "~/routes/storefront/account/forgot";
import { action as loginAction, loader as loginLoader } from "~/routes/storefront/account/login";
import { action as logoutAction, loader as logoutLoader } from "~/routes/storefront/account/logout";
import { action as settingsAction } from "~/routes/storefront/account/settings";
import { action as signupAction, loader as signupLoader } from "~/routes/storefront/account/signup";
import { action as walletProofAction, loader as walletProofLoader } from "~/routes/storefront/account/wallet-proof";
import { action as wishlistPageAction } from "~/routes/storefront/account/wishlist";
import { action as onboardingAction, loader as onboardingLoader } from "~/routes/storefront/home/api.onboarding";
import { action as recentAction } from "~/routes/storefront/home/api.recently-viewed";
import { confirmationPath } from "~/routes/storefront/checkout/checkout.server";
import { MAX_PROOF_BODY_BYTES } from "~/routes/storefront/checkout/proof.server";
import { ADMIN_COOKIE, changeEmployeePassword, getEmployee, signInEmployee } from "~/server/auth/admin.server";
import { changeCustomerPassword, CUSTOMER_COOKIE, getCustomer, revokeAllCustomerSessions, signInCustomer, signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { customerSessions, files, otpCodes } from "~/server/db/schema";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { WISHLIST_CHANGES_PER_IP } from "~/server/services/wishlist.server";
import { applySecurityHeaders } from "~/server/security.server";
import { kvBlobStore, putFile } from "~/server/storage.server";
import { saveTopupProof } from "~/server/services/account/topups.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { lookupGuestOrder } from "~/server/services/orders/manage.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { env } from "./helpers/cloudflare-workers";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const SITE = "http://localhost:5173";
const MINUTE = 60_000;

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t?.dispose();
});

// The production switch is read from `env` on every request; a test that changes it puts it back.
const savedEnv = { APP_ENV: undefined as unknown, STORE_MODE: undefined as unknown };
beforeAll(() => {
  savedEnv.APP_ENV = env.APP_ENV;
  savedEnv.STORE_MODE = env.STORE_MODE;
});
afterEach(() => {
  env.APP_ENV = savedEnv.APP_ENV;
  env.STORE_MODE = savedEnv.STORE_MODE;
});

// ───────────────────────────────────────────────────────────────── harness

let counter = 0;
/** A fresh documentation-range IPv4 address per request, so per-IP limits never leak between tests. */
const freshIp = () => {
  counter++;
  return `198.51.${100 + Math.floor(counter / 250)}.${(counter % 250) + 1}`;
};

/** A request context as the root middleware builds it, for calling services directly. */
function context(options: { cookies?: Record<string, string>; now?: number; ip?: string | null; isDev?: boolean } = {}): { ctx: RequestCtx; setCookies: string[] } {
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `sec-${++counter}`,
    nonce: "test-nonce",
    origin: SITE,
    isHttps: false,
    isDev: options.isDev ?? true,
    now: options.now ?? Date.now(),
    ip: options.ip === undefined ? freshIp() : options.ip,
    country: "IQ",
    userAgent: "Mozilla/5.0 (security review)",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
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
  form?: Record<string, string> | FormData;
  json?: unknown;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  params?: Record<string, string>;
  /** null = no CF-Connecting-IP header (local development) */
  ip?: string | null;
  /** Origin header for non-GET requests; null sends none. Default: the site itself. */
  origin?: string | null;
};
type Hit = { status: number; headers: Headers; location: string | null; body: unknown; setCookies: string[]; error?: unknown };

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
  const method = init.method ?? (init.form || init.json !== undefined || init.body ? "POST" : "GET");
  const headers = new Headers(init.headers);
  const ip = init.ip === undefined ? freshIp() : init.ip;
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (init.cookies) headers.set("Cookie", Object.entries(init.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
  if (method !== "GET" && method !== "HEAD" && init.origin !== null) headers.set("Origin", init.origin ?? SITE);
  let body: BodyInit | null | undefined = init.body;
  if (init.form) body = init.form instanceof FormData ? init.form : new URLSearchParams(init.form);
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(`${SITE}${path}`, { method, headers, body: body ?? null, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
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
    // The middleware itself refused (CSRF, a body that is too large…): a thrown data() or Response.
    const converted = asResponse(thrown);
    return { status: converted.response.status, headers: converted.response.headers, location: converted.response.headers.get("Location"), body: converted.body, setCookies: converted.response.headers.getSetCookie() };
  }
  let parsed: unknown = asResponse(inner).body;
  if (inner instanceof Response && (inner.headers.get("Content-Type") ?? "").includes("json")) parsed = await inner.clone().json();
  return { status: response.status, headers: response.headers, location: response.headers.get("Location"), body: parsed, setCookies: response.headers.getSetCookie(), error: innerError };
}

type Cookie = { name: string; value: string; attributes: Record<string, string | true> };
function parseCookie(serialized: string): Cookie {
  const [pair, ...attributes] = serialized.split(/;\s*/);
  const at = pair.indexOf("=");
  const cookie: Cookie = { name: pair.slice(0, at), value: decodeURIComponent(pair.slice(at + 1)), attributes: {} };
  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    if (eq === -1) cookie.attributes[attribute.toLowerCase()] = true;
    else cookie.attributes[attribute.slice(0, eq).toLowerCase()] = attribute.slice(eq + 1);
  }
  return cookie;
}
/** The cookies a browser keeps after these Set-Cookie headers (later wins, Max-Age=0 deletes). */
function jarAfter(setCookies: string[], base: Record<string, string> = {}): Record<string, string> {
  const jar = { ...base };
  for (const cookie of setCookies.map(parseCookie)) {
    if (cookie.attributes["max-age"] === "0") delete jar[cookie.name];
    else jar[cookie.name] = cookie.value;
  }
  return jar;
}
const clears = (setCookies: string[], name: string) => setCookies.map(parseCookie).some((cookie) => cookie.name === name && cookie.attributes["max-age"] === "0");

/** A customer with a password, signed in: their cookie jar. */
async function customerWithSession(password = `pw-${randomToken(9)}`): Promise<{ id: string; phone: string; password: string; jar: Record<string, string> }> {
  const phone = make.phone();
  const req = context();
  const session = await signUpCustomer(req.ctx, t.db, { phone, password, name: "زبون المراجعة" });
  return { id: session.customer.id, phone, password, jar: jarAfter(req.setCookies) };
}

/** A local path for a Location header: one leading "/", no "//" or "/\" that a browser reads as another host, ASCII only. */
function isLocalLocation(location: string | null): boolean {
  if (location === null) return false;
  if (!/^\/(?![/\\])/.test(location)) return false;
  if (/[^\x21-\x7e]/.test(location)) return false;
  return new URL(location, "https://tamtamgames.example").host === "tamtamgames.example";
}

/** A real 1×1 PNG (the upload pipeline parses it). */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

/** A bank-transfer order for a guest (or a customer), with its confirmation token. */
async function transferOrder(customerId: string | null = null) {
  const product = await make.product({ stock: 5, priceIqd: 120_000 });
  const { cartToken } = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: product.variantId, qty: 1 }, TEST_NOW);
  const view = await getCartView(t.db, { cartToken, customerId, locale: "ar", governorateId: governorateId("baghdad") }, TEST_NOW);
  const phone = make.phone();
  const placed = await placeOrder(
    t.db,
    { cartToken, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "demo" },
    {
      idempotencyKey: randomToken(),
      phone,
      governorateId: governorateId("baghdad"),
      districtId: districtId("baghdad", "karrada"),
      areaText: "الكرادة",
      addressText: "شارع 62، دار 14",
      marketingConsent: false,
      paymentMethod: "bank_transfer",
      expectedTotalIqd: view.totalIqd,
    },
    Date.now(),
  );
  return { ...placed, phone, cartToken };
}

function proofForm(ref: string, token: string | null, file: Blob | string = new File([PNG], "proof.png", { type: "image/png" })): FormData {
  const form = new FormData();
  form.set("ref", ref);
  if (token) form.set("t", token);
  form.set("declaredAmountIqd", "125000");
  form.set("file", file);
  return form;
}

// ───────────────────────────────────────────────────────────────── 1. next= stays on this site

describe("next= after signing in or up never leaves the site", () => {
  // Each value is what a link can put in ?next= (URLSearchParams has already decoded it once).
  const VECTORS = [
    "https://evil.example/",
    "//evil.example/",
    "///evil.example/",
    "/\\evil.example/",
    "\\\\evil.example",
    "/%5Cevil.example",
    "/%2F%2Fevil.example",
    "/%2f/evil.example",
    "javascript:alert(1)",
    " //evil.example",
    "\t//evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/en//evil.example/x",
    "/ckb//evil.example",
    "/en/\\evil.example",
    "/en/..//evil.example",
    "/en/%2F%2Fevil.example",
    "/ckb///evil.example",
    "/　/evil.example",
    "/／／evil.example",
    "/∕∕evil.example",
    "/حسابي/طلباتي",
    "/account?x=" + "a".repeat(600),
  ];

  test("the sign-in page sends a signed-in visitor only to a path on this site", async () => {
    const person = await customerWithSession();
    for (const next of VECTORS) {
      const answer = await hit(`/account/login?next=${encodeURIComponent(next)}`, loginLoader as Handler, { cookies: person.jar });
      expect(answer.status, next).toBe(302);
      expect(isLocalLocation(answer.location), `${JSON.stringify(next)} → ${answer.location}`).toBe(true);
    }
  });

  test("the sign-up page does the same for a signed-in visitor", async () => {
    const person = await customerWithSession();
    for (const next of VECTORS) {
      const answer = await hit(`/account/signup?next=${encodeURIComponent(next)}`, signupLoader as Handler, { cookies: person.jar });
      expect(isLocalLocation(answer.location), `${JSON.stringify(next)} → ${answer.location}`).toBe(true);
    }
  });

  test("the sign-in form's next (as the page renders it) and the action's redirect stay local", async () => {
    const person = await customerWithSession();
    for (const next of ["/en//evil.example/x", "/ckb//evil.example", "//evil.example"]) {
      const page = await hit(`/account/login?next=${encodeURIComponent(next)}`, loginLoader as Handler);
      const rendered = (page.body as { next: string }).next;
      expect(isLocalLocation(rendered), `rendered ${rendered}`).toBe(true);
      const answer = await hit("/account/login", loginAction as Handler, { form: { phone: person.phone, password: person.password, next } });
      expect(answer.status).toBe(302);
      expect(isLocalLocation(answer.location), `${next} → ${answer.location}`).toBe(true);
    }
  });

  test("the sign-up action's redirect stays local", async () => {
    for (const next of ["/en//evil.example/x", "/ckb/..//evil.example", "https://evil.example"]) {
      const answer = await hit("/account/signup", signupAction as Handler, { form: { phone: make.phone(), password: `pw-${randomToken(9)}`, next } });
      expect(answer.status).toBe(302);
      expect(isLocalLocation(answer.location), `${next} → ${answer.location}`).toBe(true);
    }
  });

  test("a good next keeps its page and query, in the visitor's language", async () => {
    const person = await customerWithSession();
    const plain = await hit(`/en/account/login?next=${encodeURIComponent("/checkout?step=payment")}`, loginLoader as Handler, { cookies: person.jar });
    expect(plain.location).toBe("/en/checkout?step=payment");
    const prefixed = await hit(`/account/login?next=${encodeURIComponent("/en/account/orders")}`, loginLoader as Handler, { cookies: person.jar });
    expect(prefixed.location).toBe("/account/orders");
    const arabic = await hit(`/account/login?next=${encodeURIComponent("/c/ألعاب")}`, loginLoader as Handler, { cookies: person.jar });
    expect(arabic.location).toBe(`/c/${encodeURIComponent("ألعاب")}`);
  });

  test("sign-out takes no destination at all, and GET signs nobody out", async () => {
    const person = await customerWithSession();
    const get = await hit("/account/logout?next=https://evil.example", logoutLoader as Handler, { cookies: person.jar });
    expect(get.location).toBe("/account");
    expect(await getCustomer(context({ cookies: person.jar }).ctx, t.db)).not.toBeNull();
    const post = await hit("/account/logout?next=//evil.example", logoutAction as Handler, { method: "POST", cookies: person.jar });
    expect(post.location).toBe("/account/login?signedout=1");
  });
});

// ───────────────────────────────────────────────────────────────── 2. sessions: fixation and rotation

describe("sessions — fixation at sign-in and sign-up, rotation and a request in flight", () => {
  test("a session cookie planted before sign-in or sign-up is never the one that comes out (and a live planted one is ended)", async () => {
    const attacker = await customerWithSession();
    const victim = await customerWithSession();
    const planted = attacker.jar[CUSTOMER_COOKIE];
    const signIn = await hit("/account/login", loginAction as Handler, { form: { phone: victim.phone, password: victim.password }, cookies: { [CUSTOMER_COOKIE]: planted } });
    const issued = jarAfter(signIn.setCookies)[CUSTOMER_COOKIE];
    expect(issued).toBeTruthy();
    expect(issued).not.toBe(planted);
    expect((await getCustomer(context({ cookies: { [CUSTOMER_COOKIE]: issued } }).ctx, t.db))?.customer.id).toBe(victim.id);
    // The planted session (the attacker's) is over: nobody shares a session with the victim.
    expect(await getCustomer(context({ cookies: { [CUSTOMER_COOKIE]: planted } }).ctx, t.db)).toBeNull();

    // A made-up token is simply replaced.
    const invented = randomToken();
    const signUp = await hit("/account/signup", signupAction as Handler, { form: { phone: make.phone(), password: `pw-${randomToken(9)}` }, cookies: { [CUSTOMER_COOKIE]: invented } });
    const fresh = jarAfter(signUp.setCookies)[CUSTOMER_COOKIE];
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(invented);
    expect(await t.db.select().from(customerSessions).where(eq(customerSessions.idHash, await sha256Hex(invented))).get()).toBeUndefined();
  });

  test("the session cookie: HttpOnly, SameSite=Lax, Path=/, Secure on HTTPS", async () => {
    const answer = await hit("/account/signup", signupAction as Handler, { form: { phone: make.phone(), password: `pw-${randomToken(9)}` } });
    const cookie = answer.setCookies.map(parseCookie).find((c) => c.name === CUSTOMER_COOKIE)!;
    expect(cookie.attributes).toMatchObject({ httponly: true, samesite: "Lax", path: "/" });
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a password change: the old cookie and every copy are dead, other devices are signed out, this device continues", async () => {
    const person = await customerWithSession();
    const laptopReq = context();
    await signInCustomer(laptopReq.ctx, t.db, { phone: person.phone, password: person.password });
    const laptop = jarAfter(laptopReq.setCookies);
    const answer = await hit("/account/settings", settingsAction as Handler, { form: { intent: "password", currentPassword: person.password, newPassword: `new-pw-${randomToken(9)}` }, cookies: person.jar });
    expect(answer.body).toMatchObject({ ok: true, intent: "password" });
    const rotated = jarAfter(answer.setCookies, person.jar);
    expect(rotated[CUSTOMER_COOKIE]).not.toBe(person.jar[CUSTOMER_COOKIE]);
    expect(await getCustomer(context({ cookies: person.jar }).ctx, t.db)).toBeNull();
    expect(await getCustomer(context({ cookies: laptop }).ctx, t.db)).toBeNull();
    expect((await getCustomer(context({ cookies: rotated }).ctx, t.db))?.customer.id).toBe(person.id);
  });

  test("a request sent with the old cookie just before the change, answered just after it, does not sign this device out", async () => {
    const person = await customerWithSession();
    const changedAt = Date.now();
    const change = context({ cookies: person.jar, now: changedAt });
    await changeCustomerPassword(change.ctx, t.db, { currentPassword: person.password, newPassword: `new-pw-${randomToken(9)}` });
    const browser = jarAfter(change.setCookies, person.jar);
    expect(browser[CUSTOMER_COOKIE]).not.toBe(person.jar[CUSTOMER_COOKIE]);

    // The request in flight carries the old cookie and reaches the server after the change committed.
    const inFlight = context({ cookies: person.jar, now: changedAt + 2_000 });
    expect(await getCustomer(inFlight.ctx, t.db)).toBeNull();
    expect(clears(inFlight.setCookies, CUSTOMER_COOKIE), "the late answer must not delete the new cookie").toBe(false);
    // So the browser, which applies the answers in the order they arrive, is still signed in.
    const afterBoth = jarAfter(inFlight.setCookies, browser);
    expect((await getCustomer(context({ cookies: afterBoth, now: changedAt + 3_000 }).ctx, t.db))?.customer.id).toBe(person.id);

    // Later, a dead cookie is cleared as before; an unknown or expired one at once.
    const later = context({ cookies: person.jar, now: changedAt + 10 * MINUTE });
    expect(await getCustomer(later.ctx, t.db)).toBeNull();
    expect(clears(later.setCookies, CUSTOMER_COOKIE)).toBe(true);
    const unknown = context({ cookies: { [CUSTOMER_COOKIE]: randomToken() } });
    expect(await getCustomer(unknown.ctx, t.db)).toBeNull();
    expect(clears(unknown.setCookies, CUSTOMER_COOKIE)).toBe(true);
  });

  test("signing out everywhere: the other devices are refused at once (their cookies are cleared on a later request)", async () => {
    const person = await customerWithSession();
    const phoneReq = context();
    await signInCustomer(phoneReq.ctx, t.db, { phone: person.phone, password: person.password });
    const phoneJar = jarAfter(phoneReq.setCookies);
    const now = Date.now();
    expect(await revokeAllCustomerSessions(t.db, person.id, now)).toBe(2);
    const soon = context({ cookies: phoneJar, now: now + 1_000 });
    expect(await getCustomer(soon.ctx, t.db)).toBeNull();
    const later = context({ cookies: phoneJar, now: now + 10 * MINUTE });
    expect(await getCustomer(later.ctx, t.db)).toBeNull();
    expect(clears(later.setCookies, CUSTOMER_COOKIE)).toBe(true);
  });

  test("staff: a request with the old admin cookie answered after a password change does not clear the new one", async () => {
    const password = `staff-pw-${randomToken(9)}`;
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next("sec-staff")}@security.test`;
    await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    const signIn = context({ ip: freshIp() });
    const result = await signInEmployee(signIn.ctx, t.db, { email, password });
    expect(result.status).toBe("signed_in");
    const before = jarAfter(signIn.setCookies);
    const changedAt = Date.now();
    const change = context({ cookies: before, now: changedAt });
    await changeEmployeePassword(change.ctx, t.db, { currentPassword: password, newPassword: `staff-new-${randomToken(9)}`, confirmPassword: undefined });
    const browser = jarAfter(change.setCookies, before);
    expect(browser[ADMIN_COOKIE]).not.toBe(before[ADMIN_COOKIE]);
    const inFlight = context({ cookies: before, now: changedAt + 2_000 });
    expect(await getEmployee(inFlight.ctx, t.db)).toBeNull();
    expect(clears(inFlight.setCookies, ADMIN_COOKIE)).toBe(false);
    expect(await getEmployee(context({ cookies: jarAfter(inFlight.setCookies, browser), now: changedAt + 3_000 }).ctx, t.db)).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── 3. the production switch

describe("production never hands out a one-time code (APP_ENV / isDev)", () => {
  // Anything but an explicit "development" must behave like production: a deploy that forgot the variable, a staging
  // environment (wrangler does not inherit top-level vars into named environments) or a typo.
  const PRODUCTION_LIKE = ["production", undefined, "", "staging", "prod", "Production", " development"];

  test.each(PRODUCTION_LIKE)("APP_ENV=%j: password reset and phone confirmation say codes are unavailable; nothing is created", async (value) => {
    env.APP_ENV = value;
    const page = await hit("/account/forgot", forgotLoader as Handler);
    expect(page.body).toMatchObject({ delivery: "unavailable" });

    const victim = await customerWithSession();
    const asked = await hit("/account/forgot", forgotAction as Handler, { form: { phone: victim.phone } });
    expect(asked.status).toBe(503);
    expect(asked.body).toMatchObject({ ok: false, code: "otp_unavailable" });
    expect(JSON.stringify(asked.body)).not.toMatch(/devCode"\s*:\s*"\d/);
    expect(await t.db.select().from(otpCodes).where(eq(otpCodes.phoneE164, victim.phone))).toEqual([]);

    const reset = await hit("/account/forgot", forgotAction as Handler, { form: { intent: "reset", phone: victim.phone, code: "123456", password: "a-new-password-1" } });
    expect(reset.status).toBe(503);

    const confirm = await hit("/account/settings", settingsAction as Handler, { form: { intent: "phoneRequest" }, cookies: victim.jar });
    expect(confirm.body).toMatchObject({ ok: false, code: "otp_unavailable" });
    expect(JSON.stringify(confirm.body)).not.toMatch(/devCode"\s*:\s*"\d/);
  });

  test.each(PRODUCTION_LIKE)("APP_ENV=%j: HTML gets the Content-Security-Policy", async (value) => {
    env.APP_ENV = value;
    const page = await hit("/", (() => new Response("<!doctype html><title>x</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } })) as Handler);
    expect(page.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-/);
  });

  test("only APP_ENV=development shows the labelled development code (the switch the local dev server uses)", async () => {
    env.APP_ENV = "development";
    const victim = await customerWithSession();
    const asked = await hit("/account/forgot", forgotAction as Handler, { form: { phone: victim.phone } });
    expect(asked.body).toMatchObject({ ok: true, step: "code", devCode: expect.stringMatching(/^\d{6}$/) });
  });
});

// ───────────────────────────────────────────────────────────────── 4. cache headers

describe("cache headers — personal pages and page data are never stored for someone else", () => {
  const html = () => new Response("<!doctype html><title>x</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const pageData = () => new Response("[]", { headers: { "Content-Type": "text/x-script" } });
  const page = (make: () => Response, headers: Record<string, string> = {}) =>
    (() => {
      const response = make();
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
    }) as Handler;

  test("a public page's data request (.data) carries a private policy like its HTML — never a cacheable default", async () => {
    for (const path of ["/p/ps5-slim.data", "/.data", "/en/c/games.data", "/_.data", "/en/_.data", "/used.data"]) {
      const answer = await hit(path, page(pageData));
      expect(answer.headers.get("Cache-Control"), path).toMatch(/^private, (no-cache|no-store)$/);
    }
    const document = await hit("/p/ps5-slim", page(html));
    expect(document.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  test("everything rendered for a signed-in customer (their name rides in the shell data) is no-store", async () => {
    const person = await customerWithSession();
    for (const path of ["/", "/.data", "/p/ps5-slim", "/p/ps5-slim.data", "/support/assistant", "/en/support/assistant.data"]) {
      const answer = await hit(path, page(path.endsWith(".data") ? pageData : html), { cookies: person.jar });
      expect(answer.headers.get("Cache-Control"), path).toBe("private, no-store");
    }
  });

  test("the trade-in tracking page (name, phone, offer) is a private page: no-store and noindex, its data too", async () => {
    env.STORE_MODE = "live";
    for (const path of ["/trade-in/TI-7K4M2Q9X", "/en/trade-in/TI-7K4M2Q9X", "/trade-in/TI-7K4M2Q9X.data", "/ckb/trade-in/TI-7K4M2Q9X.data"]) {
      const answer = await hit(path, page(path.endsWith(".data") ? pageData : html));
      expect(answer.headers.get("Cache-Control"), path).toBe("no-store");
      expect(answer.headers.get("X-Robots-Tag"), path).toBe("noindex, nofollow");
    }
    // The wizard's first step is a public page (no noindex forced), still never shared-cached.
    const wizard = await hit("/trade-in", page(html));
    expect(wizard.headers.get("X-Robots-Tag")).toBeNull();
    expect(wizard.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  test("account, checkout, cart, order and tracking pages and their data stay no-store (as before)", async () => {
    for (const path of ["/account", "/account.data", "/en/account/orders/_.data", "/checkout", "/cart.data", "/order/TT-7K4M2Q9X", "/order/TT-7K4M2Q9X.data", "/track"]) {
      const answer = await hit(path, page(path.includes(".data") ? pageData : html, { "Cache-Control": "public, max-age=600" }));
      expect(answer.headers.get("Cache-Control"), path).toBe("no-store");
    }
  });

  test("a page that asks for no Referer (a link token in its URL) keeps that policy", async () => {
    const answer = await hit("/support/repair/status?ref=RP-7K4M2Q9X&t=x", page(html, { "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store" }));
    expect(answer.headers.get("Referrer-Policy")).toBe("no-referrer");
    const plain = await hit("/", page(html));
    expect(plain.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  test("API answers: personal ones no-store, the suggestion list public for a minute and never with a cookie", async () => {
    const suggest = await hit("/api/search/suggest?q=ps", suggestLoader as Handler, { cookies: { tt_sid: randomToken() } });
    expect(suggest.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(suggest.setCookies).toEqual([]);
    expect(suggest.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    for (const [path, handler] of [
      ["/api/wishlist", apiWishlistLoader],
      ["/api/upload/tradein", uploadTradeInLoader],
      ["/api/files/fil_00000000000000000000000000", filesLoader],
      ["/api/health", healthLoader],
    ] as const) {
      const answer = await hit(path, handler as Handler, { params: { fileId: "fil_00000000000000000000000000" } });
      expect(answer.headers.get("Cache-Control"), path).toBe("no-store");
    }
  });

  test("applySecurityHeaders is the one place: the base headers on every response", () => {
    const response = new Response("x", { headers: { "Content-Type": "text/plain" } });
    applySecurityHeaders(response, context().ctx, new URL(`${SITE}/media/pub_x.webp`));
    expect(Object.fromEntries([...response.headers].filter(([name]) => name !== "content-type"))).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
  });
});

// ───────────────────────────────────────────────────────────────── 5. who counts as one caller

describe("per-IP limits — one IPv6 subscriber is one caller", () => {
  test("addresses of one /64 share one key; other /64s and IPv4 addresses do not; IPv4-mapped IPv6 is its IPv4", async () => {
    const key = (ip: string) => limitKey("order_lookup", "ip", ip);
    expect(await key("2001:db8:1:2::1")).toBe(await key("2001:db8:1:2:ffff:abcd:1234:9"));
    expect(await key("2001:db8:1:2::1")).toBe(await key("2001:0DB8:0001:0002:0000:0000:0000:0001"));
    expect(await key("2001:db8:1:2::1")).not.toBe(await key("2001:db8:1:3::1"));
    expect(await key("::ffff:203.0.113.9")).toBe(await key("203.0.113.9"));
    expect(await key("203.0.113.9")).not.toBe(await key("203.0.113.10"));
    // Other kinds of identifiers are untouched.
    expect(await limitKey("signin", "phone", "+9647701234567")).not.toBe(await limitKey("signin", "phone", "+9647701234568"));
  });

  test("guest order lookups: rotating the interface id inside one /64 does not buy more guesses", async () => {
    const order = await transferOrder();
    for (let i = 0; i < RATE_LIMITS.orderLookup.limit; i++) {
      expect(await lookupGuestOrder(t.db, { ref: order.ref, phone: make.phone() }, { ip: `2001:db8:77:1::${(i + 1).toString(16)}` }, Date.now())).toBeNull();
    }
    await expect(lookupGuestOrder(t.db, { ref: `TT-${randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, "A")}`, phone: order.phone }, { ip: "2001:db8:77:1:dead:beef:0:1" }, Date.now())).rejects.toMatchObject({ code: "rate_limited" });
  });
});

// ───────────────────────────────────────────────────────────────── 6. request bodies

/** A multipart body that never ends on its own: the parts arrive as the server pulls; `pulled()` says how much it read. */
function endlessUpload(totalBytes: number) {
  const boundary = "----tamtamboundary";
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="ref"\r\n\r\nTT-7K4M2Q9X\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const chunk = new Uint8Array(256 * 1024).fill(0x41);
  let sent = 0;
  let headSent = false;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headSent) {
        headSent = true;
        sent += head.length;
        controller.enqueue(head);
        return;
      }
      if (sent < totalBytes) {
        sent += chunk.length;
        controller.enqueue(chunk);
        return;
      }
      if (!done) {
        done = true;
        controller.enqueue(tail);
        controller.close();
      }
    },
  });
  return { stream, boundary, pulled: () => sent };
}

describe("request bodies — limits hold before a body is read, with or without Content-Length", () => {
  test("a declared body above the endpoint's limit is refused by the middleware before anything runs", async () => {
    let ran = false;
    const probe = (() => {
      ran = true;
      return new Response(null);
    }) as Handler;
    const huge = String(64 * 1024 * 1024);
    for (const path of ["/account/login", "/api/wishlist", "/checkout", "/en/track.data"]) {
      const answer = await hit(path, probe, { method: "POST", body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(2 * 1024 * 1024) } });
      expect(answer.status, path).toBe(413);
    }
    for (const path of ["/api/upload/proof", "/api/upload/tradein", "/account/wallet/proof", "/support/repair"]) {
      const answer = await hit(path, probe, { method: "POST", body: "x=1", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": huge } });
      expect(answer.status, path).toBe(413);
    }
    expect(ran).toBe(false);
    // An ordinary form passes.
    const small = await hit("/account/login", probe, { method: "POST", form: { phone: "x" } });
    expect(small.status).toBe(200);
    expect(ran).toBe(true);
  });

  test.each([
    ["/api/upload/proof", uploadProofAction],
    ["/api/upload/tradein", uploadTradeInAction],
    ["/account/wallet/proof", walletProofAction],
  ] as const)("%s: a chunked upload without Content-Length is cut off at the limit, not read to the end", async (path, action) => {
    const person = await customerWithSession();
    const upload = endlessUpload(48 * 1024 * 1024);
    const answer = await hit(path, action as Handler, { method: "POST", body: upload.stream, headers: { "Content-Type": `multipart/form-data; boundary=${upload.boundary}` }, cookies: person.jar });
    expect(answer.status).toBe(413);
    expect((answer.body as { code?: string }).code).toBe("upload_too_large");
    expect(upload.pulled(), "bytes read before refusing").toBeLessThanOrEqual(MAX_PROOF_BODY_BYTES + 512 * 1024);
  });
});

describe("error answers — a malformed body is a 400 with a code, never an unexpected error", () => {
  test.each([
    ["/api/upload/proof", uploadProofAction],
    ["/api/upload/tradein", uploadTradeInAction],
    ["/account/wallet/proof", walletProofAction],
  ] as const)("%s: garbage multipart", async (path, action) => {
    const person = await customerWithSession();
    const answer = await hit(path, action as Handler, { method: "POST", body: "--x\r\nnot a part at all", headers: { "Content-Type": "multipart/form-data; boundary=zzz" }, cookies: person.jar });
    expect(answer.error, String(answer.error)).toBeUndefined();
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body)).not.toMatch(/stack|TypeError|at \w+ \(|D1_|SQLITE/i);
  });

  test("support forms: garbage multipart and a body past three photos answer with a code", async () => {
    const { action: repairAction } = await import("~/routes/storefront/support/repair");
    const garbage = await hit("/support/repair", repairAction as Handler, { method: "POST", body: "--x\r\nnope", headers: { "Content-Type": "multipart/form-data; boundary=zzz" } });
    expect(garbage.error).toBeUndefined();
    expect(garbage.status).toBe(400);
    const upload = endlessUpload(40 * 1024 * 1024);
    const big = await hit("/support/repair", repairAction as Handler, { method: "POST", body: upload.stream, headers: { "Content-Type": `multipart/form-data; boundary=${upload.boundary}` } });
    expect(big.status).toBe(413);
    expect(upload.pulled()).toBeLessThanOrEqual(3 * 8 * 1024 * 1024 + 512 * 1024);
  });
});

// ───────────────────────────────────────────────────────────────── 7. favourites page

describe("favourites — the page's form counts like the API", () => {
  test("POST /wishlist is limited per IP (shared with /api/wishlist): a script cannot fill the table", async () => {
    const product = await make.product({ stock: 1 });
    const ip = freshIp();
    let last: Hit | null = null;
    // Windows are aligned to the clock: a run that crosses a minute boundary splits its count over two windows, so
    // allow twice the limit plus one (the loop still stops at the first 429, normally the 61st request).
    const { limit } = WISHLIST_CHANGES_PER_IP;
    for (let i = 0; i < 2 * limit + 1; i++) {
      last = await hit("/wishlist", wishlistPageAction as Handler, { form: { intent: "add", productId: product.productId }, ip });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toMatch(/^\d+$/);
    const api = await hit("/api/wishlist", apiWishlistAction as Handler, { form: { intent: "add", productId: product.productId }, ip });
    expect(api.status).toBe(429);
  });
});

// ───────────────────────────────────────────────────────────────── 8. the private-file route

describe("GET /api/files/:fileId — a shopper's own proof only", () => {
  test("the order's token or its signed-in owner; anyone else, any trick, the same 404", async () => {
    const owner = await customerWithSession();
    const order = await transferOrder(owner.id);
    const sent = await hit("/api/upload/proof", uploadProofAction as Handler, { form: proofForm(order.ref, null), cookies: owner.jar });
    expect(sent.status).toBe(200);
    const previewUrl = (sent.body as { previewUrl: string }).previewUrl;
    const fileId = decodeURIComponent(previewUrl.split("/").pop()!.split("?")[0]);

    const ok = await hit(`/api/files/${fileId}`, filesLoader as Handler, { params: { fileId }, cookies: owner.jar });
    expect(ok.status).toBe(200);
    expect(Object.fromEntries(["cache-control", "cross-origin-resource-policy", "x-content-type-options", "content-type", "content-disposition"].map((name) => [name, ok.headers.get(name)]))).toEqual({
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-type": "image/png",
      "content-disposition": "inline",
    });
    expect(ok.headers.get("Content-Security-Policy")).toContain("sandbox");
    const byToken = await hit(`/api/files/${fileId}?t=${order.accessToken}`, filesLoader as Handler, { params: { fileId } });
    expect(byToken.status).toBe(200);

    const stranger = await customerWithSession();
    const signedOut = { ...owner.jar };
    await revokeAllCustomerSessions(t.db, owner.id, Date.now() - 10 * MINUTE);
    const otherOrder = await transferOrder();
    const attempts: [string, HitInit][] = [
      ["guest, no token", {}],
      ["another customer", { cookies: stranger.jar }],
      ["revoked session", { cookies: signedOut }],
      ["wrong token", { headers: {} }],
      ["another order's token", {}],
      ["token with the right shape, wrong value", {}],
    ];
    // the right shape, a wrong value: the real token with its last two characters changed, whatever they are
    const nearToken = `${order.accessToken.slice(0, -2)}${order.accessToken.endsWith("AA") ? "BB" : "AA"}`;
    expect(nearToken).not.toBe(order.accessToken);
    const queries = ["", "", "", `?t=${randomToken()}`, `?t=${otherOrder.accessToken}`, `?t=${nearToken}`];
    for (const [index, [label, init]] of attempts.entries()) {
      const answer = await hit(`/api/files/${fileId}${queries[index]}`, filesLoader as Handler, { ...init, params: { fileId } });
      expect(answer.status, label).toBe(404);
      expect(answer.body, label).toEqual({ ok: false, code: "not_found" });
      expect(answer.headers.get("Cache-Control"), label).toBe("no-store");
    }
  });

  test("other kinds of private files, public files and path tricks are 404 — never served here", async () => {
    const owner = await customerWithSession();
    const store = kvBlobStore(t.kv);
    const topup = await saveTopupProof(t.db, store, { kind: "customer", id: owner.id }, new File([PNG], "t.png", { type: "image/png" }), Date.now());
    const tradeIn = await putFile(t.db, store, { bytes: PNG, mime: "image/png", visibility: "private", kind: "trade_in_photo", ownerType: "trade_in_draft", ownerId: "x", now: Date.now() });
    const repair = await putFile(t.db, store, { bytes: PNG, mime: "image/png", visibility: "private", kind: "repair_photo", ownerType: "repair_ticket", ownerId: "x", createdBy: { kind: "customer", id: owner.id }, now: Date.now() });
    const publicFile = await putFile(t.db, store, { bytes: PNG, mime: "image/png", visibility: "public", kind: "product_image", now: Date.now() });

    // The top-up proof is its uploader's (that is the route's second rule) — and nobody else's.
    expect((await hit(`/api/files/${topup.fileId}`, filesLoader as Handler, { params: { fileId: topup.fileId }, cookies: owner.jar })).status).toBe(200);
    const stranger = await customerWithSession();
    expect((await hit(`/api/files/${topup.fileId}`, filesLoader as Handler, { params: { fileId: topup.fileId }, cookies: stranger.jar })).status).toBe(404);

    for (const fileId of [tradeIn.id, repair.id, publicFile.id, publicFile.storageKey, "../../etc/passwd", "fil_x/../../x", `${topup.fileId}%00`, `${topup.fileId} `, "", "%2e%2e%2f", "prv_" + "A".repeat(24) + ".png"]) {
      const answer = await hit(`/api/files/${encodeURIComponent(fileId)}`, filesLoader as Handler, { params: { fileId }, cookies: owner.jar });
      expect(answer.status, fileId).toBe(404);
    }
  });

  test("the files route answers GET only", async () => {
    const files = await import("~/routes/api/files");
    expect("action" in files).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── 9. methods and CSRF

describe("method and CSRF posture of the storefront's endpoints", () => {
  const WRITES: [string, Handler, Record<string, string>][] = [
    ["/api/cart", cartAction as Handler, { intent: "coupon", code: "" }],
    ["/api/wishlist", apiWishlistAction as Handler, { intent: "toggle", productId: "prd_x" }],
    ["/api/events", eventsAction as Handler, { kind: "view", productId: "prd_x" }],
    ["/api/onboarding", onboardingAction as Handler, { consent: "1" }],
    ["/api/recently-viewed", recentAction as Handler, { productId: "prd_x" }],
    ["/api/upload/proof", uploadProofAction as Handler, { ref: "TT-7K4M2Q9X" }],
    ["/api/upload/tradein", uploadTradeInAction as Handler, { intent: "remove", fileId: "fil_x" }],
    ["/account/wallet/proof", walletProofAction as Handler, {}],
    ["/account/login", loginAction as Handler, { phone: "07701234567", password: "x" }],
    ["/account/signup", signupAction as Handler, { phone: "07701234567", password: "x" }],
    ["/account/logout", logoutAction as Handler, {}],
    ["/account/forgot", forgotAction as Handler, { phone: "07701234567" }],
    ["/wishlist", wishlistPageAction as Handler, { intent: "add", productId: "prd_x" }],
  ];

  test("cross-site writes are refused before the action runs: another origin, null, a sibling site, no header at all", async () => {
    for (const [path, , form] of WRITES) {
      for (const variant of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "http://localhost:5174" }, { origin: "https://localhost:5173" }, { origin: null, headers: { "Sec-Fetch-Site": "same-site" } }, { origin: null, headers: { "Sec-Fetch-Site": "cross-site" } }, { origin: null }]) {
        let ran = false;
        const answer = await hit(path, (() => {
          ran = true;
          return new Response(null);
        }) as Handler, { method: "POST", form, ...variant });
        expect(answer.status, `${path} ${JSON.stringify(variant)}`).toBe(403);
        expect(answer.body).toEqual({ error: "cross_site_request_blocked" });
        expect(ran).toBe(false);
      }
      // PUT, PATCH and DELETE are writes too.
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const answer = await hit(path, (() => new Response(null)) as Handler, { method, body: "x", origin: "https://evil.example" });
        expect(answer.status, `${method} ${path}`).toBe(403);
      }
    }
  });

  test("resource routes that only write answer 405 to GET, and do nothing", async () => {
    for (const [path, loader] of [
      ["/api/upload/proof", uploadProofLoader],
      ["/api/events", eventsLoader],
      ["/api/onboarding", onboardingLoader],
    ] as const) {
      const answer = await hit(path, loader as Handler);
      expect(answer.status, path).toBe(405);
      expect(answer.headers.get("Allow"), path).toMatch(/POST/);
    }
    const walletGet = await hit("/account/wallet/proof", walletProofLoader as Handler);
    expect(walletGet.status).toBe(404);
  });

  test("a write with another method than POST is refused by the endpoint (405), even same-site", async () => {
    for (const [path, action] of WRITES.slice(0, 8)) {
      const answer = await hit(path, action, { method: "PUT", body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      expect([405], `${path}`).toContain(answer.status);
    }
  });

  test("a confirmation link's token never travels in a Referer to another site, and error answers carry no detail", async () => {
    expect(confirmationPath("TT-7K4M2Q9X", "tok")).toBe("/order/TT-7K4M2Q9X?t=tok");
    const bad = await hit("/api/upload/proof", uploadProofAction as Handler, { form: proofForm("TT-NOPE1234", randomToken()) });
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual({ ok: false, code: "not_found" });
    expect(bad.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});

// Files left by the tests above are private rows; make sure none of them became public along the way.
afterAll(async () => {
  if (!t) return;
  const leaked = await t.db.select({ id: files.id }).from(files).where(and(eq(files.kind, "payment_proof"), eq(files.visibility, "public")));
  expect(leaked).toEqual([]);
});
