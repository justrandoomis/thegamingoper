/**
 * Catalogue read layer (app/server/services/catalog/*) against a real local D1 with the DEMO catalogue seeded.
 *
 * Expectations are derived from the database itself (raw SQL) wherever possible, so the tests keep holding when the
 * seed's products, prices or stock change. What is checked:
 *   · only published products with an active variant are listed; draft / archived / variant-less ones never are
 *   · every filter (platform, category with sub-categories, kind, device model with rule precedence, search text,
 *     price range, in stock, deals) and every sort, with keyset paging that never repeats or skips a product
 *   · stock states agree with the commerce core's getAvailability(); bundles; preorder
 *   · names, subtitles and platform names in ar / en / ckb
 *   · ratings only from approved verified-purchase reviews
 *   · no protected field (cost, margin, serial, stock quantity) in any result
 *   · used spotlight, shelves, platforms, category tree and the cached navigation taxonomy
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductCardData, StockState, UsedUnitCardData } from "~/lib/dto";
import { LOCALE_CODES, pick, type L10n } from "~/lib/locales";
import { isAppError } from "~/server/errors";
import { compatibilityRules, products, reviews, variants } from "~/server/db/schema";
import { demoId, seedDemo } from "~/server/db/seed/demo";
import { runBatch } from "~/server/db/tx.server";
import { getCardsByIds, getDeals, getNewArrivals, getUsedSpotlight, listCards, MAX_CARD_PAGE } from "~/server/services/catalog/cards.server";
import { getCategoryTree, getNavTaxonomy, getPlatforms, invalidateNavTaxonomy, NAV_CHECK_MS } from "~/server/services/catalog/taxonomy.server";
import type { CardSort } from "~/server/services/catalog/types";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures } from "./helpers/factories";

let t: TestDb;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const parse = (text: string | null): L10n | null => (text ? (JSON.parse(text) as L10n) : null);

/** Every page of a listing, following nextCursor. */
async function allPages(options: Parameters<typeof listCards>[2], locale: "ar" | "en" | "ckb" = "ar") {
  const items: ProductCardData[] = [];
  let cursor: string | null = null;
  let total = -1;
  for (let guard = 0; guard < 100; guard++) {
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

const ids = (cards: { id: string }[]) => cards.map((card) => card.id);

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
});

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── what is listed

describe("listCards — what is listed", () => {
  it("lists exactly the published products that have an active variant", async () => {
    const expected = await rows<{ id: string }>(
      "SELECT p.id FROM products p WHERE p.status = 'published' AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) ORDER BY p.id",
    );
    expect(expected.length).toBeGreaterThan(40);
    const { items, total } = await allPages({ sort: "newest", limit: MAX_CARD_PAGE });
    expect(total).toBe(expected.length);
    expect(ids(items).sort()).toEqual(expected.map((row) => row.id));
  });

  it("hides draft, review, archived and variant-less products, and inactive variants", async () => {
    const make = fixtures(t.db, t.now);
    const draft = await make.product({ stock: 3 });
    const archived = await make.product({ stock: 3 });
    const noActive = await make.product({ stock: 3 });
    await runBatch(t.db, [
      t.db.update(products).set({ status: "draft" }).where(eq(products.id, draft.productId)),
      t.db.update(products).set({ status: "archived" }).where(eq(products.id, archived.productId)),
      t.db.update(variants).set({ isActive: false }).where(eq(variants.id, noActive.variantId)),
    ]);
    const { items } = await allPages({ sort: "newest", limit: MAX_CARD_PAGE });
    for (const hidden of [draft, archived, noActive]) expect(ids(items)).not.toContain(hidden.productId);
    expect(await getCardsByIds(t.db, "ar", [draft.productId, archived.productId, noActive.productId])).toEqual([]);
    // the fixtures are cleaned up so later counts stay those of the seed
    await t.d1.batch([draft, archived, noActive].flatMap((f) => [t.d1.prepare("DELETE FROM stock_levels WHERE variant_id = ?").bind(f.variantId), t.d1.prepare("DELETE FROM variants WHERE id = ?").bind(f.variantId), t.d1.prepare("DELETE FROM products WHERE id = ?").bind(f.productId)]));
  });

  it("a product's inactive variant is never the card variant", async () => {
    const slim = demoId.product("playstation-5-slim");
    const disc = demoId.variant("PS5-SLIM-DISC");
    const digital = demoId.variant("PS5-SLIM-DIGITAL");
    const [before] = await getCardsByIds(t.db, "en", [slim]);
    expect(before.variantId).toBe(disc);
    expect(before.hasVariants).toBe(true);
    await t.d1.prepare("UPDATE variants SET is_active = 0 WHERE id = ?").bind(disc).run();
    try {
      const [after] = await getCardsByIds(t.db, "en", [slim]);
      expect(after.variantId).toBe(digital);
      expect(after.hasVariants).toBe(false);
      const [{ price }] = await rows<{ price: number }>("SELECT price_iqd AS price FROM variants WHERE id = ?", digital);
      expect(after.priceIqd).toBe(price);
    } finally {
      await t.d1.prepare("UPDATE variants SET is_active = 1 WHERE id = ?").bind(disc).run();
    }
  });
});

// ───────────────────────────────────────────────────────────────── sorting and paging

describe("listCards — sorting and keyset paging", () => {
  const SORTS: CardSort[] = ["featured", "newest", "price_asc", "price_desc"];

  for (const sort of SORTS) {
    it(`pages through "${sort}" in pages of 7 without duplicates or gaps`, async () => {
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
    for (let i = 1; i < desc.length; i++) expect(desc[i].priceIqd).toBeLessThanOrEqual(desc[i - 1].priceIqd);
  });

  it("orders newest by publication time", async () => {
    const expected = await rows<{ id: string }>(
      "SELECT p.id FROM products p WHERE p.status = 'published' AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC",
    );
    expect(ids((await allPages({ sort: "newest", limit: 13 })).items)).toEqual(expected.map((row) => row.id));
  });

  it("puts what can be bought now first in featured", async () => {
    const { items } = await allPages({ sort: "featured", limit: 9 });
    const firstUnavailable = items.findIndex((card) => card.stock === "out_of_stock");
    expect(firstUnavailable).toBeGreaterThan(0);
    expect(items.slice(firstUnavailable).every((card) => card.stock === "out_of_stock")).toBe(true);
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
    for (const bad of [{ limit: 0 }, { limit: MAX_CARD_PAGE + 1 }, { priceMin: -1 }, { platform: "Play Station" }, { kind: "spaceship" }]) {
      const error = await listCards(t.db, "ar", { sort: "newest", limit: 10, ...(bad as object) }).catch((caught: unknown) => caught);
      expect(isAppError(error, "invalid")).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────── filters

describe("listCards — filters", () => {
  it("filters by platform (one or several)", async () => {
    const [{ n }] = await rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM products p JOIN platforms pl ON pl.id = p.platform_id WHERE pl.slug = 'playstation' AND p.status = 'published'",
    );
    const { items, total } = await allPages({ platform: "playstation", sort: "featured", limit: 10 });
    expect(total).toBe(n);
    expect(items.every((card) => card.platformSlug === "playstation")).toBe(true);
    const both = await listCards(t.db, "ar", { platform: ["playstation", "xbox"], sort: "newest", limit: MAX_CARD_PAGE });
    expect(new Set(both.items.map((card) => card.platformSlug))).toEqual(new Set(["playstation", "xbox"]));
    expect((await listCards(t.db, "ar", { platform: "atari", sort: "newest", limit: 5 })).total).toBe(0);
  });

  it("includes sub-categories in a category", async () => {
    const [{ n }] = await rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN categories parent ON parent.id = c.parent_id WHERE p.status = 'published' AND (c.slug = 'games' OR parent.slug = 'games')",
    );
    expect(n).toBeGreaterThan(10);
    const games = await listCards(t.db, "ar", { category: "games", sort: "newest", limit: MAX_CARD_PAGE });
    expect(games.total).toBe(n);
    expect(games.items.every((card) => card.kind === "game")).toBe(true);
    const nintendoGames = await listCards(t.db, "ar", { category: "nintendo-games", sort: "newest", limit: MAX_CARD_PAGE });
    expect(nintendoGames.total).toBeGreaterThan(0);
    expect(nintendoGames.total).toBeLessThan(games.total);
    expect(nintendoGames.items.every((card) => card.platformSlug === "nintendo")).toBe(true);
  });

  it("filters by kind", async () => {
    const page = await listCards(t.db, "ar", { kind: ["controller", "headset"], sort: "newest", limit: MAX_CARD_PAGE });
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.every((card) => card.kind === "controller" || card.kind === "headset")).toBe(true);
  });

  it("filters by price range, inclusively, on the card variant's price", async () => {
    const page = await listCards(t.db, "ar", { priceMin: 90_000, priceMax: 110_000, sort: "price_asc", limit: MAX_CARD_PAGE });
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.every((card) => card.priceIqd >= 90_000 && card.priceIqd <= 110_000)).toBe(true);
    expect(page.items.some((card) => card.priceIqd === 90_000 || card.priceIqd === 110_000)).toBe(true);
  });

  it("keeps only what can be bought now with inStockOnly", async () => {
    const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE })).items;
    const inStock = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE, inStockOnly: true })).items;
    expect(inStock.every((card) => card.stock === "in_stock" || card.stock === "low_stock")).toBe(true);
    expect(inStock.length).toBe(all.filter((card) => card.stock === "in_stock" || card.stock === "low_stock").length);
    expect(inStock.length).toBeLessThan(all.length);
  });

  it("keeps only genuine reductions with dealsOnly", async () => {
    const expected = await rows<{ product_id: string }>(
      `SELECT DISTINCT v.product_id FROM variants v JOIN products p ON p.id = v.product_id
       WHERE p.status = 'published' AND v.is_active = 1 AND v.is_default = 1 AND v.compare_at_iqd > v.price_iqd ORDER BY v.product_id`,
    );
    expect(expected.length).toBeGreaterThan(0);
    const deals = await listCards(t.db, "ar", { dealsOnly: true, sort: "newest", limit: MAX_CARD_PAGE });
    expect(ids(deals.items).sort()).toEqual(expected.map((row) => row.product_id));
    for (const card of deals.items) {
      expect(card.compareAtIqd).not.toBeNull();
      expect(card.compareAtIqd!).toBeGreaterThan(card.priceIqd);
      expect(card.badge).toBe("deal");
    }
  });

  it("never shows a compare-at price that is not above the price", async () => {
    const make = fixtures(t.db, t.now);
    const fake = await make.product({ stock: 4, priceIqd: 100_000 });
    await t.d1.prepare("UPDATE variants SET compare_at_iqd = 100000 WHERE id = ?").bind(fake.variantId).run();
    const [card] = await getCardsByIds(t.db, "ar", [fake.productId]);
    expect(card.compareAtIqd).toBeNull();
    expect(card.badge).toBe("new");
    const deals = await listCards(t.db, "ar", { dealsOnly: true, sort: "newest", limit: MAX_CARD_PAGE });
    expect(ids(deals.items)).not.toContain(fake.productId);
    await t.d1.batch([t.d1.prepare("DELETE FROM stock_levels WHERE variant_id = ?").bind(fake.variantId), t.d1.prepare("DELETE FROM variants WHERE id = ?").bind(fake.variantId), t.d1.prepare("DELETE FROM products WHERE id = ?").bind(fake.productId)]);
  });

  it("searches in Arabic, English and Kurdish, short terms included", async () => {
    const arabic = await listCards(t.db, "ar", { q: "بلايستيشن", sort: "featured", limit: MAX_CARD_PAGE });
    expect(arabic.total).toBeGreaterThan(0);
    expect(ids(arabic.items)).toContain(demoId.product("playstation-5-slim"));
    const latin = await listCards(t.db, "en", { q: "Zelda", sort: "featured", limit: MAX_CARD_PAGE });
    expect(latin.items.some((card) => /zelda/i.test(card.name))).toBe(true);
    const short = await listCards(t.db, "ar", { q: "ps5", sort: "featured", limit: MAX_CARD_PAGE });
    expect(short.total).toBeGreaterThan(0);
    expect((await listCards(t.db, "ar", { q: "qqqzzzxxx", sort: "featured", limit: 5 })).total).toBe(0);
    // a query with nothing searchable in it does not filter
    const all = await listCards(t.db, "ar", { sort: "featured", limit: 5 });
    expect((await listCards(t.db, "ar", { q: "  ؟ ", sort: "featured", limit: 5 })).total).toBe(all.total);
  });

  it("filters by device model with the most specific compatibility rule winning", async () => {
    const seriesS = await allPages({ deviceModel: "xbox-series-s", sort: "newest", limit: 20 });
    const seriesX = await allPages({ deviceModel: "xbox-series-x", sort: "newest", limit: 20 });
    const sIds = ids(seriesS.items);
    const xIds = ids(seriesX.items);
    // the console itself, generation-wide accessories, platform-wide store credit (partial)
    expect(sIds).toContain(demoId.product("xbox-series-s"));
    expect(sIds).toContain(demoId.product("xbox-wireless-controller"));
    expect(sIds).toContain(demoId.product("xbox-gift-card-us"));
    // a disc game: verified on Series X, incompatible on Series S (no disc drive)
    expect(xIds).toContain(demoId.product("forza-horizon-5"));
    expect(sIds).not.toContain(demoId.product("forza-horizon-5"));
    // unverified rules never make a product compatible
    const deck = ids((await allPages({ deviceModel: "steam-deck-oled", sort: "newest", limit: 20 })).items);
    expect(deck).not.toContain(demoId.product("usb-c-gan-charger-65w"));

    // precedence: a model-level "incompatible" overrides a generation-level "verified"
    const make = fixtures(t.db, t.now);
    const thing = await make.product({ kind: "accessory", stock: 5 });
    const rule = (target: "generation" | "device_model", targetId: string, status: "verified" | "incompatible") =>
      t.db.insert(compatibilityRules).values({ id: `cr_test_${target}_${thing.productId}`, subjectType: "product", subjectId: thing.productId, targetType: target, targetId, status, createdAt: t.now, updatedAt: t.now });
    await runBatch(t.db, [rule("generation", demoId.generation("xbox-series"), "verified"), rule("device_model", demoId.deviceModel("xbox-series-s"), "incompatible")]);
    expect(ids((await allPages({ deviceModel: "xbox-series-x", sort: "newest", limit: 50 })).items)).toContain(thing.productId);
    expect(ids((await allPages({ deviceModel: "xbox-series-s", sort: "newest", limit: 50 })).items)).not.toContain(thing.productId);
    await t.d1.batch([
      t.d1.prepare("DELETE FROM compatibility_rules WHERE subject_id = ?").bind(thing.productId),
      t.d1.prepare("DELETE FROM stock_levels WHERE variant_id = ?").bind(thing.variantId),
      t.d1.prepare("DELETE FROM variants WHERE id = ?").bind(thing.variantId),
      t.d1.prepare("DELETE FROM products WHERE id = ?").bind(thing.productId),
    ]);
  });

  it("combines filters", async () => {
    const page = await listCards(t.db, "ar", { platform: "playstation", category: "games", inStockOnly: true, priceMax: 100_000, sort: "price_desc", limit: MAX_CARD_PAGE });
    expect(page.total).toBeGreaterThan(0);
    for (const card of page.items) {
      expect(card.platformSlug).toBe("playstation");
      expect(card.kind).toBe("game");
      expect(card.priceIqd).toBeLessThanOrEqual(100_000);
      expect(card.stock === "in_stock" || card.stock === "low_stock").toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────── card content

describe("cards — stock, language, ratings, privacy", () => {
  it("states stock exactly as the commerce core's getAvailability() does", async () => {
    const all = (await allPages({ sort: "newest", limit: MAX_CARD_PAGE })).items;
    const variantRows = await rows<{ id: string; product_id: string }>("SELECT id, product_id FROM variants WHERE is_active = 1");
    const availability = await getAvailability(t.db, variantRows.map((row) => row.id));
    const rank: Record<StockState, number> = { out_of_stock: 0, low_stock: 1, in_stock: 2, preorder: 3 };
    for (const card of all) {
      const own = variantRows.filter((row) => row.product_id === card.id).map((row) => availability.get(row.id)!.state);
      const best = own.reduce<StockState>((acc, state) => (rank[state] > rank[acc] ? state : acc), "out_of_stock");
      const expected = card.hasVariants ? best : availability.get(card.variantId)!.state;
      expect(card.stock, card.slug).toBe(expected);
    }
    expect(all.some((card) => card.stock === "in_stock")).toBe(true);
    expect(all.some((card) => card.stock === "low_stock")).toBe(true);
    expect(all.some((card) => card.stock === "out_of_stock")).toBe(true);
  });

  it("counts reserved units and bundles like the cart does", async () => {
    const pro = demoId.product("playstation-5-pro");
    const [before] = await getCardsByIds(t.db, "ar", [pro]);
    expect(before.stock).not.toBe("out_of_stock");
    const variantId = demoId.variant("PS5-PRO-2TB");
    const [{ onHand }] = await rows<{ onHand: number }>("SELECT on_hand AS onHand FROM stock_levels WHERE variant_id = ?", variantId);
    await t.d1.prepare("UPDATE stock_levels SET reserved = on_hand WHERE variant_id = ?").bind(variantId).run();
    try {
      const [after] = await getCardsByIds(t.db, "ar", [pro]);
      expect(after.stock).toBe("out_of_stock");
    } finally {
      await t.d1.prepare("UPDATE stock_levels SET reserved = 0, on_hand = ? WHERE variant_id = ?").bind(onHand, variantId).run();
    }
    // Switch 2: one variant is a bundle whose availability is that of its components
    const [switch2] = await getCardsByIds(t.db, "ar", [demoId.product("nintendo-switch-2")]);
    const availability = await getAvailability(t.db, [demoId.variant("NSW2-CON-256"), demoId.variant("NSW2-BUNDLE-MKW")]);
    const states = [...availability.values()].map((entry) => entry.state);
    expect(switch2.hasVariants).toBe(true);
    expect(states).toContain(switch2.stock);
  });

  it("says preorder while the release date is in the future", async () => {
    const slug = demoId.product("ghost-of-yotei");
    await t.d1.prepare("UPDATE products SET preorder_release_at = ? WHERE id = ?").bind(t.now + 86_400_000, slug).run();
    try {
      const [card] = await getCardsByIds(t.db, "ar", [slug], { now: t.now });
      expect(card.stock).toBe("preorder");
      expect(card.badge).toBe("preorder");
      const [later] = await getCardsByIds(t.db, "ar", [slug], { now: t.now + 2 * 86_400_000 });
      expect(later.stock).not.toBe("preorder");
    } finally {
      await t.d1.prepare("UPDATE products SET preorder_release_at = NULL WHERE id = ?").bind(slug).run();
    }
  });

  it("localizes names, subtitles and platform names in ar, en and ckb", async () => {
    const productIds = [demoId.product("playstation-5-slim"), demoId.product("mario-kart-world"), demoId.product("xbox-wireless-controller")];
    const dbRows = await rows<{ id: string; name: string; short: string | null; platform_name: string | null }>(
      `SELECT p.id, p.name, p.short, pl.name AS platform_name FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id WHERE p.id IN (${productIds.map(() => "?").join(",")})`,
      ...productIds,
    );
    for (const locale of LOCALE_CODES) {
      const cards = await getCardsByIds(t.db, locale, productIds);
      expect(ids(cards)).toEqual(productIds);
      for (const card of cards) {
        const row = dbRows.find((entry) => entry.id === card.id)!;
        expect(card.name).toBe(pick(parse(row.name), locale));
        expect(card.subtitle).toBe(pick(parse(row.short), locale) || null);
        expect(card.platformName).toBe(pick(parse(row.platform_name), locale));
        expect(card.name.length).toBeGreaterThan(0);
        expect(card.image.alt.length).toBeGreaterThan(0);
      }
    }
    const [ar] = await getCardsByIds(t.db, "ar", [productIds[2]]);
    const [ckb] = await getCardsByIds(t.db, "ckb", [productIds[2]]);
    expect(ar.platformName).not.toBe(ckb.platformName);
  });

  it("returns pictures as art keys of the card variant first, flagged as illustrations", async () => {
    const [controller] = await getCardsByIds(t.db, "en", [demoId.product("xbox-wireless-controller")]);
    const [variantArt] = await rows<{ art: string }>("SELECT art_key AS art FROM media WHERE owner_type = 'variant' AND owner_id = ? ORDER BY sort LIMIT 1", controller.variantId);
    expect(controller.image.artKey).toBe(variantArt.art);
    expect(controller.image.mediaKey).toBeNull();
    expect(controller.image.isIllustration).toBe(true);
  });

  it("rates only from approved, verified-purchase reviews", async () => {
    const product = demoId.product("mario-kart-world");
    const [before] = await getCardsByIds(t.db, "ar", [product]);
    expect(before.rating).toBeNull();
    const make = fixtures(t.db, t.now);
    const customers = [await make.customer(), await make.customer(), await make.customer(), await make.customer()];
    const review = (index: number, rating: number, status: "approved" | "pending" | "rejected", verified: boolean) =>
      t.db.insert(reviews).values({ id: `rev_test_${index}`, productId: product, customerId: customers[index], rating, status, isVerifiedPurchase: verified, createdAt: t.now });
    await runBatch(t.db, [review(0, 5, "approved", true), review(1, 4, "approved", true), review(2, 1, "pending", true), review(3, 1, "approved", false)]);
    try {
      const [after] = await getCardsByIds(t.db, "ar", [product]);
      expect(after.rating).toEqual({ average: 4.5, count: 2 });
    } finally {
      await t.d1.prepare("DELETE FROM reviews WHERE id LIKE 'rev_test_%'").run();
    }
  });

  it("never returns protected or internal fields", async () => {
    const CARD_KEYS = ["badge", "compareAtIqd", "hasVariants", "id", "image", "isDemo", "kind", "name", "platformName", "platformSlug", "priceIqd", "rating", "slug", "stock", "subtitle", "variantId"].sort();
    const IMAGE_KEYS = ["alt", "artKey", "isIllustration", "mediaKey"];
    const cards = [...(await allPages({ sort: "featured", limit: MAX_CARD_PAGE })).items, ...(await getDeals(t.db, "ar")), ...(await getNewArrivals(t.db, "ar"))];
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
      expect(Object.keys(card.image).filter((key) => !IMAGE_KEYS.includes(key))).toEqual([]);
    }
    const used = await getUsedSpotlight(t.db, "ar", { limit: 20 });
    const USED_KEYS = ["batteryHealthPct", "grade", "hasRealPhotos", "id", "image", "isDemo", "name", "platformSlug", "priceIqd", "slug", "subtitle", "warrantyDays"].sort();
    for (const unit of used) expect(Object.keys(unit).sort()).toEqual(USED_KEYS);
    // no key anywhere in the results names a cost, a quantity or a serial, and no serial number leaks as a value
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) (keys.add(key), walk(inner));
    };
    walk([cards, used]);
    for (const key of keys) expect(key).not.toMatch(/cost|margin|landed|acquisition|serial|onhand|on_hand|reserved|available|quantity|qty/i);
    expect(JSON.stringify([cards, used])).not.toContain("DEMO-");
  });

  it("flags demo products", async () => {
    const cards = (await listCards(t.db, "ar", { sort: "newest", limit: 10 })).items;
    expect(cards.every((card) => card.isDemo)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── shelves

describe("shelves", () => {
  it("getCardsByIds keeps the order asked, once each, skipping unknown ids", async () => {
    const a = demoId.product("legion-go");
    const b = demoId.product("mario-kart-world");
    const cards = await getCardsByIds(t.db, "en", [b, "prd_nope", a, b]);
    expect(ids(cards)).toEqual([b, a]);
    expect(await getCardsByIds(t.db, "en", [])).toEqual([]);
  });

  it("getNewArrivals: newest first, only what can be bought, per platform", async () => {
    const shelf = await getNewArrivals(t.db, "ar", { limit: 6 });
    expect(shelf.length).toBe(6);
    expect(shelf.every((card) => card.stock === "in_stock" || card.stock === "low_stock")).toBe(true);
    const newest = await listCards(t.db, "ar", { sort: "newest", inStockOnly: true, limit: 6 });
    expect(ids(shelf)).toEqual(ids(newest.items));
    const xbox = await getNewArrivals(t.db, "ar", { platform: "xbox", limit: 4 });
    expect(xbox.every((card) => card.platformSlug === "xbox")).toBe(true);
  });

  it("getDeals: genuine reductions in stock, biggest saving first", async () => {
    const deals = await getDeals(t.db, "ar", { limit: 20 });
    expect(deals.length).toBeGreaterThan(0);
    const saving = (card: ProductCardData) => (card.compareAtIqd! - card.priceIqd) / card.compareAtIqd!;
    for (let i = 0; i < deals.length; i++) {
      expect(deals[i].compareAtIqd!).toBeGreaterThan(deals[i].priceIqd);
      expect(deals[i].stock === "in_stock" || deals[i].stock === "low_stock").toBe(true);
      if (i > 0) expect(saving(deals[i])).toBeLessThanOrEqual(saving(deals[i - 1]));
    }
  });

  it("getUsedSpotlight: listed units newest first, honest about illustrations", async () => {
    const expected = await rows<{ id: string }>("SELECT id FROM used_units WHERE status = 'listed' ORDER BY COALESCE(listed_at, created_at) DESC, id DESC");
    const units = await getUsedSpotlight(t.db, "ar", { limit: 20 });
    expect(ids(units)).toEqual(expected.map((row) => row.id));
    for (const unit of units) {
      expect(unit.hasRealPhotos).toBe(false); // the demo seed has drawings only
      expect(unit.image.isIllustration).toBe(true);
      expect(unit.isDemo).toBe(true);
      expect(["A+", "A", "B", "C"]).toContain(unit.grade);
      expect(unit.name.length).toBeGreaterThan(0);
    }
    const nintendo = await getUsedSpotlight(t.db, "en", { platform: "nintendo" });
    expect(nintendo.length).toBeGreaterThan(0);
    expect(nintendo.every((unit: UsedUnitCardData) => unit.platformSlug === "nintendo")).toBe(true);
  });

  it("getUsedSpotlight leaves out units that are no longer listed", async () => {
    const [first] = await getUsedSpotlight(t.db, "ar", { limit: 1 });
    await t.d1.prepare("UPDATE used_units SET status = 'reserved' WHERE id = ?").bind(first.id).run();
    expect(ids(await getUsedSpotlight(t.db, "ar", { limit: 20 }))).not.toContain(first.id);
  });
});

// ───────────────────────────────────────────────────────────────── taxonomy

describe("taxonomy", () => {
  it("lists active platforms in order, localized", async () => {
    const ar = await getPlatforms(t.db, "ar");
    const en = await getPlatforms(t.db, "en");
    expect(ar.map((platform) => platform.slug)).toEqual(["nintendo", "playstation", "xbox", "handheld"]);
    expect(en.map((platform) => platform.name)).toEqual(["Nintendo", "PlayStation", "Xbox", "Handheld PCs"]);
    expect(ar[1].name).not.toBe(en[1].name);
  });

  it("builds the category tree from active categories only", async () => {
    const tree = await getCategoryTree(t.db, "en");
    const consoles = tree.find((node) => node.slug === "consoles")!;
    expect(consoles.name).toBe("Consoles");
    expect(consoles.children.map((child) => child.slug)).toEqual(["nintendo-consoles", "playstation-consoles", "xbox-consoles"]);
    await t.d1.prepare("UPDATE categories SET is_active = 0 WHERE slug = 'consoles'").run();
    try {
      const without = await getCategoryTree(t.db, "en");
      expect(without.find((node) => node.slug === "consoles")).toBeUndefined();
      expect(JSON.stringify(without)).not.toContain("playstation-consoles");
    } finally {
      await t.d1.prepare("UPDATE categories SET is_active = 1 WHERE slug = 'consoles'").run();
    }
  });

  it("gives every platform its menu: devices, categories, consoles, used", async () => {
    invalidateNavTaxonomy();
    const nav = await getNavTaxonomy(t.db, "ar", { now: t.now });
    expect(nav.platforms.map((platform) => platform.slug)).toEqual(["nintendo", "playstation", "xbox", "handheld"]);
    const ps = nav.platforms.find((platform) => platform.slug === "playstation")!;
    expect(ps.href).toBe("/platform/playstation");
    expect(ps.devices.map((link) => link.href)).toContain("/device/ps5-slim");
    expect(ps.consoles.map((link) => link.href)).toContain("/p/playstation-5-slim");
    expect(ps.allConsoles?.href).toBe("/c/playstation-consoles");
    expect(ps.games.map((link) => link.href)).toContain("/c/playstation-games");
    // a category shared by several platforms carries ?platform=
    expect(ps.accessories.map((link) => link.href)).toContain("/c/controllers?platform=playstation");
    expect(ps.productCount).toBeGreaterThan(5);
    const [{ n }] = await rows<{ n: number }>("SELECT COUNT(*) AS n FROM products p JOIN platforms pl ON pl.id = p.platform_id WHERE pl.slug = 'playstation' AND p.status = 'published'");
    expect(ps.productCount).toBe(n);
    for (const platform of nav.platforms) for (const link of [...platform.devices, ...platform.accessories, ...platform.games, ...platform.consoles]) expect(link.label.length).toBeGreaterThan(0);
    // top-level categories with products, sub-categories counted in
    const games = nav.categories.find((category) => category.slug === "games")!;
    expect(games.count).toBe(games.children.reduce((sum, child) => sum + child.count, 0));
    expect(nav.categories.some((category) => category.kind === "used")).toBe(false);
    expect(nav.usedCount).toBeGreaterThan(0);
  });

  it("names the menu in every language", async () => {
    invalidateNavTaxonomy();
    const [ar, en, ckb] = await Promise.all(LOCALE_CODES.map((locale) => getNavTaxonomy(t.db, locale, { now: t.now })));
    const label = (nav: typeof ar) => nav.categories.find((category) => category.slug === "controllers")!.label;
    expect(new Set([label(ar), label(en), label(ckb)]).size).toBe(3);
    expect(label(en)).toBe("Controllers");
  });

  it("serves the menu from memory and rebuilds when the catalogue changes", async () => {
    invalidateNavTaxonomy();
    const first = await getNavTaxonomy(t.db, "en", { now: t.now });
    // within the check interval: the same snapshot, even though the catalogue changed underneath
    await t.d1.prepare("UPDATE categories SET name = json_set(name, '$.en', 'Pads and controllers') WHERE slug = 'controllers'").run();
    try {
      expect(await getNavTaxonomy(t.db, "en", { now: t.now + 1000 })).toBe(first);
      // after it: the fingerprint changed (the name got longer), so the menu is rebuilt
      const later = await getNavTaxonomy(t.db, "en", { now: t.now + NAV_CHECK_MS + 1 });
      expect(later).not.toBe(first);
      expect(later.categories.find((category) => category.slug === "controllers")!.label).toBe("Pads and controllers");
      // nothing changed since: the snapshot is kept
      expect(await getNavTaxonomy(t.db, "en", { now: t.now + 2 * NAV_CHECK_MS + 2 })).toBe(later);
    } finally {
      await t.d1.prepare("UPDATE categories SET name = json_set(name, '$.en', 'Controllers') WHERE slug = 'controllers'").run();
      invalidateNavTaxonomy();
    }
  });
});

