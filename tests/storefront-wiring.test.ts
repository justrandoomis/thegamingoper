/**
 * The storefront reading what the content module (admin 17) and the support module (admin 14) store — against a real
 * local D1 with the demo catalogue:
 *
 *   redirects        findStoreRedirect / safeRedirectTarget: a same-site storefront path only, whatever a row holds
 *                    (another host, /admin, /api, a loop and a chain refused); the visitor's language prefix
 *   navigation       arrangeNav / getArrangedNav: the staff's order, hidden ones out, `featured`
 *   banners          bannerHref / getStoreBanners: never demo, never a link the store cannot open
 *   landing pages    the sitemap lists live ones (not demo, noindex or ended ones)
 *   home             homeLayoutOf, pinnedHero, featuredHero and getHomeData with a pinned hero
 *   listing filters  filterOrderOf (null until arranged) and the panel's order (panelOrder)
 *   support          lookupTicket, rateTicket, ticketOrderOf, the hand-off linked to an order, routing on arrival
 *
 * Fixture rows are written straight into the tables (as a hostile or careless row could be): the CMS's own rules would
 * refuse most of them, which is the point — the store must not trust the row.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { publicRef, randomToken } from "~/lib/ids";
import type { ProductCardData } from "~/lib/dto";
import { panelOrder } from "~/routes/storefront/catalog/components/FilterPanel";
import { categoryCmsOf, filterOrderOf } from "~/routes/storefront/catalog/list.server";
import { FILTER_GROUPS } from "~/routes/storefront/catalog/listing-model";
import { featuredHero } from "~/routes/storefront/home/view";
import { seedDemo } from "~/server/db/seed/demo";
import { isAppError } from "~/server/errors";
import { HOME_SECTIONS, LISTING_FILTER_GROUPS } from "~/server/services/admin/cms/rules";
import { getNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
import { arrangeNav, bannerHref, findStoreRedirect, getArrangedNav, getSitemapEntries, getStoreBanners, landingPath, safeRedirectTarget } from "~/server/services/content.server";
import { getHomeData, HOME_PAGE_SECTIONS, homeLayoutOf, pinnedHero } from "~/server/services/home.server";
import { handOffToStaff } from "~/server/services/support/assistant.server";
import { accessTokenHash, type SupportWho } from "~/server/services/support/common.server";
import { routeOnArrival } from "~/server/services/support/routing.server";
import { EMPTY_ASSISTANT_STATE } from "~/server/services/support/state";
import { getTicketByAccessToken, lookupTicket, rateTicket, ticketOrderOf } from "~/server/services/support/tickets.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures } from "./helpers/factories";

let t: TestDb;
let seq = 0;
const uid = (prefix: string) => `${prefix}_wiring_${Date.now().toString(36)}_${++seq}`;
const run = (query: string, ...params: unknown[]) => t.d1.prepare(query).bind(...params).run();
const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;

let ipCounter = 0;
const who = (overrides: Partial<SupportWho> = {}): SupportWho => ({ customerId: null, ip: `203.0.113.${++ipCounter}`, storeMode: "demo", ...overrides });
let phoneCounter = 0;
const freshPhone = () => `07702${String(100_000 + ++phoneCounter).slice(-6)}`;
const e164 = (local: string) => `+964${local.slice(1)}`;

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
}, 120_000);

afterAll(async () => {
  await t?.dispose();
});

async function redirectRow(fromPath: string, toPath: string, options: { code?: number; active?: boolean } = {}) {
  await run("INSERT INTO redirects (id, from_path, to_path, code, is_active, hits, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)", uid("rdr"), fromPath, toPath, options.code ?? 301, options.active === false ? 0 : 1, t.now);
}

// ───────────────────────────────────────────────────────────────── redirects

describe("redirects: a same-site storefront path only, whatever the row holds", () => {
  test("safeRedirectTarget (pure)", () => {
    expect(safeRedirectTarget("/c/controllers", "/old")).toEqual({ path: "/c/controllers", query: "" });
    expect(safeRedirectTarget("/C/Controllers/?platform=xbox", "/old")).toEqual({ path: "/c/controllers", query: "?platform=xbox" });
    // the language prefix of a stored target is dropped (the visitor's is added)
    expect(safeRedirectTarget("/en/p/x", "/old")).toEqual({ path: "/p/x", query: "" });
    // the store's own address is the path it names; another host never is a destination
    expect(safeRedirectTarget("https://tamtamgames.com/p/x", "/old")).toEqual({ path: "/p/x", query: "" });
    expect(safeRedirectTarget("https://preview.example.dev/p/x", "/old", ["https://preview.example.dev"])).toEqual({ path: "/p/x", query: "" });
    for (const hostile of ["https://evil.example/p/x", "http://evil.example", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "data:text/html,x", "p/x", "", "  "]) {
      expect(safeRedirectTarget(hostile, "/old"), hostile).toBeNull();
    }
    for (const reserved of ["/admin", "/admin/orders", "/api/cart", "/en/admin/x", "/ckb/en/admin", "/sitemap.xml", "https://tamtamgames.com/admin/x"]) {
      expect(safeRedirectTarget(reserved, "/old"), reserved).toBeNull();
    }
    // a loop on itself, whatever its query or language prefix
    expect(safeRedirectTarget("/old?x=1", "/old")).toBeNull();
    expect(safeRedirectTarget("/old", "/en/old")).toBeNull();
    expect(safeRedirectTarget(42, "/old")).toBeNull();
  });

  test("a row's target becomes the visitor's same-site location; hostile rows are refused", async () => {
    const [category] = await rows<{ slug: string }>("SELECT slug FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
    await redirectRow("/wiring-old-cat", `/c/${category.slug}`);
    await redirectRow("/wiring-temp", "/c/controllers?platform=xbox", { code: 302 });
    await redirectRow("/wiring-ext", "https://evil.example/steal");
    await redirectRow("/wiring-admin", "/admin/orders");
    await redirectRow("/wiring-api", "/api/cart");
    await redirectRow("/wiring-loop-a", "/wiring-loop-b");
    await redirectRow("/wiring-loop-b", "/wiring-loop-a");
    await redirectRow("/wiring-chain-a", "/wiring-chain-b");
    await redirectRow("/wiring-chain-b", `/c/${category.slug}`);
    await redirectRow("/wiring-self", "/wiring-self?again=1");
    await redirectRow("/wiring-off", `/c/${category.slug}`, { active: false });
    await redirectRow("/wiring-arabic", "/c/ألعاب?q=بلايستيشن");

    expect(await findStoreRedirect(t.db, "/wiring-old-cat", "ar")).toMatchObject({ location: `/c/${category.slug}`, code: 301 });
    expect(await findStoreRedirect(t.db, "/en/wiring-old-cat", "en")).toMatchObject({ location: `/en/c/${category.slug}`, code: 301 });
    expect(await findStoreRedirect(t.db, "/ckb/Wiring-Old-Cat/", "ckb")).toMatchObject({ location: `/ckb/c/${category.slug}` });
    expect(await findStoreRedirect(t.db, "/wiring-temp", "ar")).toMatchObject({ location: "/c/controllers?platform=xbox", code: 302 });
    for (const path of ["/wiring-ext", "/wiring-admin", "/wiring-api", "/wiring-loop-a", "/wiring-loop-b", "/wiring-chain-a", "/wiring-self", "/wiring-off", "/no-such-path"]) {
      expect(await findStoreRedirect(t.db, path, "ar"), path).toBeNull();
    }
    // the second hop of a chain is a plain one-hop redirect
    expect(await findStoreRedirect(t.db, "/wiring-chain-b", "ar")).toMatchObject({ location: `/c/${category.slug}` });
    // non-ASCII targets travel percent-encoded (a header-safe Location)
    const arabic = await findStoreRedirect(t.db, "/wiring-arabic", "ar");
    expect(arabic?.location).toBe(`/c/${encodeURIComponent("ألعاب")}?q=${encodeURIComponent("بلايستيشن")}`);
    expect(/^[\x21-\x7e]+$/.test(arabic?.location ?? "")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── navigation

describe("navigation: the staff's arrangement over the catalogue's taxonomy", () => {
  test("arrangeNav orders, hides and features by slug; new entries follow; nothing arranged keeps the catalogue's order", async () => {
    const nav = await getNavTaxonomy(t.db, "ar", { now: t.now });
    expect(nav.platforms.length).toBeGreaterThan(2);
    const [first, second, third] = nav.platforms.map((platform) => platform.slug);
    const arranged = arrangeNav(nav, { platforms: [{ slug: third, hidden: false, featured: true }, { slug: first, hidden: true, featured: false }], categories: [] });
    expect(arranged.platforms.map((platform) => platform.slug)).toEqual([third, ...nav.platforms.map((platform) => platform.slug).filter((slug) => slug !== third && slug !== first)]);
    expect(arranged.platforms[0].featured).toBe(true);
    expect(arranged.platforms.some((platform) => platform.slug === first)).toBe(false);
    expect(arranged.platforms.find((platform) => platform.slug === second)?.featured).toBe(false);
    const plain = arrangeNav(nav, null);
    expect(plain.platforms.map((platform) => platform.slug)).toEqual(nav.platforms.map((platform) => platform.slug));
    expect(plain.categories.every((category) => category.featured === false)).toBe(true);
  });

  test("getArrangedNav reads the published arrangement (refs by id)", async () => {
    const nav = await getNavTaxonomy(t.db, "ar", { now: t.now });
    const platformRows = await rows<{ id: string; slug: string }>("SELECT id, slug FROM platforms WHERE is_active = 1");
    const last = nav.platforms[nav.platforms.length - 1];
    const lastId = platformRows.find((row) => row.slug === last.slug)!.id;
    const items = [{ ref: `platform:${lastId}`, label: { ar: last.name }, link: last.href, hidden: false, featured: true }];
    await run("INSERT INTO nav_menus (id, key, items, updated_at) VALUES (?, 'catalog', ?, ?) ON CONFLICT(key) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at", uid("nav"), JSON.stringify(items), t.now);
    // a later clock than any cached read of this database
    const arranged = await getArrangedNav(t.db, nav, t.now + 10 * 60_000);
    expect(arranged.platforms[0].slug).toBe(last.slug);
    expect(arranged.platforms[0].featured).toBe(true);
    expect(arranged.platforms).toHaveLength(nav.platforms.length);
    await run("DELETE FROM nav_menus WHERE key = 'catalog'");
  });
});

// ───────────────────────────────────────────────────────────────── banners

describe("banners: never demo, never a link the store cannot open", () => {
  test("bannerHref (pure)", () => {
    expect(bannerHref("/c/controllers?platform=xbox")).toEqual({ kind: "path", to: "/c/controllers?platform=xbox" });
    expect(bannerHref("https://tamtamgames.com/en/p/x")).toEqual({ kind: "path", to: "/p/x" });
    expect(bannerHref("https://instagram.com/tamtam")).toEqual({ kind: "external", href: "https://instagram.com/tamtam" });
    for (const bad of ["/admin/cms", "/api/cart", "http://evil.example", "javascript:alert(1)", "//evil.example", "https://user:pass@evil.example", "not a link", ""]) expect(bannerHref(bad), bad).toBeNull();
  });

  test("getStoreBanners keeps live real banners with links the store can open", async () => {
    const [category] = await rows<{ id: string; slug: string }>("SELECT id, slug FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
    const banner = async (title: string, link: string | null, options: { demo?: boolean; placement?: string; sort?: number } = {}) => {
      const id = uid("bnr");
      await run(
        "INSERT INTO banners (id, placement, title, link, accent, sort, status, is_demo, updated_at) VALUES (?, ?, ?, ?, 'brand', ?, 'published', ?, ?)",
        id,
        options.placement ?? "home_strip",
        JSON.stringify({ ar: title, en: `${title} (en)` }),
        link,
        options.sort ?? 0,
        options.demo ? 1 : 0,
        t.now,
      );
      return id;
    };
    const live = await banner("حي", `/c/${category.slug}`, { sort: 1 });
    const words = await banner("كلمات فقط", null, { sort: 2 });
    await banner("تجريبي", `/c/${category.slug}`, { demo: true });
    const outside = await banner("إلى موقع آخر", "https://example.org/offer", { sort: 4 });
    await banner("إلى الإدارة", "/admin/orders", { sort: 5 });
    await banner("إلى موقع آخر بلا https", "http://evil.example/x", { sort: 6 });
    const shown = await getStoreBanners(t.db, "en", "home_strip", { now: t.now });
    expect(shown.map((entry) => entry.id)).toEqual([live, words, outside]);
    expect(shown[0]).toMatchObject({ title: "حي (en)", textLocale: "en", href: { kind: "path", to: `/c/${category.slug}` } });
    expect(shown[1].href).toBeNull();
    expect(shown[2].href).toEqual({ kind: "external", href: "https://example.org/offer" });
    // without the outside one, the CMS hands over the admin link next: the store leaves it out (and the http one)
    await run("UPDATE banners SET status = 'archived' WHERE id = ?", outside);
    expect((await getStoreBanners(t.db, "ar", "home_strip", { now: t.now })).map((entry) => entry.id)).toEqual([live, words]);
    // a category's own banner and the every-category one
    const own = await banner("قسم واحد", `/c/${category.slug}`, { placement: `category:${category.id}` });
    const every = await banner("كل الأقسام", null, { placement: "category_top" });
    expect((await getStoreBanners(t.db, "ar", "category_top", { now: t.now, categoryId: category.id })).map((entry) => entry.id).sort()).toEqual([own, every].sort());
    expect((await getStoreBanners(t.db, "ar", "category_top", { now: t.now, categoryId: "cat_other" })).map((entry) => entry.id)).toEqual([every]);
    // a link to a category switched off after publishing: the banner is left out (the CMS read re-checks it)
    await run("UPDATE categories SET is_active = 0 WHERE id = ?", category.id);
    expect((await getStoreBanners(t.db, "ar", "home_strip", { now: t.now })).map((entry) => entry.id)).not.toContain(live);
    await run("UPDATE categories SET is_active = 1 WHERE id = ?", category.id);
    await run("DELETE FROM banners WHERE id LIKE 'bnr_wiring_%'");
  });
});

// ───────────────────────────────────────────────────────────────── landing pages

describe("landing pages in the sitemap", () => {
  test("live pages are listed under /pages; demo, noindex, ended and text-less ones are not", async () => {
    const page = async (slug: string, options: { demo?: boolean; noindex?: boolean; endsAt?: number | null; blocks?: boolean } = {}) =>
      run(
        "INSERT INTO pages (id, slug, kind, title, body, seo, status, published_at, ends_at, is_demo, created_at, updated_at) VALUES (?, ?, 'landing', ?, ?, ?, 'published', ?, ?, ?, ?, ?)",
        uid("pg"),
        slug,
        JSON.stringify({ ar: `صفحة ${slug}` }),
        JSON.stringify({ ar: options.blocks === false ? [] : [{ type: "p", text: "نص الصفحة" }] }),
        JSON.stringify({ noindex: options.noindex === true }),
        t.now - 1000,
        options.endsAt ?? null,
        options.demo ? 1 : 0,
        t.now,
        t.now,
      );
    await page("wiring-live");
    await page("wiring-demo", { demo: true });
    await page("wiring-hidden", { noindex: true });
    await page("wiring-ended", { endsAt: t.now - 10 });
    await page("wiring-empty", { blocks: false });
    const paths = (await getSitemapEntries(t.db, t.now)).map((entry) => entry.path);
    expect(paths).toContain(landingPath("wiring-live"));
    for (const slug of ["wiring-demo", "wiring-hidden", "wiring-ended", "wiring-empty"]) expect(paths, slug).not.toContain(landingPath(slug));
    await run("DELETE FROM pages WHERE slug LIKE 'wiring-%'");
  });
});

// ───────────────────────────────────────────────────────────────── home

const card = (id: string, patch: Partial<ProductCardData> = {}): ProductCardData =>
  ({
    id,
    slug: id,
    name: id,
    subtitle: null,
    kind: "console",
    platformSlug: "playstation",
    platformName: "PlayStation",
    variantId: `${id}-v`,
    hasVariants: false,
    priceIqd: 100_000,
    compareAtIqd: null,
    stock: "in_stock",
    badge: null,
    image: { artKey: `${id}--1`, mediaKey: null, alt: "", isIllustration: false },
    rating: null,
    isDemo: true,
    ...patch,
  }) as ProductCardData;

describe("home: the staff's sections and pinned hero", () => {
  test("homeLayoutOf: the page's own order until arranged; then the staff's, the privacy panel always there", () => {
    expect(homeLayoutOf(null)).toEqual({ sections: [...HOME_PAGE_SECTIONS], arranged: false });
    expect(homeLayoutOf([...HOME_SECTIONS])).toEqual({ sections: [...HOME_PAGE_SECTIONS], arranged: false });
    expect(homeLayoutOf(["used", "games", "platforms", "deals", "personal"])).toEqual({ sections: ["used", "platforms", "personal"], arranged: true });
    expect(homeLayoutOf(["new_arrivals"]).sections).toEqual(["new_arrivals", "personal"]);
  });

  test("pinnedHero: only a buyable product with a photo; the page's language, else Arabic", () => {
    const cards = new Map<string, ProductCardData>([
      ["p1", card("p1")],
      ["out", card("out", { stock: "out_of_stock" })],
      ["bare", card("bare", { image: { artKey: null, mediaKey: null, alt: "", isIllustration: false } })],
    ]);
    const pin = (productId: string, headline: Record<string, string>, deck: Record<string, string> | null = null) => ({ pinId: "pin1", productId, headline: headline as { ar: string }, deck: deck as { ar: string } | null });
    expect(pinnedHero(pin("p1", { ar: "عرض", en: "Offer" }, { ar: "سطر", en: "Line" }), cards, "en")).toEqual({ productId: "p1", mode: "lead", releasedOn: null, pin: { pinId: "pin1", headline: "Offer", deck: "Line", textLocale: "en" } });
    expect(pinnedHero(pin("p1", { ar: "عرض" }, { ar: "سطر" }), cards, "ckb")?.pin).toEqual({ pinId: "pin1", headline: "عرض", deck: "سطر", textLocale: "ar" });
    expect(pinnedHero(pin("p1", { ar: "عرض", en: "Offer" }, { ar: "سطر" }), cards, "en")?.pin?.deck).toBeNull();
    expect(pinnedHero(pin("out", { ar: "عرض" }), cards, "ar")).toBeNull();
    expect(pinnedHero(pin("bare", { ar: "عرض" }), cards, "ar")).toBeNull();
    expect(pinnedHero(pin("missing", { ar: "عرض" }), cards, "ar")).toBeNull();
    expect(pinnedHero(undefined, cards, "ar")).toBeNull();
  });

  test("featuredHero: a pinned platform first (the featured one's pin, else the first pinned)", () => {
    const platform = (slug: string, pinned: boolean) => ({ slug, hero: { productId: `${slug}-p`, pin: pinned ? { pinId: "x" } : null }, newArrivals: [] });
    expect(featuredHero([platform("nintendo", false), platform("xbox", true)])?.slug).toBe("xbox");
    expect(featuredHero([platform("xbox", true), platform("nintendo", true)])?.slug).toBe("nintendo");
    expect(featuredHero([platform("xbox", false), platform("nintendo", false)])?.slug).toBe("nintendo");
  });

  test("getHomeData uses a live real pin whose product can be bought, and ignores demo and ended pins", async () => {
    const before = await getHomeData(t.db, { locale: "ar", now: t.now, extraShelves: false });
    const target = before.platforms.find((platform) => platform.hero && platform.newArrivals.some((id) => id !== platform.hero?.productId && before.cards[id]?.image.artKey));
    expect(target, "a platform with a hero and another photographed arrival").toBeTruthy();
    const productId = target!.newArrivals.find((id) => id !== target!.hero?.productId && before.cards[id]?.image.artKey)!;
    const pinRow = async (options: { demo?: boolean; endsAt?: number; headline?: string }) =>
      run(
        "INSERT INTO home_sections (id, kind, config, sort, is_active, starts_at, ends_at, is_demo, updated_at) VALUES (?, 'hero_pin', ?, 0, 1, ?, ?, ?, ?)",
        uid("pin"),
        JSON.stringify({ platform: target!.slug, productId, headline: { ar: options.headline ?? "عرض الاختبار", en: "Test offer" }, deck: { ar: "سطر العرض" } }),
        t.now - 60_000,
        options.endsAt ?? t.now + 86_400_000,
        options.demo ? 1 : 0,
        t.now,
      );
    await pinRow({ demo: true, headline: "تجريبي" });
    await pinRow({ endsAt: t.now - 1, headline: "منتهٍ" });
    const unpinned = await getHomeData(t.db, { locale: "ar", now: t.now, extraShelves: false });
    expect(unpinned.platforms.find((platform) => platform.slug === target!.slug)?.hero?.pin ?? null).toBeNull();
    await pinRow({});
    const pinned = await getHomeData(t.db, { locale: "en", now: t.now, extraShelves: false });
    const hero = pinned.platforms.find((platform) => platform.slug === target!.slug)?.hero;
    expect(hero).toMatchObject({ productId, pin: { headline: "Test offer", deck: null, textLocale: "en" } });
    expect(pinned.cards[productId]).toBeTruthy();
    expect(pinned.layout.arranged).toBe(false);
    await run("DELETE FROM home_sections WHERE id LIKE 'pin_wiring_%'");
  });
});

// ───────────────────────────────────────────────────────────────── listing filters

describe("listing filters: the staff's order, else the page's own", () => {
  test("panelOrder (pure): the own order without an arrangement; availability where its first part is", () => {
    expect(panelOrder(null)).toEqual({ groups: ["availability", "platforms", "category", "device", "price", "arabic", "formats"], inStock: true, deals: true });
    expect(panelOrder(["price", "deals", "platforms"])).toEqual({ groups: ["price", "availability", "platforms"], inStock: false, deals: true });
    expect(LISTING_FILTER_GROUPS).toEqual(FILTER_GROUPS);
  });

  test("filterOrderOf: null until arranged; the default arrangement; a category's own wins", async () => {
    expect(await filterOrderOf(t.db, null)).toBeNull();
    const [category] = await rows<{ id: string; slug: string }>("SELECT id, slug FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
    const filter = (categoryId: string | null, key: string, sort: number, active = true) =>
      run("INSERT INTO catalog_filters (id, category_id, key, label, source, widget, sort, is_active) VALUES (?, ?, ?, ?, ?, 'checkbox', ?, ?)", uid("flt"), categoryId, key, JSON.stringify({ ar: key }), key, sort, active ? 1 : 0);
    await filter(null, "price", 0);
    await filter(null, "platforms", 1);
    await filter(null, "deals", 2, false);
    expect(await filterOrderOf(t.db, null)).toEqual(["price", "platforms", "category", "device", "inStock", "arabic", "formats"]);
    expect(await filterOrderOf(t.db, category.id)).toEqual(["price", "platforms", "category", "device", "inStock", "arabic", "formats"]);
    await filter(category.id, "inStock", 0);
    expect((await filterOrderOf(t.db, category.id))?.[0]).toBe("inStock");
    await run("DELETE FROM catalog_filters WHERE id LIKE 'flt_wiring_%'");
    expect(await filterOrderOf(t.db, category.id)).toBeNull();
  });

  test("categoryCmsOf: the id and the SEO words staff wrote (the page's language, else Arabic)", async () => {
    const [category] = await rows<{ id: string; slug: string; seo: string | null }>("SELECT id, slug, seo FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
    await run("UPDATE categories SET seo = ? WHERE id = ?", JSON.stringify({ title: { ar: "عنوان البحث", en: "Search title" }, description: { ar: "وصف" }, noindex: true }), category.id);
    expect(await categoryCmsOf(t.db, category.slug, "en")).toEqual({ id: category.id, seo: { title: "Search title", description: "وصف", noindex: true } });
    await run("UPDATE categories SET seo = ? WHERE id = ?", "not json", category.id);
    expect((await categoryCmsOf(t.db, category.slug, "ar"))?.seo).toEqual({ title: null, description: null, noindex: false });
    await run("UPDATE categories SET seo = ? WHERE id = ?", category.seo, category.id);
    expect(await categoryCmsOf(t.db, "no-such-category", "ar")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── support

async function ticketRow(options: { phone: string; status?: string; rating?: number | null }) {
  const id = uid("stk");
  const ref = publicRef("SP");
  const token = randomToken();
  await run(
    "INSERT INTO support_tickets (id, ref, phone_e164, channel, subject, category, priority, status, csat_rating, access_token_hash, is_demo, created_at, updated_at) VALUES (?, ?, ?, 'assistant', 'اختبار', 'other', 'normal', ?, ?, ?, 1, ?, ?)",
    id,
    ref,
    e164(options.phone),
    options.status ?? "open",
    options.rating ?? null,
    await accessTokenHash(token),
    t.now,
    t.now,
  );
  return { id, ref, token };
}

describe("support: following a message to staff and rating the help", () => {
  test("lookupTicket by number AND phone; a wrong one of either reads the same", async () => {
    const phone = freshPhone();
    const ticket = await ticketRow({ phone });
    const found = await lookupTicket(t.db, { ref: ticket.ref.toLowerCase(), phone }, { ip: who().ip }, t.now);
    expect(found).toMatchObject({ ref: ticket.ref, status: "open", rating: null, canRate: false, replies: [] });
    expect(await lookupTicket(t.db, { ref: ticket.ref, phone: freshPhone() }, { ip: who().ip }, t.now)).toBeNull();
    expect(await lookupTicket(t.db, { ref: "SP-ZZZZZZZZ", phone }, { ip: who().ip }, t.now)).toBeNull();
    await expect(lookupTicket(t.db, { ref: "RP-7K4M2Q9X", phone }, { ip: who().ip }, t.now)).rejects.toSatisfy((error: unknown) => isAppError(error, "invalid"));
  });

  test("rateTicket: only once staff solved it, only once, never invented", async () => {
    const phone = freshPhone();
    const open = await ticketRow({ phone });
    expect(await rateTicket(t.db, who(), { ref: open.ref, token: open.token, rating: "4" }, t.now)).toMatchObject({ ok: false, reason: "not_ratable" });
    const solved = await ticketRow({ phone, status: "resolved" });
    expect((await getTicketByAccessToken(t.db, solved.ref, solved.token))?.canRate).toBe(true);
    await expect(rateTicket(t.db, who(), { ref: solved.ref, token: solved.token }, t.now)).rejects.toSatisfy((error: unknown) => isAppError(error, "invalid"));
    await expect(rateTicket(t.db, who(), { ref: solved.ref, token: solved.token, rating: "6" }, t.now)).rejects.toSatisfy((error: unknown) => isAppError(error, "invalid"));
    const rated = await rateTicket(t.db, who(), { ref: solved.ref, phone, rating: "4", comment: "  شكراً  " }, t.now);
    expect(rated).toMatchObject({ ok: true, receipt: { rating: 4, canRate: false } });
    expect(await rows("SELECT csat_rating, csat_comment FROM support_tickets WHERE id = ?", solved.id)).toEqual([{ csat_rating: 4, csat_comment: "شكراً" }]);
    expect(await rows("SELECT action FROM audit_events WHERE entity_id = ? AND action = 'support.ticket.rate'", solved.id)).toHaveLength(1);
    expect(await rateTicket(t.db, who(), { ref: solved.ref, token: solved.token, rating: "1" }, t.now)).toMatchObject({ ok: false, reason: "already_rated", receipt: { rating: 4 } });
    // a wrong token, a wrong phone: nothing is said about the ticket
    expect(await rateTicket(t.db, who(), { ref: solved.ref, token: randomToken(), rating: "5" }, t.now)).toEqual({ ok: false, reason: "not_found", receipt: null });
    expect(await rateTicket(t.db, who(), { ref: solved.ref, phone: freshPhone(), rating: "5" }, t.now)).toEqual({ ok: false, reason: "not_found", receipt: null });
  });

  test("a hand-off from an order's page names the order; it is linked only when the order is the shopper's", async () => {
    const make = fixtures(t.db, t.now);
    const product = await make.product({ stock: 2 });
    const customerId = await make.customer();
    const placed = await make.order([{ ...product, qty: 1 }], { ref: publicRef("TT"), contactPhoneE164: e164(freshPhone()), customerId });
    const [order] = await rows<{ id: string; ref: string; contact_phone_e164: string | null; customer_id: string | null }>("SELECT id, ref, contact_phone_e164, customer_id FROM orders WHERE id = ?", placed.orderId);
    const local = `0${order.contact_phone_e164!.slice(4)}`;
    expect(await ticketOrderOf(t.db, order.ref.toLowerCase(), { customerId: null }, order.contact_phone_e164!)).toEqual({ ref: order.ref, orderId: order.id });
    expect(await ticketOrderOf(t.db, order.ref, { customerId: null }, e164(freshPhone()))).toEqual({ ref: order.ref, orderId: null });
    if (order.customer_id) expect(await ticketOrderOf(t.db, order.ref, { customerId: order.customer_id }, e164(freshPhone()))).toEqual({ ref: order.ref, orderId: order.id });
    expect(await ticketOrderOf(t.db, "not an order", { customerId: null }, order.contact_phone_e164!)).toBeNull();

    const mine = await handOffToStaff(t.db, who(), "ar", { ...EMPTY_ASSISTANT_STATE, answers: [], device: "other" }, { idempotencyKey: randomToken(), phone: local, consent: "on", order: order.ref }, t.now);
    const other = await handOffToStaff(t.db, who(), "ar", { ...EMPTY_ASSISTANT_STATE, answers: [], device: "other" }, { idempotencyKey: randomToken(), phone: freshPhone(), consent: "on", order: order.ref }, t.now);
    const [linked] = await rows<{ order_id: string | null; category: string; subject: string }>("SELECT order_id, category, subject FROM support_tickets WHERE id = ?", mine.ticketId);
    const [unlinked] = await rows<{ order_id: string | null; category: string }>("SELECT order_id, category FROM support_tickets WHERE id = ?", other.ticketId);
    expect(linked).toMatchObject({ order_id: order.id, category: "order" });
    expect(linked.subject).toContain(order.ref);
    expect(unlinked).toEqual({ order_id: null, category: "order" });
    const notes = await rows<{ body: string }>("SELECT body FROM ticket_messages WHERE ticket_id = ? AND is_internal = 1", other.ticketId);
    expect(notes[0]?.body).toContain(order.ref);
  });

  test("routing on arrival never fails the hand-off: routed by the rules, or left for the job", async () => {
    const ticket = await ticketRow({ phone: freshPhone() });
    expect(["routed", "waiting"]).toContain(await routeOnArrival(t.db, ticket.id, t.now));
    expect(await routeOnArrival(t.db, "stk_missing", t.now)).toBe("waiting");
  });
});
