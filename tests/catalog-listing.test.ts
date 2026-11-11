/**
 * Product lists (app/server/services/catalog/listing.server.ts) and the page URL model
 * (app/routes/storefront/catalog/listing-model.ts) against a real local D1 with the demo catalogue.
 *
 * Every expectation is derived from the database or from another service (getCardsByIds, listCards), never from a
 * product slug: the universe agrees with the cards the store shows; platform hubs use the RESEARCHED platforms
 * (multi-platform games and headsets have no platform_id); each filter, facet count, sort and the cursor behave.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductCardData } from "~/lib/dto";
import {
  FILTER_GROUPS,
  NO_FILTERS,
  PRICE_BANDS,
  activeGroups,
  listingSearch,
  parsePriceInput,
  readListingQuery,
  sameFilters,
  withoutGroup,
  type ListingFilters,
  type ListingSort,
} from "~/routes/storefront/catalog/listing-model";
import { addToCompare, clearCompare, compareHref, readCompare, removeFromCompare, syncCompare } from "~/routes/storefront/catalog/compare-client";
import { isAppError } from "~/server/errors";
import { seedDemo } from "~/server/db/seed/demo";
import { getCardsByIds, listCards } from "~/server/services/catalog/cards.server";
import { listProducts, loadListingRows, scopePicks, type ListingInput, type ListingScope } from "~/server/services/catalog/listing.server";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const ids = (cards: { id: string }[]) => cards.map((card) => card.id);
const sorted = (values: string[]) => [...values].sort();

/** Every item of a list, page after page (non-cumulative), checking the total holds. */
async function allPages(input: Omit<ListingInput, "cursor">, limit = 7): Promise<{ items: ProductCardData[]; total: number }> {
  const items: ProductCardData[] = [];
  let cursor: string | null = null;
  let total = -1;
  for (let guard = 0; guard < 100; guard++) {
    const page = await listProducts(t.db, "ar", { ...input, limit, cursor, now: t.now });
    expect(page).not.toBeNull();
    if (total === -1) total = page!.total;
    expect(page!.total).toBe(total);
    items.push(...page!.items);
    if (!page!.nextCursor) break;
    cursor = page!.nextCursor;
  }
  return { items, total };
}

const STOCK = { 0: "out_of_stock", 1: "low_stock", 2: "in_stock" } as const;

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
});

afterAll(async () => {
  await t?.dispose();
});

describe("the universe agrees with the store's cards", () => {
  it("price, reduction and stock state of every published product equal getCardsByIds()", async () => {
    const { rows: universe } = await loadListingRows(t.db, { kind: "all" }, t.now);
    const published = await rows<{ id: string }>("SELECT DISTINCT p.id FROM products p JOIN variants v ON v.product_id = p.id AND v.is_active = 1 WHERE p.status = 'published'");
    expect(universe.length).toBe(published.length);
    expect(universe.length).toBeGreaterThan(100);
    const cards: ProductCardData[] = [];
    for (let i = 0; i < universe.length; i += 100) cards.push(...(await getCardsByIds(t.db, "ar", ids(universe.slice(i, i + 100)), { now: t.now })));
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const row of universe) {
      const card = byId.get(row.id)!;
      expect(card, row.id).toBeDefined();
      expect(row.price, row.id).toBe(card.priceIqd);
      expect(row.compareAt, row.id).toBe(card.compareAtIqd);
      expect(row.kind).toBe(card.kind);
      expect(row.preorder ? "preorder" : STOCK[row.st], row.id).toBe(card.stock);
    }
  });

  it("device fits equal listCards' deviceModel filter for every device model", async () => {
    const { rows: universe } = await loadListingRows(t.db, { kind: "all" }, t.now);
    const models = await rows<{ slug: string }>("SELECT dm.slug FROM device_models dm JOIN platforms pl ON pl.id = dm.platform_id WHERE dm.status = 'published' AND pl.is_active = 1");
    expect(models.length).toBeGreaterThan(20);
    for (const { slug } of models) {
      const viaCards = await listCards(t.db, "ar", { deviceModel: slug, sort: "newest", limit: 60, now: t.now });
      expect(sorted(universe.filter((row) => row.devices.includes(slug)).map((row) => row.id)), slug).toEqual(sorted(ids(viaCards.items)));
    }
  });
});

describe("researched platforms (multi-platform products have no platform_id)", () => {
  it("a platform hub holds its own products AND the multi-platform products researched for it — the same set listCards finds", async () => {
    const platforms = await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 1");
    const multiPlatform = new Set((await rows<{ id: string }>("SELECT id FROM products WHERE platform_id IS NULL AND status = 'published'")).map((row) => row.id));
    expect(multiPlatform.size).toBeGreaterThan(0);
    let multiOnHubs = 0;
    for (const { slug } of platforms) {
      const hub = await allPages({ scope: { kind: "platform", slug } }, 60);
      const own = await listCards(t.db, "ar", { platform: slug, sort: "newest", limit: 60, now: t.now });
      // the read layer and the hub use one platform rule (researchedPlatformSql), so they agree exactly…
      expect(hub.total, slug).toBe(own.total);
      for (const id of ids(own.items)) expect(ids(hub.items), slug).toContain(id);
      multiOnHubs += ids(hub.items).filter((id) => multiPlatform.has(id)).length;
    }
    // …and that set includes the multi-platform products (no platform_id) researched for each platform
    expect(multiOnHubs).toBeGreaterThan(0);
  });

  it("a game sold for PS5 and Xbox is on both hubs; a headset is on the hubs its compatibility allows", async () => {
    const multi = await rows<{ id: string; game: string | null }>(
      "SELECT id, json_extract(attributes, '$.game.platforms') AS game FROM products WHERE platform_id IS NULL AND status = 'published'",
    );
    expect(multi.length).toBeGreaterThan(0);
    const { rows: universe } = await loadListingRows(t.db, { kind: "all" }, t.now);
    const byId = new Map(universe.map((row) => [row.id, row]));
    for (const product of multi) {
      const expected = product.game
        ? (await rows<{ slug: string }>("SELECT DISTINCT pl.slug FROM json_each(?) g JOIN device_models dm ON dm.slug = g.value JOIN platforms pl ON pl.id = dm.platform_id AND pl.is_active = 1", product.game)).map((r) => r.slug)
        : (
            await rows<{ slug: string }>(
              "SELECT DISTINCT pl.slug FROM compatibility_rules r JOIN device_models dm ON r.target_type = 'device_model' AND dm.id = r.target_id JOIN platforms pl ON pl.id = dm.platform_id AND pl.is_active = 1 WHERE r.subject_type = 'product' AND r.subject_id = ? AND r.status IN ('verified','partial')",
              product.id,
            )
          ).map((r) => r.slug);
      expect(expected.length, product.id).toBeGreaterThan(0);
      expect(sorted(byId.get(product.id)!.platforms), product.id).toEqual(sorted(expected));
      for (const slug of expected) {
        const hub = await allPages({ scope: { kind: "platform", slug }, filters: { category: null } }, 60);
        expect(ids(hub.items), `${product.id} on ${slug}`).toContain(product.id);
      }
    }
  });

  it("the platform filter on a category uses the same researched platforms", async () => {
    const games = await allPages({ scope: { kind: "category", slug: "games" }, filters: { platforms: ["xbox"] } }, 60);
    const { rows: universe } = await loadListingRows(t.db, { kind: "category", slug: "games" }, t.now);
    expect(sorted(ids(games.items))).toEqual(sorted(universe.filter((row) => row.platforms.includes("xbox")).map((row) => row.id)));
    expect(games.total).toBeGreaterThan(0);
  });

  it("unknown or inactive platforms and categories are not lists", async () => {
    const inactive = await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 0");
    for (const { slug } of inactive) expect(await listProducts(t.db, "ar", { scope: { kind: "platform", slug }, now: t.now })).toBeNull();
    expect(await listProducts(t.db, "ar", { scope: { kind: "platform", slug: "sega" }, now: t.now })).toBeNull();
    expect(await listProducts(t.db, "ar", { scope: { kind: "category", slug: "no-such-category" }, now: t.now })).toBeNull();
  });
});

describe("filters", () => {
  const scope: ListingScope = { kind: "all" };

  it("each filter keeps exactly the products whose facts match", async () => {
    const { rows: universe } = await loadListingRows(t.db, scope, t.now);
    const check = async (filters: Partial<ListingFilters>, keep: (row: (typeof universe)[number]) => boolean) => {
      const list = await allPages({ scope, filters }, 60);
      expect(sorted(ids(list.items)), JSON.stringify(filters)).toEqual(sorted(universe.filter(keep).map((row) => row.id)));
      return list.total;
    };
    expect(await check({ inStock: true }, (row) => row.st > 0)).toBeGreaterThan(0);
    expect(await check({ deals: true }, (row) => row.compareAt !== null)).toBeGreaterThan(0);
    expect(await check({ priceMin: 100_000, priceMax: 250_000 }, (row) => row.price >= 100_000 && row.price <= 250_000)).toBeGreaterThan(0);
    expect(await check({ arabic: "interface" }, (row) => (row.arabic ?? -1) >= 1)).toBeGreaterThan(0);
    expect(await check({ arabic: "voice" }, (row) => row.arabic === 3)).toBeGreaterThan(0);
    expect(await check({ formats: ["disc"] }, (row) => row.format === "disc")).toBeGreaterThan(0);
    expect(await check({ formats: ["cartridge", "game-key-card"] }, (row) => row.format === "cartridge" || row.format === "game-key-card")).toBeGreaterThan(0);
    expect(await check({ category: "games" }, (row) => row.chain.includes("games"))).toBeGreaterThan(0);
    expect(await check({ platforms: ["nintendo", "xbox"] }, (row) => row.platforms.includes("nintendo") || row.platforms.includes("xbox"))).toBeGreaterThan(0);
  });

  it("'unknown' Arabic support is never counted as any level", async () => {
    const unknown = await rows<{ id: string }>("SELECT id FROM products WHERE json_extract(attributes, '$.game.arabic') = 'unknown'");
    expect(unknown.length).toBeGreaterThan(0);
    const any = await allPages({ scope, filters: { arabic: "interface" } }, 60);
    for (const { id } of unknown) expect(ids(any.items)).not.toContain(id);
  });

  it("a category scope includes its sub-categories; the category filter narrows to one branch", async () => {
    const children = await rows<{ slug: string }>("SELECT ch.slug FROM categories ch JOIN categories p ON p.id = ch.parent_id WHERE p.slug = 'games' AND ch.is_active = 1");
    expect(children.length).toBeGreaterThan(1);
    const all = await allPages({ scope: { kind: "category", slug: "games" } }, 60);
    let sum = 0;
    for (const child of children) sum += (await allPages({ scope: { kind: "category", slug: "games" }, filters: { category: child.slug } }, 60)).total;
    expect(sum).toBe(all.total);
  });

  it("invalid filters are refused by the service (the page drops them before)", async () => {
    const attempt = async (input: Partial<ListingInput>) => {
      try {
        await listProducts(t.db, "ar", { scope, now: t.now, ...input } as ListingInput);
        return "ok";
      } catch (error) {
        return isAppError(error, "invalid") ? "invalid" : "other";
      }
    };
    expect(await attempt({ filters: { platforms: ["Not A Slug"] } })).toBe("invalid");
    expect(await attempt({ filters: { priceMin: 500, priceMax: 100 } })).toBe("invalid");
    expect(await attempt({ filters: { priceMin: -1 } })).toBe("invalid");
    expect(await attempt({ sort: "relevance" })).toBe("invalid");
    expect(await attempt({ cursor: "garbage" })).toBe("invalid");
    expect(await attempt({ limit: 0 })).toBe("invalid");
    expect(await attempt({ scope: { kind: "category", slug: "../etc" } })).toBe("invalid");
  });
});

describe("facets", () => {
  it("each option's count is what choosing it would show (the other filters applied)", async () => {
    const filters: Partial<ListingFilters> = { inStock: true };
    const list = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters, now: t.now }))!;
    expect(list.facets.platforms.length).toBeGreaterThan(1);
    for (const option of list.facets.platforms) {
      const chosen = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters: { ...filters, platforms: [option.value] }, now: t.now }))!;
      expect(chosen.total, option.value).toBe(option.count);
    }
    for (const option of list.facets.categories) {
      const chosen = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters: { ...filters, category: option.value }, now: t.now }))!;
      expect(chosen.total, option.value).toBe(option.count);
    }
    for (const option of list.facets.devices.slice(0, 6)) {
      const chosen = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters: { ...filters, device: option.value }, now: t.now }))!;
      expect(chosen.total, option.value).toBe(option.count);
    }
    for (const band of list.facets.priceBands) {
      const chosen = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters: { ...filters, priceMin: band.min, priceMax: band.max }, now: t.now }))!;
      expect(chosen.total).toBe(band.count);
    }
    expect(list.facets.inStock).toBe(list.total);
    const inStockOff = (await listProducts(t.db, "ar", { scope: { kind: "all" }, now: t.now }))!;
    expect(inStockOff.facets.inStock).toBe(list.total);
  });

  it("'without' says how many products each group's removal would show (the 'All' chip)", async () => {
    const filters: ListingFilters = { ...NO_FILTERS, platforms: ["playstation"], inStock: true, category: "controllers", formats: [] };
    const list = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters, now: t.now }))!;
    for (const group of FILTER_GROUPS) {
      const relaxed = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters: withoutGroup(filters, group), now: t.now }))!;
      expect(list.facets.without[group], group).toBe(relaxed.total);
    }
  });

  it("a platform hub offers the platform's device models and no platform facet", async () => {
    const hub = (await listProducts(t.db, "en", { scope: { kind: "platform", slug: "playstation" }, now: t.now }))!;
    expect(hub.facets.platforms).toEqual([]);
    const models = await rows<{ slug: string }>("SELECT dm.slug FROM device_models dm JOIN platforms pl ON pl.id = dm.platform_id WHERE pl.slug = 'playstation' AND dm.status = 'published'");
    for (const option of hub.facets.devices) expect(models.map((m) => m.slug)).toContain(option.value);
    expect(hub.hub.platform).toEqual(expect.objectContaining({ slug: "playstation" }));
    expect(sorted(hub.hub.devices.map((device) => device.slug))).toEqual(sorted(models.map((m) => m.slug)));
    expect(hub.facets.categories.length).toBeGreaterThan(1);
  });

  it("price bands are the documented ones, only those with products", async () => {
    const list = (await listProducts(t.db, "ar", { scope: { kind: "all" }, now: t.now }))!;
    for (const band of list.facets.priceBands) {
      expect(PRICE_BANDS).toContainEqual({ min: band.min, max: band.max });
      expect(band.count).toBeGreaterThan(0);
    }
  });
});

describe("sorting and the cursor", () => {
  const SORTS: ListingSort[] = ["featured", "newest", "price_asc", "price_desc"];

  it("every sort visits every product once, in order", async () => {
    const { rows: universe } = await loadListingRows(t.db, { kind: "all" }, t.now);
    const byId = new Map(universe.map((row) => [row.id, row]));
    for (const sort of SORTS) {
      const list = await allPages({ scope: { kind: "all" }, sort }, 9);
      expect(list.items.length, sort).toBe(universe.length);
      expect(new Set(ids(list.items)).size).toBe(universe.length);
      const order = list.items.map((card) => byId.get(card.id)!);
      for (let i = 1; i < order.length; i++) {
        const [a, b] = [order[i - 1], order[i]];
        if (sort === "price_asc") expect(a.price).toBeLessThanOrEqual(b.price);
        if (sort === "price_desc") expect(a.price).toBeGreaterThanOrEqual(b.price);
        if (sort === "newest") expect(a.pub).toBeGreaterThanOrEqual(b.pub);
        if (sort === "featured") expect(Number(a.avail)).toBeGreaterThanOrEqual(Number(b.avail));
      }
    }
  });

  it("cumulative pages are the prefix of the list (show more survives a reload)", async () => {
    const first = (await listProducts(t.db, "ar", { scope: { kind: "all" }, sort: "price_asc", limit: 10, now: t.now }))!;
    const second = (await listProducts(t.db, "ar", { scope: { kind: "all" }, sort: "price_asc", limit: 10, cursor: first.nextCursor, cumulative: true, now: t.now }))!;
    expect(second.offset).toBe(0);
    expect(second.items.length).toBe(20);
    expect(ids(second.items).slice(0, 10)).toEqual(ids(first.items));
    const alone = (await listProducts(t.db, "ar", { scope: { kind: "all" }, sort: "price_asc", limit: 10, cursor: first.nextCursor, now: t.now }))!;
    expect(ids(alone.items)).toEqual(ids(second.items).slice(10));
    expect(alone.nextCursor).toBe(second.nextCursor);
  });

  it("a cursor made for another sort is refused", async () => {
    const first = (await listProducts(t.db, "ar", { scope: { kind: "all" }, sort: "price_asc", limit: 5, now: t.now }))!;
    await expect(listProducts(t.db, "ar", { scope: { kind: "all" }, sort: "newest", cursor: first.nextCursor, now: t.now })).rejects.toSatisfy((error) => isAppError(error, "invalid"));
  });
});

describe("zero results and picks", () => {
  it("names each filter whose removal alone shows products, with the count it would show", async () => {
    const filters: Partial<ListingFilters> = { formats: ["cartridge"], platforms: ["xbox"] };
    const list = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters, now: t.now }))!;
    expect(list.total).toBe(0);
    expect(list.relax.length).toBeGreaterThan(0);
    for (const entry of list.relax) {
      const relaxed = (await listProducts(t.db, "ar", { scope: { kind: "all" }, filters: withoutGroup({ ...NO_FILTERS, ...filters }, entry.group), now: t.now }))!;
      expect(relaxed.total).toBe(entry.count);
    }
    expect(list.relax.map((entry) => entry.count)).toEqual([...list.relax.map((entry) => entry.count)].sort((a, b) => b - a));
  });

  it("picks are products of the scope that can be bought now", async () => {
    const picks = await scopePicks(t.db, "ar", { kind: "category", slug: "controllers" }, { limit: 3, now: t.now });
    expect(picks.length).toBe(3);
    const { rows: universe } = await loadListingRows(t.db, { kind: "category", slug: "controllers" }, t.now);
    for (const card of picks) {
      expect(ids(universe as { id: string }[])).toContain(card.id);
      expect(["in_stock", "low_stock"]).toContain(card.stock);
    }
  });
});

describe("hub data", () => {
  it("a sub-category knows its trail and its one platform; a mixed category has none", async () => {
    const child = (await listProducts(t.db, "en", { scope: { kind: "category", slug: "nintendo-games" }, now: t.now }))!;
    expect(child.hub.category).toEqual(expect.objectContaining({ slug: "nintendo-games", platform: "nintendo" }));
    expect(child.hub.category!.trail.map((crumb) => crumb.slug)).toEqual(["games"]);
    const mixed = (await listProducts(t.db, "en", { scope: { kind: "category", slug: "controllers" }, now: t.now }))!;
    expect(mixed.hub.category!.platform).toBeNull();
    expect(mixed.hub.devices.length).toBeGreaterThan(0);
    expect(mixed.hub.devices.length).toBeLessThanOrEqual(8);
    expect(mixed.facets.categories).toEqual([]);
    expect(mixed.facets.platforms.length).toBeGreaterThan(1);
  });
});

describe("compare store (compare-client.ts, exported for the product page and cards)", () => {
  it("holds one kind, at most four, starts a new list for another kind, and builds the URL", () => {
    clearCompare();
    expect(addToCompare({ id: "prd_a", kind: "console" })).toBe("added");
    expect(addToCompare({ id: "prd_a", kind: "console" })).toBe("present");
    expect(addToCompare({ id: "not an id", kind: "console" })).toBe("invalid");
    expect(addToCompare({ id: "prd_b", kind: "console" })).toBe("added");
    expect(addToCompare({ id: "prd_c", kind: "console" })).toBe("added");
    expect(addToCompare({ id: "prd_d", kind: "console" })).toBe("added");
    expect(addToCompare({ id: "prd_e", kind: "console" })).toBe("full");
    expect(readCompare().ids).toEqual(["prd_a", "prd_b", "prd_c", "prd_d"]);
    expect(addToCompare({ id: "prd_g", kind: "game" })).toBe("replaced");
    expect(readCompare()).toEqual({ kind: "game", ids: ["prd_g"] });
    removeFromCompare("prd_g");
    expect(readCompare().ids).toEqual([]);
    expect(compareHref(["prd_a", "prd_b"])).toBe("/compare?ids=prd_a&ids=prd_b");
    expect(compareHref(["bad id!", "prd_a", "prd_b", "prd_c", "prd_d", "prd_e"])).toBe("/compare?ids=prd_a&ids=prd_b&ids=prd_c&ids=prd_d");
    expect(compareHref([])).toBe("/compare");
    syncCompare({ kind: "headset", ids: ["prd_h", "prd_h", "prd_i"] });
    expect(readCompare()).toEqual({ kind: "headset", ids: ["prd_h", "prd_i"] });
    clearCompare();
  });
});

describe("URL model (listing-model.ts)", () => {
  it("reads and writes the URL grammar, dropping what does not parse", () => {
    const query = readListingQuery(
      new URLSearchParams("platform=xbox,playstation&platform=xbox&cat=games&device=ps5-pro&min=300000&max=100000&stock=1&deals=1&arabic=voice&format=disc&format=floppy&sort=price_desc&cursor=abc_-1"),
    );
    expect(query).toEqual({
      platforms: ["xbox", "playstation"],
      category: "games",
      device: "ps5-pro",
      priceMin: 100_000,
      priceMax: 300_000,
      inStock: true,
      deals: true,
      arabic: "voice",
      formats: ["disc"],
      sort: "price_desc",
      cursor: "abc_-1",
    });
    expect(readListingQuery(new URLSearchParams("sort=relevance&min=abc&cat=Bad Slug&arabic=klingon"))).toEqual({ ...NO_FILTERS, sort: null, cursor: null });
    expect(readListingQuery(new URLSearchParams("sort=relevance"), ["relevance", "featured"]).sort).toBe("relevance");
    expect(listingSearch(query, { q: "ps5" })).toBe("?q=ps5&platform=xbox&platform=playstation&cat=games&device=ps5-pro&min=100000&max=300000&stock=1&deals=1&arabic=voice&format=disc&sort=price_desc&cursor=abc_-1");
    expect(listingSearch({ ...NO_FILTERS, sort: null, cursor: null })).toBe("");
    expect(readListingQuery(new URLSearchParams(listingSearch(query).slice(1)))).toEqual(query);
  });

  it("reads a typed price in any digits, never a fraction", () => {
    expect(parsePriceInput("250000")).toBe(250_000);
    expect(parsePriceInput("250,000")).toBe(250_000);
    expect(parsePriceInput("٢٥٠٬٠٠٠ د.ع")).toBe(250_000);
    expect(parsePriceInput("۲۵۰۰۰۰")).toBe(250_000);
    expect(parsePriceInput("250000 IQD")).toBe(250_000);
    expect(parsePriceInput("  ")).toBeNull();
    expect(parsePriceInput("99.5")).toBe("invalid");
    expect(parsePriceInput("-5")).toBe("invalid");
    expect(parsePriceInput("abc")).toBe("invalid");
    expect(parsePriceInput("99999999999")).toBe("invalid");
  });

  it("knows which groups are active, removes one, compares sets", () => {
    const filters: ListingFilters = { ...NO_FILTERS, platforms: ["xbox"], inStock: true, priceMax: 5 };
    expect(activeGroups(filters)).toEqual(["platforms", "price", "inStock"]);
    for (const group of FILTER_GROUPS) expect(activeGroups(withoutGroup(filters, group))).not.toContain(group);
    expect(sameFilters({ ...filters, platforms: ["a", "b"] }, { ...filters, platforms: ["b", "a"] })).toBe(true);
    expect(sameFilters(filters, NO_FILTERS)).toBe(false);
  });
});
