import { describe, expect, it } from "vitest";
import { edgeCacheable } from "../workers/edge-cache";

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
    ]) {
      expect(edgeCacheable(req(path)), path).toBe(true);
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
