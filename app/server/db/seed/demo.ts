/**
 * DEMO catalogue seed (ARCHITECTURE §11): so the store can be explored before real data exists.
 *
 *   await seedDemo(db, now)                       // insert what is missing, never touch existing rows
 *   await seedDemo(db, now, { overwrite: true })  // also restore the seed's descriptive content
 *
 * What it writes (definitions live in ./demo/*):
 *   platforms, device generations and models · category tree · 51 products with variants, costs,
 *   pictures, a bundle, stock (with opening movements, cost layers and serials) · compatibility
 *   rules and product relations · search synonyms and the search index · 6 used units and
 *   trade-in price guides · a DEMO USD rate · 2 coupons · 8 knowledge articles · 2 troubleshooting
 *   trees.
 * What it never writes: reviews, ratings, customers, orders, employees or any account.
 *
 * Rules it keeps:
 *   · Every row whose table has an `is_demo` column is flagged. Tables without one (stock movements,
 *     serials, cost layers) say "DEMO" in their reason / notes and carry ref_type "demo_seed".
 *   · Idempotent: ids are derived from slugs and SKUs, every statement is "insert if missing", and
 *     the whole seed is ONE batch — it is applied completely or not at all.
 *   · `overwrite` refreshes names, texts, specs, pictures, relations, compatibility, synonyms,
 *     articles and the search index. It never touches prices, costs, stock, serials, a used unit's
 *     status, coupons, the exchange rate or trade-in guides: those are money and stock, and changes
 *     to them belong to the audited admin flows.
 *   · Pictures are clay renders from scripts/art/catalog.json and are all flagged as illustrations.
 *
 * Needs seedReference() to have run (stock location, inspection templates). Worker-safe: no Node APIs.
 */
import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { bpsOf, roundToStep } from "../../../lib/money";
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
  type NewBundleItem,
  type NewVariant,
  type NewVariantCost,
  type ProductKind,
} from "../schema";
import { normalizeSearchText, searchIndexStatements } from "../search.server";
import { batchSql, chunkRows, runBatch } from "../tx.server";
import { localizeBlocks } from "./demo/blocks";
import { DEMO_CATEGORIES } from "./demo/categories";
import { DEMO_COUPONS, DEMO_FX_RATE } from "./demo/commerce";
import { DEMO_COMPATIBILITY, DEMO_RELATIONS, type CompatSubject, type CompatTarget } from "./demo/compatibility";
import { DEMO_DEVICE_MODELS, DEMO_GENERATIONS, DEMO_PLATFORMS, artNamesOf, deviceModelBySlug } from "./demo/devices";
import { DEMO_ACTOR_ID, DEMO_REF_TYPE, demoId } from "./demo/ids";
import { DEMO_ARTICLES } from "./demo/knowledge";
import { DEMO_PRODUCTS, DEMO_VARIANTS, KIND_DEFAULTS, productBySlug, variantBySku, type ProductSeed, type VariantSeed } from "./demo/products";
import { DEMO_SYNONYM_GROUPS, productSearchDocs, productSearchKeywords } from "./demo/search";
import { SEED_LOCALES, t3, type T3 } from "./demo/text";
import { DEMO_TREES } from "./demo/trees";
import { DEMO_TRADE_IN_GUIDES, DEMO_USED_UNITS, TRADE_IN_GRADE_MULTIPLIERS, USED_ILLUSTRATION_ALT } from "./demo/used";
import { DEFAULT_LOCATION_ID } from "./reference";

export { demoId } from "./demo/ids";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Asia/Baghdad is UTC+3 all year. */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const PRICE_STEP_IQD = 250;

const OPENING_REASON = "رصيد افتتاحي — بيانات تجريبية (DEMO)";
const DEMO_SERIAL_NOTE = "وحدة تجريبية (DEMO) — رقم تسلسلي غير حقيقي";
const DEMO_USED_SERIAL_NOTE = "وحدة مستعملة تجريبية (DEMO) — رقم تسلسلي غير حقيقي";

// ───────────────────────────────────────────────────────────────── derived values

export type PlaceholderCost = { landedCostIqd: number; unitCostMinor: number; minMarginBps: number; targetMarginBps: number };

/**
 * A placeholder cost for a variant, derived from its price so margin features have coherent
 * numbers: the kind's target margin off the regular (pre-discount) price, but never so high that
 * the current price would fall below the kind's minimum margin. 94% of the landed cost is taken
 * as the purchase price in USD cents at the demo rate; the rest stands for freight and customs.
 */
export function placeholderCost(kind: ProductKind, priceIqd: number, compareAtIqd?: number): PlaceholderCost {
  const { minMarginBps, targetMarginBps } = KIND_DEFAULTS[kind];
  const regular = compareAtIqd ?? priceIqd;
  const fromTarget = roundToStep(regular - bpsOf(regular, targetMarginBps), PRICE_STEP_IQD);
  const ceiling = Math.floor((priceIqd - bpsOf(priceIqd, minMarginBps + 100)) / PRICE_STEP_IQD) * PRICE_STEP_IQD;
  const landedCostIqd = Math.min(fromTarget, ceiling);
  return { landedCostIqd, unitCostMinor: Math.round((landedCostIqd * 94) / DEMO_FX_RATE.iqdPerUnit), minMarginBps, targetMarginBps };
}

/** Whether units of this variant are tracked one by one. A bundle is not: its components are. */
const tracksSerials = (product: ProductSeed, variant: VariantSeed) => product.trackSerials === true && !variant.bundle;
const hasOwnStock = (product: ProductSeed, variant: VariantSeed) => !variant.bundle && product.kind !== "digital";
const costOf = (product: ProductSeed, variant: VariantSeed) => (variant.cost === false || variant.bundle ? null : placeholderCost(product.kind, variant.priceIqd, variant.compareAtIqd));

/** Fake serial numbers of the new units on hand: "DEMO-PS5-SLIM-DISC-0001"… */
export const demoSerialsOf = (sku: string, count: number): string[] => Array.from({ length: count }, (_, index) => `DEMO-${sku}-${String(index + 1).padStart(4, "0")}`);

const VIEW_LABEL: Record<string, T3> = {
  front: t3("من الأمام", "front view", "لە پێشەوە"),
  back: t3("من الخلف", "back view", "لە پشتەوە"),
};

/** Alt text of a render: the thing's name, the variant if the picture shows one, and the view. */
function altFor(name: T3, artName: string, variantTitle?: T3): T3 {
  const view = VIEW_LABEL[artName.split("@")[1] ?? ""];
  const pick = (locale: (typeof SEED_LOCALES)[number]) => [name[locale], variantTitle?.[locale], view?.[locale]].filter(Boolean).join(" — ");
  return { ar: pick("ar"), en: pick("en"), ckb: pick("ckb") };
}

const subjectOf = (subject: CompatSubject) =>
  "product" in subject
    ? { type: "product" as const, id: demoId.product(productBySlug(subject.product).slug), key: `product-${subject.product}` }
    : { type: "variant" as const, id: demoId.variant(variantBySku(subject.variant).variant.sku), key: `variant-${subject.variant}` };

function targetOf(target: CompatTarget) {
  if ("model" in target) return { type: "device_model" as const, id: demoId.deviceModel(deviceModelBySlug(target.model).slug), key: `model-${target.model}` };
  if ("generation" in target) {
    if (!DEMO_GENERATIONS.some((generation) => generation.slug === target.generation)) throw new Error(`Demo seed: unknown generation "${target.generation}"`);
    return { type: "generation" as const, id: demoId.generation(target.generation), key: `generation-${target.generation}` };
  }
  return { type: "platform" as const, id: demoId.platform(target.platform), key: `platform-${target.platform}` };
}

// ───────────────────────────────────────────────────────────────── consistency of the definitions

/**
 * Checks the seed definitions against each other before anything is written, so a typo fails with
 * its own message instead of as a foreign-key error in the middle of a batch.
 */
export function assertDemoDataConsistent(): void {
  const fail = (message: string): never => {
    throw new Error(`Demo seed: ${message}`);
  };
  const platformSlugs = new Set<string>(DEMO_PLATFORMS.map((platform) => platform.slug));
  const generationSlugs = new Set(DEMO_GENERATIONS.map((generation) => generation.slug));
  const categorySlugs = new Set<string>();
  for (const category of DEMO_CATEGORIES) {
    if (category.parent && !categorySlugs.has(category.parent)) fail(`category "${category.slug}" comes before its parent "${category.parent}"`);
    if (categorySlugs.has(category.slug)) fail(`duplicate category "${category.slug}"`);
    categorySlugs.add(category.slug);
  }
  for (const generation of DEMO_GENERATIONS) if (!platformSlugs.has(generation.platform)) fail(`generation "${generation.slug}" has an unknown platform`);
  for (const model of DEMO_DEVICE_MODELS) {
    if (!platformSlugs.has(model.platform) || !generationSlugs.has(model.generation)) fail(`device model "${model.slug}" has an unknown platform or generation`);
  }
  for (const product of DEMO_PRODUCTS) {
    if (!categorySlugs.has(product.category)) fail(`product "${product.slug}" has an unknown category "${product.category}"`);
    if (product.platform && !platformSlugs.has(product.platform)) fail(`product "${product.slug}" has an unknown platform`);
    if (product.deviceModel) deviceModelBySlug(product.deviceModel);
    if (product.art.length === 0) fail(`product "${product.slug}" has no picture`);
    if (product.variants.length === 0) fail(`product "${product.slug}" has no variant`);
    for (const variant of product.variants) {
      for (const price of [variant.priceIqd, variant.compareAtIqd]) {
        if (price !== undefined && (!Number.isSafeInteger(price) || price <= 0 || price % PRICE_STEP_IQD !== 0)) fail(`${variant.sku}: price ${price} is not a positive multiple of ${PRICE_STEP_IQD}`);
      }
      if (variant.compareAtIqd !== undefined && variant.compareAtIqd <= variant.priceIqd) fail(`${variant.sku}: compare-at price must be above the price`);
      if (!Number.isSafeInteger(variant.stock) || variant.stock < 0) fail(`${variant.sku}: invalid stock`);
      if (!hasOwnStock(product, variant) && variant.stock !== 0) fail(`${variant.sku}: bundles and digital items carry no stock of their own`);
      for (const component of variant.bundle ?? []) {
        const { product: componentProduct, variant: componentVariant } = variantBySku(component.sku);
        if (componentVariant.bundle || componentProduct.kind === "digital") fail(`${variant.sku}: bundle component ${component.sku} must be a stocked item`);
      }
      const cost = costOf(product, variant);
      if (cost && (cost.landedCostIqd <= 0 || cost.landedCostIqd >= variant.priceIqd)) fail(`${variant.sku}: derived cost ${cost.landedCostIqd} is not below the price`);
    }
  }
  const edges = new Set<string>();
  for (const rule of DEMO_COMPATIBILITY) {
    const edge = `${subjectOf(rule.subject).key}→${targetOf(rule.target).key}`;
    if (edges.has(edge)) fail(`duplicate compatibility rule ${edge}`);
    edges.add(edge);
    if (rule.status !== "verified" && !rule.note) fail(`compatibility rule ${edge} (${rule.status}) needs a note`);
  }
  const links = new Set<string>();
  for (const relation of DEMO_RELATIONS) {
    productBySlug(relation.product);
    productBySlug(relation.related);
    const link = `${relation.product}→${relation.related}:${relation.kind}`;
    if (relation.product === relation.related || links.has(link)) fail(`invalid or duplicate relation ${link}`);
    links.add(link);
  }
  for (const unit of DEMO_USED_UNITS) {
    const { product } = variantBySku(unit.sku);
    if (!product.trackSerials) fail(`used unit "${unit.slug}" must be an instance of a serial-tracked variant`);
    if (unit.priceIqd % PRICE_STEP_IQD !== 0 || unit.acquisitionCostIqd >= unit.priceIqd) fail(`used unit "${unit.slug}" has an invalid price or cost`);
  }
  for (const guide of DEMO_TRADE_IN_GUIDES) deviceModelBySlug(guide.deviceModel);
  const articleSlugs = new Set(DEMO_ARTICLES.map((article) => article.slug));
  for (const article of DEMO_ARTICLES) if (article.deviceModel) deviceModelBySlug(article.deviceModel);
  for (const { symptomKey, tree } of DEMO_TREES) {
    const ids = new Set(tree.nodes.map((node) => node.id));
    if (!ids.has(tree.start)) fail(`tree "${symptomKey}" starts at an unknown node`);
    for (const node of tree.nodes) {
      for (const choice of node.options ?? []) if (!ids.has(choice.next)) fail(`tree "${symptomKey}": node "${node.id}" points at unknown node "${choice.next}"`);
      if (node.kind === "outcome" ? !node.outcome || (node.options?.length ?? 0) > 0 : (node.options?.length ?? 0) === 0) fail(`tree "${symptomKey}": node "${node.id}" is malformed`);
      if (node.outcome?.articleSlug && !articleSlugs.has(node.outcome.articleSlug)) fail(`tree "${symptomKey}": unknown article "${node.outcome.articleSlug}"`);
    }
  }
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

function buildPlan(db: Db, now: number, overwrite: boolean): Plan {
  assertDemoDataConsistent();
  const plan = new Plan(db, overwrite);

  // ── device knowledge graph and categories ──────────────────────────────────
  plan.put(
    platforms,
    DEMO_PLATFORMS.map((platform, index): NewPlatform => ({ id: demoId.platform(platform.slug), slug: platform.slug, name: platform.name, accent: platform.accent, sort: (index + 1) * 10, artKey: platform.artKey, isActive: true })),
    { target: platforms.id, mode: "content" },
  );
  plan.put(
    deviceGenerations,
    DEMO_GENERATIONS.map((generation, index): NewDeviceGeneration => ({ id: demoId.generation(generation.slug), platformId: demoId.platform(generation.platform), slug: generation.slug, name: generation.name, sort: (index + 1) * 10 })),
    { target: deviceGenerations.id, mode: "content" },
  );
  plan.put(
    deviceModels,
    DEMO_DEVICE_MODELS.map(
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
    { target: deviceModels.id, mode: "content" },
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

  // ── products, variants, costs, bundles ─────────────────────────────────────
  plan.put(
    products,
    DEMO_PRODUCTS.map((product, index): NewProduct => {
      // Listed newest first: one minute apart, so "new arrivals" has a stable order.
      const createdAt = now - index * MINUTE_MS;
      const modelSpecs = product.kind === "console" && product.deviceModel ? deviceModelBySlug(product.deviceModel).specs : {};
      const specs = { ...modelSpecs, ...product.specs };
      return {
        id: demoId.product(product.slug),
        slug: product.slug,
        kind: product.kind,
        name: product.name,
        short: product.short,
        description: product.description,
        brand: product.brand ?? null,
        platformId: product.platform ? demoId.platform(product.platform) : null,
        deviceModelId: product.deviceModel ? demoId.deviceModel(product.deviceModel) : null,
        categoryId: demoId.category(product.category),
        specs: Object.keys(specs).length > 0 ? specs : null,
        attributes: null,
        warrantyMonths: product.warrantyMonths ?? null,
        ageRating: product.ageRating ?? null,
        region: product.region ?? null,
        licenseType: product.licenseType ?? null,
        mediaFormat: product.mediaFormat ?? null,
        status: "published",
        publishAt: null,
        isDemo: true,
        seo: null,
        createdAt,
        updatedAt: now,
        searchKeywords: productSearchKeywords(product),
        preorderReleaseAt: null,
        preorderDepositIqd: null,
        version: 1,
        publishedAt: createdAt,
        createdBy: null,
        updatedBy: null,
      };
    }),
    { target: products.id, mode: "content", keep: ["createdAt", "publishedAt", "version", "createdBy"] },
  );
  plan.put(
    variants,
    DEMO_VARIANTS.map(
      ({ product, variant, index }): NewVariant => ({
        id: demoId.variant(variant.sku),
        productId: demoId.product(product.slug),
        sku: variant.sku,
        barcode: null,
        title: variant.title ?? null,
        options: variant.options ?? null,
        priceIqd: variant.priceIqd,
        compareAtIqd: variant.compareAtIqd ?? null,
        isDefault: index === 0,
        isActive: true,
        trackSerials: tracksSerials(product, variant),
        sort: index,
        weightGrams: null,
        createdAt: now,
        updatedAt: now,
      }),
    ),
    // A price only changes through the audited price-change flow, never by re-running a seed.
    { target: variants.id, mode: "content", keep: ["priceIqd", "compareAtIqd", "createdAt", "barcode", "weightGrams"] },
  );
  const fxDate = new Date(now + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
  const costRows: NewVariantCost[] = [];
  for (const { product, variant } of DEMO_VARIANTS) {
    const cost = costOf(product, variant);
    if (!cost) continue;
    costRows.push({
      variantId: demoId.variant(variant.sku),
      currency: DEMO_FX_RATE.quote,
      unitCostMinor: cost.unitCostMinor,
      fxRateMicros: DEMO_FX_RATE.iqdPerUnit * 1_000_000,
      fxDate,
      landedCostIqd: cost.landedCostIqd,
      avgCostIqd: cost.landedCostIqd,
      minMarginBps: cost.minMarginBps,
      targetMarginBps: cost.targetMarginBps,
      updatedBy: null,
      updatedAt: now,
    });
  }
  plan.put(variantCosts, costRows, { target: variantCosts.variantId, mode: "state" });
  plan.put(
    bundleItems,
    DEMO_VARIANTS.flatMap(({ variant }) =>
      (variant.bundle ?? []).map((component): NewBundleItem => ({ bundleVariantId: demoId.variant(variant.sku), componentVariantId: demoId.variant(component.sku), qty: component.qty })),
    ),
    { target: [bundleItems.bundleVariantId, bundleItems.componentVariantId], mode: "content" },
  );

  // ── pictures (all clay renders, all flagged as illustrations) ──────────────
  const mediaRows: NewMediaItem[] = [];
  const addMedia = (ownerType: string, ownerId: string, ownerKey: string, artNames: readonly string[], alt: (artName: string) => T3) =>
    artNames.forEach((artName, index) =>
      mediaRows.push({ id: demoId.media(ownerType, ownerKey, index), ownerType, ownerId, fileId: null, artKey: artName, kind: "render", alt: alt(artName), isIllustration: true, sort: index, createdAt: now }),
    );
  for (const model of DEMO_DEVICE_MODELS) {
    addMedia("device_model", demoId.deviceModel(model.slug), model.slug, artNamesOf(model.artKey, model.artViews), (artName) => altFor(model.name, artName));
  }
  for (const product of DEMO_PRODUCTS) {
    // A picture that belongs to one colour variant says which one.
    const variantShowing = (artName: string) => product.variants.find((variant) => variant.art?.includes(artName));
    addMedia("product", demoId.product(product.slug), product.slug, product.art, (artName) => altFor(product.name, artName, variantShowing(artName)?.title));
    for (const variant of product.variants) {
      if (variant.art) addMedia("variant", demoId.variant(variant.sku), variant.sku, variant.art, (artName) => altFor(product.name, artName, variant.title));
    }
  }
  for (const unit of DEMO_USED_UNITS) addMedia("used_unit", demoId.usedUnit(unit.slug), unit.slug, unit.art, () => USED_ILLUSTRATION_ALT);
  plan.put(media, mediaRows, { target: media.id, mode: "content", keep: ["createdAt"] });

  // ── stock: levels, serials, opening movements, cost layers ─────────────────
  const levelRows: NewStockLevel[] = [];
  const serialRows: NewSerial[] = [];
  const movementRows: NewStockMovement[] = [];
  const layerRows: NewCostLayer[] = [];
  for (const { product, variant } of DEMO_VARIANTS) {
    const variantId = demoId.variant(variant.sku);
    const stocked = hasOwnStock(product, variant);
    const cost = costOf(product, variant);
    levelRows.push({
      variantId,
      locationId: DEFAULT_LOCATION_ID,
      onHand: variant.stock,
      reserved: 0,
      incoming: 0,
      reorderPoint: stocked ? (variant.reorderPoint ?? KIND_DEFAULTS[product.kind].reorderPoint) : null,
      allowOversell: false,
      reorderQty: null,
      updatedAt: now,
    });
    if (variant.stock === 0) continue;
    const movement = (id: string, qtyDelta: number, serialId: string | null): NewStockMovement => ({
      id,
      variantId,
      locationId: DEFAULT_LOCATION_ID,
      serialId,
      kind: "adjust",
      qtyDelta,
      reservedDelta: 0,
      unitCostIqd: cost?.landedCostIqd ?? null,
      refType: DEMO_REF_TYPE,
      refId: "opening_balance",
      reason: OPENING_REASON,
      actorKind: "system",
      actorId: DEMO_ACTOR_ID,
      at: now,
    });
    if (tracksSerials(product, variant)) {
      // One serial row per unit on hand, so "on hand" and "serials in stock" always agree.
      for (const serial of demoSerialsOf(variant.sku, variant.stock)) {
        const serialId = demoId.serial(serial);
        serialRows.push({ id: serialId, serial, variantId, status: "in_stock", locationId: DEFAULT_LOCATION_ID, costIqd: cost?.landedCostIqd ?? null, source: "purchase", sourceRef: DEMO_REF_TYPE, notes: DEMO_SERIAL_NOTE, createdAt: now, updatedAt: now });
        movementRows.push(movement(demoId.openingMovement(variant.sku, serial), 1, serialId));
      }
    } else {
      movementRows.push(movement(demoId.openingMovement(variant.sku), variant.stock, null));
    }
    if (cost) {
      layerRows.push({ id: demoId.openingCostLayer(variant.sku), variantId, locationId: DEFAULT_LOCATION_ID, qtyRemaining: variant.stock, unitCostIqd: cost.landedCostIqd, receivedAt: now, receiptItemId: null, qtyReceived: variant.stock, source: "opening" });
    }
  }
  // Used units are one-of-a-kind: each has its own serial, outside the stock counts of new units.
  for (const unit of DEMO_USED_UNITS) {
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

  // ── relations and compatibility ────────────────────────────────────────────
  plan.put(
    productRelations,
    DEMO_RELATIONS.map((relation): NewProductRelation => ({ productId: demoId.product(relation.product), relatedProductId: demoId.product(relation.related), kind: relation.kind, pinned: relation.pinned, sort: relation.sort })),
    { target: [productRelations.productId, productRelations.relatedProductId, productRelations.kind], mode: "content" },
  );
  plan.put(
    compatibilityRules,
    DEMO_COMPATIBILITY.map((rule): NewCompatibilityRule => {
      const subject = subjectOf(rule.subject);
      const target = targetOf(rule.target);
      return {
        id: demoId.compatibility(subject.key, target.key),
        subjectType: subject.type,
        subjectId: subject.id,
        targetType: target.type,
        targetId: target.id,
        status: rule.status,
        note: rule.note ?? null,
        source: rule.source ?? null,
        verifiedBy: null,
        verifiedAt: rule.status === "unverified" ? null : now,
        createdAt: now,
        updatedAt: now,
      };
    }),
    { target: compatibilityRules.id, mode: "content", keep: ["createdAt"], skipOnAnyConflict: true },
  );

  // ── used units and trade-in guides ─────────────────────────────────────────
  plan.put(
    usedUnits,
    DEMO_USED_UNITS.map((unit): NewUsedUnit => {
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
    DEMO_TRADE_IN_GUIDES.map(
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
  // The FTS5 index comes last in the batch. FTS5 buffers what an INSERT writes and flushes it to its
  // shadow tables when the NEXT write statement opens its savepoint, so D1 would count that flush
  // as changes of whatever table follows. Last, the flush happens at commit and counts for nobody.
  if (overwrite) {
    // Replace each product's rows (the same statements the catalogue service uses on publish).
    // Every row is rewritten, so seedDemo reports all of them as changed.
    for (const product of DEMO_PRODUCTS) {
      const docs = productSearchDocs(product);
      for (const statement of searchIndexStatements(db, demoId.product(product.slug), docs)) plan.add("search_index", statement, 0);
      plan.rows.search_index = (plan.rows.search_index ?? 0) + docs.length;
    }
  } else {
    // Index only what is missing, so a product whose text was edited in the admin keeps its own index rows.
    plan.measure("search_index", () => {
      for (const product of DEMO_PRODUCTS) {
        const productId = demoId.product(product.slug);
        for (const doc of productSearchDocs(product)) {
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
 * Loads the DEMO catalogue. The third argument also accepts the context scripts/db-reset.ts passes
 * (`{ d1, kv, env }`); only `overwrite` is read.
 */
export async function seedDemo(db: Db, now: number, options: SeedDemoOptions & Record<string, unknown> = {}): Promise<SeedDemoResult> {
  const overwrite = options.overwrite === true;
  const plan = buildPlan(db, now, overwrite);
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
