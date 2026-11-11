/**
 * Product lists — category hubs, platform hubs and search results (catalog area; docs/CONTRACTS.md §3, the page
 * grammar in app/routes/storefront/catalog/listing-model.ts).
 *
 *   const list = await listProducts(db, ctx.locale, {
 *     scope: { kind: "platform", slug: "xbox" },                    // or category / products (search) / all
 *     filters: { inStock: true, arabic: "subtitles" },              // any of ListingFilters
 *     sort: "price_asc", cursor, cumulative: true, now: ctx.now,
 *   });
 *   if (!list) throw 404;                                           // the category / platform does not exist
 *   list.items · list.total · list.nextCursor · list.facets · list.relax · list.hub
 *
 * WHY NOT listCards(): the catalogue read layer filters platforms by `products.platform_id`, and multi-platform
 * products (the PS5 + Xbox games, headsets for several consoles) have none. Here a product's platforms are the
 * RESEARCHED ones, exactly as the demo import decides them (app/server/db/seed/demo/import.ts platformsOf):
 *   1. its own platform (`platform_id`) when it has one;
 *   2. else the platforms of the device models in `attributes.game.platforms`;
 *   3. else the platforms of the devices its product-level compatibility rules mark verified or partial.
 * Game facts (`attributes.game.arabic`, `.physicalFormat`) are filters too.
 *
 * HOW (two round trips):
 *   1. One db.batch: the UNIVERSE statement — one compact row per published product in the scope, with the card
 *      variant's price and compare-at price, the stock state (0 out · 1 low · 2 in, the same rules as
 *      cards.server.ts / getAvailability()), the pre-order flag, the publication time, the researched platforms,
 *      the device models it fits (the same "most specific rule wins" logic as listCards' deviceModel filter) and the
 *      game facts — plus the small dictionaries (active categories, platforms, published device models).
 *      The statement is a LINEAR CTE chain (D1 refuses fan-out; see cards.server.ts) with correlated subqueries.
 *   2. getCardsByIds() for the rows of the page — so a card shows exactly what every other card in the store shows.
 *   Filters, facet counts (each group counted with every OTHER filter applied, so a chip says what choosing it
 *   gives), sorting and the keyset cursor run in memory over the universe. That is cheap for a scope of a few hundred
 *   products (this catalogue has 106); a scope of many thousands would want facets in SQL (docs/areas/catalog.md).
 *
 * PRIVACY: nothing here selects cost, margin, serials or stock quantities; only the state 0/1/2 leaves SQL.
 * Services take `db` first and never import "cloudflare:workers".
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Paged, ProductCardData, ProductKind } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import {
  ARABIC_LEVELS,
  ARABIC_RANK,
  FILTER_GROUPS,
  LISTING_PAGE_SIZE,
  MAX_COMPARE,
  MAX_CUMULATIVE,
  MAX_PLATFORM_FILTERS,
  MAX_PRICE_IQD,
  NO_FILTERS,
  PHYSICAL_FORMATS,
  PRICE_BANDS,
  SEARCH_SORTS,
  arabicLevelRank,
  isActive,
  type DeviceShortcut,
  type FilterGroup,
  type ListingFacets,
  type ListingFilters,
  type ListingSort,
  type PhysicalFormat,
} from "~/routes/storefront/catalog/listing-model";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { invalid, zodFieldErrors } from "~/server/errors";
import { DEFAULT_LOW_STOCK } from "~/server/services/inventory/stock.server";
import { getCardsByIds, MAX_CARD_IDS } from "./cards.server";

export {
  ARABIC_LEVELS,
  FILTER_GROUPS,
  LISTING_PAGE_SIZE,
  LISTING_SORTS,
  MAX_CUMULATIVE,
  NO_FILTERS,
  PHYSICAL_FORMATS,
  SEARCH_SORTS,
} from "~/routes/storefront/catalog/listing-model";
export type { ArabicLevel, DeviceShortcut, FacetOption, FilterGroup, ListingFacets, ListingFilters, ListingSort, PhysicalFormat } from "~/routes/storefront/catalog/listing-model";

/** Most product ids a "products" scope may name (a search's matches). */
export const MAX_SCOPE_IDS = 2_000;

// ───────────────────────────────────────────────────────────────── input

/**
 * What to list.
 *   category — a category and its active sub-categories (404 when the category or an ancestor is inactive)
 *   platform — every product researched for the platform (404 when the platform is unknown or inactive)
 *   products — these product ids (a search's matches); `rank` orders them for sort "relevance" (smaller = better,
 *              compared position by position)
 *   all      — the whole published catalogue
 */
export type ListingScope =
  | { kind: "category"; slug: string }
  | { kind: "platform"; slug: string }
  | { kind: "products"; ids: readonly string[]; rank?: ReadonlyMap<string, readonly number[]> }
  | { kind: "all" };

export type ListingInput = {
  scope: ListingScope;
  filters?: Partial<ListingFilters>;
  /** Default "featured" ("relevance" when the scope carries a rank). "relevance" needs a ranked products scope. */
  sort?: ListingSort | null;
  cursor?: string | null;
  /** Page size, 1 … 60 (default LISTING_PAGE_SIZE). */
  limit?: number;
  /**
   * Return every row from the first one through the page after `cursor` — "show more" that survives a reload and
   * Back without client state. Past MAX_CUMULATIVE rows the page comes on its own (`offset` > 0).
   */
  cumulative?: boolean;
  /** Request time (ctx.now): decides "pre-order". Default Date.now(). */
  now?: number;
};

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const slug = z.string().trim().min(1, "invalid").max(80, "invalid").regex(SLUG, "invalid");
const price = z.number().int("invalid").min(0, "invalid").max(MAX_PRICE_IQD, "invalid");

const FiltersSchema = z.object({
  platforms: z.array(slug).max(MAX_PLATFORM_FILTERS, "invalid").default([]),
  category: slug.nullable().default(null),
  device: slug.nullable().default(null),
  priceMin: price.nullable().default(null),
  priceMax: price.nullable().default(null),
  inStock: z.boolean().default(false),
  deals: z.boolean().default(false),
  arabic: z.enum(ARABIC_LEVELS).nullable().default(null),
  formats: z.array(z.enum(PHYSICAL_FORMATS)).max(PHYSICAL_FORMATS.length, "invalid").default([]),
});

const InputSchema = z.object({
  sort: z.enum(SEARCH_SORTS).nullable().optional(),
  cursor: z.string().max(512, "invalid").nullable().optional(),
  limit: z.number().int("invalid").min(1, "invalid").max(60, "invalid").optional(),
  cumulative: z.boolean().optional(),
  now: z.number().int("invalid").min(0, "invalid").optional(),
});

function parseInput(input: ListingInput): { scope: ListingScope; filters: ListingFilters; sort: ListingSort; cursor: string | null; limit: number; cumulative: boolean; now: number } {
  const scope = input.scope;
  const scopeOk =
    !!scope &&
    (scope.kind === "all" ||
      ((scope.kind === "category" || scope.kind === "platform") && slug.safeParse(scope.slug).success) ||
      (scope.kind === "products" && Array.isArray(scope.ids) && scope.ids.length <= MAX_SCOPE_IDS && scope.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)));
  if (!scopeOk) throw invalid({ scope: "invalid" }, "catalog.listing");
  const filters = FiltersSchema.safeParse(input.filters ?? {});
  if (!filters.success) throw invalid(zodFieldErrors(filters.error), "catalog.listing");
  const rest = InputSchema.safeParse({ sort: input.sort, cursor: input.cursor, limit: input.limit, cumulative: input.cumulative, now: input.now });
  if (!rest.success) throw invalid(zodFieldErrors(rest.error), "catalog.listing");
  const ranked = scope.kind === "products" && !!scope.rank;
  const sort = rest.data.sort ?? (ranked ? "relevance" : "featured");
  if (sort === "relevance" && !ranked) throw invalid({ sort: "invalid" }, "catalog.listing");
  const parsed = filters.data;
  if (parsed.priceMin !== null && parsed.priceMax !== null && parsed.priceMin > parsed.priceMax) throw invalid({ priceMin: "invalid" }, "catalog.listing");
  return {
    scope,
    filters: { ...parsed, platforms: [...new Set(parsed.platforms)], formats: [...new Set(parsed.formats)] },
    sort,
    cursor: rest.data.cursor ?? null,
    limit: rest.data.limit ?? LISTING_PAGE_SIZE,
    cumulative: rest.data.cumulative ?? false,
    now: rest.data.now ?? Date.now(),
  };
}

// ───────────────────────────────────────────────────────────────── SQL

/** Free units of one variant over sellable, active locations (the same expression as cards.server.ts). */
const freeUnits = (variantId: SQL, alias: string): SQL => {
  const sl = sql.raw(`${alias}s`);
  const loc = sql.raw(`${alias}l`);
  return sql`(SELECT SUM(MAX(${sl}.on_hand - ${sl}.reserved, 0)) FROM stock_levels AS ${sl} JOIN inventory_locations AS ${loc} ON ${loc}.id = ${sl}.location_id WHERE ${sl}.variant_id = ${variantId} AND ${loc}.is_sellable = 1 AND ${loc}.is_active = 1)`;
};

/**
 * Condition on `platforms AS pl`: the platform is one the product (alias `p`) is researched for — see the header.
 * Malformed `attributes` JSON counts as "no game facts" instead of failing the statement.
 */
function researchedPlatform(alias: string): SQL {
  const p = sql.raw(alias);
  const gamePlatforms = sql`(CASE WHEN json_valid(${p}.attributes) THEN COALESCE(json_array_length(${p}.attributes, '$.game.platforms'), 0) ELSE 0 END)`;
  return sql`(pl.id = ${p}.platform_id
    OR (${p}.platform_id IS NULL AND ${gamePlatforms} > 0
        AND pl.id IN (SELECT gm.platform_id FROM json_each(${p}.attributes, '$.game.platforms') AS g JOIN device_models AS gm ON gm.slug = g.value))
    OR (${p}.platform_id IS NULL AND ${gamePlatforms} = 0
        AND pl.id IN (
          SELECT CASE r.target_type
                   WHEN 'device_model' THEN (SELECT rm.platform_id FROM device_models AS rm WHERE rm.id = r.target_id)
                   WHEN 'generation' THEN (SELECT rg.platform_id FROM device_generations AS rg WHERE rg.id = r.target_id)
                   ELSE r.target_id END
          FROM compatibility_rules AS r
          WHERE r.subject_type = 'product' AND r.subject_id = ${p}.id AND r.status IN ('verified', 'partial'))))`;
}

/**
 * Device models (alias `dm`) a product (alias `c`) fits: it IS the model / is made for it (`device_model_id`), or a
 * subject — the product or one of its active variants — whose MOST SPECIFIC rule for the model (device model ›
 * generation › platform) is verified or partial. The same rule as listCards' deviceModel filter (cards.server.ts):
 * specificity × 10 + weakness, MAX per subject, fits when the remainder is 0 or 1. A missing rule never fits.
 */
const FITS_OF_C = sql`(SELECT json_group_array(dm.slug)
  FROM device_models AS dm JOIN platforms AS dp ON dp.id = dm.platform_id AND dp.is_active = 1
  WHERE dm.status = 'published' AND (
    dm.id = c.device_model_id
    OR EXISTS (
      SELECT 1 FROM compatibility_rules AS r
      WHERE ((r.subject_type = 'product' AND r.subject_id = c.id)
          OR (r.subject_type = 'variant' AND r.subject_id IN (SELECT fv.id FROM variants AS fv WHERE fv.product_id = c.id AND fv.is_active = 1)))
        AND ((r.target_type = 'device_model' AND r.target_id = dm.id)
          OR (r.target_type = 'generation' AND r.target_id = dm.generation_id)
          OR (r.target_type = 'platform' AND r.target_id = dm.platform_id))
      GROUP BY r.subject_type, r.subject_id
      HAVING MAX(CASE r.target_type WHEN 'device_model' THEN 30 WHEN 'generation' THEN 20 ELSE 10 END
               + CASE r.status WHEN 'verified' THEN 0 WHEN 'partial' THEN 1 WHEN 'unverified' THEN 2 ELSE 3 END) % 10 <= 1)))`;

function scopeSql(scope: ListingScope): { ctes: SQL[]; where: SQL } {
  switch (scope.kind) {
    case "category":
      return {
        ctes: [
          sql`cat(id) AS (
  SELECT id FROM categories WHERE slug = ${scope.slug} AND is_active = 1
  UNION
  SELECT ch.id FROM categories AS ch JOIN cat ON ch.parent_id = cat.id WHERE ch.is_active = 1
)`,
        ],
        where: sql`p.category_id IN (SELECT id FROM cat)`,
      };
    case "platform":
      return { ctes: [], where: sql`EXISTS (SELECT 1 FROM platforms AS pl WHERE pl.is_active = 1 AND pl.slug = ${scope.slug} AND ${researchedPlatform("p")})` };
    case "products":
      return { ctes: [], where: sql`p.id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(scope.ids)])}))` };
    case "all":
      return { ctes: [], where: sql`1 = 1` };
  }
}

/** One row per published product of the scope that has an active variant (see the header). */
function universeStatement(scope: ListingScope, now: number): SQL {
  const { ctes, where } = scopeSql(scope);
  const extra = ctes.length > 0 ? sql`${sql.join(ctes, sql`,\n`)},\n` : sql``;
  return sql`WITH RECURSIVE
${extra}cv AS (
  SELECT v.id, v.product_id, v.price_iqd, v.compare_at_iqd,
    ROW_NUMBER() OVER (PARTITION BY v.product_id ORDER BY v.is_default DESC, v.sort ASC, v.id ASC) AS rn,
    ${freeUnits(sql`v.id`, "f")} AS free,
    (SELECT CASE WHEN COUNT(ts.reorder_point) > 0 THEN SUM(ts.reorder_point) ELSE ${DEFAULT_LOW_STOCK} END
       FROM stock_levels AS ts JOIN inventory_locations AS tl ON tl.id = ts.location_id
       WHERE ts.variant_id = v.id AND tl.is_sellable = 1 AND tl.is_active = 1) AS low,
    (SELECT MIN(COALESCE(${freeUnits(sql`bi.component_variant_id`, "b")}, 0) / MAX(bi.qty, 1))
       FROM bundle_items AS bi WHERE bi.bundle_variant_id = v.id) AS sets
  FROM variants AS v
  JOIN products AS p ON p.id = v.product_id
  WHERE v.is_active = 1 AND p.status = 'published' AND ${where}
),
vs AS (
  SELECT cv.product_id, cv.rn, cv.price_iqd, cv.compare_at_iqd,
    MAX(CASE
      WHEN cv.sets IS NOT NULL THEN (CASE WHEN cv.sets <= 0 THEN 0 WHEN cv.sets <= ${DEFAULT_LOW_STOCK} THEN 1 ELSE 2 END)
      WHEN COALESCE(cv.free, 0) <= 0 THEN 0
      WHEN cv.free <= cv.low THEN 1
      ELSE 2
    END) OVER (PARTITION BY cv.product_id) AS best
  FROM cv
),
c AS (
  SELECT p.id, p.kind, p.category_id, p.platform_id, p.device_model_id, p.attributes,
    COALESCE(p.published_at, p.created_at) AS pub,
    d.price_iqd, d.compare_at_iqd, d.best AS st,
    CASE WHEN COALESCE(p.preorder_release_at, 0) > ${now} THEN 1 ELSE 0 END AS pre
  FROM vs AS d
  JOIN products AS p ON p.id = d.product_id
  WHERE d.rn = 1
)
SELECT c.id, c.kind, c.price_iqd, c.compare_at_iqd, c.st, c.pre, c.pub, c.category_id,
  (SELECT json_group_array(pl.slug) FROM platforms AS pl WHERE pl.is_active = 1 AND ${researchedPlatform("c")}) AS plats,
  ${FITS_OF_C} AS fits,
  CASE WHEN json_valid(c.attributes) THEN json_extract(c.attributes, '$.game.arabic') END AS arabic,
  CASE WHEN json_valid(c.attributes) THEN json_extract(c.attributes, '$.game.physicalFormat') END AS format
FROM c`;
}

const CATEGORIES_SQL = sql`SELECT id, slug, parent_id, name, kind, sort, art_key FROM categories WHERE is_active = 1 ORDER BY sort, id`;
const PLATFORMS_SQL = sql`SELECT id, slug, name, accent, art_key, sort FROM platforms WHERE is_active = 1 ORDER BY sort, id`;
const DEVICES_SQL = sql`SELECT dm.slug, dm.name, dm.art_key, pl.slug AS platform
  FROM device_models AS dm JOIN platforms AS pl ON pl.id = dm.platform_id
  WHERE dm.status = 'published' AND pl.is_active = 1
  ORDER BY pl.sort, dm.sort, dm.id`;

// ───────────────────────────────────────────────────────────────── rows

type UniverseRow = {
  id: string;
  kind: ProductKind;
  price_iqd: number;
  compare_at_iqd: number | null;
  st: number;
  pre: number;
  pub: number;
  category_id: string | null;
  plats: string | null;
  fits: string | null;
  arabic: string | null;
  format: string | null;
};
type CategoryRow = { id: string; slug: string; parent_id: string | null; name: string; kind: string; sort: number; art_key: string | null };
type PlatformRow = { id: string; slug: string; name: string; accent: string; art_key: string | null; sort: number };
type DeviceRow = { slug: string; name: string; art_key: string | null; platform: string };

/** A product of the universe, in the shape filters and sorts read. */
export type ListingRow = {
  id: string;
  kind: ProductKind;
  /** The card variant's price, integer IQD. */
  price: number;
  /** Set only for a genuine reduction. */
  compareAt: number | null;
  /** 0 out of stock · 1 low · 2 in stock (best over active variants). */
  st: 0 | 1 | 2;
  preorder: boolean;
  /** Can be bought now: in stock, low, or a pre-order. */
  avail: boolean;
  pub: number;
  /** Category slugs from the product's category up to its root (empty when it has none, or an inactive one). */
  chain: string[];
  platforms: string[];
  devices: string[];
  /** Arabic support rank 0–3, null when not known (or not a game). */
  arabic: number | null;
  format: PhysicalFormat | null;
};

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

function jsonList(text: string | null): string[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function l10n(text: string | null): L10n | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as L10n;
  } catch {
    return null;
  }
}

function toRow(row: UniverseRow, chainOf: (categoryId: string | null) => string[]): ListingRow {
  const compareAt = row.compare_at_iqd !== null && row.compare_at_iqd > row.price_iqd ? row.compare_at_iqd : null;
  const st = (row.st >= 2 ? 2 : row.st <= 0 ? 0 : 1) as 0 | 1 | 2;
  const preorder = row.pre === 1;
  const arabic = row.arabic !== null && row.arabic in ARABIC_RANK ? (ARABIC_RANK[row.arabic] ?? null) : null;
  const format = (PHYSICAL_FORMATS as readonly string[]).includes(row.format ?? "") ? (row.format as PhysicalFormat) : null;
  return {
    id: row.id,
    kind: row.kind,
    price: Number(row.price_iqd),
    compareAt,
    st,
    preorder,
    avail: st > 0 || preorder,
    pub: Number(row.pub),
    chain: chainOf(row.category_id),
    platforms: [...new Set(jsonList(row.plats))],
    devices: [...new Set(jsonList(row.fits))],
    arabic,
    format,
  };
}

// ───────────────────────────────────────────────────────────────── filters and facets

function passes(group: FilterGroup, row: ListingRow, filters: ListingFilters): boolean {
  switch (group) {
    case "platforms":
      return filters.platforms.length === 0 || row.platforms.some((platform) => filters.platforms.includes(platform));
    case "category":
      return filters.category === null || row.chain.includes(filters.category);
    case "device":
      return filters.device === null || row.devices.includes(filters.device);
    case "price":
      return (filters.priceMin === null || row.price >= filters.priceMin) && (filters.priceMax === null || row.price <= filters.priceMax);
    case "inStock":
      return !filters.inStock || row.st > 0;
    case "deals":
      return !filters.deals || row.compareAt !== null;
    case "arabic":
      return filters.arabic === null || (row.arabic !== null && row.arabic >= arabicLevelRank(filters.arabic));
    case "formats":
      return filters.formats.length === 0 || (row.format !== null && filters.formats.includes(row.format));
  }
}

/** For each row, which filter groups it passes (FILTER_GROUPS order). */
const passMatrix = (rows: readonly ListingRow[], filters: ListingFilters) => rows.map((row) => FILTER_GROUPS.map((group) => passes(group, row, filters)));

/** Rows that pass every filter except `skip` (null: every filter). */
function rowsPassing(rows: readonly ListingRow[], matrix: readonly boolean[][], skip: FilterGroup | null): ListingRow[] {
  const skipIndex = skip === null ? -1 : FILTER_GROUPS.indexOf(skip);
  return rows.filter((_, i) => matrix[i].every((ok, j) => ok || j === skipIndex));
}

type Dictionaries = { categories: CategoryRow[]; platforms: PlatformRow[]; devices: DeviceRow[] };

function facetsOf(rows: readonly ListingRow[], matrix: readonly boolean[][], filters: ListingFilters, scope: ListingScope, dict: Dictionaries, locale: Locale): ListingFacets {
  const others = (group: FilterGroup) => rowsPassing(rows, matrix, group);

  // categories: the scope category's sub-categories, else the top-level categories
  const byCategory = others("category");
  const scopeCategory = scope.kind === "category" ? dict.categories.find((row) => row.slug === scope.slug) : undefined;
  const optionsSource = scopeCategory ? dict.categories.filter((row) => row.parent_id === scopeCategory.id) : dict.categories.filter((row) => row.parent_id === null);
  const categories = optionsSource
    .map((row) => ({ value: row.slug, label: pick(l10n(row.name), locale), artKey: row.art_key, count: byCategory.filter((item) => item.chain.includes(row.slug)).length }))
    .filter((option) => option.count > 0 || option.value === filters.category);

  // platforms (none on a platform hub)
  const byPlatform = others("platforms");
  const platforms =
    scope.kind === "platform"
      ? []
      : dict.platforms
          .map((row) => ({ value: row.slug, label: pick(l10n(row.name), locale), accent: row.accent, count: byPlatform.filter((item) => item.platforms.includes(row.slug)).length }))
          .filter((option) => option.count > 0 || filters.platforms.includes(option.value));

  // device models: of the hub's platform, else of the chosen platforms, else all
  const byDevice = others("device");
  const devicePlatforms = scope.kind === "platform" ? [scope.slug] : filters.platforms;
  const devices = dict.devices
    .filter((row) => devicePlatforms.length === 0 || devicePlatforms.includes(row.platform))
    .map((row) => ({ value: row.slug, label: pick(l10n(row.name), locale), platform: row.platform, artKey: row.art_key, count: byDevice.filter((item) => item.devices.includes(row.slug)).length }))
    .filter((option) => option.count > 0 || option.value === filters.device);

  const byPrice = others("price");
  const prices = byPrice.map((row) => row.price);
  const priceBands = PRICE_BANDS.map((band) => ({
    ...band,
    count: byPrice.filter((row) => (band.min === null || row.price >= band.min) && (band.max === null || row.price <= band.max)).length,
  })).filter((band) => band.count > 0);

  const byArabic = others("arabic");
  const byFormat = others("formats");
  return {
    categories,
    platforms,
    devices,
    price: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    priceBands,
    inStock: others("inStock").filter((row) => row.st > 0).length,
    deals: others("deals").filter((row) => row.compareAt !== null).length,
    arabic: ARABIC_LEVELS.map((value) => ({ value, count: byArabic.filter((row) => row.arabic !== null && row.arabic >= arabicLevelRank(value)).length })).filter(
      (option) => option.count > 0 || option.value === filters.arabic,
    ),
    formats: PHYSICAL_FORMATS.map((value) => ({ value, count: byFormat.filter((row) => row.format === value).length })).filter(
      (option) => option.count > 0 || filters.formats.includes(option.value),
    ),
    without: Object.fromEntries(FILTER_GROUPS.map((group) => [group, others(group).length])) as Record<FilterGroup, number>,
  };
}

// ───────────────────────────────────────────────────────────────── sorting and the cursor

type SortKey = (number | string)[];

/** How a "relevance" list is ranked: the scope's rank per product, all of one width. */
type Ranking = { rank: ReadonlyMap<string, readonly number[]>; width: number } | null;

function rankingOf(scope: ListingScope): Ranking {
  if (scope.kind !== "products" || !scope.rank) return null;
  let width = 1;
  for (const value of scope.rank.values()) width = Math.max(width, value.length);
  return { rank: scope.rank, width };
}

/** Sort key of a row (see directions() for the order of each position). The id ends every key. */
function keyOf(sort: ListingSort, row: ListingRow, ranking: Ranking): SortKey {
  switch (sort) {
    case "featured":
      return [row.avail ? 1 : 0, row.pub, row.id];
    case "newest":
      return [row.pub, row.id];
    case "price_asc":
    case "price_desc":
      return [row.price, row.id];
    case "relevance": {
      const width = ranking?.width ?? 1;
      const own = ranking?.rank.get(row.id) ?? [];
      // a product without a rank (should not happen) goes last; a short rank is padded the same way
      const padded = Array.from({ length: width }, (_, i) => (typeof own[i] === "number" && Number.isFinite(own[i]) ? own[i] : Number.MAX_SAFE_INTEGER));
      return [...padded, row.avail ? 1 : 0, row.pub, row.id];
    }
  }
}

function directions(sort: ListingSort, length: number): (1 | -1)[] {
  switch (sort) {
    case "featured":
      return [-1, -1, -1];
    case "newest":
      return [-1, -1];
    case "price_asc":
      return [1, 1];
    case "price_desc":
      return [-1, -1];
    case "relevance":
      // rank positions ascending (smaller is better), then avail ↓, pub ↓, id ↓
      return [...Array.from({ length: length - 3 }, () => 1 as const), -1, -1, -1];
  }
}

function compareKeys(a: SortKey, b: SortKey, dirs: readonly (1 | -1)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x) < String(y) ? -1 : 1;
    if (order !== 0) return order * (dirs[i] ?? 1);
  }
  return 0;
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Opaque cursor: the sort and the sort key of the last row shown. */
export function encodeListingCursor(sort: ListingSort, key: SortKey): string {
  return toBase64Url(JSON.stringify([sort, ...key]));
}

/** The key inside a cursor; AppError("invalid") when it does not fit this sort (an old link after a sort change). */
function decodeCursor(sort: ListingSort, cursor: string): SortKey {
  const fail = () => invalid({ cursor: "invalid" }, "catalog.listing.cursor");
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(cursor) ?? "null");
  } catch {
    throw fail();
  }
  if (!Array.isArray(decoded) || decoded[0] !== sort || decoded.length < 3 || decoded.length > 12) throw fail();
  const key = decoded.slice(1);
  const id = key[key.length - 1];
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw fail();
  if (!key.slice(0, -1).every((part) => typeof part === "number" && Number.isFinite(part))) throw fail();
  return key as SortKey;
}

// ───────────────────────────────────────────────────────────────── hubs

export type HubCategory = {
  slug: string;
  name: string;
  /** Navigation group ("consoles", "games", "used", …). */
  kind: string;
  artKey: string | null;
  /** Ancestors, root first (breadcrumbs). */
  trail: { slug: string; name: string }[];
  /** The one platform every product of the category is for, when there is exactly one (the stage's light). */
  platform: string | null;
};

export type HubPlatform = { slug: string; name: string; accent: string; artKey: string | null };

export type ListingHub = {
  category: HubCategory | null;
  platform: HubPlatform | null;
  /**
   * Device shortcuts: on a platform hub every published model of the platform; elsewhere the models the scope's
   * products fit, most products first (at most 8). `count` = products of the scope (no filters) that fit.
   */
  devices: DeviceShortcut[];
};

export type ListingResult = Paged<ProductCardData> & {
  sort: ListingSort;
  /** The filters as applied (validated). */
  filters: ListingFilters;
  /** Products in the scope before any filter. */
  scopeTotal: number;
  /** Position of the first returned item in the whole list (0 unless a page past MAX_CUMULATIVE came alone). */
  offset: number;
  facets: ListingFacets;
  /**
   * Nothing matches: each active filter whose removal alone would show products, with how many — most first.
   * Empty when something matches, or when no single filter is to blame.
   */
  relax: { group: FilterGroup; count: number }[];
  hub: ListingHub;
};

function categoryChain(dict: Dictionaries): (categoryId: string | null) => string[] {
  const byId = new Map(dict.categories.map((row) => [row.id, row]));
  const cache = new Map<string, string[]>();
  return (categoryId) => {
    if (!categoryId) return [];
    const hit = cache.get(categoryId);
    if (hit) return hit;
    const chain: string[] = [];
    let row = byId.get(categoryId);
    for (let guard = 0; row && guard < 16; guard++) {
      chain.push(row.slug);
      if (!row.parent_id) break;
      const parent = byId.get(row.parent_id);
      // a category under an inactive one is hidden with it
      if (!parent) return cache.set(categoryId, []).get(categoryId)!;
      row = parent;
    }
    cache.set(categoryId, chain);
    return chain;
  };
}

function hubOf(scope: ListingScope, rows: readonly ListingRow[], dict: Dictionaries, locale: Locale): ListingHub | null {
  const deviceCount = (slug: string) => rows.filter((row) => row.devices.includes(slug)).length;
  const shortcut = (row: DeviceRow): DeviceShortcut => ({ slug: row.slug, name: pick(l10n(row.name), locale), platform: row.platform, artKey: row.art_key, count: deviceCount(row.slug) });

  if (scope.kind === "platform") {
    const platform = dict.platforms.find((row) => row.slug === scope.slug);
    if (!platform) return null;
    return {
      category: null,
      platform: { slug: platform.slug, name: pick(l10n(platform.name), locale), accent: platform.accent, artKey: platform.art_key },
      devices: dict.devices.filter((row) => row.platform === platform.slug).map(shortcut),
    };
  }
  const devices = dict.devices
    .map(shortcut)
    .filter((device) => device.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  if (scope.kind !== "category") return { category: null, platform: null, devices };

  const category = dict.categories.find((row) => row.slug === scope.slug);
  if (!category) return null;
  const byId = new Map(dict.categories.map((row) => [row.id, row]));
  const trail: { slug: string; name: string }[] = [];
  for (let parentId = category.parent_id, guard = 0; parentId && guard < 16; guard++) {
    const parent = byId.get(parentId);
    if (!parent) return null; // under an inactive category: not shown
    trail.unshift({ slug: parent.slug, name: pick(l10n(parent.name), locale) });
    parentId = parent.parent_id;
  }
  const platformSets = new Set(rows.map((row) => row.platforms.join("|")));
  const only = platformSets.size === 1 ? [...platformSets][0] : "";
  return {
    category: {
      slug: category.slug,
      name: pick(l10n(category.name), locale),
      kind: category.kind,
      artKey: category.art_key,
      trail,
      platform: only && !only.includes("|") ? only : null,
    },
    platform: null,
    devices,
  };
}

// ───────────────────────────────────────────────────────────────── public API

/** The universe of a scope and the dictionaries, in one round trip. */
export async function loadListingRows(db: Db, scope: ListingScope, now: number): Promise<{ rows: ListingRow[]; dict: Dictionaries }> {
  const [universe, categories, platforms, devices] = await runBatch(db, [
    batchSql(db, universeStatement(scope, now)),
    batchSql(db, CATEGORIES_SQL),
    batchSql(db, PLATFORMS_SQL),
    batchSql(db, DEVICES_SQL),
  ]);
  const dict: Dictionaries = { categories: rowsOf<CategoryRow>(categories), platforms: rowsOf<PlatformRow>(platforms), devices: rowsOf<DeviceRow>(devices) };
  const chainOf = categoryChain(dict);
  return { rows: rowsOf<UniverseRow>(universe).map((row) => toRow(row, chainOf)), dict };
}

/** Cards for these ids, in this order (getCardsByIds takes at most MAX_CARD_IDS per call). */
async function cardsFor(db: Db, locale: Locale, ids: readonly string[], now: number): Promise<ProductCardData[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_CARD_IDS) chunks.push(ids.slice(i, i + MAX_CARD_IDS));
  const pages = await Promise.all(chunks.map((chunk) => getCardsByIds(db, locale, chunk, { now })));
  return pages.flat();
}

/**
 * A page of a product list with its facets, the hub's header data and zero-result recovery (see the file header).
 * Null when the scope's category or platform does not exist (or is inactive). Invalid input → AppError("invalid").
 */
export async function listProducts(db: Db, locale: Locale, input: ListingInput): Promise<ListingResult | null> {
  const { scope, filters, sort, cursor, limit, cumulative, now } = parseInput(input);
  const { rows, dict } = await loadListingRows(db, scope, now);
  const hub = hubOf(scope, rows, dict, locale);
  if (!hub) return null;

  const matrix = passMatrix(rows, filters);
  const matches = rowsPassing(rows, matrix, null);
  const facets = facetsOf(rows, matrix, filters, scope, dict, locale);

  const ranking = rankingOf(scope);
  const keys = new Map(matches.map((row) => [row.id, keyOf(sort, row, ranking)]));
  const width = sort === "relevance" ? (ranking?.width ?? 1) + 3 : sort === "featured" ? 3 : 2;
  const dirs = directions(sort, width);
  const sorted = [...matches].sort((a, b) => compareKeys(keys.get(a.id)!, keys.get(b.id)!, dirs));

  let start = 0;
  if (cursor) {
    const after = decodeCursor(sort, cursor);
    if (after.length !== width) throw invalid({ cursor: "invalid" }, "catalog.listing.cursor");
    const index = sorted.findIndex((row) => compareKeys(keys.get(row.id)!, after, dirs) > 0);
    start = index === -1 ? sorted.length : index;
  }
  const end = Math.min(sorted.length, start + limit);
  const from = cumulative && end <= MAX_CUMULATIVE ? 0 : start;
  const pageRows = sorted.slice(from, end);
  const items = await cardsFor(db, locale, pageRows.map((row) => row.id), now);

  const relax =
    matches.length > 0
      ? []
      : FILTER_GROUPS.filter((group) => isActive(filters, group))
          .map((group) => ({ group, count: rowsPassing(rows, matrix, group).length }))
          .filter((entry) => entry.count > 0)
          .sort((a, b) => b.count - a.count);

  return {
    items,
    total: sorted.length,
    nextCursor: end < sorted.length && end > 0 ? encodeListingCursor(sort, keys.get(sorted[end - 1].id)!) : null,
    sort,
    filters,
    scopeTotal: rows.length,
    offset: from,
    facets,
    relax,
    hub,
  };
}

// ───────────────────────────────────────────────────────────────── compare

export { MAX_COMPARE };

export type CompareSpecRow = {
  /** The spec key (`products.specs`), stable across products: rows are aligned on it. */
  key: string;
  /** The spec's own label in the shopper's language (from the first product that states it), else the key. */
  label: string;
  /** One value per product, in the products' order; null = this product's research does not state it. */
  values: (string | boolean | null)[];
  /** Every product states the same value. */
  same: boolean;
};

/**
 * What the research says about a product beyond its spec sheet (shown as the first rows). Games' sheets already state
 * platforms, format, players, size, age rating and developer, so only what they lack is here.
 */
export type CompareFacts = {
  /** The store platforms the product is researched for (slugs) and their names. */
  platforms: { slug: string; name: string }[];
  game: {
    /** Arabic support rank 0–3, null when not known — the same for every game (the sheets state it for some only). */
    arabic: number | null;
    genres: string | null;
  } | null;
};

/**
 * Spec keys the research wrote two ways for the same thing, per kind → the key rows align on. Only true synonyms:
 * "size" means the dimensions of a console but the storage a game needs, so nothing crosses kinds.
 */
const SPEC_ALIASES: Partial<Record<ProductKind, Readonly<Record<string, string>>>> = {
  game: { release: "releaseDate", platform: "platforms", age: "ageRating" },
  console: { model_number: "model", processor: "cpu", chip: "cpu" },
  headset: { mic: "microphone", connection: "connectivity", spatial: "spatial_audio" },
  controller: { connection: "connectivity" },
};
/** Spec rows replaced by a fact row that every product of the kind has (games: Arabic support). */
const SPECS_SHOWN_AS_FACTS: Partial<Record<ProductKind, readonly string[]>> = { game: ["arabic"] };

export type CompareResult = {
  /** The kind being compared (the first product's), null when nothing is. */
  kind: ProductKind | null;
  products: { card: ProductCardData; facts: CompareFacts }[];
  specs: CompareSpecRow[];
  /** Asked for, but of another kind: left out (comparisons hold one kind). */
  otherKind: { id: string; name: string }[];
  /** Asked for, but unknown, unpublished or without an active variant (or beyond MAX_COMPARE). */
  missing: number;
  /** Products of the same kind and category that are not in the comparison (to add). */
  more: ProductCardData[];
};

type CompareRow = { id: string; slug: string; kind: ProductKind; name: string; specs: string | null; attributes: string | null; age_rating: string | null; category: string | null };
type SpecCell = string | number | boolean | (L10n & { label?: L10n }) | null;

function specText(value: SpecCell, locale: Locale): string | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "object") return pick(value, locale).trim() || null;
  return null;
}

const humanKey = (key: string) => key.replace(/[_-]+/g, " ").trim();

function parseObject<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * A side-by-side comparison of up to MAX_COMPARE products of ONE kind, specs aligned by spec key (rows in the order
 * the products first state them). `refs` are product ids or slugs, in the order to show; duplicates count once.
 */
export async function getComparison(db: Db, locale: Locale, refs: readonly string[], options: { now?: number } = {}): Promise<CompareResult> {
  const now = options.now ?? Date.now();
  const wanted = [...new Set(refs.filter((ref) => typeof ref === "string" && ref.length > 0 && ref.length <= 128))].slice(0, MAX_COMPARE * 3);
  const empty: CompareResult = { kind: null, products: [], specs: [], otherKind: [], missing: 0, more: [] };
  if (wanted.length === 0) return empty;
  const list = JSON.stringify(wanted);
  const found = await db.all<CompareRow>(sql`
    SELECT p.id, p.slug, p.kind, p.name, p.specs, p.attributes, p.age_rating, c.slug AS category
    FROM products AS p LEFT JOIN categories AS c ON c.id = p.category_id AND c.is_active = 1
    WHERE p.status = 'published' AND (p.id IN (SELECT value FROM json_each(${list})) OR p.slug IN (SELECT value FROM json_each(${list})))`);
  const byRef = new Map<string, CompareRow>();
  for (const row of found) {
    byRef.set(row.id, row);
    byRef.set(row.slug, row);
  }
  const ordered: CompareRow[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (const ref of wanted) {
    const row = byRef.get(ref);
    if (!row) {
      missing++;
      continue;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    ordered.push(row);
  }
  if (ordered.length === 0) return { ...empty, missing };

  const kind = ordered[0].kind;
  const sameKind = ordered.filter((row) => row.kind === kind);
  const chosen = sameKind.slice(0, MAX_COMPARE);
  missing += sameKind.length - chosen.length;
  const otherKind = ordered.filter((row) => row.kind !== kind).map((row) => ({ id: row.id, name: pick(l10n(row.name), locale) || row.slug }));

  const [cards, listing] = await Promise.all([getCardsByIds(db, locale, chosen.map((row) => row.id), { now }), loadListingRows(db, { kind: "products", ids: chosen.map((row) => row.id) }, now)]);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const rowById = new Map(listing.rows.map((row) => [row.id, row]));
  const platformName = new Map(listing.dict.platforms.map((row) => [row.slug, pick(l10n(row.name), locale)]));
  const kept = chosen.filter((row) => cardById.has(row.id));
  missing += chosen.length - kept.length;

  const products = kept.map((row) => {
    const attributes = parseObject<{ game?: Record<string, unknown> | null }>(row.attributes);
    const game = attributes?.game ?? null;
    const universe = rowById.get(row.id);
    const localized = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? pick(value as L10n, locale).trim() || null : null);
    return {
      card: cardById.get(row.id)!,
      facts: {
        platforms: (universe?.platforms ?? []).map((slug) => ({ slug, name: platformName.get(slug) ?? slug })),
        game: game
          ? {
              arabic: universe?.arabic ?? null,
              genres: Array.isArray(game.genres) ? game.genres.map(localized).filter(Boolean).join(locale === "en" ? ", " : "، ") || null : null,
            }
          : null,
      },
    };
  });

  // spec rows aligned by key (true synonyms folded, per kind), in the order the products first state them
  const aliases = SPEC_ALIASES[kind] ?? {};
  const dropped = new Set(SPECS_SHOWN_AS_FACTS[kind] ?? []);
  const sheets = kept.map((row) => {
    const raw = parseObject<Record<string, SpecCell>>(row.specs) ?? {};
    const sheet: Record<string, SpecCell> = {};
    for (const [key, value] of Object.entries(raw)) {
      const canonical = aliases[key] ?? key;
      if (dropped.has(canonical)) continue;
      // the canonical key wins when a sheet states both spellings
      if (!(canonical in sheet) || canonical === key) sheet[canonical] = value;
    }
    return sheet;
  });
  const keys: string[] = [];
  for (const sheet of sheets) for (const key of Object.keys(sheet)) if (!keys.includes(key)) keys.push(key);
  const specs: CompareSpecRow[] = keys.map((key) => {
    const values = sheets.map((sheet) => specText(sheet[key] ?? null, locale));
    const labelSource = sheets.map((sheet) => sheet[key]).find((cell) => cell && typeof cell === "object" && "label" in cell && cell.label) as { label?: L10n } | undefined;
    const label = (labelSource?.label ? pick(labelSource.label, locale) : "") || humanKey(key);
    const shown = values.map((value) => (value === null ? "∅" : String(value)));
    return { key, label, values, same: values.length > 1 && shown.every((value) => value === shown[0]) };
  });

  // more of the same kind from the first product's category
  let more: ProductCardData[] = [];
  const category = kept[0] ? chosen.find((row) => row.id === kept[0].id)?.category : null;
  if (category && kept.length < MAX_COMPARE) {
    const page = await listProducts(db, locale, { scope: { kind: "category", slug: category }, sort: "featured", limit: 12, now });
    more = (page?.items ?? []).filter((card) => card.kind === kind && !kept.some((row) => row.id === card.id)).slice(0, 8);
  }

  return { kind: kept.length > 0 ? kind : null, products, specs, otherKind, missing, more };
}

/**
 * A few products of a scope that can be bought now, featured order — the "picks" under a zero-result state
 * (labelled for what they are: products of this section, not recommendations).
 */
export async function scopePicks(db: Db, locale: Locale, scope: ListingScope, options: { limit?: number; now?: number; exclude?: readonly string[] } = {}): Promise<ProductCardData[]> {
  const now = options.now ?? Date.now();
  const { rows } = await loadListingRows(db, scope, now);
  const exclude = new Set(options.exclude ?? []);
  const dirs = directions("featured", 3);
  const picks = rows
    .filter((row) => row.st > 0 && !exclude.has(row.id))
    .sort((a, b) => compareKeys(keyOf("featured", a, null), keyOf("featured", b, null), dirs))
    .slice(0, Math.min(Math.max(1, options.limit ?? 3), 12));
  return cardsFor(db, locale, picks.map((row) => row.id), now);
}
