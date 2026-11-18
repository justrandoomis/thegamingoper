/**
 * Edge cache for anonymous browsing pages (2026-11-18, speed work).
 *
 * A visitor without the store's cookies gets the same page as every other such visitor: the locale comes from the
 * address, nothing is personal, no cookie is set. Those pages (home, categories, products, platform hubs, used
 * devices, device hubs, help articles, info pages — and their `.data` twins for client navigations) are kept in the
 * colo's cache (Cache API) for up to EDGE_TTL seconds and refreshed in the background once older than FRESH_MS, so a
 * first visit skips the server render and the database (~200–400 ms).
 *
 * Never cached: anything with a store cookie (cart, session, wishlist, prefs…), a query string (filters, search,
 * campaign links), POST, admin/api/account/cart/checkout/track…, a non-200 answer or an answer that sets a cookie.
 *
 * The CSP nonce: the cached copy keeps the nonce it was rendered with; every answer from the cache gets a fresh one,
 * replaced in the header and in the HTML (it is a 128-bit random value, so a plain replace is exact).
 * The key carries the build version: a deploy never serves pages that point at the previous build's files.
 */

const EDGE_TTL = 120;
const FRESH_MS = 30_000;
const STORED_AT = "x-tt-stored-at";

/** Browsing paths (without the "/en" or "/ckb" prefix and without ".data"). */
const CACHEABLE: RegExp[] = [
  /^\/$/,
  /^\/(c|p|platform|device|used|policies|pages|support\/article)\/[^/]+$/,
  /^\/(used|devices|about|accessibility|contact|policies|support|trade-in)$/,
];

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
  // HTML: no query at all. ".data": only React Router's own "_routes" parameter.
  for (const key of url.searchParams.keys()) if (!(hit.data && key === "_routes")) return false;
  if (!onlyCloudflareCookies(request.headers.get("Cookie"))) return false;
  if (request.headers.get("Authorization")) return false;
  return true;
}

function cacheKey(request: Request, version: string): Request {
  const url = new URL(request.url);
  url.searchParams.set("__v", version);
  return new Request(url.toString(), { method: "GET" });
}

function storable(response: Response): boolean {
  if (response.status !== 200 || response.headers.has("Set-Cookie")) return false;
  const type = response.headers.get("Content-Type") ?? "";
  return type.startsWith("text/html") || type.includes("turbo-stream") || type.includes("x-script");
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

const NONCE_IN_CSP = /'nonce-([^']+)'/;

/** A cached answer, re-signed with a fresh nonce. */
async function serve(cached: Response, state: "HIT" | "STALE"): Promise<Response> {
  const headers = new Headers(cached.headers);
  const csp = headers.get("Content-Security-Policy");
  const old = csp?.match(NONCE_IN_CSP)?.[1];
  let body: BodyInit | null = cached.body;
  if (old) {
    const fresh = newNonce();
    headers.set("Content-Security-Policy", csp!.replace(`'nonce-${old}'`, `'nonce-${fresh}'`));
    body = (await cached.text()).split(old).join(fresh);
  }
  headers.delete(STORED_AT);
  headers.set("Cache-Control", "private, no-cache");
  headers.set("X-TT-Edge", state);
  return new Response(body, { status: 200, headers });
}

async function store(cache: Cache, key: Request, response: Response): Promise<void> {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${EDGE_TTL}`);
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
          const response = await render(new Request(request.url, { method: "GET", headers: { Accept: request.headers.get("Accept") ?? "text/html" } }));
          if (storable(response)) await store(cache, key, response);
        })().catch(() => undefined),
      );
      return serve(cached, "STALE");
    }
    return serve(cached, "HIT");
  }
  const response = await render(request);
  if (!storable(response)) return response;
  const [forVisitor, forCache] = response.body ? response.body.tee() : [null, null];
  ctx.waitUntil(store(cache, key, new Response(forCache, { status: 200, headers: response.headers })).catch(() => undefined));
  const headers = new Headers(response.headers);
  headers.set("X-TT-Edge", "MISS");
  return new Response(forVisitor, { status: response.status, statusText: response.statusText, headers });
}
