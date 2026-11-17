/**
 * Campaign attribution (admin 16.04; polish round 2026-11-13, owner: platform): app/server/attribution.server.ts, its
 * hook in the root middleware (context.server.ts), placeOrder's write of orders.attribution / orders.utm_link_id and
 * the link's click (links.server recordLinkClick).
 *
 *   · landing → order: a shopper opens a store page through a campaign link and starts the cart there; the order
 *     placed from that cart carries the campaign and the link, and module 16's report counts it
 *   · the link's click: a person's browser opening a page — not a bot or a link preview, not a prefetch, not React
 *     Router's data requests, not a redirect or an error page, not /admin — within a per-address limit
 *   · no cookie, nothing on the device: the campaign is kept on the server with the cart (KV), the newest wins
 *   · junk parameters are dropped, never repaired; junk alone is no campaign; a junk or unreadable source never
 *     refuses or breaks an order
 *   · no attribution when none
 *
 * Runs against a real local D1 and KV (tests/helpers/db.ts) behind the real root middleware.
 */
import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { randomToken } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import {
  ATTRIBUTION_CART_COOKIE,
  CLICK_LIMIT,
  KEEP_LIMIT,
  KEEP_STORE_LIMIT,
  campaignFromParams,
  campaignValue,
  campaignVisit,
  cartAttribution,
  cleanCampaign,
  isBrowserOpen,
  linkCode,
  orderSource,
} from "~/server/attribution.server";
import { getCtx, requestContextMiddleware, serializeCookie, type RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db/drizzle.server";
import { orders, utmLinks } from "~/server/db/schema";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { saveCampaign } from "~/server/services/admin/marketing/campaigns.server";
import { attributedByCampaign, createLink } from "~/server/services/admin/marketing/links.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { placeOrder, type CheckoutInput, type CheckoutWho } from "~/server/services/orders/place.server";
import { CART_COOKIE } from "~/server/shell.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

/** What the root middleware handed to the Worker's waitUntil (the recording runs after the response). */
const waited = vi.hoisted(() => ({ promises: [] as Promise<unknown>[] }));
vi.mock("cloudflare:workers", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, waitUntil: (promise: Promise<unknown>) => void waited.promises.push(promise) };
});

const NOW = TEST_NOW;
const DAY = 86_400_000;
const SITE = "http://localhost:5173";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const BAGHDAD = governorateId("baghdad");

let t: TestDb;
let make: Fixtures;
beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

const staff: EmployeeActor = { kind: "employee", id: "emp_attr_owner", permissions: new Set(["*"]), label: "owner" };
let keyCount = 0;
const key = (label: string) => `attr-${label}-${++keyCount}-${randomToken(6)}`.replace(/[^A-Za-z0-9_-]/g, "x");
let ipCount = 0;
const nextIp = () => `203.0.113.${(++ipCount % 250) + 1}`;

/** A link to `targetPath`, optionally of a tracked campaign; its code and id. */
async function link(targetPath: string, options: { campaignId?: string; source?: string; medium?: string } = {}) {
  const made = await createLink(t.db, staff, { targetPath, source: options.source ?? "instagram", medium: options.medium ?? "social", campaignId: options.campaignId ?? "", idempotencyKey: key("link") }, NOW, SITE);
  return { code: made.code, linkId: made.linkId };
}
const clicksOf = async (linkId: string) => (await t.db.select({ clicks: utmLinks.clicks }).from(utmLinks).where(eq(utmLinks.id, linkId)).get())?.clicks;

type Visit = { method?: string; headers?: Record<string, string>; cookies?: Record<string, string>; status?: number; ip?: string; handler?: (ctx: RequestCtx) => Promise<void> };

/** One request through the real root middleware (a page answering `status`), then whatever it left for after the response. */
async function visit(path: string, init: Visit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { "User-Agent": BROWSER, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "CF-Connecting-IP": init.ip ?? nextIp(), ...init.headers };
  // "" = the browser does not send that header at all
  for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
  if (init.cookies) headers.Cookie = Object.entries(init.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
  if (method !== "GET" && method !== "HEAD") headers.Origin = SITE;
  const request = new Request(`${SITE}${path}`, { method, headers });
  const context = new RouterContextProvider();
  waited.promises.length = 0;
  const response = (await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} } as never, async () => {
    if (init.handler) await init.handler(getCtx(context));
    return new Response(method === "HEAD" ? null : "page", { status: init.status ?? 200 });
  })) as Response;
  await Promise.all(waited.promises);
  return response;
}

/** "Add to cart" from a page (React Router posts it as a fetch with the page as Referer): starts the cart, sets its cookie. */
async function addFrom(referer: string, variantId: string, cartToken: string | null = null): Promise<{ token: string; response: Response }> {
  let token = cartToken;
  const response = await visit("/api/cart", {
    method: "POST",
    headers: { Referer: referer, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors" },
    cookies: cartToken ? { [CART_COOKIE]: cartToken } : undefined,
    handler: async (ctx) => {
      const added = await addToCart(t.db, { cartToken, customerId: null, locale: "ar" }, { variantId, qty: 1 }, NOW);
      if (added.cartToken && added.cartToken !== cartToken) {
        token = added.cartToken;
        ctx.setCookie(serializeCookie(ctx, CART_COOKIE, added.cartToken, { maxAge: 60 * 86_400, httpOnly: true, sameSite: "Lax" }));
      }
    },
  });
  return { token: token as string, response };
}

async function checkoutInput(cartToken: string): Promise<CheckoutInput> {
  const view = await getCartView(t.db, { cartToken, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW);
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
  };
}
const who = (cartToken: string, attribution?: unknown): CheckoutWho => ({ cartToken, customer: null, locale: "ar", ip: null, storeMode: "live", ...(attribution === undefined ? {} : { attribution }) });
const orderOf = (orderId: string) => t.db.select({ attribution: orders.attribution, utmLinkId: orders.utmLinkId }).from(orders).where(eq(orders.id, orderId)).get();
async function cartOf(variantId: string): Promise<string> {
  return (await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId, qty: 1 }, NOW)).cartToken as string;
}

// ───────────────────────────────────────────────────────────────── landing → order

describe("landing → order", () => {
  test("a shopper opens a product through a campaign link and starts the cart there: the order carries the campaign and the link, and module 16 counts it", async () => {
    const product = await make.product({ priceIqd: 120_000, stock: 5 });
    const { campaignId } = await saveCampaign(t.db, staff, { idempotencyKey: key("campaign"), name: "إطلاق الشتاء", channel: "social", utmCampaign: "winter-launch" }, NOW);
    const slug = (await t.d1.prepare("SELECT slug FROM products WHERE id = ?").bind(product.productId).first<{ slug: string }>())!.slug;
    const tracked = await link(`/p/${slug}`, { campaignId });
    const landing = `/p/${slug}?utm_source=instagram&utm_medium=social&utm_campaign=winter-launch&utm_content=story-1&tt_l=${tracked.code}`;

    const page = await visit(landing);
    expect(page.status).toBe(200);
    expect(page.headers.getSetCookie()).toEqual([]); // nothing on the device
    expect(await clicksOf(tracked.linkId)).toBe(1);

    const { token, response } = await addFrom(`${SITE}${landing}`, product.variantId);
    expect(response.headers.getSetCookie().map((cookie) => cookie.split("=")[0])).toEqual([CART_COOKIE]); // only the cart's own cookie
    expect(await clicksOf(tracked.linkId)).toBe(1); // starting the cart is no second click

    const kept = await cartAttribution(t.kv, token);
    expect(kept).toEqual({ source: "instagram", medium: "social", campaign: "winter-launch", content: "story-1", term: null, link: tracked.code });

    const placed = await placeOrder(t.db, who(token, kept), await checkoutInput(token), NOW);
    expect(await orderOf(placed.orderId)).toEqual({ attribution: { source: "instagram", medium: "social", campaign: "winter-launch", content: "story-1" }, utmLinkId: tracked.linkId });

    const report = await attributedByCampaign(t.db, { fromMs: NOW - DAY, toMs: NOW + DAY, includeDemo: true });
    expect(report.byCampaign.get(campaignId)).toMatchObject({ orders: 1 });
    expect(report.orders).toContainEqual(expect.objectContaining({ campaignId }));
  });

  test("a shopper who already has a cart: the landing keeps the campaign with it at once, and the newest campaign wins", async () => {
    const product = await make.product({ priceIqd: 60_000, stock: 5 });
    const token = await cartOf(product.variantId);
    const tracked = await link("/");
    await visit(`/?utm_source=sms&utm_medium=campaign&tt_l=${tracked.code}`, { cookies: { [CART_COOKIE]: token } });
    expect(await cartAttribution(t.kv, token)).toMatchObject({ source: "sms", medium: "campaign", link: tracked.code });

    // later the same shopper comes back through an advert without a link code: kept (no click to count)
    await visit("/c/games?utm_source=google&utm_medium=cpc&utm_campaign=ps5-pro&utm_term=PS5%20Pro", { cookies: { [CART_COOKIE]: token } });
    const newest = await cartAttribution(t.kv, token);
    expect(newest).toEqual({ source: "google", medium: "cpc", campaign: "ps5-pro", content: null, term: "ps5-pro", link: null });
    expect(await clicksOf(tracked.linkId)).toBe(1);

    const placed = await placeOrder(t.db, who(token, newest), await checkoutInput(token), NOW);
    expect(await orderOf(placed.orderId)).toEqual({ attribution: { source: "google", medium: "cpc", campaign: "ps5-pro", term: "ps5-pro" }, utmLinkId: null });
  });

  test("the cart cookie the capture reads is the store's own", () => {
    expect(ATTRIBUTION_CART_COOKIE).toBe(CART_COOKIE);
  });

  test("crafted landings cannot spend the store's KV writes: at most KEEP_LIMIT new campaigns per address and hour", async () => {
    const product = await make.product({ priceIqd: 20_000, stock: 5 });
    const token = await cartOf(product.variantId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 13, 11, 5, 0)));
    try {
      for (let index = 1; index <= KEEP_LIMIT.limit + 3; index++) await visit(`/?utm_source=flood&utm_campaign=c${index}`, { cookies: { [CART_COOKIE]: token }, ip: "198.51.100.90" });
      expect((await cartAttribution(t.kv, token))?.campaign).toBe(`c${KEEP_LIMIT.limit}`);
      // the same campaign again is no write at all, so it never counts against the limit
      await visit(`/?utm_source=flood&utm_campaign=c${KEEP_LIMIT.limit}`, { cookies: { [CART_COOKIE]: token }, ip: "198.51.100.90" });
      expect((await cartAttribution(t.kv, token))?.campaign).toBe(`c${KEEP_LIMIT.limit}`);
    } finally {
      vi.useRealTimers();
    }
  });

  test("many addresses together cannot spend them either: at most KEEP_STORE_LIMIT campaigns kept a day for the whole store (the file store's payment proofs share the KV writes)", async () => {
    const product = await make.product({ priceIqd: 20_000, stock: 5 });
    const token = await cartOf(product.variantId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 20, 9, 0, 0)));
    try {
      for (let index = 1; index <= KEEP_STORE_LIMIT.limit + 2; index++) {
        await visit(`/?utm_source=crowd&utm_campaign=k${index}`, { cookies: { [CART_COOKIE]: token }, ip: `10.${index >> 8}.${index & 255}.7` });
      }
      expect((await cartAttribution(t.kv, token))?.campaign).toBe(`k${KEEP_STORE_LIMIT.limit}`);
      // the next day the store keeps campaigns again
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 21, 9, 0, 0)));
      await visit("/?utm_source=crowd&utm_campaign=next-day", { cookies: { [CART_COOKIE]: token }, ip: "10.9.9.9" });
      expect((await cartAttribution(t.kv, token))?.campaign).toBe("next-day");
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});

// ───────────────────────────────────────────────────────────────── the click

describe("the link's click", () => {
  test("counts a person's browser opening a page — not a bot or a preview, a prefetch, a data request, a redirect or an error, HEAD or /admin", async () => {
    const tracked = await link("/");
    const url = `/?utm_source=whatsapp&utm_medium=message&tt_l=${tracked.code}`;
    await visit(url.replace("/?", "/_.data?")); // React Router's revalidation repeats the page's URL
    await visit(url, { headers: { "User-Agent": "WhatsApp/2.24.20.80 A" } });
    await visit(url, { headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" } });
    await visit(url, { headers: { "User-Agent": "TelegramBot (like TwitterBot)" } });
    await visit(url, { headers: { "User-Agent": "" } });
    await visit(url, { headers: { "Sec-Purpose": "prefetch;prerender" } });
    await visit(url, { headers: { "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors" } });
    await visit(url, { status: 302 });
    await visit(url, { status: 404 });
    await visit(url, { method: "HEAD" });
    await visit(`/admin/marketing/links?utm_source=x&tt_l=${tracked.code}`);
    expect(await clicksOf(tracked.linkId)).toBe(0);

    await visit(url);
    // an in-app browser (Instagram, Facebook) is a person's browser; no Sec-Fetch headers (older browsers) still counts
    await visit(url, { headers: { "User-Agent": `${BROWSER} Instagram 350.0.0.0.0` } });
    await visit(url, { headers: { "Sec-Fetch-Dest": "", "Sec-Fetch-Mode": "" } });
    expect(await clicksOf(tracked.linkId)).toBe(3);
  });

  test("at most CLICK_LIMIT counted per address and window; another address still counts", async () => {
    const tracked = await link("/");
    const url = `/?utm_source=sms&utm_medium=campaign&tt_l=${tracked.code}`;
    // the middleware stamps requests with the real clock: hold it inside one window so the limit cannot roll over mid-test
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 13, 10, 3, 0)));
    try {
      for (let index = 0; index < CLICK_LIMIT.limit + 5; index++) await visit(url, { ip: "198.51.100.77" });
      expect(await clicksOf(tracked.linkId)).toBe(CLICK_LIMIT.limit);
      await visit(url, { ip: "198.51.100.78" });
      expect(await clicksOf(tracked.linkId)).toBe(CLICK_LIMIT.limit + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an unknown link code counts nothing and is no error", async () => {
    const response = await visit("/?utm_source=sms&tt_l=zzzz9999zz");
    expect(response.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────── junk

describe("junk parameters", () => {
  test("each value is cleaned or dropped, never repaired; junk alone is no campaign", () => {
    expect(campaignValue("Summer Sale")).toBe("summer-sale");
    expect(campaignValue("  PS5_Pro.v2  ")).toBe("ps5_pro.v2");
    expect(campaignValue("عرض_الصيف")).toBe("عرض_الصيف");
    expect(campaignValue("حملة٢٠٢٦")).toBe("حملة2026");
    expect(campaignValue("black-friday-20261127")).toBe("black-friday-20261127");
    for (const junk of ["<script>alert(1)</script>", "zahra@example.com", "https://evil.example/x", "+9647701234567", "07701234567", "x".repeat(61), "‮abc", "a\u0000b", "-start", "", "   ", "=cmd|' /C calc'!A0", 42, null, undefined, { source: "x" }]) {
      expect(campaignValue(junk), String(junk)).toBeNull();
    }
    expect(campaignValue("y".repeat(201))).toBeNull();
    expect(linkCode("ABCD2345")).toBe("abcd2345");
    for (const junk of ["../../etc", "abc", "a".repeat(25), "abc d123", "<b>1234</b>", 1234]) expect(linkCode(junk), String(junk)).toBeNull();

    expect(campaignFromParams(new URLSearchParams("utm_source=Instagram&utm_source=evil&utm_medium=%3Cb%3E&utm_campaign=a%40b.com&tt_l=ABCD2345"))).toEqual({ source: "instagram", medium: null, campaign: null, content: null, term: null, link: "abcd2345" });
    expect(campaignFromParams(new URLSearchParams("utm_medium=social&utm_campaign=x"))).toBeNull(); // no source, no link
    expect(campaignFromParams(new URLSearchParams("utm_source=%3Cscript%3E&tt_l=..%2F..%2Fx"))).toBeNull();
    expect(cleanCampaign({ source: "<b>x</b>", link: "x".repeat(100) })).toBeNull();
    expect(cleanCampaign("instagram")).toBeNull();
    expect(cleanCampaign(["instagram"])).toBeNull();
  });

  test("a landing with junk only is nothing: no click, nothing kept with the cart", async () => {
    const product = await make.product({ priceIqd: 40_000, stock: 3 });
    const token = await cartOf(product.variantId);
    await visit("/?utm_source=%3Cscript%3Ealert(1)%3C%2Fscript%3E&utm_medium=+9647701234567&tt_l=%27%3B--", { cookies: { [CART_COOKIE]: token } });
    expect(await cartAttribution(t.kv, token)).toBeNull();
  });

  test("a tampered or unreadable record is no source; a junk or failing source never refuses or breaks the order", async () => {
    const product = await make.product({ priceIqd: 45_000, stock: 10 });
    const token = await cartOf(product.variantId);
    await visit("/?utm_source=sms&utm_medium=campaign", { cookies: { [CART_COOKIE]: token } });
    expect(await cartAttribution(t.kv, token)).toMatchObject({ source: "sms" });
    // someone with access to the store rewrites what is kept: read back, it is cleaned again like any parameter
    const keys = (await t.kv.list({ prefix: "attribution/cart/" })).keys.map((row) => row.name);
    expect(keys.length).toBeGreaterThan(0);
    for (const name of keys) await t.kv.put(name, JSON.stringify({ source: "<img src=x onerror=alert(1)>", link: "../../" }));
    expect(await cartAttribution(t.kv, token)).toBeNull();
    for (const name of keys) await t.kv.put(name, "{not json");
    expect(await cartAttribution(t.kv, token)).toBeNull();

    for (const junk of ["instagram", ["instagram"], 42, { source: "<b>x</b>" }, { get source(): string { throw new Error("a getter that throws (test)"); } }]) {
      const cart = await cartOf(product.variantId);
      const placed = await placeOrder(t.db, who(cart, junk), await checkoutInput(cart), NOW);
      expect(await orderOf(placed.orderId), String(junk)).toEqual({ attribution: null, utmLinkId: null });
    }
    // a valid campaign whose link does not exist: the campaign is kept, the link is not invented
    const cart = await cartOf(product.variantId);
    const placed = await placeOrder(t.db, who(cart, { source: "sms", medium: "campaign", link: "gone2345" }), await checkoutInput(cart), NOW);
    expect(await orderOf(placed.orderId)).toEqual({ attribution: { source: "sms", medium: "campaign" }, utmLinkId: null });
    // the link lookup failing: the order source keeps the campaign and leaves the link out, without throwing
    const broken = new Proxy(t.db, {
      get(target, property) {
        if (property === "select") {
          return () => {
            throw new Error("the database is down (test)");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as Db;
    expect(await orderSource(broken, { source: "sms", link: "abcd2345" })).toEqual({ attribution: { source: "sms" }, utmLinkId: null });
  });

  test("the recording failing never fails the request", async () => {
    const product = await make.product({ priceIqd: 45_000, stock: 2 });
    const token = await cartOf(product.variantId);
    const bindings = env as unknown as Record<string, unknown>;
    const realKv = bindings.KV;
    bindings.KV = { put: () => Promise.reject(new Error("KV is down (test)")), get: () => Promise.reject(new Error("KV is down (test)")) };
    try {
      const response = await visit("/?utm_source=sms&utm_medium=campaign", { cookies: { [CART_COOKIE]: token } });
      expect(response.status).toBe(200);
      expect(await cartAttribution(bindings.KV as KVNamespace, token)).toBeNull();
    } finally {
      bindings.KV = realKv;
    }
  });
});

// ───────────────────────────────────────────────────────────────── none

describe("no attribution when none", () => {
  test("pages and carts without campaign parameters keep nothing, and their orders carry no source", async () => {
    const product = await make.product({ priceIqd: 30_000, stock: 5 });
    const plain = await visit("/p/anything?q=ps5&page=2");
    expect(plain.headers.getSetCookie()).toEqual([]);
    const { token } = await addFrom(`${SITE}/p/anything?q=ps5`, product.variantId);
    expect(await cartAttribution(t.kv, token)).toBeNull();
    const placed = await placeOrder(t.db, who(token, await cartAttribution(t.kv, token)), await checkoutInput(token), NOW);
    expect(await orderOf(placed.orderId)).toEqual({ attribution: null, utmLinkId: null });
    // the checkout as it is today (no attribution passed) is unchanged
    const other = await cartOf(product.variantId);
    const today = await placeOrder(t.db, who(other), await checkoutInput(other), NOW);
    expect(await orderOf(today.orderId)).toEqual({ attribution: null, utmLinkId: null });
    expect(await cartAttribution(undefined, token)).toBeNull();
    expect(await cartAttribution(t.kv, "not a token")).toBeNull();
  });

  test("requests that are not a landing or a cart started on one are passed over", () => {
    const ctx = { cookie: (name: string) => (name === CART_COOKIE ? "a".repeat(32) : null), ip: null, now: NOW };
    const get = (path: string, headers: Record<string, string> = {}) => new Request(`${SITE}${path}`, { headers: { "User-Agent": BROWSER, ...headers } });
    const post = (path: string, headers: Record<string, string>) => new Request(`${SITE}${path}`, { method: "POST", headers });
    const newCart = [`${CART_COOKIE}=${"b".repeat(32)}; Path=/; Max-Age=5184000; HttpOnly; SameSite=Lax`];
    const at = (path: string) => new URL(`${SITE}${path}`);
    // a GET whose URL has no campaign, an API GET, a data request
    expect(campaignVisit(get("/c/games?platform=ps5"), at("/c/games?platform=ps5"), ctx, [], 200)).toBeNull();
    expect(campaignVisit(get("/api/search/suggest?utm_source=x"), at("/api/search/suggest?utm_source=x"), ctx, [], 200)).toBeNull();
    expect(campaignVisit(get("/c/games.data?utm_source=x"), at("/c/games.data?utm_source=x"), ctx, [], 200)).toBeNull();
    // a POST from a landing page that does not start a cart (the shopper had one), from another site, or from a page without a campaign
    expect(campaignVisit(post("/api/cart", { Referer: `${SITE}/?utm_source=x` }), at("/api/cart"), ctx, [], 200)).toBeNull();
    expect(campaignVisit(post("/api/cart", { Referer: "https://elsewhere.example/?utm_source=x" }), at("/api/cart"), ctx, newCart, 200)).toBeNull();
    expect(campaignVisit(post("/api/cart", { Referer: `${SITE}/p/x` }), at("/api/cart"), ctx, newCart, 200)).toBeNull();
    expect(campaignVisit(post("/api/cart", { Referer: `${SITE}/?utm_source=x` }), at("/api/cart"), ctx, [`${CART_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`], 200)).toBeNull();
    // what does count: the landing (a page, with the shopper's cart), and the cart it starts
    expect(campaignVisit(get("/?utm_source=x"), at("/?utm_source=x"), ctx, [], 200)).toMatchObject({ click: false, cartToken: "a".repeat(32) });
    expect(campaignVisit(post("/api/cart", { Referer: `${SITE}/?utm_source=x` }), at("/api/cart"), ctx, newCart, 200)).toMatchObject({ click: false, cartToken: "b".repeat(32) });
    expect(isBrowserOpen(get("/", { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" }))).toBe(true);
    expect(isBrowserOpen(get("/", { "Sec-Fetch-Dest": "iframe" }))).toBe(false);
  });
});
