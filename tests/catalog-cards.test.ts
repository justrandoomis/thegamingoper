/**
 * Catalogue read layer (app/server/services/catalog/*) against a real local D1.
 *
 * Two kinds of data, on purpose:
 *   · the DEMO catalogue (seedDemo) — volume and variety. Tests that run over it derive every expectation from the
 *     database itself (raw SQL), never from a product slug, so they keep holding when the researched catalogue
 *     (catalog/products/*.json) replaces the demo one.
 *   · the TEST WORLD built in beforeAll — its own platform ("zz-test"), generation, two device models, a parent and a
 *     child category and nine products with known prices, stock, variants, a bundle, a preorder, compatibility
 *     rules, pictures, search rows and reviews. Filtering on platform "zz-test" isolates it, so exact expectations
 *     (prices at the range bounds, which rule wins, which state a bundle has) are written down here.
 *
 * Covered: published-only listing; every filter (platform, category with sub-categories, kind, device model with
 * rule precedence, search text in three languages, price range, in stock, deals) alone, combined and all at once;
 * every sort with keyset paging that never repeats or skips; stock states identical to the commerce core's
 * getAvailability() (reservations, bundles, preorder; a demo row never "low"); ar / en / ckb; ratings from approved
 * verified-purchase reviews only; no protected field (cost, margin, serial, quantity) anywhere; shelves; platforms,
 * category tree and the cached navigation taxonomy. Design v2 (card-facts.ts): the suggested order (in stock › coming
 * soon › sold out), «جديد» only from real dates (≤ 30 days), the kind label, a struck price only when really charged
 * (or a demo row's demo value, flagged), the opaque-photo flag.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getArt, isPhoto, photoKeys } from "~/art";
import type { ProductCardData, StockState } from "~/lib/dto";
import { LOCALE_CODES, pick, type L10n, type Locale } from "~/lib/locales";
import { isAppError } from "~/server/errors";
import { bundleItems, categories, compatibilityRules, deviceGenerations, deviceModels, media, platforms, priceChanges, products, reviews, stockLevels, variantCosts, variants } from "~/server/db/schema";
import { searchIndexStatements } from "~/server/db/search.server";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { DAY_MS, isNewProduct, kindLabelOf, NEW_WINDOW_DAYS, opaqueOf, qualifiedLine, qualifierOf, shoppingTier, shortModelName, shownStockRank, type DeviceFamily } from "~/server/services/catalog/card-facts";
import { getCardsByIds, getDeals, getNewArrivals, getUsedSpotlight, listCards, MAX_CARD_PAGE } from "~/server/services/catalog/cards.server";
import { listProducts, loadListingRows } from "~/server/services/catalog/listing.server";
import { getProductDetail } from "~/server/services/catalog/product.server";
import { baghdadMidnight } from "~/server/services/catalog/product-types";
import { getCategoryTree, getNavTaxonomy, getPlatforms, invalidateNavTaxonomy, NAV_CHECK_MS } from "~/server/services/catalog/taxonomy.server";
import { suggestSearchWithTotal } from "~/server/services/search.server";
import type { CardSort } from "~/server/services/catalog/types";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures } from "./helpers/factories";

let t: TestDb;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const parse = (text: string | null): L10n | null => (text ? (JSON.parse(text) as L10n) : null);
const ids = (cards: { id: string }[]) => cards.map((card) => card.id);
const sorted = (values: string[]) => [...values].sort();

/** Every page of a listing, following nextCursor. */
async function allPages(options: Parameters<typeof listCards>[2], locale: Locale = "ar") {
  const items: ProductCardData[] = [];
  let cursor: string | null = null;
  let total = -1;
  for (let guard = 0; guard < 200; guard++) {
    const page = await listCards(t.db, locale, { ...options, cursor });
    if (total === -1) total = page.total;
    expect(page.total).toBe(total); // the total does not depend on the page
    items.push(...page.items);
    if (!page.nextCursor) break;
    expect(page.items.length).toBe(options.limit);
    cursor = page.nextCursor;
  }
  return { items, total };
}

// ───────────────────────────────────────────────────────────────── the test world

const DAY = 86_400_000;
const PLATFORM = "zz-test";
const W = {
  platform: "plt_zz_test",
  generation: "gen_zz_test",
  modelA: "dm_zz_a",
  modelB: "dm_zz_b",
  parent: "cat_zz_parent",
  child: "cat_zz_child",
} as const;

/** Product ids, their (default) variant ids, and what each one is for. */
const P = {
  console: { id: "prd_zz_console", v: "var_zz_console" }, // in stock (10), IS model A, on the parent category, 500,000
  game: { id: "prd_zz_game", v: "var_zz_game" }, // low (2), a real deal 60,000 ← 80,000, child category
  controller: { id: "prd_zz_controller", v: "var_zz_controller" }, // out of stock, 60,000 (price tie with game), child
  headset: { id: "prd_zz_headset", v: "var_zz_headset" }, // in stock (5), compare-at = price (NOT a deal), parent
  twoVariants: { id: "prd_zz_two", v: "var_zz_two_a", v2: "var_zz_two_b" }, // default 90,000 out · second 95,000 in
  bundle: { id: "prd_zz_bundle", v: "var_zz_bundle" }, // components: console ×1 + game ×1 → 2 complete sets → low
  preorder: { id: "prd_zz_preorder", v: "var_zz_preorder" }, // released in 10 days, no stock, 70,000, child
  draft: { id: "prd_zz_draft", v: "var_zz_draft" }, // status draft → never listed
  noVariant: { id: "prd_zz_novariant", v: "var_zz_novariant" }, // its only variant is inactive → never listed
} as const;
const LISTED = [P.console, P.game, P.controller, P.headset, P.twoVariants, P.bundle, P.preorder].map((p) => p.id);

/**
 * A second little world for RESEARCHED platforms: two more platforms ("zz-multi", "zz-other", a model each) and
 * products sold for several of them, which have no platform_id — all on one department ("zz-multi-cat"). None of them
 * is for "zz-test", so the first world's expectations do not move.
 */
const MULTI = { platform: "zz-multi", other: "zz-other", category: "zz-multi-cat" } as const;
const Z = {
  multi: "plt_zz_multi",
  other: "plt_zz_other",
  genM: "gen_zz_m",
  genO: "gen_zz_o",
  modelM: "dm_zz_m",
  modelO: "dm_zz_o",
  category: "cat_zz_multi",
} as const;
const M = {
  game: "prd_zz_m_game", // game facts name models M and O → both platforms
  headset: "prd_zz_m_headset", // rules: model M verified, platform O partial → both platforms
  factsWin: "prd_zz_m_facts", // game facts name O only; its verified rule on M is not read (facts come first) → O
  none: "prd_zz_m_none", // rules: M unverified, O's generation incompatible → no platform at all
  own: "prd_zz_m_own", // its own platform is O (platform_id) → O, whatever its rules say
  broken: "prd_zz_m_broken", // malformed attributes JSON (set after the batch); a verified rule on M's generation → M
} as const;

const name3 = (ar: string, en: string, ckb: string): L10n => ({ ar, en, ckb });

async function buildTestWorld(now: number) {
  const db = t.db;
  const product = (key: keyof typeof P, values: Partial<typeof products.$inferInsert> & { kind: (typeof products.$inferInsert)["kind"]; name: L10n; publishedDaysAgo: number }) => {
    const { publishedDaysAgo, ...rest } = values;
    return db.insert(products).values({
      id: P[key].id,
      slug: `zz-${key.toLowerCase()}`,
      platformId: W.platform,
      status: "published",
      isDemo: false,
      createdAt: now - 30 * DAY,
      updatedAt: now - publishedDaysAgo * DAY,
      publishedAt: now - publishedDaysAgo * DAY,
      ...rest,
    });
  };
  const variant = (id: string, productId: string, priceIqd: number, extra: Partial<typeof variants.$inferInsert> = {}) =>
    db.insert(variants).values({ id, productId, sku: id.toUpperCase(), priceIqd, isDefault: true, ...extra });
  const stock = (variantId: string, onHand: number) => db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand });

  const statements: BatchStatement[] = [
    db.insert(platforms).values({ id: W.platform, slug: PLATFORM, name: name3("منصة الاختبار", "Test platform", "پلاتفۆرمی تاقیکردنەوە"), accent: "brand", sort: 99 }),
    db.insert(deviceGenerations).values({ id: W.generation, platformId: W.platform, slug: "zz-gen", name: name3("الجيل التجريبي", "Test generation", "نەوەی تاقیکردنەوە") }),
    db.insert(deviceModels).values({ id: W.modelA, platformId: W.platform, generationId: W.generation, slug: "zz-model-a", name: name3("الجهاز أ", "Model A", "ئامێری A"), status: "published", sort: 1 }),
    db.insert(deviceModels).values({ id: W.modelB, platformId: W.platform, generationId: W.generation, slug: "zz-model-b", name: name3("الجهاز ب", "Model B", "ئامێری B"), status: "published", sort: 2 }),
    db.insert(categories).values({ id: W.parent, slug: "zz-parent", kind: "zz", sort: 99, name: name3("قسم الاختبار", "Test department", "بەشی تاقیکردنەوە") }),
    db.insert(categories).values({ id: W.child, parentId: W.parent, slug: "zz-child", kind: "zz", sort: 1, name: name3("فرع الاختبار", "Test branch", "لقی تاقیکردنەوە") }),

    product("console", { kind: "console", name: name3("جهاز زقزق", "Zorblax console", "ئامێری زۆربلاکس"), short: name3("نسخة 1TB", "1TB edition", "وەشانی 1TB"), deviceModelId: W.modelA, categoryId: W.parent, publishedDaysAgo: 5 }),
    variant(P.console.v, P.console.id, 500_000),
    stock(P.console.v, 10),
    product("game", { kind: "game", name: name3("لعبة الاختبار", "Test game", "یاریی تاقیکردنەوە"), categoryId: W.child, publishedDaysAgo: 4 }),
    variant(P.game.v, P.game.id, 60_000, { compareAtIqd: 80_000 }),
    stock(P.game.v, 2),
    // the store really charged 80,000: an applied price change set the compare-at (admin pricing's honest path)
    db.insert(priceChanges).values({ id: "pc_zz_game", variantId: P.game.v, oldPriceIqd: 80_000, newPriceIqd: 60_000, oldCompareAtIqd: null, newCompareAtIqd: 80_000, status: "applied", createdAt: now - 3 * DAY }),
    product("controller", { kind: "controller", name: name3("يد الاختبار", "Test controller", "دەسکی تاقیکردنەوە"), categoryId: W.child, publishedDaysAgo: 3 }),
    variant(P.controller.v, P.controller.id, 60_000),
    stock(P.controller.v, 0),
    product("headset", { kind: "headset", name: name3("سماعة الاختبار", "Test headset", "هێدسێتی تاقیکردنەوە"), categoryId: W.parent, publishedDaysAgo: 2 }),
    variant(P.headset.v, P.headset.id, 120_000, { compareAtIqd: 120_000 }),
    stock(P.headset.v, 5),
    product("twoVariants", { kind: "accessory", name: name3("ملحق بلونين", "Two-colour accessory", "پاشکۆی دوو ڕەنگ"), publishedDaysAgo: 1 }),
    variant(P.twoVariants.v, P.twoVariants.id, 90_000, { sort: 0 }),
    variant(P.twoVariants.v2, P.twoVariants.id, 95_000, { isDefault: false, sort: 1 }),
    stock(P.twoVariants.v, 0),
    stock(P.twoVariants.v2, 8),
    product("bundle", { kind: "bundle", name: name3("حزمة الاختبار", "Test bundle", "باندڵی تاقیکردنەوە"), publishedDaysAgo: 6 }),
    variant(P.bundle.v, P.bundle.id, 540_000),
    db.insert(bundleItems).values({ bundleVariantId: P.bundle.v, componentVariantId: P.console.v, qty: 1 }),
    db.insert(bundleItems).values({ bundleVariantId: P.bundle.v, componentVariantId: P.game.v, qty: 1 }),
    product("preorder", { kind: "game", name: name3("لعبة قادمة", "Upcoming game", "یارییەکی داهاتوو"), categoryId: W.child, preorderReleaseAt: now + 10 * DAY, publishedDaysAgo: 7 }),
    variant(P.preorder.v, P.preorder.id, 70_000),
    product("draft", { kind: "accessory", name: name3("مسودة", "Draft", "ڕەشنووس"), status: "draft", publishedDaysAgo: 0 }),
    variant(P.draft.v, P.draft.id, 10_000),
    stock(P.draft.v, 3),
    product("noVariant", { kind: "accessory", name: name3("بلا نسخة فعالة", "No active variant", "بێ وەشانی چالاک"), publishedDaysAgo: 0 }),
    variant(P.noVariant.v, P.noVariant.id, 10_000, { isActive: false }),

    // compatibility for the device-model filter
    db.insert(compatibilityRules).values({ id: "cr_zz_game_gen", subjectType: "product", subjectId: P.game.id, targetType: "generation", targetId: W.generation, status: "verified" }),
    db.insert(compatibilityRules).values({ id: "cr_zz_game_b", subjectType: "product", subjectId: P.game.id, targetType: "device_model", targetId: W.modelB, status: "incompatible" }),
    db.insert(compatibilityRules).values({ id: "cr_zz_ctl_plat", subjectType: "product", subjectId: P.controller.id, targetType: "platform", targetId: W.platform, status: "partial" }),
    db.insert(compatibilityRules).values({ id: "cr_zz_head_a", subjectType: "product", subjectId: P.headset.id, targetType: "device_model", targetId: W.modelA, status: "unverified" }),
    db.insert(compatibilityRules).values({ id: "cr_zz_two_b", subjectType: "variant", subjectId: P.twoVariants.v2, targetType: "device_model", targetId: W.modelB, status: "verified" }),

    // pictures: the headset has a product picture and a variant picture (the variant's wins)
    db.insert(media).values({ id: "med_zz_head_p", ownerType: "product", ownerId: P.headset.id, artKey: "zz-art-product", kind: "image", alt: name3("صورة", "Picture", "وێنە"), sort: 0 }),
    db.insert(media).values({ id: "med_zz_head_v", ownerType: "variant", ownerId: P.headset.v, artKey: "zz-art-variant", kind: "image", alt: name3("صورة النسخة", "Variant picture", "وێنەی وەشان"), sort: 5 }),

    // protected data that must never come back
    db.insert(variantCosts).values({ variantId: P.console.v, currency: "USD", unitCostMinor: 31_337_00, landedCostIqd: 424_242, updatedAt: now }),

    // the researched-platforms world (see MULTI)
    ...multiPlatformWorld(now),

    // search rows in three languages (search index writes go last in a batch — drizzle/README.md)
    ...searchIndexStatements(db, P.console.id, [
      { locale: "ar", name: "جهاز زقزق", keywords: "zx" },
      { locale: "en", name: "Zorblax console", keywords: "zx" },
      { locale: "ckb", name: "ئامێری زۆربلاکس", keywords: "zx" },
    ]),
  ];
  await runBatch(db, statements);
  // not JSON at all: the platform rules must read it as "no game facts", never fail the statement
  await t.d1.prepare("UPDATE products SET attributes = '{\"game\": {\"platforms\": [' WHERE id = ?").bind(M.broken).run();
}

function multiPlatformWorld(now: number): BatchStatement[] {
  const db = t.db;
  const product = (id: string, kind: (typeof products.$inferInsert)["kind"], platformId: string | null, attributes: Record<string, unknown> | null, daysAgo: number) =>
    db.insert(products).values({
      id,
      slug: id.replace(/^prd_/, "").replace(/_/g, "-"),
      kind,
      name: name3(`منتج ${id}`, `Product ${id}`, `بەرهەمی ${id}`),
      platformId,
      categoryId: Z.category,
      attributes,
      status: "published",
      isDemo: false,
      createdAt: now - 40 * DAY,
      updatedAt: now - daysAgo * DAY,
      publishedAt: now - daysAgo * DAY,
    });
  const variant = (productId: string, priceIqd: number) => db.insert(variants).values({ id: productId.replace(/^prd_/, "var_"), productId, sku: productId.toUpperCase(), priceIqd, isDefault: true });
  const rule = (id: string, subjectId: string, targetType: "device_model" | "generation" | "platform", targetId: string, status: "verified" | "partial" | "unverified" | "incompatible") =>
    db.insert(compatibilityRules).values({ id, subjectType: "product", subjectId, targetType, targetId, status });
  const games = (...models: string[]) => ({ game: { platforms: models } });
  return [
    db.insert(platforms).values({ id: Z.multi, slug: MULTI.platform, name: name3("منصة متعددة", "Multi platform", "پلاتفۆرمی فرە"), accent: "brand", sort: 97 }),
    db.insert(platforms).values({ id: Z.other, slug: MULTI.other, name: name3("منصة أخرى", "Other platform", "پلاتفۆرمی تر"), accent: "brand", sort: 98 }),
    db.insert(deviceGenerations).values({ id: Z.genM, platformId: Z.multi, slug: "zz-gen-m", name: name3("جيل م", "Generation M", "نەوەی M") }),
    db.insert(deviceGenerations).values({ id: Z.genO, platformId: Z.other, slug: "zz-gen-o", name: name3("جيل و", "Generation O", "نەوەی O") }),
    db.insert(deviceModels).values({ id: Z.modelM, platformId: Z.multi, generationId: Z.genM, slug: "zz-model-m", name: name3("الجهاز م", "Model M", "ئامێری M"), status: "published", sort: 1 }),
    db.insert(deviceModels).values({ id: Z.modelO, platformId: Z.other, generationId: Z.genO, slug: "zz-model-o", name: name3("الجهاز و", "Model O", "ئامێری O"), status: "published", sort: 1 }),
    db.insert(categories).values({ id: Z.category, slug: MULTI.category, kind: "zz-multi", sort: 98, name: name3("قسم متعدد المنصات", "Multi-platform department", "بەشی فرە پلاتفۆرم") }),

    product(M.game, "game", null, games("zz-model-m", "zz-model-o"), 11),
    variant(M.game, 50_000),
    product(M.headset, "headset", null, null, 12),
    variant(M.headset, 75_000),
    rule("cr_zz_m_head_m", M.headset, "device_model", Z.modelM, "verified"),
    rule("cr_zz_m_head_o", M.headset, "platform", Z.other, "partial"),
    product(M.factsWin, "game", null, games("zz-model-o"), 13),
    variant(M.factsWin, 40_000),
    rule("cr_zz_m_facts_m", M.factsWin, "device_model", Z.modelM, "verified"),
    product(M.none, "accessory", null, { highlights: [] }, 14),
    variant(M.none, 20_000),
    rule("cr_zz_m_none_m", M.none, "device_model", Z.modelM, "unverified"),
    rule("cr_zz_m_none_o", M.none, "generation", Z.genO, "incompatible"),
    product(M.own, "console", Z.other, null, 15),
    variant(M.own, 400_000),
    rule("cr_zz_m_own_m", M.own, "device_model", Z.modelM, "verified"),
    product(M.broken, "storage", null, null, 16),
    variant(M.broken, 30_000),
    rule("cr_zz_m_broken_g", M.broken, "generation", Z.genM, "verified"),
  ];
}

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
  await buildTestWorld(t.now);
  invalidateNavTaxonomy();
});

afterAll(async () => {
  await t?.dispose();
});

const LISTED_SQL =
  "SELECT p.id FROM products p WHERE p.status = 'published' AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_active = 1)";

// ───────────────────────────────────────────────────────────────── what is listed

describe("listCards — what is listed", () => {
  it("lists exactly the published products that have an active variant", async () => {
    const expected = await rows<{ id: string }>(`${LISTED_SQL} ORDER BY p.id`);
    expect(expected.length).toBeGreaterThan(LISTED.length);
    const { items, total } = await allPages({ sort: "newest", limit: MAX_CARD_PAGE });
    expect(total).toBe(expected.length);
    expect(sorted(ids(items))).toEqual(expected.map((row) => row.id));
  });

  it("hides drafts and products without an active variant", async () => {
    const { items, total } = await allPages({ platform: PLATFORM, sort: "newest", limit: MAX_CARD_PAGE });
    expect(total).toBe(LISTED.length);
    expect(sorted(ids(items))).toEqual(sorted(LISTED));
    expect(await getCardsByIds(t.db, "ar", [P.draft.id, P.noVariant.id])).toEqual([]);
    // archived too
    await t.d1.prepare("UPDATE products SET status = 'archived' WHERE id = ?").bind(P.headset.id).run();
    try {
      expect(await getCardsByIds(t.db, "ar", [P.headset.id])).toEqual([]);
      expect(ids((await listCards(t.db, "ar", { platform: PLATFORM, sort: "newest", limit: MAX_CARD_PAGE })).items)).not.toContain(P.headset.id);
    } finally {
      await t.d1.prepare("UPDATE products SET status = 'published' WHERE id = ?").bind(P.headset.id).run();
    }
  });

  it("shows the version on sale: the default when it can be bought, else the next one — never a sold-out default's price — and never an inactive one", async () => {
    const card = async () => (await getCardsByIds(t.db, "en", [P.twoVariants.id]))[0];
    const onHand = (variantId: string, n: number) => t.d1.prepare("UPDATE stock_levels SET on_hand = ? WHERE variant_id = ?").bind(n, variantId).run();
    // the default (90,000) is sold out and the second version (95,000) is not: the card prices what can be bought
    const before = await card();
    expect(before.variantId).toBe(P.twoVariants.v2);
    expect(before.priceIqd).toBe(95_000);
    expect(before.hasVariants).toBe(true);
    expect(before.stock).toBe("in_stock");
    // the listing universe (filters, price sorts) reads the same version
    const { rows: universe } = await loadListingRows(t.db, { kind: "products", ids: [P.twoVariants.id] }, t.now);
    expect(universe[0]?.price).toBe(95_000);
    try {
      // the default can be bought again: it leads
      await onHand(P.twoVariants.v, 6);
      expect(await card()).toMatchObject({ variantId: P.twoVariants.v, priceIqd: 90_000 });
      // nothing can be bought: the default, as it is
      await onHand(P.twoVariants.v, 0);
      await onHand(P.twoVariants.v2, 0);
      expect(await card()).toMatchObject({ variantId: P.twoVariants.v, priceIqd: 90_000, stock: "out_of_stock" });
    } finally {
      await onHand(P.twoVariants.v, 0);
      await onHand(P.twoVariants.v2, 8);
    }
    await t.d1.prepare("UPDATE variants SET is_active = 0 WHERE id = ?").bind(P.twoVariants.v).run();
    try {
      const [after] = await getCardsByIds(t.db, "en", [P.twoVariants.id]);
      expect(after.variantId).toBe(P.twoVariants.v2);
      expect(after.priceIqd).toBe(95_000);
      expect(after.hasVariants).toBe(false);
    } finally {
      await t.d1.prepare("UPDATE variants SET is_active = 1 WHERE id = ?").bind(P.twoVariants.v).run();
    }
  });
});

// ───────────────────────────────────────────────────────────────── sorting and paging

describe("listCards — sorting and keyset paging", () => {
  const SORTS: CardSort[] = ["featured", "newest", "price_asc", "price_desc"];

  for (const sort of SORTS) {
    it(`pages through the whole catalogue by "${sort}" in pages of 7 without duplicates or gaps`, async () => {
      const { items, total } = await allPages({ sort, limit: 7 });
      expect(items.length).toBe(total);
      expect(new Set(ids(items)).size).toBe(total);
      const single = await listCards(t.db, "ar", { sort, limit: MAX_CARD_PAGE });
      expect(ids(items).slice(0, single.items.length)).toEqual(ids(single.items));
    });
  }

  it("orders by price, ties broken by id", async () => {
    const asc = (await allPages({ sort: "price_asc", limit: 20 })).items;
    for (let i = 1; i < asc.length; i++) {
      expect(asc[i].priceIqd > asc[i - 1].priceIqd || (asc[i].priceIqd === asc[i - 1].priceIqd && asc[i].id > asc[i - 1].id)).toBe(true);
    }
    const desc = (await allPages({ sort: "price_desc", limit: 20 })).items;
    for (let i = 1; i < desc.length; i++) {
      expect(desc[i].priceIqd < desc[i - 1].priceIqd || (desc[i].priceIqd === desc[i - 1].priceIqd && desc[i].id < desc[i - 1].id)).toBe(true);
    }
    // the two 60,000 products of the test world, on either side of a page boundary
    const world = await allPages({ platform: PLATFORM, sort: "price_asc", limit: 1 });
    const tie = ids(world.items).filter((id) => id === P.game.id || id === P.controller.id);
    expect(tie).toEqual(sorted([P.game.id, P.controller.id]));
  });

  it("orders newest by publication time", async () => {
    const expected = await rows<{ id: string }>(`${LISTED_SQL} ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC`);
    expect(ids((await allPages({ sort: "newest", limit: 13 })).items)).toEqual(expected.map((row) => row.id));
  });

  it("featured is the suggested order: what can be bought now, then coming soon, then sold out — newest first inside", async () => {
    const tierOf = (card: ProductCardData) => (card.stock === "preorder" ? 1 : card.stock === "out_of_stock" ? 0 : 2);
    const { items } = await allPages({ sort: "featured", limit: 9 });
    for (let i = 1; i < items.length; i++) expect(tierOf(items[i]), items[i].slug).toBeLessThanOrEqual(tierOf(items[i - 1]));
    expect(new Set(items.map(tierOf))).toEqual(new Set([0, 1, 2])); // the demo catalogue has all three
    // the first card can be bought (the old order put coming-soon products first)
    expect(tierOf(items[0])).toBe(2);
    // the test world, written down: in stock by publication (1, 2, 4, 5, 6 days ago), the coming-soon game, then the
    // sold-out controller
    const world = ids((await allPages({ platform: PLATFORM, sort: "featured", limit: 3, now: t.now })).items);
    expect(world).toEqual([P.twoVariants.id, P.headset.id, P.game.id, P.console.id, P.bundle.id, P.preorder.id, P.controller.id]);
  });

  it("refuses a malformed cursor and a cursor made for another sort", async () => {
    const page = await listCards(t.db, "ar", { sort: "price_asc", limit: 5 });
    expect(page.nextCursor).not.toBeNull();
    for (const [sort, cursor] of [["price_asc", "not-a-cursor!"], ["newest", page.nextCursor], ["price_asc", "WzEsMl0"]] as const) {
      const error = await listCards(t.db, "ar", { sort, limit: 5, cursor }).catch((caught: unknown) => caught);
      expect(isAppError(error, "invalid")).toBe(true);
    }
  });

  it("validates its options", async () => {
    for (const bad of [{ limit: 0 }, { limit: MAX_CARD_PAGE + 1 }, { priceMin: -1 }, { priceMax: 1.5 }, { platform: "Play Station" }, { kind: "spaceship" }, { category: "../x" }]) {
      const error = await listCards(t.db, "ar", { sort: "newest", limit: 10, ...(bad as object) }).catch((caught: unknown) => caught);
      expect(isAppError(error, "invalid")).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────── filters

describe("listCards — filters", () => {
  const world = (options: Omit<Parameters<typeof listCards>[2], "sort" | "limit">) => listCards(t.db, "ar", { platform: PLATFORM, sort: "newest", limit: MAX_CARD_PAGE, ...options });

  it("filters by the RESEARCHED platforms: own platform, else game facts, else verified/partial rules", async () => {
    const of = async (platform: string | string[]) => sorted(ids((await allPages({ platform, sort: "newest", limit: MAX_CARD_PAGE })).items));
    expect(await of(MULTI.platform)).toEqual(sorted([M.game, M.headset, M.broken]));
    expect(await of(MULTI.other)).toEqual(sorted([M.game, M.headset, M.factsWin, M.own]));
    expect(await of([MULTI.platform, MULTI.other])).toEqual(sorted([M.game, M.headset, M.factsWin, M.own, M.broken]));
    // a multi-platform card names no platform of its own
    const [game, own] = await getCardsByIds(t.db, "en", [M.game, M.own]);
    expect([game.platformSlug, own.platformSlug]).toEqual([null, MULTI.other]);
    expect((await listCards(t.db, "ar", { platform: "no-such-platform", sort: "newest", limit: 5 })).total).toBe(0);
    // an inactive platform lists nothing, even through game facts and rules
    await t.d1.prepare("UPDATE platforms SET is_active = 0 WHERE id = ?").bind(Z.multi).run();
    try {
      expect(await of(MULTI.platform)).toEqual([]);
      expect(await of(MULTI.other)).toEqual(sorted([M.game, M.headset, M.factsWin, M.own]));
    } finally {
      await t.d1.prepare("UPDATE platforms SET is_active = 1 WHERE id = ?").bind(Z.multi).run();
    }
  });

  it("lists exactly what each platform hub lists (catalog area), multi-platform games and headsets included", async () => {
    const platformRows = await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 1");
    let multi = 0;
    for (const { slug } of platformRows) {
      const { rows: hub } = await loadListingRows(t.db, { kind: "platform", slug }, t.now);
      const viaCards = await allPages({ platform: slug, sort: "featured", limit: MAX_CARD_PAGE });
      expect(viaCards.total, slug).toBe(hub.length);
      expect(sorted(ids(viaCards.items)), slug).toEqual(sorted(hub.map((row) => row.id)));
      for (const card of viaCards.items) expect([slug, null], card.slug).toContain(card.platformSlug);
      if (!slug.startsWith("zz-")) multi += viaCards.items.filter((card) => card.platformSlug === null).length;
    }
    expect(multi).toBeGreaterThan(0); // the demo catalogue's games sold for PS5 and Xbox, headsets for several
    // several platforms at once: the union
    const [a, b] = ["playstation", "xbox"];
    const union = new Set([...(await loadListingRows(t.db, { kind: "platform", slug: a }, t.now)).rows, ...(await loadListingRows(t.db, { kind: "platform", slug: b }, t.now)).rows].map((row) => row.id));
    expect(sorted(ids((await allPages({ platform: [a, b], sort: "newest", limit: MAX_CARD_PAGE })).items))).toEqual(sorted([...union]));
  });

  it("includes sub-categories in a category", async () => {
    const parent = await listCards(t.db, "ar", { category: "zz-parent", sort: "newest", limit: MAX_CARD_PAGE });
    expect(sorted(ids(parent.items))).toEqual(sorted([P.console.id, P.headset.id, P.game.id, P.controller.id, P.preorder.id]));
    const child = await listCards(t.db, "ar", { category: "zz-child", sort: "newest", limit: MAX_CARD_PAGE });
    expect(sorted(ids(child.items))).toEqual(sorted([P.game.id, P.controller.id, P.preorder.id]));
    // over the seeded catalogue: a parent counts its children's products (derived from SQL)
    const [tree] = await rows<{ slug: string; n: number }>(
      `SELECT parent.slug, COUNT(*) AS n FROM products p JOIN categories c ON c.id = p.category_id JOIN categories parent ON parent.id = c.parent_id
       WHERE p.status = 'published' AND parent.parent_id IS NULL AND parent.slug NOT LIKE 'zz-%' GROUP BY parent.slug ORDER BY n DESC LIMIT 1`,
    );
    const [{ own }] = await rows<{ own: number }>("SELECT COUNT(*) AS own FROM products p JOIN categories c ON c.id = p.category_id WHERE p.status = 'published' AND c.slug = ?", tree.slug);
    expect((await listCards(t.db, "ar", { category: tree.slug, sort: "newest", limit: 1 })).total).toBe(Number(tree.n) + Number(own));
    // an inactive category lists nothing
    await t.d1.prepare("UPDATE categories SET is_active = 0 WHERE id = ?").bind(W.parent).run();
    try {
      expect((await listCards(t.db, "ar", { category: "zz-parent", sort: "newest", limit: 5 })).total).toBe(0);
      expect((await listCards(t.db, "ar", { category: "zz-child", sort: "newest", limit: 5 })).total).toBe(3);
    } finally {
      await t.d1.prepare("UPDATE categories SET is_active = 1 WHERE id = ?").bind(W.parent).run();
    }
  });

  it("filters by kind", async () => {
    expect(sorted(ids((await world({ kind: ["controller", "headset"] })).items))).toEqual(sorted([P.controller.id, P.headset.id]));
    expect(ids((await world({ kind: "bundle" })).items)).toEqual([P.bundle.id]);
  });

  it("filters by price range, inclusively, on the card variant's price", async () => {
    const page = await world({ priceMin: 60_000, priceMax: 90_000 });
    // 60,000 ×2 (game, controller), 70,000 (preorder) — the two-variant product is priced by its version on sale
    // (95,000: its 90,000 default is sold out), so it is not in this range…
    expect(sorted(ids(page.items))).toEqual(sorted([P.game.id, P.controller.id, P.preorder.id]));
    expect((await world({ priceMin: 90_001, priceMax: 94_999 })).total).toBe(0);
    // …but in the one of the price it shows
    expect(ids((await world({ priceMin: 95_000, priceMax: 95_000 })).items)).toEqual([P.twoVariants.id]);
  });

  it("keeps only what can be bought now with inStockOnly", async () => {
    expect(sorted(ids((await world({ inStockOnly: true })).items))).toEqual(sorted([P.console.id, P.game.id, P.headset.id, P.twoVariants.id, P.bundle.id]));
    const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE })).items;
    const inStock = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE, inStockOnly: true })).items;
    expect(inStock.every((card) => card.stock === "in_stock" || card.stock === "low_stock")).toBe(true);
    expect(inStock.length).toBe(all.filter((card) => card.stock === "in_stock" || card.stock === "low_stock").length);
  });

  it("keeps only previous prices the card strikes with dealsOnly: really charged, or a demo row's demo value", async () => {
    expect(ids((await world({ dealsOnly: true })).items)).toEqual([P.game.id]);
    const expected = await rows<{ product_id: string }>(
      `SELECT v.product_id FROM variants v JOIN products p ON p.id = v.product_id
       WHERE p.status = 'published' AND v.is_active = 1 AND v.compare_at_iqd > v.price_iqd
         AND v.id = (SELECT v2.id FROM variants v2 WHERE v2.product_id = p.id AND v2.is_active = 1 ORDER BY v2.is_default DESC, v2.sort, v2.id LIMIT 1)
         AND (p.is_demo = 1 OR EXISTS (SELECT 1 FROM price_changes pc WHERE pc.variant_id = v.id AND pc.status = 'applied' AND pc.new_compare_at_iqd = v.compare_at_iqd))
       ORDER BY v.product_id`,
    );
    const deals = await allPages({ dealsOnly: true, sort: "newest", limit: MAX_CARD_PAGE });
    expect(sorted(ids(deals.items))).toEqual(expected.map((row) => row.product_id));
    const demo = new Map((await rows<{ id: string; is_demo: number }>("SELECT id, is_demo FROM products")).map((row) => [row.id, row.is_demo === 1]));
    for (const card of deals.items) {
      expect(card.compareAtIqd!).toBeGreaterThan(card.priceIqd);
      if (card.stock !== "out_of_stock") expect(card.badge).toBe("deal");
      // the seed writes no price history: a demo deal is a demo value, the test world's game was really charged
      expect(card.compareAtDemo, card.slug).toBe(card.id === P.game.id ? false : demo.get(card.id) === true);
    }
  });

  it("never strikes a compare-at price that is not above the price, or that the store never charged", async () => {
    const [headset] = await getCardsByIds(t.db, "ar", [P.headset.id], { now: t.now });
    expect(headset.compareAtIqd).toBeNull();
    expect(headset.badge).toBe("new"); // listed 2 days ago, not a demo row
    // the game's 80,000 is backed by an applied price change; without it the card strikes nothing
    const [backed] = await getCardsByIds(t.db, "ar", [P.game.id], { now: t.now });
    expect([backed.compareAtIqd, backed.compareAtDemo, backed.badge]).toEqual([80_000, false, "deal"]);
    // price history is append-only: requests that are still pending, or were rejected, name other compare-at prices
    await runBatch(t.db, [
      t.db.insert(priceChanges).values({ id: "pc_zz_game_pending", variantId: P.game.v, oldPriceIqd: 60_000, newPriceIqd: 60_000, newCompareAtIqd: 90_000, status: "pending", createdAt: t.now - DAY }),
      t.db.insert(priceChanges).values({ id: "pc_zz_game_rejected", variantId: P.game.v, oldPriceIqd: 60_000, newPriceIqd: 60_000, newCompareAtIqd: 95_000, status: "rejected", createdAt: t.now - DAY }),
    ]);
    // a compare-at no APPLIED change set — another value, or one only a pending or rejected request names — is not struck
    for (const value of [85_000, 90_000, 95_000]) {
      await t.d1.prepare("UPDATE variants SET compare_at_iqd = ? WHERE id = ?").bind(value, P.game.v).run();
      try {
        const [unbacked] = await getCardsByIds(t.db, "ar", [P.game.id], { now: t.now });
        expect([unbacked.compareAtIqd, unbacked.compareAtDemo, unbacked.badge], String(value)).toEqual([null, false, "new"]);
        expect(ids((await world({ dealsOnly: true })).items), String(value)).toEqual([]);
      } finally {
        await t.d1.prepare("UPDATE variants SET compare_at_iqd = 80000 WHERE id = ?").bind(P.game.v).run();
      }
    }
    // on a demo row the same unbacked value is the seed's kind of demo deal: struck, and flagged as demo
    await t.d1.prepare("UPDATE products SET is_demo = 1 WHERE id = ?").bind(P.game.id).run();
    await t.d1.prepare("UPDATE variants SET compare_at_iqd = 85000 WHERE id = ?").bind(P.game.v).run();
    try {
      const [demo] = await getCardsByIds(t.db, "ar", [P.game.id], { now: t.now });
      expect([demo.compareAtIqd, demo.compareAtDemo, demo.badge]).toEqual([85_000, true, "deal"]);
      expect(demo.stock).toBe("in_stock"); // two units left: low stock, but a demo row never says so
    } finally {
      await t.d1.prepare("UPDATE products SET is_demo = 0 WHERE id = ?").bind(P.game.id).run();
      await t.d1.prepare("UPDATE variants SET compare_at_iqd = 80000 WHERE id = ?").bind(P.game.v).run();
    }
  });

  it("searches in Arabic, English and Kurdish, short terms included", async () => {
    for (const [locale, q] of [["ar", "زقزق"], ["en", "zorblax"], ["en", "ZORBLAX Console"], ["ckb", "زۆربلاکس"], ["ar", "zx"]] as const) {
      const page = await listCards(t.db, locale, { q, sort: "featured", limit: MAX_CARD_PAGE });
      expect(ids(page.items), `${locale}: ${q}`).toEqual([P.console.id]);
    }
    expect((await listCards(t.db, "ar", { q: "qqqzzzxxx", sort: "featured", limit: 5 })).total).toBe(0);
    // a query with nothing searchable in it does not filter
    const all = await listCards(t.db, "ar", { sort: "featured", limit: 5 });
    expect((await listCards(t.db, "ar", { q: "  ؟ ", sort: "featured", limit: 5 })).total).toBe(all.total);
  });

  it("filters by device model, the most specific compatibility rule winning", async () => {
    // A: the model itself, the game (generation: verified), the controller (platform: partial)
    expect(sorted(ids((await world({ deviceModel: "zz-model-a" })).items))).toEqual(sorted([P.console.id, P.game.id, P.controller.id]));
    // B: the game's model-level "incompatible" beats its generation-level "verified"; the two-variant product fits
    // through its second variant's rule; the headset's "unverified" never counts
    expect(sorted(ids((await world({ deviceModel: "zz-model-b" })).items))).toEqual(sorted([P.controller.id, P.twoVariants.id]));
    // a rule on an inactive variant does not count
    await t.d1.prepare("UPDATE variants SET is_active = 0 WHERE id = ?").bind(P.twoVariants.v2).run();
    try {
      expect(ids((await world({ deviceModel: "zz-model-b" })).items)).toEqual([P.controller.id]);
    } finally {
      await t.d1.prepare("UPDATE variants SET is_active = 1 WHERE id = ?").bind(P.twoVariants.v2).run();
    }
    expect((await listCards(t.db, "ar", { deviceModel: "no-such-model", sort: "newest", limit: 5 })).total).toBe(0);
  });

  it("combines filters", async () => {
    const page = await world({ category: "zz-child", inStockOnly: true, priceMax: 65_000 });
    expect(ids(page.items)).toEqual([P.game.id]);
  });

  it("runs every filter at once as one statement (D1's nesting limit)", async () => {
    const options = { platform: [PLATFORM, "no-such-platform"], category: "zz-parent", kind: ["console", "game"], deviceModel: "zz-model-a", q: "zorblax", priceMin: 1, priceMax: 600_000, inStockOnly: true, sort: "price_desc", limit: 1 } as const;
    const page = await listCards(t.db, "en", options);
    expect(ids(page.items)).toEqual([P.console.id]);
    expect(page.total).toBe(1);
    const deals = await listCards(t.db, "en", { ...options, dealsOnly: true });
    expect(deals.total).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── card content

describe("cards — stock, language, ratings, privacy", () => {
  it("states stock exactly as the commerce core's getAvailability() does — a demo row never 'low'", async () => {
    const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE }, "ar")).items;
    const variantRows = await rows<{ id: string; product_id: string }>("SELECT id, product_id FROM variants WHERE is_active = 1");
    const availability = await getAvailability(t.db, variantRows.map((row) => row.id));
    const preorders = new Set((await rows<{ id: string }>("SELECT id FROM products WHERE preorder_release_at > ?", Date.now())).map((row) => row.id));
    const rank: Record<StockState, number> = { out_of_stock: 0, low_stock: 1, in_stock: 2, preorder: 3 };
    let demoLow = 0;
    for (const card of all) {
      if (preorders.has(card.id)) continue;
      const own = variantRows.filter((row) => row.product_id === card.id).map((row) => availability.get(row.id)!.state);
      const best = own.reduce<StockState>((acc, state) => (rank[state] > rank[acc] ? state : acc), "out_of_stock");
      const core = card.hasVariants ? best : availability.get(card.variantId)!.state;
      // scarcity from placeholder stock is not information (design v2 spec §4.7): a demo row says "in stock"
      if (card.isDemo && core === "low_stock") demoLow++;
      expect(card.stock, card.slug).toBe(card.isDemo && core === "low_stock" ? "in_stock" : core);
    }
    expect(demoLow).toBeGreaterThan(0); // the demo catalogue has low stock to hide
    // the test world, written down
    const states = new Map((await getCardsByIds(t.db, "ar", LISTED, { now: t.now })).map((card) => [card.id, card.stock]));
    expect(Object.fromEntries(states)).toEqual({
      [P.console.id]: "in_stock",
      [P.game.id]: "low_stock",
      [P.controller.id]: "out_of_stock",
      [P.headset.id]: "in_stock",
      [P.twoVariants.id]: "in_stock", // the best of its variants (90,000 is out, 95,000 is in)
      [P.bundle.id]: "low_stock", // min(10 consoles, 2 games) = 2 complete sets
      [P.preorder.id]: "preorder",
    });
  });

  it("counts reserved units, and a bundle by its scarcest component", async () => {
    await t.d1.prepare("UPDATE stock_levels SET reserved = on_hand WHERE variant_id = ?").bind(P.console.v).run();
    try {
      const cards = await getCardsByIds(t.db, "ar", [P.console.id, P.bundle.id]);
      expect(cards.map((card) => card.stock)).toEqual(["out_of_stock", "out_of_stock"]);
    } finally {
      await t.d1.prepare("UPDATE stock_levels SET reserved = 0 WHERE variant_id = ?").bind(P.console.v).run();
    }
    await t.d1.prepare("UPDATE stock_levels SET on_hand = 40 WHERE variant_id = ?").bind(P.game.v).run();
    try {
      const [bundle] = await getCardsByIds(t.db, "ar", [P.bundle.id]);
      expect(bundle.stock).toBe("in_stock"); // min(10, 40) = 10 sets
      const availability = await getAvailability(t.db, [P.bundle.v]);
      expect(availability.get(P.bundle.v)!.state).toBe("in_stock");
    } finally {
      await t.d1.prepare("UPDATE stock_levels SET on_hand = 2 WHERE variant_id = ?").bind(P.game.v).run();
    }
  });

  it("says preorder (with its release date) until the release, then what the stock says", async () => {
    const [before] = await getCardsByIds(t.db, "ar", [P.preorder.id], { now: t.now });
    expect(before.stock).toBe("preorder");
    expect(before.badge).toBe("preorder");
    expect(before.releaseAt).toBe(t.now + 10 * DAY);
    expect(before.isNew).toBe(false); // coming soon is not new
    const [after] = await getCardsByIds(t.db, "ar", [P.preorder.id], { now: t.now + 11 * DAY });
    expect(after.stock).toBe("out_of_stock");
    expect(after.releaseAt).toBeNull();
    expect(after.badge).toBeNull(); // sold out: the card says «نفد» from its stock, no badge
  });

  it("localizes names, subtitles and platform names in ar, en and ckb", async () => {
    for (const locale of LOCALE_CODES) {
      const [card] = await getCardsByIds(t.db, locale, [P.console.id]);
      expect(card.name).toBe(pick(name3("جهاز زقزق", "Zorblax console", "ئامێری زۆربلاکس"), locale));
      expect(card.subtitle).toBe(pick(name3("نسخة 1TB", "1TB edition", "وەشانی 1TB"), locale));
      expect(card.platformName).toBe(pick(name3("منصة الاختبار", "Test platform", "پلاتفۆرمی تاقیکردنەوە"), locale));
      expect(card.platformSlug).toBe(PLATFORM);
      expect(card.image.alt).toBe(card.name); // no picture: the name is the alternative text
    }
    // and over the seeded catalogue, every card's name comes from its row
    const sample = (await listCards(t.db, "ckb", { sort: "newest", limit: 12 })).items;
    const dbRows = await rows<{ id: string; name: string }>(`SELECT id, name FROM products WHERE id IN (${sample.map(() => "?").join(",")})`, ...sample.map((card) => card.id));
    for (const card of sample) expect(card.name).toBe(pick(parse(dbRows.find((row) => row.id === card.id)!.name), "ckb"));
  });

  it("returns the card variant's picture before the product's, flagged as an illustration", async () => {
    const [headset] = await getCardsByIds(t.db, "en", [P.headset.id]);
    expect(headset.image).toEqual({ artKey: "zz-art-variant", mediaKey: null, alt: "Variant picture", isIllustration: true });
  });

  it("rates only from approved, verified-purchase reviews", async () => {
    const [before] = await getCardsByIds(t.db, "ar", [P.console.id]);
    expect(before.rating).toBeNull();
    const make = fixtures(t.db, t.now);
    const customers = [await make.customer(), await make.customer(), await make.customer(), await make.customer()];
    const review = (index: number, rating: number, status: "approved" | "pending" | "rejected", verified: boolean) =>
      t.db.insert(reviews).values({ id: `rev_test_${index}`, productId: P.console.id, customerId: customers[index], rating, status, isVerifiedPurchase: verified, createdAt: t.now });
    await runBatch(t.db, [review(0, 5, "approved", true), review(1, 4, "approved", true), review(2, 1, "pending", true), review(3, 1, "approved", false)]);
    try {
      const [after, other] = await getCardsByIds(t.db, "ar", [P.console.id, P.game.id]);
      expect(after.rating).toEqual({ average: 4.5, count: 2 });
      expect(other.rating).toBeNull();
    } finally {
      await t.d1.prepare("DELETE FROM reviews WHERE id LIKE 'rev_test_%'").run();
    }
  });

  it("never returns protected or internal fields", async () => {
    const CARD_KEYS = [
      "badge",
      "compareAtDemo",
      "compareAtIqd",
      "forPlatforms",
      "hasVariants",
      "id",
      "image",
      "isDemo",
      "isNew",
      "kind",
      "kindLabel",
      "name",
      "platformName",
      "platformSlug",
      "priceIqd",
      "rating",
      "releaseAt",
      "slug",
      "stock",
      "subtitle",
      "variantId",
    ].sort();
    const IMAGE_KEYS = ["alt", "artKey", "height", "isIllustration", "mediaKey", "opaque", "width"];
    const cards = [...(await allPages({ sort: "featured", limit: MAX_CARD_PAGE })).items, ...(await getDeals(t.db, "ar")), ...(await getNewArrivals(t.db, "ar"))];
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
      expect(Object.keys(card.image).filter((key) => !IMAGE_KEYS.includes(key))).toEqual([]);
    }
    const used = await getUsedSpotlight(t.db, "ar", { limit: 20 });
    const USED_KEYS = ["batteryHealthPct", "grade", "hasRealPhotos", "id", "image", "isDemo", "name", "platformSlug", "priceIqd", "slug", "subtitle", "warrantyDays"].sort();
    for (const unit of used) expect(Object.keys(unit).sort()).toEqual(USED_KEYS);
    // no key anywhere names a cost, a quantity or a serial; no cost, quantity or serial number leaks as a value
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) (keys.add(key), walk(inner));
    };
    walk([cards, used]);
    for (const key of keys) expect(key).not.toMatch(/cost|margin|landed|acquisition|serial|onhand|on_hand|reserved|available|quantity|qty/i);
    const json = JSON.stringify([cards, used]);
    expect(json).not.toContain("424242"); // the test world's landed cost
    expect(json).not.toContain("3133700"); // … and unit cost
    const serials = await rows<{ serial: string }>("SELECT serial FROM serials LIMIT 50");
    for (const { serial } of serials) expect(json).not.toContain(serial);
  });

  it("flags demo products exactly as the catalogue does", async () => {
    const cards = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE })).items;
    const flags = new Map((await rows<{ id: string; is_demo: number }>("SELECT id, is_demo FROM products")).map((row) => [row.id, row.is_demo === 1]));
    for (const card of cards) expect(card.isDemo, card.slug).toBe(flags.get(card.id));
    expect(cards.find((card) => card.id === P.console.id)!.isDemo).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── shelves

describe("shelves", () => {
  it("getCardsByIds keeps the order asked, once each, skipping unknown ids", async () => {
    const cards = await getCardsByIds(t.db, "en", [P.headset.id, "prd_nope", P.console.id, P.headset.id]);
    expect(ids(cards)).toEqual([P.headset.id, P.console.id]);
    expect(await getCardsByIds(t.db, "en", [])).toEqual([]);
    const error = await getCardsByIds(t.db, "en", Array.from({ length: 101 }, (_, i) => `prd_${i}`)).catch((caught: unknown) => caught);
    expect(isAppError(error, "invalid")).toBe(true);
  });

  it("getNewArrivals: newest first, only what can be bought, per platform", async () => {
    const shelf = await getNewArrivals(t.db, "ar", { limit: 6, now: t.now });
    expect(shelf.length).toBe(6);
    expect(shelf.every((card) => card.stock === "in_stock" || card.stock === "low_stock")).toBe(true);
    const newest = await listCards(t.db, "ar", { sort: "newest", inStockOnly: true, limit: 6, now: t.now });
    expect(ids(shelf)).toEqual(ids(newest.items));
    expect(ids(await getNewArrivals(t.db, "ar", { platform: PLATFORM, now: t.now }))).toEqual([P.twoVariants.id, P.headset.id, P.game.id, P.console.id, P.bundle.id]);
  });

  it("getDeals: genuine reductions in stock, biggest saving first", async () => {
    const deals = await getDeals(t.db, "ar", { limit: 20 });
    expect(ids(deals)).toContain(P.game.id);
    const saving = (card: ProductCardData) => (card.compareAtIqd! - card.priceIqd) / card.compareAtIqd!;
    for (let i = 0; i < deals.length; i++) {
      expect(deals[i].compareAtIqd!).toBeGreaterThan(deals[i].priceIqd);
      expect(deals[i].stock === "in_stock" || deals[i].stock === "low_stock").toBe(true);
      if (i > 0) expect(saving(deals[i])).toBeLessThanOrEqual(saving(deals[i - 1]));
    }
    expect(ids(await getDeals(t.db, "ar", { platform: PLATFORM }))).toEqual([P.game.id]);
  });

  it("getUsedSpotlight: listed units newest first, honest about illustrations", async () => {
    const expected = await rows<{ id: string; is_demo: number; real: number }>(
      `SELECT u.id, u.is_demo, EXISTS (SELECT 1 FROM media m JOIN files f ON f.id = m.file_id WHERE m.owner_type = 'used_unit' AND m.owner_id = u.id
         AND m.kind = 'image' AND m.is_illustration = 0 AND f.visibility = 'public') AS real
       FROM used_units u WHERE u.status = 'listed' ORDER BY COALESCE(u.listed_at, u.created_at) DESC, u.id DESC`,
    );
    expect(expected.length).toBeGreaterThan(0);
    const units = await getUsedSpotlight(t.db, "ar", { limit: 20 });
    expect(ids(units)).toEqual(expected.slice(0, 20).map((row) => row.id));
    for (const unit of units) {
      const row = expected.find((entry) => entry.id === unit.id)!;
      expect(unit.hasRealPhotos).toBe(row.real === 1);
      if (!unit.hasRealPhotos) expect(unit.image.isIllustration).toBe(true);
      expect(unit.isDemo).toBe(row.is_demo === 1);
      expect(["A+", "A", "B", "C"]).toContain(unit.grade);
      expect(unit.name.length).toBeGreaterThan(0);
    }
    const [withUsed] = await rows<{ slug: string; n: number }>(
      `SELECT pl.slug, COUNT(*) AS n FROM used_units u JOIN variants v ON v.id = u.variant_id JOIN products p ON p.id = v.product_id
       JOIN platforms pl ON pl.id = p.platform_id WHERE u.status = 'listed' GROUP BY pl.slug ORDER BY n DESC LIMIT 1`,
    );
    const onePlatform = await getUsedSpotlight(t.db, "en", { platform: withUsed.slug, limit: 20 });
    expect(onePlatform.length).toBe(Math.min(20, Number(withUsed.n)));
    expect(onePlatform.every((unit) => unit.platformSlug === withUsed.slug)).toBe(true);
  });

  it("getUsedSpotlight leaves out units that are no longer listed", async () => {
    const [first] = await getUsedSpotlight(t.db, "ar", { limit: 1 });
    await t.d1.prepare("UPDATE used_units SET status = 'reserved' WHERE id = ?").bind(first.id).run();
    try {
      expect(ids(await getUsedSpotlight(t.db, "ar", { limit: 20 }))).not.toContain(first.id);
    } finally {
      await t.d1.prepare("UPDATE used_units SET status = 'listed' WHERE id = ?").bind(first.id).run();
    }
  });
});

// ───────────────────────────────────────────────────────────────── taxonomy

describe("taxonomy", () => {
  it("lists active platforms in order, localized", async () => {
    const expected = await rows<{ slug: string; name: string }>("SELECT slug, name FROM platforms WHERE is_active = 1 ORDER BY sort, id");
    for (const locale of LOCALE_CODES) {
      const list = await getPlatforms(t.db, locale);
      expect(list.map((platform) => platform.slug)).toEqual(expected.map((row) => row.slug));
      expect(list.map((platform) => platform.name)).toEqual(expected.map((row) => pick(parse(row.name), locale)));
    }
    await t.d1.prepare("UPDATE platforms SET is_active = 0 WHERE id = ?").bind(W.platform).run();
    try {
      expect((await getPlatforms(t.db, "en")).map((platform) => platform.slug)).not.toContain(PLATFORM);
    } finally {
      await t.d1.prepare("UPDATE platforms SET is_active = 1 WHERE id = ?").bind(W.platform).run();
    }
  });

  it("builds the category tree from active categories only", async () => {
    const tree = await getCategoryTree(t.db, "en");
    const parent = tree.find((node) => node.slug === "zz-parent")!;
    expect(parent.name).toBe("Test department");
    expect(parent.children.map((child) => child.slug)).toEqual(["zz-child"]);
    const [{ roots }] = await rows<{ roots: number }>("SELECT COUNT(*) AS roots FROM categories WHERE is_active = 1 AND parent_id IS NULL");
    expect(tree.length).toBe(Number(roots));
    await t.d1.prepare("UPDATE categories SET is_active = 0 WHERE id = ?").bind(W.parent).run();
    try {
      const without = await getCategoryTree(t.db, "en");
      expect(without.find((node) => node.slug === "zz-parent")).toBeUndefined();
      expect(JSON.stringify(without)).not.toContain("zz-child"); // dropped with its parent
    } finally {
      await t.d1.prepare("UPDATE categories SET is_active = 1 WHERE id = ?").bind(W.parent).run();
    }
  });

  it("gives every platform its menu: devices, departments, consoles, used", async () => {
    invalidateNavTaxonomy();
    const nav = await getNavTaxonomy(t.db, "en", { now: t.now });
    const expectedSlugs = await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 1 ORDER BY sort, id");
    expect(nav.platforms.map((platform) => platform.slug)).toEqual(expectedSlugs.map((row) => row.slug));

    const zz = nav.platforms.find((platform) => platform.slug === PLATFORM)!;
    expect(zz.href).toBe(`/platform/${PLATFORM}`);
    expect(zz.name).toBe("Test platform");
    expect(zz.productCount).toBe(LISTED.length); // what the hub lists: the draft and the variant-less product are not counted
    // device links: the full name, a short one (a model the short-name table does not know keeps its name) and how
    // many of the platform's products work with it
    expect(zz.devices).toEqual([
      { label: "Model A", href: "/device/zz-model-a", short: "Model A", count: 3 },
      { label: "Model B", href: "/device/zz-model-b", short: "Model B", count: 2 },
    ]);
    expect(zz.consoles).toEqual([{ label: "Zorblax console", href: "/p/zz-console" }]);
    expect(zz.accessories.map((link) => link.href).sort()).toEqual(["/c/zz-child", "/c/zz-parent"]);
    expect(zz.games).toEqual([]);
    expect(zz.used).toBeNull();
    // the featured tile: the platform's console with its card's price and state
    const [consoleCard] = await getCardsByIds(t.db, "en", [P.console.id], { now: t.now });
    expect(zz.featured).toEqual({
      productId: P.console.id,
      href: "/p/zz-console",
      label: "Zorblax console",
      qualifier: null, // its name says everything (a qualifier would sit here, never inside the label)
      image: consoleCard.image,
      priceIqd: consoleCard.priceIqd,
      stock: consoleCard.stock,
      hasVariants: consoleCard.hasVariants,
      isDemo: consoleCard.isDemo,
    });

    // researched platforms: products sold for several count for each; a shared department's link filters by platform
    const multi = nav.platforms.find((platform) => platform.slug === MULTI.platform)!;
    const other = nav.platforms.find((platform) => platform.slug === MULTI.other)!;
    expect([multi.productCount, other.productCount]).toEqual([3, 4]);
    expect(multi.accessories).toEqual([{ label: "Multi-platform department", href: `/c/${MULTI.category}?platform=${MULTI.platform}`, count: 3 }]);
    expect(other.accessories).toEqual([{ label: "Multi-platform department", href: `/c/${MULTI.category}?platform=${MULTI.other}`, count: 4 }]);
    expect(other.consoles).toEqual([{ label: `Product ${M.own}`, href: `/p/${M.own.replace(/^prd_/, "").replace(/_/g, "-")}` }]);
    expect(nav.categories.find((category) => category.slug === MULTI.category)!.count).toBe(6); // each product once

    const [{ used }] = await rows<{ used: number }>("SELECT COUNT(*) AS used FROM used_units WHERE status = 'listed'");
    expect(nav.usedCount).toBe(Number(used));

    // top-level departments with products, sub-categories counted in; the "used" group is not a department
    const parent = nav.categories.find((category) => category.slug === "zz-parent")!;
    expect(parent.count).toBe(5);
    expect(parent.children).toEqual([{ slug: "zz-child", label: "Test branch", href: "/c/zz-child", count: 3, artKey: null }]);
    // every department carries its tile photo (categories.art_key) — the demo seed's, here
    for (const category of nav.categories) {
      const [row] = await rows<{ art_key: string | null }>("SELECT art_key FROM categories WHERE slug = ?", category.slug);
      expect(category.artKey, category.slug).toBe(row.art_key ?? null);
    }
    expect(nav.categories.some((category) => category.artKey)).toBe(true);
    expect(nav.categories.some((category) => category.kind === "used")).toBe(false);
  });

  it("agrees with the hubs (catalog area): every count, every link, every department", async () => {
    invalidateNavTaxonomy();
    const nav = await getNavTaxonomy(t.db, "en", { now: t.now });
    const { rows: universe, dict } = await loadListingRows(t.db, { kind: "all" }, t.now);
    const kindOf = new Map(dict.categories.map((row) => [row.slug, row.kind]));
    let shared = 0;
    for (const platform of nav.platforms) {
      // the platform hub's count
      const { rows: hub } = await loadListingRows(t.db, { kind: "platform", slug: platform.slug }, t.now);
      expect(platform.productCount, platform.slug).toBe(hub.length);
      for (const link of [...platform.devices, ...platform.accessories, ...platform.games, ...platform.consoles]) expect(link.label.length).toBeGreaterThan(0);
      // every department link leads to a hub with products of this platform; it filters exactly when the hub also
      // lists products that are not for this platform
      const departmentLinks = [...platform.accessories, ...platform.games, ...(platform.allConsoles ? [platform.allConsoles] : [])];
      for (const link of departmentLinks) {
        const [path, query] = link.href.split("?");
        const { rows: department } = await loadListingRows(t.db, { kind: "category", slug: path.slice("/c/".length) }, t.now);
        expect(department.some((row) => row.platforms.includes(platform.slug)), link.href).toBe(true);
        const holdsOthers = department.some((row) => !row.platforms.includes(platform.slug));
        expect(query === `platform=${platform.slug}`, link.href).toBe(holdsOthers);
        if (holdsOthers && !platform.slug.startsWith("zz-")) shared++;
        // the mega menu's count: what that hub lists with the link's filter
        expect(link.count, `${platform.slug} ${link.href}`).toBe(department.filter((row) => !query || row.platforms.includes(platform.slug)).length);
      }
      // a device link counts what the platform hub's device shortcut counts (its rows that fit the device), and has
      // a short name
      for (const link of platform.devices) {
        const slug = link.href.slice("/device/".length);
        expect(link.count, `${platform.slug} ${link.href}`).toBe(hub.filter((row) => row.devices.includes(slug)).length);
        expect(link.short?.length, link.href).toBeGreaterThan(0);
      }
      // the featured tile: one of the platform's listed consoles; one that can be bought now whenever there is one
      const consoleIds = hub.filter((row) => row.kind === "console" && row.ownPlatform === platform.slug).map((row) => row.id);
      if (consoleIds.length === 0) expect(platform.featured ?? null, platform.slug).toBeNull();
      else {
        expect(consoleIds, platform.slug).toContain(platform.featured?.productId);
        const buyable = hub.some((row) => consoleIds.includes(row.id) && row.st > 0 && !row.preorder);
        if (buyable) expect(["in_stock", "low_stock"], platform.slug).toContain(platform.featured?.stock);
      }
      // …and no department of this platform's products is missing (consoles have one "all consoles" link)
      const linked = new Set(departmentLinks.map((link) => link.href.split("?")[0].slice("/c/".length)));
      for (const row of hub) {
        if (row.chain.length === 0) continue;
        const rootKind = kindOf.get(row.chain[row.chain.length - 1]);
        if (rootKind === "used" || rootKind === "consoles" || rootKind === "handhelds") continue;
        expect(linked.has(row.chain[0]), `${platform.slug}: ${row.chain[0]}`).toBe(true);
      }
    }
    expect(shared).toBeGreaterThan(0); // e.g. headsets: several platforms in one department
    // departments and their sub-departments: the category hubs' counts
    for (const category of nav.categories) {
      for (const node of [category, ...category.children]) {
        const { rows: hub } = await loadListingRows(t.db, { kind: "category", slug: node.slug }, t.now);
        expect(node.count, node.slug).toBe(hub.length);
      }
    }
    expect(nav.categories.reduce((sum, category) => sum + category.count, 0)).toBe(universe.filter((row) => row.chain.length > 0 && kindOf.get(row.chain[row.chain.length - 1]) !== "used").length);
  });

  it("names the menu in every language", async () => {
    invalidateNavTaxonomy();
    const [ar, en, ckb] = await Promise.all(LOCALE_CODES.map((locale) => getNavTaxonomy(t.db, locale, { now: t.now })));
    const label = (nav: typeof ar) => nav.categories.find((category) => category.slug === "zz-parent")!.label;
    expect([label(ar), label(en), label(ckb)]).toEqual(["قسم الاختبار", "Test department", "بەشی تاقیکردنەوە"]);
  });

  it("serves the menu from memory and rebuilds when the catalogue changes", async () => {
    invalidateNavTaxonomy();
    const first = await getNavTaxonomy(t.db, "en", { now: t.now });
    await t.d1.prepare("UPDATE categories SET name = json_set(name, '$.en', 'Test department, renamed') WHERE id = ?").bind(W.parent).run();
    try {
      // within the check interval: the same snapshot, even though the catalogue changed underneath
      expect(await getNavTaxonomy(t.db, "en", { now: t.now + 1000 })).toBe(first);
      // after it: the fingerprint changed (the name got longer), so the menu is rebuilt
      const later = await getNavTaxonomy(t.db, "en", { now: t.now + NAV_CHECK_MS + 1 });
      expect(later).not.toBe(first);
      expect(later.categories.find((category) => category.slug === "zz-parent")!.label).toBe("Test department, renamed");
      // nothing changed since: the snapshot is kept
      expect(await getNavTaxonomy(t.db, "en", { now: t.now + 2 * NAV_CHECK_MS + 2 })).toBe(later);
    } finally {
      await t.d1.prepare("UPDATE categories SET name = json_set(name, '$.en', 'Test department') WHERE id = ?").bind(W.parent).run();
      invalidateNavTaxonomy();
    }
  });
});

// ───────────────────────────────────────────────────────────────── design v2 card facts (card-facts.ts)

describe("«جديد»: released, or really listed, within 30 days (isNewProduct)", () => {
  const NOW = Date.parse("2026-11-11T18:00:00Z");
  const daysAgo = (n: number) => NOW - n * DAY_MS;
  /** "YYYY-MM-DD" of the Baghdad day `n` days before NOW. */
  const dateDaysAgo = (n: number) => new Date(NOW - n * DAY_MS + 3 * 3_600_000).toISOString().slice(0, 10);

  it("counts the researched release date, both ends of the window included", () => {
    expect(NEW_WINDOW_DAYS).toBe(30);
    for (const [released, expected] of [[0, true], [1, true], [29, true], [31, false], [400, false]] as const) {
      expect(isNewProduct({ releasedOn: dateDaysAgo(released), listedAt: null, isDemo: true, now: NOW }), `released ${released} days ago`).toBe(expected);
    }
    // exactly 30 days after 00:00 Baghdad of the release day: still new; one millisecond later: not
    const day = "2026-10-12";
    const midnight = baghdadMidnight(day)!;
    expect(isNewProduct({ releasedOn: day, listedAt: null, isDemo: true, now: midnight + 30 * DAY_MS })).toBe(true);
    expect(isNewProduct({ releasedOn: day, listedAt: null, isDemo: true, now: midnight + 30 * DAY_MS + 1 })).toBe(false);
  });

  it("never makes a coming-soon product new, whatever its listing", () => {
    expect(isNewProduct({ releasedOn: "2026-11-19", listedAt: daysAgo(1), isDemo: false, now: NOW })).toBe(false);
    expect(isNewProduct({ releasedOn: "2027-05-20", listedAt: daysAgo(0), isDemo: false, now: NOW })).toBe(false);
  });

  it("counts a listing only on a row that is not demo (a demo row's listing time is the seed's clock)", () => {
    expect(isNewProduct({ releasedOn: "2020-11-12", listedAt: daysAgo(0), isDemo: true, now: NOW })).toBe(false);
    expect(isNewProduct({ releasedOn: null, listedAt: daysAgo(0), isDemo: true, now: NOW })).toBe(false);
    expect(isNewProduct({ releasedOn: "2020-11-12", listedAt: daysAgo(5), isDemo: false, now: NOW })).toBe(true);
    expect(isNewProduct({ releasedOn: null, listedAt: daysAgo(30), isDemo: false, now: NOW })).toBe(true);
    expect(isNewProduct({ releasedOn: null, listedAt: daysAgo(31), isDemo: false, now: NOW })).toBe(false);
    expect(isNewProduct({ releasedOn: null, listedAt: NOW + DAY_MS, isDemo: false, now: NOW })).toBe(false); // a listing in the future is no fact yet
    expect(isNewProduct({ releasedOn: null, listedAt: null, isDemo: false, now: NOW })).toBe(false);
    expect(isNewProduct({ releasedOn: "not a date", listedAt: Number.NaN, isDemo: false, now: NOW })).toBe(false);
  });

  it("over the demo catalogue: «جديد» exactly on the products released in the last 30 days, never on everything", async () => {
    const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE, now: t.now })).items;
    const facts = new Map(
      (await rows<{ id: string; rel: string | null; is_demo: number; pub: number }>(
        "SELECT id, json_extract(attributes, '$.catalogue.releaseDate') AS rel, is_demo, COALESCE(published_at, created_at) AS pub FROM products WHERE json_valid(attributes) OR attributes IS NULL",
      )).map((row) => [row.id, row]),
    );
    let fresh = 0;
    let demo = 0;
    for (const card of all) {
      const row = facts.get(card.id);
      if (!row) continue;
      const released = baghdadMidnight(row.rel);
      const expected =
        card.stock !== "preorder" &&
        ((released !== null && released <= t.now && t.now - released <= 30 * DAY_MS) || (row.is_demo === 0 && row.pub <= t.now && t.now - row.pub <= 30 * DAY_MS));
      expect(card.isNew, card.slug).toBe(expected);
      if (card.badge === "new") expect(card.isNew, card.slug).toBe(true);
      if (card.isNew) fresh++;
      if (card.isDemo) demo++;
    }
    // the demo seed "lists" every product on the day it runs: listing time must not make them all new
    expect(demo).toBeGreaterThan(50);
    expect(fresh).toBeLessThan(demo / 2);
    // no «جديد» older than 30 days anywhere
    for (const card of all.filter((entry) => entry.badge === "new" && entry.isDemo)) {
      const released = baghdadMidnight(facts.get(card.id)!.rel)!;
      expect(t.now - released, card.slug).toBeLessThanOrEqual(30 * DAY_MS);
    }
  });
});

describe("the shopping tier and the shown stock", () => {
  it("ranks what can be bought now over coming soon over sold out", () => {
    expect([shoppingTier({ preorder: false, st: 2 }), shoppingTier({ preorder: false, st: 1 }), shoppingTier({ preorder: true, st: 0 }), shoppingTier({ preorder: false, st: 0 })]).toEqual([2, 2, 1, 0]);
    // announced but already stocked: the card says coming soon, so it is in the coming-soon tier
    expect(shoppingTier({ preorder: true, st: 2 })).toBe(1);
  });

  it("never reports scarcity of a demo row", () => {
    expect([shownStockRank(0, true), shownStockRank(1, true), shownStockRank(2, true)]).toEqual([0, 2, 2]);
    expect([shownStockRank(0, false), shownStockRank(1, false), shownStockRank(2, false)]).toEqual([0, 1, 2]);
  });
});

describe("the kind label (kindLabelOf) and the platforms of a card", () => {
  const fam = (generation: string | null, platform: string, generationSort = 10): DeviceFamily => ({ generation, generationSort, platform, platformSort: 10 });
  const ps5 = fam("ps5", "playstation", 30);
  const sw2 = fam("switch-2", "nintendo", 10);
  const sw1 = fam("switch", "nintendo", 20);
  const xbs = fam("xbox-series", "xbox", 40);

  it("words the examples of the spec in ar, en and ckb", () => {
    const label = (input: Parameters<typeof kindLabelOf>[0]) => LOCALE_CODES.map((locale) => kindLabelOf(input, locale));
    expect(label({ kind: "console", families: [ps5], forPlatforms: ["playstation"] })).toEqual(["جهاز PS5", "Console · PS5", "ئامێری PS5"]);
    expect(label({ kind: "game", families: [sw2], forPlatforms: ["nintendo"] })).toEqual(["لعبة Switch 2", "Game · Switch 2", "یاریی Switch 2"]);
    expect(label({ kind: "controller", families: [ps5], forPlatforms: ["playstation"] })).toEqual(["يد تحكم · PS5", "Controller · PS5", "دەسکی یاری · PS5"]);
    expect(label({ kind: "headset", families: [ps5, sw1, xbs], forPlatforms: ["nintendo", "playstation", "xbox"] })).toEqual([
      "سماعة · متعددة المنصات",
      "Headset · Multi-platform",
      "هێدسێت · فرە پلاتفۆرم",
    ]);
    expect(label({ kind: "game", families: [ps5, xbs], forPlatforms: ["playstation", "xbox"] })).toEqual(["لعبة متعددة المنصات", "Game · Multi-platform", "یاریی فرە پلاتفۆرم"]);
  });

  it("names up to two families of one platform, the platform beyond that, and the product's own platform when nothing else is known", () => {
    expect(kindLabelOf({ kind: "game", families: [sw1, sw2, sw2], forPlatforms: ["nintendo"] }, "ar")).toBe("لعبة Switch 2 · Switch");
    expect(kindLabelOf({ kind: "digital", families: [sw1, sw2], forPlatforms: ["nintendo"] }, "en")).toBe("Digital code · Switch 2 · Switch");
    expect(kindLabelOf({ kind: "accessory", families: [fam(null, "xbox")], forPlatforms: ["xbox"] }, "ar")).toBe("إكسسوار · Xbox");
    expect(kindLabelOf({ kind: "accessory", families: [], ownPlatform: "playstation" }, "ar")).toBe("إكسسوار · PlayStation");
    expect(kindLabelOf({ kind: "accessory", families: [] }, "en")).toBe("Accessory");
    // families of platforms the product is not researched for are dropped (a PC rule on a PlayStation headset)
    expect(kindLabelOf({ kind: "headset", families: [ps5, fam("rog-xbox-ally", "handheld")], forPlatforms: ["playstation"] }, "ar")).toBe("سماعة · PS5");
    // research kinds that say more than products.kind
    expect(kindLabelOf({ kind: "console", researchKind: "handheld_pc", families: [fam("steam-deck", "handheld")], forPlatforms: ["handheld"] }, "ar")).toBe("جهاز محمول · Steam Deck");
    expect(kindLabelOf({ kind: "accessory", researchKind: "vr", families: [ps5], forPlatforms: ["playstation"] }, "en")).toBe("VR headset · PS5");
    // a generation the table does not know falls back to its own name
    expect(kindLabelOf({ kind: "console", families: [{ ...fam("zz-gen", PLATFORM), generationName: JSON.stringify(name3("الجيل التجريبي", "Test generation", "نەوەی تاقیکردنەوە")) }], forPlatforms: [PLATFORM] }, "en")).toBe(
      "Console · Test generation",
    );
  });

  it("every card carries its label and its platforms, from the same facts the hubs use", async () => {
    const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE })).items;
    const { rows: universe } = await loadListingRows(t.db, { kind: "all" }, t.now);
    const platformsOf = new Map(universe.map((row) => [row.id, row.platforms]));
    const order = (await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 1 ORDER BY sort, id")).map((row) => row.slug);
    let multi = 0;
    for (const card of all) {
      expect(card.kindLabel!.length, card.slug).toBeGreaterThan(0);
      expect(card.forPlatforms, card.slug).toEqual([...platformsOf.get(card.id)!].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      if (card.forPlatforms!.length >= 2) {
        multi++;
        expect(card.kindLabel, card.slug).toContain("متعددة المنصات");
      }
      if (card.kind === "console" && card.platformSlug === "playstation") expect(card.kindLabel, card.slug).toBe("جهاز PS5");
    }
    expect(multi).toBeGreaterThan(0);
    // the test world: its console IS model A of the test generation
    const [console_] = await getCardsByIds(t.db, "en", [P.console.id]);
    expect(console_.kindLabel).toBe("Console · Test generation");
    expect(console_.forPlatforms).toEqual([PLATFORM]);
    // a headset researched for two platforms through its rules
    const [headset] = await getCardsByIds(t.db, "ar", [M.headset]);
    expect([headset.kindLabel, headset.forPlatforms]).toEqual(["سماعة · متعددة المنصات", [MULTI.platform, MULTI.other]]);
  });
});

describe("opaque photos (design v2 spec §7.5)", () => {
  it("flags exactly the card pictures whose manifest kept a background, never box art, screenshots or cut-outs", async () => {
    const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE })).items;
    let flagged = 0;
    for (const card of all) {
      const art = card.image.artKey ? getArt(card.image.artKey) : undefined;
      const expected = isPhoto(art) && !art.transparent && art.kind !== "box-art" && art.kind !== "screenshot";
      expect(Boolean(card.image.opaque), card.slug).toBe(expected);
      if (!card.image.opaque) continue;
      flagged++;
      expect(card.image.opaque).toEqual(opaqueOf(card.image.artKey));
      if (isPhoto(art)) expect(card.image.opaque.background).toBe(art.background);
    }
    expect(flagged).toBeGreaterThan(0); // PS5 (2020), Switch Lite, PULSE 3D, the Razer BlackShark… until they are re-cut
    expect(opaqueOf(null)).toBeNull();
    expect(opaqueOf("zz-no-such-photo--1")).toBeNull();
  });

  it("says whether the kept box is light or dark", () => {
    const keys = photoKeys();
    let light = 0;
    let dark = 0;
    for (const key of keys) {
      const art = getArt(key);
      const flag = opaqueOf(key);
      if (!flag || !isPhoto(art) || !art.background) continue;
      if (art.background.toLowerCase() === "#ffffff") (expect(flag.tone, key).toBe("light"), light++);
      if (/^#(0|1)[0-9a-f](0|1)[0-9a-f](0|1)[0-9a-f]$/i.test(art.background)) (expect(flag.tone, key).toBe("dark"), dark++);
    }
    expect(light).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(0);
  });
});

describe("short model names, the product page's kind and a store set's parts (polish)", () => {
  it("names every published device model shortly, Latin in every language; an unknown model keeps its name", async () => {
    const models = await rows<{ slug: string; name: string }>("SELECT dm.slug, dm.name FROM device_models dm JOIN platforms pl ON pl.id = dm.platform_id WHERE dm.status = 'published' AND pl.is_active = 1");
    expect(models.length).toBeGreaterThan(10);
    for (const model of models) {
      const name = JSON.parse(model.name) as L10n;
      // every seeded model has an English name; L10n only guarantees the Arabic one
      const en = name.en ?? name.ar;
      const short = shortModelName(model.slug, en);
      expect(short.length, model.slug).toBeGreaterThan(0);
      expect(short.length, model.slug).toBeLessThanOrEqual(en.length);
      // the same short name whatever the page's language (the Arabic name's qualifier becomes the year)
      if (!model.slug.startsWith("zz-")) expect(shortModelName(model.slug, name.ar), model.slug).toBe(short);
      expect(short, model.slug).not.toMatch(/[؀-ۿ]/);
    }
    expect(["ps5-pro", "ps5-slim", "ps5-slim-digital", "ps-portal", "ps-vr2"].map((slug) => shortModelName(slug, slug))).toEqual(["PS5 Pro", "PS5 Slim", "PS5 Slim Digital", "PlayStation Portal", "PS VR2"]);
    expect(shortModelName("zz-new-model", "A New Model")).toBe("A New Model");
    // the platform hub's model switcher gets them too
    const hub = (await listProducts(t.db, "en", { scope: { kind: "platform", slug: "playstation" }, now: t.now }))!;
    expect(hub.hub.devices.find((device) => device.slug === "ps5-pro")).toMatchObject({ name: "PlayStation 5 Pro", short: "PS5 Pro" });
  });

  it("the product page says what the product is from the research's kind: handheld PCs and VR are not «جهاز» and «إكسسوار»", async () => {
    const research = await rows<{ slug: string; kind: string; research: string | null }>(
      "SELECT slug, kind, json_extract(attributes, '$.catalogue.kind') AS research FROM products WHERE status = 'published' AND json_valid(attributes) AND json_extract(attributes, '$.catalogue.kind') IN ('handheld_pc', 'vr', 'console', 'game')",
    );
    const handheld = research.find((row) => row.research === "handheld_pc");
    const vr = research.find((row) => row.research === "vr");
    const console_ = research.find((row) => row.research === "console");
    expect(handheld && vr && console_).toBeTruthy();
    const detail = async (slug: string, locale: Locale) => (await getProductDetail(t.db, locale, slug, { now: t.now, related: false }))!;
    expect((await detail(handheld!.slug, "ar")).kindLabel).toBe("جهاز محمول");
    expect((await detail(handheld!.slug, "en")).kindLabel).toBe("Handheld PC");
    expect((await detail(vr!.slug, "ar")).kindLabel).toBe("نظارة واقع افتراضي");
    expect((await detail(console_!.slug, "ar")).kindLabel).toBe("جهاز");
    // the noun alone: the page names the platform beside it
    expect((await detail(handheld!.slug, "en")).kindLabel).toBe(kindLabelOf({ kind: "console", researchKind: "handheld_pc", families: [] }, "en"));
  });

  it("a store set's parts carry their own prices (what buying them separately costs)", async () => {
    const [set] = await rows<{ slug: string; bundle: string }>(
      "SELECT p.slug, v.id AS bundle FROM bundle_items bi JOIN variants v ON v.id = bi.bundle_variant_id JOIN products p ON p.id = v.product_id WHERE p.status = 'published' LIMIT 1",
    );
    expect(set).toBeDefined();
    const detail = (await getProductDetail(t.db, "ar", set.slug, { now: t.now, related: false }))!;
    const parts = detail.variants.find((variant) => variant.id === set.bundle)!.bundle!;
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const prices = await rows<{ slug: string; price_iqd: number; qty: number }>(
      "SELECT p.slug, v.price_iqd, bi.qty FROM bundle_items bi JOIN variants v ON v.id = bi.component_variant_id JOIN products p ON p.id = v.product_id WHERE bi.bundle_variant_id = ?",
      set.bundle,
    );
    for (const part of parts) {
      const row = prices.find((entry) => entry.slug === part.slug)!;
      expect(part.priceIqd, part.slug).toBe(Number(row.price_iqd));
      expect(Number.isSafeInteger(part.priceIqd) && part.priceIqd > 0).toBe(true);
    }
  });
});

describe("the qualifier: a Latin title stays Latin, its qualifier opens the meta line (design v2 spec §4.11)", () => {
  const ARABIC = /[؀-ۿ]/;
  const opensLatin = (text: string) => /^[^A-Za-z؀-ۿ]*[A-Za-z]/.test(text);

  it("reads the qualifier of a row and joins it in front of the meta facts", () => {
    const attributes = JSON.stringify({ qualifier: { ar: "نسخة الأقراص", en: "Disc edition", ckb: "وەشانی دیسک" } });
    expect(qualifierOf(attributes, "ar")).toBe("نسخة الأقراص");
    expect(qualifierOf(JSON.parse(attributes), "ckb")).toBe("وەشانی دیسک");
    expect(qualifierOf(JSON.stringify({ qualifier: { ar: "", en: "With heatsink", ckb: "" } }), "ar")).toBe("");
    for (const broken of [null, "", "{", "[]", JSON.stringify({ qualifier: "نسخة" }), JSON.stringify({ catalogue: {} })]) expect(qualifierOf(broken, "ar")).toBe("");
    expect(qualifiedLine("نسخة الأقراص", "قارئ أقراص · DualSense في العلبة")).toBe("نسخة الأقراص · قارئ أقراص · DualSense في العلبة");
    expect(qualifiedLine("", "1TB · 7,450MB/s")).toBe("1TB · 7,450MB/s");
    expect(qualifiedLine("Disc edition", null)).toBe("Disc edition");
    expect(qualifiedLine(" ", "")).toBeNull();
  });

  it("over the demo catalogue: no card name opens with Latin and hides Arabic-script words inside", async () => {
    for (const locale of ["ar", "ckb"] as const) {
      const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE }, locale)).items;
      for (const card of all) expect(opensLatin(card.name) && ARABIC.test(card.name), `${card.slug} (${locale}): «${card.name}»`).toBe(false);
    }
  });

  it("prints every product's qualifier first on its card's meta line and under the product page's name", async () => {
    const qualified = await rows<{ id: string; slug: string; short: string | null; qualifier: string }>(
      "SELECT id, slug, short, json_extract(attributes, '$.qualifier') AS qualifier FROM products WHERE status = 'published' AND json_valid(attributes) AND json_type(attributes, '$.qualifier') = 'object'",
    );
    expect(qualified.length).toBeGreaterThanOrEqual(2); // «PlayStation 5 Slim · 1TB» + «نسخة الأقراص», «PlayStation 5 (2020)» + «الطراز الأصلي»
    for (const locale of LOCALE_CODES) {
      const cards = await getCardsByIds(t.db, locale, qualified.map((row) => row.id), { now: t.now });
      expect(cards.length).toBe(qualified.length);
      for (const row of qualified) {
        const card = cards.find((entry) => entry.id === row.id)!;
        const qualifier = pick(parse(row.qualifier), locale).trim();
        const short = pick(parse(row.short), locale).trim();
        expect(card.subtitle, `${row.slug} (${locale})`).toBe([qualifier, short].filter(Boolean).join(" · "));
        // the card meta line shows the first two facts: the qualifier is always one of them
        if (qualifier) expect((card.subtitle ?? "").split(" · ")[0]).toBe(qualifier);
        const detail = (await getProductDetail(t.db, locale, row.slug, { now: t.now, related: false }))!;
        expect(detail.qualifier, `${row.slug} (${locale})`).toBe(qualifier || null);
        expect(detail.short, `${row.slug} (${locale})`).toBe([qualifier, short].filter(Boolean).join(" · ") || null);
      }
    }
  });

  it("hands the mega menu's console links and featured tile the qualifier beside their Latin label", async () => {
    const qualified = new Map(
      (await rows<{ slug: string; qualifier: string }>("SELECT slug, json_extract(attributes, '$.qualifier') AS qualifier FROM products WHERE json_valid(attributes) AND json_type(attributes, '$.qualifier') = 'object'")).map((row) => [row.slug, parse(row.qualifier)!]),
    );
    invalidateNavTaxonomy();
    let seen = 0;
    for (const locale of LOCALE_CODES) {
      const nav = await getNavTaxonomy(t.db, locale, { now: t.now });
      for (const platform of nav.platforms) {
        for (const link of [...platform.consoles, ...(platform.featured ? [{ label: platform.featured.label, href: platform.featured.href, qualifier: platform.featured.qualifier ?? undefined }] : [])]) {
          const slug = link.href.replace(/^\/p\//, "");
          const expected = qualified.has(slug) ? pick(qualified.get(slug)!, locale) || undefined : undefined;
          expect(link.qualifier, `${slug} (${locale})`).toBe(expected);
          if (expected) seen++;
          expect(opensLatin(link.label) && ARABIC.test(link.label), `${slug} (${locale}): «${link.label}»`).toBe(false);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("gives the header's product suggestions the qualifier on its own field, the label staying the Latin title", async () => {
    const [slim] = await rows<{ id: string; name: string; qualifier: string }>(
      "SELECT id, name, json_extract(attributes, '$.qualifier') AS qualifier FROM products WHERE status = 'published' AND json_valid(attributes) AND json_type(attributes, '$.qualifier') = 'object' ORDER BY slug LIMIT 1",
    );
    expect(slim).toBeDefined();
    for (const locale of LOCALE_CODES) {
      const name = pick(parse(slim.name), locale);
      const { items } = await suggestSearchWithTotal(t.db, locale, name, { now: t.now });
      const item = items.find((entry) => entry.id === slim.id);
      expect(item, `${name} (${locale})`).toBeDefined();
      expect(item!.label).toBe(name);
      expect(item!.qualifier).toBe(pick(parse(slim.qualifier), locale) || undefined);
    }
    // a product without one carries no qualifier field at all
    const { items } = await suggestSearchWithTotal(t.db, "en", "Zorblax", { now: t.now });
    expect(items.find((entry) => entry.id === P.console.id)).not.toHaveProperty("qualifier");
  });

  it("leaves every card without a qualifier exactly as its short line says", async () => {
    const [plain] = await rows<{ id: string; short: string }>(
      "SELECT id, short FROM products WHERE status = 'published' AND short IS NOT NULL AND (attributes IS NULL OR NOT json_valid(attributes) OR json_type(attributes, '$.qualifier') IS NULL) AND kind = 'console' LIMIT 1",
    );
    const [card] = await getCardsByIds(t.db, "ar", [plain.id], { now: t.now });
    expect(card.subtitle).toBe(pick(parse(plain.short), "ar"));
  });
});
