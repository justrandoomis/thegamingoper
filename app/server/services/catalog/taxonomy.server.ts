/**
 * Catalogue read layer — platforms, the category tree and the navigation taxonomy (docs/CONTRACTS.md §2).
 *
 *   const platforms = await getPlatforms(db, ctx.locale);          // PlatformSummary[], menu order
 *   const tree = await getCategoryTree(db, ctx.locale);            // CategoryNode[] (active categories only)
 *   const nav = await getNavTaxonomy(db, ctx.locale, { now: ctx.now });   // header, mega menu, categories sheet
 *
 * getNavTaxonomy() is read on every storefront document request, so it is cached PER ISOLATE (per database binding
 * and locale) and guarded by a VERSION KEY: a one-statement fingerprint of what the menu is built from (published
 * products and device models — count and last update —, platforms, categories, listed used units).
 *   · within NAV_CHECK_MS of the last check: served from memory, no query at all;
 *   · after that: the fingerprint is read (one small query); unchanged → the snapshot is kept, changed → rebuilt;
 *   · a snapshot older than NAV_MAX_AGE_MS is rebuilt whatever the fingerprint says (renames the fingerprint
 *     cannot see, e.g. a category renamed to a name of the same length).
 * Admin code that edits the catalogue in the same isolate may call invalidateNavTaxonomy() to drop it at once.
 *
 * Links are locale-less ("/c/controllers?platform=xbox"); the shell wraps them in <LocaleLink>. A category link
 * carries `?platform=` only when the category also holds products of other platforms (or of none).
 *
 * Services take `db` first and never import "cloudflare:workers".
 */
import { sql } from "drizzle-orm";
import type { CategoryNode, PlatformSummary } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import type { NavCategory, NavLink, NavPlatform, NavTaxonomy } from "./types";

export type { NavCategory, NavLink, NavPlatform, NavTaxonomy } from "./types";

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
type CategoryRow = { id: string; parent_id: string | null; slug: string; name: string; kind: string; sort: number };

const PLATFORMS_SQL = sql`SELECT id, slug, name, accent, art_key FROM platforms WHERE is_active = 1 ORDER BY sort, id`;
const CATEGORIES_SQL = sql`SELECT id, parent_id, slug, name, kind, sort FROM categories WHERE is_active = 1 ORDER BY sort, id`;

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
type CountRow = { platform_id: string | null; category_id: string | null; n: number };
type ConsoleRow = { platform_id: string | null; slug: string; name: string };
type UsedRow = { platform_id: string | null; n: number };

/** Kinds of top-level category that go into the mega menu's "games" and "consoles" columns; the rest are accessories. */
const GAME_KINDS = new Set(["games"]);
const CONSOLE_KINDS = new Set(["consoles", "handhelds"]);
const SKIP_KINDS = new Set(["used"]);

async function buildNavTaxonomy(db: Db, locale: Locale, now: number): Promise<NavTaxonomy> {
  const [platformResult, categoryResult, deviceResult, countResult, consoleResult, usedResult] = await runBatch(db, [
    batchSql(db, PLATFORMS_SQL),
    batchSql(db, CATEGORIES_SQL),
    batchSql(db, sql`SELECT platform_id, slug, name FROM device_models WHERE status = 'published' ORDER BY sort, id`),
    batchSql(db, sql`SELECT platform_id, category_id, COUNT(*) AS n FROM products WHERE status = 'published' GROUP BY platform_id, category_id`),
    batchSql(db, sql`SELECT platform_id, slug, name FROM products WHERE status = 'published' AND kind = 'console' ORDER BY COALESCE(published_at, created_at) DESC, id DESC`),
    batchSql(db, sql`
      SELECT p.platform_id, COUNT(*) AS n
      FROM used_units AS u JOIN variants AS v ON v.id = u.variant_id JOIN products AS p ON p.id = v.product_id
      WHERE u.status = 'listed'
      GROUP BY p.platform_id`),
  ]);
  const platforms = rowsOf<PlatformRow>(platformResult);
  const categories = rowsOf<CategoryRow>(categoryResult);
  const devices = rowsOf<DeviceRow>(deviceResult);
  const counts = rowsOf<CountRow>(countResult);
  const consoles = rowsOf<ConsoleRow>(consoleResult);
  const used = rowsOf<UsedRow>(usedResult);

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

  // products per category (deepest), split by platform
  const perCategory = new Map<string, Map<string | null, number>>();
  for (const row of counts) {
    if (!row.category_id || !byId.has(row.category_id)) continue;
    const map = perCategory.get(row.category_id) ?? new Map<string | null, number>();
    map.set(row.platform_id, (map.get(row.platform_id) ?? 0) + Number(row.n));
    perCategory.set(row.category_id, map);
  }
  const categoryTotal = (id: string) => [...(perCategory.get(id)?.values() ?? [])].reduce((sum, n) => sum + n, 0);
  const isMixed = (id: string) => (perCategory.get(id)?.size ?? 0) > 1;

  // top-level categories with their sub-categories, counting whole subtrees
  const subtreeTotal = new Map<string, number>();
  for (const row of categories) {
    const total = categoryTotal(row.id);
    if (total === 0) continue;
    for (let current: CategoryRow | undefined = row, guard = 0; current && guard < 16; guard++) {
      subtreeTotal.set(current.id, (subtreeTotal.get(current.id) ?? 0) + total);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
  }
  const navCategories: NavCategory[] = categories
    .filter((row) => row.parent_id === null && (subtreeTotal.get(row.id) ?? 0) > 0 && !SKIP_KINDS.has(row.kind))
    .map((row) => ({
      slug: row.slug,
      kind: row.kind,
      label: label(row),
      href: `/c/${row.slug}`,
      count: subtreeTotal.get(row.id) ?? 0,
      children: categories
        .filter((child) => child.parent_id === row.id && (subtreeTotal.get(child.id) ?? 0) > 0)
        .map((child) => ({ slug: child.slug, label: label(child), href: `/c/${child.slug}`, count: subtreeTotal.get(child.id) ?? 0 })),
    }));

  const usedBy = new Map(used.map((row) => [row.platform_id, Number(row.n)]));
  const navPlatforms: NavPlatform[] = platforms.map((platform) => {
    const accessories: NavLink[] = [];
    const games: NavLink[] = [];
    let allConsoles: NavLink | null = null;
    let productCount = 0;
    for (const row of categories) {
      const n = perCategory.get(row.id)?.get(platform.id) ?? 0;
      if (n === 0) continue;
      productCount += n;
      const root = rootOf(row.id);
      if (!root || SKIP_KINDS.has(root.kind)) continue;
      const link: NavLink = { label: label(row), href: isMixed(row.id) ? `/c/${row.slug}?platform=${platform.slug}` : `/c/${row.slug}` };
      if (GAME_KINDS.has(root.kind)) games.push(link);
      else if (CONSOLE_KINDS.has(root.kind)) allConsoles ??= link;
      else accessories.push(link);
    }
    // products of this platform that sit on no (active) category still count for the hub
    for (const row of counts) if (row.platform_id === platform.id && (!row.category_id || !byId.has(row.category_id))) productCount += Number(row.n);
    const usedCount = usedBy.get(platform.id) ?? 0;
    return {
      id: platform.id,
      slug: platform.slug,
      name: label(platform),
      accent: platform.accent,
      artKey: platform.art_key,
      href: `/platform/${platform.slug}`,
      productCount,
      devices: devices.filter((row) => row.platform_id === platform.id).map((row) => ({ label: label(row), href: `/device/${row.slug}` })),
      accessories,
      games,
      consoles: consoles
        .filter((row) => row.platform_id === platform.id)
        .slice(0, CONSOLES_PER_PLATFORM)
        .map((row) => ({ label: label(row), href: `/p/${row.slug}` })),
      allConsoles,
      // label = the platform's name; the shell words the link ("مستعمل {name}")
      used: usedCount > 0 ? { label: label(platform), href: `/used?platform=${platform.slug}` } : null,
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
