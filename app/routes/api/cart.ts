/**
 * /api/cart — the cart as JSON, for fetchers (`useFetcher().load` / `.submit`) and scripts.
 *
 *   GET  /api/cart[?locale=en&governorateId=gov_basra]        → 200 { ok: true, cart: CartView }
 *   POST /api/cart                                            → 200 { ok: true, cart: CartView }
 *        intent=add     variantId=… | usedUnitId=…  [qty=1]     (+ "added": units that went in)
 *        intent=set     lineId=…  qty=0–10                       (0 removes the line)
 *        intent=remove  lineId=…
 *        intent=coupon  code=DEMO10                              (empty code removes the coupon)
 *        every intent also takes  locale=ar|en|ckb  and  governorateId=…  for the returned view
 *
 * `cart` is CartViewData from ~/server/services/cart.server: the CartView of ~/lib/dto plus
 * `couponIssue` (why a stored coupon does not apply right now).
 *
 * Failures are `{ ok: false, code, fields? }` (ActionFail): 400 `invalid` with field error keys,
 * 404 `not_found` (a line or item that does not exist), 409 with a business code (`out_of_stock`,
 * `insufficient_stock`, `unavailable`, `max_qty_reached`, `cart_full`, `coupon_<reason>`), 429
 * `rate_limited` with Retry-After. Codes are error KEYS (`errors.<code>`), translated by the client.
 *
 * The body may be form data (what fetchers send) or JSON. Nothing the client sends is trusted for
 * money: prices, totals and the discount are computed on the server on every request. The cart
 * token lives only in the httpOnly `tt_cart` cookie, which every successful change (re)sets for 60
 * days. POSTs must carry a same-origin `Origin` header (CSRF check in the root middleware) and are
 * rate-limited per IP and per cart.
 */
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/cart";
import { LOCALE_CODES, isLocale, type Locale } from "~/lib/locales";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx, serializeCookie, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { CART_COOKIE } from "~/server/shell.server";
import { CART_COOKIE_MAX_AGE_SEC, MAX_LINE_QTY, addToCart, changeCoupon, changeLineQty, deleteLine, getCartView, isCartToken, type CartChangeResult, type CartRequest } from "~/server/services/cart.server";

/** Cart changes allowed per IP, and per cart, per minute. Generous for people, tight for scripts. */
const CART_CHANGES: RateLimitRule = { limit: 60, windowSec: 60 };
/** Bodies are a handful of short fields. */
const MAX_BODY_BYTES = 8 * 1024;

const NO_STORE = { "Cache-Control": "no-store" } as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Form fields arrive as strings; an empty field means "not given". */
const blank = (value: unknown) => (value === "" || value === null ? undefined : value);
const id = z.string().trim().regex(ID, "invalid");
const optionalId = z.preprocess(blank, id.optional());
const integer = (min: number, max: number) =>
  z.preprocess((value) => (typeof value === "string" ? (value.trim() === "" ? undefined : Number(value)) : blank(value)), z.number({ error: "required" }).int("invalid").min(min, "too_small").max(max, "too_big"));
const common = {
  locale: z.preprocess(blank, z.enum(LOCALE_CODES as [Locale, ...Locale[]]).optional()),
  governorateId: optionalId,
};

const CartIntent = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("add"), variantId: optionalId, usedUnitId: optionalId, qty: z.preprocess(blank, integer(1, MAX_LINE_QTY).optional()), ...common }),
  z.object({ intent: z.literal("set"), lineId: z.preprocess(blank, id), qty: integer(0, MAX_LINE_QTY), ...common }),
  z.object({ intent: z.literal("remove"), lineId: z.preprocess(blank, id), ...common }),
  z.object({ intent: z.literal("coupon"), code: z.preprocess(blank, z.string().trim().max(64, "too_long").optional()), ...common }),
]);

function cartToken(ctx: RequestCtx): string | null {
  const value = ctx.cookie(CART_COOKIE);
  return isCartToken(value) ? value : null;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return {};
  const type = request.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body: unknown = await request.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    }
    const form = await request.formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form) if (typeof value === "string" && !(key in out)) out[key] = value;
    return out;
  } catch {
    // An unreadable body is treated as an empty one: validation then says what is missing.
    return {};
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const url = new URL(request.url);
  const locale = url.searchParams.get("locale");
  const governorateId = url.searchParams.get("governorateId");
  const customer = await getCustomer(ctx, db);
  const cart = await getCartView(
    db,
    {
      cartToken: cartToken(ctx),
      customerId: customer?.customer.id ?? null,
      locale: isLocale(locale) ? locale : ctx.locale,
      governorateId: governorateId && ID.test(governorateId) ? governorateId : null,
    },
    ctx.now,
  );
  return data({ ok: true as const, cart }, { headers: NO_STORE });
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  if (request.method !== "POST") return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "GET, POST" } });
  const db = getDb();
  try {
    await enforceRateLimit(db, await limitKey("cart", "ip", ctx.ip), CART_CHANGES, ctx.now);
    const body = CartIntent.parse(await readBody(request));
    const token = cartToken(ctx);
    if (token) await enforceRateLimit(db, await limitKey("cart", "cart", token), CART_CHANGES, ctx.now);
    const customer = await getCustomer(ctx, db);
    const cartRequest: CartRequest = { cartToken: token, customerId: customer?.customer.id ?? null, locale: body.locale ?? ctx.locale, governorateId: body.governorateId ?? null };

    let result: CartChangeResult;
    let added: number | undefined;
    switch (body.intent) {
      case "add": {
        const outcome = await addToCart(db, cartRequest, { variantId: body.variantId, usedUnitId: body.usedUnitId, qty: body.qty ?? 1 }, ctx.now);
        result = outcome;
        added = outcome.added;
        break;
      }
      case "set":
        result = await changeLineQty(db, cartRequest, body.lineId, body.qty, ctx.now, { rekey: true });
        break;
      case "remove":
        result = await deleteLine(db, cartRequest, body.lineId, ctx.now, { rekey: true });
        break;
      case "coupon":
        result = await changeCoupon(db, cartRequest, body.code ?? null, ctx.now, { rekey: true });
        break;
    }
    if (result.cartToken) ctx.setCookie(serializeCookie(ctx, CART_COOKIE, result.cartToken, { maxAge: CART_COOKIE_MAX_AGE_SEC, httpOnly: true, sameSite: "Lax" }));
    return data({ ok: true as const, cart: result.view, ...(added === undefined ? {} : { added }) }, { headers: NO_STORE });
  } catch (error) {
    // Expected failures become { ok: false, code, fields }; anything else is a bug and goes to the error handler.
    const { status, retryAfterSec, ...failure } = actionError(error);
    const headers = new Headers(NO_STORE);
    if (retryAfterSec !== undefined) headers.set("Retry-After", String(retryAfterSec));
    return data({ ...failure, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
  }
}
