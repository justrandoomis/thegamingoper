/**
 * Used devices — the marketplace read side (brief §5, DESIGN.md §9.5 "used", §9.20, CONTRACTS.md §3 "used").
 *
 *   const page = await listUsedUnits(db, ctx.locale, { platform: ["nintendo"], grade: ["A", "B"], sort: "price_asc" });
 *   const facets = await getUsedFacets(db, ctx.locale);          // what the filters can offer (listed units only)
 *   const unit = await getUsedUnitDetail(db, ctx.locale, slug);   // the unit page: inspection, photos, warranty
 *   const filters = parseUsedFilters(url.searchParams);           // tolerant: unknown values are dropped
 *
 * WHAT IS PUBLIC. The list shows units with status `listed` only. The unit page also answers for `reserved` (another
 * order holds it — it may come back) and `sold` (so an old link explains itself); every other status (intake,
 * testing, ready, returned) is not public and reads as "not found". The database does not let a real unit be listed
 * without a real photo, a completed checklist, an ownership check and a data wipe (drizzle/0001_invariants.sql); demo
 * units (`is_demo`) are the exception and only carry the maker's photo of the model — flagged `is_illustration`, so
 * every screen labels it "صورة توضيحية".
 *
 * PRIVACY. No statement here selects the serial (`serial_id`), the acquisition cost (`acquisition_cost_iqd` [P]), the
 * internal stock location's name, who checked ownership or wiped the data, or a private file's key: a photo of the
 * unit is shown only once its file is public (the admin makes a listed unit's photos public). The "location" a shopper
 * sees is the branch the unit sits in (`inventory_locations.branch_id` → branches), when the store has entered one.
 *
 * Buying a unit goes through the cart: POST /api/cart intent=add usedUnitId=… (commerce core, CONTRACTS.md §1).
 * Services take `db` first and never import "cloudflare:workers".
 */
import { sql, type SQL } from "drizzle-orm";
import type { ImageRef, Paged, UsedGrade, UsedUnitCardData } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { getSetting } from "~/server/settings.server";

export const USED_GRADE_ORDER: readonly UsedGrade[] = ["A+", "A", "B", "C"];
export const USED_SORTS = ["newest", "price_asc", "price_desc"] as const;
export type UsedSort = (typeof USED_SORTS)[number];
/** Units per page of the list. */
export const USED_PAGE_SIZE = 24;
export const MAX_USED_PAGE_SIZE = 48;

/** One used unit in a list: the card's data plus the facts the filters work on. */
export type UsedUnitListItem = UsedUnitCardData & {
  platformName: string | null;
  model: { slug: string; name: string } | null;
  /** From the variant's options ("512GB"), as written in the catalogue. */
  storage: string | null;
  /** The branch the unit is at, when the store has entered branches. */
  location: { code: string; name: string } | null;
  listedAt: number | null;
};

export type UsedFilters = {
  platform?: readonly string[];
  model?: readonly string[];
  grade?: readonly UsedGrade[];
  storage?: readonly string[];
  priceMin?: number;
  priceMax?: number;
  /** At least this many days of store warranty. */
  warrantyMin?: number;
  location?: readonly string[];
  sort?: UsedSort;
  /** 1-based. */
  page?: number;
  limit?: number;
  /** Leave one unit out (the "other units" shelf on a unit's page). */
  excludeId?: string;
};

// ───────────────────────────────────────────────────────────────── parsing filters from a URL

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const STORAGE = /^\d{1,5}(?:\.\d{1,2})?\s?(?:GB|TB)$/i;
const CODE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_LIST = 12;
const MAX_IQD = 1_000_000_000;

const isGrade = (value: unknown): value is UsedGrade => typeof value === "string" && (USED_GRADE_ORDER as readonly string[]).includes(value);
const unique = <T>(values: T[]) => [...new Set(values)].slice(0, MAX_LIST);

function amountOf(value: string | null): number | undefined {
  if (value === null) return undefined;
  const digits = value.replace(/[,\s٬]/g, "");
  if (!/^\d{1,10}$/.test(digits)) return undefined;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) && amount <= MAX_IQD ? amount : undefined;
}

/**
 * Filters from the query string of /used — tolerant (a shared link with a stale or mistyped value still opens):
 * `platform`, `model`, `grade`, `storage`, `location` may repeat; `min`, `max` (IQD), `warranty` (days), `sort`, `page`.
 */
export function parseUsedFilters(params: URLSearchParams): UsedFilters {
  const list = (name: string, test: (value: string) => boolean) => unique(params.getAll(name).map((value) => value.trim()).filter((value) => value !== "" && test(value)));
  const filters: UsedFilters = {};
  const platform = list("platform", (value) => SLUG.test(value));
  if (platform.length) filters.platform = platform;
  const model = list("model", (value) => SLUG.test(value));
  if (model.length) filters.model = model;
  const grade = list("grade", isGrade) as UsedGrade[];
  if (grade.length) filters.grade = grade;
  const storage = list("storage", (value) => STORAGE.test(value));
  if (storage.length) filters.storage = storage;
  const location = list("location", (value) => CODE.test(value));
  if (location.length) filters.location = location;
  const priceMin = amountOf(params.get("min"));
  const priceMax = amountOf(params.get("max"));
  if (priceMin !== undefined) filters.priceMin = priceMin;
  if (priceMax !== undefined) filters.priceMax = priceMax;
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
    filters.priceMin = priceMax;
    filters.priceMax = priceMin;
  }
  const warranty = params.get("warranty");
  if (warranty && /^\d{1,4}$/.test(warranty) && Number(warranty) > 0) filters.warrantyMin = Number(warranty);
  const sort = params.get("sort");
  if (sort && (USED_SORTS as readonly string[]).includes(sort)) filters.sort = sort as UsedSort;
  const page = params.get("page");
  if (page && /^\d{1,4}$/.test(page) && Number(page) > 1) filters.page = Number(page);
  return filters;
}

/** How many filters (not counting sort and page) are on — the badge of the filter key. */
export function activeFilterCount(filters: UsedFilters): number {
  return (
    (filters.platform?.length ?? 0) +
    (filters.model?.length ?? 0) +
    (filters.grade?.length ?? 0) +
    (filters.storage?.length ?? 0) +
    (filters.location?.length ?? 0) +
    (filters.priceMin !== undefined ? 1 : 0) +
    (filters.priceMax !== undefined ? 1 : 0) +
    (filters.warrantyMin !== undefined ? 1 : 0)
  );
}

// ───────────────────────────────────────────────────────────────── SQL

/** Joins every listing query uses. No serial, no cost, no internal location name. */
const FROM = sql`
FROM used_units AS u
JOIN variants AS v ON v.id = u.variant_id
JOIN products AS p ON p.id = v.product_id
LEFT JOIN platforms AS pl ON pl.id = p.platform_id
LEFT JOIN device_models AS dm ON dm.id = p.device_model_id
LEFT JOIN inventory_locations AS il ON il.id = u.location_id
LEFT JOIN branches AS b ON b.id = il.branch_id AND b.is_active = 1`;

/** The picture of a unit: a real, public photo of it first; else the first illustration (catalogue photo of the model). */
const UNIT_IMAGE = sql`(
  SELECT json_object('a', m.art_key, 'k', CASE WHEN f.visibility = 'public' THEN f.storage_key END, 'w', f.width, 'h', f.height, 'alt', json(m.alt), 'i', m.is_illustration)
  FROM media AS m
  LEFT JOIN files AS f ON f.id = m.file_id AND f.deleted_at IS NULL
  WHERE m.owner_type = 'used_unit' AND m.owner_id = u.id AND m.kind IN ('image', 'render')
    AND (m.art_key IS NOT NULL OR (f.storage_key IS NOT NULL AND f.visibility = 'public'))
  ORDER BY CASE WHEN m.is_illustration = 0 AND f.visibility = 'public' THEN 0 ELSE 1 END, m.sort, m.id
  LIMIT 1
)`;

/** True when the unit has at least one real, public photograph of itself. */
const REAL_PHOTOS = sql`EXISTS (
  SELECT 1 FROM media AS m JOIN files AS f ON f.id = m.file_id AND f.deleted_at IS NULL
  WHERE m.owner_type = 'used_unit' AND m.owner_id = u.id AND m.kind = 'image' AND m.is_illustration = 0 AND f.visibility = 'public'
)`;

const json = (values: readonly unknown[]) => JSON.stringify(values);

function whereOf(filters: UsedFilters): SQL {
  const parts: SQL[] = [sql`u.status = 'listed'`];
  if (filters.platform?.length) parts.push(sql`pl.slug IN (SELECT value FROM json_each(${json(filters.platform)}))`);
  if (filters.model?.length) parts.push(sql`dm.slug IN (SELECT value FROM json_each(${json(filters.model)}))`);
  if (filters.grade?.length) parts.push(sql`u.grade IN (SELECT value FROM json_each(${json(filters.grade)}))`);
  if (filters.storage?.length) parts.push(sql`upper(replace(json_extract(v.options, '$.storage'), ' ', '')) IN (SELECT upper(replace(value, ' ', '')) FROM json_each(${json(filters.storage)}))`);
  if (filters.location?.length) parts.push(sql`b.code IN (SELECT value FROM json_each(${json(filters.location)}))`);
  if (filters.priceMin !== undefined) parts.push(sql`u.price_iqd >= ${filters.priceMin}`);
  if (filters.priceMax !== undefined) parts.push(sql`u.price_iqd <= ${filters.priceMax}`);
  if (filters.warrantyMin !== undefined) parts.push(sql`u.warranty_days >= ${filters.warrantyMin}`);
  if (filters.excludeId) parts.push(sql`u.id <> ${filters.excludeId}`);
  return sql.join(parts, sql` AND `);
}

function orderOf(sort: UsedSort): SQL {
  switch (sort) {
    case "price_asc":
      return sql`u.price_iqd ASC, u.id ASC`;
    case "price_desc":
      return sql`u.price_iqd DESC, u.id DESC`;
    default:
      return sql`COALESCE(u.listed_at, u.created_at) DESC, u.id DESC`;
  }
}

type ListRow = {
  id: string;
  slug: string;
  grade: UsedGrade;
  battery_health_pct: number | null;
  price_iqd: number;
  warranty_days: number;
  is_demo: number;
  listed_at: number | null;
  name: string | null;
  short: string | null;
  variant_title: string | null;
  storage: string | null;
  platform_slug: string | null;
  platform_name: string | null;
  model_slug: string | null;
  model_name: string | null;
  branch_code: string | null;
  branch_name: string | null;
  image: string | null;
  real_photos: number;
};

const LIST_COLUMNS = sql`u.id, u.slug, u.grade, u.battery_health_pct, u.price_iqd, u.warranty_days, u.is_demo, u.listed_at,
  p.name, p.short, v.title AS variant_title, json_extract(v.options, '$.storage') AS storage,
  pl.slug AS platform_slug, pl.name AS platform_name, dm.slug AS model_slug, dm.name AS model_name,
  b.code AS branch_code, b.name AS branch_name,
  ${UNIT_IMAGE} AS image, ${REAL_PHOTOS} AS real_photos`;

// ───────────────────────────────────────────────────────────────── rows → view models

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  if (value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

const l10n = (value: unknown, locale: Locale) => pick(parseJson<L10n>(value), locale);

type ImageJson = { a: string | null; k: string | null; w: number | null; h: number | null; alt: L10n | null; i: number | null };

function imageRef(raw: unknown, fallbackAlt: string, locale: Locale): ImageRef {
  const image = parseJson<ImageJson>(raw);
  if (!image) return { artKey: null, mediaKey: null, alt: fallbackAlt, isIllustration: true };
  const mediaKey = image.k ?? null;
  return {
    artKey: mediaKey ? null : (image.a ?? null),
    mediaKey,
    alt: pick(image.alt, locale) || fallbackAlt,
    // A catalogue photo is never evidence of a unit; an uploaded photo counts only when a person marked it real.
    isIllustration: mediaKey ? image.i !== 0 : true,
    ...(mediaKey && image.w && image.h ? { width: image.w, height: image.h } : {}),
  };
}

function toItem(row: ListRow, locale: Locale): UsedUnitListItem {
  const name = l10n(row.name, locale);
  const image = imageRef(row.image, name, locale);
  const storage = typeof row.storage === "string" && row.storage !== "" ? row.storage : null;
  return {
    id: row.id,
    slug: row.slug,
    name,
    // The card's fact line: the storage (the variant title mostly repeats the name); the unit page shows the full title.
    subtitle: storage ?? (l10n(row.variant_title, locale) || null),
    platformSlug: row.platform_slug ?? null,
    platformName: row.platform_name ? l10n(row.platform_name, locale) || null : null,
    grade: row.grade,
    batteryHealthPct: row.battery_health_pct ?? null,
    priceIqd: row.price_iqd,
    warrantyDays: row.warranty_days,
    image,
    hasRealPhotos: Number(row.real_photos) === 1 && !image.isIllustration,
    isDemo: row.is_demo === 1,
    model: row.model_slug ? { slug: row.model_slug, name: l10n(row.model_name, locale) || row.model_slug } : null,
    storage: typeof row.storage === "string" && row.storage !== "" ? row.storage : null,
    location: row.branch_code ? { code: row.branch_code, name: l10n(row.branch_name, locale) || row.branch_code } : null,
    listedAt: row.listed_at ?? null,
  };
}

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

// ───────────────────────────────────────────────────────────────── public API

/**
 * A page of listed used units. `total` counts every match; `nextCursor` is the next page number as text, or null on
 * the last page. Out-of-range pages return no items (and the right total).
 */
export async function listUsedUnits(db: Db, locale: Locale, filters: UsedFilters = {}): Promise<Paged<UsedUnitListItem>> {
  const limit = Math.min(MAX_USED_PAGE_SIZE, Math.max(1, Math.trunc(filters.limit ?? USED_PAGE_SIZE)));
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const where = whereOf(filters);
  const [pageResult, countResult] = await runBatch(db, [
    batchSql(db, sql`SELECT ${LIST_COLUMNS} ${FROM} WHERE ${where} ORDER BY ${orderOf(filters.sort ?? "newest")} LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}`),
    batchSql(db, sql`SELECT COUNT(*) AS n ${FROM} WHERE ${where}`),
  ]);
  const rows = rowsOf<ListRow>(pageResult);
  const total = Number(rowsOf<{ n: number }>(countResult)[0]?.n ?? 0);
  return {
    items: rows.slice(0, limit).map((row) => toItem(row, locale)),
    total,
    nextCursor: rows.length > limit ? String(page + 1) : null,
  };
}

export type UsedFacetOption = { value: string; label: string; count: number };

export type UsedFacets = {
  /** Listed units in all. */
  total: number;
  platforms: UsedFacetOption[];
  /** `platform` = the platform slug of the model (to group or light the LED). */
  models: (UsedFacetOption & { platform: string | null })[];
  grades: { value: UsedGrade; count: number }[];
  storages: UsedFacetOption[];
  /** Distinct warranty lengths in days, shortest first ("at least …" choices). */
  warranties: { days: number; count: number }[];
  locations: UsedFacetOption[];
  price: { min: number; max: number } | null;
};

type FacetRow = {
  grade: UsedGrade;
  price_iqd: number;
  warranty_days: number;
  storage: string | null;
  platform_slug: string | null;
  platform_name: string | null;
  platform_sort: number | null;
  model_slug: string | null;
  model_name: string | null;
  model_sort: number | null;
  branch_code: string | null;
  branch_name: string | null;
};

/** Storage as bytes for ordering ("512GB" < "1TB"); unknown shapes sort last. */
function storageRank(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s?(GB|TB)$/i.exec(value.trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * (match[2].toUpperCase() === "TB" ? 1024 : 1);
}

/** What the filters can offer: the values present among listed units, with how many units have each. */
export async function getUsedFacets(db: Db, locale: Locale): Promise<UsedFacets> {
  const rows = await db.all<FacetRow>(sql`
SELECT u.grade, u.price_iqd, u.warranty_days, json_extract(v.options, '$.storage') AS storage,
  pl.slug AS platform_slug, pl.name AS platform_name, pl.sort AS platform_sort,
  dm.slug AS model_slug, dm.name AS model_name, dm.sort AS model_sort,
  b.code AS branch_code, b.name AS branch_name
${FROM}
WHERE u.status = 'listed'`);
  const bump = <T extends { count: number }>(map: Map<string, T>, key: string, make: () => T) => {
    const entry = map.get(key) ?? make();
    entry.count++;
    map.set(key, entry);
  };
  const platforms = new Map<string, UsedFacetOption & { sort: number }>();
  const models = new Map<string, UsedFacetOption & { platform: string | null; sort: number; platformSort: number }>();
  const grades = new Map<string, { value: UsedGrade; count: number }>();
  const storages = new Map<string, UsedFacetOption>();
  const warranties = new Map<string, { days: number; count: number }>();
  const locations = new Map<string, UsedFacetOption>();
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const row of rows) {
    if (row.platform_slug) bump(platforms, row.platform_slug, () => ({ value: row.platform_slug!, label: l10n(row.platform_name, locale) || row.platform_slug!, count: 0, sort: row.platform_sort ?? 0 }));
    if (row.model_slug)
      bump(models, row.model_slug, () => ({ value: row.model_slug!, label: l10n(row.model_name, locale) || row.model_slug!, platform: row.platform_slug, count: 0, sort: row.model_sort ?? 0, platformSort: row.platform_sort ?? 0 }));
    bump(grades, row.grade, () => ({ value: row.grade, count: 0 }));
    if (typeof row.storage === "string" && row.storage.trim() !== "") {
      const value = row.storage.trim();
      bump(storages, value.toUpperCase().replace(/\s/g, ""), () => ({ value, label: value, count: 0 }));
    }
    bump(warranties, String(row.warranty_days), () => ({ days: row.warranty_days, count: 0 }));
    if (row.branch_code) bump(locations, row.branch_code, () => ({ value: row.branch_code!, label: l10n(row.branch_name, locale) || row.branch_code!, count: 0 }));
    min = Math.min(min, row.price_iqd);
    max = Math.max(max, row.price_iqd);
  }
  return {
    total: rows.length,
    platforms: [...platforms.values()].sort((a, b) => a.sort - b.sort || a.value.localeCompare(b.value)).map(({ value, label, count }) => ({ value, label, count })),
    models: [...models.values()]
      .sort((a, b) => a.platformSort - b.platformSort || a.sort - b.sort || a.value.localeCompare(b.value))
      .map(({ value, label, count, platform }) => ({ value, label, count, platform })),
    grades: USED_GRADE_ORDER.map((grade) => grades.get(grade)).filter((entry): entry is { value: UsedGrade; count: number } => entry !== undefined),
    storages: [...storages.values()].sort((a, b) => storageRank(a.value) - storageRank(b.value)),
    warranties: [...warranties.values()].filter((entry) => entry.days > 0).sort((a, b) => a.days - b.days),
    locations: [...locations.values()].sort((a, b) => a.label.localeCompare(b.label)),
    price: rows.length > 0 ? { min, max } : null,
  };
}

// ───────────────────────────────────────────────────────────────── one unit

/** One line of the inspection, ready for <InspectionCard> (~/ui/InspectionCard's InspectionCheck). */
export type UsedCheck = { key: string; label: string; ok: boolean; note: string | null };

export type UsedUnitDetail = {
  id: string;
  slug: string;
  /** listed = can be bought; reserved = another order holds it; sold = gone (the page says so). */
  status: "listed" | "reserved" | "sold";
  name: string;
  /** The variant: edition, storage, colour. */
  subtitle: string | null;
  platform: { slug: string; name: string } | null;
  model: { slug: string; name: string } | null;
  /** The new product this unit is an instance of. `published` = its page exists in the store. */
  product: { slug: string; name: string; published: boolean };
  /** The store's price for this variant new, when it is on sale (a fact for comparison; never a "was" price). */
  newPriceIqd: number | null;
  storage: string | null;
  grade: UsedGrade;
  /** 0–100, or null when this device's battery cannot be measured (home consoles). */
  batteryHealthPct: number | null;
  cosmeticNotes: string | null;
  defects: { area: string; severity: "minor" | "moderate" | "major"; text: string }[];
  /** What comes with the unit: the label as recorded, or null (the screen names the key). */
  included: { key: string; label: string | null }[];
  checklist: UsedCheck[];
  inspectedAt: number | null;
  ownershipChecked: boolean;
  dataWiped: boolean;
  priceIqd: number;
  warrantyDays: number;
  /** The store's return window (settings returns.window_days). */
  returnDays: number;
  /** Real photos of this unit first (public files), then illustrations (the maker's photos of the model). */
  photos: ImageRef[];
  hasRealPhotos: boolean;
  location: { code: string; name: string } | null;
  listedAt: number | null;
  isDemo: boolean;
};

type DetailRow = {
  id: string;
  slug: string;
  status: string;
  grade: UsedGrade;
  battery_health_pct: number | null;
  cosmetic_notes: string | null;
  defects: string | null;
  included: string | null;
  checklist: string | null;
  price_iqd: number;
  warranty_days: number;
  ownership_checked_at: number | null;
  data_wiped_at: number | null;
  listed_at: number | null;
  is_demo: number;
  variant_title: string | null;
  storage: string | null;
  new_price_iqd: number;
  variant_active: number;
  product_slug: string;
  product_name: string | null;
  product_status: string;
  platform_slug: string | null;
  platform_name: string | null;
  model_slug: string | null;
  model_name: string | null;
  branch_code: string | null;
  branch_name: string | null;
};

type MediaRow = { art_key: string | null; storage_key: string | null; visibility: string | null; width: number | null; height: number | null; alt: string | null; is_illustration: number };

type StoredChecklist = { templateId?: string | null; completedAt?: number | null; items?: { key?: unknown; result?: unknown; value?: unknown; note?: unknown }[] };
type TemplateItem = { key: string; label: L10n; input?: string };

const PUBLIC_STATUSES = new Set(["listed", "reserved", "sold"]);
const SEVERITIES = new Set(["minor", "moderate", "major"]);

/**
 * The page of one used unit, or null when there is no such public unit (unknown slug, or a status that is not
 * public). Checklist lines come with the inspection template's labels in the shopper's language; "not applicable" and
 * free-text lines are left out (the battery has its own row on the card, the accessories their own list).
 */
export async function getUsedUnitDetail(db: Db, locale: Locale, slug: unknown): Promise<UsedUnitDetail | null> {
  if (typeof slug !== "string" || slug.length > 120 || !SLUG.test(slug)) return null;
  const [row] = await db.all<DetailRow>(sql`
SELECT u.id, u.slug, u.status, u.grade, u.battery_health_pct, u.cosmetic_notes, u.defects, u.included, u.checklist,
  u.price_iqd, u.warranty_days, u.ownership_checked_at, u.data_wiped_at, u.listed_at, u.is_demo,
  v.title AS variant_title, json_extract(v.options, '$.storage') AS storage, v.price_iqd AS new_price_iqd, v.is_active AS variant_active,
  p.slug AS product_slug, p.name AS product_name, p.status AS product_status,
  pl.slug AS platform_slug, pl.name AS platform_name, dm.slug AS model_slug, dm.name AS model_name,
  b.code AS branch_code, b.name AS branch_name
${FROM}
WHERE u.slug = ${slug}
LIMIT 1`);
  if (!row || !PUBLIC_STATUSES.has(row.status)) return null;

  const checklist = parseJson<StoredChecklist>(row.checklist) ?? {};
  const templateId = typeof checklist.templateId === "string" ? checklist.templateId : null;
  const [mediaRows, templateRows, returnDays] = await Promise.all([
    db.all<MediaRow>(sql`
SELECT m.art_key, f.storage_key, f.visibility, f.width, f.height, m.alt, m.is_illustration
FROM media AS m
LEFT JOIN files AS f ON f.id = m.file_id AND f.deleted_at IS NULL
WHERE m.owner_type = 'used_unit' AND m.owner_id = ${row.id} AND m.kind IN ('image', 'render')
ORDER BY CASE WHEN m.is_illustration = 0 AND f.visibility = 'public' THEN 0 ELSE 1 END, m.sort, m.id`),
    templateId ? db.all<{ items: string | null }>(sql`SELECT items FROM inspection_templates WHERE id = ${templateId} LIMIT 1`) : Promise.resolve([] as { items: string | null }[]),
    getSetting(db, "returns.window_days"),
  ]);

  const name = l10n(row.product_name, locale);
  const photos: ImageRef[] = [];
  for (const media of mediaRows) {
    const alt = l10n(media.alt, locale) || name;
    if (media.storage_key && media.visibility === "public") {
      photos.push({ artKey: null, mediaKey: media.storage_key, alt, isIllustration: media.is_illustration !== 0, ...(media.width && media.height ? { width: media.width, height: media.height } : {}) });
    } else if (media.art_key) {
      // The maker's catalogue photo is never a photo of this unit, whatever the row says.
      photos.push({ artKey: media.art_key, mediaKey: null, alt, isIllustration: true });
    }
  }

  const labels = new Map<string, L10n>();
  for (const item of parseJson<TemplateItem[]>(templateRows[0]?.items) ?? []) if (item && typeof item.key === "string" && item.label) labels.set(item.key, item.label);
  const checks: UsedCheck[] = [];
  for (const item of checklist.items ?? []) {
    if (!item || typeof item.key !== "string" || item.key === "battery") continue;
    if (item.result !== "pass" && item.result !== "fail") continue; // "na" and free-text lines are not checks
    const label = pick(labels.get(item.key), locale);
    if (!label) continue;
    checks.push({ key: item.key, label, ok: item.result === "pass", note: typeof item.note === "string" && item.note.trim() !== "" ? item.note : null });
  }

  const defects = (parseJson<{ area?: unknown; severity?: unknown; note?: unknown }[]>(row.defects) ?? [])
    .map((defect) => ({
      area: typeof defect.area === "string" ? defect.area : "",
      severity: (SEVERITIES.has(String(defect.severity)) ? defect.severity : "minor") as "minor" | "moderate" | "major",
      text: pick(defect.note as L10n | null, locale),
    }))
    .filter((defect) => defect.text !== "");
  const included = (parseJson<{ key?: unknown; label?: unknown }[]>(row.included) ?? [])
    .filter((item) => typeof item.key === "string" && item.key !== "")
    .map((item) => ({ key: item.key as string, label: pick((item.label ?? null) as L10n | null, locale) || null }));

  const productPublished = row.product_status === "published";
  return {
    id: row.id,
    slug: row.slug,
    status: row.status as UsedUnitDetail["status"],
    name,
    subtitle: l10n(row.variant_title, locale) || null,
    platform: row.platform_slug ? { slug: row.platform_slug, name: l10n(row.platform_name, locale) || row.platform_slug } : null,
    model: row.model_slug ? { slug: row.model_slug, name: l10n(row.model_name, locale) || row.model_slug } : null,
    product: { slug: row.product_slug, name, published: productPublished },
    newPriceIqd: productPublished && row.variant_active === 1 && Number.isSafeInteger(row.new_price_iqd) && row.new_price_iqd > row.price_iqd ? row.new_price_iqd : null,
    storage: typeof row.storage === "string" && row.storage !== "" ? row.storage : null,
    grade: row.grade,
    batteryHealthPct: row.battery_health_pct ?? null,
    cosmeticNotes: l10n(row.cosmetic_notes, locale) || null,
    defects,
    included,
    checklist: checks,
    inspectedAt: typeof checklist.completedAt === "number" ? checklist.completedAt : null,
    ownershipChecked: row.ownership_checked_at !== null,
    dataWiped: row.data_wiped_at !== null,
    priceIqd: row.price_iqd,
    warrantyDays: row.warranty_days,
    returnDays,
    photos,
    hasRealPhotos: photos.some((photo) => !photo.isIllustration),
    location: row.branch_code ? { code: row.branch_code, name: l10n(row.branch_name, locale) || row.branch_code } : null,
    listedAt: row.listed_at ?? null,
    isDemo: row.is_demo === 1,
  };
}

/**
 * Other listed units for a unit's page: the same platform first, then any; never the unit itself. Empty when there is
 * nothing else to show (the page then shows no shelf — never placeholders).
 */
export async function getOtherUsedUnits(db: Db, locale: Locale, unit: { id: string; platformSlug: string | null }, limit = 8): Promise<UsedUnitListItem[]> {
  const same = unit.platformSlug ? (await listUsedUnits(db, locale, { platform: [unit.platformSlug], excludeId: unit.id, limit })).items : [];
  if (same.length >= limit) return same;
  const rest = (await listUsedUnits(db, locale, { excludeId: unit.id, limit })).items.filter((item) => !same.some((other) => other.id === item.id));
  return [...same, ...rest].slice(0, limit);
}
