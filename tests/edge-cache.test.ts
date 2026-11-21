import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edgeCacheable, withEdgeCache } from "../workers/edge-cache";

const req = (path: string, init: RequestInit = {}) => new Request(`https://tamtamgames.com${path}`, init);

describe("edge cache: which requests may be answered from the colo's cache", () => {
  it("caches anonymous browsing pages in every locale, and their .data twins", () => {
    for (const path of [
      "/",
      "/en",
      "/ckb",
      "/c/games",
      "/en/c/games",
      "/p/nintendo-switch-2",
      "/ckb/p/dualsense",
      "/platform/playstation",
      "/used",
      "/used/used-ps5-slim-disc-01",
      "/devices",
      "/device/ps5-slim",
      "/support",
      "/support/article/how-to-pair",
      "/policies/returns",
      "/about",
      "/trade-in",
      "/c/games.data",
      "/_root.data",
      "/en/p/dualsense.data?_routes=routes%2Fstorefront%2Fproduct%2Fproduct",
      // the Switch builder's first step (2026-11-21)
      "/build/switch",
      "/en/build/switch",
      "/ckb/build/switch",
      "/build/switch.data",
      "/en/build/switch.data?_routes=routes%2Fstorefront%2Fbuilder%2Fswitch-builder",
    ]) {
      expect(edgeCacheable(req(path)), path).toBe(true);
    }
  });

  it("caches the Switch builder's public JSON at its own address only, whatever query or cookie comes with it (2026-11-21)", () => {
    expect(edgeCacheable(req("/api/switch-library"))).toBe(true);
    // the route reads neither the query nor cookies: one copy per path, so neither can force a database read
    for (const path of ["/api/switch-library?rev=1", "/api/switch-library?x=1&y=2"]) expect(edgeCacheable(req(path)), path).toBe(true);
    for (const path of ["/api/switch-library/", "/en/api/switch-library", "/ckb/api/switch-library", "/api/switch-library.data", "/api/switch-libraryx", "/api/switch"]) {
      expect(edgeCacheable(req(path)), path).toBe(false);
    }
    expect(edgeCacheable(req("/api/switch-library", { headers: { Cookie: "tt_cart=abc" } }))).toBe(true);
    expect(edgeCacheable(req("/api/switch-library", { headers: { Cookie: "__cf_bm=x" } }))).toBe(true);
    expect(edgeCacheable(req("/api/switch-library", { headers: { Authorization: "Bearer x" } }))).toBe(false);
    expect(edgeCacheable(req("/api/switch-library", { method: "POST" }))).toBe(false);
  });

  it("never caches the builder's other steps or other builders (their state is in the query, or they do not exist)", () => {
    for (const path of ["/build/switch?step=memory", "/en/build/switch?step=games", "/build/switch.data?step=review&_routes=x", "/build/switch/", "/build", "/build/switch-2", "/build/switch/x"]) {
      expect(edgeCacheable(req(path)), path).toBe(false);
    }
  });

  it("never caches personal, transactional or admin pages", () => {
    for (const path of ["/cart", "/checkout", "/account", "/account/orders", "/wishlist", "/track", "/order/TT-1", "/login", "/signup", "/admin", "/admin/login", "/api/health", "/search", "/compare", "/trade-in/TI-1", "/support/ticket", "/support/repair/status", "/en/cart.data"]) {
      expect(edgeCacheable(req(path)), path).toBe(false);
    }
  });

  it("never caches a query string (filters, search, campaign links) on a page", () => {
    expect(edgeCacheable(req("/c/games?sort=price"))).toBe(false);
    expect(edgeCacheable(req("/?utm_source=ig"))).toBe(false);
    expect(edgeCacheable(req("/c/games.data?sort=price&_routes=x"))).toBe(false);
  });

  it("never caches a visitor with store cookies, only Cloudflare's own", () => {
    expect(edgeCacheable(req("/", { headers: { Cookie: "tt_cart=abc" } }))).toBe(false);
    expect(edgeCacheable(req("/", { headers: { Cookie: "__cf_bm=x; tt_prefs=dark" } }))).toBe(false);
    expect(edgeCacheable(req("/", { headers: { Cookie: "__cf_bm=x; _cfuvid=y" } }))).toBe(true);
  });

  it("never caches anything but GET", () => {
    expect(edgeCacheable(req("/", { method: "POST" }))).toBe(false);
    expect(edgeCacheable(req("/", { method: "HEAD" }))).toBe(false);
  });
});

/** The colo's cache as the Cache API behaves for these tests: by URL, a copy per put (expiry is Cloudflare's). */
class MemoryCache {
  entries = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
  }
}

describe("edge cache: what is kept and what a cached answer says (2026-11-21, the Switch builder's public JSON)", () => {
  const T0 = Date.UTC(2026, 10, 21, 9, 0, 0);
  let cache: MemoryCache;
  let pending: Promise<unknown>[];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  /** Waits for the background work (the copy being stored, a stale copy being refreshed). */
  const settle = async () => {
    while (pending.length > 0) await pending.shift();
  };
  const at = (ms: number) => vi.setSystemTime(T0 + ms);
  const json = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", ...headers } });
  const library = () => req("/api/switch-library");

  beforeEach(() => {
    cache = new MemoryCache();
    pending = [];
    vi.stubGlobal("caches", { default: cache });
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the public JSON 60 s; a copy goes out with the route's Cache-Control and its age, and is refreshed after 30 s", async () => {
    let renders = 0;
    const render = async () => json(`{"rev":"${++renders}"}`);

    const first = await withEdgeCache(library(), ctx, "v1", render);
    expect(first.headers.get("X-TT-Edge")).toBe("MISS");
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await first.text()).toBe('{"rev":"1"}');
    await settle();
    const stored = [...cache.entries.values()][0];
    expect(stored.headers.get("Cache-Control")).toBe("public, max-age=60");

    at(10_000);
    const hit = await withEdgeCache(library(), ctx, "v1", render);
    expect(hit.headers.get("X-TT-Edge")).toBe("HIT");
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(hit.headers.get("Age")).toBe("10");
    expect(hit.headers.get("x-tt-stored-at")).toBeNull();
    expect(hit.headers.get("x-tt-route-cache-control")).toBeNull();
    expect(await hit.text()).toBe('{"rev":"1"}');
    expect(renders).toBe(1);

    at(45_000);
    const stale = await withEdgeCache(library(), ctx, "v1", render);
    expect(stale.headers.get("X-TT-Edge")).toBe("STALE");
    expect(stale.headers.get("Age")).toBe("45");
    expect(await stale.text()).toBe('{"rev":"1"}');
    await settle();
    expect(renders).toBe(2);
    at(46_000);
    const refreshed = await withEdgeCache(library(), ctx, "v1", render);
    expect(await refreshed.text()).toBe('{"rev":"2"}');
    expect(refreshed.headers.get("Age")).toBe("1");
  });

  it("never keeps a JSON answer its route does not call public, one that sets a cookie, an error or another type", async () => {
    for (const answer of [
      json("{}", { "Cache-Control": "no-store" }),
      json("{}", { "Cache-Control": "private, max-age=60" }),
      // public, but the route allows no reuse without asking it again (review 2026-11-21)
      json("{}", { "Cache-Control": "public, no-cache" }),
      json("{}", { "Cache-Control": "public, max-age=0" }),
      json("{}", { "Cache-Control": "public, s-maxage=0, max-age=60" }),
      json("{}", { "Cache-Control": "public, max-age=60", "Set-Cookie": "tt_cart=x" }),
      new Response("{}", { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } }),
      new Response("<html></html>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=60" } }),
    ]) {
      const response = await withEdgeCache(library(), ctx, "v1", async () => answer);
      expect(response.headers.get("X-TT-Edge")).toBeNull();
      await settle();
      expect(cache.entries.size).toBe(0);
    }
  });

  it("keeps a JSON answer no longer than its route allows: s-maxage, else max-age, at most 60 s (review 2026-11-21)", async () => {
    const kept = async (cacheControl: string) => {
      cache = new MemoryCache();
      vi.stubGlobal("caches", { default: cache });
      await withEdgeCache(library(), ctx, "v1", async () => json("{}", { "Cache-Control": cacheControl }));
      await settle();
      const stored = [...cache.entries.values()][0];
      return stored?.headers.get("Cache-Control") ?? null;
    };
    expect(await kept("public, max-age=10")).toBe("public, max-age=10");
    expect(await kept("public, s-maxage=20, max-age=60")).toBe("public, max-age=20");
    expect(await kept("public, max-age=600")).toBe("public, max-age=60");
    expect(await kept("public")).toBe("public, max-age=60");
    // a copy goes out with the route's own words, whatever the colo keeps it for
    at(3_000);
    const hit = await withEdgeCache(library(), ctx, "v1", async () => json("{}"));
    expect(hit.headers.get("X-TT-Edge")).toBe("HIT");
    expect(hit.headers.get("Cache-Control")).toBe("public");
    expect(hit.headers.get("Age")).toBe("3");
  });

  it("pages keep their rule: a cached page goes out private, no-cache, re-signed, without an Age", async () => {
    const page = () => new Response('<html><script nonce="bm9uY2UtMQ=="></script></html>', { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "script-src 'self' 'nonce-bm9uY2UtMQ=='", "Cache-Control": "private, no-cache" } });
    await withEdgeCache(req("/build/switch"), ctx, "v1", async () => page());
    await settle();
    at(5_000);
    const hit = await withEdgeCache(req("/build/switch"), ctx, "v1", async () => page());
    expect(hit.headers.get("X-TT-Edge")).toBe("HIT");
    expect(hit.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(hit.headers.get("Age")).toBeNull();
    const fresh = /'nonce-([^']+)'/.exec(hit.headers.get("Content-Security-Policy") ?? "")?.[1];
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe("bm9uY2UtMQ==");
    expect(await hit.text()).toContain(`nonce="${fresh}"`);
  });
});
