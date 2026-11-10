/**
 * Per-request context, created by the root middleware and read with `getCtx(context)`.
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const ctx = getCtx(context);          // locale, prefs, ip, nonce, cookies…
 *     const db = getDb();                   // see ~/server/db.server
 *     …
 *   }
 *
 * Nothing request-specific may live in module scope (Workers reuse isolates across requests).
 */
import { env } from "cloudflare:workers";
import { createContext, data, redirect, type MiddlewareFunction, type RouterContextProvider } from "react-router";
import { DEFAULT_LOCALE, LOCALES, splitLocale, type Dir, type Locale } from "~/lib/locales";
import { parsePrefs, PREFS_COOKIE, readCookie, type Prefs } from "~/lib/prefs";
import { applySecurityHeaders, isSameOriginMutation } from "./security.server";

export type StoreMode = "demo" | "live";

export type RequestCtx = {
  requestId: string;
  /** CSP nonce for this response; pass to inline <script nonce>. */
  nonce: string;
  /** e.g. "https://tamtamgames.com" — derived from the request, never from user input. */
  origin: string;
  isHttps: boolean;
  isDev: boolean;
  /** Epoch ms captured once per request so every write in a request shares a timestamp. */
  now: number;
  ip: string | null;
  country: string | null;
  userAgent: string;
  locale: Locale;
  dir: Dir;
  prefs: Prefs;
  storeMode: StoreMode;
  /** Read a request cookie. */
  cookie(name: string): string | null;
  /** Queue a Set-Cookie header for the response (use `serializeCookie`). */
  setCookie(serialized: string): void;
};

const requestCtx = createContext<RequestCtx | null>(null);

export function getCtx(context: Readonly<RouterContextProvider>): RequestCtx {
  const ctx = context.get(requestCtx);
  if (!ctx) throw new Error("Request context is missing — is the root middleware installed?");
  return ctx;
}

/** Same as getCtx but returns null instead of throwing (used by entry.server for error paths). */
export function peekCtx(context: Readonly<RouterContextProvider>): RequestCtx | null {
  try {
    return context.get(requestCtx);
  } catch {
    return null;
  }
}

export type CookieOptions = {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
};

/** Serialize a cookie. `Secure` is added automatically on HTTPS; httpOnly + SameSite=Lax by default. */
export function serializeCookie(ctx: RequestCtx, name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (ctx.isHttps) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(ctx: RequestCtx, name: string): string {
  return serializeCookie(ctx, name, "", { maxAge: 0 });
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Root middleware: builds the request context, rejects cross-site mutations (CSRF),
 * then decorates the response with security headers and queued cookies.
 */
export const requestContextMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  const url = new URL(request.url);

  // One canonical host: www.tamtamgames.com → tamtamgames.com (permanent, keeps path and query).
  if (url.hostname.startsWith("www.") && (request.method === "GET" || request.method === "HEAD")) {
    url.hostname = url.hostname.slice(4);
    throw redirect(url.toString(), 301);
  }

  const cookieHeader = request.headers.get("Cookie");
  const isDev = env.APP_ENV !== "production";
  const queued: string[] = [];

  // Locale comes from the URL for the storefront; the admin keeps its own cookie preference.
  let locale: Locale = splitLocale(url.pathname).locale;
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    const adminLocale = readCookie(cookieHeader, "tt_admin_locale");
    locale = adminLocale === "en" ? "en" : DEFAULT_LOCALE;
  }

  const ctx: RequestCtx = {
    requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    nonce: newNonce(),
    origin: url.origin,
    isHttps: url.protocol === "https:",
    isDev,
    now: Date.now(),
    ip: request.headers.get("CF-Connecting-IP"),
    country: (request as Request & { cf?: { country?: string } }).cf?.country ?? null,
    userAgent: request.headers.get("User-Agent") ?? "",
    locale,
    dir: LOCALES[locale].dir,
    prefs: parsePrefs(readCookie(cookieHeader, PREFS_COOKIE)),
    storeMode: env.STORE_MODE === "live" ? "live" : "demo",
    cookie: (name) => readCookie(cookieHeader, name),
    setCookie: (serialized) => {
      queued.push(serialized);
    },
  };
  context.set(requestCtx, ctx);

  if (!isSameOriginMutation(request, url)) {
    throw data({ error: "cross_site_request_blocked" }, { status: 403 });
  }

  const response = await next();
  for (const cookie of queued) response.headers.append("Set-Cookie", cookie);
  applySecurityHeaders(response, ctx, url);
  return response;
};
