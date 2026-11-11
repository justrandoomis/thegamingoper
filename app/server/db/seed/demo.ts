/**
 * DEMO seed (ARCHITECTURE §11): the researched product catalogue plus demo money, stock and content,
 * so the store can be explored before real data exists.
 *
 *   await seedDemo(db, now)                        // reads catalog/products from disk (Node: scripts and tests)
 *   await seedDemo(db, now, { catalog })           // with a catalogue already loaded (loadDemoCatalog())
 *   await seedDemo(db, now, { overwrite: true })   // also restore the seed's descriptive content
 *
 * What it writes (definitions in ./demo/*):
 *   · every product of catalog/products/*.json (./demo/import.ts says where each fact goes): products,
 *     variants, official photos (media), compatibility rules exactly as researched, product relations,
 *     the search index in Arabic, English and Kurdish — plus one store set (./demo/sets.ts);
 *   · platforms, device generations and every device model the catalogue names (./demo/devices.ts),
 *     the category tree (./demo/categories.ts);
 *   · demo prices, previous prices on a handful of deals, costs (variant costs + FIFO layers), stock
 *     with opening movements and serials (./demo/pricing.ts);
 *   · 6 used units and the trade-in price guides (./demo/used.ts), a DEMO USD rate, 2 coupons,
 *     8 knowledge articles, 2 troubleshooting trees, search synonyms.
 * What it never writes: reviews, ratings, customers, orders, employees or any account.
 *
 * Rules it keeps:
 *   · Every row whose table has an `is_demo` column is flagged. Stock movements and serials have no
 *     such column: they say "DEMO" in their reason / notes and carry "demo_seed" (ref_type /
 *     source_ref). Variant prices, costs, stock levels and cost layers have no column for it either
 *     (cost layers are `source = 'opening'`); every one of them belongs to a product with is_demo = 1.
 *   · Product photos are the makers' official images (`is_illustration = 0`); a used unit shows the
 *     model's official photo flagged as an illustration (`is_illustration = 1`).
 *   · A product whose release date is still ahead is a pre-order (`preorder_release_at`) with no stock;
 *     so is a variant with a later release date of its own (no stock; attributes.variantReleaseDates).
 *     Discontinued products stay published and their research status says so (attributes.catalogue).
 *   · products.warranty_months stays empty: it is the store's warranty, not the maker's (./demo/import.ts).
 *   · Idempotent: ids are derived from slugs and SKUs, every statement is "insert if missing", and
 *     the whole seed is ONE batch — it is applied completely or not at all.
 *   · `overwrite` refreshes names, texts, specs, pictures, relations, compatibility, synonyms,
 *     articles and the search index. It never touches prices, costs, stock, serials, a used unit's
 *     status, coupons, the exchange rate or trade-in guides: those are money and stock, and changes
 *     to them belong to the audited admin flows. It does not delete either: a picture, rule or
 *     relation removed from the catalogue stays until `npm run db:reset` (or the admin) removes it.
 *
 * Needs seedReference() to have run (stock location, inspection templates). The catalogue is read by
 * Node only (./demo/catalog/load.ts) — this module itself uses no Node API, and nothing the Worker
 * or the client bundles imports it.
 */
import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { BatchStatement, Db } from "../drizzle.server";
import {
  bundleItems,
  categories,
  compatibilityRules,
  costLayers,
  coupons,
  deviceGenerations,
  deviceModels,
  fxRates,
  knowledgeArticles,
  media,
  platforms,
  productRelations,
  products,
  searchSynonyms,
  serials,
  stockLevels,
  stockMovements,
  tradeInPriceGuides,
  troubleshootingTrees,
  usedUnits,
  variantCosts,
  variants,
  type NewBundleItem,
  type NewCategory,
  type NewCompatibilityRule,
  type NewCostLayer,
  type NewCoupon,
  type NewDeviceGeneration,
  type NewDeviceModel,
  type NewFxRate,
  type NewKnowledgeArticle,
  type NewMediaItem,
  type NewPlatform,
  type NewProduct,
  type NewProductRelation,
  type NewSearchSynonym,
  type NewSerial,
  type NewStockLevel,
  type NewStockMovement,
  type NewTradeInPriceGuide,
  type NewTroubleshootingTreeRow,
  type NewUsedUnit,
  type NewVariant,
  type NewVariantCost,
} from "../schema";
import { normalizeSearchText, searchIndexStatements } from "../search.server";
import { batchSql, chunkRows, runBatch } from "../tx.server";
import { localizeBlocks } from "./demo/blocks";
import { loadDemoCatalog } from "./demo/catalog/load";
import type { DemoCatalog } from "./demo/catalog/types";
import { DEMO_CATEGORIES } from "./demo/categories";
import { DEMO_COUPONS, DEMO_FX_RATE } from "./demo/commerce";
import { DEMO_DEVICE_MODELS, DEMO_GENERATIONS, DEMO_PLATFORMS } from "./demo/devices";
import { DEMO_ACTOR_ID, DEMO_REF_TYPE, demoId } from "./demo/ids";
import { buildDemoData, type DemoData, type DemoImage, type DemoProduct, type DemoVariant } from "./demo/import";
import { DEMO_ARTICLES } from "./demo/knowledge";
import { BAGHDAD_OFFSET_MS, PRICE_STEP_IQD, defaultVariantOf, demoStock, isPreorderAt, type DemoStock } from "./demo/pricing";
import { DEMO_SYNONYM_GROUPS, productSearchDocs } from "./demo/search";
import { SEED_LOCALES, type T3 } from "./demo/text";
import { DEMO_TREES } from "./demo/trees";
import {
  DEMO_USED_UNITS,
  TRADE_IN_GRADE_MULTIPLIERS,
  USED_PHOTO_NOTE,
  USED_UNIT_PHOTOS,
  acquisitionCostIqd,
  buysDevice,
  tradeInBaseIqd,
  tradeInDeductions,
  usedPriceIqd,
  type UsedUnitSeed,
} from "./demo/used";
import { DEFAULT_LOCATION_ID } from "./reference";

export { demoId } from "./demo/ids";
export { loadDemoCatalog } from "./demo/catalog/load";
export { buildDemoData } from "./demo/import";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const OPENING_REASON = "رصيد افتتاحي — بيانات تجريبية (DEMO)";
const DEMO_SERIAL_NOTE = "وحدة تجريبية (DEMO) — رقم تسلسلي غير حقيقي";
const DEMO_USED_SERIAL_NOTE = "وحدة مستعملة تجريبية (DEMO) — رقم تسلسلي غير حقيقي";

/** Fake serial numbers of the new units on hand: "DEMO-PS5-SLIM-DISC-1TB-0001"… */
export const demoSerialsOf = (sku: string, count: number): string[] => Array.from({ length: count }, (_, index) => `DEMO-${sku}-${String(index + 1).padStart(4, "0")}`);

// ───────────────────────────────────────────────────────────────── derived demo data

export type DemoTradeInGuide = { deviceModel: string; baseIqd: number; deductions: Record<string, number> };

/** Trade-in guides of the device models the store buys: a share of the model's new (demo) price. */
export function demoTradeInGuides(data: DemoData): DemoTradeInGuide[] {
  return data.deviceModels.filter(buysDevice).map((model) => {
    const product = data.products.find((entry) => entry.slug === model.product);
    if (!product?.source) throw new Error(`Demo seed: device model "${model.slug}" has no product to price it by`);
    const sku = model.variant ?? defaultVariantOf(product.source).sku;
    const reference = data.variantsBySku.get(sku);
    if (!reference) throw new Error(`Demo seed: unknown SKU ${sku}`);
    return { deviceModel: model.slug, baseIqd: tradeInBaseIqd(reference.variant.priceIqd), deductions: tradeInDeductions(model, product.source) };
  });
}

export type DemoUsedUnit = UsedUnitSeed & { priceIqd: number; acquisitionCostIqd: number; deviceModel: string; images: DemoImage[] };

/** The used units with their money (from the demo prices and the guides) and their pictures. */
export function demoUsedUnits(data: DemoData, guides: readonly DemoTradeInGuide[] = demoTradeInGuides(data)): DemoUsedUnit[] {
  return DEMO_USED_UNITS.map((unit) => {
    const found = data.variantsBySku.get(unit.sku);
    if (!found) throw new Error(`Demo seed: used unit "${unit.slug}" names unknown SKU ${unit.sku}`);
    const { product, variant } = found;
    const guide = guides.find((entry) => entry.deviceModel === product.deviceModel);
    if (!guide || !product.deviceModel) throw new Error(`Demo seed: used unit "${unit.slug}" is not a device the store buys`);
    const shots = (variant.images.length > 0 ? variant.images : product.images).slice(0, USED_UNIT_PHOTOS);
    return {
      ...unit,
      deviceModel: product.deviceModel,
      priceIqd: usedPriceIqd(variant.priceIqd, unit.grade),
      acquisitionCostIqd: acquisitionCostIqd(guide.baseIqd, unit.grade, guide.deductions, unit.missing),
      images: shots.map((image) => ({ key: image.key, alt: withNote(image.alt, USED_PHOTO_NOTE) })),
    };
  });
}

const withNote = (alt: T3, note: T3): T3 => ({ ar: `${alt.ar} — ${note.ar}`, en: `${alt.en} — ${note.en}`, ckb: `${alt.ckb} — ${note.ckb}` });

/** Units on hand of a variant (a store set has none of its own: its components do). */
const stockOf = (product: DemoProduct, variant: DemoVariant, now: number): DemoStock =>
  product.source && variant.source ? demoStock(product.source, variant.source, now) : { onHand: 0, reorderPoint: null };

// ───────────────────────────────────────────────────────────────── consistency of the definitions

/**
 * Checks the seed definitions against each other and against the catalogue before anything is
 * written, so a typo or a research edit the seed cannot place fails with its own message instead of
 * a foreign-key error in the middle of a batch.
 */
export function assertDemoDataConsistent(catalog: DemoCatalog = loadDemoCatalog(), data: DemoData = buildDemoData(catalog)): void {
  const problems: string[] = [];
  const categorySlugs = new Set<string>();
  for (const category of DEMO_CATEGORIES) {
    if (category.parent && !categorySlugs.has(category.parent)) problems.push(`category "${category.slug}" comes before its parent "${category.parent}"`);
    if (categorySlugs.has(category.slug)) problems.push(`duplicate category "${category.slug}"`);
    categorySlugs.add(category.slug);
  }
  for (const product of data.products) {
    if (product.variants.length === 0) problems.push(`product "${product.slug}" has no variant`);
    if (product.images.length === 0) problems.push(`product "${product.slug}" has no picture`);
    for (const variant of product.variants) {
      for (const price of [variant.priceIqd, variant.compareAtIqd]) {
        if (price !== null && (!Number.isSafeInteger(price) || price <= 0 || price % PRICE_STEP_IQD !== 0)) problems.push(`${variant.sku}: price ${price} is not a positive multiple of ${PRICE_STEP_IQD}`);
      }
      if (variant.compareAtIqd !== null && variant.compareAtIqd <= variant.priceIqd) problems.push(`${variant.sku}: the previous price must be above the price`);
      if (variant.cost && (variant.cost.landedCostIqd <= 0 || variant.cost.landedCostIqd >= variant.priceIqd)) problems.push(`${variant.sku}: cost ${variant.cost.landedCostIqd} is not below the price`);
      for (const component of variant.bundle ?? []) {
        const part = data.variantsBySku.get(component.sku);
        if (!part || part.variant.bundle || part.product.kind === "digital") problems.push(`${variant.sku}: set component ${component.sku} must be a stocked item`);
      }
    }
  }
  for (const article of DEMO_ARTICLES) {
    if (article.deviceModel && !DEMO_DEVICE_MODELS.some((model) => model.slug === article.deviceModel)) problems.push(`article "${article.slug}" names unknown device "${article.deviceModel}"`);
    for (const block of article.blocks) if (block.type === "art" && !catalog.photoKeys.has(block.name)) problems.push(`article "${article.slug}" shows unknown photo "${block.name}"`);
  }
  const articleSlugs = new Set(DEMO_ARTICLES.map((article) => article.slug));
  for (const { symptomKey, tree } of DEMO_TREES) {
    const ids = new Set(tree.nodes.map((node) => node.id));
    if (!ids.has(tree.start)) problems.push(`tree "${symptomKey}" starts at an unknown node`);
    for (const node of tree.nodes) {
      for (const choice of node.options ?? []) if (!ids.has(choice.next)) problems.push(`tree "${symptomKey}": node "${node.id}" points at unknown node "${choice.next}"`);
      if (node.kind === "outcome" ? !node.outcome || (node.options?.length ?? 0) > 0 : (node.options?.length ?? 0) === 0) problems.push(`tree "${symptomKey}": node "${node.id}" is malformed`);
      if (node.outcome?.articleSlug && !articleSlugs.has(node.outcome.articleSlug)) problems.push(`tree "${symptomKey}": unknown article "${node.outcome.articleSlug}"`);
    }
  }
  try {
    for (const unit of demoUsedUnits(data)) {
      const found = data.variantsBySku.get(unit.sku);
      if (!found?.variant.trackSerials) problems.push(`used unit "${unit.slug}" must be an instance of a serial-tracked variant`);
      if (unit.priceIqd % PRICE_STEP_IQD !== 0 || unit.acquisitionCostIqd <= 0 || unit.acquisitionCostIqd >= unit.priceIqd) problems.push(`used unit "${unit.slug}" has an invalid price or cost`);
      if (found && unit.priceIqd >= found.variant.priceIqd) problems.push(`used unit "${unit.slug}" is not cheaper than new`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0) throw new Error(`Demo seed: ${problems.join("; ")}`);
}

// ───────────────────────────────────────────────────────────────── statement plan

type PutOptions = {
  /** Primary-key column(s): the conflict target. */
  target: SQLiteColumn | SQLiteColumn[];
  /** "content" rows are refreshed when `overwrite` is on; "state" rows are only ever inserted. */
  mode: "content" | "state";
  /** Columns (schema keys) that `overwrite` leaves alone. */
  keep?: readonly string[];
  /** Fewer rows per statement than the bound-parameter limit allows (rows with large JSON). */
  rowsPerStatement?: number;
  /**
   * Leaf rows with a second unique key (an edge, a code, a slug): when a row with ANOTHER id
   * already holds that key, skip ours instead of failing the whole seed.
   */
  skipOnAnyConflict?: boolean;
};

/** `Plan.tables` entry of a row-count probe (a SELECT, not a write). */
const PROBE = "";

class Plan {
  readonly statements: BatchStatement[] = [];
  /** Table of each statement, parallel to `statements` (PROBE for the row counts of `measure`). */
  readonly tables: string[] = [];
  /** Rows the seed defines, per table. */
  readonly rows: Record<string, number> = {};
  /** Tables whose changes are measured by counting rows before and after their statements: index of each count. */
  readonly measured = new Map<string, { before: number; after: number }>();

  constructor(
    readonly db: Db,
    readonly overwrite: boolean,
  ) {}

  add(table: string, statement: BatchStatement, rows: number): void {
    this.statements.push(statement);
    this.tables.push(table);
    this.rows[table] = (this.rows[table] ?? 0) + rows;
  }

  /**
   * Counts `table` before and after the statements `write` adds, in the same batch. For the FTS5
   * search index: D1 also reports the rows an FTS5 insert writes to the index's shadow tables as
   * changes, so `meta.changes` cannot say how many index rows were added (1 insert ≈ 9-12 changes).
   */
  measure(table: string, write: () => void): void {
    const count = () => {
      this.statements.push(batchSql(this.db, sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`));
      this.tables.push(PROBE);
      return this.statements.length - 1;
    };
    const before = count();
    write();
    this.measured.set(table, { before, after: count() });
  }

  put<T extends SQLiteTable>(table: T, rows: T["$inferInsert"][], options: PutOptions): void {
    if (rows.length === 0) return;
    const name = getTableName(table);
    const targets = Array.isArray(options.target) ? options.target : [options.target];
    const update: Record<string, SQL> = {};
    if (this.overwrite && options.mode === "content") {
      for (const [key, column] of Object.entries(getTableColumns(table) as Record<string, SQLiteColumn>)) {
        if (targets.includes(column) || options.keep?.includes(key)) continue;
        update[key] = sql.raw(`excluded."${column.name}"`);
      }
    }
    const refresh = Object.keys(update).length > 0;
    for (const chunk of chunkRows(table, rows)) {
      const size = Math.max(1, Math.min(options.rowsPerStatement ?? chunk.length, chunk.length));
      for (let start = 0; start < chunk.length; start += size) {
        const part = chunk.slice(start, start + size);
        const insert = this.db.insert(table).values(part);
        const statement = refresh
          ? insert.onConflictDoUpdate({ target: options.target, set: update as never })
          : options.skipOnAnyConflict
            ? insert.onConflictDoNothing()
            : insert.onConflictDoNothing({ target: options.target });
        this.add(name, statement, part.length);
      }
    }
  }
}

/** Newest release first (pre-orders lead), undated last: the order "new arrivals" lists them in. */
function listingOrder(products: readonly DemoProduct[]): DemoProduct[] {
  const key = (product: DemoProduct) => product.source?.releaseDate ?? "";
  return [...products].sort((a, b) => (key(a) === key(b) ? a.slug.localeCompare(b.slug) : key(a) < key(b) ? 1 : -1));
}

function buildPlan(db: Db, now: number, overwrite: boolean, catalog: DemoCatalog): Plan {
  const data = buildDemoData(catalog);
  assertDemoDataConsistent(catalog, data);
  const plan = new Plan(db, overwrite);

  // ── device knowledge graph and categories ──────────────────────────────────
  plan.put(
    platforms,
    DEMO_PLATFORMS.map((platform, index): NewPlatform => ({ id: demoId.platform(platform.slug), slug: platform.slug, name: platform.name, accent: platform.accent, sort: (index + 1) * 10, artKey: platform.artKey, isActive: platform.isActive })),
    { target: platforms.id, mode: "content" },
  );
  plan.put(
    deviceGenerations,
    DEMO_GENERATIONS.map((generation, index): NewDeviceGeneration => ({ id: demoId.generation(generation.slug), platformId: demoId.platform(generation.platform), slug: generation.slug, name: generation.name, sort: (index + 1) * 10 })),
    { target: deviceGenerations.id, mode: "content" },
  );
  plan.put(
    deviceModels,
    data.deviceModels.map(
      (model, index): NewDeviceModel => ({
        id: demoId.deviceModel(model.slug),
        platformId: demoId.platform(model.platform),
        generationId: demoId.generation(model.generation),
        slug: model.slug,
        name: model.name,
        summary: model.summary,
        specs: model.specs,
        releasedOn: model.releasedOn,
        status: "published",
        deviceKind: model.deviceKind,
        artKey: model.artKey,
        sort: (index + 1) * 10,
        updatedAt: now,
      }),
    ),
    { target: deviceModels.id, mode: "content", rowsPerStatement: 2 },
  );
  const siblings = new Map<string, number>();
  plan.put(
    categories,
    DEMO_CATEGORIES.map((category): NewCategory => {
      const position = (siblings.get(category.parent ?? "") ?? 0) + 1;
      siblings.set(category.parent ?? "", position);
      return {
        id: demoId.category(category.slug),
        parentId: category.parent ? demoId.category(category.parent) : null,
        slug: category.slug,
        name: category.name,
        kind: category.kind,
        sort: position * 10,
        isActive: true,
        description: category.description ?? null,
        artKey: category.artKey,
        seo: null,
      };
    }),
    { target: categories.id, mode: "content" },
  );

  // ── products, variants, costs, sets ────────────────────────────────────────
  const listed = listingOrder(data.products);
  plan.put(
    products,
    listed.map((product, index): NewProduct => {
      // One minute apart, so "new arrivals" has a stable order.
      const createdAt = now - index * MINUTE_MS;
      return {
        id: demoId.product(product.slug),
        slug: product.slug,
        kind: product.kind,
        name: product.name,
        short: product.short,
        description: product.description,
        brand: product.brand,
        platformId: product.platform ? demoId.platform(product.platform) : null,
        deviceModelId: product.deviceModel ? demoId.deviceModel(product.deviceModel) : null,
        categoryId: demoId.category(product.category),
        specs: product.specs,
        attributes: product.attributes,
        warrantyMonths: product.warrantyMonths,
        ageRating: product.ageRating,
        region: product.region,
        licenseType: product.licenseType,
        mediaFormat: product.mediaFormat,
        status: "published",
        publishAt: null,
        isDemo: true,
        seo: null,
        createdAt,
        updatedAt: now,
        searchKeywords: product.searchKeywords,
        preorderReleaseAt: product.source && isPreorderAt(product.source, now) ? product.releaseAt : null,
        preorderDepositIqd: null,
        version: 1,
        publishedAt: createdAt,
        createdBy: null,
        updatedBy: null,
      };
    }),
    { target: products.id, mode: "content", keep: ["createdAt", "publishedAt", "version", "createdBy"], rowsPerStatement: 1 },
  );
  const allVariants = data.products.flatMap((product) => product.variants.map((variant) => ({ product, variant })));
  plan.put(
    variants,
    allVariants.map(
      ({ product, variant }): NewVariant => ({
        id: demoId.variant(variant.sku),
        productId: demoId.product(product.slug),
        sku: variant.sku,
        barcode: variant.barcode,
        title: variant.title,
        options: variant.options,
        priceIqd: variant.priceIqd,
        compareAtIqd: variant.compareAtIqd,
        isDefault: variant.isDefault,
        isActive: true,
        trackSerials: variant.trackSerials,
        sort: variant.sort,
        weightGrams: null,
        createdAt: now,
        updatedAt: now,
      }),
    ),
    // A price only changes through the audited price-change flow, never by re-running a seed.
    { target: variants.id, mode: "content", keep: ["priceIqd", "compareAtIqd", "createdAt", "weightGrams"] },
  );
  const fxDate = new Date(now + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
  const costRows: NewVariantCost[] = [];
  for (const { variant } of allVariants) {
    if (!variant.cost) continue;
    costRows.push({
      variantId: demoId.variant(variant.sku),
      currency: DEMO_FX_RATE.quote,
      unitCostMinor: variant.cost.unitCostMinor,
      fxRateMicros: DEMO_FX_RATE.iqdPerUnit * 1_000_000,
      fxDate,
      landedCostIqd: variant.cost.landedCostIqd,
      avgCostIqd: variant.cost.landedCostIqd,
      minMarginBps: variant.cost.minMarginBps,
      targetMarginBps: variant.cost.targetMarginBps,
      updatedBy: null,
      updatedAt: now,
    });
  }
  plan.put(variantCosts, costRows, { target: variantCosts.variantId, mode: "state" });
  plan.put(
    bundleItems,
    allVariants.flatMap(({ variant }) =>
      (variant.bundle ?? []).map((component): NewBundleItem => ({ bundleVariantId: demoId.variant(variant.sku), componentVariantId: demoId.variant(component.sku), qty: component.qty })),
    ),
    { target: [bundleItems.bundleVariantId, bundleItems.componentVariantId], mode: "content" },
  );

  // ── pictures: official photos (used units: the model's photo, as an illustration) ──
  const usedUnitsData = demoUsedUnits(data);
  const mediaRows: NewMediaItem[] = [];
  const addMedia = (ownerType: string, ownerId: string, ownerKey: string, images: readonly DemoImage[], isIllustration: boolean) =>
    images.forEach((image, index) =>
      mediaRows.push({ id: demoId.media(ownerType, ownerKey, index), ownerType, ownerId, fileId: null, artKey: image.key, kind: "image", alt: image.alt, isIllustration, sort: index, createdAt: now }),
    );
  for (const model of data.deviceModels) addMedia("device_model", demoId.deviceModel(model.slug), model.slug, model.images, false);
  for (const product of data.products) {
    addMedia("product", demoId.product(product.slug), product.slug, product.images, false);
    for (const variant of product.variants) addMedia("variant", demoId.variant(variant.sku), variant.sku, variant.images, false);
  }
  for (const unit of usedUnitsData) addMedia("used_unit", demoId.usedUnit(unit.slug), unit.slug, unit.images, true);
  plan.put(media, mediaRows, { target: media.id, mode: "content", keep: ["createdAt"] });

  // ── stock: levels, serials, opening movements, cost layers ─────────────────
  const levelRows: NewStockLevel[] = [];
  const serialRows: NewSerial[] = [];
  const movementRows: NewStockMovement[] = [];
  const layerRows: NewCostLayer[] = [];
  for (const { product, variant } of allVariants) {
    const variantId = demoId.variant(variant.sku);
    const stock = stockOf(product, variant, now);
    levelRows.push({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: stock.onHand, reserved: 0, incoming: 0, reorderPoint: stock.reorderPoint, allowOversell: false, reorderQty: null, updatedAt: now });
    if (stock.onHand === 0) continue;
    const unitCost = variant.cost?.landedCostIqd ?? null;
    const movement = (id: string, qtyDelta: number, serialId: string | null): NewStockMovement => ({
      id,
      variantId,
      locationId: DEFAULT_LOCATION_ID,
      serialId,
      kind: "adjust",
      qtyDelta,
      reservedDelta: 0,
      unitCostIqd: unitCost,
      refType: DEMO_REF_TYPE,
      refId: "opening_balance",
      reason: OPENING_REASON,
      actorKind: "system",
      actorId: DEMO_ACTOR_ID,
      at: now,
    });
    if (variant.trackSerials) {
      // One serial row per unit on hand, so "on hand" and "serials in stock" always agree.
      for (const serial of demoSerialsOf(variant.sku, stock.onHand)) {
        const serialId = demoId.serial(serial);
        serialRows.push({ id: serialId, serial, variantId, status: "in_stock", locationId: DEFAULT_LOCATION_ID, costIqd: unitCost, source: "purchase", sourceRef: DEMO_REF_TYPE, notes: DEMO_SERIAL_NOTE, createdAt: now, updatedAt: now });
        movementRows.push(movement(demoId.openingMovement(variant.sku, serial), 1, serialId));
      }
    } else {
      movementRows.push(movement(demoId.openingMovement(variant.sku), stock.onHand, null));
    }
    if (variant.cost) {
      layerRows.push({ id: demoId.openingCostLayer(variant.sku), variantId, locationId: DEFAULT_LOCATION_ID, qtyRemaining: stock.onHand, unitCostIqd: variant.cost.landedCostIqd, receivedAt: now, receiptItemId: null, qtyReceived: stock.onHand, source: "opening" });
    }
  }
  // Used units are one-of-a-kind: each has its own serial, outside the stock counts of new units.
  for (const unit of usedUnitsData) {
    serialRows.push({
      id: demoId.serial(unit.serial),
      serial: unit.serial,
      variantId: demoId.variant(unit.sku),
      status: "in_stock",
      locationId: DEFAULT_LOCATION_ID,
      costIqd: unit.acquisitionCostIqd,
      source: "trade_in",
      sourceRef: DEMO_REF_TYPE,
      notes: DEMO_USED_SERIAL_NOTE,
      createdAt: now - unit.inspectedDaysAgo * DAY_MS,
      updatedAt: now,
    });
  }
  plan.put(stockLevels, levelRows, { target: [stockLevels.variantId, stockLevels.locationId], mode: "state" });
  plan.put(serials, serialRows, { target: serials.id, mode: "state" });
  plan.put(stockMovements, movementRows, { target: stockMovements.id, mode: "state" });
  plan.put(costLayers, layerRows, { target: costLayers.id, mode: "state" });

  // ── relations and compatibility (as researched) ────────────────────────────
  plan.put(
    productRelations,
    data.relations.map((relation): NewProductRelation => ({ productId: demoId.product(relation.product), relatedProductId: demoId.product(relation.related), kind: relation.kind, pinned: false, sort: relation.sort })),
    { target: [productRelations.productId, productRelations.relatedProductId, productRelations.kind], mode: "content" },
  );
  plan.put(
    compatibilityRules,
    data.compatibility.map(
      (rule): NewCompatibilityRule => ({
        id: demoId.compatibility(`product-${rule.product}`, `model-${rule.deviceModel}`),
        subjectType: "product",
        subjectId: demoId.product(rule.product),
        targetType: "device_model",
        targetId: demoId.deviceModel(rule.deviceModel),
        status: rule.status,
        note: rule.note,
        source: rule.source,
        verifiedBy: null,
        verifiedAt: rule.status === "unverified" ? null : now,
        createdAt: now,
        updatedAt: now,
      }),
    ),
    { target: compatibilityRules.id, mode: "content", keep: ["createdAt"], skipOnAnyConflict: true },
  );

  // ── used units and trade-in guides ─────────────────────────────────────────
  plan.put(
    usedUnits,
    usedUnitsData.map((unit): NewUsedUnit => {
      const inspectedAt = now - unit.inspectedDaysAgo * DAY_MS;
      return {
        id: demoId.usedUnit(unit.slug),
        slug: unit.slug,
        variantId: demoId.variant(unit.sku),
        serialId: demoId.serial(unit.serial),
        grade: unit.grade,
        batteryHealthPct: unit.batteryHealthPct ?? null,
        cosmeticNotes: unit.cosmeticNotes,
        defects: unit.defects,
        included: unit.included,
        checklist: { templateId: unit.templateId, completedAt: inspectedAt, completedBy: null, items: unit.checklist },
        priceIqd: unit.priceIqd,
        acquisitionCostIqd: unit.acquisitionCostIqd,
        warrantyDays: unit.warrantyDays,
        locationId: DEFAULT_LOCATION_ID,
        status: "listed",
        ownershipCheckedAt: inspectedAt,
        dataWipedAt: inspectedAt,
        listedAt: now - unit.listedDaysAgo * DAY_MS,
        isDemo: true,
        source: "trade_in",
        tradeInId: null,
        ownershipCheckedBy: null,
        dataWipedBy: null,
        soldOrderItemId: null,
        soldAt: null,
        createdAt: inspectedAt,
        updatedAt: now,
      };
    }),
    {
      target: usedUnits.id,
      mode: "content",
      // A unit that has been reserved or sold stays that way; its price and cost are money.
      keep: ["status", "listedAt", "soldOrderItemId", "soldAt", "tradeInId", "priceIqd", "acquisitionCostIqd", "createdAt", "ownershipCheckedAt", "ownershipCheckedBy", "dataWipedAt", "dataWipedBy"],
      rowsPerStatement: 1,
    },
  );
  plan.put(
    tradeInPriceGuides,
    demoTradeInGuides(data).map(
      (guide): NewTradeInPriceGuide => ({
        id: demoId.tradeInGuide(guide.deviceModel),
        deviceModelId: demoId.deviceModel(guide.deviceModel),
        variantId: null,
        baseIqd: guide.baseIqd,
        gradeMultipliers: TRADE_IN_GRADE_MULTIPLIERS,
        updatedBy: null,
        updatedAt: now,
        deductions: guide.deductions,
        isActive: true,
      }),
    ),
    { target: tradeInPriceGuides.id, mode: "state" },
  );

  // ── exchange rate and coupons ──────────────────────────────────────────────
  const fxRow: NewFxRate = { id: demoId.fxRate(DEMO_FX_RATE.quote), quote: DEMO_FX_RATE.quote, iqdPerUnit: DEMO_FX_RATE.iqdPerUnit, source: DEMO_FX_RATE.source, isDemo: true, effectiveAt: now, createdBy: null, createdAt: now };
  plan.put(fxRates, [fxRow], { target: fxRates.id, mode: "state" });
  plan.put(
    coupons,
    DEMO_COUPONS.map(
      (coupon): NewCoupon => ({
        id: demoId.coupon(coupon.code),
        code: coupon.code.toUpperCase(),
        kind: coupon.kind,
        value: coupon.value,
        minSubtotalIqd: coupon.minSubtotalIqd,
        maxDiscountIqd: coupon.maxDiscountIqd ?? null,
        usageLimit: coupon.usageLimit,
        perCustomerLimit: coupon.perCustomerLimit,
        startsAt: now,
        endsAt: null,
        conditions: null,
        isActive: true,
        description: coupon.description,
        isDemo: true,
        createdBy: null,
        createdAt: now,
      }),
    ),
    { target: coupons.id, mode: "state", skipOnAnyConflict: true },
  );

  // ── knowledge ──────────────────────────────────────────────────────────────
  plan.put(
    knowledgeArticles,
    DEMO_ARTICLES.map(
      (article, index): NewKnowledgeArticle => ({
        id: demoId.article(article.slug),
        slug: article.slug,
        kind: article.kind,
        title: article.title,
        body: localizeBlocks(article.blocks),
        deviceModelId: article.deviceModel ? demoId.deviceModel(article.deviceModel) : null,
        platformId: demoId.platform(article.platform),
        tags: article.tags,
        audience: "public",
        status: "approved",
        approvedBy: null,
        approvedAt: now,
        updatedAt: now,
        summary: article.summary,
        sort: (index + 1) * 10,
        isDemo: true,
        createdBy: null,
        createdAt: now,
      }),
    ),
    { target: knowledgeArticles.id, mode: "content", keep: ["createdAt", "approvedAt"], rowsPerStatement: 1, skipOnAnyConflict: true },
  );
  plan.put(
    troubleshootingTrees,
    DEMO_TREES.map(
      (entry): NewTroubleshootingTreeRow => ({
        id: demoId.tree(entry.symptomKey),
        deviceModelId: null,
        symptomKey: entry.symptomKey,
        title: entry.title,
        tree: entry.tree,
        status: "approved",
        approvedBy: null,
        platformId: null,
        approvedAt: now,
        isDemo: true,
        updatedAt: now,
      }),
    ),
    { target: troubleshootingTrees.id, mode: "content", keep: ["approvedAt"], rowsPerStatement: 1 },
  );

  // ── search (last: see below) ───────────────────────────────────────────────
  const synonymRows: NewSearchSynonym[] = [];
  for (const group of DEMO_SYNONYM_GROUPS) {
    for (const locale of SEED_LOCALES) {
      const [term, ...rest] = group[locale].map((entry) => normalizeSearchText(entry));
      const synonyms = [...new Set(rest)].filter((entry) => entry && entry !== term);
      synonymRows.push({ id: demoId.synonym(locale, group.key), locale, term, synonyms, isActive: true, createdBy: null, updatedAt: now });
    }
  }
  plan.put(searchSynonyms, synonymRows, { target: searchSynonyms.id, mode: "content", skipOnAnyConflict: true });
  const docsOf = (product: DemoProduct) =>
    productSearchDocs({
      name: product.name,
      short: product.short,
      description: product.description,
      brand: product.brand,
      searchKeywords: product.searchKeywords,
      codes: product.codes,
      variantTitles: product.variants.map((variant) => variant.title),
    });
  // The FTS5 index comes last in the batch. FTS5 buffers what an INSERT writes and flushes it to its
  // shadow tables when the NEXT write statement opens its savepoint, so D1 would count that flush
  // as changes of whatever table follows. Last, the flush happens at commit and counts for nobody.
  if (overwrite) {
    // Replace each product's rows (the same statements the catalogue service uses on publish).
    // Every row is rewritten, so seedDemo reports all of them as changed.
    for (const product of data.products) {
      const docs = docsOf(product);
      for (const statement of searchIndexStatements(db, demoId.product(product.slug), docs)) plan.add("search_index", statement, 0);
      plan.rows.search_index = (plan.rows.search_index ?? 0) + docs.length;
    }
  } else {
    // Index only what is missing, so a product whose text was edited in the admin keeps its own index rows.
    plan.measure("search_index", () => {
      for (const product of data.products) {
        const productId = demoId.product(product.slug);
        for (const doc of docsOf(product)) {
          const name = normalizeSearchText(doc.name);
          const keywords = normalizeSearchText(doc.keywords);
          const body = normalizeSearchText(doc.body);
          plan.add(
            "search_index",
            batchSql(
              db,
              sql`INSERT INTO search_index (product_id, locale, name, keywords, body) SELECT ${productId}, ${doc.locale}, ${name}, ${keywords}, ${body} WHERE NOT EXISTS (SELECT 1 FROM search_index WHERE product_id = ${productId} AND locale = ${doc.locale})`,
            ),
            1,
          );
        }
      }
    });
  }

  return plan;
}

// ───────────────────────────────────────────────────────────────── seeding

export type SeedDemoOptions = {
  /** Also restore the seed's descriptive content on rows that already exist (see the file header for what is never touched). */
  overwrite?: boolean;
  /** The catalogue to import; default: catalog/products and app/art/photos read from disk (Node only). */
  catalog?: DemoCatalog;
};

export type SeedDemoResult = {
  overwrite: boolean;
  /** Statements in the batch. */
  statements: number;
  /** Rows the seed defines, per table. */
  rows: Record<string, number>;
  /** Rows this run actually inserted or refreshed, per table — all zero on a second run without `overwrite`. */
  changed: Record<string, number>;
};

/** Rows changed by one statement of a D1 batch (0 when the driver reports nothing). */
const changesOf = (result: unknown): number => {
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === "number" ? changes : 0;
};

/** The count a `Plan.measure` probe returned. */
const countOf = (result: unknown): number => {
  const count = (result as { results?: Array<{ n?: unknown }> } | null)?.results?.[0]?.n;
  if (typeof count !== "number") throw new Error("Demo seed: a row-count probe returned no count");
  return count;
};

/**
 * Loads the DEMO data. The third argument also accepts the context scripts/db-reset.ts passes
 * (`{ d1, kv, env }`); only `overwrite` and `catalog` are read.
 */
export async function seedDemo(db: Db, now: number, options: SeedDemoOptions & Record<string, unknown> = {}): Promise<SeedDemoResult> {
  const overwrite = options.overwrite === true;
  const catalog = (options.catalog as DemoCatalog | undefined) ?? loadDemoCatalog();
  const plan = buildPlan(db, now, overwrite, catalog);
  // One batch = one transaction: either the whole demo catalogue is there, or none of this run's rows are.
  const results = await runBatch(db, plan.statements);
  const changed: Record<string, number> = {};
  for (const table of Object.keys(plan.rows)) changed[table] = 0;
  results.forEach((result, index) => {
    const table = plan.tables[index];
    if (table !== PROBE) changed[table] = (changed[table] ?? 0) + changesOf(result);
  });
  for (const [table, probe] of plan.measured) changed[table] = countOf(results[probe.after]) - countOf(results[probe.before]);
  // With overwrite the index rows are deleted and written again: all of them are refreshed.
  if (overwrite && plan.rows.search_index !== undefined) changed.search_index = plan.rows.search_index;
  return { overwrite, statements: plan.statements.length, rows: plan.rows, changed };
}
