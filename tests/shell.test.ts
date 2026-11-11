/**
 * Storefront shell decisions (app/routes/storefront/shell/chrome.ts, Design System v2 §5) — pure, no database:
 *   · the language links' query string is spelled as React Router's server spells it, so they hydrate unchanged;
 *   · which shell a page gets from its route handles (store · checkout · task), when the tab bar is drawn, when the
 *     header becomes the task header, and that an error page ignores the failed page's handle;
 *   · where the task header's back key leads without history; which tab a page belongs to;
 *   · the checkout bar's step rail from `?step=`;
 *   · what a platform's mega menu lists (the cross-platform games category leaves navigation, five links at most);
 *   · what a search suggestion points at; the categories sheet's departments; which error panel a failure gets
 *     (offline is never a 500);
 *   · the footer links every policy page the content area publishes.
 */
import { describe, expect, it } from "vitest";
import { switchLocalePath } from "~/lib/locales";
import { POLICY_SLUGS } from "~/routes/storefront/content/content-model";
import {
  backFallback,
  canonicalSearch,
  checkoutRail,
  errorKind,
  FOOTER_POLICIES,
  isNetworkFailure,
  MEGA_LINKS,
  megaFeature,
  megaPlan,
  sheetCategories,
  shellChrome,
  suggestionKind,
  tabOf,
  TASK_FOOTER_LINKS,
} from "~/routes/storefront/shell/chrome";
import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { NavCategory, NavPlatform } from "~/routes/storefront/shell/types";

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

describe("shellChrome — the shell a page asks for", () => {
  const root = { id: "root", handle: undefined };
  const layout = { id: LAYOUT_ROUTE_ID, handle: undefined };
  const product = { id: "routes/storefront/product/product", handle: { shell: { tabBar: false } } };
  const cart = { id: "routes/storefront/checkout/cart", handle: { shell: { tabBar: false }, nav: "push" } };
  const checkout = { id: "routes/storefront/checkout/checkout", handle: { shell: { tabBar: false, back: "/cart" }, nav: "push" } };
  const declaredCheckout = { id: "routes/storefront/checkout/checkout", handle: { shell: { chrome: "checkout" } } };
  const tradeIn = { id: "routes/storefront/used/trade-in", handle: { shell: { chrome: "task" }, nav: "push" } };
  const page = { id: "routes/storefront/support/help", handle: { nav: "push" } };
  const store = { chrome: "store", tabBar: true, task: false, back: null };

  it("store pages: the tab bar, no task header", () => {
    expect(shellChrome([root, layout, page])).toEqual(store);
    expect(shellChrome([])).toEqual(store);
    expect(shellChrome([root, layout, page], { path: "/support" })).toEqual(store);
  });

  it("a page with its own task bar keeps the drawn tab bar (it gives way by CSS, so an empty cart keeps it) and gets the task header", () => {
    expect(shellChrome([root, layout, product])).toEqual({ chrome: "store", tabBar: true, task: true, back: null });
    expect(shellChrome([root, layout, cart], { path: "/cart" })).toEqual({ chrome: "store", tabBar: true, task: true, back: null });
  });

  it("checkout: one bar, no tab bar, no task header — from its handle, and on /checkout before the handle says so", () => {
    expect(shellChrome([root, layout, declaredCheckout])).toEqual({ chrome: "checkout", tabBar: false, task: false, back: null });
    expect(shellChrome([root, layout, checkout], { path: "/checkout" })).toEqual({ chrome: "checkout", tabBar: false, task: false, back: "/cart" });
    expect(shellChrome([root, layout, checkout], { path: "/checkout/" })).toMatchObject({ chrome: "checkout" });
    // the cart and the order page are store pages
    expect(shellChrome([root, layout, cart], { path: "/cart" }).chrome).toBe("store");
    expect(shellChrome([root, layout, page], { path: "/order/TT-1" }).chrome).toBe("store");
    expect(shellChrome([root, layout, page], { path: "/checkouts" }).chrome).toBe("store");
  });

  it("task flows: the store header (task header after scroll), no tab bar", () => {
    expect(shellChrome([root, layout, tradeIn], { path: "/trade-in" })).toEqual({ chrome: "task", tabBar: false, task: true, back: null });
  });

  it("ignores the failed page's handle on the error page (an unknown product URL gets the store shell and its tab bar)", () => {
    expect(shellChrome([root, layout, product], { errored: true })).toEqual(store);
    expect(shellChrome([root, layout, checkout], { errored: true, path: "/checkout" })).toEqual(store);
    expect(shellChrome([root, layout, tradeIn], { errored: true })).toEqual(store);
    // the layout's own loader failed (no layout match yet): nothing below the root applies either
    expect(shellChrome([root, product], { errored: true })).toEqual(store);
  });

  it("takes only locale-less paths on this site as a back target", () => {
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { tabBar: false, back: "https://evil.example/" } } }]).back).toBeNull();
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { tabBar: false, back: "//evil.example/x" } } }]).back).toBeNull();
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { back: 42 } } }]).back).toBeNull();
    expect(shellChrome([root, layout, { id: "x", handle: null }])).toEqual(store);
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { chrome: "sideways" } } }]).chrome).toBe("store");
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

describe("tabOf — the tab a page belongs to", () => {
  it("marks home, categories (catalogue pages), cart (and checkout), favourites and account", () => {
    expect(tabOf("/")).toBe("home");
    expect(tabOf("/platform/playstation")).toBe("categories");
    expect(tabOf("/p/nintendo-switch-2")).toBe("categories");
    expect(tabOf("/support/assistant")).toBe("categories");
    expect(tabOf("/cart")).toBe("cart");
    expect(tabOf("/checkout")).toBe("cart");
    expect(tabOf("/wishlist")).toBe("wishlist");
    expect(tabOf("/account/orders")).toBe("account");
    expect(tabOf("/about")).toBeNull();
    expect(tabOf("/cartography")).toBeNull();
  });
});

describe("checkoutRail — the checkout bar's steps from ?step=", () => {
  it("numbers the three steps and links back only to the ones done", () => {
    expect(checkoutRail("")).toEqual({
      current: 0,
      steps: [
        { id: "address", href: null },
        { id: "payment", href: null },
        { id: "review", href: null },
      ],
    });
    expect(checkoutRail("?step=review")).toEqual({
      current: 2,
      steps: [
        { id: "address", href: "/checkout?step=address" },
        { id: "payment", href: "/checkout?step=payment" },
        { id: "review", href: null },
      ],
    });
    expect(checkoutRail("?step=payment&x=1").current).toBe(1);
    expect(checkoutRail("?step=nonsense").current).toBe(0);
  });
});

const PLATFORM: NavPlatform = {
  id: "p1",
  slug: "playstation",
  name: "بلايستيشن",
  accent: "playstation",
  artKey: "playstation-5-slim--1",
  href: "/platform/playstation",
  productCount: 42,
  devices: ["ps5-pro", "ps5-slim", "ps5-slim-digital", "ps5", "ps5-digital", "ps-portal", "ps-vr2"].map((slug) => ({ label: slug, href: `/device/${slug}` })),
  accessories: [
    { label: "بطاقات الشحن", href: "/c/gift-cards?platform=playstation" },
    { label: "الاشتراكات", href: "/c/subscriptions?platform=playstation" },
    { label: "أيدي التحكم", href: "/c/controllers?platform=playstation" },
    { label: "سماعات الرأس", href: "/c/headsets?platform=playstation" },
    { label: "التخزين", href: "/c/storage?platform=playstation" },
    { label: "الملحقات", href: "/c/accessories?platform=playstation" },
    { label: "الواقع الافتراضي", href: "/c/vr" },
  ],
  games: [
    { label: "ألعاب PlayStation", href: "/c/playstation-games" },
    { label: "ألعاب PlayStation و Xbox", href: "/c/multiplatform-games" },
  ],
  consoles: [
    { label: "PlayStation 5 Pro", href: "/p/playstation-5-pro" },
    { label: "PlayStation 5 Slim (نسخة الأقراص) – 1TB", href: "/p/playstation-5-slim" },
  ],
  allConsoles: { label: "أجهزة PlayStation", href: "/c/playstation-consoles" },
  used: { label: "بلايستيشن", href: "/used?platform=playstation" },
};

describe("megaPlan / megaFeature — what a platform's mega menu lists", () => {
  it("lists five device models at most, then all the platform's consoles", () => {
    const plan = megaPlan(PLATFORM);
    expect(plan.devices).toHaveLength(MEGA_LINKS);
    expect(plan.devices[0].href).toBe("/device/ps5-pro");
    expect(plan.allDevices).toBe("/c/playstation-consoles");
  });

  it("drops the cross-platform games category; «all games» is every game for the platform", () => {
    const plan = megaPlan(PLATFORM);
    expect(plan.games.map((link) => link.href)).toEqual(["/c/playstation-games"]);
    expect(plan.allGames).toBe("/c/games?platform=playstation");
    expect(megaPlan({ ...PLATFORM, games: [] }).allGames).toBeNull();
  });

  it("puts gift cards and subscriptions under cards and services, the rest under accessories, the used units last", () => {
    const plan = megaPlan(PLATFORM);
    expect(plan.cards.map((link) => link.href)).toEqual(["/c/gift-cards?platform=playstation", "/c/subscriptions?platform=playstation"]);
    expect(plan.accessories.map((link) => link.href)).toEqual([
      "/c/controllers?platform=playstation",
      "/c/headsets?platform=playstation",
      "/c/storage?platform=playstation",
      "/c/accessories?platform=playstation",
      "/c/vr",
    ]);
    expect(plan.used).toBe("/used?platform=playstation");
    expect(megaPlan({ ...PLATFORM, used: null, allConsoles: null })).toMatchObject({ used: null, allDevices: null });
  });

  it("features the product whose photo leads the platform, else the newest console", () => {
    expect(megaFeature(PLATFORM)).toEqual({ href: "/p/playstation-5-slim", label: "PlayStation 5 Slim (نسخة الأقراص) – 1TB", artKey: "playstation-5-slim--1" });
    expect(megaFeature({ ...PLATFORM, artKey: "unknown--1" })).toEqual({ href: "/p/playstation-5-pro", label: "PlayStation 5 Pro", artKey: null });
    expect(megaFeature({ ...PLATFORM, consoles: [] })).toBeNull();
  });
});

describe("suggestionKind — what a suggestion points at", () => {
  it("reads it from the locale-less href", () => {
    expect(suggestionKind("/p/nintendo-switch-2")).toBe("product");
    expect(suggestionKind("/platform/xbox")).toBe("platform");
    expect(suggestionKind("/c/controllers?platform=xbox")).toBe("category");
    expect(suggestionKind("/device/ps5-pro")).toBe("device");
    expect(suggestionKind("/used?platform=nintendo")).toBe("used");
    expect(suggestionKind("/search?q=playstation")).toBe("correction");
    expect(suggestionKind("/about")).toBe("other");
  });
});

describe("sheetCategories — the categories sheet's departments", () => {
  const category = (slug: string, kind: string, count = 3): NavCategory => ({ slug, kind, count, label: slug, href: `/c/${slug}`, children: [] });
  it("keeps the departments in the sheet's order, without consoles, handheld PCs or empty ones", () => {
    const list = [
      category("consoles", "consoles"),
      category("games", "games"),
      category("handheld-pcs", "handhelds"),
      category("headsets", "headsets"),
      category("digital-cards", "digital"),
      category("controllers", "controllers"),
      category("vr", "vr", 0),
    ];
    expect(sheetCategories(list).map((item) => item.slug)).toEqual(["controllers", "headsets", "digital-cards", "games"]);
  });
});

describe("errorKind — which error panel a failure gets", () => {
  it("names the statuses", () => {
    // what React Router hands the boundary for a thrown `data(…, { status })` (an ErrorResponse)
    const thrown = (status: number) => ({ status, statusText: "", internal: false, data: null });
    expect(errorKind(thrown(404), true)).toEqual({ status: 404, kind: "notFound" });
    expect(errorKind(thrown(403), true)).toEqual({ status: 403, kind: "forbidden" });
    expect(errorKind(thrown(401), true)).toEqual({ status: 401, kind: "forbidden" });
    expect(errorKind(thrown(503), true)).toEqual({ status: 503, kind: "unavailable" });
    expect(errorKind(thrown(500), true)).toEqual({ status: 500, kind: "error" });
    // a status from the store stays itself even while the browser thinks it is offline
    expect(errorKind(thrown(404), false).kind).toBe("notFound");
  });

  it("never calls a request that never reached the store a 500", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isNetworkFailure(new TypeError("Load failed"))).toBe(true);
    expect(isNetworkFailure(new TypeError("x is not a function"))).toBe(false);
    expect(errorKind(new TypeError("Failed to fetch"), true).kind).toBe("offline");
    expect(errorKind(new Error("boom"), false).kind).toBe("offline");
    expect(errorKind(new Error("boom"), true)).toEqual({ status: 500, kind: "error" });
  });
});

describe("footer", () => {
  it("links every policy page the content area publishes, each once", () => {
    const linked = Object.values(FOOTER_POLICIES).flat();
    expect([...linked].sort()).toEqual([...POLICY_SLUGS].sort());
    expect(new Set(linked).size).toBe(linked.length);
  });

  it("the one-line footer of checkout and task flows: returns, privacy, terms, support", () => {
    expect([...TASK_FOOTER_LINKS]).toEqual(["/policies/returns", "/policies/privacy", "/policies/terms", "/support"]);
  });
});
