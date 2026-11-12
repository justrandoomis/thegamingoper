/**
 * Catalogue read layer — product cards and used-unit cards (docs/CONTRACTS.md §2; types in ./types).
 *
 *   const cards = await getCardsByIds(db, ctx.locale, ["prd_…", "prd_…"]);               // in the order asked, unknown/unpublished skipped
 *   const page = await listCards(db, ctx.locale, { category: "games", sort: "price_asc", limit: 24, cursor, now: ctx.now });
 *   const shelf = await getNewArrivals(db, ctx.locale, { platform: "nintendo", limit: 6, now: ctx.now });
 *   const deals = await getDeals(db, ctx.locale, { now: ctx.now });                       // genuine reductions, biggest saving first
 *   const used = await getUsedSpotlight(db, ctx.locale, { limit: 4 });                    // listed used units, newest first
 *
 * PLATFORMS: a product's platforms are the RESEARCHED ones (researchedPlatformSql below — its own platform, else the
 * devices its game facts name, else its verified/partial compatibility rules), exactly as the catalog area's hubs
 * decide them, so `platform: "xbox"` includes the games sold for PlayStation AND Xbox and the headsets made for both.
 * Used units are devices and keep their own platform (`getUsedSpotlight`, like the used marketplace's filter).
 *
 * WHAT A CARD SAYS (design v2 spec §4.7, §4.11, §9; the rules are in ./card-facts.ts):
 *   · `compareAtIqd` only for a previous price the store really charged — an APPLIED price change set exactly this
 *     compare-at (admin pricing only applies one that passed the 90-days-charged rule) — or, on a demo row, the
 *     seed's demo value, flagged `compareAtDemo` (struck only under the demo marking, never worded as a saving).
 *   · `stock`: a demo row never says "low_stock" — its stock is a placeholder, so its scarcity is too.
 *   · `badge`: "preorder" (coming soon) › "deal" › "new" (`isNew`: released, or really listed, ≤ 30 days ago); none
 *     on a sold-out card (the card says «نفد» from `stock`).
 *   · `kindLabel` («جهاز PS5», «يد تحكم · PS5», «سماعة · متعددة المنصات») and `forPlatforms` (the dots) from the
 *     device families the product is for: the model it is, else its game facts, else its verified/partial rules.
 *   · `releaseAt` while coming soon; `image.opaque` for a photo that is not a cut-out (spec §7.5).
 *   · "featured" = the suggested order «المقترَح»: in stock, then coming soon, then sold out; newest first inside each
 *     (the platform hubs also lead with the platform's consoles — listing.server.ts).
 *
 * HOW (one round trip per call, no N+1)
 *   Every card query is ONE SQL statement built from the linear CTE chain in cardCtes():
 *     [filter CTEs: plat (researched platforms), cat (category subtree), fb/fit (device model), hit (search)]
 *     cv    active variants of published products that pass the product-level filters, with free units, low-stock
 *           threshold and complete bundle sets read by indexed correlated subqueries
 *     vs    the stock state of each variant (0 out · 1 low · 2 in, exactly as getAvailability() decides it), the
 *           best state per product, and the card variant as rn = 1 (CARD_VARIANT_ORDER_OF_CV: the first version on
 *           sale — the default when it is —, else the default)
 *     c     one row per product: card variant price, state, preorder flag, the shopping tier, the previous-price
 *           evidence (was), the release facts
 *   then filters on c, sort + keyset cursor, LIMIT, and — only for the rows of the page — the first picture, the
 *   review summary and the card facts (researched platforms, device families) as correlated subqueries. listCards
 *   sends the page and the total COUNT in one db.batch.
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
import { isNewProduct, kindLabelOf, qualifiedLine, qualifierOf, shownStockRank, withOpaque, type DeviceFamily } from "./card-facts";
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
 * Product-level scope: CTEs the filters need (named, at the top of the WITH clause) and conditions on products
 * (alias p). Each filter CTE is referenced exactly once, from `cv`.
 */
type Scope = { ctes: SQL[]; where: SQL[] };

/**
 * Free units of one variant over sellable, active locations (NULL when it has no stock rows). `alias` keeps the
 * nested copies of this subquery apart.
 */
const freeUnits = (variantId: SQL, alias: string): SQL => {
  const sl = sql.raw(`${alias}s`);
  const loc = sql.raw(`${alias}l`);
  return sql`(SELECT SUM(MAX(${sl}.on_hand - ${sl}.reserved, 0)) FROM stock_levels AS ${sl} JOIN inventory_locations AS ${loc} ON ${loc}.id = ${sl}.location_id WHERE ${sl}.variant_id = ${variantId} AND ${loc}.is_sellable = 1 AND ${loc}.is_active = 1)`;
};

/**
 * The stock state of one variant row of `cv` (0 out · 1 low · 2 in), exactly as getAvailability() decides it: a store
 * set counts complete sets, anything else its free units against the low-stock threshold.
 */
export const VARIANT_STATE_OF_CV = sql`(CASE
      WHEN cv.sets IS NOT NULL THEN (CASE WHEN cv.sets <= 0 THEN 0 WHEN cv.sets <= ${DEFAULT_LOW_STOCK} THEN 1 ELSE 2 END)
      WHEN COALESCE(cv.free, 0) <= 0 THEN 0
      WHEN cv.free <= cv.low THEN 1
      ELSE 2
    END)`;

/**
 * Which variant a product's card shows (rn = 1 in the window): the first version that can be bought now — the default
 * one when it can, else the next by sort — and the default only when no version can (sold out, or coming soon). A card
 * never prices a sold-out default while another version is on sale (the Steam Deck LCD: its default 256GB is sold out,
 * the 512GB is not), and the product page opens on that same version (product/useVariant.ts).
 */
export const CARD_VARIANT_ORDER_OF_CV = sql`CASE WHEN ${VARIANT_STATE_OF_CV} > 0 THEN 0 ELSE 1 END, cv.is_default DESC, cv.sort ASC, cv.id ASC`;

/**
 * The CTE chain shared by every card query (see the file header).
 *
 * D1 (workerd's SQLite) refuses a statement whose CTE references fan out too far ("VIEWs and/or subqueries nested
 * too deep"): every reference to a CTE expands that CTE's whole definition again, MATERIALIZED or not, so a chain
 * in which CTEs are referenced two or three times each grows exponentially. This chain is LINEAR — every CTE is
 * referenced once, by the next one — and per-variant stock comes from correlated subqueries (indexed lookups on
 * stock_levels' primary key), not from extra CTEs.
 */
function cardCtes(scope: Scope, now: number): SQL {
  const extra = scope.ctes.length > 0 ? sql`${sql.join(scope.ctes, sql`,\n`)},\n` : sql``;
  return sql`WITH RECURSIVE
${extra}cv AS (
  SELECT v.id, v.product_id, v.price_iqd, v.compare_at_iqd, v.is_default, v.sort,
    COUNT(*) OVER (PARTITION BY v.product_id) AS n,
    ${freeUnits(sql`v.id`, "f")} AS free,
    (SELECT CASE WHEN COUNT(ts.reorder_point) > 0 THEN SUM(ts.reorder_point) ELSE ${DEFAULT_LOW_STOCK} END
       FROM stock_levels AS ts JOIN inventory_locations AS tl ON tl.id = ts.location_id
       WHERE ts.variant_id = v.id AND tl.is_sellable = 1 AND tl.is_active = 1) AS low,
    (SELECT MIN(COALESCE(${freeUnits(sql`bi.component_variant_id`, "b")}, 0) / MAX(bi.qty, 1))
       FROM bundle_items AS bi WHERE bi.bundle_variant_id = v.id) AS sets
  FROM variants AS v
  JOIN products AS p ON p.id = v.product_id
  WHERE v.is_active = 1 AND p.status = 'published' AND ${andAll(scope.where)}
),
vs AS (
  SELECT cv.id, cv.product_id, cv.n, cv.price_iqd, cv.compare_at_iqd,
    ROW_NUMBER() OVER (PARTITION BY cv.product_id ORDER BY ${CARD_VARIANT_ORDER_OF_CV}) AS rn,
    MAX(${VARIANT_STATE_OF_CV}) OVER (PARTITION BY cv.product_id) AS best
  FROM cv
),
c AS (
  SELECT p.id, p.slug, p.kind, p.name, p.short, p.platform_id, p.is_demo,
    COALESCE(p.published_at, p.created_at) AS pub,
    d.id AS variant_id, d.price_iqd, d.compare_at_iqd, d.n AS variant_count,
    d.best AS st,
    CASE WHEN COALESCE(p.preorder_release_at, 0) > ${now} THEN 1 ELSE 0 END AS pre,
    CASE WHEN COALESCE(p.preorder_release_at, 0) > ${now} THEN 1 WHEN d.best > 0 THEN 2 ELSE 0 END AS tier,
    ${previousPriceEvidence(sql`d.id`, sql`d.price_iqd`, sql`d.compare_at_iqd`, sql`p.is_demo`)} AS was,
    p.preorder_release_at AS release_at,
    CASE WHEN json_valid(p.attributes) THEN json_extract(p.attributes, '$.catalogue.releaseDate') END AS released_on,
    CASE WHEN json_valid(p.attributes) THEN json_extract(p.attributes, '$.catalogue.kind') END AS research_kind,
    CASE WHEN json_valid(p.attributes) AND json_type(p.attributes, '$.qualifier') = 'object' THEN json_extract(p.attributes, '$.qualifier') END AS qualifier
  FROM vs AS d
  JOIN products AS p ON p.id = d.product_id
  WHERE d.rn = 1
)`;
}

/**
 * What backs a variant's compare-at price (design v2 spec §4.7, §13 row 8): 2 = the store really charged it — an
 * APPLIED price change set exactly this compare-at (admin pricing applies a compare-at only after its
 * 90-days-charged check, prices.server.ts compareAtCheck); 1 = a demo value on a demo row (the seed's demo deal:
 * shown only under the demo marking); 0 = nothing to strike (none, not above the price, or not backed).
 * The same expression in listing.server.ts and product.server.ts, so every surface strikes the same prices.
 */
export function previousPriceEvidence(variantId: SQL, price: SQL, compareAt: SQL, isDemo: SQL): SQL {
  return sql`(CASE WHEN ${compareAt} IS NULL OR ${compareAt} <= ${price} THEN 0
      WHEN EXISTS (SELECT 1 FROM price_changes AS pcw WHERE pcw.variant_id = ${variantId} AND pcw.status = 'applied' AND pcw.new_compare_at_iqd = ${compareAt}) THEN 2
      WHEN ${isDemo} = 1 THEN 1
      ELSE 0 END)`;
}

/**
 * The card facts of a page row (alias `page`), as one JSON object: `pl` = the active platforms the product is
 * RESEARCHED for ([slug, sort] pairs — researchedPlatformSql), `fam` = the device generations it is for
 * ([slug, sort, platform slug, platform sort, name]), `wide` = platforms a platform-wide rule names ([slug, sort]).
 * Families come from the first source that has any, like the researched platforms: the device model the product is
 * (or is made for), else the devices its game facts name, else its product-level verified/partial rules. Generations
 * of inactive platforms (the PC) are left out.
 */
const FACTS_OF_PAGE_ROW = sql`(
  SELECT json_object(
    'pl', json((SELECT json_group_array(json_array(fpl.slug, fpl.sort)) FROM platforms AS fpl WHERE fpl.is_active = 1 AND ${researchedPlatformSql("fp", "fpl")})),
    'fam', json((SELECT json_group_array(json_array(fg.slug, fg.sort, fgp.slug, fgp.sort, fg.name))
      FROM device_generations AS fg JOIN platforms AS fgp ON fgp.id = fg.platform_id AND fgp.is_active = 1
      WHERE fg.id IN (
        SELECT fdm.generation_id FROM device_models AS fdm WHERE fdm.id = fp.device_model_id
        UNION
        SELECT gdm.generation_id
          FROM json_each(CASE WHEN fp.device_model_id IS NULL AND json_valid(fp.attributes) THEN fp.attributes ELSE '{}' END, '$.game.platforms') AS fgame
          JOIN device_models AS gdm ON gdm.slug = fgame.value
        UNION
        SELECT CASE fr.target_type WHEN 'device_model' THEN (SELECT rdm.generation_id FROM device_models AS rdm WHERE rdm.id = fr.target_id) ELSE fr.target_id END
          FROM compatibility_rules AS fr
          WHERE fr.subject_type = 'product' AND fr.subject_id = fp.id AND fr.status IN ('verified', 'partial') AND fr.target_type IN ('device_model', 'generation')
            AND fp.device_model_id IS NULL
            AND (CASE WHEN json_valid(fp.attributes) THEN COALESCE(json_array_length(fp.attributes, '$.game.platforms'), 0) ELSE 0 END) = 0))),
    'wide', json((SELECT json_group_array(json_array(wp.slug, wp.sort))
      FROM compatibility_rules AS wr JOIN platforms AS wp ON wp.id = wr.target_id AND wp.is_active = 1
      WHERE wr.subject_type = 'product' AND wr.subject_id = fp.id AND wr.status IN ('verified', 'partial') AND wr.target_type = 'platform'
        AND fp.device_model_id IS NULL
        AND (CASE WHEN json_valid(fp.attributes) THEN COALESCE(json_array_length(fp.attributes, '$.game.platforms'), 0) ELSE 0 END) = 0))
  )
  FROM products AS fp WHERE fp.id = page.id
)`;

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

/**
 * ORDER BY for the rows of `alias` (they all carry the columns of c). Every order ends on the id: a total order.
 * "featured" is the suggested order: the shopping tier (2 in stock › 1 coming soon › 0 sold out), newest first inside.
 */
function orderBy(ordering: Ordering, alias: "c" | "page"): SQL {
  const a = sql.raw(alias);
  switch (ordering) {
    case "featured":
      return sql`${a}.tier DESC, ${a}.pub DESC, ${a}.id DESC`;
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

/**
 * Condition on a platforms row (alias `platform`): it is one of the platforms the product (alias `product`) is
 * RESEARCHED for — the rule of the demo import (app/server/db/seed/demo/import.ts platformsOf) and of the catalog
 * area's hubs (listing.server.ts):
 *   1. its own platform (`platform_id`) when it has one;
 *   2. else the platforms of the device models named in `attributes.game.platforms` (games sold for several);
 *   3. else the platforms of its product-level compatibility rules that are verified or partial (headsets,
 *      controllers and storage made for several platforms) — a rule on a device model, a generation or a platform.
 * Multi-platform products have no `platform_id`, so filtering on it alone misses them. Malformed `attributes` JSON
 * counts as "no game facts" instead of failing the statement. Callers make sure the platforms row is active.
 */
export function researchedPlatformSql(product: string, platform: string): SQL {
  const p = sql.raw(product);
  const pl = sql.raw(platform);
  const gamePlatforms = sql`(CASE WHEN json_valid(${p}.attributes) THEN COALESCE(json_array_length(${p}.attributes, '$.game.platforms'), 0) ELSE 0 END)`;
  return sql`(${pl}.id = ${p}.platform_id
    OR (${p}.platform_id IS NULL AND ${gamePlatforms} > 0
        AND ${pl}.id IN (SELECT rpm.platform_id FROM json_each(${p}.attributes, '$.game.platforms') AS rpg JOIN device_models AS rpm ON rpm.slug = rpg.value))
    OR (${p}.platform_id IS NULL AND ${gamePlatforms} = 0
        AND ${pl}.id IN (
          SELECT CASE rpr.target_type
                   WHEN 'device_model' THEN (SELECT rpd.platform_id FROM device_models AS rpd WHERE rpd.id = rpr.target_id)
                   WHEN 'generation' THEN (SELECT rpe.platform_id FROM device_generations AS rpe WHERE rpe.id = rpr.target_id)
                   ELSE rpr.target_id END
          FROM compatibility_rules AS rpr
          WHERE rpr.subject_type = 'product' AND rpr.subject_id = ${p}.id AND rpr.status IN ('verified', 'partial'))))`;
}

/** Product-level filters, shared by listCards and the shelves. */
function productScope(filters: CardFilters): Scope {
  const scope: Scope = { ctes: [], where: [] };
  const platforms = asList(filters.platform);
  if (platforms.length > 0) {
    // Products researched for one of the platforms (researchedPlatformSql: multi-platform games and headsets
    // included), worked out once per product in CTE `plat` rather than once per variant row of `cv`.
    scope.ctes.push(sql`plat(product_id) AS (
  SELECT DISTINCT rp.id
  FROM products AS rp JOIN platforms AS rpl ON rpl.is_active = 1 AND rpl.slug IN (SELECT value FROM json_each(${JSON.stringify(platforms)})) AND ${researchedPlatformSql("rp", "rpl")}
  WHERE rp.status = 'published'
)`);
    scope.where.push(sql`p.id IN (SELECT product_id FROM plat)`);
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
 *
 * `fb` packs both orderings into one number per subject — specificity × 10 + weakness (0 verified, 1 partial,
 * 2 unverified, 3 incompatible) — so MAX() picks the most specific rule (the unique edge index allows one rule per
 * subject and target, so there is no tie to break); the subject fits when the remainder is 0 or 1. Each CTE is
 * referenced once (see cardCtes()).
 */
function deviceModelCtes(model: string): SQL[] {
  return [
    sql`fb AS (
  SELECT r.subject_type, r.subject_id,
    MAX(CASE r.target_type WHEN 'device_model' THEN 30 WHEN 'generation' THEN 20 ELSE 10 END
      + CASE r.status WHEN 'verified' THEN 0 WHEN 'partial' THEN 1 WHEN 'unverified' THEN 2 ELSE 3 END) AS k
  FROM compatibility_rules AS r
  JOIN device_models AS dm ON dm.slug = ${model}
  WHERE (r.target_type = 'device_model' AND r.target_id = dm.id)
     OR (r.target_type = 'generation' AND r.target_id = dm.generation_id)
     OR (r.target_type = 'platform' AND r.target_id = dm.platform_id)
  GROUP BY r.subject_type, r.subject_id
)`,
    sql`fit(product_id) AS (
  SELECT CASE WHEN fb.subject_type = 'product' THEN fb.subject_id ELSE v.product_id END
  FROM fb LEFT JOIN variants AS v ON fb.subject_type = 'variant' AND v.id = fb.subject_id AND v.is_active = 1
  WHERE fb.k % 10 <= 1 AND (fb.subject_type = 'product' OR v.id IS NOT NULL)
  UNION
  SELECT p.id FROM products AS p JOIN device_models AS dm ON dm.id = p.device_model_id WHERE dm.slug = ${model}
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
  // a previous price the card would strike (really charged, or a demo value on a demo row)
  if (filters.dealsOnly) where.push(sql`c.was > 0`);
  return where;
}

/** The page statement: filtered, sorted and limited rows of c, then picture, rating, platform and facts for those rows only. */
function pageStatement(scope: Scope, cardWhere: SQL[], ordering: Ordering, limit: number | null, now: number): SQL {
  return sql`${cardCtes(scope, now)},
page AS (
  SELECT * FROM c WHERE ${andAll(cardWhere)} ORDER BY ${orderBy(ordering, "c")}${limit === null ? sql`` : sql` LIMIT ${limit}`}
)
SELECT page.*, pl.slug AS platform_slug, pl.name AS platform_name,
  ${IMAGE_OF_PAGE_ROW} AS image,
  ${RATING_OF_PAGE_ROW} AS rating,
  ${FACTS_OF_PAGE_ROW} AS facts
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
  /** 2 in stock · 1 coming soon · 0 sold out. */
  tier: number;
  /** previousPriceEvidence(): 2 really charged · 1 demo value on a demo row · 0 nothing to strike. */
  was: number;
  release_at: number | null;
  released_on: string | null;
  research_kind: string | null;
  /** attributes.qualifier as JSON text (an L10n), or null — card-facts.ts qualifierOf. */
  qualifier: string | null;
  platform_slug: string | null;
  platform_name: string | null;
  image: string | null;
  rating: string | null;
  facts: string | null;
};

type ImageJson = { a: string | null; k: string | null; w: number | null; h: number | null; alt: L10n | null; i: number | null };

/** FACTS_OF_PAGE_ROW as parsed: [slug, sort] platforms, [slug, sort, platform, platform sort, name] generations. */
type FactsJson = { pl?: [string, number][] | null; fam?: [string, number, string, number, string | null][] | null; wide?: [string, number][] | null };

/** The researched platforms (menu order) and the device families of a card, from its facts JSON. */
export function cardFamilies(raw: string | null): { forPlatforms: string[]; families: DeviceFamily[] } {
  const facts = parseJson<FactsJson>(raw) ?? {};
  const platforms = (Array.isArray(facts.pl) ? facts.pl : []).filter((entry) => Array.isArray(entry) && typeof entry[0] === "string");
  const forPlatforms = [...platforms].sort((a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0])).map((entry) => entry[0]);
  const families: DeviceFamily[] = [];
  for (const entry of Array.isArray(facts.fam) ? facts.fam : []) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[2] !== "string") continue;
    families.push({ generation: entry[0], generationSort: Number(entry[1]) || 0, platform: entry[2], platformSort: Number(entry[3]) || 0, generationName: typeof entry[4] === "string" ? entry[4] : null });
  }
  for (const entry of Array.isArray(facts.wide) ? facts.wide : []) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    families.push({ generation: null, generationSort: 0, platform: entry[0], platformSort: Number(entry[1]) || 0 });
  }
  return { forPlatforms: [...new Set(forPlatforms)], families };
}

function parseJson<T>(text: string | null | undefined): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const l10nOf = (value: unknown): L10n | null => (typeof value === "string" ? parseJson<L10n>(value) : (value as L10n | null));

/** The first picture JSON as an ImageRef, with its opaque-photo flag (card-facts.ts opaqueOf) when it is not a cut-out. */
function imageRef(raw: string | null, fallbackAlt: string, locale: Locale): ImageRef {
  const image = parseJson<ImageJson>(raw);
  if (!image) return { artKey: null, mediaKey: null, alt: fallbackAlt, isIllustration: true };
  const mediaKey = image.k ?? null;
  return withOpaque({
    artKey: mediaKey ? null : (image.a ?? null),
    mediaKey,
    alt: pick(image.alt, locale) || fallbackAlt,
    isIllustration: image.i !== 0,
    ...(mediaKey && image.w && image.h ? { width: image.w, height: image.h } : {}),
  });
}

function ratingOf(raw: string | null): RatingSummary | null {
  const rating = parseJson<{ avg: number | null; n: number }>(raw);
  if (!rating || !rating.n || rating.avg === null) return null;
  return { average: Math.round(rating.avg * 10) / 10, count: rating.n };
}

const STOCK_BY_RANK: readonly StockState[] = ["out_of_stock", "low_stock", "in_stock"];

function toCard(row: CardRow, locale: Locale, now: number): ProductCardData {
  const name = pick(l10nOf(row.name), locale);
  const was = Number(row.was);
  const compareAtIqd = was > 0 && row.compare_at_iqd !== null && row.compare_at_iqd > row.price_iqd ? row.compare_at_iqd : null;
  const preorder = row.pre === 1;
  const isDemo = row.is_demo === 1;
  const stock: StockState = preorder ? "preorder" : (STOCK_BY_RANK[shownStockRank(row.st, isDemo)] ?? "out_of_stock");
  const isNew = !preorder && isNewProduct({ releasedOn: row.released_on, listedAt: Number(row.pub), isDemo, now });
  const { forPlatforms, families } = cardFamilies(row.facts);
  return {
    id: row.id,
    slug: row.slug,
    name,
    // the qualifier a Latin title leaves out («نسخة الأقراص») opens the meta line, never the name (spec §4.11)
    subtitle: qualifiedLine(qualifierOf({ qualifier: l10nOf(row.qualifier) }, locale), pick(l10nOf(row.short), locale)),
    kind: row.kind,
    platformSlug: row.platform_slug ?? null,
    platformName: row.platform_name ? pick(l10nOf(row.platform_name), locale) || null : null,
    variantId: row.variant_id,
    hasVariants: row.variant_count > 1,
    priceIqd: row.price_iqd,
    compareAtIqd,
    compareAtDemo: compareAtIqd !== null && was === 1,
    stock,
    // one badge: coming soon › a struck previous price › new; a sold-out card says «نفد» from its stock instead
    badge: preorder ? "preorder" : stock === "out_of_stock" ? null : compareAtIqd !== null ? "deal" : isNew ? "new" : null,
    isNew,
    kindLabel: kindLabelOf({ kind: row.kind, researchKind: row.research_kind, families, forPlatforms, ownPlatform: row.platform_slug, ownPlatformName: row.platform_name }, locale),
    forPlatforms,
    releaseAt: preorder && row.release_at !== null ? Number(row.release_at) : null,
    image: imageRef(row.image, name, locale),
    rating: ratingOf(row.rating),
    isDemo,
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
  const key = sort === "featured" ? [row.tier, row.pub, row.id] : sort === "newest" ? [row.pub, row.id] : [row.price_iqd, row.id];
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
      const [tier, pub, id] = values;
      return sql`(c.tier < ${tier} OR (c.tier = ${tier} AND c.pub < ${pub}) OR (c.tier = ${tier} AND c.pub = ${pub} AND c.id < ${id}))`;
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
  const byId = new Map(rows.map((row) => [row.id, toCard(row, locale, now)]));
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
    items: items.map((row) => toCard(row, locale, now)),
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
 * Previous prices the card strikes only: the card variant's compare-at is above its price AND backed — an applied
 * price change set it (really charged), or it is a demo row's demo value (each card says which: `compareAtDemo`).
 * In stock only, biggest saving (in percent) first.
 */
export async function getDeals(db: Db, locale: Locale, options: ShelfOptions = {}): Promise<ProductCardData[]> {
  const input = parse(ShelfSchema, options);
  const now = input.now ?? Date.now();
  const filters: CardFilters = { platform: input.platform, dealsOnly: true, inStockOnly: true };
  const rows = await runPage(db, pageStatement(productScope(filters), cardFilters(filters), "saving", input.limit ?? 12, now));
  return rows.map((row) => toCard(row, locale, now));
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
