/**
 * /api/wishlist — favourites as JSON (account area; docs/CONTRACTS.md §3). `~/ui/WishlistKey` calls the POST.
 *
 *   GET  /api/wishlist                                   → 200 { ok: true, ids: string[] }           (newest first)
 *   POST /api/wishlist  intent=toggle  productId=…       → 200 { ok: true, wished: boolean, count }
 *                       intent=add | remove  productId=… → the same, idempotent (undo, explicit choices)
 *
 * Failures are `{ ok: false, code, fields? }`: 400 `invalid` (fields.productId: required | invalid), 404 `not_found`
 * (no such published product — adding only), 409 `wishlist_full`, 429 `rate_limited` (Retry-After), 405 for other
 * methods. Codes are error KEYS, translated by the client.
 *
 * Who: the signed-in customer, else the guest behind the cart cookie (`tt_cart`) or the favourites bridge cookie
 * (`tt_wish`, set here for a guest who has neither) — see ~/server/services/wishlist.server. The body may be form data
 * or JSON. Cross-site posts are refused by the root middleware; changes are rate-limited per IP.
 */
import { data } from "react-router";
import type { Route } from "./+types/wishlist";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx, serializeCookie } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, invalid } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { getWishlistIds, setWished, toggleWishlist, WISH_COOKIE, WISH_COOKIE_MAX_AGE_SEC, wishlistWho } from "~/server/services/wishlist.server";

/** Toggles per IP per minute: generous for people, tight for scripts. */
const WISHLIST_CHANGES: RateLimitRule = { limit: 60, windowSec: 60 };
const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

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
    // An unreadable body is an empty one: validation then says what is missing.
    return {};
  }
}

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const ids = await getWishlistIds(db, wishlistWho(ctx.cookie, session?.customer.id ?? null));
  return data({ ok: true as const, ids }, { headers: NO_STORE });
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  if (request.method !== "POST") return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "GET, POST" } });
  const db = getDb();
  try {
    await enforceRateLimit(db, await limitKey("wishlist", "ip", ctx.ip), WISHLIST_CHANGES, ctx.now);
    const body = await readBody(request);
    const intent = typeof body.intent === "string" ? body.intent : "toggle";
    if (intent !== "toggle" && intent !== "add" && intent !== "remove") throw invalid({ intent: "invalid" });
    const session = await getCustomer(ctx, db);
    const who = wishlistWho(ctx.cookie, session?.customer.id ?? null);
    const change = intent === "toggle" ? await toggleWishlist(db, who, body.productId, ctx.now) : await setWished(db, who, body.productId, intent === "add", ctx.now);
    // A guest's favourites stay findable from this device: the bridge cookie remembers which token keys them.
    if (!session && change.guestToken && change.guestToken !== ctx.cookie(WISH_COOKIE)) {
      ctx.setCookie(serializeCookie(ctx, WISH_COOKIE, change.guestToken, { maxAge: WISH_COOKIE_MAX_AGE_SEC, httpOnly: true, sameSite: "Lax" }));
    }
    return data({ ok: true as const, wished: change.wished, count: change.count }, { headers: NO_STORE });
  } catch (error) {
    const { status, retryAfterSec, ...failure } = actionError(error);
    const headers = new Headers(NO_STORE);
    if (retryAfterSec !== undefined) headers.set("Retry-After", String(retryAfterSec));
    return data({ ...failure, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
  }
}
