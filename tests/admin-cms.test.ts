/**
 * Admin module 17 "cms" (content & storefront experience) — services against a real local D1 with the demo catalogue
 * (createTestDb + seedDemo). Fixtures are chosen by their properties (a published console the catalogue shows, with a
 * photo, on a home platform), never by hard-coded slugs.
 *
 *   · authorization per role (content, cashier, a page editor without publish, a search-only role)
 *   · banners: a link that opens nothing or a product the catalogue would not show is refused; stale forms; the
 *     storefront read (window, demo, a product link that stopped being live)
 *   · policies: start from the code's draft, save, APPROVE → the storefront serves the CMS text (getPolicy source
 *     "cms"); withdraw → the draft again; returns/warranty belong to module 22; landing pages: slugs, schedule rule,
 *     getLandingPage
 *   · hero pins: catalogue readiness, platform, photo, no overlap (also inside the batch), staged changes, getHomeHero
 *   · home layout (the privacy panel never hidden), navigation arrangement by id, listing filters
 *   · synonyms normalised as the index, merges reported, the search finds a product through a new synonym;
 *     zero-result report with suggestions; adding a query as a synonym
 *   · SEO through the catalogue's write path (version, history, audit; the product page reads it); categories
 *   · redirects: normalisation, reserved paths, home, loops and chains (rules and batch guards), bulk on/off,
 *     resolveRedirect in any locale, hits
 *   · preview links: signed, permission, tampering, expiry, staleness; no cost data anywhere
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { seedDemo } from "~/server/db/seed/demo";
import { auditEvents, banners, employeeRoles, homeSections, pages, productVersions, products, redirects, searchQueryStats, searchSynonyms } from "~/server/db/schema";
import { isAppError } from "~/server/errors";
import { DEFAULT_ROLES, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { changeBannerStatus, getActiveBanners, getBannerEditor, listBanners, parseBannerFilters, saveBanner } from "~/server/services/admin/cms/banners.server";
import { getHomeHero, getHomeLayout, getHomeLayoutEditor, getHeroPinEditor, publishHeroPin, saveHeroPin, saveHomeLayout, searchPinProducts, unpublishHeroPin } from "~/server/services/admin/cms/home.server";
import { getFilterEditor, getListingFilterOrder, getNavArrangement, getNavEditor, publishNav, saveFilters, saveNavDraft } from "~/server/services/admin/cms/navigation.server";
import { getCmsOverview } from "~/server/services/admin/cms/overview.server";
import { archivePage, createLandingPage, getLandingPage, getPageEditor, listPages, publishPage, savePageDraft, schedulePage, startPageDraft } from "~/server/services/admin/cms/pages.server";
import { openPreview, previewLink } from "~/server/services/admin/cms/preview.server";
import { listRedirects, recordRedirectHit, resolveRedirect, saveRedirect, setRedirectsActive } from "~/server/services/admin/cms/redirects.server";
import {
  BAGHDAD_OFFSET_MS,
  DAY_MS,
  HERO_PLATFORMS,
  LISTING_FILTER_GROUPS,
  arrangeBySlug,
  arrangeFilterGroups,
  arrangeHomeSections,
  baghdadLocal,
  normalizeStorePath,
  parseBaghdadLocal,
  redirectConflict,
} from "~/server/services/admin/cms/rules";
import { getSchedule } from "~/server/services/admin/cms/schedule.server";
import { addQueryAsSynonym, consonantSketch, normalizeSet, saveSynonym, setSynonymActive, suggestFor, zeroResultQueries } from "~/server/services/admin/cms/search.server";
import { getSeoEditor, listSeo, saveSeo } from "~/server/services/admin/cms/seo.server";
import { productReadiness } from "~/server/services/admin/cms/shared.server";
import { getProductDetail } from "~/server/services/catalog/product.server";
import { getPolicy } from "~/server/services/content.server";
import { HOME_PLATFORMS } from "~/server/services/home.server";
import { matchQuery } from "~/server/services/search.server";
import { FILTER_GROUPS } from "~/routes/storefront/catalog/listing-model";
import { TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
let NOW: number;
let clock: number;
/** A fresh "now" per change, so versions (updated_at) and audit rows keep their order. */
const tick = () => (clock += 1000);
const SECRET = TEST_VARS.SESSION_SECRET;

async function failure(run: () => Promise<unknown>): Promise<{ code: string; status: number; fields?: Record<string, string>; detail?: string }> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, status: error.status, fields: error.fields, detail: error.detail };
    throw error;
  }
  throw new Error("expected the call to fail");
}
const code = async (run: () => Promise<unknown>) => (await failure(run)).code;

type Staff = { id: string; actor: EmployeeActor };
async function staff(role: DefaultRoleKey | Permission[], name = "موظف"): Promise<Staff> {
  const id = await make.employee({ name });
  const permissions = Array.isArray(role) ? role : [...(DEFAULT_ROLES.find((entry) => entry.key === role)?.permissions ?? [])];
  if (!Array.isArray(role)) await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, actor: { kind: "employee", id, permissions: new Set(permissions), label: name } };
}

let owner: Staff;
let content: Staff;
let cashier: Staff;
let editorOnly: Staff;
let searchOnly: Staff;
/** A published console the catalogue shows now, with a photo, on a home platform. */
let consoleProduct: { id: string; slug: string; platform: string; artKey: string };
/** A draft product (the catalogue does not show it). */
let draftProduct: { id: string; slug: string };
/** Another product the catalogue shows (not the console above). */
let otherProduct: { id: string; slug: string };

beforeAll(async () => {
  t = await createTestDb();
  NOW = t.now;
  clock = NOW;
  make = fixtures(t.db, NOW);
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  owner = await staff(["*" as Permission], "المالك");
  content = await staff("content", "محتوى");
  cashier = await staff("cashier", "كاشير");
  editorOnly = await staff(["cms.page.manage"], "محرر صفحات");
  searchOnly = await staff(["cms.search.manage"], "بحث");
  const candidates = await t.db.all<{ id: string; slug: string; platform: string; art_key: string | null }>(sql`
    SELECT p.id, p.slug, pl.slug AS platform,
      (SELECT m.art_key FROM media m WHERE m.owner_type = 'product' AND m.owner_id = p.id AND m.art_key IS NOT NULL AND m.kind IN ('image', 'render') ORDER BY m.sort, m.id LIMIT 1) AS art_key
    FROM products p JOIN platforms pl ON pl.id = p.platform_id
    WHERE p.kind = 'console' AND p.status = 'published' AND pl.slug IN ('nintendo', 'playstation', 'xbox', 'handheld') ORDER BY p.slug`);
  for (const row of candidates) {
    if (!row.art_key) continue;
    if ((await productReadiness(t.db, row.id, NOW)).ok) {
      consoleProduct = { id: row.id, slug: row.slug, platform: row.platform, artKey: row.art_key };
      break;
    }
  }
  if (!consoleProduct) throw new Error("the demo catalogue has no ready console with a photo");
  const created = await make.product({ kind: "game" });
  await t.db.update(products).set({ status: "draft" }).where(eq(products.id, created.productId));
  const row = await t.db.select({ slug: products.slug }).from(products).where(eq(products.id, created.productId)).get();
  draftProduct = { id: created.productId, slug: row!.slug };
  const others = await t.db.all<{ id: string; slug: string }>(sql`SELECT id, slug FROM products WHERE status = 'published' AND kind = 'accessory' AND id <> ${consoleProduct.id} ORDER BY slug`);
  for (const other of others) if ((await productReadiness(t.db, other.id, NOW)).ok) {
    otherProduct = other;
    break;
  }
  if (!otherProduct) throw new Error("the demo catalogue has no second ready product");
}, 180_000);

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── pure rules

describe("rules", () => {
  test("store paths: locale prefix, case, slashes, query and reserved paths", () => {
    expect(normalizeStorePath("/en/P/Old-Name/?x=1#a", { query: true })).toEqual({ ok: true, path: "/p/old-name", query: "?x=1" });
    expect(normalizeStorePath("/ckb//c//controllers/", { query: false })).toEqual({ ok: true, path: "/c/controllers", query: "" });
    expect(normalizeStorePath("/c/x?y=1", { query: false })).toMatchObject({ ok: false, code: "path_query" });
    for (const reserved of ["/admin", "/admin/orders", "/en/admin/cms", "/api/cart", "/sitemap.xml", "/robots.txt", "/assets/app.js"]) expect(normalizeStorePath(reserved, { query: true })).toMatchObject({ ok: false, code: "path_reserved" });
    for (const bad of ["p/x", "//evil.com", "/a b", "/../admin", "/%E0%A4%A"]) expect(normalizeStorePath(bad, { query: true }).ok).toBe(false);
    expect(normalizeStorePath("https://example.com/x", { query: true })).toMatchObject({ ok: false, code: "path_external" });
    // an encoded admin path is still the admin
    expect(normalizeStorePath("/%61dmin/x", { query: true })).toMatchObject({ ok: false, code: "path_reserved" });
  });

  test("redirect rules: itself, a taken source, loops and chains in both directions", () => {
    const rows = [
      { id: "a", fromPath: "/old", toPath: "/new", isActive: true },
      { id: "b", fromPath: "/gone", toPath: "/c/x?platform=xbox", isActive: true },
      { id: "c", fromPath: "/off", toPath: "/elsewhere", isActive: false },
    ];
    expect(redirectConflict(rows, { fromPath: "/same", toPath: "/same?x=1" })).toBe("redirect_self");
    expect(redirectConflict(rows, { fromPath: "/old", toPath: "/other" })).toBe("redirect_from_taken");
    expect(redirectConflict(rows, { fromPath: "/new", toPath: "/old" })).toBe("redirect_loop");
    expect(redirectConflict(rows, { fromPath: "/start", toPath: "/old" })).toBe("redirect_chain_target");
    expect(redirectConflict(rows, { fromPath: "/c/x", toPath: "/c/y" })).toBe("redirect_chain_source");
    // switched-off rules do not chain
    expect(redirectConflict(rows, { fromPath: "/start", toPath: "/off" })).toBeNull();
    expect(redirectConflict(rows, { fromPath: "/fresh", toPath: "https://example.com/" })).toBeNull();
  });

  test("Iraq time: datetime-local in and out, Arabic digits, impossible dates", () => {
    const at = parseBaghdadLocal("2026-11-20T09:30");
    expect(at).toBe(Date.UTC(2026, 10, 20, 9, 30) - BAGHDAD_OFFSET_MS);
    expect(parseBaghdadLocal("٢٠٢٦-١١-٢٠T٠٩:٣٠")).toBe(at);
    expect(baghdadLocal(at)).toBe("2026-11-20T09:30");
    expect(parseBaghdadLocal("2026-02-31T10:00")).toBeNull();
    expect(parseBaghdadLocal("tomorrow")).toBeNull();
  });

  test("arrangements: home sections keep the privacy panel, navigation by slug, filters", () => {
    expect(arrangeHomeSections([{ kind: "deals", visible: true }, { kind: "personal", visible: false }, { kind: "games", visible: false }])).toEqual(expect.arrayContaining(["deals", "personal"]));
    expect(arrangeHomeSections([{ kind: "games", visible: false }])).not.toContain("games");
    expect(arrangeHomeSections(null)[0]).toBe("new_arrivals");
    const items = [{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }];
    expect(arrangeBySlug(items, [{ slug: "c", hidden: false, featured: true }, { slug: "a", hidden: true, featured: false }]).map((item) => `${item.slug}${item.featured ? "*" : ""}`)).toEqual(["c*", "b", "d"]);
    expect(arrangeFilterGroups([{ group: "price", visible: true }, { group: "deals", visible: false }])).toEqual(["price", ...LISTING_FILTER_GROUPS.filter((group) => group !== "price" && group !== "deals")]);
  });

  test("the module's lists equal the areas' own (home platforms, listing filter groups)", () => {
    expect([...HERO_PLATFORMS]).toEqual([...HOME_PLATFORMS]);
    expect([...LISTING_FILTER_GROUPS]).toEqual([...FILTER_GROUPS]);
  });

  test("search spellings: normalised like the index; Arabic and Latin consonant sketches meet", () => {
    expect(normalizeSet("بلايستيشِن", "PS5, بلي ستيشن\nps5")).toEqual({ term: "بلايستيشن", synonyms: ["ps5", "بلي ستيشن"] });
    expect(normalizeSet("سويتش ٢", "switch 2")).toEqual({ term: "سويتش 2", synonyms: ["switch 2"] });
    expect(consonantSketch("بلايستيشن")).toBe(consonantSketch("playstation"));
    const vocab = [{ form: "playstation", label: "PlayStation", source: "name" as const, forms: { en: ["playstation"], ar: ["بلايستيشن"] } }];
    expect(suggestFor("بلستيشن", vocab)[0]).toMatchObject({ target: "playstation", distance: 0 });
    expect(suggestFor("playstaton", vocab)[0]).toMatchObject({ target: "playstation", distance: 1 });
    expect(suggestFor("xyz", vocab)).toEqual([]);
    // one suggestion per concept: its spellings in two scripts are not offered twice
    const shared = { ar: ["دوالسنس"], en: ["dualsense"] };
    const concept = [
      { form: "dualsense", label: "dualsense", source: "synonym" as const, forms: shared },
      { form: "دوالسنس", label: "دوالسنس", source: "synonym" as const, forms: shared },
    ];
    const offered = suggestFor("دوالسنسس", concept);
    expect(offered).toHaveLength(1);
    expect(offered[0].forms).toBe(shared);
  });
});

// ───────────────────────────────────────────────────────────────── authorization

describe("authorization per role", () => {
  test("a role without content permissions is refused by every service", async () => {
    const actor = cashier.actor;
    expect(await code(() => listBanners(t.db, actor, parseBannerFilters(new URLSearchParams()), "ar", NOW))).toBe("forbidden");
    expect(await code(() => saveBanner(t.db, actor, { placement: "home_strip", title: { ar: "x" } }, tick()))).toBe("forbidden");
    expect(await code(() => listPages(t.db, actor, "ar", NOW))).toBe("forbidden");
    expect(await code(() => getHomeLayoutEditor(t.db, actor))).toBe("forbidden");
    expect(await code(() => getNavEditor(t.db, actor, "ar", NOW))).toBe("forbidden");
    expect(await code(() => listSeo(t.db, actor, { type: null, issue: null, q: "", page: 1 }, "ar"))).toBe("forbidden");
    expect(await code(() => listRedirects(t.db, actor, { q: "", state: "all", page: 1 }, NOW))).toBe("forbidden");
    expect(await code(() => saveSynonym(t.db, actor, { locale: "ar", term: "x", synonyms: "y" }, tick()))).toBe("forbidden");
    expect(await code(() => getSchedule(t.db, actor, { from: null, days: 30 }, "ar", NOW))).toBe("forbidden");
    expect(await code(() => getCmsOverview(t.db, actor, "ar", NOW))).toBe("forbidden");
    expect(await code(() => previewLink(t.db, actor, { kind: "banner", id: "x" }, SECRET, NOW))).toBe("forbidden");
  });

  test("a page editor may draft but not approve; a search-only role sees search, not banners", async () => {
    expect(await code(() => publishPage(t.db, editorOnly.actor, { slug: "terms", version: 1, reason: "اعتماد" }, tick()))).toBe("forbidden");
    expect((await listPages(t.db, editorOnly.actor, "ar", NOW)).can).toEqual({ edit: true, publish: false });
    expect(await code(() => listBanners(t.db, searchOnly.actor, parseBannerFilters(new URLSearchParams()), "ar", NOW))).toBe("forbidden");
    const overview = await getCmsOverview(t.db, searchOnly.actor, "ar", NOW);
    expect(overview.access.search).toBe(true);
    expect(overview.banners).toBeNull();
    expect(overview.pages).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── banners

describe("banners", () => {
  test("a draft is saved; publishing checks the link against the catalogue; a stale form is refused", async () => {
    const created = await saveBanner(t.db, content.actor, { placement: "home_strip", title: { ar: "عرض", en: "Offer" }, ctaLabel: { ar: "تسوّق" }, link: `/en/p/${draftProduct.slug}/`, accent: "playstation" }, tick(), { demo: false });
    const editor = await getBannerEditor(t.db, content.actor, created.bannerId, "ar", NOW);
    expect(editor.banner?.link).toBe(`/p/${draftProduct.slug}`);
    expect(editor.banner?.status).toBe("draft");
    // the catalogue does not show a draft product: publishing is refused, nothing changes
    const refused = await failure(() => changeBannerStatus(t.db, content.actor, { bannerId: created.bannerId, version: editor.banner!.version, action: "publish", reason: "حملة" }, tick()));
    expect(refused.code).toBe("product_not_ready");
    expect((await t.db.select().from(banners).where(eq(banners.id, created.bannerId)).get())?.status).toBe("draft");
    // point it at a product the catalogue shows, then publish
    const at = tick();
    await saveBanner(t.db, content.actor, { bannerId: created.bannerId, version: editor.banner!.version, placement: "home_strip", title: { ar: "عرض", en: "Offer" }, ctaLabel: { ar: "تسوّق" }, link: `/p/${consoleProduct.slug}`, accent: "playstation" }, at);
    expect(await code(() => saveBanner(t.db, content.actor, { bannerId: created.bannerId, version: editor.banner!.version, placement: "home_strip", title: { ar: "قديم" } }, tick()))).toBe("content_changed");
    const published = await changeBannerStatus(t.db, content.actor, { bannerId: created.bannerId, version: at, action: "publish", reason: "حملة الشتاء" }, tick());
    expect(published.status).toBe("published");
    const shown = await getActiveBanners(t.db, "en", "home_strip", { now: clock });
    expect(shown.map((banner) => banner.id)).toContain(created.bannerId);
    expect(shown.find((banner) => banner.id === created.bannerId)).toMatchObject({ title: "Offer", ctaLabel: "تسوّق", textLocale: "en" });
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, created.bannerId));
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(["cms.banner.create", "cms.banner.update", "cms.banner.publish"]));
    expect(events.find((event) => event.action === "cms.banner.publish")?.reason).toBe("حملة الشتاء");
  });

  test("links that open nothing, the admin, or a bad URL are refused; an unknown photo too", async () => {
    expect((await failure(() => saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "x" }, link: "/admin/finance" }, tick()))).fields?.link).toBe("link_reserved");
    expect((await failure(() => saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "x" }, link: "javascript:alert(1)" }, tick()))).fields?.link).toBe("link_invalid");
    expect((await failure(() => saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "x" }, link: "http://insecure.example" }, tick()))).fields?.link).toBe("link_invalid");
    expect((await failure(() => saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "x" }, artKey: "no-such-photo--9" }, tick()))).fields?.artKey).toBe("art_unknown");
    expect((await failure(() => saveBanner(t.db, content.actor, { placement: "category:no-such", title: { ar: "x" } }, tick()))).fields?.placement).toBe("category_unknown");
    expect((await failure(() => saveBanner(t.db, content.actor, { placement: "cart", title: { en: "English only" } }, tick()))).fields?.["title.ar"]).toBe("required");
    const missing = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "رابط مكسور" }, link: "/p/no-such-product" }, tick());
    const row = await t.db.select().from(banners).where(eq(banners.id, missing.bannerId)).get();
    expect(await code(() => changeBannerStatus(t.db, content.actor, { bannerId: missing.bannerId, version: row!.updatedAt, action: "publish", reason: "تجربة" }, tick()))).toBe("link_missing");
  });

  test("scheduling needs a future start; the storefront read keeps windows, leaves out demo rows and dead product links", async () => {
    const start = NOW + 3 * DAY_MS;
    const made = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "مجدول" }, startsAt: baghdadLocal(start), endsAt: baghdadLocal(start + DAY_MS) }, tick());
    const row = await t.db.select().from(banners).where(eq(banners.id, made.bannerId)).get();
    expect((await failure(() => changeBannerStatus(t.db, content.actor, { bannerId: made.bannerId, version: row!.updatedAt, action: "schedule", startsAt: baghdadLocal(NOW - DAY_MS), reason: "تجربة" }, tick()))).fields?.startsAt).toBe("schedule_past");
    await changeBannerStatus(t.db, content.actor, { bannerId: made.bannerId, version: row!.updatedAt, action: "schedule", startsAt: baghdadLocal(start), endsAt: baghdadLocal(start + DAY_MS), reason: "موسم" }, tick());
    expect((await getActiveBanners(t.db, "ar", "cart", { now: NOW })).map((banner) => banner.id)).not.toContain(made.bannerId);
    expect((await getActiveBanners(t.db, "ar", "cart", { now: start + 60_000 })).map((banner) => banner.id)).toContain(made.bannerId);
    expect((await getActiveBanners(t.db, "ar", "cart", { now: start + DAY_MS })).map((banner) => banner.id)).not.toContain(made.bannerId);

    const demo = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "تجريبي" } }, tick(), { demo: true });
    const demoRow = await t.db.select().from(banners).where(eq(banners.id, demo.bannerId)).get();
    await changeBannerStatus(t.db, content.actor, { bannerId: demo.bannerId, version: demoRow!.updatedAt, action: "publish", reason: "تجربة" }, tick());
    expect((await getActiveBanners(t.db, "ar", "cart", { now: clock })).map((banner) => banner.id)).not.toContain(demo.bannerId);
    expect((await getActiveBanners(t.db, "ar", "cart", { now: clock, includeDemo: true })).map((banner) => banner.id)).toContain(demo.bannerId);

    // a live banner whose product is later unpublished drops out of the read at once (then the product is restored)
    const linked = await saveBanner(t.db, owner.actor, { placement: "category_top", title: { ar: "ملحق" }, link: `/p/${otherProduct.slug}` }, tick());
    const linkedRow = await t.db.select().from(banners).where(eq(banners.id, linked.bannerId)).get();
    await changeBannerStatus(t.db, owner.actor, { bannerId: linked.bannerId, version: linkedRow!.updatedAt, action: "publish", reason: "تجربة" }, tick());
    expect((await getActiveBanners(t.db, "ar", "category_top", { now: clock })).map((banner) => banner.id)).toContain(linked.bannerId);
    await t.db.update(products).set({ status: "draft" }).where(eq(products.id, otherProduct.id));
    expect((await getActiveBanners(t.db, "ar", "category_top", { now: clock })).map((banner) => banner.id)).not.toContain(linked.bannerId);
    await t.db.update(products).set({ status: "published" }).where(eq(products.id, otherProduct.id));
  });
});

// ───────────────────────────────────────────────────────────────── policies and pages

describe("policies and pages", () => {
  test("a policy: start from the code's draft, save, approve → the storefront serves it; withdraw → the draft again", async () => {
    expect((await getPolicy(t.db, "ar", "privacy", { now: NOW }))?.source).toBe("draft");
    expect(await code(() => savePageDraft(t.db, content.actor, { slug: "privacy", version: 1, title: { ar: "x" }, textAr: "y" }, tick()))).toBe("page_no_draft");
    await startPageDraft(t.db, content.actor, { slug: "privacy", version: "", reason: "مراجعة المالك" }, tick(), "demo");
    let editor = await getPageEditor(t.db, content.actor, "privacy", "ar", NOW, "demo");
    expect(editor.source).toBe("draft");
    expect(editor.text.ar.length).toBeGreaterThan(100);
    expect(editor.text.en.length).toBeGreaterThan(50);
    // the storefront still serves the code's draft while the CMS row is a draft
    expect((await getPolicy(t.db, "ar", "privacy", { now: clock }))?.source).toBe("draft");
    expect((await failure(() => savePageDraft(t.db, content.actor, { slug: "privacy", version: editor.version, title: { ar: "الخصوصية" }, textAr: "   " }, tick()))).fields?.textAr).toBe("page_empty");
    await savePageDraft(t.db, content.actor, { slug: "privacy", version: editor.version, title: { ar: "سياسة الخصوصية", en: "Privacy" }, description: { ar: "ما نحفظه ولماذا." }, textAr: "## ما نحفظه\nرقم الموبايل والعنوان لتوصيل الطلب.\n- لا تتبع دون موافقة", textEn: "## What we keep\nYour number and address to deliver." }, tick());
    editor = await getPageEditor(t.db, content.actor, "privacy", "ar", NOW, "demo");
    await publishPage(t.db, content.actor, { slug: "privacy", version: editor.version, reason: "اعتمده المالك" }, tick());
    const served = await getPolicy(t.db, "en", "privacy", { now: clock });
    expect(served).toMatchObject({ source: "cms", approved: true, title: "Privacy", summary: expect.any(String) });
    expect((await getPolicy(t.db, "ar", "privacy", { now: clock }))?.summary).toBe("ما نحفظه ولماذا.");
    // withdrawing returns the code's draft, still marked as awaiting the owner
    editor = await getPageEditor(t.db, content.actor, "privacy", "ar", clock, "demo");
    await archivePage(t.db, content.actor, { slug: "privacy", version: editor.version, reason: "خطأ في النص" }, tick());
    expect((await getPolicy(t.db, "ar", "privacy", { now: clock }))?.source).toBe("draft");
    const actions = (await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, "privacy"))).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["cms.page.start", "cms.page.save", "cms.page.publish", "cms.page.archive"]));
  });

  test("returns and warranty are module 22's; about and contact work through the same reader", async () => {
    expect(await code(() => startPageDraft(t.db, content.actor, { slug: "returns", version: "", reason: "تجربة" }, tick(), "demo"))).toBe("page_in_settings");
    const list = await listPages(t.db, content.actor, "ar", NOW);
    expect(list.policies.map((policy) => policy.slug)).toEqual(["shipping", "returns", "warranty", "payment", "privacy", "terms"]);
    expect(list.policies.filter((policy) => policy.inSettings).map((policy) => policy.slug)).toEqual(["returns", "warranty"]);
    await startPageDraft(t.db, content.actor, { slug: "about", version: "", reason: "نص من نحن" }, tick(), "demo");
    const editor = await getPageEditor(t.db, content.actor, "about", "ar", NOW, "demo");
    await savePageDraft(t.db, content.actor, { slug: "about", version: editor.version, title: { ar: "عن طمطم" }, textAr: "متجر ألعاب في العراق." }, tick());
    const saved = await getPageEditor(t.db, content.actor, "about", "ar", NOW, "demo");
    await publishPage(t.db, owner.actor, { slug: "about", version: saved.version, reason: "اعتماد" }, tick());
    const { getCmsText } = await import("~/server/services/content.server");
    expect((await getCmsText(t.db, "ar", "about", { now: clock }))?.title).toBe("عن طمطم");
  });

  test("landing pages: slugs, schedule only while not live, the storefront read, demo pages never served", async () => {
    expect((await failure(() => createLandingPage(t.db, content.actor, { slug: "privacy", titleAr: "x" }, tick()))).code).toBe("page_slug_reserved");
    expect((await failure(() => createLandingPage(t.db, content.actor, { slug: "Not A Slug", titleAr: "x" }, tick()))).fields?.slug).toBe("invalid");
    await createLandingPage(t.db, content.actor, { slug: "winter-2026", titleAr: "حملة الشتاء" }, tick());
    expect(await code(() => createLandingPage(t.db, content.actor, { slug: "winter-2026", titleAr: "مكرر" }, tick()))).toBe("page_slug_taken");
    let editor = await getPageEditor(t.db, content.actor, "winter-2026", "ar", NOW, "demo");
    await savePageDraft(t.db, content.actor, { slug: "winter-2026", version: editor.version, title: { ar: "حملة الشتاء" }, textAr: "## العروض\nأجهزة وملحقات." }, tick());
    expect(await getLandingPage(t.db, "ar", "winter-2026", clock)).toBeNull();
    editor = await getPageEditor(t.db, content.actor, "winter-2026", "ar", NOW, "demo");
    const start = clock + 2 * DAY_MS;
    await schedulePage(t.db, owner.actor, { slug: "winter-2026", version: editor.version, reason: "موسم", startsAt: baghdadLocal(start), endsAt: baghdadLocal(start + 7 * DAY_MS) }, tick());
    expect(await getLandingPage(t.db, "ar", "winter-2026", clock)).toBeNull();
    expect((await getLandingPage(t.db, "en", "winter-2026", start + 60_000))?.textLocale).toBe("ar");
    expect(await getLandingPage(t.db, "ar", "winter-2026", start + 8 * DAY_MS)).toBeNull();
    // live now → scheduling would hide it: refused
    await createLandingPage(t.db, content.actor, { slug: "always-on", titleAr: "دائمة" }, tick());
    editor = await getPageEditor(t.db, content.actor, "always-on", "ar", NOW, "demo");
    await savePageDraft(t.db, content.actor, { slug: "always-on", version: editor.version, title: { ar: "دائمة" }, textAr: "نص" }, tick());
    editor = await getPageEditor(t.db, content.actor, "always-on", "ar", NOW, "demo");
    await publishPage(t.db, owner.actor, { slug: "always-on", version: editor.version, reason: "نشر" }, tick());
    expect(await getLandingPage(t.db, "ar", "always-on", clock)).not.toBeNull();
    await startPageDraft(t.db, content.actor, { slug: "always-on", version: (await getPageEditor(t.db, content.actor, "always-on", "ar", clock, "demo")).version, reason: "تعديل" }, tick(), "demo");
    editor = await getPageEditor(t.db, content.actor, "always-on", "ar", clock, "demo");
    expect(await code(() => schedulePage(t.db, owner.actor, { slug: "always-on", version: editor.version, reason: "تجربة", startsAt: baghdadLocal(clock + DAY_MS) }, tick()))).toBe("page_live_schedule");
    // a demo landing page is never served, even published
    await createLandingPage(t.db, content.actor, { slug: "demo-page", titleAr: "تجريبية" }, tick(), { demo: true });
    editor = await getPageEditor(t.db, content.actor, "demo-page", "ar", NOW, "demo");
    await savePageDraft(t.db, content.actor, { slug: "demo-page", version: editor.version, title: { ar: "تجريبية" }, textAr: "نص" }, tick());
    editor = await getPageEditor(t.db, content.actor, "demo-page", "ar", NOW, "demo");
    await publishPage(t.db, owner.actor, { slug: "demo-page", version: editor.version, reason: "نشر" }, tick());
    expect((await t.db.select().from(pages).where(eq(pages.slug, "demo-page")).get())?.isDemo).toBe(true);
    expect(await getLandingPage(t.db, "ar", "demo-page", clock)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── the home page

describe("hero pins and the home layout", () => {
  test("a pin publishes only a product the catalogue shows, for that platform, with a photo, without overlap", async () => {
    const start = NOW - DAY_MS;
    const window = { startsAt: baghdadLocal(start), endsAt: baghdadLocal(NOW + 10 * DAY_MS) };
    const otherPlatform = HERO_PLATFORMS.find((platform) => platform !== consoleProduct.platform)!;
    // wrong platform
    const wrong = await saveHeroPin(t.db, content.actor, { platform: otherPlatform, productId: consoleProduct.id, headline: { ar: "خطأ" }, ...window }, tick());
    const wrongRow = await t.db.select().from(homeSections).where(eq(homeSections.id, wrong.pinId)).get();
    expect(await code(() => publishHeroPin(t.db, content.actor, { pinId: wrong.pinId, version: wrongRow!.updatedAt, reason: "تجربة" }, tick()))).toBe("pin_platform");
    // a draft product
    const draft = await saveHeroPin(t.db, content.actor, { platform: consoleProduct.platform, productId: draftProduct.id, headline: { ar: "مسودة" }, ...window }, tick());
    const draftRow = await t.db.select().from(homeSections).where(eq(homeSections.id, draft.pinId)).get();
    expect(await code(() => publishHeroPin(t.db, content.actor, { pinId: draft.pinId, version: draftRow!.updatedAt, reason: "تجربة" }, tick()))).toBe("product_not_ready");
    // a real pin
    const made = await saveHeroPin(t.db, content.actor, { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "العب الشتاء كله", en: "Play all winter" }, deck: { ar: "سطر" }, ...window }, tick());
    let row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    expect(row?.isActive).toBe(false);
    expect((await getHomeHero(t.db, clock)).map((pin) => pin.pinId)).not.toContain(made.pinId);
    await publishHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, reason: "حملة" }, tick());
    const heroes = await getHomeHero(t.db, clock);
    expect(heroes.find((pin) => pin.platform === consoleProduct.platform)).toMatchObject({ pinId: made.pinId, productId: consoleProduct.id, headline: { ar: "العب الشتاء كله", en: "Play all winter" } });
    // another pin of the same platform overlapping the window cannot be published
    const second = await saveHeroPin(t.db, content.actor, { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "ثانٍ" }, startsAt: baghdadLocal(NOW + DAY_MS), endsAt: baghdadLocal(NOW + 3 * DAY_MS) }, tick());
    const secondRow = await t.db.select().from(homeSections).where(eq(homeSections.id, second.pinId)).get();
    expect(await code(() => publishHeroPin(t.db, content.actor, { pinId: second.pinId, version: secondRow!.updatedAt, reason: "تجربة" }, tick()))).toBe("pin_overlap");
    expect((await getHeroPinEditor(t.db, content.actor, second.pinId, "ar", NOW)).overlaps.map((other) => other.id)).toContain(made.pinId);
    // changes to a published pin wait; the store keeps the published headline until they are published
    row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    const staged = await saveHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "عنوان جديد" }, ...window }, tick());
    expect(staged.staged).toBe(true);
    expect((await getHomeHero(t.db, clock)).find((pin) => pin.pinId === made.pinId)?.headline.ar).toBe("العب الشتاء كله");
    row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    await publishHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, reason: "تحديث" }, tick());
    expect((await getHomeHero(t.db, clock)).find((pin) => pin.pinId === made.pinId)?.headline.ar).toBe("عنوان جديد");
    // stopping it brings back the automatic hero
    row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    await unpublishHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, reason: "انتهت الحملة" }, tick());
    expect((await getHomeHero(t.db, clock)).map((pin) => pin.pinId)).not.toContain(made.pinId);
    // a window longer than 120 days
    expect((await failure(() => saveHeroPin(t.db, content.actor, { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "طويل" }, startsAt: baghdadLocal(NOW), endsAt: baghdadLocal(NOW + 200 * DAY_MS) }, tick()))).code).toBe("pin_window");
  });

  test("two people publishing overlapping pins at once: the batch guard lets only one win", async () => {
    const window = { startsAt: baghdadLocal(NOW + 30 * DAY_MS), endsAt: baghdadLocal(NOW + 40 * DAY_MS) };
    const a = await saveHeroPin(t.db, content.actor, { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "أ" }, ...window }, tick());
    const b = await saveHeroPin(t.db, owner.actor, { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "ب" }, ...window }, tick());
    const rowA = await t.db.select().from(homeSections).where(eq(homeSections.id, a.pinId)).get();
    const rowB = await t.db.select().from(homeSections).where(eq(homeSections.id, b.pinId)).get();
    const results = await Promise.allSettled([publishHeroPin(t.db, content.actor, { pinId: a.pinId, version: rowA!.updatedAt, reason: "حملة أ" }, tick()), publishHeroPin(t.db, owner.actor, { pinId: b.pinId, version: rowB!.updatedAt, reason: "حملة ب" }, tick())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(isAppError(lost.reason, "pin_overlap")).toBe(true);
  });

  test("the home layout: order and hidden sections, never the privacy panel, a stale form refused", async () => {
    const editor = await getHomeLayoutEditor(t.db, content.actor);
    expect(editor.version).toBe(0);
    expect((await failure(() => saveHomeLayout(t.db, content.actor, { order: ["deals"], hidden: ["personal"], version: 0, reason: "ترتيب" }, tick()))).fields?.hidden).toBe("section_locked");
    await saveHomeLayout(t.db, content.actor, { order: ["deals", "new_arrivals"], hidden: ["games"], version: 0, reason: "تخفيضات أولاً" }, tick());
    const layout = await getHomeLayout(t.db);
    expect(layout.slice(0, 2)).toEqual(["deals", "new_arrivals"]);
    expect(layout).not.toContain("games");
    expect(layout).toContain("personal");
    expect(await code(() => saveHomeLayout(t.db, content.actor, { order: ["games"], hidden: [], version: 0, reason: "قديم" }, tick()))).toBe("content_changed");
  });
});

// ───────────────────────────────────────────────────────────────── navigation and filters

describe("navigation and filters", () => {
  test("the arrangement names entries by id, resolves to today's slugs, caps featured entries", async () => {
    const editor = await getNavEditor(t.db, content.actor, "ar", NOW);
    expect(editor.platforms.length).toBeGreaterThan(1);
    const [first, second, ...rest] = editor.platforms;
    const strip = (entry: { ref: string; hidden: boolean; featured: boolean }) => ({ ref: entry.ref, hidden: entry.hidden, featured: entry.featured });
    expect(await code(() => saveNavDraft(t.db, content.actor, { platforms: [{ ref: "platform:nope", hidden: false, featured: false }], categories: [], version: editor.version }, tick()))).toBe("nav_unknown_entry");
    const tooMany = editor.categories.slice(0, 4).map((entry) => ({ ...strip(entry), featured: true }));
    if (tooMany.length === 4) expect(await code(() => saveNavDraft(t.db, content.actor, { platforms: [], categories: tooMany, version: editor.version }, tick()))).toBe("nav_featured_max");
    await saveNavDraft(t.db, content.actor, { platforms: [{ ...strip(second), featured: true }, { ...strip(first), hidden: true }, ...rest.map(strip)], categories: editor.categories.map(strip), version: editor.version }, tick());
    // a draft does not change what the store gets
    expect((await getNavArrangement(t.db)).platforms).toEqual([]);
    const draft = await getNavEditor(t.db, content.actor, "ar", NOW);
    expect(draft.hasDraft).toBe(true);
    await publishNav(t.db, content.actor, { version: draft.version, reason: "إبراز" }, tick());
    const arrangement = await getNavArrangement(t.db);
    expect(arrangement.platforms[0]).toEqual({ slug: second.slug, hidden: false, featured: true });
    expect(arrangement.platforms[1]).toEqual({ slug: first.slug, hidden: true, featured: false });
    const applied = arrangeBySlug([{ slug: first.slug }, { slug: second.slug }], arrangement.platforms);
    expect(applied.map((entry) => entry.slug)).toEqual([second.slug]);
  });

  test("listing filters: a default, a category's own, back to the default", async () => {
    const editor = await getFilterEditor(t.db, content.actor, null, "ar");
    expect(editor.own).toBe(false);
    const groups = editor.groups.map((entry) => ({ ...entry, visible: entry.group !== "arabic" }));
    const reordered = [groups.find((entry) => entry.group === "price")!, ...groups.filter((entry) => entry.group !== "price")];
    await saveFilters(t.db, content.actor, { categoryId: "", groups: reordered, version: editor.version, reason: "السعر أولاً" }, tick());
    expect((await getListingFilterOrder(t.db, null))[0]).toBe("price");
    expect(await getListingFilterOrder(t.db, null)).not.toContain("arabic");
    expect(await code(() => saveFilters(t.db, content.actor, { categoryId: "", groups: reordered, version: editor.version, reason: "قديم" }, tick()))).toBe("content_changed");
    const category = editor.categories[0];
    const own = await getFilterEditor(t.db, content.actor, category.id, "ar");
    expect(own.own).toBe(false);
    await saveFilters(t.db, content.actor, { categoryId: category.id, groups: [{ group: "deals", visible: true }], version: own.version, reason: "خاص" }, tick());
    expect((await getListingFilterOrder(t.db, category.id))[0]).toBe("deals");
    const saved = await getFilterEditor(t.db, content.actor, category.id, "ar");
    await saveFilters(t.db, content.actor, { categoryId: category.id, groups: [], mode: "inherit", version: saved.version, reason: "يتبع الافتراضي" }, tick());
    expect((await getListingFilterOrder(t.db, category.id))[0]).toBe("price");
  });
});

// ───────────────────────────────────────────────────────────────── search

describe("search synonyms and zero-result searches", () => {
  test("a new set is stored normalised, the search finds a product through it, a merge is reported", async () => {
    const before = await matchQuery(t.db, "طمطمكونسول", clock);
    expect(before.ids).toHaveLength(0);
    const name = (await t.db.select({ name: products.name }).from(products).where(eq(products.id, consoleProduct.id)).get())!.name;
    const saved = await saveSynonym(t.db, searchOnly.actor, { locale: "ar", term: "طمطمكونسول", synonyms: name.en ?? name.ar }, tick());
    expect(saved.term).toBe("طمطمكونسول");
    const after = await matchQuery(t.db, "طمطمكونسول", clock);
    expect(after.ids).toContain(consoleProduct.id);
    expect(await code(() => saveSynonym(t.db, searchOnly.actor, { locale: "ar", term: "طمطمكونسول", synonyms: "شيء" }, tick()))).toBe("synonym_term_taken");
    expect((await failure(() => saveSynonym(t.db, searchOnly.actor, { locale: "ar", term: "كلمة", synonyms: "كلمة" }, tick()))).fields?.synonyms).toBe("synonym_same");
    // a set sharing a spelling with an existing one joins its concept, and saving says so
    const joined = await saveSynonym(t.db, searchOnly.actor, { locale: "en", term: "tamtamconsole", synonyms: "طمطمكونسول" }, tick());
    expect(joined.joins.map((row) => row.id)).toContain(saved.id);
    // switching it off stops the search using it
    const row = await t.db.select().from(searchSynonyms).where(eq(searchSynonyms.id, joined.id)).get();
    await setSynonymActive(t.db, searchOnly.actor, { id: joined.id, version: row!.updatedAt, active: false, reason: "خطأ" }, tick());
    expect((await t.db.select().from(searchSynonyms).where(eq(searchSynonyms.id, joined.id)).get())?.isActive).toBe(false);
  });

  test("the zero-result report: counts, whether it matches now, suggestions, adding the query as a synonym", async () => {
    const day = new Date(NOW + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
    const platformName = await t.db.all<{ name: string }>(sql`SELECT name FROM platforms WHERE slug = ${consoleProduct.platform}`);
    const latin = (JSON.parse(platformName[0].name) as { en?: string; ar: string }).en ?? "PlayStation";
    const typo = latin.toLowerCase().replace(/a/, "").slice(0, 12);
    await t.db.insert(searchQueryStats).values([
      { day, locale: "en", query: typo, searches: 4, zeroResults: 4, lastAt: NOW },
      { day, locale: "ar", query: "فيفا", searches: 2, zeroResults: 2, lastAt: NOW },
    ]);
    const report = await zeroResultQueries(t.db, searchOnly.actor, { days: 7, locale: null, page: 1 }, NOW + 1000);
    const row = report.rows.find((entry) => entry.query === typo)!;
    expect(row).toMatchObject({ locale: "en", searches: 4, zeroResults: 4 });
    expect(report.zero).toBeGreaterThanOrEqual(6);
    if (row.matchesNow === 0) {
      expect(row.suggestions.length).toBeGreaterThan(0);
      await addQueryAsSynonym(t.db, searchOnly.actor, { locale: "en", query: typo, target: row.suggestions[0].target }, tick());
      expect((await matchQuery(t.db, typo, clock)).ids.length).toBeGreaterThan(0);
    }
    expect(report.rows.find((entry) => entry.query === "فيفا")).toMatchObject({ locale: "ar", searches: 2, zeroResults: 2 });
    expect(await code(() => zeroResultQueries(t.db, cashier.actor, { days: 7, locale: null, page: 1 }, NOW))).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── SEO

describe("SEO", () => {
  test("a product's SEO goes through the catalogue's write path and the product page reads it", async () => {
    const editor = await getSeoEditor(t.db, content.actor, "product", consoleProduct.id);
    const before = (await t.db.select({ version: products.version }).from(products).where(eq(products.id, consoleProduct.id)).get())!.version;
    expect((await failure(() => saveSeo(t.db, content.actor, { type: "product", id: consoleProduct.id, version: editor.version, title: null, description: null, noindex: true }, tick()))).fields?.reason).toBe("reason_required");
    await saveSeo(t.db, content.actor, { type: "product", id: consoleProduct.id, version: editor.version, title: { ar: "اشترِ الجهاز في العراق", en: "Buy the console in Iraq" }, description: { ar: "توصيل لكل المحافظات." }, noindex: false }, tick());
    const after = (await t.db.select({ version: products.version }).from(products).where(eq(products.id, consoleProduct.id)).get())!.version;
    expect(after).toBe(before + 1);
    const version = await t.db.select().from(productVersions).where(eq(productVersions.productId, consoleProduct.id));
    expect(version.some((entry) => entry.version === after)).toBe(true);
    const detail = await getProductDetail(t.db, "en", consoleProduct.slug, { now: clock });
    expect(detail?.seo.title).toBe("Buy the console in Iraq");
    expect(await code(() => saveSeo(t.db, content.actor, { type: "product", id: consoleProduct.id, version: editor.version, title: { ar: "قديم" }, description: null, noindex: false }, tick()))).toBe("content_changed");
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "cms.seo.product"));
    expect(events.some((event) => event.entityId === consoleProduct.id)).toBe(true);
  });

  test("a category's SEO is guarded on what the form saw; the list finds issues", async () => {
    const list = await listSeo(t.db, content.actor, { type: "category", issue: null, q: "", page: 1 }, "ar");
    const category = list.rows[0];
    const editor = await getSeoEditor(t.db, content.actor, "category", category.id);
    await saveSeo(t.db, content.actor, { type: "category", id: category.id, version: editor.version, title: { ar: "عنوان القسم" }, description: { ar: "وصف قصير" }, noindex: false }, tick());
    expect(await code(() => saveSeo(t.db, content.actor, { type: "category", id: category.id, version: editor.version, title: { ar: "قديم" }, description: null, noindex: false }, tick()))).toBe("content_changed");
    const after = await listSeo(t.db, content.actor, { type: "category", issue: null, q: "", page: 1 }, "ar");
    expect(after.rows.find((row) => row.id === category.id)?.issues).toContain("description_short");
    expect(after.counts.all).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────── redirects

describe("redirects", () => {
  test("created normalised; resolved in any locale; switched off ones are not; hits count", async () => {
    const made = await saveRedirect(t.db, content.actor, { fromPath: "/en/Old-Console/", toPath: `/p/${consoleProduct.slug}`, code: 301 }, tick());
    const row = await t.db.select().from(redirects).where(eq(redirects.id, made.id)).get();
    expect(row).toMatchObject({ fromPath: "/old-console", toPath: `/p/${consoleProduct.slug}`, code: 301, isActive: true });
    expect(await resolveRedirect(t.db, "/ckb/old-console")).toMatchObject({ id: made.id, to: `/p/${consoleProduct.slug}`, code: 301, external: false });
    expect(await resolveRedirect(t.db, "/OLD-CONSOLE/")).toMatchObject({ id: made.id });
    await recordRedirectHit(t.db, made.id);
    expect((await t.db.select().from(redirects).where(eq(redirects.id, made.id)).get())?.hits).toBe(1);
    await setRedirectsActive(t.db, content.actor, { ids: [made.id], active: false, reason: "لم يعد لازماً" }, tick());
    expect(await resolveRedirect(t.db, "/old-console")).toBeNull();
  });

  test("never the admin or the API, never the home page, never to a page that opens nothing", async () => {
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "/admin/orders", toPath: "/" }, tick()))).fields?.fromPath).toBe("path_reserved");
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "/x-old", toPath: "/api/cart" }, tick()))).fields?.toPath).toBe("path_reserved");
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "/en", toPath: "/used" }, tick()))).fields?.fromPath).toBe("path_home");
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "/x-old", toPath: "/p/no-such-product" }, tick()))).code).toBe("redirect_target_missing");
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "https://evil.example/x", toPath: "/used" }, tick()))).fields?.fromPath).toBe("path_external");
    expect(await resolveRedirect(t.db, "/admin")).toBeNull();
  });

  test("no loops and no chains — by the rules, inside the batch, and when switching many on", async () => {
    const a = await saveRedirect(t.db, content.actor, { fromPath: "/chain-a", toPath: "/used" }, tick());
    expect(await code(() => saveRedirect(t.db, content.actor, { fromPath: "/chain-b", toPath: "/chain-a" }, tick()))).toBe("redirect_chain_target");
    expect(await code(() => saveRedirect(t.db, content.actor, { fromPath: "/used", toPath: "/support" }, tick()))).toBe("redirect_chain_source");
    expect(await code(() => saveRedirect(t.db, content.actor, { fromPath: "/chain-a", toPath: "/support" }, tick()))).toBe("redirect_from_taken");
    // two people at once: B → C while C → D, both pass the read; the batch guard stops the second
    const results = await Promise.allSettled([saveRedirect(t.db, content.actor, { fromPath: "/race-b", toPath: "/race-c" }, tick()), saveRedirect(t.db, owner.actor, { fromPath: "/race-c", toPath: "/support" }, tick())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    // switching on many: one that would chain with the others is skipped, with its reason
    await setRedirectsActive(t.db, content.actor, { ids: [a.id], active: false, reason: "مؤقتاً" }, tick());
    const b = await saveRedirect(t.db, content.actor, { fromPath: "/chain-x", toPath: "/chain-a" }, tick());
    const outcome = await setRedirectsActive(t.db, content.actor, { ids: [a.id, b.id], active: true, reason: "تشغيل" }, tick());
    // switching a back on would make x → a → used: skipped with its reason; b was on already
    expect(outcome.changed).toEqual([]);
    expect(outcome.skipped).toEqual([
      { id: a.id, code: "redirect_chain_source" },
      { id: b.id, code: "nothing_changed" },
    ]);
    const list = await listRedirects(t.db, content.actor, { q: "chain", state: "all", page: 1 }, NOW);
    expect(list.rows.every((entry) => entry.fromPath.includes("chain"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── preview, schedule, no cost data

describe("preview links, the schedule, cost data", () => {
  test("a signed link: the kind's permission, tampering, expiry, staleness; no secret → an honest refusal", async () => {
    const banner = await saveBanner(t.db, content.actor, { placement: "home_strip", title: { ar: "معاينة" } }, tick());
    const link = await previewLink(t.db, content.actor, { kind: "banner", id: banner.bannerId }, SECRET, clock);
    expect(link.path).toBe(`/admin/cms/preview/${link.token}`);
    const opened = await openPreview(t.db, content.actor, link.token, SECRET, "ar", clock);
    expect(opened).toMatchObject({ kind: "banner", stale: false, banner: { title: { ar: "معاينة" } } });
    expect(await code(() => openPreview(t.db, searchOnly.actor, link.token, SECRET, "ar", clock))).toBe("forbidden");
    const tampered = `${link.token.slice(0, -2)}${link.token.endsWith("A") ? "B" : "A"}A`;
    expect(await code(() => openPreview(t.db, content.actor, tampered, SECRET, "ar", clock))).toBe("preview_invalid");
    expect(await code(() => openPreview(t.db, content.actor, link.token, SECRET, "ar", clock + 8 * DAY_MS))).toBe("preview_invalid");
    expect(await code(() => previewLink(t.db, content.actor, { kind: "banner", id: banner.bannerId }, "", clock))).toBe("preview_secret");
    const row = await t.db.select().from(banners).where(eq(banners.id, banner.bannerId)).get();
    await saveBanner(t.db, content.actor, { bannerId: banner.bannerId, version: row!.updatedAt, placement: "home_strip", title: { ar: "معاينة بعد التغيير" } }, tick());
    expect(await openPreview(t.db, content.actor, link.token, SECRET, "ar", clock)).toMatchObject({ stale: true, banner: { title: { ar: "معاينة بعد التغيير" } } });
  });

  test("the schedule: banners, pins and the catalogue's dates by Iraq day, with the problems named", async () => {
    const start = NOW + 5 * DAY_MS;
    const banner = await saveBanner(t.db, content.actor, { placement: "home_strip", title: { ar: "إصدار" }, link: `/p/${draftProduct.slug}`, startsAt: baghdadLocal(start) }, tick());
    // a scheduled banner pointing at a draft product would be refused at publish; force the state to see the warning
    await t.db.update(banners).set({ status: "scheduled" }).where(eq(banners.id, banner.bannerId));
    const schedule = await getSchedule(t.db, content.actor, { from: null, days: 30 }, "ar", NOW);
    const item = schedule.days.flatMap((day) => day.items).find((entry) => entry.key === `banner:${banner.bannerId}:start`);
    expect(item).toMatchObject({ kind: "banner", problem: "product_not_ready" });
    expect(schedule.problems).toBeGreaterThan(0);
    expect(schedule.can).toMatchObject({ banners: true, pins: true, catalog: true });
  });

  test("no supplier cost or margin leaves the module: the pin picker and the editors carry none", async () => {
    const candidates = await searchPinProducts(t.db, owner.actor, { platform: consoleProduct.platform, q: "" }, "ar", NOW);
    const text = JSON.stringify(candidates) + JSON.stringify(await getSeoEditor(t.db, owner.actor, "product", consoleProduct.id));
    for (const word of ["unitCost", "unit_cost", "costIqd", "landed", "margin", "fxRate"]) expect(text).not.toContain(word);
  });
});
