/**
 * /api/cart — the cart as JSON, for fetchers (`useFetcher().load` / `.submit`) and scripts.
 *
 *   GET  /api/cart[?locale=en&governorateId=gov_basra]        → 200 { ok: true, cart: CartView }
 *   POST /api/cart                                            → 200 { ok: true, cart: CartView }
 *        intent=add     variantId=… | usedUnitId=…  [qty=1]     (+ "added": units that went in)
 *        intent=set     lineId=…  qty=0–10                       (0 removes the line)
 *        intent=remove  lineId=…
 *        intent=coupon  code=DEMO10                              (empty code removes the coupon)
 *        intent=price                                            changes nothing: the cart priced with the choices
 *                                                                below — how the checkout asks about a referral code,
 *                                                                in a body, never in a URL (security review 2026-11-12)
 *        every intent also takes  locale=ar|en|ckb  and  governorateId=…  for the returned view
 *   GET and POST also take (since 2026-11-12) the checkout's choices, priced for this answer only and never stored:
 *        points=1500        signed-in customers: points to redeem (the view says how many may be: `points.max`)
 *        referral=ABCD2345  a referral code to check (the view's `referral`: ok, or why it cannot count) —
 *                           every request asking about one, GET or POST, counts against ONE per-IP budget
 *                           (REFERRAL_CHECKS, 20 a minute: codes are not to be guessed — security review 2026-11-12);
 *                           send it in a POST (intent=price) — a GET puts it in the URL, which logs keep
 *   POST only (QA 2026-11-12), any intent:
 *        phone=0770 111 2233  the number typed at checkout (step 1): the answer is priced for it — a once-per-customer
 *                           code that number used comes back with `couponIssue` "customer_limit" and no discount, a
 *                           first-order code and flash limits count it — so the review shows the total the order will
 *                           charge. A referral code is still said without it (the order checks it). Never read from a
 *                           URL. Not an Iraqi mobile number → priced as without one. Such an answer says what a number
 *                           has used, so numbers are counted per address (PHONE_PRICING_PER_IP, 20 per 10 minutes);
 *                           past that the answer is priced as without a number (the order still checks it)
 *
 * `cart` is CartViewData from ~/server/services/cart.server: the CartView of ~/lib/dto plus
 * `couponIssue` (why a stored coupon does not apply right now) and `payableCount` (the units the totals are for: a
 * sold-out line stays in `count` and out of the money).
 *
 * Failures are `{ ok: false, code, fields? }` (ActionFail): 400 `invalid` with field error keys,
 * 404 `not_found` (a line or item that does not exist), 409 with a business code (`out_of_stock`,
 * `insufficient_stock`, `unavailable`, `max_qty_reached`, `cart_full`, `coupon_<reason>`), 429
 * `rate_limited` with Retry-After. Codes are error KEYS (`errors.<code>`), translated by the client.
 * A code below its minimum (409 `coupon_min_subtotal`, client round 1 wave C) also carries `minimumIqd` and `moreIqd`
 * — the minimum and how much more the cart needs, whole dinars, as the core counts them — so the page can say
 * «أضف منتجات بقيمة …» without asking again; a stored code below its minimum says the same in `cart.couponIssue`.
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
import { normalizeIraqPhone } from "~/lib/phone";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx, serializeCookie, type RequestCtx } from "~/server/context.server";
import { getDb, type Db } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { enforceRateLimit, limitKey, rateLimit, type RateLimitRule } from "~/server/ratelimit.server";
import { CART_COOKIE } from "~/server/shell.server";
import { CART_COOKIE_MAX_AGE_SEC, MAX_LINE_QTY, PHONE_PRICING_PER_IP, addToCart, changeCoupon, changeLineQty, couponMinimumGapOf, deleteLine, getCartView, isCartToken, type CartChangeResult, type CartRequest } from "~/server/services/cart.server";

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
  points: z.preprocess(blank, integer(0, 10_000_000).optional()),
  referral: z.preprocess(blank, z.string().trim().max(40, "too_long").optional()),
  /** The number typed at checkout (a body field only — the GET never reads one). */
  phone: z.preprocess(blank, z.string().trim().max(40, "too_long").optional()),
};

/** Referral codes asked about per IP per minute (GET): enough for a person typing one, too few to guess codes. */
const REFERRAL_CHECKS: RateLimitRule = { limit: 20, windowSec: 60 };

/** `points=` as a whole number, or none. */
const pointsParam = (value: string | null): number | null => (value && /^\d{1,8}$/.test(value) ? Number(value) : null);

const CartIntent = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("add"), variantId: optionalId, usedUnitId: optionalId, qty: z.preprocess(blank, integer(1, MAX_LINE_QTY).optional()), ...common }),
  z.object({ intent: z.literal("set"), lineId: z.preprocess(blank, id), qty: integer(0, MAX_LINE_QTY), ...common }),
  z.object({ intent: z.literal("remove"), lineId: z.preprocess(blank, id), ...common }),
  z.object({ intent: z.literal("coupon"), code: z.preprocess(blank, z.string().trim().max(64, "too_long").optional()), ...common }),
  z.object({ intent: z.literal("price"), ...common }),
]);

function cartToken(ctx: RequestCtx): string | null {
  const value = ctx.cookie(CART_COOKIE);
  return isCartToken(value) ? value : null;
}

/**
 * The number typed at checkout, normalised, when it is an Iraqi mobile number and this address may ask about one more
 * (PHONE_PRICING_PER_IP); null otherwise — the answer is then priced as without a number, and the order still checks it.
 * Only a usable number is counted.
 */
async function pricedPhone(db: Db, ctx: RequestCtx, typed: string | undefined): Promise<string | null> {
  const phone = normalizeIraqPhone(typed);
  if (!phone) return null;
  const verdict = await rateLimit(db, await limitKey("cart-phone", "ip", ctx.ip), PHONE_PRICING_PER_IP, ctx.now);
  return verdict.ok ? phone : null;
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
  const referral = (url.searchParams.get("referral") ?? "").trim().slice(0, 40);
  if (referral) {
    try {
      await enforceRateLimit(db, await limitKey("cart-referral", "ip", ctx.ip), REFERRAL_CHECKS, ctx.now);
    } catch (error) {
      const { status, retryAfterSec, ...failure } = actionError(error);
      return data({ ...failure, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers: retryAfterSec === undefined ? NO_STORE : { ...NO_STORE, "Retry-After": String(retryAfterSec) } });
    }
  }
  const customer = await getCustomer(ctx, db);
  const cart = await getCartView(
    db,
    {
      cartToken: cartToken(ctx),
      customerId: customer?.customer.id ?? null,
      locale: isLocale(locale) ? locale : ctx.locale,
      governorateId: governorateId && ID.test(governorateId) ? governorateId : null,
      redeemPoints: pointsParam(url.searchParams.get("points")),
      referralCode: referral || null,
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
    // A referral code asked about here is a check like the GET's, on the SAME per-address budget (security review
    // 2026-11-12: any intent with `referral=` checked a code uncounted — a second door, three times as wide, for
    // guessing codes). A change without a code never meets this budget.
    if (body.referral) await enforceRateLimit(db, await limitKey("cart-referral", "ip", ctx.ip), REFERRAL_CHECKS, ctx.now);
    const token = cartToken(ctx);
    if (token) await enforceRateLimit(db, await limitKey("cart", "cart", token), CART_CHANGES, ctx.now);
    const customer = await getCustomer(ctx, db);
    // The number typed at checkout (QA 2026-11-12): the review is priced as the order will be — a once-per-customer code
    // that number used no longer shows a discount «أكّد الطلب» then refuses. Budgeted per address (pricedPhone).
    const phoneE164 = await pricedPhone(db, ctx, body.phone);
    const cartRequest: CartRequest = { cartToken: token, customerId: customer?.customer.id ?? null, locale: body.locale ?? ctx.locale, governorateId: body.governorateId ?? null, redeemPoints: body.points ?? null, referralCode: body.referral ?? null, phoneE164 };

    // the checkout's pricing with the choices in a body (a referral code never goes into a URL): reads, changes nothing
    if (body.intent === "price") return data({ ok: true as const, cart: await getCartView(db, cartRequest, ctx.now) }, { headers: NO_STORE });

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
    // a code below its minimum: the minimum and how much more the cart needs, beside the code (no second request)
    const gap = couponMinimumGapOf(error);
    return data({ ...failure, ...(gap ?? {}), ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
  }
}
