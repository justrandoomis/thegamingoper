/**
 * The home page's data (docs/areas/home.md) — composed from the catalogue read layer (catalog/cards.server.ts) and a
 * few reads of its own. Read-only, except recordPersonalizationConsent (one consent row).
 *
 *   const home = await getHomeData(db, { locale: ctx.locale, now: ctx.now, extraShelves: false });
 *   home.platforms        the four platforms of the key bank, each with its hero and its shelves (product ids)
 *   home.cards            every product card those lists name, once (id → ProductCardData)
 *   home.deals            genuine reductions only (getDeals: compare-at above the price), store-wide
 *   home.used             listed used units (getUsedSpotlight)
 *   home.comingSoon       pre-orders and unreleased variants, with the release dates from the research and their
 *                         platform line (platformSlug, forPlatforms, kindLabel — no second card read needed)
 *   home.layout           the sections below the hero in the order the page draws them: the staff's arrangement from
 *                         the content module (getHomeLayout, admin 17.01) once they saved one, else the page's own
 *   `extraShelves: false` leaves out the games and gear shelves and the deals (empty), which the v2 page does not show.
 *
 * THE PINNED HERO (admin 17.01, getHomeHero): staff may pin a product and a headline on a platform's stage for a
 * period. The pin is used only while its product can be bought now and has a photo (the same test as the automatic
 * pick) — otherwise the platform's automatic hero stands, as if nothing were pinned. Demo pins are never read. A pin
 * takes the stage only: the platform's own lead device stays in `lead` for the page's other pictures of its console.
 *
 * HONESTY RULES (what the page may say)
 *   · Shelves are store suggestions with a written rule ("the newest in stock"), never "trending" or "customers also
 *     bought": the store has no sales, view or review aggregates to rank by (no orders exist in the demo data).
 *   · A product belongs to a platform when it is made for it (`products.platform_id`) or — for products sold for
 *     several platforms, which have no platform_id — when it has a VERIFIED or PARTIAL compatibility rule for one of
 *     the platform's device models, generations or the platform itself. An unverified or incompatible rule never
 *     puts a product on a platform's shelf (brief §6: compatibility is a hard filter).
 *   · Shelves only hold what can be bought now (stock state in_stock / low_stock from the card read layer). Pre-orders
 *     cannot be added to the cart (the commerce core has no pre-order flow), so they appear only in `comingSoon`,
 *     with their release date and no add key.
 *   · The hero of a platform is its lead device — the first device model of the platform in the store's own order
 *     (device_models.sort) whose base product can be bought now — or, when a base model of the platform came out in
 *     the last NEW_RELEASE_DAYS days and can be bought, that one ("new"). A model's base product is the product named
 *     like the model ("Nintendo Switch 2", not one of its bundles). Products the research marks discontinued are
 *     not featured.
 *
 * COST: one db.batch with three small statements (platform membership + ranking, console candidates, coming soon),
 * then in parallel: the cards of every id it named (getCardsByIds, ≤ 100 ids per statement), the deals and the used
 * spotlight. Nothing here selects cost, stock quantities, serials or any customer data.
 *
 * Services take `db` first and never import "cloudflare:workers" (tests run them against a local D1).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ImageRef, ProductCardData, UsedUnitCardData } from "~/lib/dto";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { consents } from "~/server/db/schema";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { invalid } from "~/server/errors";
import { getHomeHero, getHomeLayout, type HeroPinView } from "~/server/services/admin/cms/home.server";
import { HOME_SECTIONS, type HomeSectionKind } from "~/server/services/admin/cms/rules";
import { kindLabelOf } from "~/server/services/catalog/card-facts";
import { MAX_CARD_IDS, getCardsByIds, getDeals, getUsedSpotlight } from "~/server/services/catalog/cards.server";
import { gelOfPlatformName } from "~/server/services/catalog/product-types";

// ───────────────────────────────────────────────────────────────── constants

/** The four platforms of the key bank (DESIGN.md §2) — the same list as PLATFORMS in ~/ui/PlatformLed. */
export const HOME_PLATFORMS = ["nintendo", "playstation", "xbox", "handheld"] as const;
export type HomePlatformSlug = (typeof HOME_PLATFORMS)[number];

export const isHomePlatform = (value: unknown): value is HomePlatformSlug => typeof value === "string" && (HOME_PLATFORMS as readonly string[]).includes(value);

/** A base model released at most this many days ago leads its platform's hero as "new" ("وصل …"). */
export const NEW_RELEASE_DAYS = 120;

/** What the page shows per platform. */
export const SHELF_SIZES = { newArrivals: 6, games: 8, gear: 8 } as const;

/** Store-wide shelves. */
export const DEALS_LIMIT = 12;
export const USED_LIMIT = 8;

/** Recently viewed: at most this many ids per request (the browser keeps the same number). */
export const RECENT_MAX = 12;

/** Candidates read per platform before the stock filter and the de-duplication (a buffer for out-of-stock items). */
const CANDIDATES = { all: 10, kind: 12 } as const;

const GEAR_KINDS = ["controller", "headset", "storage", "accessory"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Asia/Baghdad is UTC+3 all year (no DST): release dates are calendar days there. */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────── types

export type HomeHero = {
  productId: string;
  /** "new": a base model released within NEW_RELEASE_DAYS. "lead": the platform's lead device (and a pinned hero). */
  mode: "new" | "lead";
  /** The release date from the research ("YYYY-MM-DD"), when known. */
  releasedOn: string | null;
  /** Staff pinned this product with their own headline (admin 17.01); null for the automatic pick. */
  pin?: HomeHeroPin | null;
};

/** A pinned hero's words, in the page's language when the pin has them, else in Arabic (`textLocale`). */
export type HomeHeroPin = { pinId: string; headline: string; deck: string | null; textLocale: Locale };

/**
 * The home page's sections below the hero in the page's OWN order (Design System v2 §6.1): the platform tiles (the
 * trust strip follows them), new arrivals, the release band, used units, the trade-in and support doors
 * ("used_repairs"), the departments ("accessories"), the personal shelves and the personalisation panel. The content
 * module's other kinds ("games", "deals") have no section on this page.
 */
export const HOME_PAGE_SECTIONS = ["platforms", "new_arrivals", "coming_soon", "used", "used_repairs", "accessories", "recently_viewed", "recommendations", "personal"] as const satisfies readonly HomeSectionKind[];
export type HomePageSection = (typeof HOME_PAGE_SECTIONS)[number];

export type HomeLayout = {
  /** The sections to draw, in order ("personal" is always there: it holds the shopper's privacy controls). */
  sections: HomePageSection[];
  /** True once staff saved an arrangement (else the page's own order). */
  arranged: boolean;
};

export type HomePlatform = {
  slug: HomePlatformSlug;
  /** The platform's name from the catalogue (the page prefers the design system's names for the known four). */
  name: string;
  /** What the hero band features for this platform: a standing staff pin, else the lead device (`lead`). */
  hero: HomeHero | null;
  /**
   * The platform's own lead device (pickHero) — the hero whenever nothing is pinned. The page's other pictures of the
   * platform's console (the trade-in door, the intro's corner objects) use it while a pin stands: a pinned game is the
   * campaign, never "trade in your device" (review 2026-11-12).
   */
  lead: HomeHero | null;
  /** Product ids, newest in the store first, all buyable now. */
  newArrivals: string[];
  /** Games for the platform, newest first, without the ones already in newArrivals. */
  games: string[];
  /** Controllers, headsets, storage and accessories for the platform, newest first, without newArrivals. */
  gear: string[];
};

export type ComingSoonItem = {
  /** Unique on the page: the product id, or product id + release day for unreleased variants. */
  key: string;
  productId: string;
  slug: string;
  name: string;
  /** The variant(s) still to come ("DualSense – Prism Flare Orange"), or the product's own subtitle. */
  detail: string | null;
  /** 0 for a pre-order product; otherwise how many of its variants come out that day. */
  variantCount: number;
  /** Midnight in Baghdad of the release day (epoch ms). */
  releaseAt: number;
  priceIqd: number;
  image: ImageRef;
  isDemo: boolean;
  /**
   * The one platform the coming item is for (its dot): for a product, its single researched platform (the card's
   * `forPlatforms`, else its own platform); for later versions of a product, the platform those versions name
   * (variant option "PS5" → "playstation"), else the product's. Null when it is for several platforms or none.
   */
  platformSlug: string | null;
  /** Every platform it is for, in menu order (two dots for a multi-platform item); [] when none is known. */
  forPlatforms: string[];
  /**
   * Its platform line, localized: the product card's `kindLabel` («لعبة PS5», «سماعة · PS5», «لعبة متعددة المنصات»);
   * for versions that name another platform than the product's line, the kind with that platform («لعبة PlayStation»).
   * Null when unknown.
   */
  kindLabel: string | null;
};

export type HomeData = {
  platforms: HomePlatform[];
  cards: Record<string, ProductCardData>;
  deals: string[];
  used: UsedUnitCardData[];
  comingSoon: ComingSoonItem[];
  /** The sections below the hero and their order (homeLayoutOf). */
  layout: HomeLayout;
};

// ───────────────────────────────────────────────────────────────── reads

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

function parseL10n(value: unknown): L10n | null {
  if (value && typeof value === "object") return value as L10n;
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(value) as L10n;
  } catch {
    return null;
  }
}

/**
 * Which products are on which platform, ranked newest first (COALESCE(published_at, created_at): when the store put
 * them on sale) — overall (rn_all) and within their shelf group (rn_kind: g = games, a = gear, o = the rest).
 * Platform membership: see the file header. Each CTE is referenced once (D1's nesting limit, cards.server.ts).
 * `perKind` false: only the overall candidates (the games and gear shelves are not wanted).
 */
function membershipStatement(perKind = true) {
  const gear = sql.join(
    GEAR_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql`
WITH member(product_id, platform) AS (
  SELECT p.id, pl.slug
  FROM products AS p
  JOIN platforms AS pl ON pl.id = p.platform_id AND pl.is_active = 1
  WHERE p.status = 'published'
  UNION
  SELECT CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE v.product_id END, pl.slug
  FROM compatibility_rules AS r
  LEFT JOIN variants AS v ON r.subject_type = 'variant' AND v.id = r.subject_id AND v.is_active = 1
  LEFT JOIN device_models AS dm ON r.target_type = 'device_model' AND dm.id = r.target_id
  LEFT JOIN device_generations AS g ON r.target_type = 'generation' AND g.id = r.target_id
  JOIN platforms AS pl ON pl.is_active = 1
    AND pl.id = (CASE r.target_type WHEN 'platform' THEN r.target_id WHEN 'generation' THEN g.platform_id ELSE dm.platform_id END)
  WHERE r.status IN ('verified', 'partial') AND (r.subject_type = 'product' OR v.id IS NOT NULL)
),
ranked AS (
  SELECT m.product_id, m.platform,
    CASE WHEN p.kind = 'game' THEN 'g' WHEN p.kind IN (${gear}) THEN 'a' ELSE 'o' END AS grp,
    ROW_NUMBER() OVER (PARTITION BY m.platform ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC) AS rn_all,
    ROW_NUMBER() OVER (
      PARTITION BY m.platform, CASE WHEN p.kind = 'game' THEN 'g' WHEN p.kind IN (${gear}) THEN 'a' ELSE 'o' END
      ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
    ) AS rn_kind
  FROM member AS m
  JOIN products AS p ON p.id = m.product_id
  WHERE p.status = 'published'
)
SELECT product_id, platform, grp, rn_all, rn_kind
FROM ranked
WHERE rn_all <= ${CANDIDATES.all}${perKind ? sql` OR (grp <> 'o' AND rn_kind <= ${CANDIDATES.kind})` : sql``}
ORDER BY platform, rn_all`;
}

export type MemberRow = { product_id: string; platform: string; grp: "g" | "a" | "o"; rn_all: number; rn_kind: number };

/** Active platforms (menu order) and every published console of them, with its device model — the hero candidates. */
const PLATFORMS_SQL = sql`SELECT id, slug, name FROM platforms WHERE is_active = 1 ORDER BY sort, id`;

const CONSOLES_SQL = sql`
SELECT p.id, pl.slug AS platform, p.name, dm.name AS model_name, dm.sort AS model_sort,
  json_extract(p.attributes, '$.catalogue.releaseDate') AS released,
  json_extract(p.attributes, '$.catalogue.status') AS research_status,
  COALESCE(p.published_at, p.created_at) AS pub
FROM products AS p
JOIN platforms AS pl ON pl.id = p.platform_id AND pl.is_active = 1
LEFT JOIN device_models AS dm ON dm.id = p.device_model_id
WHERE p.status = 'published' AND p.kind = 'console'`;

type PlatformRow = { id: string; slug: string; name: string | null };
type ConsoleRow = {
  id: string;
  platform: string;
  name: string | null;
  model_name: string | null;
  model_sort: number | null;
  released: string | null;
  research_status: string | null;
  pub: number;
};

/**
 * Coming soon: products whose release day is still ahead (`preorder_release_at`, set by the catalogue import), and
 * variants that come out after their product (attributes.variantReleaseDates — per SKU, "YYYY-MM-DD"). The variant
 * rows carry the variant's own first picture when it has one. Filtering by date happens in code (one rule for both).
 */
function comingSoonStatement(now: number) {
  return sql`
SELECT p.id AS product_id, p.preorder_release_at AS release_at, NULL AS sku, NULL AS release_day, NULL AS title,
  NULL AS price_iqd, NULL AS art_key, NULL AS alt, NULL AS platform_option
FROM products AS p
WHERE p.status = 'published' AND p.preorder_release_at > ${now}
UNION ALL
SELECT p.id, NULL, v.sku, je.value, v.title, v.price_iqd,
  (SELECT m.art_key FROM media AS m WHERE m.owner_type = 'variant' AND m.owner_id = v.id AND m.art_key IS NOT NULL AND m.kind IN ('image', 'render') ORDER BY m.sort, m.id LIMIT 1),
  (SELECT m.alt FROM media AS m WHERE m.owner_type = 'variant' AND m.owner_id = v.id AND m.art_key IS NOT NULL AND m.kind IN ('image', 'render') ORDER BY m.sort, m.id LIMIT 1),
  CASE WHEN json_valid(v.options) THEN json_extract(v.options, '$.platform') END
FROM products AS p
JOIN json_each(p.attributes, '$.variantReleaseDates') AS je
JOIN variants AS v ON v.product_id = p.id AND v.sku = je.key AND v.is_active = 1
WHERE p.status = 'published' AND json_type(p.attributes, '$.variantReleaseDates') = 'object'`;
}

export type ComingRow = {
  product_id: string;
  release_at: number | null;
  sku: string | null;
  release_day: string | null;
  title: string | null;
  price_iqd: number | null;
  art_key: string | null;
  alt: string | null;
  /** The version's platform option ("PS5", "Xbox Series X"), when it has one (variant rows only). */
  platform_option?: string | null;
};

// ───────────────────────────────────────────────────────────────── rules (pure, exported for tests)

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-19" → epoch ms of midnight in Baghdad that day; null for anything else. */
export function baghdadMidnight(day: string | null | undefined): number | null {
  const match = typeof day === "string" ? DAY_RE.exec(day) : null;
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - BAGHDAD_OFFSET_MS;
  return Number.isFinite(ms) ? ms : null;
}

/** Whole days from a release day to `now` (negative while it is still ahead). */
export function daysSinceRelease(day: string | null | undefined, now: number): number | null {
  const at = baghdadMidnight(day);
  return at === null ? null : Math.floor((now - at) / DAY_MS);
}

/** In stock or low stock: what a shelf may show and the hero may offer. */
export const isBuyable = (card: ProductCardData | undefined): card is ProductCardData => card !== undefined && (card.stock === "in_stock" || card.stock === "low_stock");

const normalizeName = (text: string | undefined) => (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** A model's base product: the product named exactly like its device model in some language. */
function isBaseModel(name: L10n | null, model: L10n | null): boolean {
  if (!name || !model) return false;
  return (["ar", "en", "ckb"] as const).some((code) => {
    const a = normalizeName(name[code]);
    return a !== "" && a === normalizeName(model[code]);
  });
}

export type HeroCandidate = {
  id: string;
  name: L10n | null;
  modelName: L10n | null;
  modelSort: number | null;
  released: string | null;
  discontinued: boolean;
  pub: number;
};

/**
 * The hero of one platform (file header): a buyable base model released within NEW_RELEASE_DAYS ("new"), else the
 * lead device — the first device model in the store's order, its base product first, then the shorter name —
 * among buyable products that the research does not mark discontinued; else any buyable console; else null.
 */
export function pickHero(candidates: readonly HeroCandidate[], cards: ReadonlyMap<string, ProductCardData>, now: number): HomeHero | null {
  // a hero stands on the stage as its photo: no picture, no hero
  const buyable = candidates.filter((candidate) => {
    const card = cards.get(candidate.id);
    return isBuyable(card) && Boolean(card.image.artKey || card.image.mediaKey);
  });
  const current = buyable.filter((candidate) => !candidate.discontinued);

  const fresh = current
    .filter((candidate) => isBaseModel(candidate.name, candidate.modelName))
    .map((candidate) => ({ candidate, days: daysSinceRelease(candidate.released, now) }))
    .filter((entry): entry is { candidate: HeroCandidate; days: number } => entry.days !== null && entry.days >= 0 && entry.days <= NEW_RELEASE_DAYS)
    .sort((a, b) => a.days - b.days || b.candidate.pub - a.candidate.pub);
  if (fresh[0]) return { productId: fresh[0].candidate.id, mode: "new", releasedOn: fresh[0].candidate.released };

  const order = (list: readonly HeroCandidate[]) =>
    [...list].sort(
      (a, b) =>
        (a.modelSort ?? Number.MAX_SAFE_INTEGER) - (b.modelSort ?? Number.MAX_SAFE_INTEGER) ||
        Number(isBaseModel(b.name, b.modelName)) - Number(isBaseModel(a.name, a.modelName)) ||
        normalizeName(a.name?.en ?? a.name?.ar).length - normalizeName(b.name?.en ?? b.name?.ar).length ||
        b.pub - a.pub ||
        a.id.localeCompare(b.id),
    );
  const lead = order(current)[0] ?? order(buyable)[0];
  return lead ? { productId: lead.id, mode: "lead", releasedOn: lead.released } : null;
}

/**
 * The shelves of one platform from its ranked members: new arrivals = the newest buyable products of any kind;
 * games and gear = the newest buyable ones of their kinds that are not already among the new arrivals.
 */
export function composeShelves(members: readonly MemberRow[], cards: ReadonlyMap<string, ProductCardData>): Pick<HomePlatform, "newArrivals" | "games" | "gear"> {
  const byAll = [...members].sort((a, b) => a.rn_all - b.rn_all);
  const newArrivals = unique(byAll.filter((row) => isBuyable(cards.get(row.product_id))).map((row) => row.product_id)).slice(0, SHELF_SIZES.newArrivals);
  const shown = new Set(newArrivals);
  const ofGroup = (grp: MemberRow["grp"], size: number) =>
    unique(
      [...members]
        .filter((row) => row.grp === grp && !shown.has(row.product_id) && isBuyable(cards.get(row.product_id)))
        .sort((a, b) => a.rn_kind - b.rn_kind)
        .map((row) => row.product_id),
    ).slice(0, size);
  return { newArrivals, games: ofGroup("g", SHELF_SIZES.games), gear: ofGroup("a", SHELF_SIZES.gear) };
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** The platforms a card is for (its dots), in menu order: its researched platforms, else its own platform. */
const platformsOfCard = (card: ProductCardData): string[] => (card.forPlatforms && card.forPlatforms.length > 0 ? [...card.forPlatforms] : card.platformSlug ? [card.platformSlug] : []);

/** A coming item's platform line from its product's card (ComingSoonItem.platformSlug / forPlatforms / kindLabel). */
function cardPlatformFacts(card: ProductCardData): Pick<ComingSoonItem, "platformSlug" | "forPlatforms" | "kindLabel"> {
  const platforms = platformsOfCard(card);
  return { platformSlug: platforms.length === 1 ? platforms[0] : null, forPlatforms: platforms, kindLabel: card.kindLabel ?? null };
}

/**
 * The platform line of a later version: the platform its option names ("PS5" → playstation: the PS5 version of a game
 * that is out on Xbox) when that says more than the product's line, else the product's line.
 */
function versionPlatformFacts(card: ProductCardData, option: string | null | undefined, locale: Locale): Pick<ComingSoonItem, "platformSlug" | "forPlatforms" | "kindLabel"> {
  const facts = cardPlatformFacts(card);
  const named = gelOfPlatformName(option);
  if (!named || facts.platformSlug === named) return facts;
  return { platformSlug: named, forPlatforms: [named], kindLabel: kindLabelOf({ kind: card.kind, families: [], ownPlatform: named }, locale) };
}

/** Pre-orders and unreleased variants still ahead of `now`, soonest first; variants of one product and day grouped. */
export function composeComingSoon(rows: readonly ComingRow[], cards: ReadonlyMap<string, ProductCardData>, locale: Locale, now: number): ComingSoonItem[] {
  const items = new Map<string, ComingSoonItem>();
  // pre-order products first: their variants are not listed again
  for (const row of rows) {
    const card = cards.get(row.product_id);
    if (!card || row.sku !== null || row.release_at === null || row.release_at <= now) continue; // unpublished / no active variant / released
    items.set(row.product_id, {
      key: row.product_id,
      productId: row.product_id,
      slug: card.slug,
      name: card.name,
      detail: card.subtitle,
      variantCount: 0,
      releaseAt: row.release_at,
      priceIqd: card.priceIqd,
      image: card.image,
      isDemo: card.isDemo,
      ...cardPlatformFacts(card),
    });
  }
  for (const row of rows) {
    const card = cards.get(row.product_id);
    if (!card || row.sku === null || items.has(row.product_id)) continue;
    const releaseAt = baghdadMidnight(row.release_day);
    if (releaseAt === null || releaseAt <= now) continue;
    const key = `${row.product_id}:${row.release_day}`;
    const title = pick(parseL10n(row.title), locale) || null;
    const facts = versionPlatformFacts(card, row.platform_option, locale);
    const existing = items.get(key);
    if (existing) {
      existing.variantCount += 1;
      existing.priceIqd = Math.min(existing.priceIqd, row.price_iqd ?? existing.priceIqd);
      if (existing.image.artKey === card.image.artKey && row.art_key) existing.image = { artKey: row.art_key, mediaKey: null, alt: pick(parseL10n(row.alt), locale) || title || card.name, isIllustration: false };
      // versions of one day for different platforms: the product's own line covers them all
      if (existing.platformSlug !== facts.platformSlug) Object.assign(existing, cardPlatformFacts(card));
      continue;
    }
    items.set(key, {
      key,
      productId: row.product_id,
      slug: card.slug,
      name: card.name,
      detail: title,
      variantCount: 1,
      releaseAt,
      priceIqd: typeof row.price_iqd === "number" ? row.price_iqd : card.priceIqd,
      image: row.art_key ? { artKey: row.art_key, mediaKey: null, alt: pick(parseL10n(row.alt), locale) || title || card.name, isIllustration: false } : card.image,
      isDemo: card.isDemo,
      ...facts,
    });
  }
  return [...items.values()].sort((a, b) => a.releaseAt - b.releaseAt || a.name.localeCompare(b.name));
}

/**
 * The sections the page draws, in order: the staff's arrangement (getHomeLayout: hidden ones left out, "personal"
 * always kept) once they saved one, else the page's own order (HOME_PAGE_SECTIONS). getHomeLayout answers the content
 * module's default list until something is saved, so exactly that list reads as "not arranged" — the module's preview
 * calls it «الصفحة بترتيبها الأصلي». Kinds without a section on this page are skipped. Pure.
 */
export function homeLayoutOf(layout: readonly string[] | null | undefined): HomeLayout {
  const untouched = !layout || (layout.length === HOME_SECTIONS.length && layout.every((kind, index) => kind === HOME_SECTIONS[index]));
  if (untouched) return { sections: [...HOME_PAGE_SECTIONS], arranged: false };
  const sections: HomePageSection[] = [];
  for (const kind of layout) if ((HOME_PAGE_SECTIONS as readonly string[]).includes(kind) && !sections.includes(kind as HomePageSection)) sections.push(kind as HomePageSection);
  if (!sections.includes("personal")) sections.push("personal");
  return { sections, arranged: true };
}

/** A card the hero may feature: buyable now and with a photo (the hero stands on the stage as its photo). */
const heroWorthy = (card: ProductCardData | undefined): card is ProductCardData => isBuyable(card) && Boolean(card.image.artKey || card.image.mediaKey);

/**
 * A platform's pinned hero, or null when the pin cannot stand: its product is not buyable now or has no photo — then
 * the automatic pick stays (pickHero). The words: the page's language when the pin has a headline in it, else Arabic
 * (the pin's source language); the deck only in that same language. Pure.
 */
export function pinnedHero(pin: Pick<HeroPinView, "pinId" | "productId" | "headline" | "deck"> | undefined, cards: ReadonlyMap<string, ProductCardData>, locale: Locale): HomeHero | null {
  if (!pin || !heroWorthy(cards.get(pin.productId))) return null;
  const own = (pin.headline[locale] ?? "").trim();
  const textLocale: Locale = own ? locale : "ar";
  const headline = (pin.headline[textLocale] ?? "").trim();
  if (!headline) return null;
  const deck = pin.deck ? (pin.deck[textLocale] ?? "").trim() || null : null;
  return { productId: pin.productId, mode: "lead", releasedOn: null, pin: { pinId: pin.pinId, headline, deck, textLocale } };
}

// ───────────────────────────────────────────────────────────────── public API

async function cardsFor(db: Db, locale: Locale, ids: readonly string[], now: number): Promise<Map<string, ProductCardData>> {
  const list = unique(ids);
  const chunks: string[][] = [];
  for (let start = 0; start < list.length; start += MAX_CARD_IDS) chunks.push(list.slice(start, start + MAX_CARD_IDS));
  const pages = await Promise.all(chunks.map((chunk) => getCardsByIds(db, locale, chunk, { now })));
  return new Map(pages.flat().map((card) => [card.id, card]));
}

export type HomeDataOptions = {
  locale: Locale;
  now: number;
  /**
   * false: leave out what the v2 home page no longer shows — the games and gear shelves (HomePlatform.games / .gear
   * come back empty) and the store-wide deals (HomeData.deals empty): fewer candidates, fewer cards and one card
   * query less on every home request. Default true (everything).
   */
  extraShelves?: boolean;
};

/**
 * Everything the home page shows, for one language. `now` decides pre-orders and "new". Never throws for an empty
 * catalogue: platforms without products have no hero and empty shelves.
 */
export async function getHomeData(db: Db, options: HomeDataOptions): Promise<HomeData> {
  const { locale, now } = options;
  const extras = options.extraShelves !== false;
  const [[platformResult, memberResult, consoleResult, comingResult], pins, arrangement] = await Promise.all([
    runBatch(db, [batchSql(db, PLATFORMS_SQL), batchSql(db, membershipStatement(extras)), batchSql(db, CONSOLES_SQL), batchSql(db, comingSoonStatement(now))]),
    // the content module (admin 17.01): pinned heroes running now (never demo pins) and the sections' arrangement
    getHomeHero(db, now),
    getHomeLayout(db),
  ]);
  const platforms = rowsOf<PlatformRow>(platformResult).filter((row): row is PlatformRow & { slug: HomePlatformSlug } => isHomePlatform(row.slug));
  const members = rowsOf<MemberRow>(memberResult);
  const consoles = rowsOf<ConsoleRow>(consoleResult);
  const coming = rowsOf<ComingRow>(comingResult);

  const ids = [...consoles.map((row) => row.id), ...members.map((row) => row.product_id), ...coming.map((row) => row.product_id), ...pins.map((pin) => pin.productId)];
  const [cards, deals, used] = await Promise.all([
    cardsFor(db, locale, ids, now),
    extras ? getDeals(db, locale, { limit: DEALS_LIMIT, now }) : Promise.resolve([] as ProductCardData[]),
    getUsedSpotlight(db, locale, { limit: USED_LIMIT }),
  ]);

  const homePlatforms: HomePlatform[] = platforms.map((platform) => {
    const candidates: HeroCandidate[] = consoles
      .filter((row) => row.platform === platform.slug)
      .map((row) => ({
        id: row.id,
        name: parseL10n(row.name),
        modelName: parseL10n(row.model_name),
        modelSort: row.model_sort,
        released: row.released,
        discontinued: row.research_status === "discontinued",
        pub: Number(row.pub),
      }));
    const shelves = composeShelves(
      members.filter((row) => row.platform === platform.slug),
      cards,
    );
    const lead = pickHero(candidates, cards, now);
    return {
      slug: platform.slug,
      name: pick(parseL10n(platform.name), locale) || platform.slug,
      // a pin stands only while its product can be bought and has a photo; else the automatic pick, as without one
      hero:
        pinnedHero(
          pins.find((pin) => pin.platform === platform.slug),
          cards,
          locale,
        ) ?? lead,
      lead,
      newArrivals: shelves.newArrivals,
      games: extras ? shelves.games : [],
      gear: extras ? shelves.gear : [],
    };
  });

  // Only the cards the page names travel to the browser.
  const named = new Set<string>();
  for (const platform of homePlatforms) {
    if (platform.hero) named.add(platform.hero.productId);
    if (platform.lead) named.add(platform.lead.productId);
    for (const id of [...platform.newArrivals, ...platform.games, ...platform.gear]) named.add(id);
  }
  const out: Record<string, ProductCardData> = {};
  for (const id of named) {
    const card = cards.get(id);
    if (card) out[id] = card;
  }
  for (const card of deals) out[card.id] = card;

  return {
    platforms: homePlatforms,
    cards: out,
    deals: deals.map((card) => card.id),
    used,
    comingSoon: composeComingSoon(coming, cards, locale, now),
    layout: homeLayoutOf(arrangement),
  };
}

const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Cards for the ids the browser remembers (most recent first, at most RECENT_MAX), in that order; ids that are
 * unknown, unpublished or without an active variant are skipped. Malformed input → AppError("invalid", 400).
 */
export async function getRecentlyViewedCards(db: Db, locale: Locale, ids: readonly unknown[], now: number): Promise<ProductCardData[]> {
  if (ids.length > RECENT_MAX) throw invalid({ ids: "too_big" }, "home.recent");
  if (ids.some((id) => typeof id !== "string" || !PRODUCT_ID.test(id))) throw invalid({ ids: "invalid" }, "home.recent");
  return getCardsByIds(db, locale, ids as string[], { now });
}

// ───────────────────────────────────────────────────────────────── onboarding and consent

const PlatformList = z
  .string()
  .max(80, "too_long")
  .transform((value, context) => {
    const list = value === "" ? [] : value.split(/[.,\s]+/).filter(Boolean);
    if (list.some((slug) => !isHomePlatform(slug))) {
      context.addIssue({ code: "custom", message: "invalid" });
      return z.NEVER;
    }
    return unique(list) as HomePlatformSlug[];
  });

/** What POST /api/onboarding may say: the intro was seen, the platforms picked, a consent answer. */
export const OnboardingInput = z.object({
  intro: z.literal("seen").optional(),
  platforms: PlatformList.optional(),
  consent: z.enum(["1", "0"]).optional(),
});

export type Onboarding = { introSeen: boolean; platforms: HomePlatformSlug[] | null; consent: boolean | null };

/** Validates the onboarding form; unknown platforms or values → AppError("invalid", 400) with field errors. */
export function parseOnboarding(raw: unknown): Onboarding {
  const result = OnboardingInput.safeParse(raw ?? {});
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) fields[String(issue.path[0] ?? "form")] = issue.message === "too_long" ? "too_long" : "invalid";
    throw invalid(fields, "home.onboarding");
  }
  const input = result.data;
  return { introSeen: input.intro === "seen", platforms: input.platforms ?? null, consent: input.consent === undefined ? null : input.consent === "1" };
}

/**
 * Personalization consent of a signed-in customer, appended to the consent history (`consents` is append-only: the
 * latest row per subject and kind is the current state). Guests have no record — their answer lives in the
 * `tt_consent` cookie on their device, which is all the store uses for them.
 */
export async function recordPersonalizationConsent(db: Db, input: { customerId: string; granted: boolean; ip: string | null; now: number }): Promise<void> {
  await db.insert(consents).values({
    id: newId("cns"),
    subjectType: "customer",
    subjectId: input.customerId,
    kind: "personalization",
    granted: input.granted,
    source: "home_onboarding",
    at: input.now,
    ip: input.ip,
  });
}
