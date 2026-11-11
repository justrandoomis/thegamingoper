/**
 * The home page's data and rules (app/server/services/home.server.ts, app/routes/storefront/home/{personal,view}.ts)
 * against a real, throw-away D1 with the demo catalogue. Expectations are derived from the database (platform order,
 * device-model order, stock states, release dates), not from product slugs, so they hold when the catalogue changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductCardData } from "~/lib/dto";
import { seedDemo } from "~/server/db/seed/demo";
import { isAppError } from "~/server/errors";
import { getCardsByIds, getDeals, getUsedSpotlight } from "~/server/services/catalog/cards.server";
import {
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
import { baghdadDay, gearFor, headlineEm, resolveFocus } from "~/routes/storefront/home/view";
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
    expect(empty).toEqual({ platforms: [], cards: {}, deals: [], used: [], comingSoon: [] });
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
        (row) => row.platform === platform.slug && row.status !== "discontinued" && l10n(row.name).en === l10n(row.model).en && isBuyable(cards.get(row.id)),
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
       WHERE p.status = 'published' AND p.kind = 'console' AND json_extract(p.name, '$.en') = json_extract(dm.name, '$.en')
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

  it("lights the platform the URL asks for, else the shopper's saved one, else the first with a hero", () => {
    const platforms = [
      { slug: "nintendo", hero: null, newArrivals: [], gear: [] },
      { slug: "playstation", hero: {}, newArrivals: [], gear: [] },
      { slug: "xbox", hero: {}, newArrivals: [], gear: [] },
    ];
    expect(resolveFocus("xbox", platforms, [])).toBe("xbox");
    expect(resolveFocus("nintendo", platforms, [])).toBe("nintendo");
    expect(resolveFocus("sega", platforms, ["nintendo", "xbox"])).toBe("xbox");
    expect(resolveFocus(null, platforms, [])).toBe("playstation");
    expect(resolveFocus(null, [{ slug: "handheld", hero: null, newArrivals: [], gear: [] }], [])).toBe("handheld");
    expect(resolveFocus(null, [], [])).toBeNull();
  });

  it("composes the accessories shelf from the chosen platforms in turns, without new arrivals", () => {
    const platforms = [
      { slug: "playstation", hero: {}, newArrivals: ["n1"], gear: ["p1", "n1", "p2", "p3"] },
      { slug: "xbox", hero: {}, newArrivals: [], gear: ["x1", "p2", "x2"] },
    ];
    expect(gearFor(platforms, ["playstation", "xbox"], "playstation", 8)).toEqual(["p1", "x1", "p2", "x2", "p3"]);
    expect(gearFor(platforms, [], "xbox", 2)).toEqual(["x1", "p2"]);
    expect(gearFor(platforms, [], null, 8)).toEqual([]);
  });

  it("estimates headline widths a little above what Kufam measures, never below", () => {
    // measured in Chromium with Kufam 600 (em): the estimate may be up to ~10% wider, never narrower
    const measured: Record<string, number> = {
      "العب على Nintendo Switch 2": 13.96,
      "العب على PlayStation 5 Pro": 13.37,
      "العب على XBOX Series X": 11.81,
      "Play on Steam Deck OLED": 12.82,
      "Nintendo Switch 2": 9.19,
      "Steam Deck OLED": 8.92,
    };
    for (const [text, em] of Object.entries(measured)) {
      expect(headlineEm(text), text).toBeGreaterThanOrEqual(em);
      expect(headlineEm(text), text).toBeLessThanOrEqual(em * 1.12);
    }
    expect(headlineEm("")).toBe(4);
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
