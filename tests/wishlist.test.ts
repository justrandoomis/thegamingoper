/**
 * Favourites — ~/server/services/wishlist.server and POST /api/wishlist (account area).
 *
 * Covered: guests keyed by the cart cookie (only its hash stored) and the `tt_wish` bridge when they have no cart;
 * the bridge moving rows when the cart token changes; sign-in merge (union, guest rows gone); customers; idempotency;
 * validation (published products only, ids); the 200-item limit; privacy between owners; the page read (cards and
 * products no longer sold); the resource route's contract `{ ok, wished }`, its cookie, CSRF and method checks.
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { requestContextMiddleware } from "~/server/context.server";
import { products, variants, wishlistItems } from "~/server/db/schema";
import { chunkRows, runBatch } from "~/server/db/tx.server";
import { AppError, toAppError } from "~/server/errors";
import { countWishlist, getWishlistIds, isWished, listWishlist, mergeGuestWishlist, rekeyGuestWishlist, reconcileGuestWishlist, setWished, toggleWishlist, WISHLIST_LIMIT, wishedAmong, wishlistWho } from "~/server/services/wishlist.server";
import { action as wishlistAction, loader as wishlistLoader } from "~/routes/api/wishlist";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
const NOW = TEST_NOW;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t.dispose();
});

async function failure(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    const appError = error instanceof AppError ? error : toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("Expected the call to fail, but it succeeded");
}

const guest = (cartToken: string | null, wishToken: string | null = null) => ({ customerId: null, cartToken, wishToken });
const rows = (where?: ReturnType<typeof eq>) => t.db.select().from(wishlistItems).where(where);

/** `count` published products in one go (the limit test needs many). */
async function manyProducts(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => newId("prd"));
  const productRows = ids.map((id, index) => ({ id, slug: `bulk-${id.slice(-10).toLowerCase()}-${index}`, kind: "game" as const, name: { ar: "لعبة", en: "Game" }, status: "published" as const, createdAt: NOW, updatedAt: NOW }));
  const variantRows = ids.map((productId, index) => ({ id: newId("var"), productId, sku: `BULK-${productId.slice(-8)}-${index}`, priceIqd: 50_000, isDefault: true }));
  await runBatch(t.db, [...chunkRows(products, productRows).map((chunk) => t.db.insert(products).values(chunk)), ...chunkRows(variants, variantRows).map((chunk) => t.db.insert(variants).values(chunk))]);
  return ids;
}

describe("guests", () => {
  test("a guest without any cookie gets a token; only its hash is stored; toggling twice takes the product off", async () => {
    const { productId } = await make.product({ stock: 1 });
    const first = await toggleWishlist(t.db, guest(null), productId, NOW);
    expect(first).toMatchObject({ wished: true, count: 1 });
    expect(first.guestToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const stored = await rows(eq(wishlistItems.productId, productId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ customerId: null, cartTokenHash: await sha256Hex(first.guestToken!) });
    expect(JSON.stringify(stored)).not.toContain(first.guestToken!);

    expect(await getWishlistIds(t.db, guest(null, first.guestToken))).toEqual([productId]);
    const second = await toggleWishlist(t.db, guest(null, first.guestToken), productId, NOW + 1);
    expect(second).toMatchObject({ wished: false, count: 0, guestToken: first.guestToken });
    expect(await rows(eq(wishlistItems.productId, productId))).toHaveLength(0);
  });

  test("a guest with a cart keys the favourites by the cart token (what other areas read with getWishlistIds)", async () => {
    const cart = randomToken();
    const { productId } = await make.product();
    const change = await toggleWishlist(t.db, guest(cart), productId, NOW);
    expect(change).toMatchObject({ wished: true, guestToken: cart });
    expect(await getWishlistIds(t.db, { customerId: null, cartToken: cart })).toEqual([productId]);
    expect(await isWished(t.db, guest(cart), productId)).toBe(true);
    expect(await wishedAmong(t.db, guest(cart), [productId, "prd_other"])).toEqual(new Set([productId]));
  });

  test("when the cart token changes (first cart, or the cart after an order), the bridge moves the rows to it", async () => {
    const before = randomToken();
    const [a, b, c] = await Promise.all([make.product(), make.product(), make.product()]);
    // Saved while the guest had no cart: keyed by the bridge token.
    await setWished(t.db, guest(null, before), a.productId, true, NOW);
    await setWished(t.db, guest(null, before), b.productId, true, NOW + 1);
    // The cart service minted a new token; the guest already had `b` under it too.
    const cart = randomToken();
    await setWished(t.db, guest(cart), b.productId, true, NOW + 2);
    // Readers that know both cookies see everything at once …
    expect(new Set(await getWishlistIds(t.db, guest(cart, before)))).toEqual(new Set([a.productId, b.productId]));
    // … and the next change through the service re-keys the rows (b kept once).
    const change = await setWished(t.db, guest(cart, before), c.productId, true, NOW + 3);
    expect(change).toMatchObject({ wished: true, count: 3, guestToken: cart });
    expect(new Set(await getWishlistIds(t.db, guest(cart)))).toEqual(new Set([a.productId, b.productId, c.productId]));
    expect(await rows(eq(wishlistItems.cartTokenHash, await sha256Hex(before)))).toHaveLength(0);
    expect(await reconcileGuestWishlist(t.db, guest(cart, before))).toBe(cart);
  });

  test("rekeyGuestWishlist moves rows between tokens and ignores bad input", async () => {
    const from = randomToken();
    const to = randomToken();
    const { productId } = await make.product();
    await setWished(t.db, guest(from), productId, true, NOW);
    await rekeyGuestWishlist(t.db, from, "short");
    expect(await getWishlistIds(t.db, guest(from))).toEqual([productId]);
    await rekeyGuestWishlist(t.db, from, to);
    expect(await getWishlistIds(t.db, guest(from))).toEqual([]);
    expect(await getWishlistIds(t.db, guest(to))).toEqual([productId]);
  });
});

describe("customers", () => {
  test("adding is idempotent, removing always works, and the newest addition comes first", async () => {
    const customerId = await make.customer();
    const who = { customerId, cartToken: null };
    const [a, b] = await Promise.all([make.product(), make.product()]);
    await setWished(t.db, who, a.productId, true, NOW);
    await setWished(t.db, who, a.productId, true, NOW + 1);
    await setWished(t.db, who, b.productId, true, NOW + 2);
    expect(await getWishlistIds(t.db, who)).toEqual([b.productId, a.productId]);
    expect(await countWishlist(t.db, who)).toBe(2);
    expect(await setWished(t.db, who, a.productId, false, NOW + 3)).toMatchObject({ wished: false, count: 1, guestToken: null });
    expect(await setWished(t.db, who, a.productId, false, NOW + 4)).toMatchObject({ wished: false, count: 1 });
  });

  test("validation: missing or malformed ids are field errors; only published products can be added", async () => {
    const customerId = await make.customer();
    const who = { customerId, cartToken: null };
    expect(await failure(() => toggleWishlist(t.db, who, "", NOW))).toMatchObject({ code: "invalid", fields: { productId: "required" } });
    expect(await failure(() => toggleWishlist(t.db, who, "prd bad id", NOW))).toMatchObject({ code: "invalid", fields: { productId: "invalid" } });
    expect(await failure(() => setWished(t.db, who, "prd_does_not_exist", true, NOW))).toMatchObject({ code: "not_found", status: 404 });
    const { productId } = await make.product();
    await t.db.update(products).set({ status: "draft" }).where(eq(products.id, productId));
    expect(await failure(() => setWished(t.db, who, productId, true, NOW))).toMatchObject({ code: "not_found" });
    // Taking an unpublished product off the list still works.
    expect(await setWished(t.db, who, productId, false, NOW)).toMatchObject({ wished: false });
  });

  test(`the list holds at most ${WISHLIST_LIMIT} products`, async () => {
    const customerId = await make.customer();
    const ids = await manyProducts(WISHLIST_LIMIT + 1);
    const wishRows = ids.slice(0, WISHLIST_LIMIT).map((productId, index) => ({ id: newId("wsh"), customerId, cartTokenHash: null, productId, createdAt: NOW + index }));
    await runBatch(t.db, chunkRows(wishlistItems, wishRows).map((chunk) => t.db.insert(wishlistItems).values(chunk)));
    const who = { customerId, cartToken: null };
    expect(await failure(() => setWished(t.db, who, ids[WISHLIST_LIMIT], true, NOW))).toMatchObject({ code: "wishlist_full", status: 409 });
    // A product already on the list is not refused; room frees up after a removal.
    expect(await setWished(t.db, who, ids[0], true, NOW)).toMatchObject({ wished: true, count: WISHLIST_LIMIT });
    await setWished(t.db, who, ids[0], false, NOW);
    expect(await setWished(t.db, who, ids[WISHLIST_LIMIT], true, NOW)).toMatchObject({ wished: true, count: WISHLIST_LIMIT });
  });

  test("owners never see each other's favourites", async () => {
    const [one, two] = [await make.customer(), await make.customer()];
    const token = randomToken();
    const { productId } = await make.product();
    await setWished(t.db, { customerId: one, cartToken: null }, productId, true, NOW);
    expect(await getWishlistIds(t.db, { customerId: two, cartToken: null })).toEqual([]);
    expect(await getWishlistIds(t.db, guest(token))).toEqual([]);
    // A signed-in customer is never answered from a cart token, even one that holds guest rows.
    await setWished(t.db, guest(token), productId, true, NOW);
    expect(await getWishlistIds(t.db, { customerId: two, cartToken: token })).toEqual([]);
  });
});

describe("sign-in merge", () => {
  test("guest rows under the cart and the bridge token join the account once each; the guest rows are gone", async () => {
    const customerId = await make.customer();
    const cart = randomToken();
    const bridge = randomToken();
    const [a, b, c] = await Promise.all([make.product(), make.product(), make.product()]);
    await setWished(t.db, { customerId, cartToken: null }, a.productId, true, NOW);
    await setWished(t.db, guest(cart), a.productId, true, NOW + 1);
    await setWished(t.db, guest(cart), b.productId, true, NOW + 2);
    await setWished(t.db, guest(null, bridge), b.productId, true, NOW + 3);
    await setWished(t.db, guest(null, bridge), c.productId, true, NOW + 4);

    expect(await mergeGuestWishlist(t.db, { customerId, cartToken: cart, wishToken: bridge }, NOW + 5)).toEqual({ moved: 2 });
    expect(new Set(await getWishlistIds(t.db, { customerId, cartToken: null }))).toEqual(new Set([a.productId, b.productId, c.productId]));
    expect(await getWishlistIds(t.db, guest(cart, bridge))).toEqual([]);
    const leftovers = await t.db
      .select({ n: sql<number>`count(*)` })
      .from(wishlistItems)
      .where(sql`${wishlistItems.cartTokenHash} IN (${await sha256Hex(cart)}, ${await sha256Hex(bridge)})`)
      .get();
    expect(Number(leftovers?.n)).toBe(0);
    // Nothing to merge: a no-op.
    expect(await mergeGuestWishlist(t.db, { customerId, cartToken: null, wishToken: null }, NOW)).toEqual({ moved: 0 });
  });
});

describe("the wishlist page read", () => {
  test("cards come from the catalogue read layer; products no longer sold are counted, not shown", async () => {
    const customerId = await make.customer();
    const who = { customerId, cartToken: null };
    const [shown, gone] = await Promise.all([make.product({ stock: 2, priceIqd: 120_000 }), make.product({ stock: 1 })]);
    await setWished(t.db, who, shown.productId, true, NOW);
    await setWished(t.db, who, gone.productId, true, NOW + 1);
    await t.db.update(products).set({ status: "archived" }).where(eq(products.id, gone.productId));
    const page = await listWishlist(t.db, who, "en", NOW);
    expect(page.ids).toEqual([gone.productId, shown.productId]);
    expect(page.unavailable).toBe(1);
    expect(page.items.map((card) => card.id)).toEqual([shown.productId]);
    expect(page.items[0]).toMatchObject({ priceIqd: 120_000, name: "Test console" });
  });
});

// ───────────────────────────────────────────────────────────────── the resource route

const SITE = "http://localhost:5173";

type Jar = Record<string, string>;
const cookieHeader = (jar: Jar) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

/** Runs the route behind the real root middleware (request context, CSRF check, queued cookies). */
async function call(kind: "loader" | "action", init: { method?: string; body?: Record<string, string>; cookies?: Jar; origin?: string | null }) {
  const headers: Record<string, string> = { "CF-Connecting-IP": `203.0.113.${Math.floor(Math.random() * 200) + 1}` };
  if (init.cookies && Object.keys(init.cookies).length) headers.Cookie = cookieHeader(init.cookies);
  if (init.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (init.origin !== null && (init.method ?? "GET") !== "GET") headers.Origin = init.origin ?? SITE;
  const request = new Request(`${SITE}/api/wishlist`, { method: init.method ?? "GET", headers, body: init.body ? new URLSearchParams(init.body) : undefined });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  try {
    const response = (await requestContextMiddleware({ request, context, url, pattern: "/api/wishlist", params: {} } as never, async () => {
      const handler = kind === "loader" ? wishlistLoader : wishlistAction;
      const result = (await handler({ request, context, params: {}, url, pattern: "/api/wishlist" } as never)) as { type?: string; data: unknown; init?: ResponseInit | null };
      const headers = new Headers(result.init?.headers);
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(result.data), { status: result.init?.status ?? 200, headers });
    })) as Response;
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, setCookies: response.headers.getSetCookie() };
  } catch (thrown) {
    const value = thrown as { init?: { status?: number }; data?: unknown };
    return { status: value.init?.status ?? 500, json: (value.data ?? {}) as Record<string, unknown>, setCookies: [] as string[] };
  }
}

describe("POST /api/wishlist", () => {
  test("a guest's toggle answers { ok, wished } and sets the bridge cookie; the next toggle with it takes the product off", async () => {
    const { productId } = await make.product();
    const first = await call("action", { method: "POST", body: { intent: "toggle", productId } });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, wished: true, count: 1 });
    const cookie = first.setCookies.find((value) => value.startsWith("tt_wish="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = decodeURIComponent(cookie!.split(";")[0].slice("tt_wish=".length));

    const listed = await call("loader", { cookies: { tt_wish: token } });
    expect(listed.json).toEqual({ ok: true, ids: [productId] });

    const second = await call("action", { method: "POST", body: { intent: "toggle", productId }, cookies: { tt_wish: token } });
    expect(second.json).toMatchObject({ ok: true, wished: false, count: 0 });
    expect(second.setCookies.find((value) => value.startsWith("tt_wish="))).toBeUndefined();
  });

  test("explicit add / remove, field errors, unknown products, unknown intents", async () => {
    const { productId } = await make.product();
    const cart = randomToken();
    expect((await call("action", { method: "POST", body: { intent: "add", productId }, cookies: { tt_cart: cart } })).json).toMatchObject({ ok: true, wished: true });
    expect((await call("action", { method: "POST", body: { intent: "add", productId }, cookies: { tt_cart: cart } })).json).toMatchObject({ ok: true, wished: true, count: 1 });
    expect((await call("action", { method: "POST", body: { intent: "remove", productId }, cookies: { tt_cart: cart } })).json).toMatchObject({ ok: true, wished: false });
    const missing = await call("action", { method: "POST", body: { intent: "toggle" } });
    expect(missing).toMatchObject({ status: 400, json: { ok: false, code: "invalid", fields: { productId: "required" } } });
    expect(await call("action", { method: "POST", body: { intent: "add", productId: "prd_nope" } })).toMatchObject({ status: 404, json: { ok: false, code: "not_found" } });
    expect(await call("action", { method: "POST", body: { intent: "explode", productId } })).toMatchObject({ status: 400, json: { ok: false, code: "invalid" } });
  });

  test("cross-site posts are refused before anything is written", async () => {
    const { productId } = await make.product();
    const outcome = await call("action", { method: "POST", body: { intent: "toggle", productId }, origin: "https://evil.example" });
    expect(outcome.status).toBe(403);
    expect(await rows(eq(wishlistItems.productId, productId))).toHaveLength(0);
  });

  test("wishlistWho reads both cookies and ignores malformed ones", () => {
    const good = randomToken();
    const jar: Record<string, string> = { tt_cart: good, tt_wish: "x" };
    expect(wishlistWho((name) => jar[name] ?? null, null)).toEqual({ customerId: null, cartToken: good, wishToken: null });
    expect(wishlistWho(() => null, "cus_1")).toEqual({ customerId: "cus_1", cartToken: null, wishToken: null });
  });
});
