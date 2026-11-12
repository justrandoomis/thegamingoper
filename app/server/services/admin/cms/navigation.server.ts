/**
 * Admin 17.03 — the storefront's navigation and listing filters.
 *
 * NAVIGATION stays generated from the catalogue (platforms and top-level categories with listed products, the
 * catalogue read layer's getNavTaxonomy): staff only ORDER, HIDE or FEATURE entries. The arrangement is one
 * `nav_menus` row (key NAV_MENU_KEY): `items` = what the store uses, `draft_items` = what staff are arranging. Each
 * entry names its platform or category by ID (`ref`, the blueprint's entity rule: never an editable name); the
 * label and link stored beside it are only a snapshot for people reading the row. A new category appears at the end
 * of its list on its own; a renamed one keeps its place.
 *
 *   getNavEditor(db, actor, locale, now) · saveNavDraft · publishNav · discardNavDraft     cms.navigation.manage
 *   getNavArrangement(db)                    ← the storefront's read (refs resolved to today's slugs);
 *                                              apply with arrangeBySlug(taxonomy.platforms, arrangement.platforms)
 *
 * FILTERS: which of the listing's filter groups a category page offers and in what order (`catalog_filters`, one row
 * per group; `category_id NULL` = the default for every category).
 *
 *   getFilterEditor(db, actor, categoryId | null, locale) · saveFilters(db, actor, raw, now)
 *   getListingFilterOrder(db, categoryId)    ← the storefront's read: the groups to offer, in order
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getNamespace } from "~/i18n/i18n.server";
import { translate, type MessageTree } from "~/i18n/translate";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { catalogFilters, categories, navMenus, platforms, type NavItem } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { getNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
import { CMS_NS, FILTER_WIDGET, LISTING_FILTER_GROUPS, NAV_FEATURED_MAX, NAV_MENU_KEY, arrangeFilterGroups, isListingFilterGroup, type ListingFilterGroup, type NavArrangement, type NavEntryState } from "./rules";
import { actorIdOf, cmsError, parseInput, zReason } from "./shared.server";

/** A stored entry: NavItem-shaped (label + link snapshot) plus the reference and the staff's choices. */
type StoredEntry = NavItem & { ref: string; hidden?: boolean; featured?: boolean };

function conflictOf(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CONTENT_CHANGED") throw cmsError("content_changed", 409);
  if (info?.kind === "unique") throw cmsError("content_changed", 409);
  throw error;
}

const readEntries = (value: unknown): StoredEntry[] =>
  Array.isArray(value) ? (value as StoredEntry[]).filter((entry) => entry && typeof entry === "object" && typeof entry.ref === "string") : [];

// ───────────────────────────────────────────────────────────────── navigation

export type NavEditorEntry = {
  ref: string;
  type: "platform" | "category";
  slug: string;
  name: string;
  /** Listed products behind it today (the menu shows an entry only with products). */
  count: number;
  hidden: boolean;
  featured: boolean;
  /** Not in the arrangement yet (new in the catalogue since it was saved). */
  isNew: boolean;
};

export type NavEditor = {
  platforms: NavEditorEntry[];
  categories: NavEditorEntry[];
  /** True while a draft arrangement waits to be published. */
  hasDraft: boolean;
  /** True once an arrangement was published (else the store shows the catalogue's own order). */
  hasPublished: boolean;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
};

type Generated = { ref: string; type: "platform" | "category"; slug: string; name: L10n; count: number };

/** The entries the catalogue generates, in the catalogue's order, with how many listed products each has. */
async function generated(db: Db, locale: Locale, now: number): Promise<{ platforms: Generated[]; categories: Generated[] }> {
  const [platformRows, categoryRows, taxonomy] = await Promise.all([
    db.select({ id: platforms.id, slug: platforms.slug, name: platforms.name }).from(platforms).where(eq(platforms.isActive, true)).orderBy(asc(platforms.sort), asc(platforms.id)),
    db
      .select({ id: categories.id, slug: categories.slug, name: categories.name, kind: categories.kind })
      .from(categories)
      .where(and(eq(categories.isActive, true), isNull(categories.parentId)))
      .orderBy(asc(categories.sort), asc(categories.id)),
    getNavTaxonomy(db, locale, { now }),
  ]);
  const platformCount = new Map(taxonomy.platforms.map((entry) => [entry.slug, entry.productCount]));
  const categoryCount = new Map(taxonomy.categories.map((entry) => [entry.slug, entry.count]));
  return {
    platforms: platformRows.map((row) => ({ ref: `platform:${row.id}`, type: "platform", slug: row.slug, name: row.name, count: platformCount.get(row.slug) ?? 0 })),
    categories: categoryRows.filter((row) => row.kind !== "used").map((row) => ({ ref: `category:${row.id}`, type: "category", slug: row.slug, name: row.name, count: categoryCount.get(row.slug) ?? 0 })),
  };
}

function arranged(list: Generated[], entries: StoredEntry[], locale: Locale): NavEditorEntry[] {
  const byRef = new Map(list.map((entry) => [entry.ref, entry]));
  const out: NavEditorEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const item = byRef.get(entry.ref);
    if (!item || seen.has(entry.ref)) continue;
    seen.add(entry.ref);
    out.push({ ref: item.ref, type: item.type, slug: item.slug, name: pick(item.name, locale) || item.slug, count: item.count, hidden: entry.hidden === true, featured: entry.featured === true, isNew: false });
  }
  for (const item of list) if (!seen.has(item.ref)) out.push({ ref: item.ref, type: item.type, slug: item.slug, name: pick(item.name, locale) || item.slug, count: item.count, hidden: false, featured: false, isNew: entries.length > 0 });
  return out;
}

export async function getNavEditor(db: Db, actor: Actor, locale: Locale, now: number): Promise<NavEditor> {
  assertCan(actor, "cms.navigation.manage");
  const [row, lists] = await Promise.all([db.select().from(navMenus).where(eq(navMenus.key, NAV_MENU_KEY)).get(), generated(db, locale, now)]);
  const entries = readEntries(row?.draftItems ?? row?.items);
  return {
    platforms: arranged(lists.platforms, entries.filter((entry) => entry.ref.startsWith("platform:")), locale),
    categories: arranged(lists.categories, entries.filter((entry) => entry.ref.startsWith("category:")), locale),
    hasDraft: Boolean(row?.draftItems),
    hasPublished: readEntries(row?.items).length > 0,
    version: row?.updatedAt ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

const EntryInput = z.object({ ref: z.string().regex(/^(platform|category):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid"), hidden: z.boolean(), featured: z.boolean() });
const DraftInput = z.object({ platforms: z.array(EntryInput).max(50), categories: z.array(EntryInput).max(200), version: z.coerce.number().int().min(0) });

function checkFeatured(list: readonly NavEntryState[], field: string): void {
  if (list.filter((entry) => entry.featured && !entry.hidden).length > NAV_FEATURED_MAX) throw cmsError("nav_featured_max", 400, { fields: { [field]: "nav_featured_max" } });
}

/** Saves the arrangement as a draft (the store keeps the published one). Every entry must be a catalogue entry. */
export async function saveNavDraft(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar"): Promise<{ saved: true }> {
  assertCan(actor, "cms.navigation.manage");
  const input = parseInput(DraftInput, raw);
  checkFeatured(input.platforms, "platforms");
  checkFeatured(input.categories, "categories");
  const [row, lists] = await Promise.all([db.select().from(navMenus).where(eq(navMenus.key, NAV_MENU_KEY)).get(), generated(db, locale, now)]);
  if ((row?.updatedAt ?? 0) !== input.version) throw cmsError("content_changed", 409);
  const known = new Map([...lists.platforms, ...lists.categories].map((entry) => [entry.ref, entry]));
  const entries: StoredEntry[] = [];
  for (const entry of [...input.platforms, ...input.categories]) {
    const item = known.get(entry.ref);
    if (!item) throw cmsError("nav_unknown_entry", 409, { detail: entry.ref });
    if (entries.some((other) => other.ref === entry.ref)) continue;
    entries.push({ ref: entry.ref, label: item.name, link: item.type === "platform" ? `/platform/${item.slug}` : `/c/${item.slug}`, hidden: entry.hidden, featured: entry.featured && !entry.hidden });
  }
  const by = actorIdOf(actor);
  const audit = auditStatement(db, { actor, action: "cms.nav.save", entityType: "nav", entityId: NAV_MENU_KEY, after: { entries: entries.length, hidden: entries.filter((entry) => entry.hidden).length, featured: entries.filter((entry) => entry.featured).length }, at: now });
  if (!row) {
    await runBatch(db, [db.insert(navMenus).values({ id: newId("nav"), key: NAV_MENU_KEY, items: [], draftItems: entries, updatedBy: by, updatedAt: now }), audit]).catch(conflictOf);
    return { saved: true };
  }
  await runBatch(db, [
    db.update(navMenus).set({ draftItems: entries, updatedBy: by, updatedAt: now }).where(and(eq(navMenus.id, row.id), eq(navMenus.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    audit,
  ]).catch(conflictOf);
  return { saved: true };
}

const DecideInput = z.object({ version: z.coerce.number().int(), reason: zReason(true) });

/** The draft arrangement becomes the store's. */
export async function publishNav(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ published: true }> {
  assertCan(actor, "cms.navigation.manage");
  const input = parseInput(DecideInput, raw);
  const row = await db.select().from(navMenus).where(eq(navMenus.key, NAV_MENU_KEY)).get();
  if (!row?.draftItems) throw cmsError("nothing_changed", 409);
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  const before = readEntries(row.items);
  const after = readEntries(row.draftItems);
  await runBatch(db, [
    db.update(navMenus).set({ items: after, draftItems: null, updatedBy: actorIdOf(actor), updatedAt: now }).where(and(eq(navMenus.id, row.id), eq(navMenus.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, {
      actor,
      action: "cms.nav.publish",
      entityType: "nav",
      entityId: NAV_MENU_KEY,
      before: { order: before.map((entry) => entry.ref), hidden: before.filter((entry) => entry.hidden).map((entry) => entry.ref), featured: before.filter((entry) => entry.featured).map((entry) => entry.ref) },
      after: { order: after.map((entry) => entry.ref), hidden: after.filter((entry) => entry.hidden).map((entry) => entry.ref), featured: after.filter((entry) => entry.featured).map((entry) => entry.ref) },
      reason: input.reason,
      at: now,
    }),
  ]).catch(conflictOf);
  return { published: true };
}

export async function discardNavDraft(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ discarded: true }> {
  assertCan(actor, "cms.navigation.manage");
  const input = parseInput(DecideInput, raw);
  const row = await db.select().from(navMenus).where(eq(navMenus.key, NAV_MENU_KEY)).get();
  if (!row?.draftItems) throw cmsError("nothing_changed", 409);
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  await runBatch(db, [
    db.update(navMenus).set({ draftItems: null, updatedBy: actorIdOf(actor), updatedAt: now }).where(and(eq(navMenus.id, row.id), eq(navMenus.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "cms.nav.discard", entityType: "nav", entityId: NAV_MENU_KEY, reason: input.reason, at: now }),
  ]).catch(conflictOf);
  return { discarded: true };
}

/**
 * The storefront's read: the published arrangement with each reference resolved to today's slug (entries whose
 * platform or category is gone or inactive are dropped). Empty lists = the catalogue's own order.
 */
export async function getNavArrangement(db: Db): Promise<NavArrangement> {
  const row = await db.select({ items: navMenus.items, updatedAt: navMenus.updatedAt }).from(navMenus).where(eq(navMenus.key, NAV_MENU_KEY)).get();
  const entries = readEntries(row?.items);
  if (entries.length === 0) return { platforms: [], categories: [], updatedAt: row?.updatedAt ?? null };
  const [platformRows, categoryRows] = await Promise.all([
    db.select({ id: platforms.id, slug: platforms.slug }).from(platforms).where(eq(platforms.isActive, true)),
    db.select({ id: categories.id, slug: categories.slug }).from(categories).where(eq(categories.isActive, true)),
  ]);
  const slugOf = new Map<string, string>([...platformRows.map((p): [string, string] => [`platform:${p.id}`, p.slug]), ...categoryRows.map((c): [string, string] => [`category:${c.id}`, c.slug])]);
  const place = (prefix: string) =>
    entries
      .filter((entry) => entry.ref.startsWith(prefix) && slugOf.has(entry.ref))
      .map((entry) => ({ slug: slugOf.get(entry.ref)!, hidden: entry.hidden === true, featured: entry.featured === true && entry.hidden !== true }));
  return { platforms: place("platform:"), categories: place("category:"), updatedAt: row?.updatedAt ?? null };
}

// ───────────────────────────────────────────────────────────────── listing filters

/** The group's name in the three languages (from this module's strings): stored as the row's label. */
function filterLabel(group: ListingFilterGroup): L10n {
  const ns = getNamespace(CMS_NS);
  const word = (locale: Locale) => (ns ? translate(ns[locale] as MessageTree, locale, `filters.group.${group}`) : undefined) ?? group;
  return { ar: word("ar"), en: word("en"), ckb: word("ckb") };
}

type FilterRow = typeof catalogFilters.$inferSelect;

const scopeWhere = (categoryId: string | null) => (categoryId ? eq(catalogFilters.categoryId, categoryId) : isNull(catalogFilters.categoryId));

/** A fingerprint of a scope's rows: what the form saw (the table has no update time). */
function fingerprintOf(rows: readonly Pick<FilterRow, "key" | "sort" | "isActive">[]): string {
  return [...rows]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((row) => `${row.key}:${row.sort}:${row.isActive ? 1 : 0}`)
    .join(",");
}

export type FilterEditor = {
  categoryId: string | null;
  categoryName: string | null;
  /** True when this category has its own arrangement (else it follows the default). */
  own: boolean;
  groups: { group: ListingFilterGroup; visible: boolean }[];
  version: string;
  categories: { id: string; name: string; own: boolean }[];
};

export async function getFilterEditor(db: Db, actor: Actor, categoryId: string | null, locale: Locale): Promise<FilterEditor> {
  assertCan(actor, "cms.navigation.manage");
  const [categoryRows, allRows] = await Promise.all([
    db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sort), asc(categories.id)),
    db.select().from(catalogFilters).orderBy(asc(catalogFilters.sort), asc(catalogFilters.key)),
  ]);
  if (categoryId && !categoryRows.some((row) => row.id === categoryId)) throw notFound("category");
  const withOwn = new Set(allRows.map((row) => row.categoryId).filter((id): id is string => Boolean(id)));
  const own = allRows.filter((row) => row.categoryId === categoryId);
  const fallback = allRows.filter((row) => row.categoryId === null);
  const source = own.length > 0 ? own : fallback;
  // the stored order, hidden groups at their place; groups the rows do not name follow, shown
  const placed: { group: ListingFilterGroup; visible: boolean }[] = [];
  for (const row of [...source].sort((a, b) => a.sort - b.sort)) if (isListingFilterGroup(row.key) && !placed.some((entry) => entry.group === row.key)) placed.push({ group: row.key, visible: row.isActive });
  const missing = LISTING_FILTER_GROUPS.filter((group) => !placed.some((entry) => entry.group === group)).map((group) => ({ group, visible: true }));
  return {
    categoryId,
    categoryName: categoryId ? pick(categoryRows.find((row) => row.id === categoryId)?.name ?? null, locale) : null,
    own: own.length > 0,
    groups: [...placed, ...missing],
    version: fingerprintOf(own),
    categories: categoryRows.map((row) => ({ id: row.id, name: pick(row.name, locale), own: withOwn.has(row.id) })),
  };
}

const FiltersInput = z.object({
  categoryId: z.preprocess((value) => (value === "" || value === undefined ? null : value), z.string().trim().max(128).nullable()),
  groups: z.array(z.object({ group: z.string(), visible: z.boolean() })).max(LISTING_FILTER_GROUPS.length),
  /** "inherit" removes a category's own arrangement (it follows the default again). */
  mode: z.enum(["save", "inherit"]).default("save"),
  version: z.string().max(500),
  reason: zReason(true),
});

/** Replaces a scope's filter rows in one guarded batch (or removes a category's own rows). */
export async function saveFilters(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ groups: ListingFilterGroup[] }> {
  assertCan(actor, "cms.navigation.manage");
  const input = parseInput(FiltersInput, raw);
  if (input.categoryId) {
    const category = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, input.categoryId), eq(categories.isActive, true))).get();
    if (!category) throw cmsError("category_unknown", 404);
  }
  if (input.mode === "inherit" && !input.categoryId) throw invalid({ mode: "invalid" });
  const seen = new Set<string>();
  const groups = input.groups.filter((entry) => isListingFilterGroup(entry.group) && !seen.has(entry.group) && seen.add(entry.group)) as { group: ListingFilterGroup; visible: boolean }[];
  for (const group of LISTING_FILTER_GROUPS) if (!seen.has(group)) groups.push({ group, visible: true });
  if (input.mode === "save" && !groups.some((entry) => entry.visible)) throw invalid({ groups: "required" });
  const current = await db.select().from(catalogFilters).where(scopeWhere(input.categoryId));
  if (fingerprintOf(current) !== input.version) throw cmsError("content_changed", 409);
  const fingerprintSql = sql`(SELECT COALESCE(group_concat(x, ','), '') FROM (SELECT key || ':' || sort || ':' || is_active AS x FROM catalog_filters WHERE ${input.categoryId ? sql`category_id = ${input.categoryId}` : sql`category_id IS NULL`} ORDER BY key))`;
  const statements: BatchStatement[] = [expectThat(db, sql`${fingerprintSql} = ${input.version}`, { code: "CONTENT_CHANGED", detail: input.categoryId ?? "default" }), db.delete(catalogFilters).where(scopeWhere(input.categoryId))];
  if (input.mode === "save") {
    groups.forEach((entry, index) => {
      statements.push(db.insert(catalogFilters).values({ id: newId("flt"), categoryId: input.categoryId, key: entry.group, label: filterLabel(entry.group), source: entry.group, widget: FILTER_WIDGET[entry.group], sort: index, isActive: entry.visible }));
    });
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: input.mode === "inherit" ? "cms.filters.inherit" : "cms.filters.save",
      entityType: "catalog_filters",
      entityId: input.categoryId ?? "default",
      before: { order: current.sort((a, b) => a.sort - b.sort).map((row) => `${row.key}${row.isActive ? "" : " (hidden)"}`) },
      after: input.mode === "inherit" ? { follows: "default" } : { order: groups.map((entry) => `${entry.group}${entry.visible ? "" : " (hidden)"}`) },
      reason: input.reason,
      at: now,
    }),
  );
  await runBatch(db, statements).catch(conflictOf);
  return { groups: input.mode === "inherit" ? [] : groups.filter((entry) => entry.visible).map((entry) => entry.group) };
}

/**
 * The storefront's read: the filter groups a listing offers, in order — the category's own arrangement, else the
 * default one, else every group in the listing's own order.
 */
export async function getListingFilterOrder(db: Db, categoryId: string | null): Promise<ListingFilterGroup[]> {
  const rows = await db
    .select({ key: catalogFilters.key, sort: catalogFilters.sort, isActive: catalogFilters.isActive, categoryId: catalogFilters.categoryId })
    .from(catalogFilters)
    .where(categoryId ? sql`${catalogFilters.categoryId} = ${categoryId} OR ${catalogFilters.categoryId} IS NULL` : isNull(catalogFilters.categoryId))
    .orderBy(asc(catalogFilters.sort));
  const own = categoryId ? rows.filter((row) => row.categoryId === categoryId) : [];
  const source = own.length > 0 ? own : rows.filter((row) => row.categoryId === null);
  return arrangeFilterGroups(source.map((row) => ({ group: row.key, visible: row.isActive })));
}
