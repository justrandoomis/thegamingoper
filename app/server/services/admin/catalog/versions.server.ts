/**
 * Admin catalogue — version history of a product with safe restore (02.09).
 *
 *   const history = await getHistory(db, actor, productId, locale);          // versions (newest first) + price history
 *   const diff = await compareVersion(db, actor, productId, version, locale); // that version against the product now
 *   await restoreVersion(db, actor, { productId, version, expectedVersion, reason }, now);
 *
 * Every save of a product writes a full snapshot to product_versions (append-only; never cost data). A product that
 * existed before the admin (the demo seed) gets a "baseline" row the first time it changes.
 *
 * SAFE RESTORE writes the descriptive content of an old version as a NEW version — texts, facts, category, platform,
 * device, specs, attributes, search keywords, and variant titles, options and barcodes of variants that still exist.
 * It never restores what moves money or stock or what other modules own: no price or compare-at price (module 03),
 * no cost, no stock, no status, no active/inactive switch, no serial tracking, no SKU or slug, and no variant that
 * was removed since. A reference that no longer exists (a deleted category) is kept as it is now. Barcodes come back
 * only when none of them is held by another variant now (one code names one variant — receiving and packing find the
 * variant by it); otherwise they stay as they are and the rest is restored. A live product cannot be restored into an
 * incomplete state (rules.ts: a change never makes a live product less complete).
 * Needs catalog.version.restore.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { categories, deviceModels, employees, platforms, priceChanges, productVersions, type Product, type Variant } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import {
  assertNoRegression,
  barcodeHolders,
  baselines,
  catalogError,
  changedFields,
  commitStatements,
  customRequirementsOf,
  parseInput,
  productCompleteness,
  readSnapshot,
  recordedBarcodes,
  requireProductState,
  requiredCustomFields,
  rethrowCatalog,
  zId,
  zReason,
  zVersion,
  type ProductSnapshot,
  type ProductState,
} from "./common.server";
import { completenessOf } from "./rules";

/** Product fields a restore brings back. */
export const RESTORABLE_PRODUCT_FIELDS = [
  "name",
  "short",
  "description",
  "brand",
  "categoryId",
  "platformId",
  "deviceModelId",
  "specs",
  "attributes",
  "warrantyMonths",
  "ageRating",
  "region",
  "licenseType",
  "mediaFormat",
  "seo",
  "searchKeywords",
] as const satisfies readonly (keyof Product)[];
/** Variant fields a restore brings back (variants that still exist, matched by id). */
export const RESTORABLE_VARIANT_FIELDS = ["title", "options", "barcode"] as const satisfies readonly (keyof Variant)[];

export type VersionEntry = {
  version: number;
  createdAt: number;
  by: string | null;
  reason: string | null;
  changes: string[];
  /** The status the product had after this version. */
  status: string | null;
};

export type PriceHistoryEntry = { at: number; sku: string; oldPriceIqd: number | null; newPriceIqd: number; source: string; reason: string | null };

export type History = {
  productId: string;
  current: number;
  versions: VersionEntry[];
  prices: PriceHistoryEntry[];
  canRestore: boolean;
};

const MAX_VERSIONS = 100;

export async function getHistory(db: Db, actor: Actor, productId: string): Promise<History> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const rows = await db
    .select({ version: productVersions.version, snapshot: productVersions.snapshot, reason: productVersions.reason, createdAt: productVersions.createdAt, changedBy: productVersions.changedBy, name: employees.name })
    .from(productVersions)
    .leftJoin(employees, eq(employees.id, productVersions.changedBy))
    .where(eq(productVersions.productId, productId))
    .orderBy(desc(productVersions.version))
    .limit(MAX_VERSIONS + 1);
  const versions: VersionEntry[] = rows.slice(0, MAX_VERSIONS).map((row, index) => {
    const snapshot = readSnapshot(row.snapshot);
    const previous = rows[index + 1] ? readSnapshot(rows[index + 1].snapshot) : null;
    return {
      version: row.version,
      createdAt: row.createdAt,
      by: row.name ?? (row.changedBy && !row.changedBy.startsWith("emp_") ? row.changedBy : null),
      reason: row.reason,
      changes: snapshot ? (previous ? changedFields(previous, snapshot) : row.reason === "baseline" ? ["baseline"] : ["created"]) : [],
      status: snapshot?.product.status ?? null,
    };
  });
  const ids = state.variants.map((variant) => variant.id);
  const skuOf = new Map(state.variants.map((variant) => [variant.id, variant.sku]));
  // Price history is module 03's (price_changes, append-only): shown here read-only.
  const prices =
    ids.length === 0
      ? []
      : await db
          .select({ variantId: priceChanges.variantId, at: priceChanges.createdAt, oldPriceIqd: priceChanges.oldPriceIqd, newPriceIqd: priceChanges.newPriceIqd, source: priceChanges.source, reason: priceChanges.reason })
          .from(priceChanges)
          .where(and(inArray(priceChanges.variantId, ids), eq(priceChanges.status, "applied")))
          .orderBy(desc(priceChanges.createdAt))
          .limit(100);
  return {
    productId,
    current: state.product.version,
    versions,
    prices: prices.map((row) => ({ at: row.at, sku: skuOf.get(row.variantId) ?? "", oldPriceIqd: row.oldPriceIqd, newPriceIqd: row.newPriceIqd, source: row.source, reason: row.reason })),
    canRestore: can(actor, "catalog.version.restore"),
  };
}

export type FieldComparison = {
  field: string;
  then: unknown;
  now: unknown;
  /** A restore would bring this value back. */
  restorable: boolean;
  /** Shown for information, never restored (prices: module 03; status: the workflow; identifiers). */
  reasonKey?: "price" | "status" | "identifier" | "variant_gone" | "reference_gone";
};

export type VersionComparison = { version: number; current: number; createdAt: number; reason: string | null; fields: FieldComparison[]; restorable: number };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every barcode a product records, with the SKU it names: each variant's column and the extra codes per SKU. */
function codesOf(state: Pick<ProductState, "product" | "variants">): { sku: string; code: string }[] {
  const pairs = state.variants.flatMap((variant) => (variant.barcode ? [{ sku: variant.sku, code: variant.barcode }] : []));
  for (const [sku, codes] of Object.entries(recordedBarcodes(state.product.attributes))) for (const code of codes) pairs.push({ sku, code });
  return pairs;
}

/**
 * Whether the restored state would give one barcode to two variants: two SKUs of this product, or a code this product
 * does not hold now that a variant of another product holds.
 */
async function restoredCodesCollide(db: Db, current: ProductState, next: Pick<ProductState, "product" | "variants">): Promise<boolean> {
  const after = codesOf(next);
  const owners = new Map<string, Set<string>>();
  for (const { sku, code } of after) owners.set(code, new Set([...(owners.get(code) ?? []), sku]));
  if ([...owners.values()].some((skus) => skus.size > 1)) return true;
  const held = new Set(codesOf(current).map((pair) => pair.code));
  const gained = [...owners.keys()].filter((code) => !held.has(code));
  if (gained.length === 0) return false;
  return (await barcodeHolders(db, gained)).some((holder) => holder.productId !== current.product.id);
}

async function loadVersion(db: Db, productId: string, version: number): Promise<{ snapshot: ProductSnapshot; createdAt: number; reason: string | null }> {
  const row = await db.select().from(productVersions).where(and(eq(productVersions.productId, productId), eq(productVersions.version, version))).get();
  const snapshot = row ? readSnapshot(row.snapshot) : null;
  if (!row || !snapshot) throw catalogError("version_unknown", 404);
  return { snapshot, createdAt: row.createdAt, reason: row.reason };
}

/** Which referenced rows of a snapshot still exist. */
async function referencesThatExist(db: Db, snapshot: ProductSnapshot): Promise<{ categoryId: boolean; platformId: boolean; deviceModelId: boolean }> {
  const { categoryId, platformId, deviceModelId } = snapshot.product;
  const [category, platform, model] = await Promise.all([
    categoryId ? db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).get() : Promise.resolve({ id: null }),
    platformId ? db.select({ id: platforms.id }).from(platforms).where(eq(platforms.id, platformId)).get() : Promise.resolve({ id: null }),
    deviceModelId ? db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, deviceModelId)).get() : Promise.resolve({ id: null }),
  ]);
  return { categoryId: Boolean(category), platformId: Boolean(platform), deviceModelId: Boolean(model) };
}

export async function compareVersion(db: Db, actor: Actor, productId: string, version: number): Promise<VersionComparison> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const { snapshot, createdAt, reason } = await loadVersion(db, productId, version);
  const refs = await referencesThatExist(db, snapshot);
  const fields: FieldComparison[] = [];
  for (const field of RESTORABLE_PRODUCT_FIELDS) {
    const then = snapshot.product[field];
    const now = state.product[field];
    if (same(then, now)) continue;
    const gone = (field === "categoryId" || field === "platformId" || field === "deviceModelId") && then !== null && then !== undefined && !refs[field];
    fields.push({ field, then, now, restorable: !gone, ...(gone ? { reasonKey: "reference_gone" as const } : {}) });
  }
  if (!same(snapshot.product.status, state.product.status)) fields.push({ field: "status", then: snapshot.product.status, now: state.product.status, restorable: false, reasonKey: "status" });
  if (!same(snapshot.product.slug, state.product.slug)) fields.push({ field: "slug", then: snapshot.product.slug, now: state.product.slug, restorable: false, reasonKey: "identifier" });
  const current = new Map(state.variants.map((variant) => [variant.id, variant]));
  for (const old of snapshot.variants) {
    const variant = current.get(old.id);
    if (!variant) {
      fields.push({ field: `variants.${old.sku}`, then: old.sku, now: null, restorable: false, reasonKey: "variant_gone" });
      continue;
    }
    for (const field of RESTORABLE_VARIANT_FIELDS) {
      if (!same(old[field], variant[field])) fields.push({ field: `variants.${variant.sku}.${field}`, then: old[field], now: variant[field], restorable: true });
    }
    if (!same(old.priceIqd, variant.priceIqd)) fields.push({ field: `variants.${variant.sku}.priceIqd`, then: old.priceIqd, now: variant.priceIqd, restorable: false, reasonKey: "price" });
    if (!same(old.sku, variant.sku)) fields.push({ field: `variants.${variant.sku}.sku`, then: old.sku, now: variant.sku, restorable: false, reasonKey: "identifier" });
  }
  return { version, current: state.product.version, createdAt, reason, fields, restorable: fields.filter((field) => field.restorable).length };
}

export const RestoreInput = z.object({ productId: zId, version: zVersion, expectedVersion: zVersion, reason: zReason(true) });

export async function restoreVersion(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ version: number; restored: string[] }> {
  assertCan(actor, "catalog.version.restore");
  const input = parseInput(RestoreInput, raw);
  const state = await requireProductState(db, input.productId);
  if (state.product.version !== input.expectedVersion) throw catalogError("product_changed");
  if (state.product.status === "archived") throw catalogError("status_not_allowed", 409, { detail: "archived" });
  const { snapshot } = await loadVersion(db, input.productId, input.version);
  const refs = await referencesThatExist(db, snapshot);

  const nextProduct: Product = { ...state.product };
  const restored: string[] = [];
  for (const field of RESTORABLE_PRODUCT_FIELDS) {
    const then = snapshot.product[field];
    if (then === undefined || same(then, state.product[field])) continue;
    if ((field === "categoryId" || field === "platformId" || field === "deviceModelId") && then !== null && !refs[field]) continue;
    (nextProduct as Record<string, unknown>)[field] = then;
    restored.push(field);
  }
  const old = new Map(snapshot.variants.map((variant) => [variant.id, variant]));
  let nextVariants = state.variants.map((variant) => {
    const previous = old.get(variant.id);
    if (!previous) return variant;
    const next = { ...variant };
    for (const field of RESTORABLE_VARIANT_FIELDS) {
      if (previous[field] === undefined || same(previous[field], variant[field])) continue;
      (next as Record<string, unknown>)[field] = previous[field];
      restored.push(`variants.${variant.sku}.${field}`);
    }
    return next;
  });
  // Barcodes stay as they are when bringing them back would give one code to two variants.
  if (await restoredCodesCollide(db, state, { product: nextProduct, variants: nextVariants })) {
    nextVariants = nextVariants.map((variant, index) => ({ ...variant, barcode: state.variants[index].barcode }));
    const attributes: Record<string, unknown> = { ...(nextProduct.attributes ?? {}) };
    if (state.product.attributes && "variantBarcodes" in state.product.attributes) attributes.variantBarcodes = state.product.attributes.variantBarcodes;
    else delete attributes.variantBarcodes;
    nextProduct.attributes = Object.keys(attributes).length > 0 ? attributes : null;
    const kept = restored.filter((field) => !field.endsWith(".barcode") && (field !== "attributes" || !same(nextProduct.attributes, state.product.attributes)));
    restored.splice(0, restored.length, ...kept);
  }
  if (restored.length === 0) throw catalogError("nothing_to_restore", 409);

  // Never into an incomplete live product.
  const before = await productCompleteness(db, state.product.id);
  if (before) {
    const fields = await requiredCustomFields(db);
    const categoryOk = nextProduct.categoryId === state.product.categoryId ? before.facts.categoryOk : nextProduct.categoryId ? Boolean((await db.select({ ok: categories.isActive }).from(categories).where(eq(categories.id, nextProduct.categoryId)).get())?.ok) : false;
    const after = completenessOf(
      {
        ...before.facts,
        nameAr: nextProduct.name.ar,
        descriptionAr: nextProduct.description?.ar ?? null,
        categoryOk,
        warrantyMonths: nextProduct.warrantyMonths,
        ageRating: nextProduct.ageRating,
        region: nextProduct.region,
        licenseType: nextProduct.licenseType,
        mediaFormat: nextProduct.mediaFormat,
        variantsHaveRegion: nextVariants.filter((variant) => variant.isActive).every((variant) => Boolean(variant.options?.region?.trim())),
      },
      customRequirementsOf(nextProduct.kind, nextProduct.attributes, fields),
    );
    assertNoRegression(state.product.status, before.completeness, after);
  }

  const hasBaseline = (await baselines(db, [state.product])).has(state.product.id);
  const plan = commitStatements(db, {
    actor,
    now,
    before: state,
    after: { product: nextProduct, variants: nextVariants },
    action: "catalog.version.restore",
    reason: `${input.reason} (v${input.version})`,
    summary: `${state.product.slug}: restore v${input.version}`,
    hasBaseline,
  });
  await runBatch(db, [...plan.statements, ...plan.search]).catch(rethrowCatalog);
  return { version: plan.version, restored };
}

/** Names of a snapshot's references in a language (for the comparison screen). */
export async function referenceNames(db: Db, ids: string[], locale: Locale): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const json = JSON.stringify(unique);
  const rows = await db.all<{ id: string; name: string }>(sql`
    SELECT id, name FROM categories WHERE id IN (SELECT value FROM json_each(${json}))
    UNION ALL SELECT id, name FROM platforms WHERE id IN (SELECT value FROM json_each(${json}))
    UNION ALL SELECT id, name FROM device_models WHERE id IN (SELECT value FROM json_each(${json}))`);
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      out[row.id] = pick(JSON.parse(row.name) as L10n, locale);
    } catch {
      out[row.id] = row.id;
    }
  }
  return out;
}

