/**
 * Server helpers shared by the account routes (loaders and actions only — never imported by components).
 *
 *   const session = await requireSignedIn(request, ctx, db);      // or a redirect to /account/login?next=<this page>
 *   const failure = accountFailure(error, ctx.locale);            // { ok:false, code, message, fields } in the visitor's language
 *   setWishCookie(ctx, token);  setConsentCookie(ctx, true);  clearGuestCookies(ctx);
 *
 * Messages: an account error key is looked up in the "account" namespace first (`errors.<key>`), then in the shared
 * "errors" namespace, so `actionError` returns sentences, never keys.
 */
import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import { getNamespace } from "~/i18n/i18n.server";
import { translate, type TFunction } from "~/i18n/translate";
import { localePath, splitLocale, type Locale } from "~/lib/locales";
import { requireCustomer, safeNextPath, type CustomerSession, type OtpOptions } from "~/server/auth/customer.server";
import { pagePathname, serializeCookie, type RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db.server";
import { actionError, type ActionFailure } from "~/server/errors";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";
import { CONSENT_COOKIE, CONSENT_COOKIE_MAX_AGE_SEC } from "~/server/services/account/preferences.server";
import { afterSignIn } from "~/server/services/account/session.server";
import { CART_COOKIE_NAME, WISH_COOKIE, WISH_COOKIE_MAX_AGE_SEC } from "~/server/services/wishlist.server";

/** The locale-less path (and query) of the page a request is for — what `next` should bring the visitor back to. */
export function pageNext(request: Request): string {
  const url = new URL(request.url);
  const { path } = splitLocale(pagePathname(url.pathname));
  const search = new URLSearchParams(url.search);
  search.delete("_routes");
  search.delete("index");
  const query = search.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

/** The signed-in customer, or a redirect to the sign-in page that comes back here. */
export function requireSignedIn(request: Request, ctx: RequestCtx, db: Db): Promise<CustomerSession> {
  return requireCustomer(ctx, db, { next: pageNext(request) });
}

/** A safe, locale-less `next` from a form or query value (default `/account`). */
export function nextFrom(value: unknown, fallback = "/account"): string {
  const safe = safeNextPath(value, fallback);
  // A `next` that already carries a language prefix keeps only its path: the visitor's language decides the prefix.
  return splitLocale(safe.split("?")[0]).path + (safe.includes("?") ? safe.slice(safe.indexOf("?")) : "");
}

/** A redirect to a locale-less path in the visitor's language. */
export function localeRedirect(path: string, locale: Locale, init?: number | ResponseInit): Response {
  return redirect(localePath(path, locale), init);
}

/** t() for error keys: the account namespace first, then the shared errors namespace. Never warns about either. */
export function errorT(locale: Locale): TFunction {
  const account = getNamespace("account")?.[locale];
  const shared = getNamespace("errors")?.[locale];
  return (key, vars) => translate(account, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

/** An expected failure as `{ ok: false, code, status, message, fields }` with sentences (rethrows anything else). */
export function accountFailure(error: unknown, locale: Locale): ActionFailure {
  return actionError(error, errorT(locale));
}

/** Form fields as strings (files and repeated names ignored). */
export function formFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form) if (typeof value === "string" && !(key in out)) out[key] = value;
  return out;
}

/** The `tt_cart` and `tt_wish` cookies of the request. */
export function guestTokens(ctx: RequestCtx): { cartToken: string | null; wishToken: string | null } {
  return { cartToken: ctx.cookie(CART_COOKIE_NAME), wishToken: ctx.cookie(WISH_COOKIE) };
}

/** Keeps (or, with null, removes) the guest wishlist bridge cookie. */
export function setWishCookie(ctx: RequestCtx, token: string | null): void {
  if (token === ctx.cookie(WISH_COOKIE)) return;
  ctx.setCookie(serializeCookie(ctx, WISH_COOKIE, token ?? "", { maxAge: token ? WISH_COOKIE_MAX_AGE_SEC : 0, httpOnly: true, sameSite: "Lax" }));
}

/** This device's personalization answer (read by the shell as `personalizationConsent`). */
export function setConsentCookie(ctx: RequestCtx, granted: boolean): void {
  ctx.setCookie(serializeCookie(ctx, CONSENT_COOKIE, granted ? "1" : "0", { maxAge: CONSENT_COOKIE_MAX_AGE_SEC, httpOnly: false, sameSite: "Lax" }));
}

export function deviceConsent(ctx: RequestCtx): boolean | null {
  const value = ctx.cookie(CONSENT_COOKIE);
  return value === "1" ? true : value === "0" ? false : null;
}

/**
 * On sign-out: the cart cookie points at a cart that now belongs to the account, and the guest favourites were moved
 * into it — the next person on this device starts with neither.
 */
export function clearGuestCookies(ctx: RequestCtx): void {
  if (ctx.cookie(CART_COOKIE_NAME)) ctx.setCookie(serializeCookie(ctx, CART_COOKIE_NAME, "", { maxAge: 0, httpOnly: true, sameSite: "Lax" }));
  if (ctx.cookie(WISH_COOKIE)) ctx.setCookie(serializeCookie(ctx, WISH_COOKIE, "", { maxAge: 0, httpOnly: true, sameSite: "Lax" }));
}

/**
 * Right after sign-in or sign-up: the guest cart, favourites and (with consent) history join the account; the bridge
 * cookie goes; a device that never answered the personalization question takes the account's answer.
 */
export async function completeSignIn(ctx: RequestCtx, db: Db, customerId: string): Promise<void> {
  const tokens = guestTokens(ctx);
  const device = deviceConsent(ctx);
  const after = await afterSignIn(db, { customerId, cartToken: tokens.cartToken, wishToken: tokens.wishToken, devicePersonalization: device }, ctx.now);
  setWishCookie(ctx, null);
  if (device === null && after.personalization !== null) setConsentCookie(ctx, after.personalization);
}

/** One-time code options: the code hash is an HMAC with SESSION_SECRET. */
export function otpOptions(): OtpOptions {
  return { secret: (env as { SESSION_SECRET?: string }).SESSION_SECRET };
}

/** The private file store (KV today). */
export function blobStore(): BlobStore {
  return kvBlobStore(env.KV);
}
