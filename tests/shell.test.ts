/**
 * Storefront shell decisions (app/routes/storefront/shell/chrome.ts, Design System v2 §5) — pure, no database:
 *   · the language links' query string is spelled as React Router's server spells it, so they hydrate unchanged;
 *   · which shell a page gets from its route handles (store · checkout · task), when the tab bar is drawn, when the
 *     header becomes the task header, and that an error page ignores the failed page's handle;
 *   · where the task header's back key leads without history; which tab a page belongs to;
 *   · the checkout bar's step rail from `?step=`;
 *   · what a platform's mega menu lists (the cross-platform games category leaves navigation, five links at most);
 *   · what a search suggestion points at; the categories sheet's departments; which error panel a failure gets
 *     (offline is never a 500 — and the panel's offline words are the root boundary's `errors.offline`);
 *   · what the offline banner says (form wording on checkout, task flows and /account; the cart elsewhere);
 *   · the product 404: the slug's words, and the platform they name;
 *   · the footer links every policy page the content area publishes;
 *   · the mega menu's words (short model names, counts, the featured product's price, one string per platform);
 *   · v2.1: which pages show the header's search field and which only the round search key (by path, every width);
 *     the catalogue's qualifier on its own meta line (search suggestions, the mega menu's links and featured card);
 *     a device model's photo on its mega-menu link when the read layer sends one;
 *   · a focused field is moved out from under a bar; the task header's title is cut between words; the exchange
 *     rate keeps «figure, then currency» in every language; the Sorani strings spell the brand «طمطم».
 */
import { describe, expect, it } from "vitest";
import errorMessages from "~/i18n/messages/errors";
import shellMessages from "~/i18n/messages/shell";
import uiMessages from "~/i18n/messages/ui";
import { makeT } from "~/i18n/translate";
import { LOCALE_CODES, switchLocalePath } from "~/lib/locales";
import { POLICY_SLUGS } from "~/routes/storefront/content/content-model";
import {
  backFallback,
  canonicalSearch,
  checkoutRail,
  clampWords,
  errorKind,
  focusNudge,
  FOOTER_POLICIES,
  isNetworkFailure,
  MEGA_LINKS,
  megaFeature,
  megaPlan,
  megaWords,
  missingProduct,
  platformForQuery,
  rateText,
  searchMode,
  sheetCategories,
  shellChrome,
  suggestionKind,
  suggestionMeta,
  tabOf,
  TASK_FOOTER_LABELS,
  TASK_FOOTER_LINKS,
} from "~/routes/storefront/shell/chrome";
import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { NavCategory, NavFeatured, NavPlatform } from "~/routes/storefront/shell/types";

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
  // `offline`: the offline banner's words (added 2026-11-12 — every expectation below names them on purpose)
  const store = { chrome: "store", tabBar: true, task: false, back: null, offline: "store" };

  it("store pages: the tab bar, no task header", () => {
    expect(shellChrome([root, layout, page])).toEqual(store);
    expect(shellChrome([])).toEqual(store);
    expect(shellChrome([root, layout, page], { path: "/support" })).toEqual(store);
  });

  it("a page with its own task bar keeps the drawn tab bar (it gives way by CSS, so an empty cart keeps it) and gets the task header", () => {
    expect(shellChrome([root, layout, product])).toEqual({ chrome: "store", tabBar: true, task: true, back: null, offline: "store" });
    expect(shellChrome([root, layout, cart], { path: "/cart" })).toEqual({ chrome: "store", tabBar: true, task: true, back: null, offline: "store" });
  });

  it("checkout: one bar, no tab bar, no task header — from its handle, and on /checkout before the handle says so", () => {
    expect(shellChrome([root, layout, declaredCheckout])).toEqual({ chrome: "checkout", tabBar: false, task: false, back: null, offline: "form" });
    expect(shellChrome([root, layout, checkout], { path: "/checkout" })).toEqual({ chrome: "checkout", tabBar: false, task: false, back: "/cart", offline: "form" });
    expect(shellChrome([root, layout, checkout], { path: "/checkout/" })).toMatchObject({ chrome: "checkout" });
    // the cart and the order page are store pages
    expect(shellChrome([root, layout, cart], { path: "/cart" }).chrome).toBe("store");
    expect(shellChrome([root, layout, page], { path: "/order/TT-1" }).chrome).toBe("store");
    expect(shellChrome([root, layout, page], { path: "/checkouts" }).chrome).toBe("store");
  });

  it("task flows: the store header (task header after scroll), no tab bar", () => {
    expect(shellChrome([root, layout, tradeIn], { path: "/trade-in" })).toEqual({ chrome: "task", tabBar: false, task: true, back: null, offline: "form" });
  });

  it("the offline banner keeps its word to forms: checkout, task flows and /account say what was typed stays; elsewhere the cart", () => {
    const login = { id: "routes/storefront/account/login", handle: undefined };
    const orders = { id: "routes/storefront/account/orders", handle: undefined };
    expect(shellChrome([root, layout, login], { path: "/account/login" }).offline).toBe("form");
    expect(shellChrome([root, layout, orders], { path: "/account/orders" }).offline).toBe("form");
    expect(shellChrome([root, layout, orders], { path: "/account" }).offline).toBe("form");
    expect(shellChrome([root, layout, page], { path: "/accounts" }).offline).toBe("store");
    expect(shellChrome([root, layout, page], { path: "/wishlist" }).offline).toBe("store");
    expect(shellChrome([root, layout, product], { path: "/p/nintendo-switch-2" }).offline).toBe("store");
    // a page says so itself: a store page built around a form, or an account page with nothing to type
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { offline: "form" } } }], { path: "/track" }).offline).toBe("form");
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { offline: "store" } } }], { path: "/account/warranties" }).offline).toBe("store");
    expect(shellChrome([root, layout, { id: "x", handle: { shell: { offline: "loud" } } }], { path: "/support" }).offline).toBe("store");
    // an error page has no form on screen
    expect(shellChrome([root, layout, login], { errored: true, path: "/account/login" }).offline).toBe("store");
    expect(shellChrome([root, layout, checkout], { errored: true, path: "/checkout" }).offline).toBe("store");
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

  it("names device models by their short model names, never SKU titles, and gives every link the read layer's count (§5.4)", () => {
    const plan = megaPlan({
      ...PLATFORM,
      devices: [
        { label: "PlayStation 5 (الطراز الأصلي 2020)", href: "/device/ps5", short: "PS5 (2020)", count: 37 },
        { label: "PlayStation 5 Digital Edition (الطراز الأصلي 2020)", href: "/device/ps5-digital", short: "PS5 Digital (2020)", count: 17 },
        { label: "PlayStation 5 Slim Digital Edition", href: "/device/ps5-slim-digital", short: "PS5 Slim Digital", count: 35 },
        { label: "PlayStation Portal", href: "/device/ps-portal", short: "PlayStation Portal", count: 8 },
      ],
      accessories: [{ label: "أيدي التحكم", href: "/c/controllers?platform=playstation", count: 3 }],
      used: { label: "PlayStation", href: "/used?platform=playstation", count: 1 },
    });
    expect(plan.devices.map((link) => link.label)).toEqual(["PS5 (2020)", "PS5 Digital (2020)", "PS5 Slim Digital", "PlayStation Portal"]);
    // the full name stays for the pointer's tooltip; a short name that IS the name needs none
    expect(plan.devices[1]).toEqual({ label: "PS5 Digital (2020)", full: "PlayStation 5 Digital Edition (الطراز الأصلي 2020)", href: "/device/ps5-digital", count: 17 });
    expect(plan.devices[3]).toEqual({ label: "PlayStation Portal", href: "/device/ps-portal", count: 8 });
    expect(plan.accessories[0]).toEqual({ label: "أيدي التحكم", href: "/c/controllers?platform=playstation", count: 3 });
    expect(plan.used).toEqual({ href: "/used?platform=playstation", count: 1 });
    // no count in the data: none shown (never invented)
    expect(megaPlan(PLATFORM).devices[0]).toEqual({ label: "ps5-pro", href: "/device/ps5-pro", count: null });
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
    expect(plan.used).toEqual({ href: "/used?platform=playstation", count: null });
    expect(megaPlan({ ...PLATFORM, used: null, allConsoles: null })).toMatchObject({ used: null, allDevices: null });
  });

  const FEATURED: NavFeatured = {
    productId: "prd_steam-deck-oled",
    href: "/p/steam-deck-oled",
    label: "Steam Deck OLED",
    image: { artKey: "steam-deck-oled--1", mediaKey: null, alt: "", isIllustration: false },
    priceIqd: 781500,
    stock: "in_stock",
    hasVariants: true,
    isDemo: true,
  };
  const none = () => null;

  it("features the read layer's product: its photo, name, price, state and demo flag (§5.4 «its name and price»)", () => {
    // `qualifier` (2026-11-12, v2.1): the words the Latin title leaves out, null when the read layer has none
    expect(megaFeature({ ...PLATFORM, featured: FEATURED }, none)).toEqual({
      href: "/p/steam-deck-oled",
      label: "Steam Deck OLED",
      qualifier: null,
      artKey: "steam-deck-oled--1",
      mediaKey: null,
      priceIqd: 781500,
      stock: "in_stock",
      isDemo: true,
    });
    expect(megaFeature({ ...PLATFORM, featured: { ...FEATURED, stock: "out_of_stock", isDemo: false } }, none)).toMatchObject({ stock: "out_of_stock", isDemo: false });
    // an uploaded picture, or none: the catalogue photo of the product, never the glyph while one exists
    expect(megaFeature({ ...PLATFORM, featured: { ...FEATURED, image: { ...FEATURED.image, artKey: null, mediaKey: "m/1.webp" } } }, none)).toMatchObject({ artKey: null, mediaKey: "m/1.webp" });
    expect(megaFeature({ ...PLATFORM, featured: { ...FEATURED, image: { ...FEATURED.image, artKey: null } } }, (slug) => `${slug}--2`)).toMatchObject({ artKey: "steam-deck-oled--2" });
    // the read layer says there is nothing to feature
    expect(megaFeature({ ...PLATFORM, featured: null }, none)).toBeNull();
  });

  it("prints the featured product's qualifier on its own meta line, never inside the Latin name (v2.1 follow-up)", () => {
    const disc = megaFeature({ ...PLATFORM, featured: { ...FEATURED, label: "PlayStation 5 Slim · 1TB", qualifier: "نسخة الأقراص" } }, none);
    expect(disc).toMatchObject({ label: "PlayStation 5 Slim · 1TB", qualifier: "نسخة الأقراص" });
    expect(megaFeature({ ...PLATFORM, featured: { ...FEATURED, qualifier: "  " } }, none)?.qualifier).toBeNull();
    // hand-written data: the console link's qualifier comes along
    const withConsole: NavPlatform = { ...PLATFORM, consoles: [{ label: "PlayStation 5 Slim · 1TB", href: "/p/playstation-5-slim", qualifier: "نسخة الأقراص" }] };
    expect(megaFeature(withConsole, none)).toMatchObject({ label: "PlayStation 5 Slim · 1TB", qualifier: "نسخة الأقراص" });
  });

  it("carries a product link's qualifier and a device model's photo when the read layer sends them (well-formed keys only)", () => {
    const plan = megaPlan({
      ...PLATFORM,
      devices: [
        { label: "PlayStation 5 Pro", href: "/device/ps5-pro", short: "PS5 Pro", artKey: "playstation-5-pro--1" } as NavPlatform["devices"][number],
        { label: "PlayStation Portal", href: "/device/ps-portal", artKey: "../evil.png" } as NavPlatform["devices"][number],
      ],
      games: [{ label: "ألعاب PlayStation", href: "/c/playstation-games", qualifier: " نسخة الأقراص " }],
    });
    expect(plan.devices[0]).toMatchObject({ label: "PS5 Pro", art: "playstation-5-pro--1" });
    expect(plan.devices[1].art).toBeUndefined();
    expect(plan.games[0].qualifier).toBe("نسخة الأقراص");
    expect(megaPlan(PLATFORM).devices[0]).not.toHaveProperty("art");
  });

  it("without the read layer's pick: the product whose photo leads the platform, else the first console that HAS a photo", () => {
    expect(megaFeature(PLATFORM, none)).toMatchObject({ href: "/p/playstation-5-slim", label: "PlayStation 5 Slim (نسخة الأقراص) – 1TB", artKey: "playstation-5-slim--1", priceIqd: null });
    // the handheld menu showed a controller glyph for «ROG Xbox Ally X20», which has photos
    const handheld: NavPlatform = {
      ...PLATFORM,
      artKey: "steam-deck-oled--1",
      consoles: [
        { label: "ROG Xbox Ally X20", href: "/p/rog-xbox-ally-x20" },
        { label: "MSI Claw 8 EX AI+", href: "/p/msi-claw-8-ex-ai-plus" },
      ],
    };
    const photos: Record<string, string> = { "rog-xbox-ally-x20": "rog-xbox-ally-x20--1", "msi-claw-8-ex-ai-plus": "msi-claw-8-ex-ai-plus--1" };
    expect(megaFeature(handheld, (slug) => photos[slug] ?? null)).toMatchObject({ href: "/p/rog-xbox-ally-x20", artKey: "rog-xbox-ally-x20--1" });
    expect(megaFeature(handheld, (slug) => (slug === "msi-claw-8-ex-ai-plus" ? photos[slug] : null))).toMatchObject({ href: "/p/msi-claw-8-ex-ai-plus", artKey: "msi-claw-8-ex-ai-plus--1" });
    // no console has a photo: the newest console, with the glyph
    expect(megaFeature(handheld, none)).toMatchObject({ href: "/p/rog-xbox-ally-x20", artKey: null });
    expect(megaFeature({ ...PLATFORM, consoles: [] }, none)).toBeNull();
  });
});

describe("megaWords — one string per platform (v2 §9: the hub rail's «أجهزة أجهزة محمولة» defect)", () => {
  const nameOf = (locale: (typeof LOCALE_CODES)[number], slug: string) => ((uiMessages[locale] as { platform: Record<string, string> }).platform[slug] ?? slug);

  it("never doubles the handheld platform's noun, in any language", () => {
    const expected = {
      ar: { allDevices: "كل الأجهزة المحمولة", usedOf: "الأجهزة المحمولة المستعملة" },
      en: { allDevices: "All handheld PCs", usedOf: "Used handheld PCs" },
    } as const;
    for (const locale of LOCALE_CODES) {
      const t = makeT(shellMessages[locale], locale, "shell");
      const words = megaWords(t, "handheld", nameOf(locale, "handheld"));
      if (locale in expected) expect(words, locale).toEqual(expected[locale as keyof typeof expected]);
      for (const text of Object.values(words)) {
        expect(text, locale).not.toMatch(/أجهزة الأجهزة|Handheld PCs (consoles|devices)|ئامێرەکانی ئامێرە|ئامێری بەکارهاتووی ئامێرە/);
        expect(text, locale).not.toContain("{");
      }
    }
  });

  it("names the brand platforms by their Latin names; an unknown platform takes the generic template", () => {
    const ar = makeT(shellMessages.ar, "ar", "shell");
    expect(megaWords(ar, "playstation", "PlayStation")).toEqual({ allDevices: "كل أجهزة PlayStation", usedOf: "أجهزة PlayStation المستعملة" });
    const en = makeT(shellMessages.en, "en", "shell");
    expect(megaWords(en, "xbox", "Xbox")).toEqual({ allDevices: "All Xbox consoles", usedOf: "Used Xbox devices" });
    expect(megaWords(en, "sega", "Sega")).toEqual({ allDevices: "All Sega consoles", usedOf: "Used Sega devices" });
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

describe("suggestionMeta — a product suggestion's meta line", () => {
  it("puts the qualifier first, then the kind, else the department — never inside the name", () => {
    expect(suggestionMeta({ qualifier: "نسخة الأقراص", kindLabel: "جهاز PS5", hint: "الأجهزة" })).toBe("نسخة الأقراص · جهاز PS5");
    expect(suggestionMeta({ kindLabel: "جهاز PS5", hint: "الأجهزة" })).toBe("جهاز PS5");
    expect(suggestionMeta({ hint: "الأجهزة" })).toBe("الأجهزة");
    expect(suggestionMeta({ qualifier: "الطراز الأصلي" })).toBe("الطراز الأصلي");
    expect(suggestionMeta({ qualifier: " ", kindLabel: "", hint: "" })).toBe("");
    expect(suggestionMeta({})).toBe("");
  });
});

describe("searchMode — the header's search field, or only the round search key (v2.1 §2.7, client note 9)", () => {
  it("keeps the field on the pages for finding products", () => {
    for (const path of ["/", "/platform/playstation", "/c/controllers", "/search", "/compare", "/p/nintendo-switch-2", "/device/ps5-pro", "/used", "/used/ps5-slim-a12", "/pages/eid"]) {
      expect(searchMode(path), path).toBe("field");
    }
  });

  it("shows only the key where finding products is not the page's job: cart, checkout, orders, support, trade-in, account, the store's pages", () => {
    for (const path of [
      "/cart",
      "/checkout",
      "/order/TT-1042",
      "/track",
      "/support",
      "/support/repair",
      "/support/article/hdmi",
      "/trade-in",
      "/trade-in/TI-77",
      "/account",
      "/account/orders",
      "/wishlist",
      "/about",
      "/contact",
      "/policies",
      "/policies/returns",
      "/accessibility",
      "/design-system",
      "/motion",
    ]) {
      expect(searchMode(path), path).toBe("key");
    }
  });

  it("matches whole path segments only, and every error page keeps the field (the 404's one search field is the header's)", () => {
    expect(searchMode("/cartography")).toBe("field");
    expect(searchMode("/supporters")).toBe("field");
    expect(searchMode("/cart", { errored: true })).toBe("field");
    expect(searchMode("/support/nothing-here", { errored: true })).toBe("field");
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
    // in the browser (the third argument; these tests run in Node, where it defaults to false)
    expect(errorKind(new TypeError("Failed to fetch"), true, true).kind).toBe("offline");
    expect(errorKind(new Error("boom"), false, true).kind).toBe("offline");
    expect(errorKind(new Error("boom"), true, true)).toEqual({ status: 500, kind: "error" });
  });

  it("on the server a fetch TypeError is the store's own failure (an upstream it called), as in the root boundary", () => {
    expect(errorKind(new TypeError("fetch failed"), true, false)).toEqual({ status: 500, kind: "error" });
    expect(errorKind(new TypeError("Failed to fetch"), true)).toEqual({ status: 500, kind: "error" });
    // Node's own words for a failed server-side fetch reach the browser in development: still the store's failure
    expect(isNetworkFailure(new TypeError("fetch failed"))).toBe(false);
    expect(errorKind(new TypeError("fetch failed"), true, true)).toEqual({ status: 500, kind: "error" });
    expect(isNetworkFailure(new TypeError("Failed to fetch dynamically imported module: /app/x.tsx"))).toBe(true);
    expect(isNetworkFailure(new TypeError("The network connection was lost."))).toBe(true);
  });

  it("the offline panel says the root boundary's sentence word for word (errors.offline), in every language", () => {
    for (const locale of LOCALE_CODES) {
      const error = shellMessages[locale].error as Record<string, string>;
      const errors = errorMessages[locale].errors as Record<string, string>;
      expect(`${error.offlineTitle}. ${error.offlineText}`, locale).toBe(errors.offline);
    }
  });
});

describe("shell copy (v2 §9)", () => {
  it("names the payable amount «الإجمالي», never «المجموع», when the total changed under the shopper", () => {
    const ar = errorMessages.ar.errors as Record<string, string>;
    expect(ar.totals_changed).toContain("الإجمالي");
    expect(ar.totals_changed).not.toContain("المجموع");
  });

  it("gives the demo rate's source in the page's language (the seed stores one Arabic sentence)", () => {
    const arabicScript = /[؀-ۿ]/;
    expect((shellMessages.en.currency as Record<string, string>).demoSource).not.toMatch(arabicScript);
    expect((shellMessages.ckb.currency as Record<string, string>).demoSource).not.toBe((shellMessages.ar.currency as Record<string, string>).demoSource);
  });
});

describe("missingProduct / platformForQuery — the product 404 (v2 §6.16)", () => {
  const thrown = (status: number, data: unknown) => ({ status, statusText: "", internal: false, data });

  it("reads the slug's words from the product page's 404, and nothing else", () => {
    expect(missingProduct(thrown(404, { error: "not_found", what: "product", query: "god of war laufey" }))).toBe("god of war laufey");
    expect(missingProduct(thrown(404, { error: "not_found", what: "product", query: "  ps5   pro  " }))).toBe("ps5 pro");
    expect(missingProduct(thrown(404, { error: "not_found", what: "product" }))).toBe("");
    expect(missingProduct(thrown(404, { error: "not_found" }))).toBeNull();
    expect(missingProduct(thrown(404, null))).toBeNull();
    expect(missingProduct(thrown(500, { what: "product", query: "x" }))).toBeNull();
    expect(missingProduct(new Error("boom"))).toBeNull();
  });

  const NINTENDO: NavPlatform = {
    ...PLATFORM,
    id: "p2",
    slug: "nintendo",
    name: "نينتندو",
    accent: "nintendo",
    artKey: null,
    href: "/platform/nintendo",
    devices: [{ label: "Nintendo Switch 2", href: "/device/nintendo-switch-2" }],
    consoles: [{ label: "Nintendo Switch 2", href: "/p/nintendo-switch-2" }],
  };
  const HANDHELD: NavPlatform = {
    ...PLATFORM,
    id: "p3",
    slug: "handheld",
    name: "الأجهزة المحمولة",
    accent: "handheld",
    artKey: null,
    href: "/platform/handheld",
    devices: [{ label: "Steam Deck OLED", href: "/device/steam-deck-oled" }],
    consoles: [],
  };
  const platforms = [NINTENDO, PLATFORM, HANDHELD];

  it("names the platform by its slug, a device hub or a console — whole words only", () => {
    expect(platformForQuery("playstation 5 pro limited", platforms)?.slug).toBe("playstation");
    expect(platformForQuery("ps5 pro 2tb", platforms)?.slug).toBe("playstation");
    expect(platformForQuery("nintendo switch 2 mario kart bundle", platforms)?.slug).toBe("nintendo");
    expect(platformForQuery("Steam Deck OLED 1TB", platforms)?.slug).toBe("handheld");
    expect(platformForQuery("god of war laufey", platforms)).toBeNull();
    expect(platformForQuery("xps5 cable", platforms)).toBeNull();
    expect(platformForQuery("", platforms)).toBeNull();
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

  it("names the support link with the navigation term «الدعم» / Support — «مركز الدعم» is the page's title (§5.8, §9)", () => {
    const words = Object.fromEntries(LOCALE_CODES.map((locale) => [locale, makeT(shellMessages[locale], locale, "shell")(TASK_FOOTER_LABELS["/support"])]));
    expect(words).toEqual({ ar: "الدعم", en: "Support", ckb: "پشتگیری" });
    for (const to of TASK_FOOTER_LINKS) expect(makeT(shellMessages.ar, "ar", "shell")(TASK_FOOTER_LABELS[to]), to).not.toBe(TASK_FOOTER_LABELS[to]);
  });
});

describe("brand and demo words (v2 §9 glossary, §13)", () => {
  it("spells the brand «طمطم» in Sorani as in the logo — never «تەمتەم» — until the owner decides (§13 item 12)", () => {
    expect(JSON.stringify(shellMessages.ckb)).not.toContain("تەمتەم");
    expect(JSON.stringify(errorMessages.ckb)).not.toContain("تەمتەم");
    const meta = shellMessages.ckb.meta as Record<string, string>;
    expect(meta.titleTemplate).toBe("{title} — طمطم");
    expect(meta.siteName).toContain("طمطم");
  });

  it("the checkout bar's tag is the glossary's «طلب تجريبي» / Demo order at every width — no short «تجريبي»", () => {
    expect((shellMessages.ar.demo as Record<string, string>).order).toBe("طلب تجريبي");
    expect((shellMessages.en.demo as Record<string, string>).order).toBe("Demo order");
    for (const locale of LOCALE_CODES) expect(shellMessages[locale].demo, locale).not.toHaveProperty("orderShort");
  });
});

describe("focusNudge — a focused field is never left under a bar (WCAG 2.4.11)", () => {
  // the transaction audit: «ملاحظات للمندوب» at 689–801, the checkout task bar from 772 — the browser did not scroll
  // a field that was already partly in view
  const edges = { top: 56, bottom: 772 };

  it("scrolls down by the overlap with the bottom bar plus 12px", () => {
    expect(focusNudge({ top: 689, bottom: 801 }, edges)).toBe(801 - 772 + 12);
  });

  it("scrolls up by the overlap with the header plus 12px", () => {
    expect(focusNudge({ top: 40, bottom: 92 }, edges)).toBe(40 - 56 - 12);
  });

  it("leaves a field between the bars where it is", () => {
    expect(focusNudge({ top: 56, bottom: 772 }, edges)).toBe(0);
    expect(focusNudge({ top: 300, bottom: 352 }, edges)).toBe(0);
  });

  it("a field taller than the room between the bars keeps its top in view (never pushed under the header)", () => {
    expect(focusNudge({ top: 100, bottom: 900 }, edges)).toBe(100 - 56 - 12);
    expect(focusNudge({ top: 60, bottom: 900 }, edges)).toBe(0);
  });
});

describe("clampWords — the task header's title, cut between words at its logical end", () => {
  // a fake measure: a candidate fits when it has at most `n` characters
  const upTo = (n: number) => (candidate: string) => candidate.length <= n;
  const title = "قاعدة الشحن DualSense Charging Station";

  it("keeps a title that fits", () => {
    expect(clampWords(title, upTo(80))).toBe(title);
  });

  it("drops whole words from the end and adds «…» — never a cut inside the Latin name («…lSense»)", () => {
    expect(clampWords(title, upTo(24))).toBe("قاعدة الشحن DualSense…");
    expect(clampWords(title, upTo(21))).toBe("قاعدة الشحن…");
    expect(clampWords("PlayStation 5 Pro Digital Edition", upTo(20))).toBe("PlayStation 5 Pro…");
  });

  it("a first word that does not fit is left to the CSS ellipsis", () => {
    expect(clampWords("Supercalifragilistic expialidocious", upTo(5))).toBe("Supercalifragilistic expialidocious");
  });

  it("never stops inside brackets: the bracket goes with the words it opens", () => {
    // Sorani: «DualSense Charging Station (وێستگەی…» read as a broken bracket
    expect(clampWords("DualSense Charging Station (وێستگەی شەحن)", upTo(37))).toBe("DualSense Charging Station…");
    expect(clampWords("PlayStation 5 Slim (نسخة الأقراص) – 1TB", upTo(36))).toBe("PlayStation 5 Slim (نسخة الأقراص)…");
  });

  it("never ends on a joiner or a colon before the «…»", () => {
    expect(clampWords("Pokémon Legends: Z-A – Nintendo Switch 2 Edition", upTo(17))).toBe("Pokémon Legends…");
    expect(clampWords("Nintendo Switch 2 + Mario Kart World", upTo(20))).toBe("Nintendo Switch 2…");
  });
});

describe("rateText — the exchange rate keeps «figure, then currency» (§2.6)", () => {
  it("isolates only the foreign side; the dinar amount takes its own direction, the figure first, joined by a no-break space", () => {
    expect(rateText("1,310", "د.ع")).toBe("⁦1 USD⁩ = ⁨1,310 د.ع⁩");
    expect(rateText("1,310", "IQD")).toBe("⁦1 USD⁩ = ⁨1,310 IQD⁩");
  });

  it("the dinar side never sits inside the left-to-right isolate (it put «د.ع» before the figure in Arabic)", () => {
    const text = rateText("1,310", "د.ع");
    const ltr = text.slice(text.indexOf("⁦"), text.indexOf("⁩") + 1);
    expect(ltr).not.toContain("د.ع");
    expect(text.indexOf("1,310")).toBeLessThan(text.indexOf("د.ع"));
  });
});
