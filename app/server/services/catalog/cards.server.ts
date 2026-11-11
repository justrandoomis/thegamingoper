/**
 * Catalogue read layer — product cards and used-unit cards (docs/CONTRACTS.md §2; types in ./types).
 *
 *   const cards = await getCardsByIds(db, ctx.locale, ["prd_…", "prd_…"]);               // in the order asked, unknown/unpublished skipped
 *   const page = await listCards(db, ctx.locale, { category: "games", sort: "price_asc", limit: 24, cursor, now: ctx.now });
 *   const shelf = await getNewArrivals(db, ctx.locale, { platform: "nintendo", limit: 6, now: ctx.now });
 *   const deals = await getDeals(db, ctx.locale, { now: ctx.now });                       // genuine reductions, biggest saving first
 *   const used = await getUsedSpotlight(db, ctx.locale, { limit: 4 });                    // listed used units, newest first
 *
 * HOW (one round trip per call, no N+1)
 *   Every card query is ONE SQL statement built from the CTE chain in cardCtes():
 *     cv    active variants of published products that pass the product-level filters, ranked so the card
 *           variant (default, else first by sort) is rn = 1
 *     lv    free units per variant (and per bundle component) over sellable, active locations
 *     bn    complete bundle sets
 *     va    the stock state of each variant (0 out · 1 low · 2 in), exactly as getAvailability() decides it
 *     pb    the best state per product
 *     c     one row per product: card variant price, state, preorder flag, "can be bought now" (avail)
 *   then filters on c, sort + keyset cursor, LIMIT, and — only for the rows of the page — the first picture and
 *   the review summary as correlated subqueries. listCards sends the page and the total COUNT in one db.batch.
 *
 * PRIVACY: the statements never select cost, landed cost, margins, serials or stock quantities; only the state
 * (0/1/2) leaves SQL. Used units: no acquisition cost, no serial, no location.
 *
 * Services take `db` first and never import "cloudflare:workers" (tests run them against a local D1).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { ImageRef, Paged, ProductCardData, ProductKind, RatingSummary, StockState, UsedGrade, UsedUnitCardData } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { PRODUCT_KINDS } from "~/server/db/schema";
import { ftsMatchQuery, searchTerms } from "~/server/db/search.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { invalid, zodFieldErrors } from "~/server/errors";
import { DEFAULT_LOW_STOCK } from "~/server/services/inventory/stock.server";
import { CARD_SORTS, MAX_CARD_PAGE, type CardFilters, type CardSort, type ListCardsOptions, type ShelfOptions } from "./types";

export { CARD_SORTS, MAX_CARD_PAGE } from "./types";
export type { CardFilters, CardSort, ListCardsOptions, ShelfOptions } from "./types";

/** getCardsByIds accepts at most this many ids per call. */
export const MAX_CARD_IDS = 100;

// ───────────────────────────────────────────────────────────────── input validation

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const slug = z.string().trim().min(1, "invalid").max(80, "invalid").regex(SLUG, "invalid");
const slugs = z.union([slug, z.array(slug).min(1, "invalid").max(12, "invalid")]);
const kinds = z.union([z.enum(PRODUCT_KINDS), z.array(z.enum(PRODUCT_KINDS)).min(1, "invalid").max(PRODUCT_KINDS.length, "invalid")]);
const amount = z.number().int("invalid").min(0, "invalid").max(1_000_000_000, "invalid");
const epoch = z.number().int("invalid").min(0, "invalid");

const FilterSchema = z.object({
  platform: slugs.optional(),
  category: slug.optional(),
  kind: kinds.optional(),
  deviceModel: slug.optional(),
  q: z.string().max(120, "too_long").optional(),
  priceMin: amount.optional(),
  priceMax: amount.optional(),
  inStockOnly: z.boolean().optional(),
  dealsOnly: z.boolean().optional(),
});

const ListSchema = FilterSchema.extend({
  sort: z.enum(CARD_SORTS),
  limit: z.number().int("invalid").min(1, "invalid").max(MAX_CARD_PAGE, "invalid"),
  cursor: z.string().max(512, "invalid").nullable().optional(),
  now: epoch.optional(),
});

const ShelfSchema = z.object({
  platform: slugs.optional(),
  limit: z.number().int("invalid").min(1, "invalid").max(MAX_CARD_PAGE, "invalid").optional(),
  now: epoch.optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw invalid(zodFieldErrors(result.error), "catalog.cards");
  return result.data;
}

const asList = <T>(value: T | readonly T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? [...(value as readonly T[])] : [value as T]);

// ───────────────────────────────────────────────────────────────── SQL building blocks

/**
 * Product-level scope: CTEs the filters need (named, at the top of the WITH clause — D1 refuses deeply nested
 * subqueries, so nothing filter-related is nested inside the chain) and conditions on products (alias p).
 */
type Scope = { ctes: SQL[]; where: SQL[] };

/** The CTE chain shared by every card query (see the file header). */
function cardCtes(scope: Scope, now: number): SQL {
  const extra = scope.ctes.length > 0 ? sql`${sql.join(scope.ctes, sql`,\n`)},\n` : sql``;
  return sql`WITH RECURSIVE
${extra}prod AS MATERIALIZED (
  SELECT p.id FROM products AS p WHERE p.status = 'published' AND ${andAll(scope.where)}
),
cv AS MATERIALIZED (
  SELECT v.id, v.product_id, v.price_iqd, v.compare_at_iqd,
    ROW_NUMBER() OVER (PARTITION BY v.product_id ORDER BY v.is_default DESC, v.sort ASC, v.id ASC) AS rn,
    COUNT(*) OVER (PARTITION BY v.product_id) AS n
  FROM variants AS v
  WHERE v.is_active = 1 AND v.product_id IN (SELECT id FROM prod)
),
lv AS MATERIALIZED (
  SELECT sl.variant_id,
    SUM(MAX(sl.on_hand - sl.reserved, 0)) AS free,
    SUM(sl.reorder_point) AS reorder_sum,
    COUNT(sl.reorder_point) AS reorder_n
  FROM stock_levels AS sl
  JOIN inventory_locations AS loc ON loc.id = sl.location_id
  WHERE loc.is_sellable = 1 AND loc.is_active = 1
    AND sl.variant_id IN (SELECT id FROM cv UNION SELECT bi.component_variant_id FROM bundle_items AS bi WHERE bi.bundle_variant_id IN (SELECT id FROM cv))
  GROUP BY sl.variant_id
),
bn AS (
  SELECT bi.bundle_variant_id AS variant_id, MIN(COALESCE(lv.free, 0) / bi.qty) AS free
  FROM bundle_items AS bi
  LEFT JOIN lv ON lv.variant_id = bi.component_variant_id
  WHERE bi.bundle_variant_id IN (SELECT id FROM cv)
  GROUP BY bi.bundle_variant_id
),
va AS MATERIALIZED (
  SELECT cv.id, cv.product_id, cv.rn, cv.n, cv.price_iqd, cv.compare_at_iqd,
    CASE
      WHEN bn.variant_id IS NOT NULL THEN (CASE WHEN bn.free <= 0 THEN 0 WHEN bn.free <= ${DEFAULT_LOW_STOCK} THEN 1 ELSE 2 END)
      WHEN COALESCE(lv.free, 0) <= 0 THEN 0
      WHEN lv.free <= (CASE WHEN lv.reorder_n > 0 THEN lv.reorder_sum ELSE ${DEFAULT_LOW_STOCK} END) THEN 1
      ELSE 2
    END AS st
  FROM cv
  LEFT JOIN bn ON bn.variant_id = cv.id
  LEFT JOIN lv ON lv.variant_id = cv.id
),
pb AS (
  SELECT product_id, MAX(st) AS best FROM va GROUP BY product_id
),
c AS (
  SELECT p.id, p.slug, p.kind, p.name, p.short, p.platform_id, p.is_demo,
    COALESCE(p.published_at, p.created_at) AS pub,
    d.id AS variant_id, d.price_iqd, d.compare_at_iqd, d.n AS variant_count,
    CASE WHEN d.n > 1 THEN pb.best ELSE d.st END AS st,
    CASE WHEN p.preorder_release_at IS NOT NULL AND p.preorder_release_at > ${now} THEN 1 ELSE 0 END AS pre,
    CASE WHEN (CASE WHEN d.n > 1 THEN pb.best ELSE d.st END) > 0 OR (p.preorder_release_at IS NOT NULL AND p.preorder_release_at > ${now}) THEN 1 ELSE 0 END AS avail
  FROM va AS d
  JOIN pb ON pb.product_id = d.product_id
  JOIN products AS p ON p.id = d.product_id
  WHERE d.rn = 1
)`;
}

/** First picture of a card: the card variant's own pictures before the product's; uploaded files only when public. */
const IMAGE_OF_PAGE_ROW = sql`(
  SELECT json_object('a', m.art_key, 'k', CASE WHEN f.visibility = 'public' THEN f.storage_key END, 'w', f.width, 'h', f.height, 'alt', json(m.alt), 'i', m.is_illustration)
  FROM media AS m
  LEFT JOIN files AS f ON f.id = m.file_id
  WHERE m.kind IN ('image', 'render')
    AND ((m.owner_type = 'variant' AND m.owner_id = page.variant_id) OR (m.owner_type = 'product' AND m.owner_id = page.id))
    AND (m.art_key IS NOT NULL OR (f.storage_key IS NOT NULL AND f.visibility = 'public'))
  ORDER BY CASE WHEN m.owner_type = 'variant' THEN 0 ELSE 1 END, m.sort, m.id
  LIMIT 1
)`;

/** Approved reviews from verified purchases only. */
const RATING_OF_PAGE_ROW = sql`(
  SELECT json_object('avg', AVG(r.rating), 'n', COUNT(*))
  FROM reviews AS r
  WHERE r.product_id = page.id AND r.status = 'approved' AND r.is_verified_purchase = 1
)`;

type Ordering = CardSort | "saving";

/** ORDER BY for the rows of `alias` (they all carry the columns of c). Every order ends on the id: a total order. */
function orderBy(ordering: Ordering, alias: "c" | "page"): SQL {
  const a = sql.raw(alias);
  switch (ordering) {
    case "featured":
      return sql`${a}.avail DESC, ${a}.pub DESC, ${a}.id DESC`;
    case "newest":
      return sql`${a}.pub DESC, ${a}.id DESC`;
    case "price_asc":
      return sql`${a}.price_iqd ASC, ${a}.id ASC`;
    case "price_desc":
      return sql`${a}.price_iqd DESC, ${a}.id DESC`;
    case "saving":
      return sql`(CAST(${a}.compare_at_iqd - ${a}.price_iqd AS REAL) / ${a}.compare_at_iqd) DESC, ${a}.pub DESC, ${a}.id DESC`;
  }
}

const andAll = (parts: SQL[]): SQL => (parts.length === 0 ? sql`1 = 1` : sql.join(parts, sql` AND `));

/** Product-level filters, shared by listCards and the shelves. */
function productScope(filters: CardFilters): Scope {
  const scope: Scope = { ctes: [], where: [] };
  const platforms = asList(filters.platform);
  if (platforms.length > 0) {
    scope.where.push(sql`p.platform_id IN (SELECT id FROM platforms WHERE is_active = 1 AND slug IN (SELECT value FROM json_each(${JSON.stringify(platforms)})))`);
  }
  const kindList = asList(filters.kind);
  if (kindList.length > 0) scope.where.push(sql`p.kind IN (SELECT value FROM json_each(${JSON.stringify(kindList)}))`);
  if (filters.category) {
    // The category and its active sub-categories (products sit on the deepest fitting category).
    scope.ctes.push(sql`cat(id) AS (
  SELECT id FROM categories WHERE slug = ${filters.category} AND is_active = 1
  UNION
  SELECT ch.id FROM categories AS ch JOIN cat ON ch.parent_id = cat.id WHERE ch.is_active = 1
)`);
    scope.where.push(sql`p.category_id IN (SELECT id FROM cat)`);
  }
  if (filters.deviceModel) {
    scope.ctes.push(...deviceModelCtes(filters.deviceModel));
    scope.where.push(sql`p.id IN (SELECT product_id FROM fit)`);
  }
  if (filters.q !== undefined) {
    const search = searchCte(filters.q);
    if (search) {
      scope.ctes.push(search);
      scope.where.push(sql`p.id IN (SELECT product_id FROM hit)`);
    }
  }
  return scope;
}

/**
 * Products for a device model (CTE `fit`): the model itself / parts made for it (`device_model_id`), or a subject —
 * the product or one of its active variants — whose MOST SPECIFIC compatibility rule for this model (device model ›
 * generation › platform) is verified or partial. A more specific rule of any status overrides a broader one
 * ("Series S: no disc drive" beats "Xbox Series generation"); unverified and incompatible never qualify.
 */
function deviceModelCtes(model: string): SQL[] {
  return [
    sql`dm AS (SELECT id, generation_id, platform_id FROM device_models WHERE slug = ${model})`,
    sql`fr AS (
  SELECT r.subject_type, r.subject_id, r.status,
    CASE r.target_type WHEN 'device_model' THEN 3 WHEN 'generation' THEN 2 ELSE 1 END AS rk
  FROM compatibility_rules AS r JOIN dm
    ON (r.target_type = 'device_model' AND r.target_id = dm.id)
    OR (r.target_type = 'generation' AND r.target_id = dm.generation_id)
    OR (r.target_type = 'platform' AND r.target_id = dm.platform_id)
)`,
    sql`fb AS (
  SELECT fr.subject_type, fr.subject_id, fr.status FROM fr
  JOIN (SELECT subject_type, subject_id, MAX(rk) AS rk FROM fr GROUP BY subject_type, subject_id) AS top
    ON top.subject_type = fr.subject_type AND top.subject_id = fr.subject_id AND top.rk = fr.rk
)`,
    sql`fit(product_id) AS (
  SELECT subject_id FROM fb WHERE subject_type = 'product' AND status IN ('verified', 'partial')
  UNION
  SELECT v.product_id FROM fb JOIN variants AS v ON v.id = fb.subject_id
  WHERE fb.subject_type = 'variant' AND fb.status IN ('verified', 'partial') AND v.is_active = 1
  UNION
  SELECT p.id FROM products AS p JOIN dm ON p.device_model_id = dm.id
)`,
  ];
}

/** Free-text matches (CTE `hit`) through the FTS5 search index (every locale's rows); null when nothing searchable was typed. */
function searchCte(q: string): SQL | null {
  const match = ftsMatchQuery(q);
  const { short } = searchTerms(q);
  const conditions: SQL[] = [];
  if (match) conditions.push(sql`search_index MATCH ${match}`);
  for (const term of short) {
    const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(sql`(name LIKE ${pattern} ESCAPE '\\' OR keywords LIKE ${pattern} ESCAPE '\\')`);
  }
  if (conditions.length === 0) return null;
  return sql`hit(product_id) AS (SELECT DISTINCT product_id FROM search_index WHERE ${sql.join(conditions, sql` AND `)})`;
}

/** Card-level filters (alias c). */
function cardFilters(filters: CardFilters): SQL[] {
  const where: SQL[] = [];
  if (filters.priceMin !== undefined) where.push(sql`c.price_iqd >= ${filters.priceMin}`);
  if (filters.priceMax !== undefined) where.push(sql`c.price_iqd <= ${filters.priceMax}`);
  if (filters.inStockOnly) where.push(sql`c.st > 0`);
  if (filters.dealsOnly) where.push(sql`c.compare_at_iqd IS NOT NULL AND c.compare_at_iqd > c.price_iqd`);
  return where;
}

/** The page statement: filtered, sorted and limited rows of c, then picture, rating and platform for those rows only. */
function pageStatement(scope: Scope, cardWhere: SQL[], ordering: Ordering, limit: number | null, now: number): SQL {
  return sql`${cardCtes(scope, now)},
page AS (
  SELECT * FROM c WHERE ${andAll(cardWhere)} ORDER BY ${orderBy(ordering, "c")}${limit === null ? sql`` : sql` LIMIT ${limit}`}
)
SELECT page.*, pl.slug AS platform_slug, pl.name AS platform_name,
  ${IMAGE_OF_PAGE_ROW} AS image,
  ${RATING_OF_PAGE_ROW} AS rating
FROM page
LEFT JOIN platforms AS pl ON pl.id = page.platform_id
ORDER BY ${orderBy(ordering, "page")}`;
}

function countStatement(scope: Scope, cardWhere: SQL[], now: number): SQL {
  return sql`${cardCtes(scope, now)}
SELECT COUNT(*) AS n FROM c WHERE ${andAll(cardWhere)}`;
}

// ───────────────────────────────────────────────────────────────── rows → view models

type CardRow = {
  id: string;
  slug: string;
  kind: ProductKind;
  name: string | null;
  short: string | null;
  platform_id: string | null;
  is_demo: number;
  pub: number;
  variant_id: string;
  price_iqd: number;
  compare_at_iqd: number | null;
  variant_count: number;
  st: number;
  pre: number;
  avail: number;
  platform_slug: string | null;
  platform_name: string | null;
  image: string | null;
  rating: string | null;
};

type ImageJson = { a: string | null; k: string | null; w: number | null; h: number | null; alt: L10n | null; i: number | null };

function parseJson<T>(text: string | null | undefined): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const l10nOf = (value: unknown): L10n | null => (typeof value === "string" ? parseJson<L10n>(value) : (value as L10n | null));

function imageRef(raw: string | null, fallbackAlt: string, locale: Locale): ImageRef {
  const image = parseJson<ImageJson>(raw);
  if (!image) return { artKey: null, mediaKey: null, alt: fallbackAlt, isIllustration: true };
  const mediaKey = image.k ?? null;
  return {
    artKey: mediaKey ? null : (image.a ?? null),
    mediaKey,
    alt: pick(image.alt, locale) || fallbackAlt,
    isIllustration: image.i !== 0,
    ...(mediaKey && image.w && image.h ? { width: image.w, height: image.h } : {}),
  };
}

function ratingOf(raw: string | null): RatingSummary | null {
  const rating = parseJson<{ avg: number | null; n: number }>(raw);
  if (!rating || !rating.n || rating.avg === null) return null;
  return { average: Math.round(rating.avg * 10) / 10, count: rating.n };
}

const STOCK_BY_RANK: readonly StockState[] = ["out_of_stock", "low_stock", "in_stock"];

function toCard(row: CardRow, locale: Locale): ProductCardData {
  const name = pick(l10nOf(row.name), locale);
  const compareAtIqd = row.compare_at_iqd !== null && row.compare_at_iqd > row.price_iqd ? row.compare_at_iqd : null;
  const preorder = row.pre === 1;
  return {
    id: row.id,
    slug: row.slug,
    name,
    subtitle: pick(l10nOf(row.short), locale) || null,
    kind: row.kind,
    platformSlug: row.platform_slug ?? null,
    platformName: row.platform_name ? pick(l10nOf(row.platform_name), locale) || null : null,
    variantId: row.variant_id,
    hasVariants: row.variant_count > 1,
    priceIqd: row.price_iqd,
    compareAtIqd,
    stock: preorder ? "preorder" : (STOCK_BY_RANK[row.st] ?? "out_of_stock"),
    badge: preorder ? "preorder" : compareAtIqd !== null ? "deal" : "new",
    image: imageRef(row.image, name, locale),
    rating: ratingOf(row.rating),
    isDemo: row.is_demo === 1,
  };
}

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

async function runPage(db: Db, statement: SQL): Promise<CardRow[]> {
  return db.all<CardRow>(statement);
}

// ───────────────────────────────────────────────────────────────── cursor

const CURSOR_SHAPES: Record<CardSort, ("int" | "id")[]> = {
  featured: ["int", "int", "id"],
  newest: ["int", "id"],
  price_asc: ["int", "id"],
  price_desc: ["int", "id"],
};

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

/** Opaque cursor: the sort and the sort key of the last row of the page (base64url JSON). */
function encodeCursor(sort: CardSort, row: CardRow): string {
  const key = sort === "featured" ? [row.avail, row.pub, row.id] : sort === "newest" ? [row.pub, row.id] : [row.price_iqd, row.id];
  return toBase64Url(JSON.stringify([sort, ...key]));
}

function decodeCursor(sort: CardSort, cursor: string): (number | string)[] {
  const fail = () => invalid({ cursor: "invalid" }, "catalog.cursor");
  const decoded = parseJson<unknown>(fromBase64Url(cursor));
  if (!Array.isArray(decoded) || decoded[0] !== sort) throw fail();
  const values = decoded.slice(1);
  const shape = CURSOR_SHAPES[sort];
  if (values.length !== shape.length) throw fail();
  shape.forEach((kind, index) => {
    const value = values[index];
    const ok = kind === "int" ? Number.isSafeInteger(value) : typeof value === "string" && value.length > 0 && value.length <= 128;
    if (!ok) throw fail();
  });
  return values as (number | string)[];
}

/** Rows strictly after the cursor in the given order (keyset pagination: no duplicates, no skips while data holds still). */
function afterCursor(sort: CardSort, values: (number | string)[]): SQL {
  switch (sort) {
    case "featured": {
      const [avail, pub, id] = values;
      return sql`(c.avail < ${avail} OR (c.avail = ${avail} AND c.pub < ${pub}) OR (c.avail = ${avail} AND c.pub = ${pub} AND c.id < ${id}))`;
    }
    case "newest": {
      const [pub, id] = values;
      return sql`(c.pub < ${pub} OR (c.pub = ${pub} AND c.id < ${id}))`;
    }
    case "price_asc": {
      const [price, id] = values;
      return sql`(c.price_iqd > ${price} OR (c.price_iqd = ${price} AND c.id > ${id}))`;
    }
    case "price_desc": {
      const [price, id] = values;
      return sql`(c.price_iqd < ${price} OR (c.price_iqd = ${price} AND c.id < ${id}))`;
    }
  }
}

// ───────────────────────────────────────────────────────────────── public API

/**
 * Cards for the given product ids, in the order asked (duplicates once). Ids that are unknown, unpublished or have
 * no active variant are skipped. At most MAX_CARD_IDS ids.
 */
export async function getCardsByIds(db: Db, locale: Locale, ids: readonly string[], options: { now?: number } = {}): Promise<ProductCardData[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128))];
  if (unique.length === 0) return [];
  if (unique.length > MAX_CARD_IDS) throw invalid({ ids: "too_big" }, "catalog.getCardsByIds");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw invalid({ now: "invalid" }, "catalog.getCardsByIds");
  const scope: Scope = { ctes: [], where: [sql`p.id IN (SELECT value FROM json_each(${JSON.stringify(unique)}))`] };
  const rows = await runPage(db, pageStatement(scope, [], "newest", null, now));
  const byId = new Map(rows.map((row) => [row.id, toCard(row, locale)]));
  return unique.map((id) => byId.get(id)).filter((card): card is ProductCardData => card !== undefined);
}

/**
 * A page of product cards. `total` counts every match (not only this page); `nextCursor` is null on the last page.
 * Invalid options or a cursor that does not fit `sort` → AppError("invalid", 400).
 */
export async function listCards(db: Db, locale: Locale, options: ListCardsOptions): Promise<Paged<ProductCardData>> {
  const input = parse(ListSchema, options);
  const now = input.now ?? Date.now();
  const scope = productScope(input);
  const cardWhere = cardFilters(input);
  const pageWhere = input.cursor ? [...cardWhere, afterCursor(input.sort, decodeCursor(input.sort, input.cursor))] : cardWhere;

  const [pageResult, countResult] = await runBatch(db, [
    batchSql(db, pageStatement(scope, pageWhere, input.sort, input.limit + 1, now)),
    batchSql(db, countStatement(scope, cardWhere, now)),
  ]);
  const rows = rowsOf<CardRow>(pageResult);
  const total = Number(rowsOf<{ n: number }>(countResult)[0]?.n ?? 0);
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  return {
    items: items.map((row) => toCard(row, locale)),
    total,
    nextCursor: hasMore && items.length > 0 ? encodeCursor(input.sort, items[items.length - 1]) : null,
  };
}

/** The newest published products that can be bought now — the "وصل حديثاً" shelf. */
export async function getNewArrivals(db: Db, locale: Locale, options: ShelfOptions = {}): Promise<ProductCardData[]> {
  const input = parse(ShelfSchema, options);
  const page = await listCards(db, locale, { platform: input.platform, inStockOnly: true, sort: "newest", limit: input.limit ?? 12, now: input.now });
  return page.items;
}

/**
 * Genuine reductions only: the card variant's compare-at price is above its price (the pricing flow sets compare-at
 * only for a real previous price — schema/catalog.ts). In stock only, biggest saving (in percent) first.
 */
export async function getDeals(db: Db, locale: Locale, options: ShelfOptions = {}): Promise<ProductCardData[]> {
  const input = parse(ShelfSchema, options);
  const now = input.now ?? Date.now();
  const filters: CardFilters = { platform: input.platform, dealsOnly: true, inStockOnly: true };
  const rows = await runPage(db, pageStatement(productScope(filters), cardFilters(filters), "saving", input.limit ?? 12, now));
  return rows.map((row) => toCard(row, locale));
}

type UsedRow = {
  id: string;
  slug: string;
  grade: UsedGrade;
  battery_health_pct: number | null;
  price_iqd: number;
  warranty_days: number;
  is_demo: number;
  name: string | null;
  short: string | null;
  variant_title: string | null;
  platform_slug: string | null;
  image: string | null;
  real_photos: number;
};

/**
 * Listed used units, newest listing first — each a specific device with its grade and price. The picture prefers
 * real photographs of the unit (`is_illustration = 0`, public file); `hasRealPhotos` is false when every picture is
 * an illustration, and the card must then say "صورة توضيحية — ليست صورة الجهاز نفسه" (DESIGN.md §12).
 */
export async function getUsedSpotlight(db: Db, locale: Locale, options: ShelfOptions = {}): Promise<UsedUnitCardData[]> {
  const input = parse(ShelfSchema, options);
  const platforms = asList(input.platform);
  const platformWhere =
    platforms.length > 0 ? sql`AND pl.slug IN (SELECT value FROM json_each(${JSON.stringify(platforms)}))` : sql``;
  const rows = await db.all<UsedRow>(sql`
SELECT u.id, u.slug, u.grade, u.battery_health_pct, u.price_iqd, u.warranty_days, u.is_demo,
  p.name, p.short, v.title AS variant_title, pl.slug AS platform_slug,
  (
    SELECT json_object('a', m.art_key, 'k', CASE WHEN f.visibility = 'public' THEN f.storage_key END, 'w', f.width, 'h', f.height, 'alt', json(m.alt), 'i', m.is_illustration)
    FROM media AS m
    LEFT JOIN files AS f ON f.id = m.file_id
    WHERE m.owner_type = 'used_unit' AND m.owner_id = u.id AND m.kind IN ('image', 'render')
      AND (m.art_key IS NOT NULL OR (f.storage_key IS NOT NULL AND f.visibility = 'public'))
    ORDER BY CASE WHEN m.is_illustration = 0 AND f.visibility = 'public' THEN 0 ELSE 1 END, m.sort, m.id
    LIMIT 1
  ) AS image,
  EXISTS (
    SELECT 1 FROM media AS m JOIN files AS f ON f.id = m.file_id
    WHERE m.owner_type = 'used_unit' AND m.owner_id = u.id AND m.kind = 'image' AND m.is_illustration = 0 AND f.visibility = 'public'
  ) AS real_photos
FROM used_units AS u
JOIN variants AS v ON v.id = u.variant_id
JOIN products AS p ON p.id = v.product_id
LEFT JOIN platforms AS pl ON pl.id = p.platform_id
WHERE u.status = 'listed' ${platformWhere}
ORDER BY COALESCE(u.listed_at, u.created_at) DESC, u.id DESC
LIMIT ${input.limit ?? 8}`);
  return rows.map((row): UsedUnitCardData => {
    const name = pick(l10nOf(row.name), locale);
    return {
      id: row.id,
      slug: row.slug,
      name,
      subtitle: pick(l10nOf(row.variant_title), locale) || pick(l10nOf(row.short), locale) || null,
      platformSlug: row.platform_slug ?? null,
      grade: row.grade,
      batteryHealthPct: row.battery_health_pct ?? null,
      priceIqd: row.price_iqd,
      warrantyDays: row.warranty_days,
      image: imageRef(row.image, name, locale),
      hasRealPhotos: row.real_photos === 1,
      isDemo: row.is_demo === 1,
    };
  });
}
