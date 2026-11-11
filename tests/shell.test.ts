/**
 * Storefront shell decisions (app/routes/storefront/shell/chrome.ts) — pure, no database:
 *   · the language links' query string is spelled as React Router's server spells it, so they hydrate unchanged;
 *   · which bars a page gets from its route handles, and that an error page ignores the failed page's handle;
 *   · where the task header's back key leads without history;
 *   · the footer links every policy page the content area publishes.
 */
import { describe, expect, it } from "vitest";
import { switchLocalePath } from "~/lib/locales";
import { POLICY_SLUGS } from "~/routes/storefront/content/content-model";
import { backFallback, canonicalSearch, FOOTER_POLICIES, shellChrome } from "~/routes/storefront/shell/chrome";
import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";

/**
 * What React Router's server renders as `location.search` for a document request (react-router
 * lib/server-runtime/urls.ts getNormalizedPath): the request URL's query rebuilt through URLSearchParams, `_routes`
 * dropped. Written out here so a change in that behaviour shows up as a failing expectation below.
 */
function serverSearch(raw: string): string {
  const url = new URL(`http://localhost/support${raw}`);
  const params = new URLSearchParams(url.search);
  params.delete("_routes");
  const search = params.toString();
  return search ? `?${search}` : "";
}

describe("canonicalSearch — the query in the server's spelling", () => {
  const cases: [raw: string, canonical: string][] = [
    ["", ""],
    ["?", ""],
    ["?x=a%20b", "?x=a+b"], // the STATUS repro: /support?x=a%20b
    ["?x=a+b", "?x=a+b"],
    ["?platform=playstation&x=a,b", "?platform=playstation&x=a%2Cb"], // filter URLs with commas
    ["?ids=a,b,c", "?ids=a%2Cb%2Cc"],
    ["?flag", "?flag="],
    ["?q=%D8%A8%D9%84%D8%A7%D9%8A", "?q=%D8%A8%D9%84%D8%A7%D9%8A"],
    ["?q=بلاي", "?q=%D8%A8%D9%84%D8%A7%D9%8A"],
    ["?q=100%", "?q=100%25"],
    ["?a=1&a=2&b=", "?a=1&a=2&b="],
    ["?_routes=routes%2Fx&step=payment", "?step=payment"],
  ];

  it("spells every query exactly as the server renders it", () => {
    for (const [raw, canonical] of cases) {
      expect(canonicalSearch(raw), raw).toBe(canonical);
      expect(serverSearch(raw), raw).toBe(canonical);
    }
  });

  it("is idempotent, so the server (already canonical) and the browser (raw) build the same href", () => {
    for (const [raw] of cases) {
      const onServer = switchLocalePath("/c/games", canonicalSearch(serverSearch(raw)), "", "en");
      const inBrowser = switchLocalePath("/c/games", canonicalSearch(raw), "", "en");
      expect(inBrowser, raw).toBe(onServer);
      expect(canonicalSearch(canonicalSearch(raw)), raw).toBe(canonicalSearch(raw));
    }
  });

  it("keeps what the query means", () => {
    for (const [raw] of cases) {
      const before = new URLSearchParams(raw);
      before.delete("_routes");
      expect([...new URLSearchParams(canonicalSearch(raw))], raw).toEqual([...before]);
    }
  });
});

describe("shellChrome — the bars a page asks for", () => {
  const root = { id: "root", handle: undefined };
  const layout = { id: LAYOUT_ROUTE_ID, handle: undefined };
  const product = { id: "routes/storefront/product/product", handle: { shell: { tabBar: false } } };
  const checkout = { id: "routes/storefront/checkout/checkout", handle: { shell: { tabBar: false, back: "/cart" }, nav: "push" } };
  const page = { id: "routes/storefront/support/help", handle: { nav: "push" } };

  it("shows the tab bar unless a matched page has its own task bar", () => {
    expect(shellChrome([root, layout, page])).toEqual({ tabBar: true, back: null });
    expect(shellChrome([root, layout, product])).toEqual({ tabBar: false, back: null });
    expect(shellChrome([root, layout, checkout])).toEqual({ tabBar: false, back: "/cart" });
    expect(shellChrome([])).toEqual({ tabBar: true, back: null });
  });

  it("ignores the failed page's handle on the error page (an unknown product URL gets the tab bar)", () => {
    expect(shellChrome([root, layout, product], { errored: true })).toEqual({ tabBar: true, back: null });
    expect(shellChrome([root, layout, checkout], { errored: true })).toEqual({ tabBar: true, back: null });
    // the layout's own loader failed (no layout match yet): nothing below the root applies either
    expect(shellChrome([root, product], { errored: true })).toEqual({ tabBar: true, back: null });
  });

  it("takes only locale-less paths as a back target", () => {
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { tabBar: false, back: "https://evil.example/" } } }]).back).toBeNull();
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { back: 42 } } }]).back).toBeNull();
    expect(shellChrome([root, layout, { id: "x", handle: null }])).toEqual({ tabBar: true, back: null });
  });
});

describe("backFallback — back without history leads to the page's section", () => {
  it("maps task pages to their section, everything else home", () => {
    expect(backFallback("/checkout")).toBe("/cart");
    expect(backFallback("/checkout/")).toBe("/cart");
    expect(backFallback("/cart")).toBe("/");
    expect(backFallback("/p/ghost-of-yotei")).toBe("/");
    expect(backFallback("/used/ps5-slim-a-1")).toBe("/used");
    expect(backFallback("/trade-in/TI-7K4M2Q9X")).toBe("/trade-in");
    expect(backFallback("/support/assistant")).toBe("/support");
    expect(backFallback("/support/repair/status")).toBe("/support");
    expect(backFallback("/account/orders/TT-1")).toBe("/account");
    expect(backFallback("/used")).toBe("/");
    expect(backFallback("/")).toBe("/");
  });
});

describe("footer", () => {
  it("links every policy page the content area publishes, each once", () => {
    const linked = [...FOOTER_POLICIES.help, ...FOOTER_POLICIES.store];
    expect([...linked].sort()).toEqual([...POLICY_SLUGS].sort());
    expect(new Set(linked).size).toBe(linked.length);
  });
});
