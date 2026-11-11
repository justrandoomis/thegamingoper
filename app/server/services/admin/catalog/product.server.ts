/**
 * Admin catalogue — products: the list (02.01, filters and search), the editor's data, creating a product, saving
 * its details (texts in ar/en/ckb with Arabic required, facts, specs by spec key, custom fields) and bulk edits (02.06).
 *
 *   const page = await listProducts(db, actor, parseProductFilters(url.searchParams), locale, now);
 *   const editor = await getProductEditor(db, actor, productId, locale, now);
 *   const { productId } = await createProduct(db, actor, raw, now);
 *   await updateProductDetails(db, actor, raw, now);                 // raw.version guards concurrent edits
 *   const result = await bulkUpdateProducts(db, actor, raw, now);     // { updated, skipped }
 *
 * Permissions: catalog.product.read (list, editor), .create, .update; bulk field edits need catalog.product.import
 * ("bulk import and bulk edit"). Prices and costs are never written here; the list shows prices read-only and never
 * selects cost data. Every write goes through commitStatements (common.server.ts): version guard, version row,
 * audit event, search_index rows last.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { ImageRef } from "~/lib/dto";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  categories,
  customFields,
  deviceModels,
  platforms,
  productVersions,
  products,
  variants,
  type CustomFieldType,
  type NewVariant,
  type Product,
  type ProductKind,
  type Variant,
} from "~/server/db/schema";
import { ftsMatchQuery } from "~/server/db/search.server";
import { runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { invalidateNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
import {
  assertNoRegression,
  baselines,
  catalogError,
  commitStatements,
  customRequirementsOf,
  FACTS_COLUMNS,
  factsOf,
  parseInput,
  productCompleteness,
  requireProductState,
  requiredCustomFields,
  rethrowCatalog,
  snapshotOf,
  specRows,
  specsFromRows,
  zBool,
  zId,
  zL10n,
  zL10nRequired,
  zOptionalId,
  zReason,
  zSpecRows,
  zText,
  zVersion,
  type FactsRow,
  type ProductState,
  type RequiredField,
  type SpecRow,
} from "./common.server";
import {
  actionsFrom,
  ADMIN_STATUSES,
  adminStatusOf,
  completenessOf,
  isAdminStatus,
  isLive,
  isProductKind,
  LICENSE_TYPE_LIST,
  MEDIA_FORMAT_LIST,
  PRODUCT_KIND_LIST,
  PRODUCT_SORTS,
  SKU_PATTERN,
  SLUG_PATTERN,
  WORKFLOW,
  type AdminStatus,
  type Completeness,
  type ProductSort,
  type WorkflowAction,
} from "./rules";

// ───────────────────────────────────────────────────────────────── list

export const PAGE_SIZE = 50;

export type ProductFilters = {
  q: string;
  status: AdminStatus | null;
  /** Platform slug, or "none" for multi-platform products. */
  platform: string | null;
  category: string | null;
  kind: ProductKind | null;
  incomplete: boolean;
  sort: ProductSort;
  page: number;
};

/** Filters from the URL; unknown values are dropped (the list works without JavaScript and survives Back). */
export function parseProductFilters(params: URLSearchParams): ProductFilters {
  const text = (name: string, max = 120) => (params.get(name) ?? "").trim().slice(0, max);
  const status = text("status");
  const kind = text("kind");
  const sort = text("sort");
  const platform = text("platform", 40);
  const category = text("category", 128);
  const page = Number.parseInt(text("page", 6), 10);
  return {
    q: text("q"),
    status: isAdminStatus(status) ? status : null,
    platform: /^[a-z0-9-]{1,40}$/.test(platform) ? platform : null,
    category: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(category) ? category : null,
    kind: isProductKind(kind) ? kind : null,
    incomplete: params.get("incomplete") === "1",
    sort: (PRODUCT_SORTS as readonly string[]).includes(sort) ? (sort as ProductSort) : "updated",
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

export type ProductListRow = {
  id: string;
  slug: string;
  kind: ProductKind;
  name: string;
  brand: string | null;
  status: AdminStatus;
  storedStatus: string;
  publishAt: number | null;
  /** Scheduled, and its time has come (the storefront's product page already shows it). */
  live: boolean;
  platform: { slug: string; name: string; accent: string } | null;
  category: string | null;
  activeVariants: number;
  skus: string[];
  /** Lowest and highest price of the priced active variants; null when none is priced. */
  priceMin: number | null;
  priceMax: number | null;
  unpriced: number;
  /** Units that can be sold now (sum over active variants; bundles count complete sets). */
  available: number;
  complete: boolean;
  missing: string[];
  image: ImageRef | null;
  updatedAt: number;
};

export type ProductListResult = {
  rows: ProductListRow[];
  total: number;
  page: number;
  pageCount: number;
  /** How many products of each status match the other filters (for the status chips). */
  statusCounts: Record<AdminStatus, number>;
  incompleteCount: number;
};

type LightRow = Omit<FactsRow, "product_id"> & {
  id: string;
  slug: string;
  kind: ProductKind;
  name: string;
  brand: string | null;
  status: string;
  publish_at: number | null;
  published_at: number | null;
  updated_at: number;
  created_at: number;
  platform_id: string | null;
  category_id: string | null;
  warranty_months: number | null;
  age_rating: string | null;
  region: string | null;
  license_type: string | null;
  media_format: string | null;
  has_description: number;
  attributes_custom: string | null;
};

const likeOf = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const parseL10n = (value: unknown): L10n => {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as L10n).ar === "string") return parsed as L10n;
    } catch {
      /* not JSON */
    }
    return { ar: value };
  }
  if (value && typeof value === "object" && typeof (value as L10n).ar === "string") return value as L10n;
  return { ar: "" };
};

/** Descendant ids of a category (itself included), from the whole tree. */
function subtreeOf(rows: ReadonlyArray<{ id: string; parentId: string | null }>, rootId: string): string[] {
  const children = new Map<string | null, string[]>();
  for (const row of rows) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row.id]);
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.includes(id)) continue;
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

export async function listProducts(db: Db, actor: Actor, filters: ProductFilters, locale: Locale, now: number): Promise<ProductListResult> {
  assertCan(actor, "catalog.product.read");
  const [platformRows, categoryRows, fields] = await Promise.all([
    db.select({ id: platforms.id, slug: platforms.slug, name: platforms.name, accent: platforms.accent }).from(platforms),
    db.select({ id: categories.id, parentId: categories.parentId, name: categories.name }).from(categories),
    requiredCustomFields(db),
  ]);

  const where: SQL[] = [];
  if (filters.q) {
    const like = likeOf(filters.q);
    const match = ftsMatchQuery(filters.q);
    where.push(sql`(p.name LIKE ${like} ESCAPE '\\' OR p.slug LIKE ${like} ESCAPE '\\' OR COALESCE(p.brand, '') LIKE ${like} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND (v.sku LIKE ${like} ESCAPE '\\' OR COALESCE(v.barcode, '') LIKE ${like} ESCAPE '\\'
        OR COALESCE(json_extract(v.options, '$.model'), '') LIKE ${like} ESCAPE '\\'))
      ${match ? sql`OR p.id IN (SELECT product_id FROM search_index WHERE search_index MATCH ${match})` : sql``})`);
  }
  if (filters.platform === "none") where.push(sql`p.platform_id IS NULL`);
  else if (filters.platform) {
    const platform = platformRows.find((row) => row.slug === filters.platform);
    where.push(platform ? sql`p.platform_id = ${platform.id}` : sql`0`);
  }
  if (filters.category) {
    const ids = subtreeOf(categoryRows, filters.category);
    where.push(sql`p.category_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
  }
  if (filters.kind) where.push(sql`p.kind = ${filters.kind}`);

  // Required custom fields: one JSON lookup per key (keys are checked identifiers, see requiredCustomFields).
  const customKeys = [...new Set(fields.map((field) => field.key))];
  const customSql = customKeys.length > 0 ? sql.raw(`json_object(${customKeys.map((key) => `'${key}', json_extract(p.attributes, '$.${key}')`).join(", ")})`) : sql`NULL`;

  const light = await db.all<LightRow>(sql`
    SELECT p.id, p.slug, p.kind, p.name, p.brand, p.status, p.publish_at, p.published_at, p.updated_at, p.created_at,
      p.platform_id, p.category_id, p.warranty_months, p.age_rating, p.region, p.license_type, p.media_format,
      length(trim(COALESCE(json_extract(p.description, '$.ar'), ''))) > 0 AS has_description,
      ${customSql} AS attributes_custom,
      ${FACTS_COLUMNS}
    FROM products p
    ${where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}`);

  const evaluated = light.map((row) => {
    const name = parseL10n(row.name);
    const attributes = row.attributes_custom ? (JSON.parse(row.attributes_custom) as Record<string, unknown>) : null;
    const facts = factsOf(
      {
        kind: row.kind,
        name,
        description: row.has_description ? { ar: "x" } : null,
        warrantyMonths: row.warranty_months,
        ageRating: row.age_rating,
        region: row.region,
        licenseType: row.license_type as Product["licenseType"],
        mediaFormat: row.media_format as Product["mediaFormat"],
      },
      row,
    );
    const completeness = completenessOf(facts, customRequirementsOf(row.kind, attributes, fields));
    return { row, name, completeness, status: adminStatusOf({ status: row.status, publishedAt: row.published_at }) };
  });

  const statusCounts = Object.fromEntries(ADMIN_STATUSES.map((status) => [status, 0])) as Record<AdminStatus, number>;
  for (const entry of evaluated) statusCounts[entry.status]++;
  // Without a status filter the list shows everything except archived products.
  const byStatus = evaluated.filter((entry) => (filters.status ? entry.status === filters.status : entry.status !== "archived"));
  const incompleteCount = byStatus.filter((entry) => !entry.completeness.complete).length;
  const shown = filters.incomplete ? byStatus.filter((entry) => !entry.completeness.complete) : byStatus;

  const collator = new Intl.Collator(locale === "en" ? "en" : "ar", { sensitivity: "base", numeric: true });
  const statusOrder = (status: AdminStatus) => ADMIN_STATUSES.indexOf(status);
  shown.sort((a, b) => {
    switch (filters.sort) {
      case "created":
        return b.row.created_at - a.row.created_at || a.row.id.localeCompare(b.row.id);
      case "name":
        return collator.compare(pick(a.name, locale), pick(b.name, locale)) || a.row.id.localeCompare(b.row.id);
      case "status":
        return statusOrder(a.status) - statusOrder(b.status) || b.row.updated_at - a.row.updated_at;
      default:
        return b.row.updated_at - a.row.updated_at || a.row.id.localeCompare(b.row.id);
    }
  });

  const total = shown.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const slice = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ids = slice.map((entry) => entry.row.id);

  type DisplayRow = { product_id: string; skus: string | null; price_min: number | null; price_max: number | null; variant_ids: string | null; image: string | null };
  const display =
    ids.length === 0
      ? []
      : await db.all<DisplayRow>(sql`
    SELECT p.id AS product_id,
      (SELECT json_group_array(v.sku) FROM (SELECT sku FROM variants WHERE product_id = p.id AND is_active = 1 ORDER BY sort, id LIMIT 4) v) AS skus,
      (SELECT MIN(price_iqd) FROM variants WHERE product_id = p.id AND is_active = 1 AND price_iqd > 0) AS price_min,
      (SELECT MAX(price_iqd) FROM variants WHERE product_id = p.id AND is_active = 1 AND price_iqd > 0) AS price_max,
      (SELECT json_group_array(id) FROM variants WHERE product_id = p.id AND is_active = 1) AS variant_ids,
      (SELECT json_object('a', m.art_key, 'k', CASE WHEN f.visibility = 'public' AND f.deleted_at IS NULL THEN f.storage_key END, 'w', f.width, 'h', f.height, 'alt', json(m.alt))
         FROM media m LEFT JOIN files f ON f.id = m.file_id
         WHERE m.owner_type = 'product' AND m.owner_id = p.id AND m.kind IN ('image', 'render')
           AND (m.art_key IS NOT NULL OR (f.visibility = 'public' AND f.deleted_at IS NULL))
         ORDER BY m.sort, m.id LIMIT 1) AS image
    FROM products p WHERE p.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
  const displayOf = new Map(display.map((row) => [row.product_id, row]));
  const variantIds = display.flatMap((row) => (row.variant_ids ? (JSON.parse(row.variant_ids) as string[]) : []));
  const availability = await getAvailability(db, variantIds);

  const rows: ProductListRow[] = slice.map(({ row, name, completeness, status }) => {
    const extra = displayOf.get(row.id);
    const platform = row.platform_id ? platformRows.find((entry) => entry.id === row.platform_id) : undefined;
    const category = row.category_id ? categoryRows.find((entry) => entry.id === row.category_id) : undefined;
    const image = extra?.image ? (JSON.parse(extra.image) as { a: string | null; k: string | null; w: number | null; h: number | null; alt: L10n | null }) : null;
    const ownVariants = extra?.variant_ids ? (JSON.parse(extra.variant_ids) as string[]) : [];
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      name: pick(name, locale),
      brand: row.brand,
      status,
      storedStatus: row.status,
      publishAt: row.publish_at,
      live: isLive({ status: row.status, publishAt: row.publish_at }, now),
      platform: platform ? { slug: platform.slug, name: pick(platform.name, locale), accent: platform.accent } : null,
      category: category ? pick(category.name, locale) : null,
      activeVariants: Number(row.active),
      skus: extra?.skus ? (JSON.parse(extra.skus) as string[]) : [],
      priceMin: extra?.price_min ?? null,
      priceMax: extra?.price_max ?? null,
      unpriced: Number(row.unpriced),
      available: ownVariants.reduce((sum, id) => sum + (availability.get(id)?.available ?? 0), 0),
      complete: completeness.complete,
      missing: [...completeness.missing, ...completeness.missingCustom.map((key) => `custom:${key}`)],
      image: image && (image.a || image.k) ? { artKey: image.k ? null : image.a, mediaKey: image.k, alt: pick(image.alt, locale), isIllustration: false, ...(image.k && image.w && image.h ? { width: image.w, height: image.h } : {}) } : null,
      updatedAt: row.updated_at,
    };
  });

  return { rows, total, page, pageCount, statusCounts, incompleteCount };
}

/** Products with a variant whose SKU or barcode is exactly `code` (a scanned barcode opens its product). */
export async function productsByExactCode(db: Db, actor: Actor, code: string): Promise<string[]> {
  assertCan(actor, "catalog.product.read");
  const clean = code.trim();
  if (!clean || clean.length > 64) return [];
  const hits = await db
    .select({ productId: variants.productId })
    .from(variants)
    .where(sql`${variants.barcode} = ${clean} OR ${variants.sku} = ${clean.toUpperCase()}`);
  return [...new Set(hits.map((hit) => hit.productId))];
}

// ───────────────────────────────────────────────────────────────── options shared by the editor screens

export type CategoryOption = { id: string; label: string; depth: number; active: boolean };
export type PlatformOption = { id: string; slug: string; name: string; accent: string; active: boolean };
export type DeviceModelOption = { id: string; platformId: string; name: string; slug: string };

/** Categories in tree order with their path as the label ("Games › Nintendo Switch games"). */
export async function categoryOptions(db: Db, locale: Locale): Promise<CategoryOption[]> {
  const rows = await db.select({ id: categories.id, parentId: categories.parentId, name: categories.name, sort: categories.sort, isActive: categories.isActive }).from(categories).orderBy(asc(categories.sort), asc(categories.id));
  const children = new Map<string | null, typeof rows>();
  for (const row of rows) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  const out: CategoryOption[] = [];
  const walk = (parentId: string | null, path: string[], depth: number) => {
    for (const row of children.get(parentId) ?? []) {
      const label = [...path, pick(row.name, locale)];
      out.push({ id: row.id, label: label.join(" › "), depth, active: row.isActive });
      if (depth < 5) walk(row.id, label, depth + 1);
    }
  };
  walk(null, [], 0);
  return out;
}

export async function platformOptions(db: Db, locale: Locale): Promise<PlatformOption[]> {
  const rows = await db.select().from(platforms).orderBy(asc(platforms.sort), asc(platforms.id));
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: pick(row.name, locale), accent: row.accent, active: row.isActive }));
}

export async function deviceModelOptions(db: Db, locale: Locale): Promise<DeviceModelOption[]> {
  const rows = await db.select({ id: deviceModels.id, platformId: deviceModels.platformId, name: deviceModels.name, slug: deviceModels.slug }).from(deviceModels).orderBy(asc(deviceModels.sort), asc(deviceModels.id));
  return rows.map((row) => ({ id: row.id, platformId: row.platformId, slug: row.slug, name: pick(row.name, locale) }));
}

// ───────────────────────────────────────────────────────────────── the editor

/** A custom field value as stored in products.attributes (JSON). */
export type CustomValue = string | number | boolean | string[] | L10n | null;

export type CustomFieldDef = { key: string; label: string; type: CustomFieldType; options: { value: string; label: string }[]; required: boolean };

export type ProductEditor = {
  product: {
    id: string;
    slug: string;
    kind: ProductKind;
    status: AdminStatus;
    storedStatus: string;
    live: boolean;
    publishAt: number | null;
    publishedAt: number | null;
    version: number;
    name: L10n;
    short: L10n | null;
    description: L10n | null;
    brand: string | null;
    platformId: string | null;
    deviceModelId: string | null;
    categoryId: string | null;
    warrantyMonths: number | null;
    ageRating: string | null;
    region: string | null;
    licenseType: string | null;
    mediaFormat: string | null;
    searchKeywords: L10n | null;
    specs: SpecRow[];
    custom: Record<string, CustomValue>;
    isDemo: boolean;
    createdAt: number;
    updatedAt: number;
    /** The slug can change only before the product was ever on the storefront. */
    slugLocked: boolean;
  };
  completeness: Completeness;
  customFields: CustomFieldDef[];
  /** Workflow actions that start from this status and that the employee may take. */
  actions: WorkflowAction[];
  /** Read-only summary of the variants (prices from module 03, stock from the stock core). */
  variants: { id: string; sku: string; title: string; priceIqd: number; isActive: boolean; available: number }[];
};

export async function getProductEditor(db: Db, actor: Actor, productId: string, locale: Locale, now: number): Promise<ProductEditor> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const { product } = state;
  const [result, defs] = await Promise.all([productCompleteness(db, productId), customFieldDefs(db, product.kind, locale)]);
  if (!result) throw notFound("product");
  const availability = await getAvailability(
    db,
    state.variants.map((variant) => variant.id),
  );
  const custom: Record<string, CustomValue> = {};
  for (const def of defs) if (product.attributes && def.key in product.attributes) custom[def.key] = product.attributes[def.key] as CustomValue;
  return {
    product: {
      id: product.id,
      slug: product.slug,
      kind: product.kind,
      status: adminStatusOf(product),
      storedStatus: product.status,
      live: isLive(product, now),
      publishAt: product.publishAt,
      publishedAt: product.publishedAt,
      version: product.version,
      name: product.name,
      short: product.short,
      description: product.description,
      brand: product.brand,
      platformId: product.platformId,
      deviceModelId: product.deviceModelId,
      categoryId: product.categoryId,
      warrantyMonths: product.warrantyMonths,
      ageRating: product.ageRating,
      region: product.region,
      licenseType: product.licenseType,
      mediaFormat: product.mediaFormat,
      searchKeywords: product.searchKeywords,
      specs: specRows(product.specs),
      custom,
      isDemo: product.isDemo,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      slugLocked: product.publishedAt !== null || product.status === "published" || product.status === "scheduled",
    },
    completeness: result.completeness,
    customFields: defs,
    actions: actionsFrom(product.status).filter((action) => can(actor, WORKFLOW[action].permission)),
    variants: state.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      title: pick(variant.title, locale),
      priceIqd: variant.priceIqd,
      isActive: variant.isActive,
      available: availability.get(variant.id)?.available ?? 0,
    })),
  };
}

/** Custom fields (module 22's definitions) that apply to a product kind. */
export async function customFieldDefs(db: Db, kind: ProductKind, locale: Locale): Promise<CustomFieldDef[]> {
  const rows = await db
    .select()
    .from(customFields)
    .where(and(eq(customFields.entity, "product"), eq(customFields.isActive, true), inArray(customFields.productKind, ["*", kind])))
    .orderBy(asc(customFields.sort), asc(customFields.key));
  return rows
    .filter((row) => /^[a-z][a-z0-9_]{0,47}$/.test(row.key))
    .map((row) => ({ key: row.key, label: pick(row.label, locale), type: row.type, required: row.required, options: (row.options ?? []).map((option) => ({ value: option.value, label: pick(option.label, locale) })) }));
}

// ───────────────────────────────────────────────────────────────── create

export const CreateProductInput = z.object({
  kind: z.enum(PRODUCT_KIND_LIST, { error: "required" }),
  slug: z.string({ error: "required" }).trim().toLowerCase().min(1, "required").max(80, "too_long").regex(SLUG_PATTERN, "slug_invalid"),
  name: zL10nRequired(200),
  // An empty choice is "required" (not "invalid"): the new-product form says which field is missing.
  categoryId: z.string({ error: "required" }).trim().min(1, "required").pipe(zId),
  platformId: zOptionalId,
  brand: zText(80),
  sku: z.preprocess((value) => (typeof value === "string" ? (value.trim() === "" ? undefined : value.trim().toUpperCase()) : value), z.string().max(64, "too_long").regex(SKU_PATTERN, "sku_invalid").optional()),
});

async function assertReferences(db: Db, refs: { categoryId?: string | null; platformId?: string | null; deviceModelId?: string | null }): Promise<void> {
  const [category, platform, model] = await Promise.all([
    refs.categoryId ? db.select({ id: categories.id }).from(categories).where(eq(categories.id, refs.categoryId)).get() : Promise.resolve(null),
    refs.platformId ? db.select({ id: platforms.id }).from(platforms).where(eq(platforms.id, refs.platformId)).get() : Promise.resolve(null),
    refs.deviceModelId ? db.select({ id: deviceModels.id, platformId: deviceModels.platformId }).from(deviceModels).where(eq(deviceModels.id, refs.deviceModelId)).get() : Promise.resolve(null),
  ]);
  const fields: Record<string, string> = {};
  if (refs.categoryId && !category) fields.categoryId = "invalid";
  if (refs.platformId && !platform) fields.platformId = "invalid";
  if (refs.deviceModelId && !model) fields.deviceModelId = "invalid";
  if (model && refs.platformId && model.platformId !== refs.platformId) fields.deviceModelId = "device_platform_mismatch";
  if (Object.keys(fields).length > 0) throw invalid(fields);
}

/** Whether any variant of the product has bundle components. */
async function hasBundleComponents(db: Db, productId: string): Promise<boolean> {
  const row = await db.get<{ n: number }>(sql`SELECT EXISTS (SELECT 1 FROM bundle_items b JOIN variants v ON v.id = b.bundle_variant_id WHERE v.product_id = ${productId}) AS n`);
  return Number(row?.n ?? 0) === 1;
}

/** `demo`: the store runs in demo mode (STORE_MODE=demo) — what is created then is flagged is_demo, like demo orders. */
export async function createProduct(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ productId: string; replayed: boolean }> {
  assertCan(actor, "catalog.product.create");
  const input = parseInput(CreateProductInput, raw);
  await assertReferences(db, { categoryId: input.categoryId, platformId: input.platformId });

  const existing = await db.select({ id: products.id, name: products.name, createdBy: products.createdBy }).from(products).where(eq(products.slug, input.slug)).get();
  if (existing) {
    // A double submit of the same form: the product is already there.
    if (existing.name.ar === input.name.ar && existing.createdBy === actorRef(actor).actorId) return { productId: existing.id, replayed: true };
    throw catalogError("slug_taken", 409, { fields: { slug: "slug_taken" } });
  }
  if (input.sku) {
    const taken = await db.select({ id: variants.id }).from(variants).where(eq(variants.sku, input.sku)).get();
    if (taken) throw catalogError("sku_taken", 409, { fields: { sku: "sku_taken" } });
  }

  const productId = newId("prd");
  const by = actorRef(actor).actorId;
  const product: Product = {
    id: productId,
    slug: input.slug,
    kind: input.kind,
    name: input.name,
    short: null,
    description: null,
    brand: input.brand ?? null,
    platformId: input.platformId ?? null,
    deviceModelId: null,
    categoryId: input.categoryId,
    specs: null,
    attributes: null,
    warrantyMonths: null,
    ageRating: null,
    region: null,
    licenseType: null,
    mediaFormat: input.kind === "game" ? "physical" : input.kind === "digital" ? "digital" : null,
    status: "draft",
    publishAt: null,
    isDemo: options.demo === true,
    seo: null,
    createdAt: now,
    updatedAt: now,
    searchKeywords: null,
    preorderReleaseAt: null,
    preorderDepositIqd: null,
    version: 1,
    publishedAt: null,
    createdBy: by,
    updatedBy: by,
  };
  const variant: Variant | null = input.sku
    ? { id: newId("var"), productId, sku: input.sku, barcode: null, title: null, options: null, priceIqd: 0, compareAtIqd: null, isDefault: true, isActive: true, trackSerials: input.kind === "console", sort: 0, weightGrams: null, createdAt: now, updatedAt: now }
    : null;
  const state: ProductState = { product, variants: variant ? [variant] : [] };
  const statements: BatchStatement[] = [
    db.insert(products).values(product),
    ...(variant ? [db.insert(variants).values(variant)] : []),
    db.insert(productVersions).values({ id: newId("pver"), productId, version: 1, snapshot: snapshotOf(state), changedBy: by, reason: "created", createdAt: now }),
    auditStatement(db, { actor, action: "catalog.product.create", entityType: "product", entityId: productId, summary: input.slug, after: { slug: input.slug, kind: input.kind, name: input.name, categoryId: input.categoryId, sku: input.sku ?? null }, at: now }),
  ];
  await runBatch(db, statements).catch(rethrowCatalog);
  return { productId, replayed: false };
}

// ───────────────────────────────────────────────────────────────── details

const optionalNumber = (min: number, max: number) =>
  z.preprocess((value) => (value === "" || value === null || value === undefined ? undefined : value), z.coerce.number({ error: "invalid" }).int("invalid").min(min, "too_small").max(max, "too_big").optional());

export const ProductDetailsInput = z.object({
  productId: zId,
  version: zVersion,
  kind: z.enum(PRODUCT_KIND_LIST, { error: "required" }),
  slug: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().trim().toLowerCase().max(80, "too_long").regex(SLUG_PATTERN, "slug_invalid").optional()),
  name: zL10nRequired(200),
  short: zL10n(300, false),
  description: zL10n(8000, false),
  brand: zText(80),
  categoryId: zOptionalId,
  platformId: zOptionalId,
  deviceModelId: zOptionalId,
  warrantyMonths: optionalNumber(0, 120),
  ageRating: zText(40),
  region: zText(40),
  licenseType: z.preprocess((value) => (value === "" ? undefined : value), z.enum(LICENSE_TYPE_LIST, { error: "invalid" }).optional()),
  mediaFormat: z.preprocess((value) => (value === "" ? undefined : value), z.enum(MEDIA_FORMAT_LIST, { error: "invalid" }).optional()),
  searchKeywords: zL10n(600, false),
  specs: zSpecRows,
  custom: z.record(z.string(), z.unknown()).optional(),
  reason: zReason(false),
});

/** Custom field values from the form, typed by their definitions. Unknown keys are ignored. */
function customValues(defs: readonly CustomFieldDef[], raw: Record<string, unknown> | undefined): { values: Record<string, unknown>; errors: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const def of defs) {
    const input = raw?.[def.key];
    const text = typeof input === "string" ? input.trim() : "";
    switch (def.type) {
      case "boolean":
        values[def.key] = input === "on" || input === "true" || input === true ? true : undefined;
        break;
      case "number": {
        if (text === "") break;
        const number = Number(text);
        if (!Number.isFinite(number)) errors[`custom.${def.key}`] = "invalid";
        else values[def.key] = number;
        break;
      }
      case "l10n": {
        const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
        const ar = String(record.ar ?? "").trim();
        if (ar) values[def.key] = { ar, ...(String(record.en ?? "").trim() ? { en: String(record.en).trim() } : {}), ...(String(record.ckb ?? "").trim() ? { ckb: String(record.ckb).trim() } : {}) };
        break;
      }
      case "multiselect": {
        const list = (Array.isArray(input) ? input.map(String) : text.split(",")).map((item) => item.trim()).filter(Boolean);
        if (list.some((item) => !def.options.some((option) => option.value === item))) errors[`custom.${def.key}`] = "invalid";
        else if (list.length > 0) values[def.key] = list;
        break;
      }
      case "select":
        if (text === "") break;
        if (!def.options.some((option) => option.value === text)) errors[`custom.${def.key}`] = "invalid";
        else values[def.key] = text;
        break;
      case "date":
        if (text === "") break;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) errors[`custom.${def.key}`] = "invalid";
        else values[def.key] = text;
        break;
      default:
        if (text.length > 500) errors[`custom.${def.key}`] = "too_long";
        else if (text) values[def.key] = text;
    }
  }
  return { values, errors };
}

export async function updateProductDetails(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ version: number }> {
  assertCan(actor, "catalog.product.update");
  const input = parseInput(ProductDetailsInput, raw);
  const state = await requireProductState(db, input.productId);
  const { product } = state;
  if (product.version !== input.version) throw catalogError("product_changed");
  if (product.status === "archived") throw catalogError("status_not_allowed", 409, { detail: "archived" });
  // A variant with components IS a bundle for the stock core whatever the product says: units received for it would
  // never be sold. The kind stays "bundle" until its components are removed.
  if (product.kind === "bundle" && input.kind !== "bundle" && (await hasBundleComponents(db, product.id))) throw invalid({ kind: "kind_has_components" });
  await assertReferences(db, { categoryId: input.categoryId, platformId: input.platformId, deviceModelId: input.deviceModelId });

  const slugLocked = product.publishedAt !== null || product.status === "published" || product.status === "scheduled";
  if (input.slug && input.slug !== product.slug) {
    if (slugLocked) throw invalid({ slug: "slug_locked" });
    const taken = await db.select({ id: products.id }).from(products).where(eq(products.slug, input.slug)).get();
    if (taken) throw catalogError("slug_taken", 409, { fields: { slug: "slug_taken" } });
  }

  const defs = await customFieldDefs(db, input.kind, "ar");
  const custom = customValues(defs, input.custom);
  if (Object.keys(custom.errors).length > 0) throw invalid(custom.errors);
  const attributes: Record<string, unknown> = { ...(product.attributes ?? {}) };
  for (const def of defs) {
    if (custom.values[def.key] === undefined) delete attributes[def.key];
    else attributes[def.key] = custom.values[def.key];
  }

  const next: Product = {
    ...product,
    kind: input.kind,
    slug: input.slug && !slugLocked ? input.slug : product.slug,
    name: input.name,
    short: input.short,
    description: input.description,
    brand: input.brand ?? null,
    categoryId: input.categoryId ?? null,
    platformId: input.platformId ?? null,
    deviceModelId: input.deviceModelId ?? null,
    warrantyMonths: input.warrantyMonths ?? null,
    ageRating: input.ageRating ?? null,
    region: input.region ?? null,
    licenseType: input.licenseType ?? null,
    mediaFormat: input.mediaFormat ?? null,
    searchKeywords: input.searchKeywords,
    specs: specsFromRows(input.specs),
    attributes: Object.keys(attributes).length > 0 ? attributes : null,
  };

  // A live (or scheduled) product may not lose a requirement it meets today.
  const before = await productCompleteness(db, product.id);
  if (!before) throw notFound("product");
  const fields = await requiredCustomFields(db);
  const categoryOk = next.categoryId === product.categoryId ? before.facts.categoryOk : next.categoryId ? Boolean((await db.select({ ok: categories.isActive }).from(categories).where(eq(categories.id, next.categoryId)).get())?.ok) : false;
  const afterFacts = {
    ...before.facts,
    kind: next.kind,
    nameAr: next.name.ar,
    descriptionAr: next.description?.ar ?? null,
    categoryOk,
    warrantyMonths: next.warrantyMonths,
    ageRating: next.ageRating,
    region: next.region,
    licenseType: next.licenseType,
    mediaFormat: next.mediaFormat,
  };
  assertNoRegression(product.status, before.completeness, completenessOf(afterFacts, customRequirementsOf(next.kind, next.attributes, fields)));

  const hasBaseline = (await baselines(db, [product])).has(product.id);
  const plan = commitStatements(db, { actor, now, before: state, after: { product: next, variants: state.variants }, action: "catalog.product.update", reason: input.reason ?? null, hasBaseline });
  await runBatch(db, [...plan.statements, ...plan.search]).catch(rethrowCatalog);
  if (product.status === "published") invalidateNavTaxonomy(db);
  return { version: plan.version };
}

// ───────────────────────────────────────────────────────────────── bulk edit (02.06)

export const BULK_MAX = 100;
/** Products written per batch: each one is its own guarded change, the batch keeps every chunk atomic. */
const BULK_CHUNK = 25;

export const BulkUpdateInput = z.object({
  ids: z.array(zId).min(1, "required").max(BULK_MAX, "too_big"),
  set: z
    .object({
      categoryId: zOptionalId,
      brand: zText(80),
      warrantyMonths: optionalNumber(0, 120),
      ageRating: zText(40),
      region: zText(40),
      licenseType: z.preprocess((value) => (value === "" ? undefined : value), z.enum(LICENSE_TYPE_LIST, { error: "invalid" }).optional()),
      mediaFormat: z.preprocess((value) => (value === "" ? undefined : value), z.enum(MEDIA_FORMAT_LIST, { error: "invalid" }).optional()),
    })
    .refine((set) => Object.values(set).some((value) => value !== undefined), { message: "nothing_to_change" }),
  reason: zReason(true),
});

export type BulkOutcome = { updated: string[]; skipped: { id: string; reason: string }[] };

/**
 * Sets the same facts on many products. Only the fields given change; a product that would lose a requirement while
 * live, or that is archived, is skipped with its reason. Each product gets its own version row and audit event.
 */
export async function bulkUpdateProducts(db: Db, actor: Actor, raw: unknown, now: number): Promise<BulkOutcome> {
  assertCan(actor, "catalog.product.import");
  assertCan(actor, "catalog.product.update");
  const input = parseInput(BulkUpdateInput, raw);
  const set = input.set;
  if (set.categoryId) await assertReferences(db, { categoryId: set.categoryId });
  // Completeness needs an ACTIVE category: moving live products into a switched-off one would strip them.
  const targetCategoryOk = set.categoryId ? Boolean((await db.select({ ok: categories.isActive }).from(categories).where(eq(categories.id, set.categoryId)).get())?.ok) : null;
  const ids = [...new Set(input.ids)];
  const outcome: BulkOutcome = { updated: [], skipped: [] };
  const fields = await requiredCustomFields(db);

  for (let start = 0; start < ids.length; start += BULK_CHUNK) {
    const chunk = ids.slice(start, start + BULK_CHUNK);
    const states = (await Promise.all(chunk.map((id) => requireProductState(db, id).catch(() => null)))).filter((state): state is ProductState => state !== null);
    for (const id of chunk) if (!states.some((state) => state.product.id === id)) outcome.skipped.push({ id, reason: "not_found" });
    const haveBaseline = await baselines(db, states.map((state) => state.product));
    const statements: BatchStatement[] = [];
    const search: BatchStatement[] = [];
    const written: string[] = [];
    for (const state of states) {
      const { product } = state;
      if (product.status === "archived") {
        outcome.skipped.push({ id: product.id, reason: "status_not_allowed" });
        continue;
      }
      const next: Product = {
        ...product,
        categoryId: set.categoryId ?? product.categoryId,
        brand: set.brand ?? product.brand,
        warrantyMonths: set.warrantyMonths ?? product.warrantyMonths,
        ageRating: set.ageRating ?? product.ageRating,
        region: set.region ?? product.region,
        licenseType: set.licenseType ?? product.licenseType,
        mediaFormat: set.mediaFormat ?? product.mediaFormat,
      };
      if (JSON.stringify(next) === JSON.stringify(product)) {
        outcome.skipped.push({ id: product.id, reason: "unchanged" });
        continue;
      }
      const before = await productCompleteness(db, product.id);
      if (!before) continue;
      const after = completenessOf(
        { ...before.facts, warrantyMonths: next.warrantyMonths, ageRating: next.ageRating, region: next.region, licenseType: next.licenseType, mediaFormat: next.mediaFormat, categoryOk: targetCategoryOk ?? before.facts.categoryOk },
        customRequirementsOf(next.kind, next.attributes, fields),
      );
      try {
        assertNoRegression(product.status, before.completeness, after);
      } catch {
        outcome.skipped.push({ id: product.id, reason: "regression" });
        continue;
      }
      const plan = commitStatements(db, { actor, now, before: state, after: { product: next, variants: state.variants }, action: "catalog.product.bulk_update", reason: input.reason, hasBaseline: haveBaseline.has(product.id) });
      statements.push(...plan.statements);
      search.push(...plan.search);
      written.push(product.id);
    }
    if (written.length === 0) continue;
    await runBatch(db, [...statements, ...search]).catch(rethrowCatalog);
    outcome.updated.push(...written);
  }
  if (outcome.updated.length > 0) invalidateNavTaxonomy(db);
  return outcome;
}

// ───────────────────────────────────────────────────────────────── helpers other services use

/** Variants of a product as NewVariant rows (for inserts built elsewhere). */
export function newVariantRow(productId: string, input: Omit<NewVariant, "id" | "productId" | "priceIqd">): NewVariant {
  return { id: newId("var"), productId, priceIqd: 0, ...input };
}

export type { RequiredField };
