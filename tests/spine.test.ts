/**
 * The lead's spine helpers: locale paths, the page path behind React Router's ".data" requests, and the headers
 * every response leaves with (security.server.ts). No database.
 */
import { describe, expect, test } from "vitest";
import { translate } from "~/i18n/translate";
import { localePath, splitLocale, switchLocalePath } from "~/lib/locales";
import type { RequestCtx } from "~/server/context.server";
import { applySecurityHeaders, pagePathname } from "~/server/security.server";

describe("locale paths", () => {
  test("storefront paths take the language prefix; Arabic has none", () => {
    expect(localePath("/cart", "en")).toBe("/en/cart");
    expect(localePath("/", "ckb")).toBe("/ckb");
    expect(localePath("/cart", "ar")).toBe("/cart");
    expect(localePath("p/x", "en")).toBe("/en/p/x");
  });

  test("the admin and the API never take a prefix (the admin's language is a cookie)", () => {
    for (const path of ["/admin", "/admin/orders", "/admin?x=1", "/admin#top", "/api/cart", "/api"]) {
      expect(localePath(path, "en")).toBe(path);
      expect(localePath(path, "ckb")).toBe(path);
    }
    // only whole segments: a storefront path that merely starts with the same letters is still prefixed
    expect(localePath("/administration-guide", "en")).toBe("/en/administration-guide");
    expect(localePath("/apis", "en")).toBe("/en/apis");
    expect(switchLocalePath("/admin/orders", "?page=2", "", "en")).toBe("/admin/orders?page=2");
  });

  test("splitLocale reads the prefix back", () => {
    expect(splitLocale("/en/cart")).toEqual({ locale: "en", path: "/cart" });
    expect(splitLocale("/ckb")).toEqual({ locale: "ckb", path: "/" });
    expect(splitLocale("/cart")).toEqual({ locale: "ar", path: "/cart" });
  });
});

describe("messages: plurals versus branches", () => {
  const tree = {
    items: { one: "{count} item", other: "{count} items" },
    reasons: { damaged: "Damaged", wrong_item: "Wrong item", other: "Something else" },
  };

  test("an object whose keys are all plural categories is one plural message", () => {
    expect(translate(tree, "en", "items", { count: 1 })).toBe("1 item");
    expect(translate(tree, "en", "items", { count: 3 })).toBe("3 items");
    expect(translate(tree, "en", "items.one")).toBeUndefined();
  });

  test("an object with `other` among ordinary keys is a branch, so `other` is an ordinary key", () => {
    expect(translate(tree, "en", "reasons.other")).toBe("Something else");
    expect(translate(tree, "en", "reasons.damaged")).toBe("Damaged");
    expect(translate(tree, "en", "reasons")).toBeUndefined();
  });
});

describe("pagePathname", () => {
  test("strips React Router's single-fetch suffixes the way the router does", () => {
    expect(pagePathname("/en.data")).toBe("/en");
    expect(pagePathname("/_.data")).toBe("/");
    expect(pagePathname("/en/_.data")).toBe("/en/");
    expect(pagePathname("/admin/orders.data")).toBe("/admin/orders");
    expect(pagePathname("/p/dualsense")).toBe("/p/dualsense");
  });
});

describe("response headers", () => {
  const ctx = { isDev: false, isHttps: true, storeMode: "live", nonce: "n" } as unknown as RequestCtx;
  const run = (path: string, init: { type?: string; cache?: string } = {}) => {
    const headers = new Headers({ "Content-Type": init.type ?? "text/html; charset=utf-8" });
    if (init.cache) headers.set("Cache-Control", init.cache);
    const response = new Response("x", { headers });
    applySecurityHeaders(response, ctx, new URL(`https://tamtamgames.com${path}`));
    return response.headers;
  };

  test("private pages are never stored — error pages and explicit route headers included", () => {
    for (const path of ["/admin", "/admin/orders", "/en/account", "/checkout", "/en/cart", "/order/TT-1", "/track"]) {
      expect(run(path).get("Cache-Control"), path).toBe("no-store");
      expect(run(path).get("X-Robots-Tag"), path).toBe("noindex, nofollow");
    }
    expect(run("/admin/orders", { cache: "private, max-age=60" }).get("Cache-Control")).toBe("no-store");
  });

  test("private data and API responses default to no-store but keep a route's own choice", () => {
    expect(run("/admin.data", { type: "text/x-script" }).get("Cache-Control")).toBe("no-store");
    expect(run("/en/account/_.data", { type: "text/x-script" }).get("Cache-Control")).toBe("no-store");
    expect(run("/api/search/suggest", { type: "application/json", cache: "public, max-age=60" }).get("Cache-Control")).toBe(
      "public, max-age=60",
    );
  });

  test("public pages keep the revalidating default and stay indexable on the live domain", () => {
    expect(run("/p/dualsense").get("Cache-Control")).toBe("private, no-cache");
    expect(run("/en").get("X-Robots-Tag")).toBeNull();
    expect(run("/en").get("Content-Security-Policy")).toContain("default-src");
  });
});
