/**
 * Edge cache for anonymous browsing pages (2026-11-18, speed work).
 *
 * A visitor without the store's cookies gets the same page as every other such visitor: the locale comes from the
 * address, nothing is personal, no cookie is set. Those pages (home, categories, products, platform hubs, used
 * devices, device hubs, help articles, info pages, the Switch builder's first step — and their `.data` twins for
 * client navigations) are kept in the colo's cache (Cache API) for up to EDGE_TTL seconds and refreshed in the
 * background once older than FRESH_MS, so a first visit skips the server render and the database (~200–400 ms).
 *
 * Never cached: anything with a store cookie (cart, session, wishlist, prefs…), a query string (filters, search,
 * campaign links), POST, admin/api/account/cart/checkout/track…, a non-200 answer or an answer that sets a cookie.
 *
 * Public JSON (2026-11-21): one resource route answers every visitor alike — TamTam's game data for the Switch
 * builder, GET /api/switch-library (docs/switch-builder.md §4.2). It is kept at its own address only (no locale prefix,
 * no ".data", no query), only while the route itself calls it public, and for JSON_TTL seconds at most — less when the
 * route's own s-maxage / max-age says less; an answer from the cache carries the route's own Cache-Control with an
 * Age, so no copy is older than the route allows in the browser either.
 *
 * The CSP nonce: the cached copy keeps the nonce it was rendered with; every answer from the cache gets a fresh one,
 * replaced in the header and in the HTML (it is a 128-bit random value, so a plain replace is exact).
 * The key carries the build version: a deploy never serves pages that point at the previous build's files.
 */

const EDGE_TTL = 120;
const JSON_TTL = 60;
const FRESH_MS = 30_000;
const STORED_AT = "x-tt-stored-at";
/** The route's own Cache-Control, kept with a stored JSON copy (the stored copy's own says how long the colo keeps it). */
const ROUTE_CACHE_CONTROL = "x-tt-route-cache-control";

/** Browsing paths (without the "/en" or "/ckb" prefix and without ".data"). */
const CACHEABLE: RegExp[] = [
  /^\/$/,
  /^\/(c|p|platform|device|used|policies|pages|support\/article)\/[^/]+$/,
  /^\/(used|devices|about|accessibility|contact|policies|support|trade-in)$/,
  // the Switch builder's first step (its other steps carry ?step=, which is never cached)
  /^\/build\/switch$/,
];

/** Public JSON resource routes, by their exact address. */
const CACHEABLE_JSON: ReadonlySet<string> = new Set(["/api/switch-library"]);

/** Cookies set by Cloudflare itself (bot management), which say nothing about the visitor's store state. */
function onlyCloudflareCookies(header: string | null): boolean {
  if (!header) return true;
  return header
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter(Boolean)
    .every((name) => name.startsWith("__cf") || name.startsWith("cf_") || name === "_cfuvid");
}

function cacheablePath(pathname: string): { data: boolean } | null {
  if (CACHEABLE_JSON.has(pathname)) return { data: false };
  let path = pathname;
  let data = false;
  if (path.endsWith(".data")) {
    data = true;
    path = path === "/_root.data" ? "/" : path.slice(0, -".data".length);
  }
  path = path.replace(/^\/(en|ckb)(?=\/|$)/, "") || "/";
  if (path.length > 1 && path.endsWith("/")) return null;
  return CACHEABLE.some((re) => re.test(path)) ? { data } : null;
}

export function edgeCacheable(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  const hit = cacheablePath(url.pathname);
  if (!hit) return false;
  if (request.headers.get("Authorization")) return false;
  // A public JSON route reads neither the query nor cookies: every such request gets the one copy kept for its path
  // (cacheKey drops the query), so "?x=1" or a cookie cannot be used to reach the database on each request.
  if (CACHEABLE_JSON.has(url.pathname)) return true;
  // HTML: no query at all. ".data": only React Router's own "_routes" parameter.
  for (const key of url.searchParams.keys()) if (!(hit.data && key === "_routes")) return false;
  if (!onlyCloudflareCookies(request.headers.get("Cookie"))) return false;
  if (request.headers.get("Authorization")) return false;
  return true;
}

function cacheKey(request: Request, version: string): Request {
  const url = new URL(request.url);
  if (CACHEABLE_JSON.has(url.pathname)) url.search = "";
  url.searchParams.set("__v", version);
  return new Request(url.toString(), { method: "GET" });
}

/** A public JSON route's request (an exact address of CACHEABLE_JSON). */
const isJsonRequest = (request: Request): boolean => CACHEABLE_JSON.has(new URL(request.url).pathname);

/**
 * How long the colo may keep a public JSON answer, in seconds: JSON_TTL, or less when the route's own Cache-Control
 * allows less (`s-maxage`, the shared caches' figure, else `max-age`). 0 = not at all.
 */
function jsonTtl(cacheControl: string): number {
  const own = /\bs-maxage=(\d+)/.exec(cacheControl) ?? /\bmax-age=(\d+)/.exec(cacheControl);
  return own ? Math.min(JSON_TTL, Number(own[1])) : JSON_TTL;
}

function storable(response: Response, json: boolean): boolean {
  if (response.status !== 200 || response.headers.has("Set-Cookie")) return false;
  const type = response.headers.get("Content-Type") ?? "";
  if (json) {
    // only what the route itself calls public, for no longer than it allows: an answer the route marks no-store,
    // no-cache (reuse only after asking it again) or private, or one it lets live 0 s, is never kept
    const own = (response.headers.get("Cache-Control") ?? "").toLowerCase();
    return type.startsWith("application/json") && /\bpublic\b/.test(own) && !/\b(no-store|no-cache|private)\b/.test(own) && jsonTtl(own) > 0;
  }
  return type.startsWith("text/html") || type.includes("turbo-stream") || type.includes("x-script");
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

const NONCE_IN_CSP = /'nonce-([^']+)'/;

/**
 * A cached answer, re-signed with a fresh nonce. A page goes out `private, no-cache`; a public JSON answer with the
 * route's own Cache-Control and its age in seconds (`ageMs`), which the browser's cache counts against that max-age.
 */
async function serve(cached: Response, state: "HIT" | "STALE", json: boolean, ageMs: number): Promise<Response> {
  const headers = new Headers(cached.headers);
  const csp = headers.get("Content-Security-Policy");
  const old = csp?.match(NONCE_IN_CSP)?.[1];
  let body: BodyInit | null = cached.body;
  if (old) {
    const fresh = newNonce();
    headers.set("Content-Security-Policy", csp!.replace(`'nonce-${old}'`, `'nonce-${fresh}'`));
    body = (await cached.text()).split(old).join(fresh);
  }
  const own = headers.get(ROUTE_CACHE_CONTROL);
  headers.delete(STORED_AT);
  headers.delete(ROUTE_CACHE_CONTROL);
  if (json && own) {
    headers.set("Cache-Control", own);
    headers.set("Age", String(Math.max(0, Math.floor(ageMs / 1000))));
  } else {
    headers.set("Cache-Control", "private, no-cache");
  }
  headers.set("X-TT-Edge", state);
  return new Response(body, { status: 200, headers });
}

async function store(cache: Cache, key: Request, response: Response, json: boolean): Promise<void> {
  const headers = new Headers(response.headers);
  const route = response.headers.get("Cache-Control") ?? "";
  if (json) headers.set(ROUTE_CACHE_CONTROL, route);
  headers.set("Cache-Control", `public, max-age=${json ? jsonTtl(route.toLowerCase()) : EDGE_TTL}`);
  headers.set(STORED_AT, String(Date.now()));
  await cache.put(key, new Response(response.body, { status: 200, headers }));
}

/** Answers from the colo cache when it can; otherwise renders, answers and keeps a copy. */
export async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  version: string,
  render: (request: Request) => Promise<Response>,
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = cacheKey(request, version);
  const json = isJsonRequest(request);
  let cached: Response | undefined;
  try {
    cached = await cache.match(key);
  } catch {
    cached = undefined;
  }
  if (cached) {
    const age = Date.now() - Number(cached.headers.get(STORED_AT) ?? 0);
    if (age > FRESH_MS) {
      // refresh behind the visitor's back; the visitor gets the copy at once
      ctx.waitUntil(
        (async () => {
          const response = await render(new Request(request.url, { method: "GET", headers: { Accept: request.headers.get("Accept") ?? (json ? "application/json" : "text/html") } }));
          if (storable(response, json)) await store(cache, key, response, json);
        })().catch(() => undefined),
      );
      return serve(cached, "STALE", json, age);
    }
    return serve(cached, "HIT", json, age);
  }
  const response = await render(request);
  if (!storable(response, json)) return response;
  const [forVisitor, forCache] = response.body ? response.body.tee() : [null, null];
  ctx.waitUntil(store(cache, key, new Response(forCache, { status: 200, headers: response.headers }), json).catch(() => undefined));
  const headers = new Headers(response.headers);
  headers.set("X-TT-Edge", "MISS");
  return new Response(forVisitor, { status: response.status, statusText: response.statusText, headers });
}
