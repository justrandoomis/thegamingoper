/**
 * Admin catalogue (module 02) — what every catalogue service shares: loading a product as one state, its version
 * snapshot, the facts completeness is decided from, input helpers, and THE write path every change to a product
 * goes through (commitStatements):
 *
 *   1. a baseline version row when the product has none for its current version (seeded products start at
 *      version 1 without a row), so the history always shows where a change started from
 *   2. the product row, guarded by its version (optimistic concurrency: a second tab or a double submit that loaded
 *      the same version fails with `product_changed` instead of overwriting)
 *   3. variant updates and inserts
 *   4. the new version row (full snapshot — never cost data) and the audit event
 *   5. the product's search_index rows — returned SEPARATELY, because they must come last in the batch
 *      (drizzle/README.md: FTS5 writes distort the change counts every later guard reads)
 *
 * Prices (price_iqd, compare_at_iqd) and costs belong to module 03 (pricing) and stock to the stock core: this module
 * reads prices for display and never writes them; a new variant starts without a price (0 = "not set yet"), which
 * keeps it from being published until Pricing sets one.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { L10n } from "~/lib/locales";
import { newId } from "~/lib/ids";
import { actorRef, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { customFields, productVersions, products, variants, type NewVariant, type Product, type ProductKind, type Specs, type Variant } from "~/server/db/schema";
import { expectChanged } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { completenessOf, newlyMissing, type Completeness, type CompletenessFacts, type CustomRequirement } from "./rules";
import { productSearchStatements } from "./search-index.server";

// ───────────────────────────────────────────────────────────────── errors

/** Error keys this module's services throw (translated as `errors.<key>` in the admin-catalog namespace). */
export const CATALOG_ERROR_KEYS = [
  "product_changed",
  "incomplete",
  "regression",
  "status_not_allowed",
  "slug_taken",
  "sku_taken",
  "barcode_invalid",
  "barcode_taken",
  "category_cycle",
  "category_not_empty",
  "category_depth",
  "track_serials_locked",
  "variant_last_active",
  "bundle_kind",
  "bundle_stocked",
  "bundle_nested",
  "bundle_self",
  "component_unknown",
  "relation_self",
  "target_unknown",
  "subject_unknown",
  "generation_platform",
  "photo_unknown",
  "media_duplicate",
  "schedule_past",
  "schedule_far",
  "import_changed",
  "import_state",
  "import_empty",
  "version_unknown",
  "nothing_to_restore",
] as const;
export type CatalogErrorKey = (typeof CATALOG_ERROR_KEYS)[number];

export function catalogError(code: CatalogErrorKey, status = 409, options: { fields?: Record<string, string>; detail?: string } = {}): AppError {
  return new AppError(code, status, options);
}

/** Runs a batch and turns the module's guard failures (TT:PRODUCT_CHANGED…) into their AppErrors. */
export function rethrowCatalog(error: unknown): never {
  const appError = toAppError(error);
  if (appError && /^(product_changed|track_serials_locked|import_changed|import_state|category_cycle|bundle_stocked|barcode_taken|regression)$/.test(appError.code)) {
    throw new AppError(appError.code, 409, { detail: appError.detail, cause: error });
  }
  if (appError?.code === "unique") {
    if (appError.detail?.includes("variants.sku")) throw new AppError("sku_taken", 409, { fields: { sku: "sku_taken" }, cause: error });
    if (appError.detail?.includes("products.slug") || appError.detail?.includes("categories.slug") || appError.detail?.includes("slug")) throw new AppError("slug_taken", 409, { fields: { slug: "slug_taken" }, cause: error });
  }
  throw error;
}

// ───────────────────────────────────────────────────────────────── input helpers

/** Form values arrive as strings; "" means "not given". */
const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const zText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max, "too_long").optional());
export const zRequiredText = (max: number) => z.string({ error: "required" }).trim().min(1, "required").max(max, "too_long");
export const zId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid");
export const zOptionalId = z.preprocess(blankToUndefined, zId.optional());
export const zBool = z.preprocess((value) => value === true || value === "true" || value === "on" || value === "1", z.boolean());
export const zVersion = z.coerce.number({ error: "invalid" }).int("invalid").min(1, "invalid");
export const zReason = (required: boolean) =>
  required ? z.string({ error: "reason_required" }).trim().min(3, "reason_required").max(500, "too_long") : zText(500);

/** A localized text from a form: Arabic required (`required`) or optional; empty translations are left out. */
export function zL10n(max: number, required: boolean) {
  const ar = required ? zRequiredText(max) : zText(max);
  return z
    .object({ ar, en: zText(max), ckb: zText(max) })
    .optional()
    .transform((value): L10n | null => {
      if (!value || !value.ar) return null;
      const out: L10n = { ar: value.ar };
      if (value.en) out.en = value.en;
      if (value.ckb) out.ckb = value.ckb;
      return out;
    });
}

/** A required L10n (never null after parsing). */
export function zL10nRequired(max: number) {
  return z.object({ ar: zRequiredText(max), en: zText(max), ckb: zText(max) }, { error: "required" }).transform((value): L10n => {
    const out: L10n = { ar: value.ar };
    if (value.en) out.en = value.en;
    if (value.ckb) out.ckb = value.ckb;
    return out;
  });
}

/** Parses with a zod schema; failures become AppError("invalid", 400, { fields }). */
export function parseInput<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const failure = toAppError(result.error);
    throw failure ?? invalid({ _: "invalid" });
  }
  return result.data;
}

// ───────────────────────────────────────────────────────────────── product state and snapshot

export type ProductState = { product: Product; variants: Variant[] };

export async function loadProductState(db: Db, productId: string): Promise<ProductState | null> {
  const [productRows, variantRows] = await db.batch([
    db.select().from(products).where(eq(products.id, productId)).limit(1),
    db.select().from(variants).where(eq(variants.productId, productId)).orderBy(asc(variants.sort), asc(variants.id)),
  ]);
  const product = productRows[0];
  return product ? { product, variants: variantRows } : null;
}

export async function requireProductState(db: Db, productId: string): Promise<ProductState> {
  const state = await loadProductState(db, productId);
  if (!state) throw notFound("product");
  return state;
}

/** Product fields a version snapshot keeps (no cost data: costs live in variant_costs, which is never read here). */
export const SNAPSHOT_PRODUCT_FIELDS = [
  "slug",
  "kind",
  "name",
  "short",
  "description",
  "brand",
  "platformId",
  "deviceModelId",
  "categoryId",
  "specs",
  "attributes",
  "warrantyMonths",
  "ageRating",
  "region",
  "licenseType",
  "mediaFormat",
  "seo",
  "searchKeywords",
  "status",
  "publishAt",
  "publishedAt",
  "preorderReleaseAt",
] as const satisfies readonly (keyof Product)[];
export const SNAPSHOT_VARIANT_FIELDS = ["id", "sku", "barcode", "title", "options", "priceIqd", "compareAtIqd", "isDefault", "isActive", "trackSerials", "sort"] as const satisfies readonly (keyof Variant)[];

export type SnapshotProduct = Pick<Product, (typeof SNAPSHOT_PRODUCT_FIELDS)[number]>;
export type SnapshotVariant = Pick<Variant, (typeof SNAPSHOT_VARIANT_FIELDS)[number]>;
export type ProductSnapshot = { schema: 1; product: SnapshotProduct; variants: SnapshotVariant[] };

const pickFields = <T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> => {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = row[key];
  return out;
};

export function snapshotOf(state: ProductState): ProductSnapshot {
  return { schema: 1, product: pickFields(state.product, SNAPSHOT_PRODUCT_FIELDS), variants: state.variants.map((variant) => pickFields(variant, SNAPSHOT_VARIANT_FIELDS)) };
}

/** Reads a stored snapshot defensively (rows written by other code may lack fields). */
export function readSnapshot(value: unknown): ProductSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { product?: unknown; variants?: unknown };
  if (typeof record.product !== "object" || record.product === null) return null;
  return { schema: 1, product: record.product as SnapshotProduct, variants: Array.isArray(record.variants) ? (record.variants as SnapshotVariant[]) : [] };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Names of the snapshot fields that differ ("name", "variants.SKU-1.title", "variants.SKU-2 (new)"). */
export function changedFields(before: ProductSnapshot | null, after: ProductSnapshot): string[] {
  if (!before) return ["created"];
  const changes: string[] = [];
  for (const key of SNAPSHOT_PRODUCT_FIELDS) if (!same(before.product[key], after.product[key])) changes.push(key);
  const old = new Map(before.variants.map((variant) => [variant.id, variant]));
  for (const variant of after.variants) {
    const previous = old.get(variant.id);
    if (!previous) {
      changes.push(`variants.${variant.sku}.added`);
      continue;
    }
    for (const key of SNAPSHOT_VARIANT_FIELDS) if (key !== "id" && !same(previous[key], variant[key])) changes.push(`variants.${variant.sku}.${key}`);
  }
  return changes;
}

/** Only the changed top-level values, for the audit trail's before/after. */
function auditDiff(before: ProductSnapshot, after: ProductSnapshot): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of SNAPSHOT_PRODUCT_FIELDS) {
    if (same(before.product[key], after.product[key])) continue;
    // Long research attributes would crowd the trail: name the change, keep the values in the version snapshot.
    if (key === "attributes" || key === "specs" || key === "description") {
      b[key] = "(see version history)";
      a[key] = "(see version history)";
      continue;
    }
    b[key] = before.product[key];
    a[key] = after.product[key];
  }
  const variantChanges = changedFields(before, after).filter((name) => name.startsWith("variants."));
  if (variantChanges.length > 0) a.variants = variantChanges;
  return { before: b, after: a };
}

// ───────────────────────────────────────────────────────────────── completeness facts

export type FactsRow = {
  product_id: string;
  active: number;
  unpriced: number;
  images: number;
  compat: number;
  variants_region: number;
  no_components: number;
  category_ok: number;
};

/** SQL columns computing completeness facts for the products row aliased `p` (one row per product). */
export const FACTS_COLUMNS = sql.raw(`
  (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) AS active,
  (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.is_active = 1 AND v.price_iqd <= 0) AS unpriced,
  (SELECT COUNT(*) FROM media m LEFT JOIN files f ON f.id = m.file_id
     WHERE m.owner_type = 'product' AND m.owner_id = p.id AND m.kind IN ('image', 'render')
       AND (m.art_key IS NOT NULL OR (f.id IS NOT NULL AND f.visibility = 'public' AND f.deleted_at IS NULL))) AS images,
  (SELECT COUNT(*) FROM compatibility_rules r WHERE r.status IN ('verified', 'partial')
     AND ((r.subject_type = 'product' AND r.subject_id = p.id)
       OR (r.subject_type = 'variant' AND r.subject_id IN (SELECT vv.id FROM variants vv WHERE vv.product_id = p.id)))) AS compat,
  NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_active = 1
     AND COALESCE(TRIM(json_extract(v.options, '$.region')), '') = '') AS variants_region,
  (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.is_active = 1
     AND NOT EXISTS (SELECT 1 FROM bundle_items b WHERE b.bundle_variant_id = v.id)) AS no_components,
  EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.is_active = 1) AS category_ok`);

export function factsOf(
  row: Pick<Product, "kind" | "name" | "description" | "warrantyMonths" | "ageRating" | "region" | "licenseType" | "mediaFormat">,
  counts: Omit<FactsRow, "product_id">,
): CompletenessFacts {
  return {
    kind: row.kind,
    nameAr: row.name?.ar ?? null,
    descriptionAr: row.description?.ar ?? null,
    categoryOk: Number(counts.category_ok) === 1,
    activeVariants: Number(counts.active),
    unpricedVariants: Number(counts.unpriced),
    images: Number(counts.images),
    compatibleRules: Number(counts.compat),
    warrantyMonths: row.warrantyMonths,
    ageRating: row.ageRating,
    region: row.region,
    variantsHaveRegion: Number(counts.variants_region) === 1,
    licenseType: row.licenseType,
    mediaFormat: row.mediaFormat,
    variantsWithoutComponents: Number(counts.no_components),
  };
}

/** A required custom field (module 22's `custom_fields`) that applies to products of some kind. */
export type RequiredField = { key: string; label: L10n; kind: string };

const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,47}$/;

/** Active, required custom fields for products (all kinds); keys that could not be a JSON path are ignored. */
export async function requiredCustomFields(db: Db): Promise<RequiredField[]> {
  const rows = await db
    .select({ key: customFields.key, label: customFields.label, kind: customFields.productKind })
    .from(customFields)
    .where(and(eq(customFields.entity, "product"), eq(customFields.required, true), eq(customFields.isActive, true)))
    .orderBy(asc(customFields.sort), asc(customFields.key));
  return rows.filter((row) => CUSTOM_KEY.test(row.key));
}

const isFilledValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return typeof (value as { ar?: unknown }).ar === "string" && ((value as { ar: string }).ar.trim() !== "");
  return true;
};

export function customRequirementsOf(kind: ProductKind, attributes: Record<string, unknown> | null, fields: readonly RequiredField[]): CustomRequirement[] {
  return fields.filter((field) => field.kind === "*" || field.kind === kind).map((field) => ({ key: field.key, label: field.label, filled: isFilledValue(attributes?.[field.key]) }));
}

/** Completeness of one product as it is in the database now. */
export async function productCompleteness(db: Db, productId: string, overrides?: Partial<Product>): Promise<{ completeness: Completeness; facts: CompletenessFacts } | null> {
  const [product, counts, fields] = await Promise.all([
    db.select().from(products).where(eq(products.id, productId)).get(),
    db.all<FactsRow>(sql`SELECT p.id AS product_id, ${FACTS_COLUMNS} FROM products p WHERE p.id = ${productId}`),
    requiredCustomFields(db),
  ]);
  const factRow = counts[0];
  if (!product || !factRow) return null;
  const merged = { ...product, ...overrides };
  const facts = factsOf(merged, factRow);
  return { facts, completeness: completenessOf(facts, customRequirementsOf(merged.kind, merged.attributes, fields)) };
}

/** Completeness from facts adjusted in memory (what a change WOULD leave). */
export function completenessWith(facts: CompletenessFacts, change: Partial<CompletenessFacts>, custom: readonly CustomRequirement[] = []): Completeness {
  return completenessOf({ ...facts, ...change }, custom);
}

/**
 * A change may not make a product that is on the storefront (published) or committed to go there (scheduled) less
 * complete than it is: throws `regression` with the requirements the change would break.
 */
export function assertNoRegression(status: string, before: Completeness, after: Completeness): void {
  if (status !== "published" && status !== "scheduled") return;
  const lost = newlyMissing(before, after);
  if (lost.length > 0) throw new AppError("regression", 409, { detail: lost.join(",") });
}

// ───────────────────────────────────────────────────────────────── the write path

export type CommitInput = {
  actor: Actor;
  now: number;
  /** The state the change was decided on — its version is the guard. */
  before: ProductState;
  /** The state to store: product fields and the variants (existing ones updated by id, `insert` ones added). */
  after: { product: Product; variants: Variant[] };
  /** Variants in `after.variants` that do not exist yet. */
  inserts?: NewVariant[];
  /** Audit action, e.g. "catalog.product.update". */
  action: string;
  reason?: string | null;
  summary?: string | null;
  /** Statements placed after the product writes and before the version row (media, relations…). Never search_index. */
  extra?: BatchStatement[];
  /** Whether a version row exists for `before.product.version` (else a baseline row is written). */
  hasBaseline: boolean;
};

export type CommitPlan = {
  /** Writes, guarded — run them first. */
  statements: BatchStatement[];
  /** The search_index rows of the product — put them at the very END of the batch. */
  search: BatchStatement[];
  version: number;
};

const PRODUCT_WRITABLE = [
  "slug",
  "kind",
  "name",
  "short",
  "description",
  "brand",
  "platformId",
  "deviceModelId",
  "categoryId",
  "specs",
  "attributes",
  "warrantyMonths",
  "ageRating",
  "region",
  "licenseType",
  "mediaFormat",
  "seo",
  "searchKeywords",
  "status",
  "publishAt",
  "publishedAt",
] as const satisfies readonly (keyof Product)[];
/** Variant columns this module writes (never price_iqd / compare_at_iqd: those are module 03's). */
const VARIANT_WRITABLE = ["sku", "barcode", "title", "options", "isDefault", "isActive", "trackSerials", "sort", "weightGrams"] as const satisfies readonly (keyof Variant)[];

export function commitStatements(db: Db, input: CommitInput): CommitPlan {
  const { actor, now, before } = input;
  const productId = before.product.id;
  const fromVersion = before.product.version;
  const version = fromVersion + 1;
  const by = actorRef(actor).actorId;
  const statements: BatchStatement[] = [];

  if (!input.hasBaseline) {
    statements.push(
      db
        .insert(productVersions)
        .values({ id: newId("pver"), productId, version: fromVersion, snapshot: snapshotOf(before), changedBy: null, reason: "baseline", createdAt: before.product.updatedAt })
        .onConflictDoNothing(),
    );
  }

  const productSet: Partial<Product> = {};
  for (const key of PRODUCT_WRITABLE) (productSet as Record<string, unknown>)[key] = input.after.product[key];
  statements.push(
    db
      .update(products)
      .set({ ...productSet, version, updatedAt: now, updatedBy: by })
      .where(and(eq(products.id, productId), eq(products.version, fromVersion))),
    expectChanged(db, 1, { code: "PRODUCT_CHANGED", detail: productId }),
  );

  const previous = new Map(before.variants.map((variant) => [variant.id, variant]));
  const inserted = new Set((input.inserts ?? []).map((row) => row.id));
  for (const variant of input.after.variants) {
    const old = previous.get(variant.id);
    if (!old || inserted.has(variant.id)) continue;
    const set: Partial<Variant> = {};
    let changed = false;
    for (const key of VARIANT_WRITABLE) {
      if (!same(old[key], variant[key])) {
        (set as Record<string, unknown>)[key] = variant[key];
        changed = true;
      }
    }
    if (changed) statements.push(db.update(variants).set({ ...set, updatedAt: now }).where(and(eq(variants.id, variant.id), eq(variants.productId, productId))));
  }
  for (const row of input.inserts ?? []) statements.push(db.insert(variants).values({ ...row, priceIqd: 0, compareAtIqd: null, createdAt: now, updatedAt: now }));

  statements.push(...(input.extra ?? []));

  const afterState: ProductState = { product: { ...input.after.product, version, updatedAt: now }, variants: input.after.variants };
  const beforeSnapshot = snapshotOf(before);
  const afterSnapshot = snapshotOf(afterState);
  statements.push(
    db.insert(productVersions).values({ id: newId("pver"), productId, version, snapshot: afterSnapshot, changedBy: by, reason: input.reason ?? null, createdAt: now }),
    auditStatement(db, {
      actor,
      action: input.action,
      entityType: "product",
      entityId: productId,
      summary: input.summary ?? `${before.product.slug} v${fromVersion} → v${version}`,
      ...auditDiff(beforeSnapshot, afterSnapshot),
      reason: input.reason ?? null,
      at: now,
    }),
  );

  const search = productSearchStatements(db, productId, {
    status: input.after.product.status,
    name: input.after.product.name,
    short: input.after.product.short,
    description: input.after.product.description,
    brand: input.after.product.brand,
    searchKeywords: input.after.product.searchKeywords,
    attributes: input.after.product.attributes,
    variants: input.after.variants,
  });
  return { statements, search, version };
}

/** Whether a version row exists for each product's current version. */
export async function baselines(db: Db, rows: ReadonlyArray<{ id: string; version: number }>): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const found = await db
    .select({ productId: productVersions.productId, version: productVersions.version })
    .from(productVersions)
    .where(inArray(productVersions.productId, rows.map((row) => row.id)));
  const have = new Set(found.map((row) => `${row.productId}@${row.version}`));
  return new Set(rows.filter((row) => have.has(`${row.id}@${row.version}`)).map((row) => row.id));
}

// ───────────────────────────────────────────────────────────────── small shared readers

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ───────────────────────────────────────────────────────────────── barcodes: one code, one variant

/** The extra barcodes the research recorded per SKU (attributes.variantBarcodes; each list includes the SKU's own). */
export function recordedBarcodes(attributes: Record<string, unknown> | null | undefined): Record<string, string[]> {
  if (!attributes || !isRecord(attributes.variantBarcodes)) return {};
  const out: Record<string, string[]> = {};
  for (const [sku, codes] of Object.entries(attributes.variantBarcodes)) if (Array.isArray(codes)) out[sku] = codes.filter((code): code is string => typeof code === "string" && code !== "");
  return out;
}

/** A place a barcode is recorded: a variant's own column (`variantId` set), or the extra codes listed for a SKU. */
export type BarcodeHolder = { code: string; sku: string; variantId: string | null; productId: string };

/** Extra-code lists of every product, as rows (sku, code) — malformed attributes read as none. */
const RECORDED_CODES = sql.raw(`products p,
  json_each(CASE WHEN json_valid(p.attributes) AND json_type(p.attributes, '$.variantBarcodes') = 'object' THEN json_extract(p.attributes, '$.variantBarcodes') ELSE '{}' END) AS s,
  json_each(CASE WHEN s.type = 'array' THEN s.value ELSE '[]' END) AS c`);

/**
 * Where these barcodes are recorded now. Receiving, stock counts, transfers and packing find a variant by a scanned
 * code (the first match wins), so a code must name ONE variant: a code that another variant holds is refused
 * (`barcode_taken`) by every path that writes barcodes — the variant editor, the CSV import and the safe restore.
 */
export async function barcodeHolders(db: Db, codes: readonly string[]): Promise<BarcodeHolder[]> {
  const wanted = [...new Set(codes.filter((code) => typeof code === "string" && code !== ""))];
  if (wanted.length === 0) return [];
  const json = JSON.stringify(wanted);
  const rows = await db.all<{ code: string; sku: string; variant_id: string | null; product_id: string }>(sql`
    SELECT v.barcode AS code, v.sku AS sku, v.id AS variant_id, v.product_id AS product_id
      FROM variants v WHERE v.barcode IN (SELECT value FROM json_each(${json}))
    UNION ALL
    SELECT c.value AS code, s.key AS sku, NULL AS variant_id, p.id AS product_id
      FROM ${RECORDED_CODES} WHERE c.value IN (SELECT value FROM json_each(${json}))`);
  return rows.map((row) => ({ code: String(row.code), sku: row.sku, variantId: row.variant_id, productId: row.product_id }));
}

/** Every barcode recorded anywhere (a variant's column or a SKU's extra codes) — for checking a whole file at once. */
export async function recordedBarcodeSet(db: Db): Promise<Set<string>> {
  const rows = await db.all<{ code: string }>(sql`SELECT barcode AS code FROM variants WHERE barcode IS NOT NULL UNION SELECT c.value AS code FROM ${RECORDED_CODES}`);
  return new Set(rows.map((row) => String(row.code)));
}

/** A spec row as the editor shows it: key, label and value in three languages. */
export type SpecRow = { key: string; label: L10n; value: L10n };

/** Reads products.specs / device_models.specs (L10n + label, plain strings, numbers or yes/no) into editor rows. */
export function specRows(specs: Specs | null | undefined): SpecRow[] {
  if (!specs || !isRecord(specs)) return [];
  const rows: SpecRow[] = [];
  for (const [key, raw] of Object.entries(specs)) {
    let value: L10n;
    let label: L10n = { ar: key };
    if (isRecord(raw)) {
      const record = raw as Record<string, unknown>;
      value = { ar: String(record.ar ?? ""), ...(record.en ? { en: String(record.en) } : {}), ...(record.ckb ? { ckb: String(record.ckb) } : {}) };
      if (isRecord(record.label) && typeof record.label.ar === "string") label = record.label as L10n;
    } else if (typeof raw === "boolean") {
      value = raw ? { ar: "نعم", en: "Yes", ckb: "بەڵێ" } : { ar: "لا", en: "No", ckb: "نەخێر" };
    } else {
      value = { ar: String(raw), en: String(raw), ckb: String(raw) };
    }
    rows.push({ key, label, value });
  }
  return rows;
}

/** Editor rows back into the stored shape: `{ key: { ar, en, ckb, label: { ar, en, ckb } } }`. */
export function specsFromRows(rows: readonly SpecRow[]): Specs | null {
  if (rows.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = { ...row.value, label: row.label };
  return out as Specs;
}

export const SPEC_KEY = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Spec rows from a form: blank rows dropped; key, Arabic label and Arabic value required on the others. */
export const zSpecRows = z
  .array(
    z.object({
      key: z.string().optional(),
      label: z.object({ ar: z.string().optional(), en: z.string().optional(), ckb: z.string().optional() }).optional(),
      value: z.object({ ar: z.string().optional(), en: z.string().optional(), ckb: z.string().optional() }).optional(),
    }),
  )
  .max(80, "too_long")
  .optional()
  .transform((rows, ctx): SpecRow[] => {
    const out: SpecRow[] = [];
    const seen = new Set<string>();
    (rows ?? []).forEach((row, index) => {
      const key = (row.key ?? "").trim().toLowerCase();
      const label = { ar: (row.label?.ar ?? "").trim(), en: (row.label?.en ?? "").trim(), ckb: (row.label?.ckb ?? "").trim() };
      const value = { ar: (row.value?.ar ?? "").trim(), en: (row.value?.en ?? "").trim(), ckb: (row.value?.ckb ?? "").trim() };
      if (!key && !label.ar && !label.en && !value.ar && !value.en && !value.ckb) return;
      if (!SPEC_KEY.test(key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: key ? "spec_key_invalid" : "required" });
      else if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: "spec_key_duplicate" });
      if (!label.ar) ctx.addIssue({ code: "custom", path: [index, "label", "ar"], message: "required" });
      if (!value.ar) ctx.addIssue({ code: "custom", path: [index, "value", "ar"], message: "required" });
      if ([...Object.values(label), ...Object.values(value)].some((text) => text.length > 500)) ctx.addIssue({ code: "custom", path: [index, "value", "ar"], message: "too_long" });
      seen.add(key);
      const clean = (l: { ar: string; en: string; ckb: string }): L10n => ({ ar: l.ar, ...(l.en ? { en: l.en } : {}), ...(l.ckb ? { ckb: l.ckb } : {}) });
      out.push({ key, label: clean(label), value: clean(value) });
    });
    return out;
  });
