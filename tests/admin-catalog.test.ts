/**
 * Admin module 02 "catalog" (owner: admin catalog) — services under app/server/services/admin/catalog against a real
 * local D1 with the demo catalogue (createTestDb + seedDemo). Fixtures are chosen by their properties (a published
 * game with rules, the store set with components, …), never by hard-coded slugs.
 *
 *   · authorization per role (content, manager, inventory, cashier, a custom export-only role)
 *   · completeness blocks publishing; a save never makes a live product less complete
 *   · the search index: identical to the seed's rows, refreshed in the same batch, found by a new name
 *   · version guard (double submit / two tabs), history with a baseline, safe restore (never prices or stock)
 *   · variants (SKU, barcode check digit, serial tracking locked while stock exists), bundles, relations
 *   · compatibility: "verified" needs the verify permission and a source; the last rule of a live product stays
 *   · categories (cycles, depth, delete only when empty), workflow incl. the scheduled-publishing job
 *   · CSV import: dry run writes nothing, apply, double apply refused, rollback (and its conflicts); exports without
 *     cost for those without cost.read
 */
import { crc32 } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { auditEvents, employeeRoles, media, productVersions, products, stockLevels, variants } from "~/server/db/schema";
import { normalizeSearchText, searchProductIds } from "~/server/db/search.server";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { isAppError } from "~/server/errors";
import { kvBlobStore } from "~/server/storage.server";
import { getBundle, removeBundleComponent, setBundleComponent } from "~/server/services/admin/catalog/bundles.server";
import { saveCompatibilityRule, deleteCompatibilityRule, compareDevices, getProductCompatibility } from "~/server/services/admin/catalog/compatibility.server";
import { parseCsv, toCsv } from "~/server/services/admin/catalog/csv";
import { applyImport, exportProductsCsv, exportVariantsCsv, getImportJob, previewImport, rollbackImport } from "~/server/services/admin/catalog/import.server";
import { addCatalogPhoto, addUploadedImage, removeMedia, getGallery, moveMedia, updateMedia } from "~/server/services/admin/catalog/media.server";
import { bulkUpdateProducts, createProduct, getProductEditor, listProducts, parseProductFilters, updateProductDetails } from "~/server/services/admin/catalog/product.server";
import { addRelation, getRelations, removeRelation, updateRelation } from "~/server/services/admin/catalog/relations.server";
import { barcodeCheckDigitOk, completenessOf } from "~/server/services/admin/catalog/rules";
import { catalogSearchDocs, loadSearchSource } from "~/server/services/admin/catalog/search-index.server";
import { deleteCategory, getCategoryTree, moveCategory, saveCategory, saveDeviceModel } from "~/server/services/admin/catalog/taxonomy.server";
import { getVariantsEditor, saveVariant, setVariantActive } from "~/server/services/admin/catalog/variants.server";
import { compareVersion, getHistory, restoreVersion } from "~/server/services/admin/catalog/versions.server";
import { bulkChangeStatus, changeProductStatus, publishDueProducts } from "~/server/services/admin/catalog/workflow.server";
import { CRON_FREQUENT, runScheduledJobs } from "~/server/jobs.server";
import { addToCart } from "~/server/services/cart.server";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { DEFAULT_ROLES, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
const NOW = Date.UTC(2026, 10, 10, 6, 0, 0);
let clock = NOW;
/** A fresh "now" per change, so versions and audit rows keep their order. */
const tick = () => (clock += 1000);

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const one = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T> => {
  const found = await rows<T>(query, ...params);
  if (!found[0]) throw new Error(`no row for: ${query}`);
  return found[0];
};

async function failure(run: () => Promise<unknown>): Promise<{ code: string; status: number; fields?: Record<string, string>; detail?: string }> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, status: error.status, fields: error.fields, detail: error.detail };
    throw error;
  }
  throw new Error("expected the call to fail");
}

type Staff = { id: string; actor: EmployeeActor };
async function staff(role: DefaultRoleKey | Permission[], name = "موظف"): Promise<Staff> {
  const id = await make.employee({ name });
  const permissions = Array.isArray(role) ? role : [...(DEFAULT_ROLES.find((entry) => entry.key === role)?.permissions ?? [])];
  if (!Array.isArray(role)) await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, actor: { kind: "employee", id, permissions: new Set(permissions), label: name } };
}

let owner: Staff;
let manager: Staff;
let content: Staff;
let inventory: Staff;
let cashier: Staff;
let exporter: Staff;

const version = async (productId: string) => (await one<{ version: number }>("SELECT version FROM products WHERE id = ?", productId)).version;
const status = async (productId: string) => (await one<{ status: string; published_at: number | null }>("SELECT status, published_at FROM products WHERE id = ?", productId));

/** A complete, published product of a kind, chosen by its properties (the list's completeness). */
async function completePublished(kind: string): Promise<{ id: string; slug: string }> {
  const list = await listProducts(t.db, manager.actor, { ...parseProductFilters(new URLSearchParams(`kind=${kind}&status=published`)) }, "en", NOW);
  const row = list.rows.find((entry) => entry.complete);
  if (!row) throw new Error(`no complete published ${kind} in the demo catalogue`);
  return { id: row.id, slug: row.slug };
}

/** A draft made complete enough to publish: category, description, a priced variant, a picture. */
async function readyDraft(kind: "accessory" | "console" = "console"): Promise<{ productId: string; variantId: string; sku: string }> {
  const category = await one<{ id: string }>("SELECT id FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
  const slug = `test-${make.next("draft").toLowerCase()}`;
  const sku = `TST-${make.next("SKU")}`;
  const { productId } = await createProduct(t.db, content.actor, { kind, slug, name: { ar: `منتج ${slug}`, en: `Product ${slug}` }, categoryId: category.id, sku }, tick());
  const variant = await one<{ id: string }>("SELECT id FROM variants WHERE product_id = ?", productId);
  await updateProductDetails(
    t.db,
    content.actor,
    { productId, version: await version(productId), kind, name: { ar: `منتج ${slug}`, en: `Product ${slug}` }, description: { ar: "وصف المنتج للاختبار" }, categoryId: category.id, warrantyMonths: "12" },
    tick(),
  );
  // Prices are module 03's: set here as the pricing module would.
  await t.db.update(variants).set({ priceIqd: 150_000 }).where(eq(variants.id, variant.id));
  const photo = await one<{ art_key: string }>("SELECT art_key FROM media WHERE art_key IS NOT NULL LIMIT 1");
  await addCatalogPhoto(t.db, content.actor, { productId, artKey: photo.art_key, alt: { ar: "صورة" } }, tick());
  return { productId, variantId: variant.id, sku };
}

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  make = fixtures(t.db, NOW);
  owner = await staff("owner", "المالك");
  manager = await staff("manager", "المدير");
  content = await staff("content", "محرر المحتوى");
  inventory = await staff("inventory", "أمين المخزن");
  cashier = await staff("cashier", "الكاشير");
  exporter = await staff(["catalog.product.read", "catalog.product.export"], "مصدّر");
});
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── pure rules

describe("rules", () => {
  test("barcodes need a valid GS1 check digit", () => {
    expect(barcodeCheckDigitOk("0045496886028")).toBe(true);
    expect(barcodeCheckDigitOk("0045496886027")).toBe(false);
    expect(barcodeCheckDigitOk("045496905613")).toBe(true);
    expect(barcodeCheckDigitOk("12345")).toBe(false);
  });

  test("completeness lists what each kind needs; warranty 0 counts as decided", () => {
    const base = { nameAr: "اسم", descriptionAr: "وصف", categoryOk: true, activeVariants: 1, unpricedVariants: 0, images: 1, compatibleRules: 0, warrantyMonths: null, ageRating: null, region: null, variantsHaveRegion: false, licenseType: null, mediaFormat: null, variantsWithoutComponents: 1 };
    expect(completenessOf({ ...base, kind: "console" }).missing).toEqual(["warranty"]);
    expect(completenessOf({ ...base, kind: "console", warrantyMonths: 0 }).complete).toBe(true);
    expect(completenessOf({ ...base, kind: "game" }).missing).toEqual(["compatibility", "age_rating", "media_format"]);
    expect(completenessOf({ ...base, kind: "digital", compatibleRules: 1, licenseType: "wallet_topup", variantsHaveRegion: true }).complete).toBe(true);
    expect(completenessOf({ ...base, kind: "bundle" }).missing).toEqual(["bundle_components"]);
    expect(completenessOf({ ...base, kind: "accessory", unpricedVariants: 1, compatibleRules: 1, warrantyMonths: 6 }).missing).toEqual(["prices"]);
  });

  test("CSV reads quotes, semicolons and a byte-order mark, and writes formula-safe cells that read back", () => {
    const parsed = parseCsv('﻿slug;name_ar\r\nps5;"بلايستيشن ""5"""\r\n\r\nx;"سطر\nثان"');
    expect(parsed.header).toEqual(["slug", "name_ar"]);
    expect(parsed.rows.map((row) => row.cells.name_ar)).toEqual(['بلايستيشن "5"', "سطر\nثان"]);
    const text = toCsv(["a", "b"], [{ a: "=HYPERLINK(1)", b: "x,y" }]);
    expect(text).toContain("'=HYPERLINK(1)");
    expect(parseCsv(text).rows[0].cells).toEqual({ a: "=HYPERLINK(1)", b: "x,y" });
  });
});

// ───────────────────────────────────────────────────────────────── authorization

describe("authorization per role", () => {
  test("content edits but cannot publish, import, export, restore or verify; cashier and inventory only read", async () => {
    const game = await completePublished("game");
    const v = await version(game.id);
    expect((await failure(async () => changeProductStatus(t.db, content.actor, { productId: game.id, version: v, action: "hide", reason: "test" }, tick()))).code).toBe("forbidden");
    expect((await failure(async () => bulkUpdateProducts(t.db, content.actor, { ids: [game.id], set: { brand: "X" }, reason: "test" }, tick()))).code).toBe("forbidden");
    expect((await failure(async () => exportVariantsCsv(t.db, content.actor, parseProductFilters(new URLSearchParams()), "ar", NOW))).code).toBe("forbidden");
    expect((await failure(async () => restoreVersion(t.db, content.actor, { productId: game.id, version: 1, expectedVersion: v, reason: "test" }, tick()))).code).toBe("forbidden");
    expect((await failure(async () => saveDeviceModel(t.db, content.actor, {}, tick()))).code).toBe("forbidden");
    for (const reader of [cashier, inventory]) {
      expect((await listProducts(t.db, reader.actor, parseProductFilters(new URLSearchParams()), "ar", NOW)).total).toBeGreaterThan(0);
      expect((await failure(async () => updateProductDetails(t.db, reader.actor, { productId: game.id, version: v }, tick()))).code).toBe("forbidden");
      expect((await failure(async () => saveCategory(t.db, reader.actor, { slug: "x", name: { ar: "س" } }, tick()))).code).toBe("forbidden");
    }
    // Nobody without catalog.product.read gets the list.
    expect((await failure(async () => listProducts(t.db, { kind: "employee", id: "emp_none", permissions: new Set(["pos.sale.create"]) }, parseProductFilters(new URLSearchParams()), "ar", NOW))).code).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── search index

describe("search index", () => {
  test("the admin's row builder writes exactly the seed's rows for every product", async () => {
    const indexed = await rows<{ product_id: string; locale: string; name: string; keywords: string; body: string }>("SELECT product_id, locale, name, keywords, body FROM search_index ORDER BY product_id, locale");
    const ids = [...new Set(indexed.map((row) => row.product_id))];
    expect(ids.length).toBeGreaterThan(100);
    for (const id of ids) {
      const source = await loadSearchSource(t.db, id);
      const docs = catalogSearchDocs(source!).map((doc) => ({ product_id: id, locale: doc.locale, name: normalizeSearchText(doc.name), keywords: normalizeSearchText(doc.keywords), body: normalizeSearchText(doc.body) }));
      expect(docs.sort((a, b) => a.locale.localeCompare(b.locale)), id).toEqual(indexed.filter((row) => row.product_id === id));
    }
  });

  test("an edited product is found by its new name in the same batch, and no longer by the old one", async () => {
    const game = await completePublished("game");
    const before = await getProductEditor(t.db, content.actor, game.id, "ar", NOW);
    const newName = "Zorblax Quantum Edition";
    await updateProductDetails(
      t.db,
      content.actor,
      {
        productId: game.id,
        version: before.product.version,
        kind: before.product.kind,
        name: { ...before.product.name, en: newName },
        short: before.product.short,
        description: before.product.description,
        categoryId: before.product.categoryId,
        platformId: before.product.platformId ?? "",
        ageRating: before.product.ageRating,
        mediaFormat: before.product.mediaFormat,
        specs: before.product.specs,
      },
      tick(),
    );
    expect((await searchProductIds(t.db, "Zorblax Quantum")).map((hit) => hit.productId)).toContain(game.id);
    // The rows were replaced, not added to: still one per language, the English one under the new name.
    const indexed = await rows<{ locale: string; name: string }>("SELECT locale, name FROM search_index WHERE product_id = ? ORDER BY locale", game.id);
    expect(indexed.map((row) => row.locale)).toEqual(["ar", "ckb", "en"]);
    expect(indexed.find((row) => row.locale === "en")?.name).toBe(normalizeSearchText(newName));
  });

  test("drafts are not indexed; publishing indexes, hiding removes", async () => {
    const draft = await readyDraft("console");
    const count = async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM search_index WHERE product_id = ?", draft.productId)).n;
    expect(await count()).toBe(0);
    await changeProductStatus(t.db, manager.actor, { productId: draft.productId, version: await version(draft.productId), action: "publish" }, tick());
    expect(await count()).toBe(3);
    expect((await searchProductIds(t.db, draft.sku)).map((hit) => hit.productId)).toContain(draft.productId);
    await changeProductStatus(t.db, manager.actor, { productId: draft.productId, version: await version(draft.productId), action: "hide", reason: "خطأ في الصور" }, tick());
    expect(await count()).toBe(0);
    expect((await status(draft.productId)).status).toBe("draft");
    expect((await status(draft.productId)).published_at).not.toBeNull();
    const hidden = await listProducts(t.db, manager.actor, parseProductFilters(new URLSearchParams("status=hidden")), "ar", NOW);
    expect(hidden.rows.map((row) => row.id)).toContain(draft.productId);
  });
});

// ───────────────────────────────────────────────────────────────── completeness and workflow

describe("publishing workflow", () => {
  test("an incomplete product can be neither published nor scheduled, and says what is missing", async () => {
    const category = await one<{ id: string }>("SELECT id FROM categories LIMIT 1");
    const { productId } = await createProduct(t.db, content.actor, { kind: "game", slug: "test-incomplete-game", name: { ar: "لعبة ناقصة" }, categoryId: category.id }, tick());
    const editor = await getProductEditor(t.db, manager.actor, productId, "ar", NOW);
    expect(editor.completeness.complete).toBe(false);
    expect(editor.completeness.missing).toEqual(expect.arrayContaining(["description_ar", "variants", "prices", "images", "compatibility", "age_rating"]));
    const refused = await failure(async () => changeProductStatus(t.db, manager.actor, { productId, version: editor.product.version, action: "publish" }, tick()));
    expect(refused.code).toBe("incomplete");
    expect(refused.detail).toContain("age_rating");
    expect((await failure(async () => changeProductStatus(t.db, manager.actor, { productId, version: editor.product.version, action: "schedule", publishAt: NOW + 86_400_000 }, tick()))).code).toBe("incomplete");
    // Content may hand it over for review, but not publish it.
    await changeProductStatus(t.db, content.actor, { productId, version: editor.product.version, action: "submit_review" }, tick());
    expect((await status(productId)).status).toBe("review");
  });

  test("a save never makes a live product less complete", async () => {
    const game = await completePublished("game");
    const editor = await getProductEditor(t.db, content.actor, game.id, "ar", NOW);
    const refused = await failure(async () =>
      updateProductDetails(
        t.db,
        content.actor,
        { productId: game.id, version: editor.product.version, kind: "game", name: editor.product.name, description: editor.product.description, categoryId: editor.product.categoryId, mediaFormat: editor.product.mediaFormat, ageRating: "" },
        tick(),
      ),
    );
    expect(refused).toMatchObject({ code: "regression", detail: "age_rating" });
    // The last picture of a live product stays.
    const gallery = await getGallery(t.db, content.actor, game.id, "ar");
    const own = gallery.items.filter((item) => item.ownerType === "product");
    for (const item of own.slice(1)) await removeMedia(t.db, kvBlobStore(t.kv), content.actor, { id: item.id, productId: game.id, reason: "صور مكررة" }, tick());
    expect((await failure(async () => removeMedia(t.db, kvBlobStore(t.kv), content.actor, { id: own[0].id, productId: game.id, reason: "آخر صورة" }, tick()))).code).toBe("regression");
  });

  test("scheduling: not in the past; the job publishes due products and returns incomplete ones to draft", async () => {
    const ready = await readyDraft("console");
    const v = await version(ready.productId);
    expect((await failure(async () => changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: v, action: "schedule", publishAt: clock - 1000 }, tick()))).code).toBe("schedule_past");
    const at = clock + 3_600_000;
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: v, action: "schedule", publishAt: at }, tick());
    expect((await publishDueProducts(t.db, at - 1)).published).not.toContain(ready.productId);
    const run = await publishDueProducts(t.db, at + 1);
    expect(run.published).toContain(ready.productId);
    expect(await status(ready.productId)).toMatchObject({ status: "published", published_at: at });
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM search_index WHERE product_id = ?", ready.productId)).n).toBe(3);
    expect((await publishDueProducts(t.db, at + 2)).published).toEqual([]);

    // Scheduled, then its price disappears (another module): at its time it goes back to draft.
    const other = await readyDraft("console");
    await changeProductStatus(t.db, manager.actor, { productId: other.productId, version: await version(other.productId), action: "schedule", publishAt: at + 60_000 }, tick());
    await t.db.update(variants).set({ priceIqd: 0 }).where(eq(variants.id, other.variantId));
    const second = await publishDueProducts(t.db, at + 120_000);
    expect(second.returnedToDraft).toContain(other.productId);
    expect((await status(other.productId)).status).toBe("draft");
  });

  test("the 5-minute cron publishes a scheduled product once its time has come (job catalog.publish_due)", async () => {
    const ready = await readyDraft("console");
    const at = clock + 7_200_000;
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "schedule", publishAt: at }, tick());
    const publishJob = (run: Awaited<ReturnType<typeof runScheduledJobs>>) => run.jobs.find((job) => job.job === "catalog.publish_due");
    const early = await runScheduledJobs(t.db, CRON_FREQUENT, at - 60_000);
    expect(publishJob(early)?.status).toBe("succeeded");
    expect((await status(ready.productId)).status).toBe("scheduled");
    const due = await runScheduledJobs(t.db, CRON_FREQUENT, at + 60_000);
    expect(publishJob(due)?.status).toBe("succeeded");
    expect(Number(publishJob(due)?.stats.published)).toBeGreaterThanOrEqual(1);
    expect(await status(ready.productId)).toMatchObject({ status: "published", published_at: at });
  });

  test("hiding and archiving need a reason; bulk transitions skip what they may not change", async () => {
    const ready = await readyDraft("console");
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "publish" }, tick());
    expect((await failure(async () => changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "archive" }, tick()))).fields).toEqual({ reason: "reason_required" });
    const draft = await readyDraft("console");
    const outcome = await bulkChangeStatus(t.db, manager.actor, { ids: [ready.productId, draft.productId], action: "hide", reason: "تحديث الصور" }, tick());
    expect(outcome.changed).toEqual([ready.productId]);
    expect(outcome.skipped).toEqual([{ id: draft.productId, reason: "status_not_allowed" }]);
    const audit = await rows<{ reason: string }>("SELECT reason FROM audit_events WHERE entity_id = ? AND action = 'catalog.product.hide'", ready.productId);
    expect(audit.map((row) => row.reason)).toEqual(["تحديث الصور"]);
  });
});

// ───────────────────────────────────────────────────────────────── versions

describe("versions and safe restore", () => {
  test("a double submit with the same version changes the product once", async () => {
    const game = await completePublished("game");
    const editor = await getProductEditor(t.db, content.actor, game.id, "ar", NOW);
    const input = { productId: game.id, version: editor.product.version, kind: "game", name: editor.product.name, short: editor.product.short, description: editor.product.description, categoryId: editor.product.categoryId, platformId: editor.product.platformId ?? "", ageRating: editor.product.ageRating, mediaFormat: editor.product.mediaFormat, brand: "Double Submit" };
    const results = await Promise.allSettled([updateProductDetails(t.db, content.actor, input, tick()), updateProductDetails(t.db, content.actor, input, tick())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(isAppError(rejected.reason, "product_changed")).toBe(true);
    expect(await version(game.id)).toBe(editor.product.version + 1);
  });

  test("history starts with a baseline; restore brings back texts but never prices, stock or status", async () => {
    const ready = await readyDraft("console");
    const v1 = await version(ready.productId);
    const original = await getProductEditor(t.db, content.actor, ready.productId, "ar", NOW);
    await updateProductDetails(t.db, content.actor, { productId: ready.productId, version: v1, kind: "console", name: { ar: "اسم جديد تماماً" }, description: { ar: "وصف جديد" }, categoryId: original.product.categoryId, warrantyMonths: "24" }, tick());
    // Meanwhile the price and the stock change (modules 03 and 04).
    await t.db.update(variants).set({ priceIqd: 199_000 }).where(eq(variants.id, ready.variantId));
    await t.db.insert(stockLevels).values({ variantId: ready.variantId, locationId: DEFAULT_LOCATION_ID, onHand: 7 });

    const comparison = await compareVersion(t.db, manager.actor, ready.productId, v1);
    expect(comparison.fields.find((field) => field.field === "name")).toMatchObject({ restorable: true });
    expect(comparison.fields.find((field) => field.field.endsWith(".priceIqd"))).toMatchObject({ restorable: false, reasonKey: "price" });

    const result = await restoreVersion(t.db, manager.actor, { productId: ready.productId, version: v1, expectedVersion: await version(ready.productId), reason: "الاسم القديم أدق" }, tick());
    expect(result.restored).toEqual(expect.arrayContaining(["name", "description", "warrantyMonths"]));
    const product = await one<{ name: string; warranty_months: number }>("SELECT name, warranty_months FROM products WHERE id = ?", ready.productId);
    expect(JSON.parse(product.name).ar).toBe(original.product.name.ar);
    expect(product.warranty_months).toBe(12);
    expect((await one<{ price_iqd: number }>("SELECT price_iqd FROM variants WHERE id = ?", ready.variantId)).price_iqd).toBe(199_000);
    expect((await one<{ on_hand: number }>("SELECT on_hand FROM stock_levels WHERE variant_id = ?", ready.variantId)).on_hand).toBe(7);
    const history = await getHistory(t.db, manager.actor, ready.productId);
    expect(history.versions[0]).toMatchObject({ reason: expect.stringContaining("الاسم القديم أدق") });
    expect(history.versions.length).toBeGreaterThanOrEqual(4);
  });

  test("a seeded product gets a baseline version the first time it changes; versions are append-only", async () => {
    const seeded = await one<{ id: string; version: number }>("SELECT p.id, p.version FROM products p WHERE p.is_demo = 1 AND p.kind = 'headset' AND NOT EXISTS (SELECT 1 FROM product_versions v WHERE v.product_id = p.id) LIMIT 1");
    await bulkUpdateProducts(t.db, manager.actor, { ids: [seeded.id], set: { warrantyMonths: "6" }, reason: "سياسة الضمان" }, tick());
    const versions = await rows<{ version: number; reason: string }>("SELECT version, reason FROM product_versions WHERE product_id = ? ORDER BY version", seeded.id);
    expect(versions).toEqual([
      { version: seeded.version, reason: "baseline" },
      { version: seeded.version + 1, reason: "سياسة الضمان" },
    ]);
    await expect(t.db.delete(productVersions).where(eq(productVersions.productId, seeded.id))).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────── variants

describe("variants", () => {
  test("a new variant has no price until Pricing sets one; SKUs are unique; barcodes are checked", async () => {
    const ready = await readyDraft("console");
    const v = await version(ready.productId);
    // A restricted-circulation code (GS1 prefix 29): no real product carries it, so it is free.
    const { variantId } = await saveVariant(t.db, content.actor, { productId: ready.productId, version: v, sku: "tst-white-1tb", barcode: "2900000000018", options: { color: "White", storage: "1TB", condition: "new" }, title: { ar: "أبيض 1TB" } }, tick());
    const row = await one<{ sku: string; price_iqd: number; options: string }>("SELECT sku, price_iqd, options FROM variants WHERE id = ?", variantId);
    expect(row).toMatchObject({ sku: "TST-WHITE-1TB", price_iqd: 0 });
    expect(JSON.parse(row.options)).toEqual({ color: "White", storage: "1TB", condition: "new" });
    expect((await failure(async () => saveVariant(t.db, content.actor, { productId: ready.productId, version: await version(ready.productId), sku: ready.sku }, tick()))).code).toBe("sku_taken");
    expect((await failure(async () => saveVariant(t.db, content.actor, { productId: ready.productId, version: await version(ready.productId), sku: "TST-BAD-CODE", barcode: "0045496886027" }, tick()))).fields).toEqual({ barcode: "barcode_invalid" });
    // The unpriced variant now keeps the product from being published.
    const editor = await getProductEditor(t.db, manager.actor, ready.productId, "ar", NOW);
    expect(editor.completeness.missing).toContain("prices");
  });

  test("serial tracking cannot change while the variant holds stock", async () => {
    const ready = await readyDraft("console");
    await t.db.insert(stockLevels).values({ variantId: ready.variantId, locationId: DEFAULT_LOCATION_ID, onHand: 2 });
    const current = await one<{ track_serials: number }>("SELECT track_serials FROM variants WHERE id = ?", ready.variantId);
    const refused = await failure(async () => saveVariant(t.db, content.actor, { productId: ready.productId, version: await version(ready.productId), variantId: ready.variantId, sku: ready.sku, trackSerials: current.track_serials ? "" : "on" }, tick()));
    expect(refused.code).toBe("track_serials_locked");
  });

  test("cost columns reach only cost.read and profit.read holders", async () => {
    const game = await completePublished("game");
    const forContent = await getVariantsEditor(t.db, content.actor, game.id, "ar");
    expect(forContent.showCost).toBe(false);
    for (const row of forContent.rows) {
      expect(row).not.toHaveProperty("landedCostIqd");
      expect(row).not.toHaveProperty("marginBps");
    }
    const forManager = await getVariantsEditor(t.db, manager.actor, game.id, "ar");
    expect(forManager.rows.some((row) => typeof row.landedCostIqd === "number")).toBe(true);
    expect(forManager.rows.some((row) => typeof row.marginBps === "number")).toBe(true);
  });

  test("the last active variant of a live product cannot be switched off", async () => {
    const ready = await readyDraft("console");
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "publish" }, tick());
    const refused = await failure(async () => setVariantActive(t.db, content.actor, { productId: ready.productId, variantId: ready.variantId, version: await version(ready.productId), active: "false", reason: "لم يعد يباع" }, tick()));
    expect(["variant_last_active", "regression"]).toContain(refused.code);
  });
});

// ───────────────────────────────────────────────────────────────── bundles and relations

describe("bundles and relations", () => {
  test("a bundle is available only as far as every component is", async () => {
    const set = await one<{ product_id: string; variant_id: string }>("SELECT v.product_id, v.id AS variant_id FROM variants v WHERE EXISTS (SELECT 1 FROM bundle_items b WHERE b.bundle_variant_id = v.id) LIMIT 1");
    const view = await getBundle(t.db, content.actor, set.product_id, "ar");
    const variant = view.variants.find((entry) => entry.id === set.variant_id)!;
    expect(variant.components.length).toBeGreaterThan(1);
    const expected = Math.min(...variant.components.map((component) => Math.floor(component.available / component.qty)));
    expect(variant.available).toBe(expected);
    expect(variant.components.filter((component) => component.limiting).every((component) => component.sets === expected)).toBe(true);
    // Raising one component's quantity can only lower the bundle's availability.
    const first = variant.components[0];
    await setBundleComponent(t.db, content.actor, { productId: set.product_id, bundleVariantId: set.variant_id, component: first.sku, qty: first.qty + 50 > 20 ? 20 : first.qty + 1 }, tick());
    const after = (await getBundle(t.db, content.actor, set.product_id, "ar")).variants.find((entry) => entry.id === set.variant_id)!;
    expect(after.available).toBeLessThanOrEqual(expected);
    await setBundleComponent(t.db, content.actor, { productId: set.product_id, bundleVariantId: set.variant_id, component: first.sku, qty: first.qty }, tick());
  });

  test("components are stocked variants of other products, one level deep", async () => {
    const set = await one<{ product_id: string; variant_id: string; sku: string }>("SELECT v.product_id, v.id AS variant_id, v.sku FROM variants v WHERE EXISTS (SELECT 1 FROM bundle_items b WHERE b.bundle_variant_id = v.id) LIMIT 1");
    // A new bundle product (components go only on a bundle's own variants).
    const category = await one<{ id: string }>("SELECT id FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
    const bundleSku = `TST-${make.next("SET")}`;
    const { productId: bundleId } = await createProduct(t.db, content.actor, { kind: "bundle", slug: `test-${make.next("set").toLowerCase()}`, name: { ar: "حزمة للاختبار" }, categoryId: category.id, sku: bundleSku }, tick());
    const ready = { productId: bundleId, variantId: (await one<{ id: string }>("SELECT id FROM variants WHERE product_id = ?", bundleId)).id, sku: bundleSku };
    // A bundle inside another bundle is refused, and so is the product's own variant.
    expect((await failure(async () => setBundleComponent(t.db, content.actor, { productId: ready.productId, bundleVariantId: ready.variantId, component: set.sku, qty: 1 }, tick()))).code).toBe("bundle_nested");
    expect((await failure(async () => setBundleComponent(t.db, content.actor, { productId: ready.productId, bundleVariantId: ready.variantId, component: ready.sku, qty: 1 }, tick()))).code).toBe("bundle_self");
    expect((await failure(async () => setBundleComponent(t.db, content.actor, { productId: ready.productId, bundleVariantId: ready.variantId, component: "NO-SUCH-SKU", qty: 1 }, tick()))).code).toBe("component_unknown");
    expect((await failure(async () => setBundleComponent(t.db, cashier.actor, { productId: ready.productId, bundleVariantId: ready.variantId, component: "X", qty: 1 }, tick()))).code).toBe("forbidden");
    expect(await removeBundleComponent(t.db, content.actor, { productId: ready.productId, bundleVariantId: ready.variantId, componentVariantId: set.variant_id, reason: "ليس مكوناً" }, tick())).toEqual({ removed: false });
  });

  test("relations keep product ids, are idempotent and never point at the product itself", async () => {
    const consoleProduct = await one<{ id: string; slug: string }>("SELECT id, slug FROM products WHERE kind = 'console' AND device_model_id IS NOT NULL LIMIT 1");
    const accessory = await one<{ id: string; sku: string }>("SELECT p.id, v.sku FROM products p JOIN variants v ON v.product_id = p.id WHERE p.kind = 'accessory' LIMIT 1");
    const first = await addRelation(t.db, content.actor, { productId: consoleProduct.id, related: accessory.sku, kind: "accessory" }, tick());
    const second = await addRelation(t.db, content.actor, { productId: consoleProduct.id, related: accessory.sku, kind: "accessory" }, tick());
    expect(first).toEqual({ relatedProductId: accessory.id, replayed: false });
    expect(second.replayed).toBe(true);
    expect((await failure(async () => addRelation(t.db, content.actor, { productId: consoleProduct.id, related: consoleProduct.slug, kind: "upsell" }, tick()))).code).toBe("relation_self");
    const view = await getRelations(t.db, content.actor, consoleProduct.id, "ar");
    expect(view.outgoing.filter((row) => row.relatedProductId === accessory.id)).toHaveLength(1);
    // Renaming the accessory does not break the link (ids, not names).
    await t.db.update(products).set({ name: { ar: "اسم آخر" } }).where(eq(products.id, accessory.id));
    expect((await getRelations(t.db, content.actor, consoleProduct.id, "ar")).outgoing.find((row) => row.relatedProductId === accessory.id)?.name).toBe("اسم آخر");
  });
});

// ───────────────────────────────────────────────────────────────── compatibility

describe("compatibility rules and device comparison", () => {
  test("verified needs the verify permission and a source; partial needs a note; the verifier is recorded", async () => {
    const ready = await readyDraft("accessory");
    const model = await one<{ id: string }>("SELECT id FROM device_models WHERE status = 'published' LIMIT 1");
    const base = { productId: ready.productId, subject: "product", target: `device_model:${model.id}` };
    expect((await failure(async () => saveCompatibilityRule(t.db, content.actor, { ...base, status: "verified", source: "https://example.com" }, tick()))).code).toBe("forbidden");
    expect((await failure(async () => saveCompatibilityRule(t.db, content.actor, { ...base, status: "partial" }, tick()))).fields).toEqual({ "note.ar": "note_required" });
    await saveCompatibilityRule(t.db, content.actor, { ...base, status: "partial", note: { ar: "يحتاج تحديث النظام" } }, tick());
    expect((await failure(async () => saveCompatibilityRule(t.db, manager.actor, { ...base, status: "verified" }, tick()))).fields).toEqual({ source: "source_required" });
    const { id } = await saveCompatibilityRule(t.db, manager.actor, { ...base, status: "verified", source: "اختبار في المتجر" }, tick());
    const rule = await one<{ status: string; verified_by: string }>("SELECT status, verified_by FROM compatibility_rules WHERE id = ?", id);
    expect(rule).toEqual({ status: "verified", verified_by: manager.id });
    // One rule per edge: saving the same edge again updates it.
    expect((await rows("SELECT id FROM compatibility_rules WHERE subject_id = ?", ready.productId)).length).toBe(1);
    const view = await getProductCompatibility(t.db, content.actor, ready.productId, "ar");
    expect(view.canVerify).toBe(false);
    expect(view.rules[0]).toMatchObject({ status: "verified", verifiedBy: "المدير" });
  });

  test("the last compatible rule of a live product cannot be removed", async () => {
    const accessory = await completePublished("game");
    const rules = await rows<{ id: string; status: string }>("SELECT id, status FROM compatibility_rules WHERE subject_type = 'product' AND subject_id = ? ORDER BY status = 'verified'", accessory.id);
    const counted = rules.filter((rule) => rule.status === "verified" || rule.status === "partial");
    for (const rule of rules.filter((entry) => !counted.includes(entry)).concat(counted.slice(0, -1))) {
      await deleteCompatibilityRule(t.db, manager.actor, { id: rule.id, productId: accessory.id, reason: "تنظيف" }, tick());
    }
    const last = counted[counted.length - 1];
    expect((await failure(async () => deleteCompatibilityRule(t.db, manager.actor, { id: last.id, productId: accessory.id, reason: "تنظيف" }, tick()))).code).toBe("regression");
  });

  test("devices compare spec by spec, and compatibility shows per device (most specific rule wins)", async () => {
    const models = await rows<{ slug: string }>("SELECT m.slug FROM device_models m JOIN device_generations g ON g.id = m.generation_id WHERE m.specs IS NOT NULL GROUP BY m.generation_id HAVING COUNT(*) >= 1 LIMIT 3");
    const comparison = await compareDevices(t.db, content.actor, models.map((row) => row.slug), "en");
    expect(comparison.models).toHaveLength(models.length);
    expect(comparison.specs.length).toBeGreaterThan(0);
    expect(comparison.specs.every((row) => row.values.length === models.length)).toBe(true);
    for (const [index, totals] of comparison.totals.entries()) {
      const counted = comparison.compatibility.filter((row) => row.statuses[index] === "verified").length;
      expect(totals.verified).toBe(counted);
    }
  });
});

// ───────────────────────────────────────────────────────────────── taxonomy

describe("categories and devices", () => {
  test("no cycles, no tree deeper than four levels, delete only when empty", async () => {
    const root = await saveCategory(t.db, content.actor, { slug: "test-root", name: { ar: "جذر" }, isActive: "on" }, tick());
    const child = await saveCategory(t.db, content.actor, { slug: "test-child", name: { ar: "فرع" }, parentId: root.id, isActive: "on" }, tick());
    expect((await saveCategory(t.db, content.actor, { slug: "test-child", name: { ar: "فرع" }, parentId: root.id, isActive: "on" }, tick())).replayed).toBe(true);
    expect((await failure(async () => saveCategory(t.db, content.actor, { id: root.id, slug: "test-root", name: { ar: "جذر" }, parentId: child.id, isActive: "on" }, tick()))).code).toBe("category_cycle");
    const grand = await saveCategory(t.db, content.actor, { slug: "test-grand", name: { ar: "حفيد" }, parentId: child.id, isActive: "on" }, tick());
    const great = await saveCategory(t.db, content.actor, { slug: "test-great", name: { ar: "أعمق" }, parentId: grand.id, isActive: "on" }, tick());
    expect((await failure(async () => saveCategory(t.db, content.actor, { slug: "test-too-deep", name: { ar: "عميق جداً" }, parentId: great.id, isActive: "on" }, tick()))).code).toBe("category_depth");
    expect((await failure(async () => deleteCategory(t.db, content.actor, { id: child.id, reason: "تجربة" }, tick()))).code).toBe("category_not_empty");
    await deleteCategory(t.db, content.actor, { id: great.id, reason: "لم يعد مطلوباً" }, tick());
    await moveCategory(t.db, content.actor, { id: root.id, direction: "up" }, tick());
    const tree = await getCategoryTree(t.db, content.actor, "ar");
    expect(tree.flat.find((node) => node.id === root.id)?.children.map((node) => node.id)).toEqual([child.id]);
    expect(await rows("SELECT id FROM categories WHERE id = ?", great.id)).toEqual([]);
  });

  test("platform management needs catalog.platform.manage; a generation must belong to the model's platform", async () => {
    const [nintendo, playstation] = await rows<{ id: string }>("SELECT id FROM platforms ORDER BY sort LIMIT 2");
    const generation = await one<{ id: string }>("SELECT id FROM device_generations WHERE platform_id = ? LIMIT 1", playstation.id);
    const input = { platformId: nintendo.id, generationId: generation.id, slug: "test-device", name: { ar: "جهاز" }, status: "draft", deviceKind: "console" };
    expect((await failure(async () => saveDeviceModel(t.db, content.actor, input, tick()))).code).toBe("forbidden");
    expect((await failure(async () => saveDeviceModel(t.db, manager.actor, input, tick()))).code).toBe("generation_platform");
    const { id } = await saveDeviceModel(t.db, manager.actor, { ...input, platformId: playstation.id, specs: [{ key: "storage", label: { ar: "التخزين" }, value: { ar: "1TB" } }] }, tick());
    expect(JSON.parse((await one<{ specs: string }>("SELECT specs FROM device_models WHERE id = ?", id)).specs)).toEqual({ storage: { ar: "1TB", label: { ar: "التخزين" } } });
  });
});

// ───────────────────────────────────────────────────────────────── media

describe("media gallery", () => {
  test("catalogue photo keys are checked and added once; order is kept per gallery", async () => {
    const ready = await readyDraft("console");
    expect((await failure(async () => addCatalogPhoto(t.db, content.actor, { productId: ready.productId, artKey: "no-such-product--1" }, tick()))).fields).toEqual({ artKey: "photo_unknown" });
    const keys = await rows<{ art_key: string }>("SELECT DISTINCT art_key FROM media WHERE art_key IS NOT NULL LIMIT 3");
    const added = [];
    for (const { art_key } of keys) added.push(await addCatalogPhoto(t.db, content.actor, { productId: ready.productId, artKey: art_key }, tick()));
    expect(added.filter((entry) => entry.replayed)).toHaveLength(1); // readyDraft already added the first key
    const gallery = await getGallery(t.db, content.actor, ready.productId, "ar");
    const last = gallery.items[gallery.items.length - 1];
    await moveMedia(t.db, content.actor, { id: last.id, productId: ready.productId, direction: "first" }, tick());
    expect((await getGallery(t.db, content.actor, ready.productId, "ar")).items[0].id).toBe(last.id);
    expect((await failure(async () => addCatalogPhoto(t.db, inventory.actor, { productId: ready.productId, artKey: keys[0].art_key }, tick()))).code).toBe("forbidden");
  });
});

describe("uploads and repeated submissions", () => {
  /** A real 12×9 PNG with a text chunk (author metadata the upload service must strip). */
  const pngChunk = (type: string, data: number[]) => {
    const body = Uint8Array.from([...new TextEncoder().encode(type), ...data]);
    const crc = crc32(body) >>> 0;
    const be = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    return [...be(data.length), ...body, ...be(crc)];
  };
  const png = (author: string) =>
    new File(
      [
        Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ...pngChunk("IHDR", [0, 0, 0, 12, 0, 0, 0, 9, 8, 2, 0, 0, 0]),
          ...pngChunk("tEXt", [...new TextEncoder().encode("Author"), 0, ...new TextEncoder().encode(author)]),
          ...pngChunk("IDAT", [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
          ...pngChunk("IEND", []),
        ]),
      ],
      "photo.png",
      { type: "image/png" },
    );

  test("an uploaded picture is stored public without its metadata; the same picture twice is added once", async () => {
    const store = kvBlobStore(t.kv);
    const ready = await readyDraft("console");
    const first = await addUploadedImage(t.db, store, content.actor, { productId: ready.productId, alt: { ar: "صورة مرفوعة" } }, png("Noor"), tick());
    // Same pixels, different metadata: the cleaned bytes hash the same, so it is the same picture.
    const again = await addUploadedImage(t.db, store, content.actor, { productId: ready.productId, alt: { ar: "مرة ثانية" } }, png("Someone else"), tick());
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ mediaId: first.mediaId, replayed: true });
    const file = await one<{ visibility: string; kind: string; storage_key: string; width: number }>("SELECT f.visibility, f.kind, f.storage_key, f.width FROM media m JOIN files f ON f.id = m.file_id WHERE m.id = ?", first.mediaId);
    expect(file).toMatchObject({ visibility: "public", kind: "product_image", width: 12 });
    expect(file.storage_key.startsWith("pub_")).toBe(true);
    const blob = await store.get(file.storage_key);
    expect(new TextDecoder("latin1").decode(blob!.bytes)).not.toContain("Noor");
    // Not an image: refused by content, whatever the name says.
    const fake = new File([new TextEncoder().encode("<svg onload=alert(1)>")], "photo.png", { type: "image/png" });
    expect((await failure(async () => addUploadedImage(t.db, store, content.actor, { productId: ready.productId }, fake, tick()))).code).toBe("upload_type");
    const gallery = await getGallery(t.db, content.actor, ready.productId, "ar");
    expect(gallery.items.filter((item) => item.mediaKey)).toHaveLength(1);
  });

  test("creating the same product twice (a double submit) makes one draft", async () => {
    const category = await one<{ id: string }>("SELECT id FROM categories WHERE is_active = 1 LIMIT 1");
    const input = { kind: "accessory", slug: "test-double-create", name: { ar: "منتج مكرر" }, categoryId: category.id };
    const [a, b] = [await createProduct(t.db, content.actor, input, tick()), await createProduct(t.db, content.actor, input, tick())];
    expect(b).toEqual({ productId: a.productId, replayed: true });
    expect((await rows("SELECT id FROM products WHERE slug = 'test-double-create'")).length).toBe(1);
    // Another employee reusing the address is told it is taken.
    expect((await failure(async () => createProduct(t.db, manager.actor, input, tick()))).code).toBe("slug_taken");
    // In demo mode what staff create is flagged as demo data, like demo orders.
    const demo = await createProduct(t.db, content.actor, { ...input, slug: "test-demo-flag" }, tick(), { demo: true });
    expect((await one<{ is_demo: number }>("SELECT is_demo FROM products WHERE id = ?", demo.productId)).is_demo).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── import and export

describe("CSV import, rollback and export", () => {
  test("preview writes nothing, apply writes the valid rows once, rollback puts them back", async () => {
    const store = kvBlobStore(t.kv);
    const game = await completePublished("game");
    const before = await one<{ brand: string | null; version: number; name: string }>("SELECT brand, version, name FROM products WHERE id = ?", game.id);
    const category = await one<{ slug: string }>("SELECT slug FROM categories WHERE is_active = 1 LIMIT 1");
    const csv = toCsv(
      ["slug", "kind", "category", "brand", "name_ar", "name_en", "sku", "warranty_months"],
      [
        { slug: game.slug, brand: "Imported Brand" },
        { slug: "test-import-new", kind: "accessory", category: category.slug, name_ar: "ملحق مستورد", name_en: "Imported accessory", sku: "TST-IMPORT-1", warranty_months: "6" },
        { slug: "test-import-bad", kind: "spaceship", category: "no-such-category", name_ar: "" },
        { slug: game.slug, brand: "Repeated" },
      ],
    );
    const { jobId } = await previewImport(t.db, store, manager.actor, csv, { fileName: "products.csv" }, tick());
    const preview = await getImportJob(t.db, store, manager.actor, jobId, NOW);
    expect(preview.status).toBe("validated");
    expect(preview.plan?.rows.map((row) => row.action)).toEqual(["update", "create", "error", "error"]);
    expect(preview.plan?.rows[2].errors.map((error) => error.field)).toEqual(expect.arrayContaining(["kind", "category", "name_ar"]));
    expect(preview.plan?.rows[3].errors).toEqual([{ field: "slug", message: "slug_repeated" }]);
    // The dry run changed nothing.
    expect(await one("SELECT brand, version, name FROM products WHERE id = ?", game.id)).toEqual(before);
    expect(await rows("SELECT id FROM products WHERE slug = 'test-import-new'")).toEqual([]);

    const applied = await applyImport(t.db, store, manager.actor, jobId, tick());
    expect(applied.applied).toBe(2);
    expect((await one<{ brand: string }>("SELECT brand FROM products WHERE id = ?", game.id)).brand).toBe("Imported Brand");
    const created = await one<{ id: string; status: string; price: number }>("SELECT p.id, p.status, v.price_iqd AS price FROM products p JOIN variants v ON v.product_id = p.id WHERE p.slug = 'test-import-new'");
    expect(created).toMatchObject({ status: "draft", price: 0 });
    expect((await failure(async () => applyImport(t.db, store, manager.actor, jobId, tick()))).code).toBe("import_state");

    const undone = await rollbackImport(t.db, manager.actor, { jobId, reason: "استيراد خاطئ" }, tick());
    expect(undone).toEqual({ restored: 1, archived: 1, conflicts: [] });
    expect((await one<{ brand: string | null }>("SELECT brand FROM products WHERE id = ?", game.id)).brand).toBe(before.brand);
    expect((await one<{ status: string }>("SELECT status FROM products WHERE id = ?", created.id)).status).toBe("archived");
    expect((await failure(async () => rollbackImport(t.db, manager.actor, { jobId, reason: "مرة ثانية" }, tick()))).code).toBe("import_state");
  });

  test("rollback leaves a product alone when it changed after the import", async () => {
    const store = kvBlobStore(t.kv);
    const game = await completePublished("game");
    const csv = toCsv(["slug", "region"], [{ slug: game.slug, region: "EU" }]);
    const { jobId } = await previewImport(t.db, store, manager.actor, csv, {}, tick());
    await applyImport(t.db, store, manager.actor, jobId, tick());
    await bulkUpdateProducts(t.db, manager.actor, { ids: [game.id], set: { region: "UK" }, reason: "تصحيح يدوي" }, tick());
    const undone = await rollbackImport(t.db, manager.actor, { jobId, reason: "تراجع" }, tick());
    expect(undone.conflicts).toEqual([game.slug]);
    expect((await one<{ region: string }>("SELECT region FROM products WHERE id = ?", game.id)).region).toBe("UK");
  });

  test("a product edited after the preview is skipped at apply", async () => {
    const store = kvBlobStore(t.kv);
    const game = await completePublished("game");
    const { jobId } = await previewImport(t.db, store, manager.actor, toCsv(["slug", "brand"], [{ slug: game.slug, brand: "From File" }]), {}, tick());
    await bulkUpdateProducts(t.db, manager.actor, { ids: [game.id], set: { brand: "Edited Meanwhile" }, reason: "تعديل" }, tick());
    expect((await failure(async () => applyImport(t.db, store, manager.actor, jobId, tick()))).code).toBe("import_empty");
    expect((await one<{ brand: string }>("SELECT brand FROM products WHERE id = ?", game.id)).brand).toBe("Edited Meanwhile");
  });

  test("exports: the variant sheet has cost columns only for cost.read; the product sheet never shows a zero price", async () => {
    const filters = parseProductFilters(new URLSearchParams("kind=game"));
    const withCost = parseCsv(await exportVariantsCsv(t.db, manager.actor, filters, "en", NOW));
    expect(withCost.header).toEqual(expect.arrayContaining(["landed_cost_iqd", "margin_percent"]));
    const without = parseCsv(await exportVariantsCsv(t.db, exporter.actor, filters, "en", NOW));
    expect(without.header).not.toContain("landed_cost_iqd");
    expect(without.header).not.toContain("margin_percent");
    expect(without.rows.length).toBe(withCost.rows.length);
    const sheet = parseCsv(await exportProductsCsv(t.db, exporter.actor, parseProductFilters(new URLSearchParams()), "en", NOW));
    expect(sheet.rows.every((row) => row.cells.price_min_iqd !== "0")).toBe(true);
    expect(sheet.header).not.toContain("landed_cost_iqd");
    // Exports are audited.
    expect((await rows("SELECT id FROM audit_events WHERE action = 'catalog.export' AND actor_id = ?", exporter.id)).length).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────── list

describe("product list", () => {
  test("filters come from the URL; search finds SKUs, barcodes and model numbers", async () => {
    expect(parseProductFilters(new URLSearchParams("status=nope&kind=car&sort=x&page=-3"))).toMatchObject({ status: null, kind: null, sort: "updated", page: 1 });
    const withBarcode = await one<{ product_id: string; barcode: string; sku: string }>("SELECT product_id, barcode, sku FROM variants WHERE barcode IS NOT NULL LIMIT 1");
    for (const q of [withBarcode.barcode, withBarcode.sku.toLowerCase()]) {
      const found = await listProducts(t.db, content.actor, parseProductFilters(new URLSearchParams({ q })), "ar", NOW);
      expect(found.rows.map((row) => row.id), q).toContain(withBarcode.product_id);
    }
    const multi = await listProducts(t.db, content.actor, parseProductFilters(new URLSearchParams("platform=none")), "ar", NOW);
    expect(multi.rows.every((row) => row.platform === null)).toBe(true);
    const incomplete = await listProducts(t.db, content.actor, parseProductFilters(new URLSearchParams("incomplete=1")), "ar", NOW);
    expect(incomplete.rows.every((row) => !row.complete && row.missing.length > 0)).toBe(true);
    // No price is shown as zero: unpriced products carry null prices.
    expect(incomplete.rows.filter((row) => row.unpriced > 0 && row.activeVariants === row.unpriced).every((row) => row.priceMin === null)).toBe(true);
  });

  test("every catalogue change leaves an audit event with the actor", async () => {
    const actions = await rows<{ action: string; actor_id: string }>("SELECT DISTINCT action, actor_id FROM audit_events WHERE action LIKE 'catalog.%'");
    expect(actions.length).toBeGreaterThan(10);
    expect(actions.every((row) => row.actor_id)).toBe(true);
    void auditEvents;
    void media;
    void sql;
    void newId;
  });
});

// ───────────────────────────────────────────────────────────────── adversarial review (2026-11-11)

describe("adversarial review: money, stock and identifiers", () => {
  /** Test barcodes from the GS1 restricted-circulation range (20…29): never printed on a real product. */
  const FREE_A = "2000000000015";
  const FREE_B = "2000000000022";
  const FREE_C = "2000000000039";

  test("a variant added to a live product starts switched off, so it is never sold without a price", async () => {
    const ready = await readyDraft("console");
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "publish" }, tick());
    const sku = `TST-LIVE-${make.next("V")}`;
    const { variantId } = await saveVariant(t.db, content.actor, { productId: ready.productId, version: await version(ready.productId), sku, options: { color: "Red" }, isDefault: "on" }, tick());
    expect(await one("SELECT is_active, price_iqd, is_default FROM variants WHERE id = ?", variantId)).toEqual({ is_active: 0, price_iqd: 0, is_default: 0 });
    // The live product keeps every requirement it met (no unpriced active variant appeared on it).
    expect((await getProductEditor(t.db, manager.actor, ready.productId, "ar", NOW)).completeness.complete).toBe(true);
    // Stock arrives before Pricing has priced it: a shopper still cannot put it in a cart at 0 IQD.
    await t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 5 });
    expect((await failure(async () => addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId, qty: 1 }, clock))).code).toBe("unavailable");
    // Switching it on is refused while it has no price …
    const refused = await failure(async () => setVariantActive(t.db, content.actor, { productId: ready.productId, variantId, version: await version(ready.productId), active: "true", reason: "جاهز للبيع" }, tick()));
    expect(refused).toMatchObject({ code: "regression", detail: "prices" });
    // … and allowed once Pricing (module 03) has set one.
    await t.db.update(variants).set({ priceIqd: 175_000 }).where(eq(variants.id, variantId));
    await setVariantActive(t.db, content.actor, { productId: ready.productId, variantId, version: await version(ready.productId), active: "true", reason: "سُعّر في التسعير" }, tick());
    expect((await one<{ is_active: number }>("SELECT is_active FROM variants WHERE id = ?", variantId)).is_active).toBe(1);
  });

  test("editing a variant of a live product cannot take away what makes it complete (a digital code's region)", async () => {
    const category = await one<{ id: string }>("SELECT id FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
    const platform = await one<{ id: string }>("SELECT id FROM platforms ORDER BY sort LIMIT 1");
    const slug = `test-${make.next("code").toLowerCase()}`;
    const sku = `TST-${make.next("CODE")}`;
    const name = { ar: "بطاقة شحن رقمية" };
    const { productId } = await createProduct(t.db, content.actor, { kind: "digital", slug, name, categoryId: category.id, sku }, tick());
    await updateProductDetails(t.db, content.actor, { productId, version: await version(productId), kind: "digital", name, description: { ar: "رمز يُستخدم على حساب أمريكي" }, categoryId: category.id, licenseType: "wallet_topup", mediaFormat: "digital" }, tick());
    const variant = await one<{ id: string }>("SELECT id FROM variants WHERE product_id = ?", productId);
    // The region is recorded on the variant only (as the seeded gift cards do).
    await saveVariant(t.db, content.actor, { productId, version: await version(productId), variantId: variant.id, sku, options: { region: "US" } }, tick());
    await saveCompatibilityRule(t.db, content.actor, { productId, subject: "product", target: `platform:${platform.id}`, status: "partial", note: { ar: "حساب أمريكي فقط" } }, tick());
    await t.db.update(variants).set({ priceIqd: 25_000 }).where(eq(variants.id, variant.id));
    const photo = await one<{ art_key: string }>("SELECT art_key FROM media WHERE art_key IS NOT NULL LIMIT 1");
    await addCatalogPhoto(t.db, content.actor, { productId, artKey: photo.art_key }, tick());
    await changeProductStatus(t.db, manager.actor, { productId, version: await version(productId), action: "publish" }, tick());
    const refused = await failure(async () => saveVariant(t.db, content.actor, { productId, version: await version(productId), variantId: variant.id, sku, options: { region: "" } }, tick()));
    expect(refused).toMatchObject({ code: "regression", detail: "region" });
    expect(JSON.parse((await one<{ options: string }>("SELECT options FROM variants WHERE id = ?", variant.id)).options)).toEqual({ region: "US" });
  });

  test("bundle components go only on a bundle's own variants, never on a variant that sells its own stock", async () => {
    const component = await one<{ sku: string }>(
      "SELECT v.sku FROM variants v JOIN products p ON p.id = v.product_id WHERE p.kind = 'controller' AND v.is_active = 1 AND NOT EXISTS (SELECT 1 FROM bundle_items b WHERE b.bundle_variant_id = v.id) LIMIT 1",
    );
    // A published console with 3 units of its own: as a "bundle" the stock core would ignore them and sell controllers.
    const stocked = await make.product({ kind: "console", stock: 3 });
    const refused = await failure(async () => setBundleComponent(t.db, content.actor, { productId: stocked.productId, bundleVariantId: stocked.variantId, component: component.sku, qty: 1 }, tick()));
    expect(refused.code).toBe("bundle_kind");
    expect(await rows("SELECT bundle_variant_id FROM bundle_items WHERE bundle_variant_id = ?", stocked.variantId)).toEqual([]);
    expect((await getAvailability(t.db, [stocked.variantId])).get(stocked.variantId)?.available).toBe(3);
    // A bundle product whose variant holds units of its own (received by mistake) gets no components either.
    const odd = await make.product({ kind: "bundle", stock: 2 });
    expect((await failure(async () => setBundleComponent(t.db, content.actor, { productId: odd.productId, bundleVariantId: odd.variantId, component: component.sku, qty: 1 }, tick()))).code).toBe("bundle_stocked");
    expect((await getAvailability(t.db, [odd.variantId])).get(odd.variantId)?.available).toBe(2);
  });

  test("a bundle with components keeps its kind (in the editor and in a CSV file): its variants stay bundles for the stock core", async () => {
    const set = await one<{ id: string; slug: string; version: number }>("SELECT p.id, p.slug, p.version FROM products p WHERE p.kind = 'bundle' AND EXISTS (SELECT 1 FROM variants v JOIN bundle_items b ON b.bundle_variant_id = v.id WHERE v.product_id = p.id) LIMIT 1");
    const editor = await getProductEditor(t.db, content.actor, set.id, "ar", NOW);
    const refused = await failure(async () =>
      updateProductDetails(t.db, content.actor, { productId: set.id, version: editor.product.version, kind: "console", name: editor.product.name, description: editor.product.description, categoryId: editor.product.categoryId, platformId: editor.product.platformId ?? "" }, tick()),
    );
    expect(refused.fields).toEqual({ kind: "kind_has_components" });
    const store = kvBlobStore(t.kv);
    const { jobId } = await previewImport(t.db, store, manager.actor, toCsv(["slug", "kind"], [{ slug: set.slug, kind: "console" }]), {}, tick());
    expect((await getImportJob(t.db, store, manager.actor, jobId, NOW)).errors.map((problem) => [problem.field, problem.message])).toEqual([["kind", "kind_has_components"]]);
    expect((await one<{ kind: string }>("SELECT kind FROM products WHERE id = ?", set.id)).kind).toBe("bundle");
  });

  test("a barcode belongs to one variant: another variant, an import or a restore cannot take it", async () => {
    const main = await one<{ barcode: string }>("SELECT barcode FROM variants WHERE barcode IS NOT NULL ORDER BY sku LIMIT 1");
    const extra = await one<{ code: string }>(
      "SELECT c.value AS code FROM products p, json_each(p.attributes, '$.variantBarcodes') s, json_each(s.value) c WHERE json_type(p.attributes, '$.variantBarcodes') = 'object' AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.barcode = c.value) LIMIT 1",
    );
    const ready = await readyDraft("console");
    const save = async (barcode: string, extraBarcodes = "") =>
      saveVariant(t.db, content.actor, { productId: ready.productId, version: await version(ready.productId), variantId: ready.variantId, sku: ready.sku, barcode, extraBarcodes }, tick());
    expect((await failure(async () => save(main.barcode))).fields).toEqual({ barcode: "barcode_taken" });
    // An extra code the research recorded for another SKU counts as taken too.
    expect((await failure(async () => save(extra.code))).fields).toEqual({ barcode: "barcode_taken" });
    expect((await failure(async () => save(FREE_C, main.barcode))).fields).toEqual({ extraBarcodes: "barcode_taken" });
    expect((await one<{ barcode: string | null }>("SELECT barcode FROM variants WHERE id = ?", ready.variantId)).barcode).toBeNull();

    // A new product from a CSV file with a barcode that is already on a shelf.
    const store = kvBlobStore(t.kv);
    const category = await one<{ slug: string }>("SELECT slug FROM categories WHERE is_active = 1 LIMIT 1");
    const csv = toCsv(["slug", "kind", "category", "name_ar", "sku", "barcode"], [{ slug: `test-${make.next("imp").toLowerCase()}`, kind: "accessory", category: category.slug, name_ar: "ملحق مستورد", sku: `TST-${make.next("IMP")}`, barcode: main.barcode }]);
    const { jobId } = await previewImport(t.db, store, manager.actor, csv, {}, tick());
    const job = await getImportJob(t.db, store, manager.actor, jobId, NOW);
    expect(job.status).toBe("failed");
    expect(job.errors.map((problem) => [problem.field, problem.message])).toEqual([["barcode", "barcode_taken"]]);

    // Restore: product 1 had code A, moved to B; product 2 took A since. Restoring product 1 leaves A where it is now.
    await save(FREE_A);
    const withA = await version(ready.productId);
    const current = await getProductEditor(t.db, content.actor, ready.productId, "ar", NOW);
    await updateProductDetails(t.db, content.actor, { productId: ready.productId, version: current.product.version, kind: "console", name: { ar: "اسم بعد تغيير الباركود" }, description: current.product.description, categoryId: current.product.categoryId, warrantyMonths: "12" }, tick());
    await save(FREE_B);
    const other = await readyDraft("console");
    await saveVariant(t.db, content.actor, { productId: other.productId, version: await version(other.productId), variantId: other.variantId, sku: other.sku, barcode: FREE_A }, tick());
    const result = await restoreVersion(t.db, manager.actor, { productId: ready.productId, version: withA, expectedVersion: await version(ready.productId), reason: "الاسم السابق" }, tick());
    expect(result.restored).toContain("name");
    expect((await rows<{ id: string }>("SELECT id FROM variants WHERE barcode = ?", FREE_A)).map((row) => row.id)).toEqual([other.variantId]);
    expect((await one<{ barcode: string }>("SELECT barcode FROM variants WHERE id = ?", ready.variantId)).barcode).toBe(FREE_B);
  });

  test("switching off a category that has products in the store needs a reason", async () => {
    const ready = await readyDraft("console");
    const slug = `test-live-${make.next("c").toLowerCase()}`;
    const name = { ar: "تصنيف فيه منتج معروض" };
    const own = await saveCategory(t.db, manager.actor, { slug, name, isActive: "on" }, tick());
    await bulkUpdateProducts(t.db, manager.actor, { ids: [ready.productId], set: { categoryId: own.id }, reason: "نقل إلى تصنيف جديد" }, tick());
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "publish" }, tick());
    const off = { id: own.id, slug, name, isActive: "" };
    expect((await failure(async () => saveCategory(t.db, manager.actor, off, tick()))).fields).toEqual({ reason: "reason_required" });
    expect((await one<{ is_active: number }>("SELECT is_active FROM categories WHERE id = ?", own.id)).is_active).toBe(1);
    await saveCategory(t.db, manager.actor, { ...off, reason: "تصنيف قديم يُدمج" }, tick());
    const audit = await one<{ reason: string }>("SELECT reason FROM audit_events WHERE entity_id = ? AND action = 'catalog.category.update' ORDER BY at DESC LIMIT 1", own.id);
    expect(audit.reason).toBe("تصنيف قديم يُدمج");
  });

  test("bulk-moving live products into a switched-off category is refused for each of them", async () => {
    const off = await saveCategory(t.db, manager.actor, { slug: `test-off-${make.next("c").toLowerCase()}`, name: { ar: "تصنيف موقوف" }, isActive: "" }, tick());
    const ready = await readyDraft("console");
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "publish" }, tick());
    const before = await one<{ category_id: string }>("SELECT category_id FROM products WHERE id = ?", ready.productId);
    const outcome = await bulkUpdateProducts(t.db, manager.actor, { ids: [ready.productId], set: { categoryId: off.id }, reason: "نقل جماعي" }, tick());
    expect(outcome).toEqual({ updated: [], skipped: [{ id: ready.productId, reason: "regression" }] });
    expect((await one<{ category_id: string }>("SELECT category_id FROM products WHERE id = ?", ready.productId)).category_id).toBe(before.category_id);
    expect((await getProductEditor(t.db, manager.actor, ready.productId, "ar", NOW)).completeness.complete).toBe(true);
  });

  test("two tabs removing a live product's last two pictures at the same moment leave it one", async () => {
    const store = kvBlobStore(t.kv);
    const ready = await readyDraft("console");
    const first = await one<{ art_key: string }>("SELECT art_key FROM media WHERE owner_type = 'product' AND owner_id = ?", ready.productId);
    const second = await one<{ art_key: string }>("SELECT art_key FROM media WHERE art_key IS NOT NULL AND art_key <> ? LIMIT 1", first.art_key);
    await addCatalogPhoto(t.db, content.actor, { productId: ready.productId, artKey: second.art_key }, tick());
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "publish" }, tick());
    const own = (await getGallery(t.db, content.actor, ready.productId, "ar")).items.filter((item) => item.ownerType === "product");
    expect(own).toHaveLength(2);
    const results = await Promise.allSettled(own.map((item) => removeMedia(t.db, store, content.actor, { id: item.id, productId: ready.productId, reason: "صورة مكررة" }, tick())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await getProductEditor(t.db, manager.actor, ready.productId, "ar", NOW)).completeness.complete).toBe(true);
  });

  test("two tabs removing a live product's last two compatibility rules at the same moment leave it one", async () => {
    const ready = await readyDraft("accessory");
    const models = await rows<{ id: string }>("SELECT id FROM device_models ORDER BY sort, id LIMIT 2");
    for (const model of models) await saveCompatibilityRule(t.db, content.actor, { productId: ready.productId, subject: "product", target: `device_model:${model.id}`, status: "partial", note: { ar: "يعمل بعد تحديث النظام" } }, tick());
    await changeProductStatus(t.db, manager.actor, { productId: ready.productId, version: await version(ready.productId), action: "publish" }, tick());
    const rules = await rows<{ id: string }>("SELECT id FROM compatibility_rules WHERE subject_type = 'product' AND subject_id = ?", ready.productId);
    expect(rules).toHaveLength(2);
    const results = await Promise.allSettled(rules.map(({ id }) => deleteCompatibilityRule(t.db, content.actor, { id, productId: ready.productId, reason: "قاعدة مكررة" }, tick())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await getProductEditor(t.db, manager.actor, ready.productId, "ar", NOW)).completeness.complete).toBe(true);
  });

  test("two tabs removing a live bundle's last two components at the same moment leave it one", async () => {
    const category = await one<{ id: string }>("SELECT id FROM categories WHERE is_active = 1 ORDER BY sort LIMIT 1");
    const sku = `TST-${make.next("SET")}`;
    const name = { ar: "حزمة جهاز ولعبة" };
    const { productId } = await createProduct(t.db, content.actor, { kind: "bundle", slug: `test-${make.next("set").toLowerCase()}`, name, categoryId: category.id, sku }, tick());
    await updateProductDetails(t.db, content.actor, { productId, version: await version(productId), kind: "bundle", name, description: { ar: "جهاز مع لعبة" }, categoryId: category.id }, tick());
    const variant = await one<{ id: string }>("SELECT id FROM variants WHERE product_id = ?", productId);
    const parts = await rows<{ sku: string }>(
      "SELECT v.sku FROM variants v JOIN products p ON p.id = v.product_id WHERE p.kind IN ('controller', 'game') AND v.is_active = 1 AND NOT EXISTS (SELECT 1 FROM bundle_items b WHERE b.bundle_variant_id = v.id) ORDER BY v.sku LIMIT 2",
    );
    for (const part of parts) await setBundleComponent(t.db, content.actor, { productId, bundleVariantId: variant.id, component: part.sku, qty: 1 }, tick());
    await t.db.update(variants).set({ priceIqd: 650_000 }).where(eq(variants.id, variant.id));
    const photo = await one<{ art_key: string }>("SELECT art_key FROM media WHERE art_key IS NOT NULL LIMIT 1");
    await addCatalogPhoto(t.db, content.actor, { productId, artKey: photo.art_key }, tick());
    await changeProductStatus(t.db, manager.actor, { productId, version: await version(productId), action: "publish" }, tick());
    const components = await rows<{ component_variant_id: string }>("SELECT component_variant_id FROM bundle_items WHERE bundle_variant_id = ?", variant.id);
    expect(components).toHaveLength(2);
    const results = await Promise.allSettled(
      components.map((row) => removeBundleComponent(t.db, content.actor, { productId, bundleVariantId: variant.id, componentVariantId: row.component_variant_id, reason: "مكوّن خاطئ" }, tick())),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await getProductEditor(t.db, manager.actor, productId, "ar", NOW)).completeness.complete).toBe(true);
  });

  test("exports defuse every cell a spreadsheet would run as a formula, a leading minus included", async () => {
    const payload = "-2+3+cmd|' /C calc'!A0";
    const ready = await readyDraft("console");
    await bulkUpdateProducts(t.db, manager.actor, { ids: [ready.productId], set: { brand: payload }, reason: "اختبار التصدير" }, tick());
    const slug = (await one<{ slug: string }>("SELECT slug FROM products WHERE id = ?", ready.productId)).slug;
    const sheet = await exportProductsCsv(t.db, manager.actor, parseProductFilters(new URLSearchParams({ q: slug })), "en", NOW);
    expect(sheet).toContain(`'${payload}`);
    expect(sheet.split(/\r\n/).some((line) => line.split(",").includes(payload))).toBe(false);
    // The guard reads back as the value (export → edit → import changes nothing) and a negative number stays a number.
    expect(parseCsv(sheet).rows.find((row) => row.cells.slug === slug)?.cells.brand).toBe(payload);
    const numbers = toCsv(["margin_percent"], [{ margin_percent: "-12.5" }]);
    expect(numbers).toContain("\r\n-12.5\r\n");
  });
});

describe("adversarial review 2026-11-11 (2): ids of another product (IDOR guard)", () => {
  test("a picture, variant, rule or link of product A cannot be changed through product B's page", async () => {
    const store = kvBlobStore(t.kv);
    const a = await readyDraft("accessory");
    const b = await readyDraft("accessory");
    const picture = await one<{ id: string }>("SELECT id FROM media WHERE owner_type = 'product' AND owner_id = ?", a.productId);
    const model = await one<{ id: string }>("SELECT id FROM device_models ORDER BY sort, id LIMIT 1");
    const { id: ruleId } = await saveCompatibilityRule(t.db, content.actor, { productId: a.productId, subject: "product", target: `device_model:${model.id}`, status: "partial", note: { ar: "يعمل بعد التحديث" } }, tick());
    const related = await one<{ slug: string; id: string }>("SELECT slug, id FROM products WHERE status = 'published' AND id NOT IN (?, ?) LIMIT 1", a.productId, b.productId);
    await addRelation(t.db, manager.actor, { productId: a.productId, related: related.slug, kind: "accessory" }, tick());
    const vB = await version(b.productId);

    const notFound = async (run: () => Promise<unknown>) => expect((await failure(run)).code).toBe("not_found");
    await notFound(async () => removeMedia(t.db, store, content.actor, { id: picture.id, productId: b.productId, reason: "ليست لهذا المنتج" }, tick()));
    await notFound(async () => updateMedia(t.db, content.actor, { id: picture.id, productId: b.productId, alt: { ar: "بديل" } }, tick()));
    await notFound(async () => moveMedia(t.db, content.actor, { id: picture.id, productId: b.productId, direction: "first" }, tick()));
    await notFound(async () => setVariantActive(t.db, manager.actor, { productId: b.productId, variantId: a.variantId, version: vB, active: "false", reason: "ليس لهذا المنتج" }, tick()));
    await notFound(async () => saveVariant(t.db, manager.actor, { productId: b.productId, version: vB, variantId: a.variantId, sku: a.sku }, tick()));
    await notFound(async () => deleteCompatibilityRule(t.db, manager.actor, { id: ruleId, productId: b.productId, reason: "ليست لهذا المنتج" }, tick()));
    await notFound(async () => updateRelation(t.db, manager.actor, { productId: b.productId, relatedProductId: related.id, kind: "accessory", pinned: "on" }, tick()));
    expect(await removeRelation(t.db, manager.actor, { productId: b.productId, relatedProductId: related.id, kind: "accessory" }, tick())).toEqual({ removed: false });

    // Product A is as it was.
    expect(await rows("SELECT id FROM media WHERE id = ?", picture.id)).toHaveLength(1);
    expect(await rows("SELECT id FROM compatibility_rules WHERE id = ?", ruleId)).toHaveLength(1);
    expect((await one<{ is_active: number }>("SELECT is_active FROM variants WHERE id = ?", a.variantId)).is_active).toBe(1);
    expect(await rows("SELECT pinned FROM product_relations WHERE product_id = ? AND related_product_id = ?", a.productId, related.id)).toEqual([{ pinned: 0 }]);
    expect(await version(b.productId)).toBe(vB);
  });
});
