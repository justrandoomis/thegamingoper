/**
 * Catalogue read layer — platforms, the category tree and the navigation taxonomy (docs/CONTRACTS.md §2).
 *
 *   const platforms = await getPlatforms(db, ctx.locale);          // PlatformSummary[], menu order
 *   const tree = await getCategoryTree(db, ctx.locale);            // CategoryNode[] (active categories only)
 *   const nav = await getNavTaxonomy(db, ctx.locale, { now: ctx.now });   // header, mega menu, categories sheet
 *
 * COUNTS AGREE WITH THE HUBS (catalog area, listing.server.ts): the menu counts and links what the hubs list —
 * published products with an active variant — and a product belongs to every platform it is RESEARCHED for
 * (researchedPlatformSql in ./cards.server: its own platform, else the devices its game facts name, else its
 * verified/partial compatibility rules). So a game sold for PS5 and Xbox counts for both platforms (once in its
 * department), and the PlayStation menu links the headsets made for PlayStation and others.
 *
 * WHAT THE MEGA MENU GETS BEYOND LINKS (design v2 spec §5.4): every category, device and used link of a platform
 * carries its `count` (what the linked page lists for the platform — a device link counts what the platform hub's
 * device shortcut counts, from the hubs' own rows: listing.server.ts loadListingRows), device links a `short` name
 * ("PS5 Pro"; card-facts.ts shortModelName), categories their tile photo (`artKey`), and each platform a `featured`
 * product with its card price and state (pickFeatured: its lead device when it can be bought now, else its newest
 * console that can, else the lead device as it is).
 *
 * getNavTaxonomy() is read on every storefront document request, so it is cached PER ISOLATE (per database binding
 * and locale) and guarded by a VERSION KEY: a one-statement fingerprint of what the menu is built from (published
 * products and device models — count and last update —, active variants and their prices, compatibility rules,
 * platforms, categories, listed used units). Stock is not in it: the featured tile's state may lag a sale by up to
 * NAV_MAX_AGE_MS (the product page and the cart always read stock live).
 *   · within NAV_CHECK_MS of the last check: served from memory, no query at all;
 *   · after that: the fingerprint is read (one small query); unchanged → the snapshot is kept, changed → rebuilt;
 *   · a snapshot older than NAV_MAX_AGE_MS is rebuilt whatever the fingerprint says (renames the fingerprint
 *     cannot see, e.g. a category renamed to a name of the same length).
 * Admin code that edits the catalogue in the same isolate may call invalidateNavTaxonomy() to drop it at once.
 *
 * Links are locale-less ("/c/controllers?platform=xbox"); the shell wraps them in <LocaleLink>. A category link
 * carries `?platform=` only when the category's hub would also list products that are not for that platform (or
 * for none).
 *
 * Services take `db` first and never import "cloudflare:workers".
 */
import { sql } from "drizzle-orm";
import type { CategoryNode, PlatformSummary, ProductCardData } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { qualifierOf, shortModelName } from "./card-facts";
import { getCardsByIds, MAX_CARD_IDS, researchedPlatformSql } from "./cards.server";
import { loadListingRows } from "./listing.server";
import type { NavCategory, NavFeatured, NavLink, NavPlatform, NavTaxonomy } from "./types";

export type { NavCategory, NavFeatured, NavLink, NavPlatform, NavTaxonomy } from "./types";

/** How long a snapshot is served without looking at the database. */
export const NAV_CHECK_MS = 30_000;
/** Oldest a snapshot may get before it is rebuilt regardless of the fingerprint. */
export const NAV_MAX_AGE_MS = 5 * 60_000;
/** Console products listed per platform in the mega menu. */
const CONSOLES_PER_PLATFORM = 5;

const parseL10n = (text: string | null | undefined): L10n | null => {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as L10n;
  } catch {
    return null;
  }
};

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

// ───────────────────────────────────────────────────────────────── platforms and categories

type PlatformRow = { id: string; slug: string; name: string; accent: string; art_key: string | null };
type CategoryRow = { id: string; parent_id: string | null; slug: string; name: string; kind: string; sort: number; art_key: string | null };

const PLATFORMS_SQL = sql`SELECT id, slug, name, accent, art_key FROM platforms WHERE is_active = 1 ORDER BY sort, id`;
const CATEGORIES_SQL = sql`SELECT id, parent_id, slug, name, kind, sort, art_key FROM categories WHERE is_active = 1 ORDER BY sort, id`;

/** Active platforms in menu order. */
export async function getPlatforms(db: Db, locale: Locale): Promise<PlatformSummary[]> {
  const rows = await db.all<PlatformRow>(PLATFORMS_SQL);
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: pick(parseL10n(row.name), locale), accent: row.accent }));
}

/** Active categories as a tree. A category under an inactive parent is left out with its parent. */
export async function getCategoryTree(db: Db, locale: Locale): Promise<CategoryNode[]> {
  const rows = await db.all<CategoryRow>(CATEGORIES_SQL);
  return buildTree(rows, locale);
}

function buildTree(rows: readonly CategoryRow[], locale: Locale): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) nodes.set(row.id, { id: row.id, slug: row.slug, name: pick(parseL10n(row.name), locale), kind: row.kind, children: [] });
  const roots: CategoryNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    if (row.parent_id === null) roots.push(node);
    else nodes.get(row.parent_id)?.children.push(node); // parent inactive (not in the map): dropped with it
  }
  return roots;
}

// ───────────────────────────────────────────────────────────────── navigation taxonomy

type DeviceRow = { platform_id: string; slug: string; name: string };
type CategoryCountRow = { category_id: string | null; n: number };
type PlatformCountRow = { platform_id: string; category_id: string | null; n: number };
/** `attributes`: the product's attributes JSON (its qualifier — card-facts.ts qualifierOf). */
type ConsoleRow = { id: string; platform_id: string | null; slug: string; name: string; attributes: string | null };
type UsedRow = { platform_id: string | null; n: number };

/** A card that can be bought now (the featured tile prefers one). */
const buyable = (card: ProductCardData | undefined): card is ProductCardData => card !== undefined && (card.stock === "in_stock" || card.stock === "low_stock");

/**
 * The mega menu's featured product of one platform (NavFeatured): among its listed consoles (newest first) the one
 * its photo comes from (`platforms.art_key` = "<product-slug>--<n>") leads; the first of them that can be bought now
 * wins, else the first of them with its true state. Null when the platform lists no console (or no card came back).
 */
export function pickFeatured(
  consoles: readonly { id: string; slug: string }[],
  artKey: string | null,
  cards: ReadonlyMap<string, ProductCardData>,
  qualifiers: ReadonlyMap<string, string> = new Map(),
): NavFeatured | null {
  const lead = artKey ? artKey.replace(/--\d+$/, "") : null;
  const ordered = [...consoles.filter((row) => row.slug === lead), ...consoles.filter((row) => row.slug !== lead)];
  const known = ordered.map((row) => cards.get(row.id)).filter((card): card is ProductCardData => card !== undefined);
  const card = known.find(buyable) ?? known[0];
  if (!card) return null;
  return {
    productId: card.id,
    href: `/p/${card.slug}`,
    label: card.name,
    qualifier: qualifiers.get(card.id) || null,
    image: card.image,
    priceIqd: card.priceIqd,
    stock: card.stock,
    hasVariants: card.hasVariants,
    isDemo: card.isDemo,
  };
}

/** Kinds of top-level category that go into the mega menu's "games" and "consoles" columns; the rest are accessories. */
const GAME_KINDS = new Set(["games"]);
const CONSOLE_KINDS = new Set(["consoles", "handhelds"]);
const SKIP_KINDS = new Set(["used"]);

/**
 * What the menu counts — exactly what the hubs list (catalog area, listing.server.ts): published products with at
 * least one active variant (a product without one answers 404, so it is never counted or linked).
 */
const LISTED = sql`p.status = 'published' AND EXISTS (SELECT 1 FROM variants AS lv WHERE lv.product_id = p.id AND lv.is_active = 1)`;

async function buildNavTaxonomy(db: Db, locale: Locale, now: number): Promise<NavTaxonomy> {
  const [[platformResult, categoryResult, deviceResult, categoryCountResult, platformCountResult, consoleResult, usedResult], universe] = await Promise.all([
    runBatch(db, [
      batchSql(db, PLATFORMS_SQL),
      batchSql(db, CATEGORIES_SQL),
      batchSql(db, sql`SELECT platform_id, slug, name FROM device_models WHERE status = 'published' ORDER BY sort, id`),
      // each listed product once, on its category
      batchSql(db, sql`SELECT p.category_id, COUNT(*) AS n FROM products AS p WHERE ${LISTED} GROUP BY p.category_id`),
      // each listed product once per platform it is RESEARCHED for (a game sold for PS5 and Xbox counts for both)
      batchSql(
        db,
        sql`SELECT pl.id AS platform_id, p.category_id, COUNT(*) AS n
          FROM products AS p JOIN platforms AS pl ON pl.is_active = 1 AND ${researchedPlatformSql("p", "pl")}
          WHERE ${LISTED}
          GROUP BY pl.id, p.category_id`,
      ),
      batchSql(db, sql`SELECT p.id, p.platform_id, p.slug, p.name, p.attributes FROM products AS p WHERE ${LISTED} AND p.kind = 'console' ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC`),
      batchSql(db, sql`
        SELECT p.platform_id, COUNT(*) AS n
        FROM used_units AS u JOIN variants AS v ON v.id = u.variant_id JOIN products AS p ON p.id = v.product_id
        WHERE u.status = 'listed'
        GROUP BY p.platform_id`),
    ]),
    // the hubs' own rows (listing.server.ts): which listed products each device fits, per researched platform — the
    // device links count exactly what the platform hub's device shortcuts count
    loadListingRows(db, { kind: "all" }, now),
  ]);
  const platforms = rowsOf<PlatformRow>(platformResult);
  const categories = rowsOf<CategoryRow>(categoryResult);
  const devices = rowsOf<DeviceRow>(deviceResult);
  const categoryCounts = rowsOf<CategoryCountRow>(categoryCountResult);
  const platformCounts = rowsOf<PlatformCountRow>(platformCountResult);
  const consoles = rowsOf<ConsoleRow>(consoleResult);
  const used = rowsOf<UsedRow>(usedResult);
  // the words each console's Latin title leaves out («نسخة الأقراص»): printed beside the name, never inside it
  const qualifiers = new Map(consoles.map((row) => [row.id, qualifierOf(row.attributes, locale)] as const).filter(([, text]) => text !== ""));

  // Categories: names, parents, the top-level ancestor of each, and product counts per subtree.
  const byId = new Map(categories.map((row) => [row.id, row]));
  const rootOf = (id: string): CategoryRow | null => {
    let row = byId.get(id);
    for (let guard = 0; row?.parent_id && guard < 16; guard++) {
      const parent = byId.get(row.parent_id);
      if (!parent) return null; // under an inactive category
      row = parent;
    }
    return row ?? null;
  };
  const label = (row: { name: string }) => pick(parseL10n(row.name), locale);
  /** Adds `n` to the category and each of its active ancestors (a category under an inactive one counts nowhere above it). */
  const addUp = (map: Map<string, number>, categoryId: string, n: number) => {
    for (let current: CategoryRow | undefined = byId.get(categoryId), guard = 0; current && guard < 16; guard++) {
      map.set(current.id, (map.get(current.id) ?? 0) + n);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
  };

  // listed products per category subtree (the category hubs' counts)
  const subtreeTotal = new Map<string, number>();
  for (const row of categoryCounts) if (row.category_id && byId.has(row.category_id)) addUp(subtreeTotal, row.category_id, Number(row.n));

  // per platform: listed products on each (deepest) category, the same per subtree, and the platform's total
  const perCategory = new Map<string, Map<string, number>>();
  const subtreeOf = new Map<string, Map<string, number>>();
  const platformTotal = new Map<string, number>();
  for (const row of platformCounts) {
    const n = Number(row.n);
    platformTotal.set(row.platform_id, (platformTotal.get(row.platform_id) ?? 0) + n); // on no (active) category too
    if (!row.category_id || !byId.has(row.category_id)) continue;
    const own = perCategory.get(row.platform_id) ?? new Map<string, number>();
    own.set(row.category_id, (own.get(row.category_id) ?? 0) + n);
    perCategory.set(row.platform_id, own);
    const subtree = subtreeOf.get(row.platform_id) ?? new Map<string, number>();
    addUp(subtree, row.category_id, n);
    subtreeOf.set(row.platform_id, subtree);
  }
  /** The category's hub also lists products that are not for this platform (or for none): its link filters by it. */
  const holdsOthers = (categoryId: string, platformId: string) => (subtreeOf.get(platformId)?.get(categoryId) ?? 0) < (subtreeTotal.get(categoryId) ?? 0);
  const navCategories: NavCategory[] = categories
    .filter((row) => row.parent_id === null && (subtreeTotal.get(row.id) ?? 0) > 0 && !SKIP_KINDS.has(row.kind))
    .map((row) => ({
      slug: row.slug,
      kind: row.kind,
      label: label(row),
      href: `/c/${row.slug}`,
      count: subtreeTotal.get(row.id) ?? 0,
      artKey: row.art_key ?? null,
      children: categories
        .filter((child) => child.parent_id === row.id && (subtreeTotal.get(child.id) ?? 0) > 0)
        .map((child) => ({ slug: child.slug, label: label(child), href: `/c/${child.slug}`, count: subtreeTotal.get(child.id) ?? 0, artKey: child.art_key ?? null })),
    }));

  // the featured tiles' cards (cards.server.ts rules: price of the version on sale, state, demo flag) — one statement
  const consoleIds = [...new Set(platforms.flatMap((platform) => consoles.filter((row) => row.platform_id === platform.id).map((row) => row.id)))].slice(0, MAX_CARD_IDS);
  const cards = new Map((consoleIds.length > 0 ? await getCardsByIds(db, locale, consoleIds, { now }) : []).map((card) => [card.id, card]));

  const usedBy = new Map(used.map((row) => [row.platform_id, Number(row.n)]));
  const navPlatforms: NavPlatform[] = platforms.map((platform) => {
    const accessories: NavLink[] = [];
    const games: NavLink[] = [];
    let allConsoles: NavLink | null = null;
    const own = perCategory.get(platform.id);
    for (const row of categories) {
      if ((own?.get(row.id) ?? 0) === 0) continue;
      const root = rootOf(row.id);
      if (!root || SKIP_KINDS.has(root.kind)) continue;
      const link: NavLink = {
        label: label(row),
        href: holdsOthers(row.id, platform.id) ? `/c/${row.slug}?platform=${platform.slug}` : `/c/${row.slug}`,
        // what the linked hub lists with the link's filter: the category's products for this platform
        count: subtreeOf.get(platform.id)?.get(row.id) ?? 0,
      };
      if (GAME_KINDS.has(root.kind)) games.push(link);
      else if (CONSOLE_KINDS.has(root.kind)) allConsoles ??= link;
      else accessories.push(link);
    }
    const usedCount = usedBy.get(platform.id) ?? 0;
    const platformConsoles = consoles.filter((row) => row.platform_id === platform.id);
    // the platform hub's rows (scope: researched for this platform) that fit each device
    const hubRows = universe.rows.filter((row) => row.platforms.includes(platform.slug));
    return {
      id: platform.id,
      slug: platform.slug,
      name: label(platform),
      accent: platform.accent,
      artKey: platform.art_key,
      href: `/platform/${platform.slug}`,
      // = the platform hub's count: every listed product researched for it, whatever its category
      productCount: platformTotal.get(platform.id) ?? 0,
      devices: devices
        .filter((row) => row.platform_id === platform.id)
        .map((row) => ({
          label: label(row),
          href: `/device/${row.slug}`,
          short: shortModelName(row.slug, label(row)),
          count: hubRows.filter((hubRow) => hubRow.devices.includes(row.slug)).length,
        })),
      accessories,
      games,
      consoles: platformConsoles.slice(0, CONSOLES_PER_PLATFORM).map((row): NavLink => {
        const qualifier = qualifiers.get(row.id);
        return qualifier ? { label: label(row), href: `/p/${row.slug}`, qualifier } : { label: label(row), href: `/p/${row.slug}` };
      }),
      allConsoles,
      // label = the platform's name; the shell words the link ("مستعمل {name}")
      used: usedCount > 0 ? { label: label(platform), href: `/used?platform=${platform.slug}`, count: usedCount } : null,
      featured: pickFeatured(platformConsoles, platform.art_key, cards, qualifiers),
    };
  });

  return {
    platforms: navPlatforms,
    categories: navCategories,
    usedCount: used.reduce((sum, row) => sum + Number(row.n), 0),
    builtAt: now,
  };
}

/** One statement that changes whenever the menu would (see the file header). */
const FINGERPRINT_SQL = sql`SELECT
  (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM products WHERE status = 'published') || '|' ||
  (SELECT COALESCE(MAX(updated_at), 0) FROM products) || '|' ||
  (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM device_models WHERE status = 'published') || '|' ||
  (SELECT COUNT(*) || ':' || TOTAL(rowid * is_active) || ':' || TOTAL(price_iqd) FROM variants) || '|' ||
  (SELECT COUNT(*) || ':' || TOTAL(rowid * (CASE status WHEN 'verified' THEN 1 WHEN 'partial' THEN 2 ELSE 3 END)) FROM compatibility_rules WHERE subject_type = 'product') || '|' ||
  (SELECT COUNT(*) || ':' || TOTAL(is_active) || ':' || TOTAL(sort) || ':' || TOTAL(length(name)) || ':' || COALESCE(GROUP_CONCAT(art_key), '') FROM platforms) || '|' ||
  (SELECT COUNT(*) || ':' || TOTAL(is_active) || ':' || TOTAL(sort) || ':' || TOTAL(length(name)) || ':' || TOTAL(length(slug)) FROM categories) || '|' ||
  (SELECT COUNT(*) FROM used_units WHERE status = 'listed') AS v`;

async function readFingerprint(db: Db): Promise<string> {
  const rows = await db.all<{ v: string | null }>(FINGERPRINT_SQL);
  return String(rows[0]?.v ?? "");
}

type CacheEntry = { value: NavTaxonomy; version: string; checkedAt: number };
/**
 * Per database binding (tests create many), then per locale. Module scope = per isolate; it holds finished, plain
 * data only — never a promise. A Worker must not await I/O that another request started: when that request ends or
 * is cancelled (a client that went away), its pending queries are cancelled and the promise never settles, so every
 * request waiting on it would hang. Each request therefore reads for itself; requests that arrive together when the
 * snapshot has just gone stale may each run the fingerprint query (one small query each, at most every NAV_CHECK_MS).
 */
let caches = new WeakMap<object, Map<Locale, CacheEntry>>();

const cacheKey = (db: Db): object => (db as { $client?: object }).$client ?? db;

/**
 * Everything the storefront navigation shows: platforms (with their mega-menu columns), top-level categories,
 * used-unit counts. Cached per isolate (see the file header). Snapshots are shared between requests: treat the
 * result as read-only.
 */
export async function getNavTaxonomy(db: Db, locale: Locale, options: { now?: number } = {}): Promise<NavTaxonomy> {
  const now = options.now ?? Date.now();
  const key = cacheKey(db);
  let byLocale = caches.get(key);
  if (!byLocale) caches.set(key, (byLocale = new Map()));
  const hit = byLocale.get(locale);
  if (hit && now - hit.checkedAt >= 0 && now - hit.checkedAt < NAV_CHECK_MS) return hit.value;

  const version = await readFingerprint(db);
  if (hit && hit.version === version && now - hit.value.builtAt < NAV_MAX_AGE_MS) {
    byLocale.set(locale, { ...hit, checkedAt: now });
    return hit.value;
  }
  const entry: CacheEntry = { value: await buildNavTaxonomy(db, locale, now), version, checkedAt: now };
  byLocale.set(locale, entry);
  return entry.value;
}

/** Drop the cached navigation (this isolate only) — for admin code that just changed the catalogue. */
export function invalidateNavTaxonomy(db?: Db): void {
  if (db) caches.delete(cacheKey(db));
  else caches = new WeakMap();
}
