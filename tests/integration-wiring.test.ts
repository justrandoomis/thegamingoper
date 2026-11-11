/**
 * The storefront's cross-area wiring (the integration pass), against a real local D1 with the demo catalogue:
 *
 *   · recommendationsFor — what every page streams: never rejects, consent-only "personal" shelves read nothing
 *     without consent, the `keep` filter, the hard filter still holds (nothing recommended is the product itself);
 *   · the purchase signal (checkout's own server file): consent only, one per product, a guest gets its session key
 *     there, a replayed attempt records nothing; orderItemsOf / usedUnitVariantIds (the cart and order anchors);
 *   · ONE recently-viewed store: a guest's views never reach the server, a signed-in customer's go to the account,
 *     the device's guest list joins the account once (newest time wins, nothing counted twice), "clear" and consent
 *     withdrawal forget the account's list and the recommendation signals (POST /api/onboarding consent=0);
 *   · getDeviceLink (hub links on the product page, used units, the help centre) and the checkout's address prefill.
 *
 * Routes run through the real root middleware (context, CSRF origin check, cookies), like tests/account.test.ts.
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, sha256Hex } from "~/lib/ids";
import { signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { consents, products, recentlyViewed, recommendationEvents } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { governorateId } from "~/server/db/seed/reference";
import { listRecentlyViewedIds, MAX_RECENTLY_VIEWED, mergeDeviceRecentlyViewed, recordRecentlyViewed } from "~/server/services/account/recently-viewed.server";
import type { AddressView } from "~/server/services/account/types";
import { getDeviceLink } from "~/server/services/devices.server";
import { isPersonalShelf, orderItemsOf, recommendationsFor, recordEvent, recordPurchaseSignals, usedUnitVariantIds } from "~/server/services/recommendations.server";
import { action as settingsAction } from "~/routes/storefront/account/settings";
import { addressPrefill, cartShelves, recordPurchase } from "~/routes/storefront/checkout/checkout.server";
import { action as onboardingAction } from "~/routes/storefront/home/api.onboarding";
import { action as recentAction, loader as recentLoader } from "~/routes/storefront/home/api.recently-viewed";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const SITE = "http://localhost:5173";

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  await seedDemo(t.db, NOW);
}, 180_000);
afterAll(async () => {
  await t.dispose();
});

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const productIdOf = async (slug: string) => (await rows<{ id: string }>("SELECT id FROM products WHERE slug = ?", slug))[0]?.id ?? "";
const cookieJar = (values: Record<string, string>) => (name: string) => values[name] ?? null;

let requestCount = 0;
type TestRequest = { ctx: RequestCtx; setCookies: string[] };
function request(cookies: Record<string, string> = {}): TestRequest {
  const n = ++requestCount;
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `int-${n}`,
    nonce: "n",
    origin: SITE,
    isHttps: false,
    isDev: true,
    now: NOW,
    ip: `198.19.${Math.floor(n / 250)}.${n % 250}`,
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: cookieJar(cookies),
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

/** A signed-up customer and the `tt_sid` value that signs them in. */
async function customerSession(): Promise<{ customerId: string; sid: string }> {
  const r = request();
  const phone = `0770${String(5_000_000 + ++requestCount).slice(-7)}`;
  const session = await signUpCustomer(r.ctx, t.db, { phone, password: "integration-password-1" });
  const cookie = r.setCookies.find((value) => value.startsWith("tt_sid="));
  return { customerId: session.customer.id, sid: decodeURIComponent(cookie!.split(";")[0].slice("tt_sid=".length)) };
}

type RouteResult = { status: number; data: unknown; setCookies: string[] };

/** Runs a loader or action the way React Router does: root middleware (context, CSRF, cookies) first. */
async function viaRoot(path: string, handler: (args: never) => Promise<unknown>, init: { method?: string; form?: Record<string, string>; cookies?: Record<string, string>; origin?: string } = {}): Promise<RouteResult> {
  const headers: Record<string, string> = { "CF-Connecting-IP": `203.0.113.${++requestCount % 250}` };
  if (init.cookies) headers.Cookie = Object.entries(init.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  if (init.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (init.method === "POST") headers.Origin = init.origin ?? SITE;
  const req = new Request(`${SITE}${path}`, { method: init.method ?? "GET", headers, body: init.form ? new URLSearchParams(init.form) : undefined });
  const context = new RouterContextProvider();
  const url = new URL(req.url);
  let value: unknown;
  let response: Response;
  try {
    response = (await requestContextMiddleware({ request: req, context, url, pattern: path, params: {} } as never, async () => {
      try {
        value = await handler({ request: req, context, params: {}, url, pattern: path } as never);
      } catch (thrown) {
        value = thrown;
      }
      if (value instanceof Response) return value;
      const status = (value as { init?: { status?: number } }).init?.status ?? 200;
      return new Response(null, { status });
    })) as Response;
  } catch (refused) {
    // the middleware itself refused (the CSRF origin check): nothing below it ran
    const init = (refused as { init?: { status?: number } }).init;
    return { status: init?.status ?? 500, data: (refused as { data?: unknown }).data ?? null, setCookies: [] };
  }
  const data = value instanceof Response ? null : ((value as { data?: unknown }).data ?? value);
  return { status: response.status, data, setCookies: response.headers.getSetCookie() };
}

// ───────────────────────────────────────────────────────────────── recommendationsFor

describe("recommendationsFor (what the pages stream)", () => {
  test("product context on the demo catalogue: an answer, never the product itself, and `keep` filters shelves", async () => {
    const productId = await productIdOf("playstation-5-slim");
    expect(productId).not.toBe("");
    const all = await recommendationsFor(t.db, { cookie: cookieJar({}), customerId: null }, { locale: "ar", context: "product", productId, now: NOW }, 8);
    expect(all.ok).toBe(true);
    expect(all.shelves.length).toBeGreaterThan(0);
    for (const shelf of all.shelves) {
      expect(shelf.reason, shelf.key).toBeTruthy();
      expect(shelf.items.map((card) => card.id)).not.toContain(productId);
      for (const card of shelf.items) expect(card.stock).not.toBe("out_of_stock");
    }
    const setupOnly = await recommendationsFor(t.db, { cookie: cookieJar({}), customerId: null }, { locale: "ar", context: "product", productId, now: NOW, keep: (shelf) => shelf.key.startsWith("product:setup:") }, 8);
    expect(setupOnly.shelves.every((shelf) => shelf.key.startsWith("product:setup:"))).toBe(true);
  });

  test("personal-only pages read nothing without consent, and show only the personal shelf with it", async () => {
    const without = await recommendationsFor(t.db, { cookie: cookieJar({ tt_consent: "0" }), customerId: null }, { locale: "ar", context: "home", personalOnly: true, now: NOW }, 8);
    expect(without).toEqual({ ok: true, shelves: [] });
    // consent, a session key and one viewed console: the personal shelf alone (the store's picks are dropped)
    const token = "integration-session-token-0000000000000001";
    const subject = { consent: true, sessionHash: await sha256Hex(token), customerId: null };
    await recordEvent(t.db, subject, { kind: "view", productId: await productIdOf("playstation-5-slim") }, NOW - 1000);
    const withConsent = await recommendationsFor(t.db, { cookie: cookieJar({ tt_consent: "1", tt_rs: token }), customerId: null }, { locale: "en", context: "home", personalOnly: true, now: NOW }, 8);
    expect(withConsent.ok).toBe(true);
    expect(withConsent.shelves.length).toBeGreaterThan(0);
    expect(withConsent.shelves.every(isPersonalShelf)).toBe(true);
    expect(withConsent.shelves[0].reason).toContain("with your permission");
  });

  test("never rejects: a malformed request is ok:false (the page shows a retry in the shelves' space)", async () => {
    const broken = await recommendationsFor(t.db, { cookie: cookieJar({}), customerId: null }, { locale: "ar", context: "product", productId: "not an id!", now: NOW }, 8);
    expect(broken).toEqual({ ok: false, shelves: [] });
    const empty = await cartShelves(t.db, { cookie: cookieJar({}), locale: "ar", now: NOW }, null, { lines: [] });
    expect(empty).toEqual({ ok: true, shelves: [] });
  });
});

// ───────────────────────────────────────────────────────────────── purchase signal, anchors

describe("the purchase signal (checkout's own server file) and the cart/order anchors", () => {
  test("orderItemsOf and usedUnitVariantIds give the products and variants behind an order and used units", async () => {
    const a = await make.product({ stock: 3 });
    const b = await make.product({ stock: 3 });
    const order = await make.order([{ variantId: a.variantId, sku: a.sku }, { variantId: b.variantId, sku: b.sku, qty: 2 }]);
    const items = await orderItemsOf(t.db, order.ref);
    expect(new Set(items.productIds)).toEqual(new Set([a.productId, b.productId]));
    expect(new Set(items.variantIds)).toEqual(new Set([a.variantId, b.variantId]));
    expect(await orderItemsOf(t.db, "TT-NOPE")).toEqual({ productIds: [], variantIds: [] });

    const unit = (await rows<{ id: string; variant_id: string }>("SELECT id, variant_id FROM used_units LIMIT 1"))[0];
    expect(await usedUnitVariantIds(t.db, [unit.id, "uu_missing", "bad id!"])).toEqual([unit.variant_id]);
  });

  test("recordPurchaseSignals: nothing without consent; one per product with it; a repeat inside the window is one", async () => {
    const a = await make.product({ stock: 3 });
    const b = await make.product({ stock: 3 });
    const customerId = await make.customer();
    expect(await recordPurchaseSignals(t.db, { consent: false, sessionHash: null, customerId }, [a.productId, b.productId], NOW)).toBe(0);
    expect(await recordPurchaseSignals(t.db, { consent: true, sessionHash: null, customerId }, [a.productId, b.productId, a.productId], NOW)).toBe(2);
    expect(await recordPurchaseSignals(t.db, { consent: true, sessionHash: null, customerId }, [a.productId], NOW + 1000)).toBe(0);
    const stored = await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.customerId, customerId));
    expect(stored.map((row) => row.kind)).toEqual(["purchase", "purchase"]);
    expect(stored.every((row) => row.source === "checkout" && row.sessionHash === null)).toBe(true);
  });

  test("recordPurchase: a consenting guest gets a session key with the signal; no consent or a replay records nothing", async () => {
    const a = await make.product({ stock: 3 });
    const order = await make.order([{ variantId: a.variantId, sku: a.sku }]);
    const success = { ok: true as const, ref: order.ref, accessToken: "x", replayed: false };

    const declined = request({ tt_consent: "0" });
    await recordPurchase(t.db, declined.ctx, null, success);
    expect(declined.setCookies).toEqual([]);

    const replay = request({ tt_consent: "1" });
    await recordPurchase(t.db, replay.ctx, null, { ...success, replayed: true });
    expect(replay.setCookies).toEqual([]);
    expect(await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.productId, a.productId))).toEqual([]);

    const guest = request({ tt_consent: "1" });
    await recordPurchase(t.db, guest.ctx, null, success);
    const minted = guest.setCookies.find((value) => value.startsWith("tt_rs="));
    expect(minted).toMatch(/HttpOnly/);
    const token = decodeURIComponent(minted!.split(";")[0].slice("tt_rs=".length));
    const stored = await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.productId, a.productId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "purchase", customerId: null, sessionHash: await sha256Hex(token) });
  });
});

// ───────────────────────────────────────────────────────────────── one recently-viewed store

describe("recently viewed: one store per shopper", () => {
  test("the device's guest list joins the account once: consent only, published only, the newest time wins, capped", async () => {
    const customerId = await make.customer();
    const [a, b, c] = [await make.product(), await make.product(), await make.product()];
    const hidden = await make.product();
    await t.db.update(products).set({ status: "draft" }).where(eq(products.id, hidden.productId));

    expect(await mergeDeviceRecentlyViewed(t.db, customerId, [{ id: a.productId, at: NOW - 1000 }], NOW, { consent: false })).toBe(0);
    expect(await listRecentlyViewedIds(t.db, { customerId, cartToken: null })).toEqual([]);

    // the account already saw `a` later than the device did: one row, the account's time
    await recordRecentlyViewed(t.db, { customerId, cartToken: null }, a.productId, NOW - 10, { consent: true });
    const merged = await mergeDeviceRecentlyViewed(
      t.db,
      customerId,
      [
        { id: a.productId, at: NOW - 5000 },
        { id: b.productId, at: NOW - 2000 },
        { id: c.productId, at: NOW + 60 * DAY }, // a clock in the future counts as now
        { id: hidden.productId, at: NOW - 100 }, // not published
        { id: "prd_unknown", at: NOW - 100 },
        { id: b.productId, at: NOW - 91 * DAY }, // older than 90 days: dropped (the newer `b` stays)
      ],
      NOW,
      { consent: true },
    );
    expect(merged).toBe(3);
    expect(await listRecentlyViewedIds(t.db, { customerId, cartToken: null })).toEqual([c.productId, a.productId, b.productId]);
    const rowsOfA = await t.db.select().from(recentlyViewed).where(and(eq(recentlyViewed.customerId, customerId), eq(recentlyViewed.productId, a.productId)));
    expect(rowsOfA).toHaveLength(1);
    expect(rowsOfA[0].viewedAt).toBe(NOW - 10);

    // the cap holds after a merge
    const many = [];
    for (let i = 0; i < MAX_RECENTLY_VIEWED + 5; i++) many.push((await make.product()).productId);
    for (const [i, id] of many.entries()) await recordRecentlyViewed(t.db, { customerId, cartToken: null }, id, NOW + i, { consent: true });
    await mergeDeviceRecentlyViewed(t.db, customerId, [{ id: a.productId, at: NOW + 1000 }], NOW + 1000, { consent: true });
    const kept = await listRecentlyViewedIds(t.db, { customerId, cartToken: null }, MAX_RECENTLY_VIEWED);
    expect(kept).toHaveLength(MAX_RECENTLY_VIEWED);
    expect(kept[0]).toBe(a.productId);
  });

  test("POST /api/recently-viewed: a guest's view never reaches the server; a consenting customer's goes to the account with the device list", async () => {
    const [a, b] = [await make.product(), await make.product()];
    const guest = await viaRoot("/api/recently-viewed", recentAction as never, { method: "POST", form: { productId: a.productId }, cookies: { tt_consent: "1" } });
    expect(guest).toMatchObject({ status: 200, data: { ok: true, kept: false, merged: null } });
    expect(await t.db.select().from(recentlyViewed).where(eq(recentlyViewed.productId, a.productId))).toEqual([]);

    const { customerId, sid } = await customerSession();
    const noConsent = await viaRoot("/api/recently-viewed", recentAction as never, { method: "POST", form: { productId: a.productId }, cookies: { tt_sid: sid, tt_consent: "0" } });
    expect(noConsent.data).toMatchObject({ ok: true, kept: false, merged: null });

    const device = JSON.stringify([{ id: b.productId, at: NOW - 60_000 }]);
    const kept = await viaRoot("/api/recently-viewed", recentAction as never, { method: "POST", form: { productId: a.productId, device }, cookies: { tt_sid: sid, tt_consent: "1" } });
    expect(kept).toMatchObject({ status: 200, data: { ok: true, kept: true, merged: 1 } });
    expect(await listRecentlyViewedIds(t.db, { customerId, cartToken: null })).toEqual([a.productId, b.productId]);

    // the account's list comes back as cards (signed in); a guest asking for it gets none
    const list = await viaRoot("/api/recently-viewed?scope=account&locale=en", recentLoader as never, { cookies: { tt_sid: sid, tt_consent: "1" } });
    expect(list.data).toMatchObject({ ok: true, scope: "account" });
    expect((list.data as { cards: { id: string }[] }).cards.map((card) => card.id)).toEqual([a.productId, b.productId]);
    expect((await viaRoot("/api/recently-viewed?scope=account", recentLoader as never, { cookies: { tt_consent: "1" } })).data).toMatchObject({ ok: true, cards: [], scope: "none" });

    // malformed input and cross-site posts are refused
    expect((await viaRoot("/api/recently-viewed", recentAction as never, { method: "POST", form: { device: "[{" }, cookies: { tt_sid: sid, tt_consent: "1" } })).status).toBe(400);
    expect((await viaRoot("/api/recently-viewed", recentAction as never, { method: "POST", form: { productId: a.productId }, cookies: { tt_sid: sid }, origin: "https://evil.example" })).status).toBe(403);

    const cleared = await viaRoot("/api/recently-viewed", recentAction as never, { method: "POST", form: { intent: "clear" }, cookies: { tt_sid: sid, tt_consent: "1" } });
    expect(cleared.data).toMatchObject({ ok: true, cleared: 2 });
    expect(await listRecentlyViewedIds(t.db, { customerId, cartToken: null })).toEqual([]);
  });

  test("withdrawing consent on the home page forgets on the server: signals of the device and the account, the account's list, tt_rs", async () => {
    const a = await make.product();
    const { customerId, sid } = await customerSession();
    const token = "integration-session-token-0000000000000002";
    const sessionHash = await sha256Hex(token);
    await recordEvent(t.db, { consent: true, sessionHash, customerId: null }, { kind: "view", productId: a.productId }, NOW);
    await recordEvent(t.db, { consent: true, sessionHash: null, customerId }, { kind: "view", productId: a.productId }, NOW);
    await recordRecentlyViewed(t.db, { customerId, cartToken: null }, a.productId, NOW, { consent: true });

    const answer = await viaRoot("/api/onboarding", onboardingAction as never, { method: "POST", form: { consent: "0" }, cookies: { tt_sid: sid, tt_rs: token, tt_consent: "1" } });
    expect(answer).toMatchObject({ status: 200, data: { ok: true, consent: false } });
    expect(answer.setCookies.some((value) => value.startsWith("tt_rs=") && /Max-Age=0/.test(value))).toBe(true);
    expect(await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.sessionHash, sessionHash))).toEqual([]);
    expect(await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.customerId, customerId))).toEqual([]);
    expect(await listRecentlyViewedIds(t.db, { customerId, cartToken: null })).toEqual([]);
    const answers = await t.db.select().from(consents).where(and(eq(consents.subjectId, customerId), eq(consents.kind, "personalization")));
    expect(answers.map((row) => row.granted)).toEqual([false]);
  });

  test("withdrawing personalization in the account settings forgets the same things", async () => {
    const a = await make.product();
    const { customerId, sid } = await customerSession();
    const token = "integration-session-token-0000000000000003";
    const sessionHash = await sha256Hex(token);
    await recordEvent(t.db, { consent: true, sessionHash, customerId: null }, { kind: "view", productId: a.productId }, NOW);
    await recordEvent(t.db, { consent: true, sessionHash: null, customerId }, { kind: "view", productId: a.productId }, NOW);
    await recordRecentlyViewed(t.db, { customerId, cartToken: null }, a.productId, NOW, { consent: true });

    const answer = await viaRoot("/account/settings", settingsAction as never, { method: "POST", form: { intent: "consents" }, cookies: { tt_sid: sid, tt_rs: token, tt_consent: "1" } });
    expect(answer).toMatchObject({ status: 200, data: { ok: true } });
    expect(answer.setCookies.some((value) => value.startsWith("tt_consent=0"))).toBe(true);
    expect(answer.setCookies.some((value) => value.startsWith("tt_rs=") && /Max-Age=0/.test(value))).toBe(true);
    expect(await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.sessionHash, sessionHash))).toEqual([]);
    expect(await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.customerId, customerId))).toEqual([]);
    expect(await listRecentlyViewedIds(t.db, { customerId, cartToken: null })).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── device links, address prefill

describe("device hub links and the checkout's address prefill", () => {
  test("getDeviceLink: a published model of an active platform has a hub; others do not", async () => {
    const link = await getDeviceLink(t.db, "en", "ps5-slim");
    expect(link).toMatchObject({ slug: "ps5-slim", platformSlug: "playstation" });
    expect(link?.name).toMatch(/PlayStation 5/);
    expect(link?.id).toMatch(/^[A-Za-z0-9]/);
    expect(await getDeviceLink(t.db, "en", "windows-pc")).toBeNull(); // inactive "pc" platform
    expect(await getDeviceLink(t.db, "en", "no-such-device")).toBeNull();
    expect(await getDeviceLink(t.db, "en", "Bad Slug!")).toBeNull();
    expect(await getDeviceLink(t.db, "en", null)).toBeNull();
  });

  test("addressPrefill: only a place the checkout serves; a district no longer listed is left to choose; the phone as the field shows it", () => {
    const baghdad = governorateId("baghdad");
    const page = {
      governorates: [
        { id: baghdad, name: "بغداد", feeIqd: 5000 },
        { id: "gov_closed", name: "مغلقة", feeIqd: null },
      ],
      districts: { [baghdad]: [{ id: "dst_a", name: "الكرادة" }] },
    } as const;
    const address: AddressView = {
      id: newId("adr"),
      label: "البيت",
      recipientName: "سارة",
      phoneE164: "+9647701234567",
      governorateId: baghdad,
      governorateName: "بغداد",
      districtId: "dst_a",
      districtName: "الكرادة",
      areaText: "الكرادة داخل",
      addressText: "شارع 62، قرب الجامع",
      notes: null,
      isDefault: true,
    };
    expect(addressPrefill(null, page as never)).toBeNull();
    expect(addressPrefill(address, page as never)).toEqual({
      label: "البيت",
      contactName: "سارة",
      phone: "0770 123 4567",
      governorateId: baghdad,
      districtId: "dst_a",
      areaText: "الكرادة داخل",
      addressText: "شارع 62، قرب الجامع",
      notes: "",
    });
    expect(addressPrefill({ ...address, districtId: "dst_gone" }, page as never)?.districtId).toBe("");
    expect(addressPrefill({ ...address, phoneE164: null, recipientName: null }, page as never)).toMatchObject({ phone: "", contactName: "" });
    expect(addressPrefill({ ...address, governorateId: "gov_closed" }, page as never)).toBeNull();
    expect(addressPrefill({ ...address, governorateId: "gov_unknown" }, page as never)).toBeNull();
  });
});
