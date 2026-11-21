/**
 * Commerce — several variants in ONE cart change: addManyToCart (cart.server.ts) and POST /api/cart intent=add_many
 * (the Switch bundle builder's «أضف الكل إلى السلة», docs/switch-builder.md §5).
 *
 *   · all or nothing: one item that cannot go in whole refuses the bundle (409 bundle_refused) with a problem per item,
 *     and nothing is written — no cart created, no line touched, no token re-keyed;
 *   · items for the same variant are merged; what the cart already holds counts against the stock and the line limit;
 *   · a guest without a cart gets ONE cart (one cookie), lines in the order asked;
 *   · new lines must fit beside the cart's lines (cart_full);
 *   · prices come from the server only (a running flash sale's price is what each line remembers);
 *   · the route: a JSON `items` field (form or JSON body), one rate-limit tick, the cookie set once, `problems` in the
 *     409 answer, and 50 items fit the 8 KB body limit;
 *   · the browser side (cart-client addManyToCart): one POST intent=add_many, the new cart published to onCartChange,
 *     the problems of a refusal read back, and it never throws.
 *
 * Real local D1 (tests/helpers/db.ts); the route runs through the real request-context middleware.
 */
import { and, eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { newId } from "~/lib/ids";
import { action as cartAction } from "~/routes/api/cart";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { cartItems, carts, flashSaleItems, flashSales, products, stockLevels, variants } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { limitKey } from "~/server/ratelimit.server";
import {
  AddManyRefusal,
  CART_ERROR_KEYS,
  MAX_ADD_MANY_ITEMS,
  MAX_CART_LINES,
  addManyProblemsOf,
  addManyToCart,
  addToCart,
  emptyCartView,
  getCartView,
  isCartToken,
  type CartViewData,
} from "~/server/services/cart.server";
import { CART_COOKIE, loadShellData } from "~/server/shell.server";
import { addManyToCart as addManyFromBrowser, onCartChange } from "~/ui/cart-client";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures, type ProductFixture } from "./helpers/factories";

const SITE = "http://localhost:5173";
const MINUTE = 60_000;
/** The route reads the clock (ctx.now = Date.now()); service calls use the same "now". */
const NOW = Date.now();

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t?.dispose();
});

const guest = (cartToken: string | null = null) => ({ cartToken, customerId: null, locale: "en" as const });

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

async function cartCount(): Promise<number> {
  const row = await t.db.select({ n: sql<number>`count(*)` }).from(carts).get();
  return Number(row?.n ?? 0);
}

async function linesOf(cartId: string) {
  return t.db.select({ id: cartItems.id, variantId: cartItems.variantId, qty: cartItems.qty, snapshot: cartItems.priceSnapshotIqd, addedAt: cartItems.addedAt }).from(cartItems).where(eq(cartItems.cartId, cartId));
}

const qtyOf = (view: CartViewData, variantId: string) => view.lines.find((line) => line.variantId === variantId)?.qty;

/** A minimal request context for the shell loader (cookies only). */
function shellCtx(cookies: Record<string, string>): RequestCtx {
  return { cookie: (name: string) => cookies[name] ?? null, setCookie: () => {}, now: NOW, isDev: true, locale: "ar", ip: null, userAgent: "", requestId: "test" } as unknown as RequestCtx;
}

async function manyProducts(count: number, options: Parameters<Fixtures["product"]>[0] = {}): Promise<ProductFixture[]> {
  const out: ProductFixture[] = [];
  for (let i = 0; i < count; i++) out.push(await make.product({ stock: 5, priceIqd: 10_000, ...options }));
  return out;
}

// ───────────────────────────────────────────────────────────────── the service

describe("addManyToCart — all of the items or none", () => {
  test("a guest without a cart gets ONE cart: every line goes in, in the order asked, and the shell counts it by the cookie", async () => {
    const console1 = await make.product({ priceIqd: 585_000, stock: 1 });
    const card = await make.product({ kind: "storage", priceIqd: 175_000, stock: 2 });
    const game = await make.product({ kind: "game", priceIqd: 70_000, stock: 3 });
    const before = await cartCount();

    const result = await addManyToCart(t.db, guest(), { items: [{ variantId: console1.variantId, qty: 1 }, { variantId: card.variantId, qty: 1 }, { variantId: game.variantId, qty: 2 }] }, NOW);

    expect(await cartCount()).toBe(before + 1);
    expect(isCartToken(result.cartToken)).toBe(true);
    expect(result.added).toBe(4);
    expect(result.view).toMatchObject({ count: 4, payableCount: 4, subtotalIqd: 585_000 + 175_000 + 140_000, blocked: false });
    expect(result.view.lines.map((line) => [line.variantId, line.qty, line.problem])).toEqual([
      [console1.variantId, 1, null],
      [card.variantId, 1, null],
      [game.variantId, 2, null],
    ]);
    expect((await loadShellData(shellCtx({ [CART_COOKIE]: result.cartToken }), t.db)).cart).toEqual({ count: 4 });
  });

  test("items of the same variant are merged, and quantities already in the cart add up (same cart, same token)", async () => {
    const a = await make.product({ priceIqd: 20_000, stock: 6 });
    const b = await make.product({ priceIqd: 5_000, stock: 6 });
    const first = await addToCart(t.db, guest(), { variantId: a.variantId, qty: 2 }, NOW);

    const result = await addManyToCart(t.db, guest(first.cartToken), { items: [{ variantId: a.variantId, qty: 1 }, { variantId: b.variantId, qty: 1 }, { variantId: a.variantId, qty: 2 }] }, NOW);

    expect(result.cartToken).toBe(first.cartToken);
    expect(result.view.id).toBe(first.view.id);
    expect(result.added).toBe(4);
    expect(qtyOf(result.view, a.variantId)).toBe(5);
    expect(qtyOf(result.view, b.variantId)).toBe(1);
    // one row per variant: the merged item updated the existing line
    expect((await linesOf(first.view.id as string)).map((line) => [line.variantId, line.qty])).toEqual([
      [a.variantId, 5],
      [b.variantId, 1],
    ]);
  });

  test("a sold-out item refuses the whole bundle: one problem per item that cannot go in, and nothing is written", async () => {
    const kept = await make.product({ priceIqd: 40_000, stock: 4 });
    const fine = await make.product({ priceIqd: 15_000, stock: 4 });
    const soldOut = await make.product({ priceIqd: 30_000, stock: 0 });
    const archived = await make.product({ priceIqd: 30_000, stock: 4 });
    const switchedOff = await make.product({ priceIqd: 30_000, stock: 4 });
    await t.db.update(products).set({ status: "archived" }).where(eq(products.id, archived.productId));
    await t.db.update(variants).set({ isActive: false }).where(eq(variants.id, switchedOff.variantId));
    const existing = await addToCart(t.db, guest(), { variantId: kept.variantId, qty: 1 }, NOW);
    const cartId = existing.view.id as string;
    const cartBefore = await t.db.select().from(carts).where(eq(carts.id, cartId)).get();
    const linesBefore = await linesOf(cartId);
    const before = await cartCount();

    const items = [
      { variantId: fine.variantId, qty: 1 },
      { variantId: soldOut.variantId, qty: 1 },
      { variantId: "var_does_not_exist", qty: 1 },
      { variantId: kept.variantId, qty: 1 },
      { variantId: archived.variantId, qty: 1 },
      { variantId: switchedOff.variantId, qty: 2 },
    ];
    const refusal = await failureOf(addManyToCart(t.db, guest(existing.cartToken), { items }, NOW + MINUTE));
    expect(refusal).toBeInstanceOf(AddManyRefusal);
    expect(refusal).toMatchObject({ code: "bundle_refused", status: 409 });
    expect(addManyProblemsOf(refusal)).toEqual([
      { variantId: soldOut.variantId, code: "out_of_stock" },
      { variantId: "var_does_not_exist", code: "not_found" },
      { variantId: archived.variantId, code: "unavailable" },
      { variantId: switchedOff.variantId, code: "unavailable" },
    ]);
    // nothing changed: the cart row (not even updated_at), its lines, no new cart
    expect(await t.db.select().from(carts).where(eq(carts.id, cartId)).get()).toEqual(cartBefore);
    expect(await linesOf(cartId)).toEqual(linesBefore);
    expect(await cartCount()).toBe(before);

    // a guest without a cart: a refusal creates none
    expect((await failureOf(addManyToCart(t.db, guest(), { items: [{ variantId: fine.variantId, qty: 1 }, { variantId: soldOut.variantId, qty: 1 }] }, NOW))).code).toBe("bundle_refused");
    expect(await cartCount()).toBe(before);
    // the error key the route answers with has its sentence (tests/commerce-money.test.ts checks every key's text)
    expect(CART_ERROR_KEYS).toContain("bundle_refused");
  });

  test("free units count what the cart already holds (insufficient_stock), and a line never passes 10 (max_qty_reached)", async () => {
    const scarce = await make.product({ priceIqd: 70_000, stock: 3 });
    const plenty = await make.product({ priceIqd: 1_000, stock: 40 });
    const inCart = await addToCart(t.db, guest(), { variantId: scarce.variantId, qty: 2 }, NOW);
    await addToCart(t.db, guest(inCart.cartToken), { variantId: plenty.variantId, qty: 9 }, NOW);

    // 2 held + 2 asked > 3 free
    const short = await failureOf(addManyToCart(t.db, guest(inCart.cartToken), { items: [{ variantId: scarce.variantId, qty: 2 }] }, NOW));
    expect(addManyProblemsOf(short)).toEqual([{ variantId: scarce.variantId, code: "insufficient_stock" }]);
    // 9 held + 2 asked > 10 a line
    const capped = await failureOf(addManyToCart(t.db, guest(inCart.cartToken), { items: [{ variantId: plenty.variantId, qty: 2 }] }, NOW));
    expect(addManyProblemsOf(capped)).toEqual([{ variantId: plenty.variantId, code: "max_qty_reached" }]);
    // merged items count as one line too: 6 + 6 of a new variant
    const fresh = await make.product({ priceIqd: 1_000, stock: 40 });
    const merged = await failureOf(addManyToCart(t.db, guest(inCart.cartToken), { items: [{ variantId: fresh.variantId, qty: 6 }, { variantId: fresh.variantId, qty: 6 }] }, NOW));
    expect(addManyProblemsOf(merged)).toEqual([{ variantId: fresh.variantId, code: "max_qty_reached" }]);
    // still as it was; exactly what fits goes in
    const view = await getCartView(t.db, guest(inCart.cartToken), NOW);
    expect([qtyOf(view, scarce.variantId), qtyOf(view, plenty.variantId), qtyOf(view, fresh.variantId)]).toEqual([2, 9, undefined]);
    const fits = await addManyToCart(t.db, guest(inCart.cartToken), { items: [{ variantId: scarce.variantId, qty: 1 }, { variantId: plenty.variantId, qty: 1 }] }, NOW);
    expect([qtyOf(fits.view, scarce.variantId), qtyOf(fits.view, plenty.variantId)]).toEqual([3, 10]);
  });

  test("cart_full: new lines must fit beside the cart's lines; adding to lines already there needs no room", async () => {
    const filler = await manyProducts(MAX_CART_LINES - 2);
    const start = await addManyToCart(t.db, guest(), { items: filler.map((product) => ({ variantId: product.variantId, qty: 1 })) }, NOW);
    expect(start.view.lines).toHaveLength(MAX_CART_LINES - 2);
    const [n1, n2, n3] = await manyProducts(3);
    const token = start.cartToken;

    // 48 + 2 new = 50: fits
    const full = await addManyToCart(t.db, guest(token), { items: [{ variantId: filler[0].variantId, qty: 1 }, { variantId: n1.variantId, qty: 1 }, { variantId: n2.variantId, qty: 1 }] }, NOW);
    expect(full.view.lines).toHaveLength(MAX_CART_LINES);
    // 50 + 1 new: refused for the new one, and the item for an existing line is not blamed
    const refused = await failureOf(addManyToCart(t.db, guest(token), { items: [{ variantId: filler[1].variantId, qty: 1 }, { variantId: n3.variantId, qty: 1 }] }, NOW));
    expect(addManyProblemsOf(refused)).toEqual([{ variantId: n3.variantId, code: "cart_full" }]);
    expect(qtyOf(await getCartView(t.db, guest(token), NOW), filler[1].variantId)).toBe(1);
    // only existing lines: fine
    const more = await addManyToCart(t.db, guest(token), { items: [{ variantId: filler[1].variantId, qty: 1 }] }, NOW);
    expect(qtyOf(more.view, filler[1].variantId)).toBe(2);
  });

  test("prices come from the server only: fields the browser adds are ignored, and a running flash sale's price is what each line remembers", async () => {
    const onSale = await make.product({ priceIqd: 80_000, stock: 5 });
    const regular = await make.product({ priceIqd: 30_000, stock: 5 });
    const saleId = newId("fls");
    await t.db.insert(flashSales).values({ id: saleId, slug: `sale-${saleId.toLowerCase()}`, name: { ar: "عرض سريع", en: "Flash sale" }, startsAt: NOW - 60 * MINUTE, endsAt: NOW + 60 * MINUTE, status: "scheduled", isDemo: false, createdAt: NOW - 120 * MINUTE });
    await t.db.insert(flashSaleItems).values({ id: newId("fli"), flashSaleId: saleId, variantId: onSale.variantId, salePriceIqd: 70_000, qtyLimit: null, qtySold: 0 });

    const result = await addManyToCart(
      t.db,
      guest(),
      { items: [{ variantId: onSale.variantId, qty: 1, priceIqd: 1, unitPriceIqd: 1 } as never, { variantId: regular.variantId, qty: 2, totalIqd: 0 } as never] },
      NOW,
    );
    const sale = result.view.lines.find((line) => line.variantId === onSale.variantId);
    expect(sale).toMatchObject({ unitPriceIqd: 70_000, problem: null, flash: { salePriceIqd: 70_000, regularPriceIqd: 80_000 } });
    expect(result.view.lines.find((line) => line.variantId === regular.variantId)).toMatchObject({ unitPriceIqd: 30_000, qty: 2, problem: null });
    expect(result.view.subtotalIqd).toBe(70_000 + 60_000);
    // what each line remembers is the price it was sold at (so it never says "price changed" by itself)
    const stored = await linesOf(result.view.id as string);
    expect(Object.fromEntries(stored.map((line) => [line.variantId, line.snapshot]))).toEqual({ [onSale.variantId]: 70_000, [regular.variantId]: 30_000 });
    expect((await getCartView(t.db, guest(result.cartToken), NOW)).lines.every((line) => line.problem === null)).toBe(true);
  });

  test("malformed input is refused (400 invalid) before anything is written", async () => {
    const p = await make.product({ stock: 5 });
    const before = await cartCount();
    const tooMany = Array.from({ length: MAX_ADD_MANY_ITEMS + 1 }, () => ({ variantId: p.variantId, qty: 1 }));
    for (const raw of [{}, { items: [] }, { items: "x" }, { items: [{ variantId: p.variantId, qty: 0 }] }, { items: [{ variantId: p.variantId, qty: 11 }] }, { items: [{ variantId: p.variantId, qty: 1.5 }] }, { items: [{ variantId: "not an id!", qty: 1 }] }, { items: tooMany }]) {
      const failure = await failureOf(addManyToCart(t.db, guest(), raw, NOW));
      expect(failure, JSON.stringify(raw).slice(0, 80)).toMatchObject({ code: "invalid", status: 400 });
    }
    expect(await cartCount()).toBe(before);
  });

  test("a signed-in customer's cart reached without the cookie is re-keyed once, like addToCart", async () => {
    const customerId = await make.customer();
    const p = await make.product({ priceIqd: 12_000, stock: 5 });
    const first = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: p.variantId, qty: 1 }, NOW);
    const again = await addManyToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { items: [{ variantId: p.variantId, qty: 1 }] }, NOW + MINUTE);
    expect(again.view.id).toBe(first.view.id);
    expect(again.cartToken).not.toBe(first.cartToken);
    expect(qtyOf(again.view, p.variantId)).toBe(2);
    // the new token is the cart's now
    expect((await getCartView(t.db, { cartToken: again.cartToken, customerId, locale: "ar" }, NOW)).id).toBe(first.view.id);
  });
});

// ───────────────────────────────────────────────────────────────── the route

let ipCounter = 0;
/** A fresh documentation-range IPv4 address, so per-IP limits never leak between tests. */
const freshIp = () => {
  ipCounter++;
  return `203.0.113.${(ipCounter % 250) + 1}`;
};

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

type Hit = { status: number; headers: Headers; body: Record<string, unknown> };

/** One POST /api/cart through the request-context middleware: form fields (what cart-client sends) or a JSON body. */
async function post(body: { form?: Record<string, string>; json?: unknown }, init: { cookies?: Record<string, string>; ip?: string } = {}): Promise<Hit> {
  const headers = new Headers({ "CF-Connecting-IP": init.ip ?? freshIp(), Origin: SITE });
  if (init.cookies) headers.set("Cookie", Object.entries(init.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
  let payload: BodyInit;
  if (body.json !== undefined) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body.json);
  } else payload = new URLSearchParams(body.form ?? {});
  const request = new Request(`${SITE}/api/cart`, { method: "POST", headers, body: payload });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let inner: unknown;
  const response = (await requestContextMiddleware({ request, context, url, pattern: "/api/cart", params: {} } as never, async () => {
    inner = await (cartAction as (args: unknown) => unknown)({ request, context, params: {}, url, pattern: "/api/cart" });
    return asResponse(inner).response;
  })) as Response;
  return { status: response.status, headers: response.headers, body: asResponse(inner).body as Record<string, unknown> };
}

const cartCookieOf = (headers: Headers): string | null => {
  const match = new RegExp(`(?:^|,\\s*)${CART_COOKIE}=([^;]+)`).exec(headers.get("Set-Cookie") ?? "");
  return match ? decodeURIComponent(match[1]) : null;
};

async function ticks(scope: "ip" | "cart", identifier: string): Promise<number> {
  const key = await limitKey("cart", scope, identifier);
  const rows = await t.db.all<{ n: number }>(sql`SELECT coalesce(sum(count), 0) AS n FROM rate_limits WHERE key = ${key}`);
  return Number(rows[0]?.n ?? 0);
}

describe("POST /api/cart intent=add_many", () => {
  test("200: the bundle goes in, the cookie is set once, `added` counts the units, and it is ONE change against the rate limit", async () => {
    const a = await make.product({ priceIqd: 550_000, stock: 1 });
    const b = await make.product({ priceIqd: 79_500, stock: 1 });
    const ip = freshIp();
    const answer = await post({ form: { intent: "add_many", items: JSON.stringify([{ variantId: a.variantId, qty: 1 }, { variantId: b.variantId, qty: 1 }]), locale: "en" } }, { ip });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, added: 2, cart: { count: 2, subtotalIqd: 629_500 } });
    const token = cartCookieOf(answer.headers);
    expect(isCartToken(token)).toBe(true);
    expect(await ticks("ip", ip)).toBe(1);

    // the next bundle carries the cookie: same cart, one tick for the address and one for the cart
    const c = await make.product({ priceIqd: 10_000, stock: 3 });
    const next = await post({ form: { intent: "add_many", items: JSON.stringify([{ variantId: c.variantId, qty: 3 }]) } }, { ip, cookies: { [CART_COOKIE]: token as string } });
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ ok: true, added: 3, cart: { count: 5 } });
    expect(await ticks("ip", ip)).toBe(2);
    expect(await ticks("cart", token as string)).toBe(1);
  });

  test("409 bundle_refused: every item's problem beside the code, nothing written, no cookie", async () => {
    const fine = await make.product({ priceIqd: 25_000, stock: 2 });
    const gone = await make.product({ priceIqd: 25_000, stock: 0 });
    const before = await cartCount();
    const answer = await post({ form: { intent: "add_many", items: JSON.stringify([{ variantId: fine.variantId, qty: 1 }, { variantId: gone.variantId, qty: 1 }]) } });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ ok: false, code: "bundle_refused", problems: [{ variantId: gone.variantId, code: "out_of_stock" }] });
    expect(answer.headers.get("Set-Cookie")).toBeNull();
    expect(await cartCount()).toBe(before);
  });

  test("400 invalid: items that are not JSON, empty, or too many", async () => {
    const p = await make.product({ stock: 5 });
    const tooMany = JSON.stringify(Array.from({ length: MAX_ADD_MANY_ITEMS + 1 }, () => ({ variantId: p.variantId, qty: 1 })));
    for (const items of ["not json", "[]", "{}", "", tooMany, JSON.stringify([{ variantId: p.variantId, qty: "x" }])]) {
      const answer = await post({ form: { intent: "add_many", items } });
      expect(answer.status, items.slice(0, 40)).toBe(400);
      expect(answer.body).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  test("a JSON body may carry the items as an array", async () => {
    const p = await make.product({ priceIqd: 9_000, stock: 4 });
    const answer = await post({ json: { intent: "add_many", items: [{ variantId: p.variantId, qty: 2 }] } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, added: 2, cart: { count: 2 } });
  });

  test("50 items fit the 8 KB body (form-encoded the way cart-client sends them), and all 50 go in", async () => {
    const fifty = await manyProducts(MAX_ADD_MANY_ITEMS, { priceIqd: 1_000, stock: 1 });
    const items = fifty.map((product) => ({ variantId: product.variantId, qty: 1 }));
    const form = { intent: "add_many", items: JSON.stringify(items), locale: "ckb" };
    expect(new TextEncoder().encode(new URLSearchParams(form).toString()).length).toBeLessThan(8 * 1024);
    // the catalogue's longest ids — "var_" + a 41-character SKU (catalog SKUs are at most 41 characters) — fit too
    const longest = JSON.stringify(Array.from({ length: MAX_ADD_MANY_ITEMS }, (_, i) => ({ variantId: `var_${"x".repeat(37)}${String(i).padStart(4, "0")}`, qty: 10 })));
    expect(new TextEncoder().encode(new URLSearchParams({ ...form, items: longest }).toString()).length).toBeLessThan(8 * 1024);

    const answer = await post({ form });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, added: 50, cart: { count: 50 } });
    const token = cartCookieOf(answer.headers) as string;
    expect((await loadShellData(shellCtx({ [CART_COOKIE]: token }), t.db)).cart).toEqual({ count: 50 });
    // the stock is not held by the cart (placeOrder reserves it)
    const level = await t.db.select({ reserved: stockLevels.reserved }).from(stockLevels).where(and(eq(stockLevels.variantId, fifty[0].variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
    expect(level?.reserved).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── the browser side (cart-client)

describe("cart-client addManyToCart — one request, the new cart published, never throws", () => {
  const sent: Array<{ url: string; fields: URLSearchParams }> = [];
  /** Every POST gets `answer` (a JSON body and its status), or fails like a dropped connection. */
  function stubFetch(answer: { status: number; body: unknown } | "network") {
    sent.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), fields: new URLSearchParams(String(init.body)) });
      if (answer === "network") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cart = { ...emptyCartView(), id: "crt_browser", count: 3 };

  test("200: ONE POST intent=add_many with the items as JSON, and the new cart reaches onCartChange", async () => {
    stubFetch({ status: 200, body: { ok: true, cart, added: 3 } });
    const seen: unknown[] = [];
    const stop = onCartChange((view) => seen.push(view));
    try {
      const outcome = await addManyFromBrowser({ items: [{ variantId: "var_a", qty: 1 }, { variantId: "var_b", qty: 2 }], locale: "en" });
      expect(outcome).toEqual({ ok: true, cart, added: 3 });
    } finally {
      stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/cart");
    expect(sent[0].fields.get("intent")).toBe("add_many");
    expect(sent[0].fields.get("locale")).toBe("en");
    expect(JSON.parse(sent[0].fields.get("items") ?? "null")).toEqual([{ variantId: "var_a", qty: 1 }, { variantId: "var_b", qty: 2 }]);
    expect(seen).toEqual([cart]);
  });

  test("409 bundle_refused: each item's problem comes back (malformed entries dropped), and nothing is published", async () => {
    const problems = [{ variantId: "var_b", code: "out_of_stock" }];
    stubFetch({ status: 409, body: { ok: false, code: "bundle_refused", problems: [...problems, { variantId: 7, code: "x" }, null] } });
    const seen: unknown[] = [];
    const stop = onCartChange((view) => seen.push(view));
    try {
      expect(await addManyFromBrowser({ items: [{ variantId: "var_a", qty: 1 }, { variantId: "var_b", qty: 1 }] })).toEqual({ ok: false, code: "bundle_refused", problems, status: 409 });
    } finally {
      stop();
    }
    expect(seen).toEqual([]);
  });

  test("never throws: a dropped connection, a listener that throws; an empty list sends nothing", async () => {
    stubFetch("network");
    await expect(addManyFromBrowser({ items: [{ variantId: "var_a", qty: 1 }] })).resolves.toEqual({ ok: false, code: "network", problems: [], status: 0 });

    stubFetch({ status: 200, body: { ok: true, cart, added: 1 } });
    const stop = onCartChange(() => {
      throw new Error("a broken view");
    });
    try {
      await expect(addManyFromBrowser({ items: [{ variantId: "var_a", qty: 1 }] })).resolves.toMatchObject({ ok: true, added: 1 });
    } finally {
      stop();
    }

    stubFetch({ status: 200, body: { ok: true, cart, added: 0 } });
    await expect(addManyFromBrowser({ items: [] })).resolves.toEqual({ ok: false, code: "invalid", problems: [], status: 0 });
    expect(sent).toHaveLength(0);
  });
});
