/**
 * The home page's data and rules (app/server/services/home.server.ts, app/routes/storefront/home/{personal,view}.ts)
 * against a real, throw-away D1 with the demo catalogue. Expectations are derived from the database (platform order,
 * device-model order, stock states, release dates), not from product slugs, so they hold when the catalogue changes.
 */
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import type { ProductCardData } from "~/lib/dto";
import { LOCALES, localePath, type Locale } from "~/lib/locales";
import type { HeroSlide } from "~/routes/storefront/home/Hero";
import { seedDemo } from "~/server/db/seed/demo";
import { isAppError } from "~/server/errors";
import { getCardsByIds, getDeals, getUsedSpotlight } from "~/server/services/catalog/cards.server";
import { gelOfPlatformName } from "~/server/services/catalog/product-types";
import {
  HOME_PAGE_SECTIONS,
  HOME_PLATFORMS,
  NEW_RELEASE_DAYS,
  RECENT_MAX as SERVER_RECENT_MAX,
  SHELF_SIZES,
  baghdadMidnight,
  daysSinceRelease,
  getHomeData,
  getRecentlyViewedCards,
  isBuyable,
  parseOnboarding,
  pickHero,
  recordPersonalizationConsent,
  type HeroCandidate,
  type HomeData,
} from "~/server/services/home.server";
import { RECENT_DAYS, RECENT_MAX, cleanRecent, parseConsent, parsePlatformList, pushRecent, serializePlatformList } from "~/routes/storefront/home/personal";
import {
  FEATURED_PLATFORM,
  HERO_AUTOPLAY_MS,
  HERO_COPY_MIN,
  MIN_SHELF,
  baghdadDay,
  bannerAway,
  inView,
  deviceHubFor,
  featuredHero,
  focusAfterIntro,
  hasShelf,
  headlineEm,
  heroSlides,
  heroTitleSizes,
  keepLastWord,
  keepTogether,
  otherView,
  photoToWarm,
  pictureFailed,
  plainFinalYeh,
  releaseItemOf,
  releasePlatformOf,
  resolveFocus,
  splitHeadline,
  stripItems,
  tileArt,
  twoLineEm,
  wordsShown,
  type HeroBreakpoint,
} from "~/routes/storefront/home/view";
import { productPhotos } from "~/art";
import { PLATFORMS } from "~/ui/PlatformLed";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures } from "./helpers/factories";

const DAY_MS = 24 * 60 * 60 * 1000;

let t: TestDb;
let empty: HomeData;
let home: HomeData;
let homeEn: HomeData;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const l10n = (value: unknown) => JSON.parse(String(value)) as { ar: string; en?: string; ckb?: string };
/** A model's base product is named like the model in some language — ignoring case and spacing, as home.server does
 *  (the catalogue writes «Xbox Series X» where the seed's device model may still say «XBOX Series X»). */
const sameName = (a: { ar: string; en?: string; ckb?: string }, b: { ar: string; en?: string; ckb?: string }) =>
  (["ar", "en", "ckb"] as const).some((code) => {
    const left = (a[code] ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    return left !== "" && left === (b[code] ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  });

/** Products on a platform, written independently of the service: made for it, or a verified/partial rule for it. */
async function membersOf(platform: string): Promise<Set<string>> {
  const found = await rows<{ id: string }>(
    `WITH pl AS (SELECT id FROM platforms WHERE slug = ?1 AND is_active = 1),
          targets AS (
            SELECT 'device_model' AS kind, id FROM device_models WHERE platform_id IN (SELECT id FROM pl)
            UNION ALL SELECT 'generation', id FROM device_generations WHERE platform_id IN (SELECT id FROM pl)
            UNION ALL SELECT 'platform', id FROM pl)
     SELECT id FROM products WHERE platform_id IN (SELECT id FROM pl)
     UNION SELECT r.subject_id FROM compatibility_rules r JOIN targets tg ON tg.kind = r.target_type AND tg.id = r.target_id
       WHERE r.subject_type = 'product' AND r.status IN ('verified', 'partial')
     UNION SELECT v.product_id FROM compatibility_rules r JOIN targets tg ON tg.kind = r.target_type AND tg.id = r.target_id
       JOIN variants v ON v.id = r.subject_id AND v.is_active = 1
       WHERE r.subject_type = 'variant' AND r.status IN ('verified', 'partial')`,
    platform,
  );
  return new Set(found.map((row) => row.id));
}

async function publishedAt(): Promise<Map<string, number>> {
  const list = await rows<{ id: string; pub: number }>("SELECT id, COALESCE(published_at, created_at) AS pub FROM products");
  return new Map(list.map((row) => [row.id, Number(row.pub)]));
}

beforeAll(async () => {
  t = await createTestDb();
  empty = await getHomeData(t.db, { locale: "ar", now: t.now });
  await seedDemo(t.db, t.now);
  home = await getHomeData(t.db, { locale: "ar", now: t.now });
  homeEn = await getHomeData(t.db, { locale: "en", now: t.now });
});

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── empty store

describe("getHomeData — a migrated database with no catalogue", () => {
  it("answers with nothing rather than failing", () => {
    // the sections in the page's own order: nothing arranged in the content module (admin 17.01)
    expect(empty).toEqual({ platforms: [], cards: {}, deals: [], used: [], comingSoon: [], layout: { sections: [...HOME_PAGE_SECTIONS], arranged: false } });
  });
});

// ───────────────────────────────────────────────────────────────── platforms and heroes

describe("getHomeData — platforms and their heroes", () => {
  it("offers the bank's platforms that are active, in the store's menu order", async () => {
    const expected = await rows<{ slug: string }>(`SELECT slug FROM platforms WHERE is_active = 1 ORDER BY sort, id`);
    expect(home.platforms.map((platform) => platform.slug)).toEqual(expected.map((row) => row.slug).filter((slug) => (HOME_PLATFORMS as readonly string[]).includes(slug)));
    expect(home.platforms.length).toBe(4);
  });

  it("gives every platform a hero: a buyable console of that platform with a photo", () => {
    for (const platform of home.platforms) {
      expect(platform.hero, platform.slug).not.toBeNull();
      const card = home.cards[platform.hero!.productId];
      expect(card.kind).toBe("console");
      expect(card.platformSlug).toBe(platform.slug);
      expect(isBuyable(card)).toBe(true);
      expect(card.image.artKey).toBeTruthy();
    }
  });

  it("leads with the first device model in the store's order whose own (base) product can be bought", async () => {
    const consoles = await rows<{ id: string; platform: string; name: string; model: string; sort: number; status: string | null; released: string | null }>(
      `SELECT p.id, pl.slug AS platform, p.name, dm.name AS model, dm.sort, json_extract(p.attributes, '$.catalogue.status') AS status,
              json_extract(p.attributes, '$.catalogue.releaseDate') AS released
       FROM products p JOIN platforms pl ON pl.id = p.platform_id JOIN device_models dm ON dm.id = p.device_model_id
       WHERE p.status = 'published' AND p.kind = 'console' ORDER BY dm.sort, p.id`,
    );
    const cards = new Map((await getCardsByIds(t.db, "ar", consoles.map((row) => row.id), { now: t.now })).map((card) => [card.id, card]));
    for (const platform of home.platforms) {
      const base = consoles.filter(
        (row) => row.platform === platform.slug && row.status !== "discontinued" && sameName(l10n(row.name), l10n(row.model)) && isBuyable(cards.get(row.id)),
      );
      const fresh = base.filter((row) => {
        const days = daysSinceRelease(row.released, t.now);
        return days !== null && days >= 0 && days <= NEW_RELEASE_DAYS;
      });
      expect(platform.hero?.mode, platform.slug).toBe(fresh.length > 0 ? "new" : "lead");
      if (fresh.length === 0) expect(platform.hero?.productId, platform.slug).toBe(base[0]?.id);
    }
  });

  it("shows a base model released in the last NEW_RELEASE_DAYS days as new", async () => {
    const released = await rows<{ id: string; platform: string; released: string }>(
      `SELECT p.id, pl.slug AS platform, json_extract(p.attributes, '$.catalogue.releaseDate') AS released
       FROM products p JOIN platforms pl ON pl.id = p.platform_id JOIN device_models dm ON dm.id = p.device_model_id
       WHERE p.status = 'published' AND p.kind = 'console' AND lower(json_extract(p.name, '$.en')) = lower(json_extract(dm.name, '$.en'))
         AND json_extract(p.attributes, '$.catalogue.status') IS NOT 'discontinued' AND released IS NOT NULL
       ORDER BY released DESC`,
    );
    const cards = new Map((await getCardsByIds(t.db, "ar", released.map((row) => row.id), { now: t.now })).map((card) => [card.id, card]));
    const subject = released.find((row) => isBuyable(cards.get(row.id)));
    expect(subject).toBeDefined();
    const later = await getHomeData(t.db, { locale: "ar", now: baghdadMidnight(subject!.released)! + 10 * DAY_MS });
    const hero = later.platforms.find((platform) => platform.slug === subject!.platform)?.hero;
    expect(hero).toEqual({ productId: subject!.id, mode: "new", releasedOn: subject!.released });
  });

  it("speaks the request's language", async () => {
    for (const platform of homeEn.platforms) {
      const [row] = await rows<{ name: string }>("SELECT name FROM products WHERE id = ?", platform.hero!.productId);
      expect(homeEn.cards[platform.hero!.productId].name).toBe(l10n(row.name).en);
    }
  });
});

describe("pickHero — the rule on its own", () => {
  const card = (id: string, stock: ProductCardData["stock"], art: string | null = `${id}--1`): ProductCardData => ({
    id,
    slug: id,
    name: id,
    subtitle: null,
    kind: "console",
    platformSlug: "xbox",
    platformName: "Xbox",
    variantId: `var_${id}`,
    hasVariants: false,
    priceIqd: 500_000,
    compareAtIqd: null,
    stock,
    badge: "new",
    image: { artKey: art, mediaKey: null, alt: id, isIllustration: false },
    rating: null,
    isDemo: true,
  });
  const candidate = (id: string, over: Partial<HeroCandidate> = {}): HeroCandidate => ({
    id,
    name: { ar: id, en: id },
    modelName: { ar: id, en: id },
    modelSort: 10,
    released: "2020-01-01",
    discontinued: false,
    pub: 1,
    ...over,
  });
  const NOW = Date.UTC(2026, 10, 10);

  it("prefers the newest base model released within the window", () => {
    const cards = new Map([
      ["old", card("old", "in_stock")],
      ["fresh", card("fresh", "low_stock")],
      ["bundle", card("bundle", "in_stock")],
    ]);
    const hero = pickHero(
      [candidate("old", { modelSort: 1 }), candidate("fresh", { modelSort: 9, released: "2026-10-01" }), candidate("bundle", { released: "2026-11-01", modelName: { ar: "x", en: "x" } })],
      cards,
      NOW,
    );
    expect(hero).toEqual({ productId: "fresh", mode: "new", releasedOn: "2026-10-01" });
  });

  it("otherwise takes the lead device: model order, then the base product, then the shorter name", () => {
    const cards = new Map(["a-bundle-with-a-long-name", "a", "b", "gone", "nophoto"].map((id) => [id, card(id, id === "gone" ? "out_of_stock" : "in_stock", id === "nophoto" ? null : `${id}--1`)]));
    expect(
      pickHero(
        [
          candidate("gone", { modelSort: 1 }),
          candidate("nophoto", { modelSort: 1 }),
          candidate("a-bundle-with-a-long-name", { modelSort: 2, modelName: { ar: "a", en: "a" } }),
          candidate("a", { modelSort: 2 }),
          candidate("b", { modelSort: 3 }),
        ],
        cards,
        NOW,
      ),
    ).toEqual({ productId: "a", mode: "lead", releasedOn: "2020-01-01" });
  });

  it("does not feature discontinued products while a current one can be bought, and has no hero when nothing can be", () => {
    const cards = new Map([
      ["old", card("old", "in_stock")],
      ["current", card("current", "in_stock")],
    ]);
    expect(pickHero([candidate("old", { modelSort: 1, discontinued: true }), candidate("current", { modelSort: 5 })], cards, NOW)?.productId).toBe("current");
    expect(pickHero([candidate("old", { modelSort: 1, discontinued: true })], cards, NOW)?.productId).toBe("old");
    expect(pickHero([candidate("old")], new Map([["old", card("old", "out_of_stock")]]), NOW)).toBeNull();
    expect(pickHero([candidate("pre")], new Map([["pre", card("pre", "preorder")]]), NOW)).toBeNull();
    expect(pickHero([], cards, NOW)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── shelves

describe("getHomeData — shelves", () => {
  it("fills new arrivals with the newest buyable products of the platform, newest first", async () => {
    const pub = await publishedAt();
    for (const platform of home.platforms) {
      const members = await membersOf(platform.slug);
      const list = platform.newArrivals;
      expect(list.length, platform.slug).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(SHELF_SIZES.newArrivals);
      expect(new Set(list).size).toBe(list.length);
      for (const id of list) {
        expect(members.has(id), `${platform.slug}: ${id}`).toBe(true);
        expect(isBuyable(home.cards[id]), id).toBe(true);
      }
      for (let i = 1; i < list.length; i++) expect(pub.get(list[i - 1])! >= pub.get(list[i])!).toBe(true);
      // nothing newer and buyable was skipped
      const cards = new Map((await getCardsByIds(t.db, "ar", [...members], { now: t.now })).map((card) => [card.id, card]));
      const newest = [...members]
        .filter((id) => isBuyable(cards.get(id)))
        .sort((a, b) => pub.get(b)! - pub.get(a)! || b.localeCompare(a))
        .slice(0, SHELF_SIZES.newArrivals);
      expect(list).toEqual(newest);
    }
  });

  it("keeps games to games and gear to controllers, headsets, storage and accessories — none of them repeated from new arrivals", async () => {
    for (const platform of home.platforms) {
      const members = await membersOf(platform.slug);
      expect(platform.games.length).toBeLessThanOrEqual(SHELF_SIZES.games);
      expect(platform.gear.length).toBeLessThanOrEqual(SHELF_SIZES.gear);
      for (const id of platform.games) {
        expect(home.cards[id].kind).toBe("game");
        expect(members.has(id)).toBe(true);
        expect(platform.newArrivals).not.toContain(id);
        expect(isBuyable(home.cards[id])).toBe(true);
      }
      for (const id of platform.gear) {
        expect(["controller", "headset", "storage", "accessory"]).toContain(home.cards[id].kind);
        expect(members.has(id)).toBe(true);
        expect(platform.newArrivals).not.toContain(id);
        expect(isBuyable(home.cards[id])).toBe(true);
      }
    }
    // the demo catalogue has games for the console platforms
    expect(home.platforms.filter((platform) => platform.games.length > 0).length).toBeGreaterThanOrEqual(3);
  });

  it("puts a product sold for several platforms on a platform's shelves only through a verified or partial rule", async () => {
    const make = fixtures(t.db, t.now);
    const product = await make.product({ kind: "headset", stock: 5 });
    const [model] = await rows<{ id: string }>(
      "SELECT dm.id FROM device_models dm JOIN platforms pl ON pl.id = dm.platform_id WHERE pl.slug = 'xbox' ORDER BY dm.sort LIMIT 1",
    );
    // the newest product of the store, with no platform of its own
    await t.d1.prepare("UPDATE products SET published_at = ?, platform_id = NULL WHERE id = ?").bind(t.now + 365 * DAY_MS, product.productId).run();
    await t.d1
      .prepare("INSERT INTO compatibility_rules (id, subject_type, subject_id, target_type, target_id, status, created_at, updated_at) VALUES (?, 'product', ?, 'device_model', ?, 'unverified', ?, ?)")
      .bind("cmp_home_test", product.productId, model.id, t.now, t.now)
      .run();
    const onXbox = async () => {
      const data = await getHomeData(t.db, { locale: "ar", now: t.now });
      const xbox = data.platforms.find((platform) => platform.slug === "xbox")!;
      const others = data.platforms.filter((platform) => platform.slug !== "xbox");
      expect(others.some((platform) => [...platform.newArrivals, ...platform.gear].includes(product.productId))).toBe(false);
      return xbox.newArrivals[0] === product.productId;
    };
    try {
      expect(await onXbox()).toBe(false);
      for (const [status, shown] of [
        ["verified", true],
        ["incompatible", false],
        ["partial", true],
      ] as const) {
        await t.d1.prepare("UPDATE compatibility_rules SET status = ? WHERE id = 'cmp_home_test'").bind(status).run();
        expect(await onXbox(), status).toBe(shown);
      }
    } finally {
      await t.d1.prepare("UPDATE products SET status = 'archived' WHERE id = ?").bind(product.productId).run();
    }
    expect(await onXbox()).toBe(false);
  });

  it("lists genuine reductions only, exactly as the read layer's deals", async () => {
    const deals = await getDeals(t.db, "ar", { limit: 12, now: t.now });
    expect(home.deals).toEqual(deals.map((card) => card.id));
    expect(home.deals.length).toBeGreaterThan(0);
    for (const id of home.deals) {
      const card = home.cards[id];
      expect(card.compareAtIqd).not.toBeNull();
      expect(card.compareAtIqd!).toBeGreaterThan(card.priceIqd);
      expect(isBuyable(card)).toBe(true);
    }
  });

  it("spotlights listed used units only", async () => {
    const used = await getUsedSpotlight(t.db, "ar", { limit: 8 });
    expect(home.used.map((unit) => unit.id)).toEqual(used.map((unit) => unit.id));
    const listed = await rows<{ n: number }>("SELECT COUNT(*) AS n FROM used_units WHERE status = 'listed'");
    expect(home.used.length).toBe(Math.min(8, Number(listed[0].n)));
  });

  it("sends each card once, and only the cards the page names", () => {
    const named = new Set<string>(home.deals);
    for (const platform of home.platforms) {
      named.add(platform.hero!.productId);
      for (const id of [...platform.newArrivals, ...platform.games, ...platform.gear]) named.add(id);
    }
    expect(new Set(Object.keys(home.cards))).toEqual(named);
    const json = JSON.stringify(home);
    expect(json).not.toMatch(/cost|margin|on_hand|onHand|serial|reserved/i);
  });
});

// ───────────────────────────────────────────────────────────────── coming soon

describe("getHomeData — coming soon", () => {
  it("lists every pre-order product and every unreleased variant, soonest first, and nothing released", async () => {
    const preorders = await rows<{ id: string; at: number }>(
      "SELECT id, preorder_release_at AS at FROM products WHERE status = 'published' AND preorder_release_at > ? ORDER BY id",
      t.now,
    );
    const variants = await rows<{ product_id: string; day: string }>(
      `SELECT p.id AS product_id, je.value AS day FROM products p JOIN json_each(p.attributes, '$.variantReleaseDates') je
       JOIN variants v ON v.product_id = p.id AND v.sku = je.key AND v.is_active = 1 WHERE p.status = 'published'`,
    );
    const ahead = variants.filter((row) => baghdadMidnight(row.day)! > t.now && !preorders.some((p) => p.id === row.product_id));
    expect(preorders.length).toBeGreaterThan(0);
    expect(ahead.length).toBeGreaterThan(0);

    const products = home.comingSoon.filter((item) => item.variantCount === 0);
    expect(products.map((item) => item.productId).sort()).toEqual(preorders.map((row) => row.id));
    for (const item of products) expect(item.releaseAt).toBe(Number(preorders.find((row) => row.id === item.productId)!.at));

    const groups = new Map<string, number>();
    for (const row of ahead) groups.set(`${row.product_id}:${row.day}`, (groups.get(`${row.product_id}:${row.day}`) ?? 0) + 1);
    const variantItems = home.comingSoon.filter((item) => item.variantCount > 0);
    expect(new Map(variantItems.map((item) => [item.key, item.variantCount]))).toEqual(groups);

    for (let i = 1; i < home.comingSoon.length; i++) expect(home.comingSoon[i].releaseAt).toBeGreaterThanOrEqual(home.comingSoon[i - 1].releaseAt);
    for (const item of home.comingSoon) {
      expect(item.releaseAt).toBeGreaterThan(t.now);
      expect(item.image.artKey ?? item.image.mediaKey).toBeTruthy();
      expect(Number.isSafeInteger(item.priceIqd)).toBe(true);
    }
  });

  it("keeps pre-orders off every shelf (they cannot be added to a cart)", () => {
    const preorderIds = new Set(home.comingSoon.filter((item) => item.variantCount === 0).map((item) => item.productId));
    for (const platform of home.platforms) {
      for (const id of [platform.hero!.productId, ...platform.newArrivals, ...platform.games, ...platform.gear]) expect(preorderIds.has(id)).toBe(false);
    }
  });

  it("drops what has come out by the time of the request", async () => {
    const last = home.comingSoon[home.comingSoon.length - 1];
    const later = await getHomeData(t.db, { locale: "ar", now: last.releaseAt + DAY_MS });
    expect(later.comingSoon).toEqual([]);
  });

  it("carries each item's platform line, so the page needs no second card read (data owner)", async () => {
    const productItems = home.comingSoon.filter((item) => item.variantCount === 0);
    const cards = new Map((await getCardsByIds(t.db, "ar", productItems.map((item) => item.productId), { now: t.now })).map((card) => [card.id, card]));
    for (const item of productItems) {
      const card = cards.get(item.productId)!;
      const platforms = card.forPlatforms?.length ? card.forPlatforms : card.platformSlug ? [card.platformSlug] : [];
      expect(item.forPlatforms, item.slug).toEqual(platforms);
      expect(item.platformSlug, item.slug).toBe(platforms.length === 1 ? platforms[0] : null);
      expect(item.kindLabel, item.slug).toBe(card.kindLabel ?? null);
    }
    // a later version for one platform (a PS5 version of a game out on Xbox) is that platform's, whatever the product's line
    const versions = await rows<{ product_id: string; platform: string | null }>(
      `SELECT p.id AS product_id, json_extract(v.options, '$.platform') AS platform FROM products p JOIN json_each(p.attributes, '$.variantReleaseDates') je
       JOIN variants v ON v.product_id = p.id AND v.sku = je.key AND v.is_active = 1 WHERE p.status = 'published' AND json_valid(v.options)`,
    );
    for (const item of home.comingSoon.filter((entry) => entry.variantCount > 0)) {
      const named = versions.filter((row) => row.product_id === item.productId).map((row) => gelOfPlatformName(row.platform)).filter(Boolean);
      if (named.length === 1) expect(item.platformSlug, item.key).toBe(named[0]);
      expect(item.forPlatforms.length, item.key).toBeGreaterThan(0);
      expect(item.kindLabel?.length, item.key).toBeGreaterThan(0);
    }
  });

  it("leaves out the games, gear and deals shelves when the page does not want them (extraShelves: false)", async () => {
    const lean = await getHomeData(t.db, { locale: "ar", now: t.now, extraShelves: false });
    expect(lean.deals).toEqual([]);
    for (const platform of lean.platforms) {
      expect(platform.games).toEqual([]);
      expect(platform.gear).toEqual([]);
      const full = home.platforms.find((entry) => entry.slug === platform.slug)!;
      // what the page shows stays the same
      expect(platform.hero).toEqual(full.hero);
      expect(platform.newArrivals).toEqual(full.newArrivals);
    }
    expect(lean.comingSoon).toEqual(home.comingSoon);
    expect(lean.used).toEqual(home.used);
  });
});

// ───────────────────────────────────────────────────────────────── recently viewed, onboarding

describe("recently viewed cards", () => {
  it("returns cards in the order asked, skipping what cannot be shown", async () => {
    const [a, b] = home.platforms.map((platform) => platform.hero!.productId);
    const cards = await getRecentlyViewedCards(t.db, "en", [b, "prd_does-not-exist", a, b], t.now);
    expect(cards.map((card) => card.id)).toEqual([b, a]);
    expect(await getRecentlyViewedCards(t.db, "ar", [], t.now)).toEqual([]);
  });

  it("refuses more than RECENT_MAX ids and ids that are not ids", async () => {
    const tooMany = Array.from({ length: SERVER_RECENT_MAX + 1 }, (_, i) => `prd_${i}`);
    await expect(getRecentlyViewedCards(t.db, "ar", tooMany, t.now)).rejects.toSatisfy((error) => isAppError(error, "invalid"));
    await expect(getRecentlyViewedCards(t.db, "ar", ["x'); DROP TABLE products; --"], t.now)).rejects.toSatisfy((error) => isAppError(error, "invalid"));
    await expect(getRecentlyViewedCards(t.db, "ar", [42], t.now)).rejects.toSatisfy((error) => isAppError(error, "invalid"));
  });
});

describe("onboarding answers", () => {
  it("parses the form: known platforms once each, consent as a yes or no", () => {
    expect(parseOnboarding({ intro: "seen", platforms: "xbox.playstation.xbox", consent: "1" })).toEqual({ introSeen: true, platforms: ["xbox", "playstation"], consent: true });
    expect(parseOnboarding({ consent: "0" })).toEqual({ introSeen: false, platforms: null, consent: false });
    expect(parseOnboarding({ platforms: "" })).toEqual({ introSeen: false, platforms: [], consent: null });
    expect(parseOnboarding({})).toEqual({ introSeen: false, platforms: null, consent: null });
  });

  it("refuses anything else with field errors", () => {
    const fieldsOf = (raw: unknown) => {
      try {
        parseOnboarding(raw);
      } catch (error) {
        if (isAppError(error, "invalid")) return error.fields;
        throw error;
      }
      return null;
    };
    expect(fieldsOf({ platforms: "xbox.sega" })).toEqual({ platforms: "invalid" });
    expect(fieldsOf({ consent: "yes" })).toEqual({ consent: "invalid" });
    expect(fieldsOf({ intro: "maybe" })).toEqual({ intro: "invalid" });
    expect(fieldsOf({ platforms: "xbox.".repeat(40) })).toEqual({ platforms: "too_long" });
  });

  it("records a signed-in customer's answers as history, newest last", async () => {
    const customerId = await fixtures(t.db, t.now).customer();
    await recordPersonalizationConsent(t.db, { customerId, granted: true, ip: "203.0.113.9", now: t.now });
    await recordPersonalizationConsent(t.db, { customerId, granted: false, ip: null, now: t.now + 1000 });
    const history = await rows<{ kind: string; granted: number; source: string; subject_type: string }>(
      "SELECT kind, granted, source, subject_type FROM consents WHERE subject_id = ? ORDER BY at",
      customerId,
    );
    expect(history).toEqual([
      { kind: "personalization", granted: 1, source: "home_onboarding", subject_type: "customer" },
      { kind: "personalization", granted: 0, source: "home_onboarding", subject_type: "customer" },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────── client rules

describe("client rules", () => {
  it("uses the design system's four platforms and one recently-viewed limit", () => {
    expect([...HOME_PLATFORMS]).toEqual([...PLATFORMS]);
    expect(RECENT_MAX).toBe(SERVER_RECENT_MAX);
  });

  it("reads and writes the platforms cookie", () => {
    expect(parsePlatformList("xbox.sega,nintendo xbox")).toEqual(["xbox", "nintendo"]);
    expect(parsePlatformList(null)).toEqual([]);
    expect(serializePlatformList(["handheld", "nintendo", "handheld"])).toBe("handheld.nintendo");
    expect([parseConsent("1"), parseConsent("0"), parseConsent(null), parseConsent("true")]).toEqual([true, false, null, null]);
  });

  it("keeps the recently-viewed list short, recent, unique and newest first", () => {
    const now = Date.UTC(2026, 10, 11);
    const list = cleanRecent(
      [
        { id: "prd_a", at: now - 1000 },
        { id: "prd_b", at: now - 500 },
        { id: "prd_a", at: now - 100 },
        { id: "bad id", at: now },
        { id: "prd_old", at: now - (RECENT_DAYS + 1) * DAY_MS },
        { id: "prd_future", at: now + 2 * DAY_MS },
        null,
        "prd_x",
      ],
      now,
    );
    expect(list.map((entry) => entry.id)).toEqual(["prd_a", "prd_b"]);
    expect(cleanRecent("nonsense", now)).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `prd_${i}`, at: now - i * 1000 }));
    expect(cleanRecent(many, now)).toHaveLength(RECENT_MAX);
    expect(pushRecent(list, "prd_b", now + 1).map((entry) => entry.id)).toEqual(["prd_b", "prd_a"]);
  });

  it("features the Nintendo platform's lead device until staff pin one, else the next platform that has a hero (v2 §13 #13)", () => {
    const platforms = [
      { slug: "nintendo", hero: { productId: "switch-2" }, newArrivals: ["n1"] },
      { slug: "playstation", hero: { productId: "ps5-pro" }, newArrivals: [] },
    ];
    expect(featuredHero(platforms)?.hero?.productId).toBe("switch-2");
    expect(featuredHero([{ ...platforms[0], hero: null }, platforms[1]])?.slug).toBe("playstation");
    expect(featuredHero(platforms, "playstation")?.slug).toBe("playstation");
    expect(featuredHero([{ slug: "xbox", hero: null, newArrivals: [] }])).toBeNull();
    // the demo catalogue: the featured product is a buyable Nintendo console with a photo
    const featured = featuredHero(home.platforms);
    expect(featured?.slug).toBe("nintendo");
    const card = home.cards[featured!.hero!.productId];
    expect(card.kind).toBe("console");
    expect(isBuyable(card) && Boolean(card.image.artKey)).toBe(true);
  });

  it("starts the new-arrivals chips on the URL's platform, else the shopper's, else the featured one — never on a shelf the page does not draw", () => {
    const shelf = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
    const platforms = [
      { slug: "nintendo", hero: null, newArrivals: shelf("n", 6) },
      { slug: "playstation", hero: null, newArrivals: shelf("p", MIN_SHELF) },
      { slug: "xbox", hero: null, newArrivals: [] },
      { slug: "handheld", hero: null, newArrivals: shelf("h", 4) },
    ];
    expect(resolveFocus("playstation", platforms, [])).toBe("playstation");
    expect(resolveFocus("xbox", platforms, [])).toBe("nintendo");
    expect(resolveFocus("sega", platforms, ["xbox", "handheld"])).toBe("handheld");
    expect(resolveFocus(null, platforms, [])).toBe("nintendo");
    expect(resolveFocus(null, platforms.slice(1), [])).toBe("playstation");
    expect(resolveFocus(null, [{ slug: "xbox", hero: null, newArrivals: [] }], [])).toBeNull();
    expect(resolveFocus(null, [], [])).toBeNull();
    // a platform with fewer new arrivals than a shelf needs (v2 §4.22: under 3 a shelf is not drawn) is never the chip
    // the shelf starts on — the URL's, the shopper's saved one or the featured one: the whole section, its chips
    // included, would vanish while the other platforms have full shelves
    const short = [{ slug: "nintendo", hero: null, newArrivals: shelf("n", MIN_SHELF - 1) }, ...platforms.slice(1)];
    expect(resolveFocus("nintendo", short, [])).toBe("playstation");
    expect(resolveFocus(null, short, ["nintendo", "handheld"])).toBe("handheld");
    expect(resolveFocus(null, short, [])).toBe("playstation");
    expect(resolveFocus(null, [short[0]], [])).toBeNull();
    expect([hasShelf(short[0]), hasShelf(platforms[1]), hasShelf(platforms[2])]).toEqual([false, true, false]);
  });

  it("gives the hero's photo up when the browser already failed it before the page came to life (no broken-image frame)", () => {
    // an <img> that failed before hydration never fires React's onError: the page checks it once it is on screen
    expect(pictureFailed({ complete: true, naturalWidth: 0 })).toBe(true);
    expect(pictureFailed({ complete: false, naturalWidth: 0 })).toBe(false); // still loading: onError will tell
    expect(pictureFailed({ complete: true, naturalWidth: 1349 })).toBe(false);
    expect(pictureFailed(null)).toBe(false);
  });

  it("shows the same picture on a platform tile in the intro as on the page — never the back of a console", async () => {
    // v2 §7.6: the device as sold, front or front three-quarter. The next "angle" photo of a lead device can be its back
    // (Xbox Series X --2: «الجهة الخلفية من Xbox Series X مع المنافذ»; Switch 2 --3), so a tile only steps away from
    // its own picture when the hero already shows it — the intro's corner objects (the lead devices) do not count.
    const backs = ["xbox-series-x--2", "nintendo-switch-2--3"];
    const heroArt = home.cards[featuredHero(home.platforms)!.hero!.productId].image.artKey;
    const tiles = await rows<{ slug: string; art_key: string | null }>("SELECT slug, art_key FROM platforms WHERE is_active = 1");
    for (const platform of home.platforms) {
      const own = tiles.find((row) => row.slug === platform.slug)?.art_key ?? null;
      const picture = tileArt(own, heroArt);
      expect(backs, platform.slug).not.toContain(picture);
      expect(picture, platform.slug).toBe(own === heroArt ? otherView(own, heroArt) : own);
      // the corner object of the intro is the platform's lead device; the tile does not step away from it
      const lead = home.cards[platform.hero!.productId].image.artKey;
      if (own === lead && own !== heroArt) expect(picture, platform.slug).toBe(lead);
    }
    expect(FEATURED_PLATFORM).toBe("nintendo");
    expect(tileArt("xbox-series-x--1", "nintendo-switch-2--1")).toBe("xbox-series-x--1");
    expect(tileArt("nintendo-switch-2--1", "nintendo-switch-2--1")).toBe("nintendo-switch-2--2");
    expect(tileArt(null, "nintendo-switch-2--1")).toBeNull();
  });

  it("splits the hero headline around the product's name: the words before it on the first line", () => {
    expect(splitHeadline((name) => `العب على ${name}`, "Nintendo Switch 2")).toEqual({ lead: "العب على", after: "", name: "Nintendo Switch 2" });
    expect(splitHeadline((name) => `یاری بکە لەسەر ${name}`, "Xbox Series X")).toEqual({ lead: "یاری بکە لەسەر", after: "", name: "Xbox Series X" });
    expect(splitHeadline((name) => `${name} گەیشت`, "Steam Deck OLED")).toEqual({ lead: "", after: "گەیشت", name: "Steam Deck OLED" });
    expect(splitHeadline(() => "Play on", "X")).toEqual({ lead: "Play on", after: "", name: "X" });
  });

  it("keeps a short last word with the name it belongs to («Switch 2», «5 Pro», «Go 2» never break)", () => {
    expect(keepTogether("Nintendo Switch 2")).toBe("Nintendo Switch 2");
    expect(keepTogether("PlayStation 5 Pro")).toBe("PlayStation 5 Pro");
    expect(keepTogether("Lenovo Legion Go 2")).toBe("Lenovo Legion Go 2");
    expect(keepTogether("Steam Deck OLED")).toBe("Steam Deck OLED");
    expect(keepTogether("DualSense")).toBe("DualSense");
  });

  it("estimates headline widths a little above what the faces measure, never below", () => {
    // measured in Edge on the dev server (em, 2026-11-12): Kufam Variable 600 (v2.1: the headline face in every
    // language — it replaced Noto Kufi, whose widths these tests used to pin) and IBM Plex Sans Arabic 600. A Latin line
    // may be up to 6% wider; a line of the page's OWN Arabic and Sorani headline words too (they are measured word by
    // word); a staff's Arabic words up to 25% beside a Latin name (one width stands in for every unknown joined letter)
    // — never narrower.
    const kufam: Record<string, number> = {
      "Nintendo Switch 2": 9.195,
      "PlayStation 5 Pro": 8.6,
      "Xbox Series X": 6.785,
      "Steam Deck OLED": 8.918,
      "Lenovo Legion Go 2": 9.78,
      "Trade in your device": 10.046,
      "Used & inspected": 8.668,
      "العب على": 4.523,
      "یاری بکە لەسەر": 7.737,
      "استبدل جهازك": 7.053,
      "مستعمل ومفحوص": 8.983,
      "ئامێرەکەت بگۆڕەوە": 10.634,
      "بەکارهاتوو و پشکنراو": 11.341,
      "العب على Nintendo Switch 2": 13.963,
      "العب على PlayStation 5 Pro": 13.368,
      "العب على Xbox Series X": 11.553,
      "Nintendo Switch 2 گەیشت": 13.789,
      "Play on Steam Deck OLED": 12.821,
    };
    const plex: Record<string, number> = { "Nintendo Switch 2": 8.511, "Steam Deck OLED": 8.298, "Nintendo Switch 2 یاری بکە": 11.878, "یاری بکە": 3.131, "مستعمل ومفحوص": 7.599 };
    for (const [face, measured] of [["kufam", kufam], ["plex", plex]] as const) {
      for (const [text, em] of Object.entries(measured)) {
        expect(headlineEm(text, face), `${face}: ${text}`).toBeGreaterThanOrEqual(em);
        expect(headlineEm(text, face), `${face}: ${text}`).toBeLessThanOrEqual(em * 1.06);
      }
    }
    // a staff pin's words the page has not measured: wider than measured, at most a quarter wider beside a Latin name
    const pinned: Record<string, number> = { "سعر تقديري الآن": 7.433, "تخفيضات الصيف على الأجهزة": 14.056, "عرض خاص": 5.301 };
    for (const [text, em] of Object.entries(pinned)) expect(headlineEm(text), text).toBeGreaterThanOrEqual(em);
    expect(headlineEm("")).toBe(1);
  });

  it("finds the best two-line break of a headline, never at a no-break space («Switch 2», «5 Pro»)", () => {
    expect(twoLineEm(keepLastWord("Nintendo Switch 2"))).toBe(Math.max(headlineEm("Nintendo"), headlineEm("Switch 2")));
    expect(twoLineEm(keepLastWord("PlayStation 5 Pro"))).toBe(Math.max(headlineEm("PlayStation"), headlineEm("5 Pro")));
    // keepTogether's one-piece name has no break: two lines are no narrower than one
    expect(twoLineEm(keepTogether("PlayStation 5 Pro"))).toBe(headlineEm("PlayStation 5 Pro"));
    expect(twoLineEm("وصل")).toBe(headlineEm("وصل"));
    // the hero's form of a name keeps only the short last word with the word before it
    expect(keepLastWord("PlayStation 5 Pro")).toBe("PlayStation 5 Pro");
    expect(keepLastWord("Steam Deck OLED")).toBe("Steam Deck OLED");
    expect(keepLastWord("DualSense")).toBe("DualSense");
  });

  it("sizes a banner's headline on its own range's type scale, one step down until it fits the copy column", () => {
    // v2 §2.6: the Kufam sizes each range already draws, display first (display, price xl, h1, h2); on phones the
    // compact banner's own two (h2 22, tile 18) — QA 2026-11-12: a size from another range's scale is one more size
    const scale: Record<HeroBreakpoint, number[]> = { sm: [22, 18], md: [40, 32, 30, 24], lg: [48, 34, 32, 26], xl: [56, 36, 28] };
    // the featured console: «العب على» / «Nintendo Switch 2» at the display size from 768; on phones the name alone on
    // two lines («Nintendo» / «Switch 2») at 22
    const switch2 = heroTitleSizes(["العب على", keepLastWord("Nintendo Switch 2")], "kufam", { phone: keepLastWord("Nintendo Switch 2") });
    expect(switch2).toEqual({ sm: 22, md: 40, lg: 48, xl: 56 });
    for (const range of ["md", "lg", "xl"] as const) expect(headlineEm("Nintendo Switch 2") * switch2[range]).toBeLessThanOrEqual(HERO_COPY_MIN[range]);
    expect(twoLineEm(keepLastWord("Nintendo Switch 2")) * switch2.sm).toBeLessThanOrEqual(HERO_COPY_MIN.sm);
    // every platform's hero of the demo catalogue keeps the display size from 768 in Arabic, English and Sorani (Kufam
    // everywhere now — the Sorani lead words are measured, no longer a guess that stepped them down)
    for (const lines of [
      ["العب على", "PlayStation 5 Pro"],
      ["Play on", "Xbox Series X"],
      ["یاری بکە لەسەر", "Steam Deck OLED"],
    ]) {
      const sizes = heroTitleSizes(lines, "kufam", { phone: lines[1] });
      expect([sizes.md, sizes.lg, sizes.xl], lines.join(" / ")).toEqual([40, 48, 56]);
    }
    // Sorani puts the verb after the name («{name} گەیشت»): that line may break after the name, so the name keeps the
    // display size (on one line it would step down to 36); phones show the name alone, as they do without the verb
    const arrived = keepLastWord("Nintendo Switch 2") + " گەیشت";
    expect(heroTitleSizes(["", arrived]).xl).toBe(36);
    expect(heroTitleSizes(["", arrived], "kufam", { wrap: true, phone: keepLastWord("Nintendo Switch 2") })).toEqual({ sm: 22, md: 40, lg: 48, xl: 56 });
    // a long name steps down its range's scale and, below the smallest step (the range's h2), wraps there (balanced)
    const long = heroTitleSizes(["Play on", "Nintendo Switch – OLED Model"], "kufam", { phone: "Nintendo Switch – OLED Model" });
    expect(long).toEqual({ sm: 18, md: 24, lg: 26, xl: 28 });
    // a staff pin's headline may take two lines: sized by its best break, so it keeps a larger size than on one line
    const pin = "عرض خاص على PlayStation 5";
    expect(heroTitleSizes([pin], "kufam", { wrap: true }).xl).toBeGreaterThan(heroTitleSizes([pin]).xl);
    // the service banners' two-word titles: the display size from 768 in every language
    for (const title of ["استبدل جهازك", "مستعمل ومفحوص", "Trade in your device", "Used & inspected", "ئامێرەکەت بگۆڕەوە", "بەکارهاتوو و پشکنراو"]) {
      expect(heroTitleSizes([title], "kufam", { wrap: true, phone: title }).xl, title).toBe(56);
    }
    const all = [switch2, long, heroTitleSizes(["وصل", "Xbox Series X|S – Galaxy Black Edition"]), heroTitleSizes([pin], "kufam", { wrap: true, phone: pin })];
    for (const sizes of all) for (const range of Object.keys(scale) as HeroBreakpoint[]) expect(scale[range], `${range} ${sizes[range]}px`).toContain(sizes[range]);
  });

  it("orders the hero's banners: the featured platform first, the others in the key bank's order, then trade-in and used", () => {
    const platform = (slug: string, art: string | null, pinned = false) => ({ slug, hero: art === null ? null : { productId: `${slug}-hero`, pin: pinned ? { pinId: "p" } : null }, newArrivals: [] as string[], art });
    const bank = [platform("nintendo", "nintendo-switch-2--1"), platform("playstation", "playstation-5-pro--1"), platform("xbox", "xbox-series-x--1"), platform("handheld", "steam-deck-oled--1")];
    const artOf = (entry: (typeof bank)[number]) => entry.art;
    const usedArt = ["playstation-5-slim--1", "nintendo-switch-oled--1", "xbox-series-s--1", "steam-deck-oled--1"];
    const plan = heroSlides(bank, artOf, { usedArt, fallbackArt: "playstation-5-pro--1" });
    expect(plan.map((slide) => slide.key)).toEqual(["nintendo", "playstation", "xbox", "handheld", "trade-in", "used"]);
    // the service banners show consoles no platform banner shows, upright ones first (the Switch OLED is wide)
    const service = plan.filter((slide) => slide.kind !== "platform") as { kind: string; art: string | null }[];
    expect(service).toEqual([
      { kind: "tradeIn", key: "trade-in", art: "playstation-5-slim--1" },
      { kind: "used", key: "used", art: "xbox-series-s--1" },
    ]);
    // a staff pin leads (what staff chose for this period, as the single hero did); a platform without a hero is left out
    const pinned = heroSlides([bank[0], platform("playstation", null), bank[2], platform("handheld", "steam-deck-oled--1", true)], artOf, { usedArt: [] });
    expect(pinned.map((slide) => slide.key)).toEqual(["handheld", "nintendo", "xbox", "trade-in"]);
    // no used units: no used banner; the trade-in banner falls back to the PlayStation lead device's picture, shown on a
    // platform banner or not
    const lean = heroSlides(bank, artOf, { usedArt: [], fallbackArt: "playstation-5-pro--1" });
    expect(lean.at(-1)).toEqual({ kind: "tradeIn", key: "trade-in", art: "playstation-5-pro--1" });
    expect(heroSlides([], artOf, { usedArt: [] })).toEqual([{ kind: "tradeIn", key: "trade-in", art: null }]);
    // the demo catalogue: four platform banners, Nintendo first, then trade-in and used
    const demo = heroSlides(home.platforms, (entry) => home.cards[entry.hero!.productId]?.image.artKey, { usedArt: home.used.map((unit) => unit.image.artKey) });
    expect(demo.map((slide) => slide.key)).toEqual([FEATURED_PLATFORM, ...home.platforms.map((entry) => entry.slug).filter((slug) => slug !== FEATURED_PLATFORM), "trade-in", ...(home.used.length > 0 ? ["used"] : [])]);
    expect(HERO_AUTOPLAY_MS).toBe(6500);
  });

  it("fetches the next banner's photo ahead while one is shown — never the first banner's (the page's one eager photo), nothing on Save-Data (review 2026-11-13)", () => {
    // a lazy photo in the sideways track waits until it scrolls in: every banner arrived as a blurred miniature and its
    // product popped in a moment later (measured in Edge: banners 2–6 not loaded 3 s after the page, nor on arrival)
    expect(photoToWarm(0, 6)).toBe(1);
    expect(photoToWarm(3, 6)).toBe(4);
    expect(photoToWarm(4, 6)).toBe(5);
    expect(photoToWarm(5, 6)).toBeNull();
    expect(photoToWarm(0, 6, true)).toBeNull();
    expect(photoToWarm(0, 1)).toBeNull();
    expect(photoToWarm(0, 0)).toBeNull();
  });

  it("shows a banner's words while it moves, as much as their column is on screen — in both directions of text (fix-browse 2026-11-13)", () => {
    // the words used to appear only after the banner landed (the slide in view is decided at 55% of the move, then a
    // fade): mid-switch frames showed an empty band of colour. A banner's distance from its resting place, in banners —
    // positive toward the reading direction's end, in both directions of text
    // (the boxes are the screen's: left and right edges in px)
    const track = { trackLeft: 0, trackRight: 1280, pad: 0, gap: 0 };
    expect(bannerAway({ ...track, rtl: false, left: 0, right: 1280 })).toBe(0);
    expect(bannerAway({ ...track, rtl: false, left: 640, right: 1920 })).toBe(0.5);
    expect(bannerAway({ ...track, rtl: false, left: -1280, right: 0 })).toBe(-1);
    expect(bannerAway({ ...track, rtl: false, left: 3840, right: 5120 }), "clamped to one banner").toBe(1);
    // right to left: the next banner waits at the LEFT (the end) — never mirrored the wrong way round
    expect(bannerAway({ ...track, rtl: true, left: 0, right: 1280 })).toBe(0);
    expect(bannerAway({ ...track, rtl: true, left: -640, right: 640 })).toBe(0.5);
    expect(bannerAway({ ...track, rtl: true, left: 1280, right: 2560 })).toBe(-1);
    // a phone: 315px banners, 12px apart, resting 16px in from the track's start (its scroll padding); the next one peeks
    const phone = { trackLeft: 0, trackRight: 390, pad: 16, gap: 12 };
    expect(bannerAway({ ...phone, rtl: true, left: 59, right: 374 })).toBe(0);
    expect(bannerAway({ ...phone, rtl: true, left: -268, right: 47 })).toBe(1);
    expect(bannerAway({ ...phone, rtl: false, left: 343, right: 658 })).toBe(1);
    // the LAST banner of a phone's track rests at the track's end (the track scrolls no further): in view there, words
    // and all — measured from where the scroll can bring it, never from the start's padding (its words showed at 73%)
    const end = { ...phone, scroll: 1635, maxScroll: 1635 };
    expect(bannerAway({ ...end, rtl: true, left: 16, right: 331 })).toBe(0);
    expect(bannerAway({ ...end, rtl: false, left: 59, right: 374 })).toBe(0);
    // …and the one before it, on the start side: as far as the last scroll step really is (284px of a 327px step)
    expect(bannerAway({ ...end, rtl: true, left: 343, right: 658 })).toBeCloseTo(-284 / 327);
    // on its way there (scrolled 100px short of the end) it is 100px — of a 327px step — from its rest
    expect(bannerAway({ ...end, scroll: 1535, rtl: true, left: -84, right: 231 })).toBeCloseTo(100 / 327);
    // a snapped track rests on whole pixels, the boxes on fractions: a banner a pixel off is at rest (no drift)
    expect(bannerAway({ ...phone, rtl: true, left: 58.6, right: 373.4 })).toBe(0);
    expect(bannerAway({ ...track, rtl: false, left: 1.2, right: 1281.2 })).toBe(0);
    // how much of the words show follows how much of their column is on screen: a banner enters words first in Arabic
    // (its copy is at its start, it comes in from the end), so a fade tied to its distance left the part on screen
    // blank for most of the move — whole words once the column is in, none while half of it or less is (the phone's
    // peeking banner: 47 of its 173px), a fade between
    expect(wordsShown(1)).toBe(1);
    expect(wordsShown(0.75)).toBeCloseTo(0.5);
    expect(wordsShown(0.5)).toBe(0);
    expect(wordsShown(47 / 173)).toBe(0);
    expect(wordsShown(0)).toBe(0);
    // the column's share on screen (screen boxes: left and right edges)
    expect(inView({ left: 100, right: 300, trackLeft: 0, trackRight: 1280 })).toBe(1);
    expect(inView({ left: -100, right: 100, trackLeft: 0, trackRight: 1280 })).toBe(0.5);
    expect(inView({ left: 1230, right: 1430, trackLeft: 0, trackRight: 1280 })).toBe(0.25);
    expect(inView({ left: 1300, right: 1500, trackLeft: 0, trackRight: 1280 })).toBe(0);
    expect(inView({ left: 10, right: 10, trackLeft: 0, trackRight: 1280 }), "no width: nothing to show").toBe(0);
  });

  it("offers in the icon strip only the departments that exist, each to its real listing", () => {
    const categories = [
      { kind: "consoles", href: "/c/consoles", count: 18 },
      { kind: "games", href: "/c/games", count: 34 },
      { kind: "controllers", href: "/c/controllers", count: 0 },
      { kind: "headsets", href: "/c/headsets", count: 8 },
      { kind: "digital", href: "/c/digital-cards", count: 6 },
      { kind: "storage", href: "/c/storage", count: 7 },
    ];
    expect(stripItems(categories, 6)).toEqual([
      { key: "devices", href: "/c/consoles", icon: "kind-console" },
      { key: "games", href: "/c/games", icon: "kind-game" },
      { key: "headsets", href: "/c/headsets", icon: "kind-headset" },
      { key: "topup", href: "/c/digital-cards", icon: "kind-topup" },
      { key: "used", href: "/used", icon: "kind-used" },
      { key: "repair", href: "/support/repair", icon: "kind-repair" },
    ]);
    // no used units listed: no «المستعمل» door; the repair booking is a service and always there
    expect(stripItems([], 0)).toEqual([{ key: "repair", href: "/support/repair", icon: "kind-repair" }]);
  });

  it("gives a platform tile another view of the product the hero already shows (v2 §7.6)", () => {
    const other = otherView("nintendo-switch-2--1", "nintendo-switch-2--1");
    expect(other).not.toBe("nintendo-switch-2--1");
    const photo = productPhotos("nintendo-switch-2").find((entry) => entry.key === other);
    expect(photo?.transparent).toBe(true);
    expect(["angle", "in-box"]).toContain(photo?.kind);
    expect(otherView("xbox-series-x--1", "nintendo-switch-2--1")).toBe("xbox-series-x--1");
    expect(otherView(null, "nintendo-switch-2--1")).toBeNull();
  });

  it("links the hero to the device hub named like its product, else nowhere", () => {
    const devices = [
      { label: "Nintendo Switch 2", href: "/device/switch-2" },
      { label: "Nintendo Switch – OLED Model", href: "/device/switch-oled" },
    ];
    expect(deviceHubFor("Nintendo  switch 2", devices)).toBe("/device/switch-2");
    expect(deviceHubFor("Nintendo Switch 2 + Mario Kart World Bundle", devices)).toBeNull();
  });

  it("labels a release with its platforms: one platform's dot and its card's words, or every platform named — never one platform's dot for several", () => {
    expect(releasePlatformOf({ platformSlug: "xbox", kindLabel: "جهاز Xbox Series X|S" })).toEqual({ platform: "xbox", platforms: null, label: "جهاز Xbox Series X|S" });
    expect(releasePlatformOf({ platformSlug: null, forPlatforms: ["playstation"], kindLabel: "سماعة · PS5" })).toEqual({ platform: "playstation", platforms: null, label: "سماعة · PS5" });
    // a game for PS5 and Xbox: both dots and both names (the band names them; «لعبة متعددة المنصات» names neither)
    expect(releasePlatformOf({ platformSlug: null, forPlatforms: ["playstation", "xbox"], kindLabel: "لعبة متعددة المنصات" })).toEqual({ platform: "playstation", platforms: ["playstation", "xbox"], label: null });
    expect(releasePlatformOf({ platformSlug: "pc" })).toEqual({ platform: null, platforms: null, label: null });
  });

  it("gives every release on the band its platform line — a dated later version is that version's platform's (QA 2026-11-12)", () => {
    const image = { artKey: "forza-horizon-6--1", mediaKey: null, alt: "", isIllustration: false };
    const base = { key: "prd_forza-horizon-6:2027-01-26", slug: "forza-horizon-6", name: "Forza Horizon 6", releaseAt: Date.UTC(2027, 0, 25, 21), priceIqd: 89_250, image };
    const words = (count: number) => (count === 1 ? "نسخة جديدة" : `${count} نسخ جديدة`);
    // the PS5 version of a game that is out on Xbox: the PlayStation line, «نسخة جديدة» under the name, never in it
    const version = releaseItemOf({ ...base, variantCount: 1, platformSlug: "playstation", forPlatforms: ["playstation"], kindLabel: "لعبة PlayStation" }, words);
    expect(version).toMatchObject({ id: base.key, to: "/p/forza-horizon-6", name: "Forza Horizon 6", detail: "نسخة جديدة", platform: "playstation", platformLabel: "لعبة PlayStation" });
    // a pre-order for two platforms: both named, no detail
    const both = releaseItemOf({ ...base, key: "prd_grand-theft-auto-vi", slug: "grand-theft-auto-vi", name: "Grand Theft Auto VI", variantCount: 0, platformSlug: null, forPlatforms: ["playstation", "xbox"], kindLabel: "لعبة متعددة المنصات" }, words);
    expect(both).toMatchObject({ name: "Grand Theft Auto VI", detail: null, platform: "playstation", platforms: ["playstation", "xbox"] });
    expect(both.platformLabel).toBeUndefined();
    // the demo catalogue: every coming item for a store platform carries its line, versions included
    expect(home.comingSoon.some((item) => item.variantCount > 0)).toBe(true);
    for (const item of home.comingSoon.filter((entry) => entry.forPlatforms.some((slug) => (PLATFORMS as readonly string[]).includes(slug)))) {
      const shown = releaseItemOf(item, words);
      expect(shown.platform, item.key).toBeTruthy();
      expect(shown.name, item.key).toBe(item.name);
    }
  });

  it("keeps a final «ى» / «ی» after a beh- or feh-shaped letter out of Plex's bowl ligature, so «حتى» never reads «حق» (QA 2026-11-12)", () => {
    const ZWJ = "‍";
    expect(plainFinalYeh("256GB · شاشة 7.9 بوصة بدقة 1080p · حتى 4K على التلفاز")).toBe(`256GB · شاشة 7.9 بوصة بدقة 1080p · حت${ZWJ}ى 4K على التلفاز`);
    expect(plainFinalYeh("متى · معنى · فى")).toBe(`مت${ZWJ}ى · معن${ZWJ}ى · ف${ZWJ}ى`);
    // Sorani: the same bowl on a final «ی» («کاتی» read «کاق»); a «ی» inside a word stays as it is
    expect(plainFinalYeh("پارەدان لە کاتی وەرگرتن")).toBe(`پارەدان لە کات${ZWJ}ی وەرگرتن`);
    expect(plainFinalYeh("بینی")).toBe(`بین${ZWJ}ی`);
    // letters that do not join forward, other finals, lam-alef and Latin are left alone; the text reads back the same
    for (const text of ["على", "إلى", "الأعلى", "هەموو", "لاسلكي", "في", "Nintendo Switch 2", ""]) expect(plainFinalYeh(text)).toBe(text);
    expect(plainFinalYeh("حتى متى").replaceAll(ZWJ, "")).toBe("حتى متى");
  });

  it("hands the focus back to the key that opened the intro, else to the page's main landmark — never <body> (QA 2026-11-12)", () => {
    const body = { id: "body" };
    const main = { id: "main" };
    const host = { id: "intro" };
    const skip = { id: "intro skip" };
    const replay = { id: "«شاهد المقدّمة مرة أخرى»" };
    const inIntro = (element: { id: string }) => element === host || element === skip;
    // Escape or «تخطَّ» on a first landing: nothing opened the overlay, so the focus fell to <body> or stayed on it
    expect(focusAfterIntro(body, body, inIntro, null, main)).toBe(main);
    expect(focusAfterIntro(skip, body, inIntro, null, main)).toBe(main);
    expect(focusAfterIntro(null, body, inIntro, null, main)).toBe(main);
    // replayed from the personal panel: back to that key — also when the focus was left on the leaving overlay (React's
    // commit put it back on the intro after the modal layer had returned it)
    expect(focusAfterIntro(host, body, inIntro, replay, main)).toBe(replay);
    expect(focusAfterIntro(body, body, inIntro, replay, main)).toBe(replay);
    // something on the page holds the focus already (the layer's own return worked): leave it there
    expect(focusAfterIntro(replay, body, inIntro, replay, main)).toBeNull();
    expect(focusAfterIntro(body, body, inIntro, null, null)).toBeNull();
  });

  it("reads release days as midnight in Baghdad, on the server and in the browser alike", () => {
    for (const day of ["2026-11-19", "2027-02-04", "2025-06-05"]) {
      expect(baghdadDay(day)).toBe(baghdadMidnight(day));
      expect(new Date(baghdadDay(day)!).toISOString().slice(11, 16)).toBe("21:00");
    }
    expect([baghdadDay("19/11/2026"), baghdadDay(null), baghdadMidnight("")]).toEqual([null, null, null]);
    expect(daysSinceRelease("2026-11-01", Date.UTC(2026, 10, 11, 12))).toBe(10);
  });
});

// ───────────────────────────────────────────────────────────────── the hero carousel, as the server renders it

describe("the hero carousel in the server's markup (client note 1; brief §5: CLS 0, the first photo eager)", () => {
  /** The page's banners from the demo catalogue, as home.tsx builds them (no device hubs, no pins). */
  const slidesOf = async (data: HomeData): Promise<HeroSlide[]> => {
    const { isPlatform } = await import("~/ui/PlatformLed");
    const plan = heroSlides(data.platforms, (entry) => (entry.hero ? data.cards[entry.hero.productId]?.image.artKey : null), { usedArt: data.used.map((unit) => unit.image.artKey) });
    return plan.flatMap((entry): HeroSlide[] => {
      if (entry.kind !== "platform") return [entry];
      const { platform } = entry;
      const card = platform.hero ? data.cards[platform.hero.productId] : undefined;
      if (!card || !platform.hero || !isPlatform(platform.slug)) return [];
      return [{ kind: "product" as const, key: platform.slug, card, platform: platform.slug, mode: platform.hero.mode, pin: null, deviceHref: null, demoPrice: card.isDemo }];
    });
  };
  const render = async (data: HomeData, locale: Locale) => {
    const { HeroCarousel } = await import("~/routes/storefront/home/Hero");
    const slides = await slidesOf(data);
    const Page: ComponentType = () => createElement(HeroCarousel, { slides });
    const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "*", Component: Page }] }]);
    const html = renderToStaticMarkup(
      createElement(Stub, {
        // the splat route needs a segment to match; the locale comes from the root's data
        initialEntries: [localePath("/hero", locale)],
        hydrationData: { loaderData: { root: { locale, dir: LOCALES[locale].dir, fx: null, i18n: messagesFor(locale, "ui", "ui-shop") }, page: { i18n: messagesFor(locale, "home") } } },
      }),
    );
    return { html, slides };
  };

  it("renders every banner with its words, a group «n من N» each — swiping works before and without JavaScript", async () => {
    const { html, slides } = await render(home, "ar");
    expect(slides.length).toBe(home.platforms.length + 1 + (home.used.length > 0 ? 1 : 0));
    expect(html).toContain('aria-roledescription="عرض شرائح"');
    expect(html).toContain('aria-label="أبرز ما في المتجر"');
    expect(html.match(/data-carousel-slide="\d+"/g)).toHaveLength(slides.length);
    expect(html.match(/<h2[\s>]/g)).toHaveLength(slides.length);
    for (let i = 1; i <= slides.length; i++) expect(html).toContain(`aria-label="${i} من ${slides.length}"`);
    // nothing is inert, nothing counts down before the page is live
    expect(html).not.toMatch(/\sinert(=|\s|>)/);
    expect(html).not.toContain("data-run");
    // the trade-in banner says what an estimate is (the final price after the inspection)
    const strings = messagesFor("ar", "home").home as unknown as { hero: { tradeIn: { text: string } } };
    expect(html.replaceAll("‍", "")).toContain(strings.hero.tradeIn.text);
  });

  it("loads only the first banner's photo with the page (eager, high priority); every other photo stays lazy in the markup", async () => {
    for (const locale of ["ar", "en"] as const) {
      const { html } = await render(locale === "ar" ? home : homeEn, locale);
      const imgs = html.match(/<img\b[^>]*>/g) ?? [];
      expect(imgs.length).toBeGreaterThanOrEqual(home.platforms.length);
      expect(imgs[0]).toMatch(/loading="eager"/);
      expect(imgs[0]).toMatch(/fetchpriority="high"/i);
      for (const img of imgs.slice(1)) {
        expect(img, locale).toMatch(/loading="lazy"/);
        expect(img, locale).not.toMatch(/fetchpriority="high"/i);
      }
    }
  });
});

describe("the home page's stylesheet: laptops' first screen, dark glass, the phone's service banners (fix-browse 2026-11-13)", () => {
  const css = readFileSync(new URL("../app/routes/storefront/home/home.css", import.meta.url), "utf8");
  /** Every rule for `selector` inside the `@media <media> { … }` blocks (brace-matched), joined; "" — the file's rules outside them too. */
  const block = (media: string, selector: string): string => {
    const found: string[] = [];
    const scan = (body: string) => {
      for (let at = body.indexOf(`${selector} {`); at !== -1; at = body.indexOf(`${selector} {`, at + 1)) found.push(body.slice(at, body.indexOf("}", at)));
    };
    if (!media) scan(css);
    else
      for (let start = css.indexOf(`${media} {`); start !== -1; start = css.indexOf(`${media} {`, start + 1)) {
        let depth = 0;
        let end = css.indexOf("{", start);
        for (let i = end; i < css.length; i++) {
          if (css[i] === "{") depth++;
          else if (css[i] === "}" && --depth === 0) {
            end = i;
            break;
          }
        }
        scan(css.slice(start, end));
      }
    expect(found.length, `${media} ${selector}`).toBeGreaterThan(0);
    return found.join("\n");
  };

  // lead decision 2: the top of the platform tiles shows on a 1440 × 900 first screen (they started at 919px behind a
  // 116px row of tiles and a 72px gap; measured 815px now)
  it("from 1024 the icon strip is one row of 48px clay pills, the kind icon beside the name, and the platform tiles follow it closely", () => {
    const laptop = "@media (min-width: 64rem)";
    const pill = block(laptop, ".home-strip .shell-itile");
    expect(pill).toMatch(/flex-direction:\s*row/);
    expect(pill).toMatch(/min-block-size:\s*48px/);
    expect(pill).toMatch(/border-radius:\s*var\(--r-full\)/);
    expect(block(laptop, ".home-strip .shell-itile__ico > svg")).toMatch(/inline-size:\s*20px/);
    expect(block(laptop, ".home-strip .shell-itile__name")).toMatch(/white-space:\s*nowrap/);
    expect(block(laptop, ".home-top + .home-platforms")).toMatch(/margin-block-start:\s*calc\(var\(--s-8\) - var\(--gap-section\)\)/);
    // the phones' strip keeps its tiles
    expect(block("", ".home-strip__list")).toMatch(/grid-auto-columns:\s*96px/);
  });

  // client note 3: on the plain dark floor the strip's tiles read as flat grey cards
  it("dark: the strip's tiles are glass — a brighter veil and rim, the banner's light spilling under them, a red light behind each icon", () => {
    const glass = block("", '[data-theme="dark"] .home-strip');
    expect(glass).toMatch(/--card-veil:\s*color-mix\(in oklab, var\(--on-color\) 10%, transparent\)/);
    expect(glass).toMatch(/--card-face:/);
    expect(block("", '[data-theme="dark"] .home-strip .shell-itile__ico::before')).toMatch(/radial-gradient/);
    // the spill is the dark theme's only (display none elsewhere), crossfades with the banner, and fades out inside its box
    expect(block("", ".home-hero__spill")).toMatch(/display:\s*none/);
    const spill = block("", '[data-theme="dark"] .home-hero__spill');
    expect(spill).toMatch(/display:\s*block/);
    const [rx, ry] = (/--glow-size:\s*(\d+)% (\d+)%/.exec(spill) ?? []).slice(1).map(Number);
    const y = Number(/--glow-y:\s*(\d+)%/.exec(spill)?.[1]);
    expect(rx * 0.72, "the ellipse ends inside its box's sides").toBeLessThanOrEqual(50);
    expect(y + ry * 0.72, "and above its foot").toBeLessThanOrEqual(100);
    // the strip paints over the light (the hero is a stacking context of its own)
    expect(block("", ".home-strip")).toMatch(/position:\s*relative/);
  });

  // the service banners' picture sat 70px wide in the top corner, the lower 40% of the banner empty
  it("phones: a service banner's console stands over everything above the key's row, at the far end — never under its white key", () => {
    const phone = "@media (max-width: 47.99rem)";
    const service = '.home-slide:is([data-kind="tradeIn"], [data-kind="used"])';
    expect(block(phone, `${service} .home-slide__body`)).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
    expect(block(phone, `${service} .home-slide__media`)).toMatch(/grid-row:\s*1 \/ 3/);
    expect(block(phone, `${service} .home-slide__buy`)).toMatch(/grid-row:\s*3/);
    expect(block(phone, `${service} .home-slide__shared`)).toMatch(/place-items:\s*end end/);
  });
});
