/**
 * Product lists (app/server/services/catalog/listing.server.ts) and the page URL model
 * (app/routes/storefront/catalog/listing-model.ts) against a real local D1 with the demo catalogue.
 *
 * Every expectation is derived from the database or from another service (getCardsByIds, listCards), never from a
 * product slug: the universe agrees with the cards the store shows; platform hubs use the RESEARCHED platforms
 * (multi-platform games and headsets have no platform_id); each filter, facet count, sort and the cursor behave.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterContextProvider, createRoutesStub } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import type { ProductCardData } from "~/lib/dto";
import { LOCALE_CODES, LOCALES, localePath, type Locale } from "~/lib/locales";
import { HubBand } from "~/routes/storefront/catalog/components/Hub";
import {
  FILTER_GROUPS,
  NO_FILTERS,
  PRICE_BANDS,
  activeGroups,
  listChangeHref,
  listingSearch,
  parsePriceInput,
  readListingQuery,
  sameFilters,
  withoutGroup,
  type ListingFilters,
  type ListingSort,
} from "~/routes/storefront/catalog/listing-model";
import { loader as categoryLoader } from "~/routes/storefront/catalog/category";
import { addToCompare, clearCompare, compareAfterAdd, compareHref, readCompare, readCompareThumbs, removeFromCompare, syncCompare } from "~/routes/storefront/catalog/compare-client";
import { arrivalsShelf } from "~/routes/storefront/catalog/list.server";
import { loader as searchLoader } from "~/routes/storefront/catalog/search";
import { requestContextMiddleware } from "~/server/context.server";
import { isAppError } from "~/server/errors";
import { seedDemo } from "~/server/db/seed/demo";
import { getCardsByIds, getNewArrivals, listCards } from "~/server/services/catalog/cards.server";
import { listProducts, loadListingRows, scopePicks, type ListingInput, type ListingScope } from "~/server/services/catalog/listing.server";
import { getNavTaxonomy, invalidateNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
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

let pageIp = 0;
/** Runs a catalog page's loader the way React Router does: the request middleware (context, locale, cookies) first. */
async function pageData<T>(path: string, loader: (args: never) => Promise<T>, params: Record<string, string> = {}): Promise<T> {
  const request = new Request(`http://localhost:5173${path}`, { headers: { "CF-Connecting-IP": `198.51.100.${(pageIp++ % 200) + 1}` } });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let data: T | undefined;
  await requestContextMiddleware({ request, context, url, pattern: path, params } as never, async () => {
    data = await loader({ request, context, params, url, pattern: path } as never);
    return new Response(null);
  });
  return data as T;
}

/** A card shows «جديد» when the read layer says so (badge "new" or isNew). */
const saysNew = (card: Pick<ProductCardData, "badge" | "isNew">) => card.badge === "new" || card.isNew === true;

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

  it("featured is the suggested order «المقترَح»: can be bought now › coming soon (soonest release first) › sold out", async () => {
    const tierOf = (card: ProductCardData) => (card.stock === "preorder" ? 1 : card.stock === "out_of_stock" ? 0 : 2);
    const { rows: universe } = await loadListingRows(t.db, { kind: "all" }, t.now);
    const pub = new Map(universe.map((row) => [row.id, row.pub]));
    for (const scope of [{ kind: "all" }, { kind: "category", slug: "consoles" }, { kind: "category", slug: "games" }] as ListingScope[]) {
      const list = await allPages({ scope, sort: "featured" }, 60);
      const tiers = list.items.map(tierOf);
      for (let i = 1; i < tiers.length; i++) expect(tiers[i], JSON.stringify(scope)).toBeLessThanOrEqual(tiers[i - 1]);
      expect(tiers[0], JSON.stringify(scope)).toBe(2); // the first card can be bought (the old order led with coming soon)
      const soon = list.items.filter((card) => tierOf(card) === 1);
      for (let i = 1; i < soon.length; i++) expect(soon[i].releaseAt!).toBeGreaterThanOrEqual(soon[i - 1].releaseAt!);
      for (const card of soon) expect(card.releaseAt!).toBeGreaterThan(t.now);
      // newest first inside the other tiers (no hub consoles outside a platform hub)
      for (const tier of [2, 0]) {
        const group = list.items.filter((card) => tierOf(card) === tier);
        for (let i = 1; i < group.length; i++) expect(pub.get(group[i].id)!).toBeLessThanOrEqual(pub.get(group[i - 1].id)!);
      }
    }
  });

  it("a platform hub leads with the platform's own consoles that can be bought now, in device-model order, the entry version first", async () => {
    const tierOf = (card: ProductCardData) => (card.stock === "preorder" ? 1 : card.stock === "out_of_stock" ? 0 : 2);
    const model = new Map(
      (await rows<{ id: string; sort: number; slug: string }>("SELECT p.id, dm.sort, dm.slug FROM products p JOIN device_models dm ON dm.id = p.device_model_id")).map((row) => [row.id, row]),
    );
    const own = new Map((await rows<{ id: string; slug: string | null }>("SELECT p.id, pl.slug FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id")).map((row) => [row.id, row.slug]));
    const platforms = await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 1 ORDER BY sort");
    let led = 0;
    for (const { slug } of platforms) {
      const hub = await allPages({ scope: { kind: "platform", slug }, sort: "featured" }, 60);
      const leads = hub.items.filter((card) => tierOf(card) === 2 && card.kind === "console" && own.get(card.id) === slug);
      const head = hub.items.slice(0, leads.length);
      expect(sorted(ids(head)), slug).toEqual(sorted(ids(leads)));
      for (let i = 1; i < head.length; i++) {
        const [a, b] = [model.get(head[i - 1].id)?.sort ?? Infinity, model.get(head[i].id)?.sort ?? Infinity];
        expect(b, `${slug}: ${head[i].slug}`).toBeGreaterThanOrEqual(a);
        if (a === b) expect(head[i].priceIqd, `${slug}: ${head[i].slug}`).toBeGreaterThanOrEqual(head[i - 1].priceIqd);
      }
      // then what can be bought now, then coming soon, then sold out
      const tiers = hub.items.map(tierOf);
      for (let i = 1; i < tiers.length; i++) expect(tiers[i], slug).toBeLessThanOrEqual(tiers[i - 1]);
      if (leads.length > 0) led++;
    }
    expect(led).toBeGreaterThanOrEqual(3);

    // /platform/playstation: the first row (four cards on a desktop, two on a phone) can be bought, and it opens with
    // the console of the first PlayStation device model that is in stock (staff order: PS5 Pro first today)
    const ps = await allPages({ scope: { kind: "platform", slug: "playstation" }, sort: "featured" }, 60);
    expect(ps.items.slice(0, 4).every((card) => tierOf(card) === 2)).toBe(true);
    const buyableConsoles = ps.items.filter((card) => tierOf(card) === 2 && card.kind === "console" && own.get(card.id) === "playstation");
    const firstModel = Math.min(...buyableConsoles.map((card) => model.get(card.id)?.sort ?? Infinity));
    expect(model.get(ps.items[0].id)?.sort).toBe(firstModel);
    expect(ps.items[0].kindLabel).toBe("جهاز PS5");
    const [top] = await rows<{ slug: string }>(
      "SELECT dm.slug FROM device_models dm JOIN platforms pl ON pl.id = dm.platform_id WHERE pl.slug = 'playstation' AND dm.status = 'published' ORDER BY dm.sort LIMIT 1",
    );
    if (buyableConsoles.some((card) => model.get(card.id)?.slug === top.slug)) expect(model.get(ps.items[0].id)?.slug).toBe(top.slug);

    // picks under a zero-result state follow the same order
    const picks = await scopePicks(t.db, "ar", { kind: "platform", slug: "playstation" }, { limit: 3, now: t.now });
    expect(ids(picks)).toEqual(ids(ps.items.filter((card) => tierOf(card) === 2).slice(0, 3)));
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

describe("«وصل حديثاً» shelves on the catalog pages (v2 §4.7: «جديد» never inside that shelf)", () => {
  it("the shelf drops «جديد» from its cards and keeps every other badge", () => {
    const base = (over: Partial<ProductCardData>) => ({ id: "prd_x", badge: null, isNew: false, ...over }) as ProductCardData;
    expect(arrivalsShelf([base({ badge: "new", isNew: true })]).map(saysNew)).toEqual([false]);
    expect(arrivalsShelf([base({ badge: null, isNew: true })]).map(saysNew)).toEqual([false]);
    expect(arrivalsShelf([base({ badge: "deal", isNew: true })])[0].badge).toBe("deal");
    expect(arrivalsShelf([base({ badge: "preorder" })])[0].badge).toBe("preorder");
  });

  it("a search that finds nothing offers new arrivals without «جديد», a shelf's worth of them", async () => {
    // what the read layer hands over: arrivals that do say «جديد» (a shelf of them would repeat its own title)
    const raw = await getNewArrivals(t.db, "ar", { limit: 8, now: Date.now() });
    expect(raw.length).toBeGreaterThanOrEqual(5);
    const page = (await pageData("/search?q=zzzzqqxx", searchLoader as never)) as { result: { total: number } | null; arrivals: ProductCardData[] };
    expect(page.result?.total).toBe(0);
    expect(page.arrivals.length).toBeGreaterThanOrEqual(5);
    expect(page.arrivals.filter(saysNew)).toEqual([]);
  });

  it("«ابحث عنها كما كتبتها»: typed=1 searches the words as typed — a typo finds nothing — and is not counted as a new search", async () => {
    type SearchPage = { q: string; result: { total: number; correctedQuery: string | null } | null };
    const statsOf = async () => (await rows<{ n: number }>("SELECT COALESCE(SUM(searches), 0) AS n FROM search_query_stats WHERE query = 'playstaion'"))[0]?.n ?? 0;
    const corrected = (await pageData("/search?q=playstaion", searchLoader as never)) as SearchPage;
    expect(corrected.result?.correctedQuery).toBe("playstation");
    expect(corrected.result?.total).toBeGreaterThan(0);
    const counted = await statsOf();
    expect(counted).toBeGreaterThan(0);
    const typed = (await pageData("/search?q=playstaion&typed=1", searchLoader as never)) as SearchPage;
    expect(typed.q).toBe("playstaion");
    expect(typed.result?.correctedQuery ?? null).toBeNull();
    expect(typed.result?.total).toBe(0);
    expect(await statsOf()).toBe(counted);
  });

  it("a corrected search says the corrected words as the catalogue writes them («نتائج «Nintendo»»), never the index's folded spelling (fix-browse 2026-11-13)", async () => {
    type SearchPage = { result: { correctedQuery: string | null } | null; corrected: string | null };
    for (const [path, folded, shown] of [
      ["/search?q=nintndo", "nintendo", "Nintendo"],
      ["/en/search?q=nintndo", "nintendo", "Nintendo"],
      ["/ckb/search?q=playstaion", "playstation", "PlayStation"],
    ] as const) {
      const page = (await pageData(path, searchLoader as never)) as SearchPage;
      // the service's words (and the page's links) stay folded; the page says them as the names do
      expect(page.result?.correctedQuery, path).toBe(folded);
      expect(page.corrected, path).toBe(shown);
    }
    // nothing corrected: nothing to say
    expect(((await pageData("/search?q=nintendo", searchLoader as never)) as SearchPage).corrected).toBeNull();
  });

  it("an empty department offers new arrivals without «جديد»", async () => {
    const departments = await rows<{ slug: string }>("SELECT slug FROM categories WHERE is_active = 1 AND kind <> 'used' ORDER BY slug");
    let empty: string | null = null;
    for (const { slug } of departments) {
      const list = await listProducts(t.db, "ar", { scope: { kind: "category", slug }, limit: 1, now: t.now });
      if (list && list.scopeTotal === 0) {
        empty = slug;
        break;
      }
    }
    expect(empty, "the demo catalogue keeps a department without products").not.toBeNull();
    const page = (await pageData(`/c/${empty}`, categoryLoader as never, { category: empty! })) as { arrivals: ProductCardData[] };
    expect(page.arrivals.length).toBeGreaterThanOrEqual(3);
    expect(page.arrivals.filter(saysNew)).toEqual([]);
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

  it("the navigation's device links carry each model's photo (device_models.art_key) — the mega menu's thumbnails — and the platform hub's device shortcuts show the same", async () => {
    invalidateNavTaxonomy(t.db);
    const nav = await getNavTaxonomy(t.db, "en", { now: t.now });
    const models = await rows<{ slug: string; art_key: string | null }>("SELECT slug, art_key FROM device_models WHERE status = 'published'");
    const photoOf = new Map(models.map((model) => [model.slug, model.art_key ?? null]));
    let links = 0;
    for (const platform of nav.platforms) {
      for (const link of platform.devices) {
        links++;
        const slug = link.href.slice("/device/".length);
        expect(photoOf.has(slug)).toBe(true);
        // the model's photo, absent (never null) when it has none — the data owner's menu tests compare links whole
        expect(link.artKey ?? null).toBe(photoOf.get(slug));
        if (photoOf.get(slug) === null) expect("artKey" in link).toBe(false);
      }
      const hub = (await listProducts(t.db, "en", { scope: { kind: "platform", slug: platform.slug }, now: t.now }))!;
      const shortcutPhoto = new Map(hub.hub.devices.map((device) => [device.slug, device.artKey]));
      for (const link of platform.devices) {
        const slug = link.href.slice("/device/".length);
        if (shortcutPhoto.has(slug)) expect(link.artKey ?? null).toBe(shortcutPhoto.get(slug));
      }
    }
    expect(links).toBeGreaterThan(0);
    // every seeded model has a photo: the menu shows pictures, not the glyph
    expect(nav.platforms.flatMap((platform) => platform.devices).every((link) => typeof link.artKey === "string" && /^[a-z0-9-]+--\d+$/.test(link.artKey))).toBe(true);
    // category and product links carry none (a NavCategory's own artKey is its tile photo)
    for (const platform of nav.platforms) for (const link of [...platform.games, ...platform.accessories, ...platform.consoles]) expect(link.artKey).toBeUndefined();
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

  it("remembers names and pictures for the tray, only for the products in the list", () => {
    clearCompare();
    expect(addToCompare({ id: "prd_t1", kind: "console", name: "PlayStation 5 Pro", image: { artKey: "playstation-5-pro--1", mediaKey: null } })).toBe("added");
    expect(addToCompare({ id: "prd_t2", kind: "console" })).toBe("added");
    expect(readCompareThumbs()).toEqual({ prd_t1: { name: "PlayStation 5 Pro", artKey: "playstation-5-pro--1", mediaKey: null } });
    // the compare page knows every product's name and picture
    syncCompare({ kind: "console", ids: ["prd_t1", "prd_t2"], items: [{ id: "prd_t2", name: "Nintendo Switch 2", image: { artKey: "nintendo-switch-2--1", mediaKey: null } }] });
    expect(Object.keys(readCompareThumbs()).sort()).toEqual(["prd_t1", "prd_t2"]);
    removeFromCompare("prd_t1");
    expect(Object.keys(readCompareThumbs())).toEqual(["prd_t2"]);
    // another kind starts a new list: the old pictures go with it
    expect(addToCompare({ id: "prd_t3", kind: "game", name: "Mario Kart World", image: null })).toBe("replaced");
    expect(readCompareThumbs()).toEqual({ prd_t3: { name: "Mario Kart World", artKey: null, mediaKey: null } });
    clearCompare();
    expect(readCompareThumbs()).toEqual({});
  });

  it("the link offered after an add opens the list that add made — another kind: the new list, never the old one", () => {
    // the compare page compares the FIRST product's kind and makes this device's list equal to what it shows, so a
    // link "old ids + the new one" would show the old list and undo the new one
    expect(compareAfterAdd("added", ["prd_a"], "prd_b")).toBe("/compare?ids=prd_a&ids=prd_b");
    expect(compareAfterAdd("replaced", ["prd_a", "prd_b"], "prd_g")).toBe("/compare?ids=prd_g");
    expect(compareAfterAdd("full", ["prd_a", "prd_b", "prd_c", "prd_d"], "prd_e")).toBe("/compare?ids=prd_a&ids=prd_b&ids=prd_c&ids=prd_d");
    expect(compareAfterAdd("present", ["prd_a", "prd_b"], "prd_b")).toBe("/compare?ids=prd_a&ids=prd_b");
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

  it("reads a price as the no-script form sends it — Arabic-Indic or Persian digits, separators, the currency — and writes it back in Western digits", () => {
    expect(readListingQuery(new URLSearchParams("min=٥٠٬٠٠٠&max=١٠٠٠٠٠"))).toMatchObject({ priceMin: 50_000, priceMax: 100_000 });
    expect(readListingQuery(new URLSearchParams("max=۲۵۰۰۰۰")).priceMax).toBe(250_000);
    expect(readListingQuery(new URLSearchParams({ min: "250,000 د.ع" })).priceMin).toBe(250_000);
    expect(listingSearch(readListingQuery(new URLSearchParams("max=١٠٠٠٠٠")))).toBe("?max=100000");
    // still nothing for what is not a whole number of dinars
    expect(readListingQuery(new URLSearchParams("min=99.5&max=abc"))).toMatchObject({ priceMin: null, priceMax: null });
    expect(readListingQuery(new URLSearchParams("min=&max="))).toMatchObject({ priceMin: null, priceMax: null });
  });

  it("knows a link that changes this page's list (held while offline) from one that leaves the page", () => {
    const here = "http://localhost:5173/platform/playstation?cat=games";
    expect(listChangeHref("/platform/playstation?cat=games&stock=1", here)).toBe("/platform/playstation?cat=games&stock=1");
    expect(listChangeHref("?cursor=abc", here)).toBe("/platform/playstation?cursor=abc");
    expect(listChangeHref("/platform/playstation", here)).toBe("/platform/playstation");
    expect(listChangeHref("/platform/playstation?cat=games", here)).toBeNull();
    expect(listChangeHref("#catalog-devices", here)).toBeNull();
    expect(listChangeHref("/p/playstation-5-pro", here)).toBeNull();
    expect(listChangeHref("/en/platform/playstation?cat=games", here)).toBeNull();
    expect(listChangeHref("https://example.com/platform/playstation?cat=consoles", here)).toBeNull();
  });

  it("knows which groups are active, removes one, compares sets", () => {
    const filters: ListingFilters = { ...NO_FILTERS, platforms: ["xbox"], inStock: true, priceMax: 5 };
    expect(activeGroups(filters)).toEqual(["platforms", "price", "inStock"]);
    for (const group of FILTER_GROUPS) expect(activeGroups(withoutGroup(filters, group))).not.toContain(group);
    expect(sameFilters({ ...filters, platforms: ["a", "b"] }, { ...filters, platforms: ["b", "a"] })).toBe(true);
    expect(sameFilters(filters, NO_FILTERS)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── the platform band on phones (catalog review, wave B)

describe("the platform band on phones (v2.1 client note 4, catalog review)", () => {
  const css = readFileSync(new URL("../app/routes/storefront/catalog/catalog.css", import.meta.url), "utf8");
  /**
   * The declarations of `selector` — media "": its first rule in the file (the base rule); else every rule for it inside
   * the `@media <media> { … }` blocks (brace-matched), joined.
   */
  const block = (media: string, selector: string): string => {
    if (!media) {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    }
    const found: string[] = [];
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
      const body = css.slice(start, end);
      for (let at = body.indexOf(`${selector} {`); at !== -1; at = body.indexOf(`${selector} {`, at + 1)) found.push(body.slice(at, body.indexOf("}", at)));
    }
    expect(found.length, `${media} ${selector}`).toBeGreaterThan(0);
    return found.join("\n");
  };
  const lead = "التوصيل 5,000 د.ع لكل المحافظات، والدفع عند الاستلام";

  /** The hub's head as the server renders it, in each language. */
  const renderBand = (locale: Locale, withLead = true) => {
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        children: [
          {
            id: "page",
            path: "*",
            Component: () =>
              createElement(HubBand, { platform: "nintendo", title: "Nintendo", count: "39", lead: withLead ? lead : null, art: "nintendo-switch-2--1", crumbs: [{ label: "home", href: "/" }, { label: "Nintendo" }] }),
          },
        ],
      },
    ]);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: [localePath("/platform/nintendo", locale)],
        hydrationData: { loaderData: { root: { locale, dir: LOCALES[locale].dir, fx: null, i18n: messagesFor(locale, "ui", "ui-shop") }, page: null } },
      }),
    );
  };

  // In the band (72% of its width at 360–390) the two-line delivery line ran into the wide hardware — the Switch 2, the
  // Steam Deck — in every language: on phones the band holds the name and the count; the line is the kit's quiet line
  // right under it (the band's own copy shows from 768, where one line fits beside the hardware).
  it("the delivery line: in the band from 768, the kit's quiet line with its truck under the band on phones — never both at once", () => {
    for (const locale of LOCALE_CODES) {
      const html = renderBand(locale);
      const band = html.indexOf('class="band band--platform');
      const bandEnd = html.indexOf("</header>", band);
      const inBand = html.indexOf('class="catalog-band__lead"', band);
      const note = html.indexOf("catalog-band-note");
      expect(band, locale).toBeGreaterThanOrEqual(0);
      expect(inBand, "the band's own copy (768–1023)").toBeGreaterThan(band);
      expect(inBand).toBeLessThan(bandEnd);
      expect(note, "the quiet line, after the band").toBeGreaterThan(bandEnd);
      expect(html.slice(note - 60, note + 40)).toMatch(/class="note note--line catalog-band-note"/);
      expect(html.split(lead).length - 1, "the same words twice: one copy per width range").toBe(2);
      expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    }
    // no delivery facts (the shell data is missing): no line anywhere
    expect(renderBand("ar", false)).not.toContain("catalog-band-note");
    // the CSS shows one copy per range: the band's below 768 is hidden, the line from 768 is hidden
    expect(block("@media (max-width: 47.99rem)", ".catalog-band__lead")).toMatch(/display:\s*none/);
    expect(block("@media (min-width: 48rem)", ".catalog-head > .catalog-band-note")).toMatch(/display:\s*none/);
    // and from 1024 the shell's strip says it (the band's copy goes too)
    expect(block("@media (min-width: 64rem)", ".catalog-band__lead")).toMatch(/display:\s*none/);
  });

  it("the hardware rises into the air under the header on phones, never into the header (the page's 12px top padding)", () => {
    const media = block("", ".catalog-band__media");
    const rise = Number(/inset-block:\s*-(\d+)px/.exec(media)?.[1] ?? NaN);
    expect(rise).toBeGreaterThan(0);
    expect(rise, "rising 30px, a PS5 crossed the header's foot at 360–390").toBeLessThanOrEqual(12);
    expect(block("", ".catalog-page")).toMatch(/padding-block:\s*var\(--s-3\)/);
  });

  it("at 320 (400% zoom) the name keeps its words whole: the glyph disc gives its room", () => {
    expect(block("@media (max-width: 22.49rem)", ".catalog-band__glyph")).toMatch(/display:\s*none/);
  });

  // lead decision 3 (fix-browse 2026-11-13): the first products start on the first laptop screen — they started at
  // ~790px under a 231px row of 124px device tiles and a 136px band (measured: 622px at 1024–1440 now)
  it("from 1024 the device row is compact: its title and note on one line, 56px clay pills with the picture beside the name; the band 112px", () => {
    const laptop = "@media (min-width: 64rem)";
    expect(block(laptop, ".catalog-devices__head")).toMatch(/display:\s*contents/);
    expect(block(laptop, ".catalog-devices__text")).toMatch(/display:\s*flex/);
    const pill = block(laptop, ".catalog-device.cat");
    expect(pill).toMatch(/min-block-size:\s*56px/);
    expect(pill).toMatch(/grid-template-columns:\s*40px auto/);
    expect(pill).toMatch(/border-radius:\s*var\(--r-full\)/);
    expect(block(laptop, ".catalog-device > .cat__art")).toMatch(/inline-size:\s*40px/);
    expect(block(laptop, ".catalog-band__content")).toMatch(/min-block-size:\s*112px/);
    // phones keep their tiles: nothing of the pill outside the laptop range
    expect(css.indexOf(".catalog-device.cat {")).toBeGreaterThan(css.indexOf(laptop));
  });

  it("phones: the hubs' side notes are reading text (v2.1 G7: 16px / 1.75, they were 14 / 1.5)", () => {
    expect(block("@media (max-width: 47.99rem)", ".catalog-devices__note")).toMatch(/font:\s*var\(--type-read\)/);
  });

  it("the zero-result card's chips wrap, centred, at every width — never a sideways row cut by the card's edge", () => {
    const chips = block("", ".chips.catalog-chips--panel");
    expect(chips).toMatch(/flex-wrap:\s*wrap/);
    expect(chips).toMatch(/justify-content:\s*center/);
    expect(chips).toMatch(/overflow:\s*visible/);
    expect(chips).not.toMatch(/margin-inline:\s*calc\(-/);
  });

  it("compare on phones: 44% product columns that snap, so a third product peeks at the end (two columns filled the card)", () => {
    const phone = "@media (max-width: 47.99rem)";
    expect(block(phone, ".catalog-compare--wide .catalog-compare__table")).toMatch(/inline-size:\s*calc\(var\(--n, 2\) \* 44cqi\)/);
    expect(block(phone, ".catalog-compare--wide")).toMatch(/scroll-snap-type:\s*inline mandatory/);
    expect(block(phone, ".catalog-compare--wide .catalog-compare__product")).toMatch(/scroll-snap-align:\s*start/);
    expect(block("@media (min-width: 48rem)", ".catalog-compare__nav")).toMatch(/display:\s*none/);
  });
});

describe("compare: how many are compared, and which are in view on a phone (fix-browse 2026-11-13)", () => {
  const render = async (locale: Locale, ids: string[]) => {
    const { loader, default: ComparePage } = await import("~/routes/storefront/catalog/compare");
    const query = ids.map((id) => `ids=${id}`).join("&");
    const data = await pageData(`${localePath("/compare", locale)}?${query}`, loader as never);
    const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "*", Component: () => createElement(ComparePage as never, { loaderData: data }) }] }]);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: [`${localePath("/compare", locale)}?${query}`],
        hydrationData: { loaderData: { root: { locale, dir: LOCALES[locale].dir, fx: null, i18n: messagesFor(locale, "ui", "ui-shop") }, page: data } },
      }),
    );
  };
  it("the head says how many products are compared, in every language; three or four get the navigator «تعرض 1–2 من 3», two do not", async () => {
    // three consoles of the demo catalogue (the slugs the store's own compare links use)
    const three = ["playstation-5-pro", "playstation-5-slim", "xbox-series-x"];
    const listed = await rows<{ slug: string }>("SELECT slug FROM products WHERE status = 'published' AND slug IN (?, ?, ?)", ...three);
    expect(listed).toHaveLength(3);
    const ar = await render("ar", three);
    expect(ar).toContain("تقارن 3 منتجات من أجهزة الألعاب");
    expect(ar).toContain("تعرض ⁦1–2⁩ من 3");
    expect(ar).toMatch(/aria-label="المنتجات التالية"/);
    expect((await render("en", three)).replaceAll("&#x27;", "'")).toContain("Comparing 3 products: consoles");
    expect(await render("ckb", three)).toContain("3 بەرهەم بەراورد دەکەیت");
    const two = await render("ar", three.slice(0, 2));
    expect(two).toContain("تقارن منتجين من أجهزة الألعاب");
    expect(two).not.toContain("catalog-compare__nav");
  });
});
