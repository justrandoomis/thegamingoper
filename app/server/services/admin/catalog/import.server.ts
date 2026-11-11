/**
 * Admin catalogue — CSV import with an error preview, a dry run and rollback, and CSV export (02.06).
 *
 *   const { jobId } = await previewImport(db, store, actor, { csv, fileName }, now);   // stores the file, validates
 *   const view = await getImportJob(db, store, actor, jobId, now);                       // the dry run: what WOULD change
 *   const result = await applyImport(db, store, actor, jobId, now);                      // writes the valid rows
 *   const undone = await rollbackImport(db, actor, { jobId, reason }, now);              // puts them back
 *   const csv = await exportProductsCsv(db, actor, filters, locale);                      // the same columns
 *   const csv2 = await exportVariantsCsv(db, actor, filters, locale);                     // cost only with cost.read
 *
 * THE FILE: rules.ts `CSV_PRODUCT_COLUMNS`, one row per product, found by `slug`. An empty cell leaves a field as it
 * is; "-" clears an optional field. A new slug creates a DRAFT product (kind, name_ar and category required; `sku`
 * and `barcode` add its default variant, without a price — prices are module 03's). Nothing is published by an
 * import, and nothing about prices, costs or stock is read from the file. At most 200 rows and 1 MB per file.
 *
 * PREVIEW (dry run): the file is stored privately (kind "catalog_import") and an `import_jobs` row records the row
 * errors; the page recomputes the plan from the file and the database as they are, so it always shows what applying
 * would do now. The product versions seen by the preview are kept: a product edited after the preview is not
 * overwritten (that row is skipped as "changed since the preview").
 *
 * APPLY writes the valid rows in chunks of 20; each chunk is one batch with its products' version guards, version
 * rows, audit events, the job's rollback data and applied count (guarded, so a double submit applies nothing twice),
 * and the search rows last. ROLLBACK restores each product's fields as they were before the import (as a new version,
 * nothing deleted) and archives the products the import created — unless a product changed after the import, which
 * is reported and left alone. Permission: catalog.product.import (export: catalog.product.export).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { L10n, Locale } from "~/lib/locales";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { categories, deviceModels, employees, importJobs, platforms, productVersions, products, variantCosts, variants, type ImportJob, type Product } from "~/server/db/schema";
import { expectChanged, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { getFile, putFile, type BlobStore } from "~/server/storage.server";
import {
  baselines,
  catalogError,
  commitStatements,
  customRequirementsOf,
  FACTS_COLUMNS,
  factsOf,
  parseInput,
  recordedBarcodeSet,
  requiredCustomFields,
  rethrowCatalog,
  snapshotOf,
  zId,
  zReason,
  type FactsRow,
  type ProductState,
} from "./common.server";
import { CsvError, parseCsv, toCsv } from "./csv";
import { listProducts, type ProductFilters } from "./product.server";
import { referenceNames } from "./versions.server";
import { invalidateNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
import {
  barcodeCheckDigitOk,
  completenessOf,
  CSV_CLEAR,
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  CSV_PRODUCT_COLUMNS,
  CSV_READ_ONLY_COLUMNS,
  isProductKind,
  LICENSE_TYPE_LIST,
  MEDIA_FORMAT_LIST,
  newlyMissing,
  SKU_PATTERN,
  SLUG_PATTERN,
  type CsvProductColumn,
} from "./rules";

export const IMPORT_KIND = "catalog.products";
const CHUNK = 20;

// ───────────────────────────────────────────────────────────────── the plan (dry run)

export type RowProblem = { field?: string; message: string };
export type RowChange = { field: string; from: unknown; to: unknown };
export type RowPlan = {
  line: number;
  slug: string;
  action: "create" | "update" | "unchanged" | "error";
  productId: string | null;
  /** Version of the product when the plan was made (updates only). */
  version: number | null;
  changes: RowChange[];
  errors: RowProblem[];
};
export type ImportPlan = { rows: RowPlan[]; unknownColumns: string[]; fileErrors: RowProblem[] };

type Lookups = {
  categories: Map<string, { id: string; isActive: boolean }>;
  platforms: Map<string, string>;
  models: Map<string, { id: string; platformId: string }>;
  existing: Map<string, Product>;
  skus: Set<string>;
  /** Every barcode on record (a variant's column or a SKU's extra codes): one code names one variant. */
  barcodes: Set<string>;
  /** Products with a variant that has bundle components (their kind stays "bundle"). */
  withComponents: Set<string>;
  facts: Map<string, FactsRow>;
  fields: Awaited<ReturnType<typeof requiredCustomFields>>;
};

async function lookups(db: Db, slugs: string[]): Promise<Lookups> {
  const json = JSON.stringify(slugs);
  const [categoryRows, platformRows, modelRows, productRows, skuRows, fields, barcodes, bundled] = await Promise.all([
    db.select({ id: categories.id, slug: categories.slug, isActive: categories.isActive }).from(categories),
    db.select({ id: platforms.id, slug: platforms.slug }).from(platforms),
    db.select({ id: deviceModels.id, slug: deviceModels.slug, platformId: deviceModels.platformId }).from(deviceModels),
    slugs.length > 0 ? db.select().from(products).where(sql`${products.slug} IN (SELECT value FROM json_each(${json}))`) : Promise.resolve([]),
    db.select({ sku: variants.sku }).from(variants),
    requiredCustomFields(db),
    recordedBarcodeSet(db),
    db.all<{ product_id: string }>(sql`SELECT DISTINCT v.product_id FROM bundle_items b JOIN variants v ON v.id = b.bundle_variant_id`),
  ]);
  const ids = productRows.map((row) => row.id);
  const facts = ids.length > 0 ? await db.all<FactsRow>(sql`SELECT p.id AS product_id, ${FACTS_COLUMNS} FROM products p WHERE p.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`) : [];
  return {
    categories: new Map(categoryRows.map((row) => [row.slug, { id: row.id, isActive: row.isActive }])),
    platforms: new Map(platformRows.map((row) => [row.slug, row.id])),
    models: new Map(modelRows.map((row) => [row.slug, { id: row.id, platformId: row.platformId }])),
    existing: new Map(productRows.map((row) => [row.slug, row])),
    skus: new Set(skuRows.map((row) => row.sku)),
    barcodes,
    withComponents: new Set(bundled.map((row) => row.product_id)),
    facts: new Map(facts.map((row) => [row.product_id, row])),
    fields,
  };
}

const LIMITS: Partial<Record<CsvProductColumn, number>> = {
  brand: 80,
  name_ar: 200,
  name_en: 200,
  name_ckb: 200,
  short_ar: 300,
  short_en: 300,
  short_ckb: 300,
  description_ar: 8000,
  description_en: 8000,
  description_ckb: 8000,
  age_rating: 40,
  region: 40,
  keywords_ar: 600,
  keywords_en: 600,
  keywords_ckb: 600,
};

const L10N_GROUPS = { name: ["name_ar", "name_en", "name_ckb"], short: ["short_ar", "short_en", "short_ckb"], description: ["description_ar", "description_en", "description_ckb"], searchKeywords: ["keywords_ar", "keywords_en", "keywords_ckb"] } as const;

/** The product a valid row describes (an existing one with the row's changes, or a new draft), or the row's errors. */
function rowProduct(cells: Record<string, string>, lookups: Lookups, now: number, by: string | null): { product: Product | null; errors: RowProblem[]; sku: string | null; barcode: string | null } {
  const errors: RowProblem[] = [];
  const cell = (name: CsvProductColumn) => (cells[name] ?? "").trim();
  const slug = cell("slug").toLowerCase();
  const existing = lookups.existing.get(slug) ?? null;
  const next: Product = existing
    ? { ...existing }
    : {
        id: newId("prd"),
        slug,
        kind: "accessory",
        name: { ar: "" },
        short: null,
        description: null,
        brand: null,
        platformId: null,
        deviceModelId: null,
        categoryId: null,
        specs: null,
        attributes: null,
        warrantyMonths: null,
        ageRating: null,
        region: null,
        licenseType: null,
        mediaFormat: null,
        status: "draft",
        publishAt: null,
        isDemo: false,
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

  for (const [name, max] of Object.entries(LIMITS) as [CsvProductColumn, number][]) if (cell(name).length > max) errors.push({ field: name, message: "too_long" });

  const kind = cell("kind");
  if (kind) {
    if (!isProductKind(kind)) errors.push({ field: "kind", message: "kind_invalid" });
    else if (existing?.kind === "bundle" && kind !== "bundle" && lookups.withComponents.has(existing.id)) errors.push({ field: "kind", message: "kind_has_components" });
    else next.kind = kind;
  } else if (!existing) errors.push({ field: "kind", message: "required" });

  const category = cell("category");
  if (category === CSV_CLEAR) errors.push({ field: "category", message: "required" });
  else if (category) {
    const found = lookups.categories.get(category.toLowerCase());
    if (!found) errors.push({ field: "category", message: "category_unknown" });
    else next.categoryId = found.id;
  } else if (!existing) errors.push({ field: "category", message: "required" });

  const platform = cell("platform");
  if (platform === CSV_CLEAR) next.platformId = null;
  else if (platform) {
    const id = lookups.platforms.get(platform.toLowerCase());
    if (!id) errors.push({ field: "platform", message: "platform_unknown" });
    else next.platformId = id;
  }
  const model = cell("device_model");
  if (model === CSV_CLEAR) next.deviceModelId = null;
  else if (model) {
    const found = lookups.models.get(model.toLowerCase());
    if (!found) errors.push({ field: "device_model", message: "device_unknown" });
    else next.deviceModelId = found.id;
  }
  if (next.deviceModelId && next.platformId) {
    const found = [...lookups.models.values()].find((entry) => entry.id === next.deviceModelId);
    if (found && found.platformId !== next.platformId) errors.push({ field: "device_model", message: "device_platform_mismatch" });
  }

  const brand = cell("brand");
  if (brand === CSV_CLEAR) next.brand = null;
  else if (brand) next.brand = brand;

  for (const [field, columns] of Object.entries(L10N_GROUPS) as [keyof typeof L10N_GROUPS, readonly CsvProductColumn[]][]) {
    const current: L10n | null = field === "name" ? next.name : (next[field] as L10n | null);
    const value: Record<string, string> = { ...(current ?? {}) } as Record<string, string>;
    let touched = false;
    columns.forEach((column, index) => {
      const locale = (["ar", "en", "ckb"] as const)[index];
      const text = cell(column);
      if (!text) return;
      touched = true;
      if (text === CSV_CLEAR) {
        if (locale === "ar" && field === "name") errors.push({ field: column, message: "required" });
        delete value[locale];
      } else value[locale] = text;
    });
    if (!touched) continue;
    if (field === "name") {
      if (!value.ar) errors.push({ field: "name_ar", message: "required" });
      else next.name = value as L10n;
    } else {
      // An optional text without Arabic is dropped as a whole (Arabic is the source language).
      if (!value.ar && (value.en || value.ckb)) errors.push({ field: `${columns[0]}`, message: "arabic_required" });
      (next as Record<string, unknown>)[field] = value.ar ? (value as L10n) : null;
    }
  }
  if (!existing && !next.name.ar) errors.push({ field: "name_ar", message: "required" });

  const warranty = cell("warranty_months");
  if (warranty === CSV_CLEAR) next.warrantyMonths = null;
  else if (warranty) {
    const months = Number(warranty);
    if (!Number.isInteger(months) || months < 0 || months > 120) errors.push({ field: "warranty_months", message: "warranty_invalid" });
    else next.warrantyMonths = months;
  }
  for (const [column, key] of [
    ["age_rating", "ageRating"],
    ["region", "region"],
  ] as const) {
    const text = cell(column);
    if (text === CSV_CLEAR) next[key] = null;
    else if (text) next[key] = text;
  }
  const license = cell("license_type");
  if (license === CSV_CLEAR) next.licenseType = null;
  else if (license) {
    if (!(LICENSE_TYPE_LIST as readonly string[]).includes(license)) errors.push({ field: "license_type", message: "license_invalid" });
    else next.licenseType = license as Product["licenseType"];
  }
  const format = cell("media_format");
  if (format === CSV_CLEAR) next.mediaFormat = null;
  else if (format) {
    if (!(MEDIA_FORMAT_LIST as readonly string[]).includes(format)) errors.push({ field: "media_format", message: "format_invalid" });
    else next.mediaFormat = format as Product["mediaFormat"];
  }

  let sku: string | null = null;
  let barcode: string | null = null;
  if (!existing) {
    const rawSku = cell("sku").toUpperCase();
    if (rawSku) {
      if (!SKU_PATTERN.test(rawSku)) errors.push({ field: "sku", message: "sku_invalid" });
      else if (lookups.skus.has(rawSku)) errors.push({ field: "sku", message: "sku_taken" });
      else sku = rawSku;
    }
    const rawBarcode = cell("barcode").replace(/\s+/g, "");
    if (rawBarcode) {
      if (!sku) errors.push({ field: "barcode", message: "barcode_needs_sku" });
      else if (!barcodeCheckDigitOk(rawBarcode)) errors.push({ field: "barcode", message: "barcode_invalid" });
      else if (lookups.barcodes.has(rawBarcode)) errors.push({ field: "barcode", message: "barcode_taken" });
      else barcode = rawBarcode;
    }
  }
  return { product: errors.length === 0 ? next : null, errors, sku, barcode };
}

const PLAN_FIELDS = [
  "kind",
  "categoryId",
  "platformId",
  "deviceModelId",
  "brand",
  "name",
  "short",
  "description",
  "warrantyMonths",
  "ageRating",
  "region",
  "licenseType",
  "mediaFormat",
  "searchKeywords",
] as const satisfies readonly (keyof Product)[];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What applying the file would do now, row by row. */
export async function planImport(db: Db, text: string, actor: Actor, now: number): Promise<{ plan: ImportPlan; products: Map<number, { product: Product; sku: string | null; barcode: string | null }> }> {
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) return { plan: { rows: [], unknownColumns: [], fileErrors: [{ message: error.code, field: `line ${error.line}` }] }, products: new Map() };
    throw error;
  }
  const fileErrors: RowProblem[] = [];
  if (!parsed.header.includes("slug")) fileErrors.push({ field: "slug", message: "csv_slug_column" });
  if (parsed.rows.length === 0) fileErrors.push({ message: "import_empty" });
  if (parsed.rows.length > CSV_MAX_ROWS) fileErrors.push({ message: "csv_too_many_rows" });
  const known = new Set<string>([...CSV_PRODUCT_COLUMNS, ...CSV_READ_ONLY_COLUMNS]);
  const unknownColumns = parsed.header.filter((name) => !known.has(name));
  if (fileErrors.length > 0) return { plan: { rows: [], unknownColumns, fileErrors }, products: new Map() };

  const slugs = parsed.rows.map((row) => (row.cells.slug ?? "").trim().toLowerCase()).filter(Boolean);
  const found = await lookups(db, slugs);
  const by = actorRef(actor).actorId;
  const seen = new Set<string>();
  const newSkus = new Set<string>();
  const newBarcodes = new Set<string>();
  const rows: RowPlan[] = [];
  const planned = new Map<number, { product: Product; sku: string | null; barcode: string | null }>();
  for (const row of parsed.rows) {
    const slug = (row.cells.slug ?? "").trim().toLowerCase();
    const plan: RowPlan = { line: row.line, slug, action: "error", productId: null, version: null, changes: [], errors: [] };
    rows.push(plan);
    if (!slug) {
      plan.errors.push({ field: "slug", message: "required" });
      continue;
    }
    if (!SLUG_PATTERN.test(slug) || slug.length > 80) {
      plan.errors.push({ field: "slug", message: "slug_invalid" });
      continue;
    }
    if (seen.has(slug)) {
      plan.errors.push({ field: "slug", message: "slug_repeated" });
      continue;
    }
    seen.add(slug);
    const existing = found.existing.get(slug) ?? null;
    if (existing?.status === "archived") {
      plan.errors.push({ message: "status_not_allowed" });
      continue;
    }
    const result = rowProduct(row.cells, found, now, by);
    plan.errors.push(...result.errors);
    if (result.sku) {
      if (newSkus.has(result.sku)) plan.errors.push({ field: "sku", message: "sku_repeated" });
      newSkus.add(result.sku);
    }
    if (result.barcode) {
      // Two new products of one file with the same code: the second would share it.
      if (newBarcodes.has(result.barcode)) plan.errors.push({ field: "barcode", message: "barcode_taken" });
      newBarcodes.add(result.barcode);
    }
    if (plan.errors.length > 0 || !result.product) continue;
    const next = result.product;
    if (!existing) {
      plan.action = "create";
      plan.productId = next.id;
      plan.changes = PLAN_FIELDS.filter((field) => next[field] !== null && next[field] !== undefined).map((field) => ({ field, from: null, to: next[field] }));
      if (result.sku) plan.changes.push({ field: "sku", from: null, to: result.sku });
      planned.set(row.line, { product: next, sku: result.sku, barcode: result.barcode });
      continue;
    }
    plan.productId = existing.id;
    plan.version = existing.version;
    plan.changes = PLAN_FIELDS.filter((field) => !same(existing[field], next[field])).map((field) => ({ field, from: existing[field], to: next[field] }));
    if (plan.changes.length === 0) {
      plan.action = "unchanged";
      continue;
    }
    // A live product may not lose a requirement it meets (02.03).
    const facts = found.facts.get(existing.id);
    if (facts && (existing.status === "published" || existing.status === "scheduled")) {
      const categoryOk = (id: string | null) => (id ? [...found.categories.values()].some((entry) => entry.id === id && entry.isActive) : false);
      const before = completenessOf(factsOf(existing, facts), customRequirementsOf(existing.kind, existing.attributes, found.fields));
      const after = completenessOf({ ...factsOf(next, facts), categoryOk: categoryOk(next.categoryId) }, customRequirementsOf(next.kind, next.attributes, found.fields));
      const lost = newlyMissing(before, after);
      if (lost.length > 0) {
        plan.errors.push({ message: "regression", field: lost.join(",") });
        continue;
      }
    }
    plan.action = "update";
    planned.set(row.line, { product: next, sku: null, barcode: null });
  }
  return { plan: { rows, unknownColumns, fileErrors }, products: planned };
}

// ───────────────────────────────────────────────────────────────── jobs

type JobRollback = {
  /** Product versions the preview saw, by slug. */
  preview?: Record<string, number>;
  applied?: { productId: string; slug: string; created: boolean; versionAfter: number; before: Partial<Product> | null }[];
  rolledBack?: { productId: string; slug: string; outcome: "restored" | "archived" | "conflict" }[];
};

export const PreviewInput = z.object({ fileName: z.string().trim().max(120).optional() });

async function readCsvSource(source: unknown): Promise<string> {
  if (typeof source === "string") {
    if (new TextEncoder().encode(source).length > CSV_MAX_BYTES) throw new AppError("upload_too_large", 413, { fields: { file: "upload_too_large" } });
    return source;
  }
  if (source && typeof source === "object" && "arrayBuffer" in source && typeof (source as Blob).arrayBuffer === "function") {
    const blob = source as Blob;
    if (blob.size === 0) throw invalid({ file: "upload_missing" });
    if (blob.size > CSV_MAX_BYTES) throw new AppError("upload_too_large", 413, { fields: { file: "upload_too_large" } });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Text only: a NUL byte means a binary file (a spreadsheet saved as .xlsx, an image…).
    if (bytes.includes(0)) throw invalid({ file: "csv_not_text" });
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  throw invalid({ file: "upload_missing" });
}

/** Stores the file privately, validates it and records the job. The rows are not written. */
export async function previewImport(db: Db, store: BlobStore, actor: Actor, source: unknown, raw: unknown, now: number): Promise<{ jobId: string }> {
  assertCan(actor, "catalog.product.import");
  const input = parseInput(PreviewInput, raw);
  const text = await readCsvSource(source);
  const { plan } = await planImport(db, text, actor, now);
  const file = await putFile(db, store, { bytes: new TextEncoder().encode(text), mime: "text/csv", visibility: "private", kind: "catalog_import", createdBy: actor, originalName: input.fileName ?? "products.csv", now });
  const errors = [
    ...plan.fileErrors.map((problem) => ({ row: 0, field: problem.field, message: problem.message })),
    ...plan.rows.flatMap((row) => row.errors.map((problem) => ({ row: row.line, field: problem.field, message: problem.message }))),
  ];
  const valid = plan.rows.filter((row) => row.action === "create" || row.action === "update").length;
  const jobId = newId("imp");
  const rollback: JobRollback = { preview: Object.fromEntries(plan.rows.filter((row) => row.version !== null).map((row) => [row.slug, row.version!])) };
  await runBatch(db, [
    db.insert(importJobs).values({ id: jobId, kind: IMPORT_KIND, fileId: file.id, status: plan.fileErrors.length > 0 || valid === 0 ? "failed" : "validated", totalRows: plan.rows.length, validRows: valid, appliedRows: 0, errors, rollback, createdBy: actorRef(actor).actorId, createdAt: now }),
    auditStatement(db, { actor, action: "catalog.import.preview", entityType: "import_job", entityId: jobId, summary: `${plan.rows.length} rows, ${valid} valid, ${errors.length} problems`, after: { fileId: file.id, rows: plan.rows.length, valid }, at: now }),
  ]);
  return { jobId };
}

export type ImportJobView = {
  id: string;
  status: ImportJob["status"];
  fileName: string | null;
  createdAt: number;
  createdBy: string | null;
  totalRows: number;
  validRows: number;
  appliedRows: number;
  appliedAt: number | null;
  rolledBackAt: number | null;
  /** Recomputed from the file and the database now (only while it can still be applied). */
  plan: ImportPlan | null;
  rollback: JobRollback | null;
  errors: { row: number; field?: string; message: string }[];
  /** Rows whose product changed after the preview (they would be skipped). */
  changedSincePreview: string[];
  /** Names of the categories, platforms and devices the plan refers to by id. */
  names: Record<string, string>;
};

async function loadJob(db: Db, jobId: string): Promise<ImportJob> {
  const job = await db.select().from(importJobs).where(and(eq(importJobs.id, jobId), eq(importJobs.kind, IMPORT_KIND))).get();
  if (!job) throw notFound("import_job");
  return job;
}

async function jobText(db: Db, store: BlobStore, job: ImportJob): Promise<string> {
  if (!job.fileId) throw catalogError("import_state", 409);
  const file = await getFile(db, store, job.fileId);
  if (!file) throw catalogError("import_state", 409, { detail: "file_missing" });
  return new TextDecoder().decode(file.bytes);
}

export async function getImportJob(db: Db, store: BlobStore, actor: Actor, jobId: string, now: number, locale: Locale = "ar"): Promise<ImportJobView> {
  assertCan(actor, "catalog.product.import");
  const job = await loadJob(db, jobId);
  const [creator, file] = await Promise.all([
    job.createdBy ? db.select({ name: employees.name }).from(employees).where(eq(employees.id, job.createdBy)).get() : Promise.resolve(undefined),
    job.fileId ? db.get<{ original_name: string | null }>(sql`SELECT original_name FROM files WHERE id = ${job.fileId}`) : Promise.resolve(undefined),
  ]);
  const rollback = (job.rollback ?? null) as JobRollback | null;
  let plan: ImportPlan | null = null;
  const changedSincePreview: string[] = [];
  if (job.status === "validated") {
    plan = (await planImport(db, await jobText(db, store, job), actor, now)).plan;
    for (const row of plan.rows) if (row.version !== null && rollback?.preview?.[row.slug] !== undefined && rollback.preview[row.slug] !== row.version) changedSincePreview.push(row.slug);
  }
  return {
    id: job.id,
    status: job.status,
    fileName: file?.original_name ?? null,
    createdAt: job.createdAt,
    createdBy: creator?.name ?? null,
    totalRows: job.totalRows ?? 0,
    validRows: job.validRows ?? 0,
    appliedRows: job.appliedRows ?? 0,
    appliedAt: job.appliedAt,
    rolledBackAt: job.rolledBackAt,
    plan,
    rollback,
    errors: job.errors ?? [],
    changedSincePreview,
    names: plan ? await referenceNames(db, plan.rows.flatMap((row) => row.changes.filter((change) => change.field.endsWith("Id")).flatMap((change) => [change.from, change.to])).filter((value): value is string => typeof value === "string"), locale) : {},
  };
}

export async function listImportJobs(db: Db, actor: Actor, limit = 20): Promise<{ id: string; status: ImportJob["status"]; createdAt: number; createdBy: string | null; totalRows: number; validRows: number; appliedRows: number }[]> {
  assertCan(actor, "catalog.product.import");
  const rows = await db
    .select({ id: importJobs.id, status: importJobs.status, createdAt: importJobs.createdAt, totalRows: importJobs.totalRows, validRows: importJobs.validRows, appliedRows: importJobs.appliedRows, name: employees.name })
    .from(importJobs)
    .leftJoin(employees, eq(employees.id, importJobs.createdBy))
    .where(eq(importJobs.kind, IMPORT_KIND))
    .orderBy(desc(importJobs.createdAt))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, status: row.status, createdAt: row.createdAt, createdBy: row.name, totalRows: row.totalRows ?? 0, validRows: row.validRows ?? 0, appliedRows: row.appliedRows ?? 0 }));
}

const changedValues = (before: Product, after: Product): Partial<Product> => {
  const out: Partial<Product> = {};
  for (const field of PLAN_FIELDS) if (!same(before[field], after[field])) (out as Record<string, unknown>)[field] = before[field];
  return out;
};

/** Applies the valid rows of a previewed job. Rows whose product changed after the preview are skipped. */
export async function applyImport(db: Db, store: BlobStore, actor: Actor, jobId: string, now: number, options: { demo?: boolean } = {}): Promise<{ applied: number; skipped: { slug: string; reason: string }[] }> {
  assertCan(actor, "catalog.product.import");
  const job = await loadJob(db, jobId);
  if (job.status !== "validated") throw catalogError("import_state", 409, { detail: job.status });
  const rollback = (job.rollback ?? {}) as JobRollback;
  const { plan, products: planned } = await planImport(db, await jobText(db, store, job), actor, now);
  const skipped: { slug: string; reason: string }[] = [];
  const work = plan.rows.filter((row) => {
    if (row.action !== "create" && row.action !== "update") {
      if (row.action === "error") skipped.push({ slug: row.slug, reason: row.errors[0]?.message ?? "invalid" });
      return false;
    }
    const seen = rollback.preview?.[row.slug];
    if (row.action === "update" && seen !== undefined && seen !== row.version) {
      skipped.push({ slug: row.slug, reason: "import_changed" });
      return false;
    }
    if (row.action === "create" && seen !== undefined) {
      // The preview saw it as an existing product that is gone now: do not recreate it silently.
      skipped.push({ slug: row.slug, reason: "import_changed" });
      return false;
    }
    return true;
  });
  if (work.length === 0) throw catalogError("import_empty", 409);

  const applied = [...(rollback.applied ?? [])];
  let appliedRows = job.appliedRows ?? 0;
  const by = actorRef(actor).actorId;
  for (let start = 0; start < work.length; start += CHUNK) {
    const chunk = work.slice(start, start + CHUNK);
    const statements: BatchStatement[] = [];
    const search: BatchStatement[] = [];
    const updates = chunk.filter((row) => row.action === "update");
    const states = new Map<string, ProductState>();
    for (const row of updates) {
      const productRows = await db.select().from(variants).where(eq(variants.productId, row.productId!));
      const product = await db.select().from(products).where(eq(products.id, row.productId!)).get();
      if (product) states.set(product.id, { product, variants: productRows });
    }
    const haveBaseline = await baselines(db, [...states.values()].map((state) => state.product));
    const chunkApplied: NonNullable<JobRollback["applied"]> = [];
    for (const row of chunk) {
      const target = planned.get(row.line);
      if (!target) continue;
      if (row.action === "create") {
        const product = { ...target.product, id: row.productId!, createdAt: now, updatedAt: now, isDemo: options.demo === true };
        const variant = target.sku
          ? { id: newId("var"), productId: product.id, sku: target.sku, barcode: target.barcode, title: null, options: null, priceIqd: 0, compareAtIqd: null, isDefault: true, isActive: true, trackSerials: product.kind === "console", sort: 0, weightGrams: null, createdAt: now, updatedAt: now }
          : null;
        const state: ProductState = { product, variants: variant ? [variant] : [] };
        statements.push(
          db.insert(products).values(product),
          ...(variant ? [db.insert(variants).values(variant)] : []),
          db.insert(productVersions).values({ id: newId("pver"), productId: product.id, version: 1, snapshot: snapshotOf(state), changedBy: by, reason: `import ${jobId}`, createdAt: now }),
          auditStatement(db, { actor, action: "catalog.product.create", entityType: "product", entityId: product.id, summary: `${product.slug} (import)`, after: { slug: product.slug, kind: product.kind, name: product.name, jobId }, at: now }),
        );
        chunkApplied.push({ productId: product.id, slug: product.slug, created: true, versionAfter: 1, before: null });
        continue;
      }
      const state = states.get(row.productId!);
      if (!state || state.product.version !== row.version) {
        skipped.push({ slug: row.slug, reason: "import_changed" });
        continue;
      }
      const commit = commitStatements(db, { actor, now, before: state, after: { product: target.product, variants: state.variants }, action: "catalog.product.import", reason: `import ${jobId}`, hasBaseline: haveBaseline.has(state.product.id) });
      statements.push(...commit.statements);
      search.push(...commit.search);
      chunkApplied.push({ productId: state.product.id, slug: state.product.slug, created: false, versionAfter: commit.version, before: changedValues(state.product, target.product) });
    }
    if (chunkApplied.length === 0) continue;
    const nextApplied = [...applied, ...chunkApplied];
    const last = start + CHUNK >= work.length;
    statements.push(
      db
        .update(importJobs)
        .set({ appliedRows: appliedRows + chunkApplied.length, rollback: { ...rollback, applied: nextApplied }, ...(last ? { status: "applied" as const, appliedAt: now } : {}) })
        .where(and(eq(importJobs.id, jobId), eq(importJobs.status, "validated"), eq(importJobs.appliedRows, appliedRows))),
      expectChanged(db, 1, { code: "IMPORT_STATE", detail: jobId }),
    );
    try {
      await runBatch(db, [...statements, ...search]).catch(rethrowCatalog);
    } catch (error) {
      // Stop here: what was applied stays applied (and can be rolled back); the job says it did not finish.
      if (appliedRows > 0) await db.update(importJobs).set({ status: "failed" }).where(and(eq(importJobs.id, jobId), eq(importJobs.status, "validated")));
      throw error;
    }
    applied.push(...chunkApplied);
    appliedRows += chunkApplied.length;
  }
  // Every chunk was skipped: close the job so it is not applied again.
  if (appliedRows === (job.appliedRows ?? 0)) await db.update(importJobs).set({ status: "failed" }).where(and(eq(importJobs.id, jobId), eq(importJobs.status, "validated")));
  invalidateNavTaxonomy(db);
  return { applied: appliedRows - (job.appliedRows ?? 0), skipped };
}

export const RollbackInput = z.object({ jobId: zId, reason: zReason(true) });

/** Undoes an applied (or partly applied) import, product by product. */
export async function rollbackImport(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ restored: number; archived: number; conflicts: string[] }> {
  assertCan(actor, "catalog.product.import");
  const input = parseInput(RollbackInput, raw);
  const job = await loadJob(db, input.jobId);
  if ((job.status !== "applied" && job.status !== "failed") || job.rolledBackAt !== null) throw catalogError("import_state", 409, { detail: job.status });
  const rollback = (job.rollback ?? {}) as JobRollback;
  const entries = [...(rollback.applied ?? [])].reverse();
  if (entries.length === 0) throw catalogError("import_state", 409, { detail: "nothing_applied" });

  const results: NonNullable<JobRollback["rolledBack"]> = [];
  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK);
    const statements: BatchStatement[] = [];
    const search: BatchStatement[] = [];
    const ids = chunk.map((entry) => entry.productId);
    const productRows = await db.select().from(products).where(inArray(products.id, ids));
    const variantRows = await db.select().from(variants).where(inArray(variants.productId, ids));
    const haveBaseline = await baselines(db, productRows);
    for (const entry of chunk) {
      const product = productRows.find((row) => row.id === entry.productId);
      if (!product || product.version !== entry.versionAfter) {
        results.push({ productId: entry.productId, slug: entry.slug, outcome: "conflict" });
        continue;
      }
      const state: ProductState = { product, variants: variantRows.filter((row) => row.productId === product.id) };
      const next: Product = entry.created ? { ...product, status: "archived", publishAt: null } : { ...product, ...(entry.before ?? {}) };
      const commit = commitStatements(db, {
        actor,
        now,
        before: state,
        after: { product: next, variants: state.variants },
        action: entry.created ? "catalog.product.archive" : "catalog.import.rollback",
        reason: `${input.reason} (import ${input.jobId})`,
        hasBaseline: haveBaseline.has(product.id),
      });
      statements.push(...commit.statements);
      search.push(...commit.search);
      results.push({ productId: product.id, slug: product.slug, outcome: entry.created ? "archived" : "restored" });
    }
    if (statements.length > 0) await runBatch(db, [...statements, ...search]).catch(rethrowCatalog);
  }
  await runBatch(db, [
    db
      .update(importJobs)
      .set({ status: "rolled_back", rolledBackAt: now, rollback: { ...rollback, rolledBack: results } })
      .where(and(eq(importJobs.id, input.jobId), sql`${importJobs.rolledBackAt} IS NULL`)),
    expectChanged(db, 1, { code: "IMPORT_STATE", detail: input.jobId }),
    auditStatement(db, {
      actor,
      action: "catalog.import.rollback",
      entityType: "import_job",
      entityId: input.jobId,
      summary: `${results.filter((row) => row.outcome !== "conflict").length} undone, ${results.filter((row) => row.outcome === "conflict").length} changed since`,
      after: { results },
      reason: input.reason,
      at: now,
    }),
  ]).catch(rethrowCatalog);
  invalidateNavTaxonomy(db);
  return {
    restored: results.filter((row) => row.outcome === "restored").length,
    archived: results.filter((row) => row.outcome === "archived").length,
    conflicts: results.filter((row) => row.outcome === "conflict").map((row) => row.slug),
  };
}

// ───────────────────────────────────────────────────────────────── export

const EXPORT_LIMIT = 5000;

async function matchingIds(db: Db, actor: Actor, filters: ProductFilters, locale: Locale, now: number): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; page <= EXPORT_LIMIT / 50; page++) {
    const result = await listProducts(db, actor, { ...filters, page }, locale, now);
    ids.push(...result.rows.map((row) => row.id));
    if (page >= result.pageCount) break;
  }
  return ids;
}

const l10nCell = (value: L10n | null | undefined, locale: "ar" | "en" | "ckb") => (value ? (value[locale] ?? "") : "");

/** The product sheet for the products the filters select: the import's columns, plus status and prices (read-only). */
export async function exportProductsCsv(db: Db, actor: Actor, filters: ProductFilters, locale: Locale, now: number): Promise<string> {
  assertCan(actor, "catalog.product.export");
  const ids = await matchingIds(db, actor, filters, locale, now);
  const json = JSON.stringify(ids);
  const [rows, variantRows, categoryRows, platformRows, modelRows] = await Promise.all([
    ids.length > 0 ? db.select().from(products).where(sql`${products.id} IN (SELECT value FROM json_each(${json}))`) : Promise.resolve([]),
    ids.length > 0 ? db.select().from(variants).where(sql`${variants.productId} IN (SELECT value FROM json_each(${json}))`) : Promise.resolve([]),
    db.select({ id: categories.id, slug: categories.slug }).from(categories),
    db.select({ id: platforms.id, slug: platforms.slug }).from(platforms),
    db.select({ id: deviceModels.id, slug: deviceModels.slug }).from(deviceModels),
  ]);
  const order = new Map(ids.map((id, index) => [id, index]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const slugOf = (list: { id: string; slug: string }[], id: string | null) => (id ? (list.find((row) => row.id === id)?.slug ?? "") : "");
  const header = [...CSV_PRODUCT_COLUMNS, ...CSV_READ_ONLY_COLUMNS];
  const records = rows.map((row) => {
    const own = variantRows.filter((variant) => variant.productId === row.id).sort((a, b) => a.sort - b.sort);
    const priced = own.filter((variant) => variant.isActive && variant.priceIqd > 0).map((variant) => variant.priceIqd);
    const first = own.find((variant) => variant.isDefault) ?? own[0];
    return {
      slug: row.slug,
      kind: row.kind,
      category: slugOf(categoryRows, row.categoryId),
      platform: slugOf(platformRows, row.platformId),
      device_model: slugOf(modelRows, row.deviceModelId),
      brand: row.brand ?? "",
      name_ar: l10nCell(row.name, "ar"),
      name_en: l10nCell(row.name, "en"),
      name_ckb: l10nCell(row.name, "ckb"),
      short_ar: l10nCell(row.short, "ar"),
      short_en: l10nCell(row.short, "en"),
      short_ckb: l10nCell(row.short, "ckb"),
      description_ar: l10nCell(row.description, "ar"),
      description_en: l10nCell(row.description, "en"),
      description_ckb: l10nCell(row.description, "ckb"),
      warranty_months: row.warrantyMonths ?? "",
      age_rating: row.ageRating ?? "",
      region: row.region ?? "",
      license_type: row.licenseType ?? "",
      media_format: row.mediaFormat ?? "",
      keywords_ar: l10nCell(row.searchKeywords, "ar"),
      keywords_en: l10nCell(row.searchKeywords, "en"),
      keywords_ckb: l10nCell(row.searchKeywords, "ckb"),
      sku: first?.sku ?? "",
      barcode: first?.barcode ?? "",
      status: row.status === "draft" && row.publishedAt !== null ? "hidden" : row.status,
      // A product without a priced variant has no price: an empty cell, never a zero.
      price_min_iqd: priced.length > 0 ? Math.min(...priced) : "",
      price_max_iqd: priced.length > 0 ? Math.max(...priced) : "",
    };
  });
  await auditExport(db, actor, "products", rows.length, false, now);
  return toCsv(header, records);
}

/**
 * One row per variant. Landed cost is a column only for employees holding cost.read, the margin only with
 * profit.read: for everyone else the columns do not exist in the file (not empty, not masked).
 */
export async function exportVariantsCsv(db: Db, actor: Actor, filters: ProductFilters, locale: Locale, now: number): Promise<string> {
  assertCan(actor, "catalog.product.export");
  const withCost = can(actor, "cost.read");
  const withMargin = can(actor, "profit.read");
  const ids = await matchingIds(db, actor, filters, locale, now);
  const json = JSON.stringify(ids);
  const rows =
    ids.length > 0
      ? await db
          .select({ productId: products.id, slug: products.slug, variant: variants })
          .from(variants)
          .innerJoin(products, eq(products.id, variants.productId))
          .where(sql`${variants.productId} IN (SELECT value FROM json_each(${json}))`)
      : [];
  const variantIds = rows.map((row) => row.variant.id);
  // [P] cost data: selected only for the holders of the permission.
  const costs = (withCost || withMargin) && variantIds.length > 0 ? await db.select({ variantId: variantCosts.variantId, landed: variantCosts.landedCostIqd }).from(variantCosts).where(inArray(variantCosts.variantId, variantIds)) : [];
  const costOf = new Map(costs.map((row) => [row.variantId, row.landed]));
  const order = new Map(ids.map((id, index) => [id, index]));
  rows.sort((a, b) => (order.get(a.productId) ?? 0) - (order.get(b.productId) ?? 0) || a.variant.sort - b.variant.sort);
  const header = ["product_slug", "sku", "barcode", "title_ar", "title_en", "title_ckb", "platform", "color", "storage", "edition", "region", "condition", "model", "active", "price_iqd", ...(withCost ? ["landed_cost_iqd"] : []), ...(withMargin ? ["margin_percent"] : [])];
  const records = rows.map(({ slug, variant }) => {
    const options = variant.options ?? {};
    const landed = costOf.get(variant.id);
    const record: Record<string, unknown> = {
      product_slug: slug,
      sku: variant.sku,
      barcode: variant.barcode ?? "",
      title_ar: l10nCell(variant.title, "ar"),
      title_en: l10nCell(variant.title, "en"),
      title_ckb: l10nCell(variant.title, "ckb"),
      platform: options.platform ?? "",
      color: options.color ?? "",
      storage: options.storage ?? "",
      edition: options.edition ?? "",
      region: options.region ?? "",
      condition: options.condition ?? "",
      model: options.model ?? "",
      active: variant.isActive ? "yes" : "no",
      price_iqd: variant.priceIqd > 0 ? variant.priceIqd : "",
    };
    if (withCost) record.landed_cost_iqd = landed ?? "";
    if (withMargin) record.margin_percent = landed !== undefined && variant.priceIqd > 0 ? (((variant.priceIqd - landed) / variant.priceIqd) * 100).toFixed(1) : "";
    return record;
  });
  await auditExport(db, actor, "variants", rows.length, withCost || withMargin, now);
  return toCsv(header, records);
}

async function auditExport(db: Db, actor: Actor, what: string, rows: number, protectedData: boolean, now: number): Promise<void> {
  await runBatch(db, [auditStatement(db, { actor, action: "catalog.export", entityType: "catalog", entityId: what, summary: `${what}: ${rows} rows${protectedData ? ", with cost" : ""}`, after: { rows, protectedData }, at: now })]);
}

