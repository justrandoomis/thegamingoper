/**
 * The owner's price sheet import (catalog/owner-sheet-2026-11-18.json → variants[].sheetRow; app/server/db/seed/demo/owner.ts):
 *   · validation: a sheet row exists, is not skipped, belongs to one variant only; a product's `category` is a leaf;
 *   · owner mode: sheet variants at the sheet price, one real unit (no "DEMO", no invented cost, no serial), products
 *     real (is_demo = 0); variants not on the sheet inactive with no price and no stock; a product without any priced
 *     row a draft; every other product (and the store set) archived; demo used units off the listing;
 *   · the PS4 device and the new categories;
 *   · the production path: a database seeded with the old demo catalogue moves to the owner's state, leaves alone what
 *     staff touched (a price change, a stock movement, a product saved in the admin), never doubles stock, and the
 *     recorded SQL file does the same and can be applied twice.
 *
 * The catalogue research runs while this file is written, so the test builds its OWN catalogue: the researched files
 * that import cleanly, their sheet rows removed, plus three test products and a test sheet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "~/server/db/drizzle.server";
import { OWNER_TRANSITION, buildDemoData, demoId, loadDemoCatalog, seedDemo, type SeedDemoResult } from "~/server/db/seed/demo";
import type { CatalogProduct, CatalogVariant, DemoCatalog, OwnerSheetRow } from "~/server/db/seed/demo/catalog/types";
import { DEMO_CATEGORIES, categoryOf, isLeafCategory } from "~/server/db/seed/demo/categories";
import { DEMO_DEVICE_MODELS, DEMO_GENERATIONS } from "~/server/db/seed/demo/devices";
import { catalogImportProblems, unmappedSheetRows } from "~/server/db/seed/demo/import";
import { recordWrites, statementToSql, type RecordedStatement } from "~/server/db/seed/demo/sql";
import { DEMO_STORE_SETS } from "~/server/db/seed/demo/sets";
import { DEMO_USED_UNITS } from "~/server/db/seed/demo/used";
import { DEFAULT_LOCATION_ID, seedReference } from "~/server/db/seed/reference";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";

// ───────────────────────────────────────────────────────────────── the test catalogue

const same = (text: string) => ({ ar: text, en: text, ckb: text });

const SHEET: OwnerSheetRow[] = [
  { row: 1, sheetName: "PS5 DUALSENSE TEST", priceIqd: 95_000 },
  { row: 2, sheetName: "PS5 SLIM TEST", priceIqd: 700_000 },
  { row: 3, sheetName: "TEST CHAIR BLACK", priceIqd: 224_000 },
  { row: 4, sheetName: "PS4 TEST GAME", priceIqd: 30_000 },
  { row: 5, sheetName: "TEST CARD NO PRICE", priceIqd: null },
  { row: 6, sheetName: "NOT YET RESEARCHED", priceIqd: 10_000 },
  { row: 233, sheetName: "كارت جهاز", priceIqd: 1_500 },
];

function testProduct(slug: string, fields: Partial<CatalogProduct> & Pick<CatalogProduct, "kind" | "platform" | "variants">): CatalogProduct {
  return {
    slug,
    group: "test",
    brand: "Test",
    status: "available",
    name: same(`Test ${slug}`),
    short: same("Test item"),
    description: same("A test item."),
    highlights: [],
    specs: [],
    related: [],
    images: [],
    sources: [{ url: "https://example.com/" }],
    verification: {},
    ...fields,
  };
}
const variant = (sku: string, isDefault: boolean, sheetRow?: number): CatalogVariant => ({ sku, title: same(sku.toLowerCase().replace(/^./, (c) => c.toUpperCase())), isDefault, ...(sheetRow !== undefined ? { sheetRow } : {}) });

const CHAIR = testProduct("test-gaming-chair", { kind: "accessory", platform: "multi", category: "gaming-chairs", variants: [variant("TEST-CHAIR-GREY", true), variant("TEST-CHAIR-BLACK", false, 3)] });
const PS4_GAME = testProduct("test-ps4-game", {
  kind: "game",
  platform: "playstation",
  variants: [variant("TEST-PS4-GAME", true, 4)],
  game: { platforms: ["ps4"], genres: [same("Action")], players: "1", online: same("No"), ageRating: { pegi: 12 }, arabic: "unknown", physicalFormat: "disc", publisher: "Test" },
  compatibility: [{ deviceModel: "ps4", status: "verified", source: "https://example.com/" }],
});
const NO_PRICE = testProduct("test-no-price-card", { kind: "storage", platform: "multi", variants: [variant("TEST-CARD-256", true, 5)] });

/** The researched files that import as they are (research is still running), without their own sheet rows. */
function cleanResearchedProducts(live: DemoCatalog): CatalogProduct[] {
  let products = live.products.map((product) => ({ ...product, variants: product.variants.map(({ sheetRow: _row, ...rest }) => rest) }));
  for (let round = 0; round < 10; round++) {
    const slugs = new Set(products.map((product) => product.slug));
    products = products.map((product) => ({ ...product, related: product.related.filter((relation) => slugs.has(relation.slug)) }));
    const broken = new Set(
      catalogImportProblems({ products, photoKeys: live.photoKeys })
        .map((problem) => /^catalog\/products\/([a-z0-9-]+)\.json:/.exec(problem)?.[1])
        .filter((slug): slug is string => !!slug),
    );
    if (broken.size === 0) break;
    products = products.filter((product) => !broken.has(product.slug));
  }
  return products;
}

const live = loadDemoCatalog();
const researched = cleanResearchedProducts(live);
const withRow = (slug: string, row: number): CatalogProduct => {
  const product = researched.find((entry) => entry.slug === slug);
  if (!product) throw new Error(`test catalogue: ${slug} does not import`);
  return { ...product, variants: product.variants.map((entry) => (entry.isDefault ? { ...entry, sheetRow: row } : entry)) };
};
const DUALSENSE = withRow("dualsense", 1);
const SLIM = withRow("playstation-5-slim", 2);
const catalog: DemoCatalog = {
  products: [...researched.map((product) => (product.slug === "dualsense" ? DUALSENSE : product.slug === "playstation-5-slim" ? SLIM : product)), CHAIR, PS4_GAME, NO_PRICE],
  photoKeys: live.photoKeys,
  ownerSheet: SHEET,
};
const OWNER_SLUGS = new Set(["dualsense", "playstation-5-slim", CHAIR.slug, PS4_GAME.slug, NO_PRICE.slug]);
const defaultSku = (product: CatalogProduct) => product.variants.find((entry) => entry.isDefault)!.sku;

// ───────────────────────────────────────────────────────────────── helpers

const rowsOf = async <T = Record<string, unknown>>(db: D1Database, query: string, ...params: unknown[]): Promise<T[]> => (await db.prepare(query).bind(...params).all<T>()).results;
const one = async <T = Record<string, unknown>>(db: D1Database, query: string, ...params: unknown[]): Promise<T> => (await rowsOf<T>(db, query, ...params))[0];
const changedTotal = (result: SeedDemoResult) => Object.values(result.changed).reduce((sum, n) => sum + n, 0);

/** What a store reads to decide what it shows: products' status and demo flag, variants' prices, stock and its movements. */
async function snapshot(db: D1Database) {
  return {
    products: await rowsOf(db, "SELECT slug, status, is_demo, category_id FROM products ORDER BY slug"),
    variants: await rowsOf(db, "SELECT sku, price_iqd, compare_at_iqd, is_active, is_default FROM variants ORDER BY sku"),
    levels: await rowsOf(db, "SELECT variant_id, on_hand, reserved FROM stock_levels ORDER BY variant_id"),
    movements: await rowsOf(db, "SELECT count(*) AS n, coalesce(sum(qty_delta), 0) AS total FROM stock_movements"),
    costs: await rowsOf(db, "SELECT count(*) AS n FROM variant_costs"),
  };
}

// ───────────────────────────────────────────────────────────────── definitions

describe("owner's sheet: catalogue rules", () => {
  it("builds its test catalogue from the research (device products and store-set components included)", () => {
    const slugs = new Set(catalog.products.map((product) => product.slug));
    for (const model of DEMO_DEVICE_MODELS) if (model.product) expect(slugs.has(model.product), model.product).toBe(true);
    expect(catalogImportProblems(catalog)).toEqual([]);
  });

  it("checks sheet rows: known, not skipped, one variant each — and that the sheet was loaded", () => {
    const withVariant = (sheetRow: number): CatalogProduct => ({ ...NO_PRICE, slug: "test-extra", variants: [variant("TEST-EXTRA", true, sheetRow)] });
    const problems = (extra: CatalogProduct, sheet: readonly OwnerSheetRow[] | null = SHEET) => catalogImportProblems({ ...catalog, products: [...catalog.products, extra], ownerSheet: sheet ?? undefined }).join("\n");
    expect(problems(withVariant(3))).toMatch(/sheet row 3 is already variant test-gaming-chair\/TEST-CHAIR-BLACK/);
    expect(problems(withVariant(999))).toMatch(/sheet row 999, which is not in/);
    expect(problems(withVariant(233))).toMatch(/row 233, which the owner left out/);
    expect(problems(withVariant(6), null)).toMatch(/owner's sheet .* was not loaded/);
    expect(problems(withVariant(6))).toBe("");
    expect(unmappedSheetRows(catalog).map((row) => row.row)).toEqual([6]);
  });

  it("files a product under the leaf category its research names, and refuses an unknown or a parent one", () => {
    expect(categoryOf(CHAIR)).toBe("gaming-chairs");
    expect(categoryOf(PS4_GAME)).toBe("playstation-games");
    const problems = (category: string) => catalogImportProblems({ ...catalog, products: catalog.products.map((product) => (product.slug === CHAIR.slug ? { ...CHAIR, category } : product)) }).join("\n");
    expect(problems("sofas")).toMatch(/category "sofas" does not exist/);
    expect(problems("pc-peripherals")).toMatch(/has sub-categories/);
  });

  it("arranges the new categories in the tree, in three languages", () => {
    const bySlug = new Map(DEMO_CATEGORIES.map((category) => [category.slug, category]));
    const expected: Record<string, string | undefined> = {
      "gaming-chairs": undefined,
      keyboards: "pc-peripherals",
      mice: "pc-peripherals",
      "mouse-pads": "pc-peripherals",
      microphones: "pc-peripherals",
      speakers: "pc-peripherals",
      monitors: "pc-peripherals",
      "gaming-glasses": "pc-peripherals",
      cables: "cables-power",
      "ups-power": "cables-power",
      lighting: undefined,
    };
    for (const [slug, parent] of Object.entries(expected)) {
      const category = bySlug.get(slug);
      expect(category, slug).toBeDefined();
      expect(category!.parent).toBe(parent);
      expect(isLeafCategory(slug)).toBe(true);
      for (const locale of ["ar", "en", "ckb"] as const) expect(category!.name[locale].trim()).not.toBe("");
      expect(category!.name.ckb).toMatch(/[؀-ۿ]/);
      if (parent) expect(category!.kind).toBe(bySlug.get(parent)!.kind);
    }
  });

  it("knows the PlayStation 4 family as a device without a product of its own", () => {
    const ps4 = DEMO_DEVICE_MODELS.find((model) => model.slug === "ps4")!;
    expect(ps4).toMatchObject({ platform: "playstation", generation: "ps4", deviceKind: "console", product: null });
    expect(ps4.summary?.ckb).toBeTruthy();
    expect(DEMO_GENERATIONS.find((generation) => generation.slug === "ps4")?.platform).toBe("playstation");
  });

  it("prices the owner's items from the sheet and archives everything else (owner mode); the demo is unchanged without it", () => {
    const owner = buildDemoData(catalog, { ownerSheet: true });
    const demo = buildDemoData(catalog);
    const product = (data: typeof owner, slug: string) => data.products.find((entry) => entry.slug === slug)!;

    const chair = product(owner, CHAIR.slug);
    expect(chair).toMatchObject({ status: "published", isDemo: false, category: "gaming-chairs" });
    const [grey, black] = chair.variants;
    expect(black).toMatchObject({ sku: "TEST-CHAIR-BLACK", priceIqd: 224_000, compareAtIqd: null, cost: null, isActive: true, isDefault: true, ownerStock: 1, sheetRow: 3 });
    // not on the sheet: not sold, no price, no stock — and no longer the default
    expect(grey).toMatchObject({ priceIqd: 0, isActive: false, isDefault: false, ownerStock: 0, sheetRow: null });

    const dualsense = product(owner, "dualsense");
    for (const entry of dualsense.variants) {
      if (entry.sku === defaultSku(DUALSENSE)) expect(entry).toMatchObject({ priceIqd: 95_000, isActive: true, compareAtIqd: null, cost: null });
      else expect(entry).toMatchObject({ priceIqd: 0, isActive: false });
    }
    expect((dualsense.attributes as { sheetRows: Record<string, unknown> }).sheetRows).toEqual({ [defaultSku(DUALSENSE)]: { row: 1, name: "PS5 DUALSENSE TEST" } });
    expect(product(owner, NO_PRICE.slug)).toMatchObject({ status: "draft", isDemo: false });
    expect(product(owner, NO_PRICE.slug).variants[0]).toMatchObject({ priceIqd: 0, isActive: false, ownerStock: 1 });

    for (const entry of owner.products) {
      if (OWNER_SLUGS.has(entry.slug)) continue;
      expect(entry, entry.slug).toMatchObject({ status: "archived", isDemo: true });
    }
    expect(product(owner, DEMO_STORE_SETS[0].slug).status).toBe("archived");
    for (const entry of demo.products) expect(entry, entry.slug).toMatchObject({ status: "published", isDemo: true });
    expect(product(demo, CHAIR.slug).variants.every((entry) => entry.isActive && entry.priceIqd > 0 && entry.ownerStock === null)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── a new database

describe("owner's sheet: a new database", () => {
  let db: TestDb;
  let first: SeedDemoResult;
  let second: SeedDemoResult;

  beforeAll(async () => {
    db = await createTestDb();
    first = await seedDemo(db.db, db.now, { catalog, ownerSheet: true });
    second = await seedDemo(db.db, db.now + 60_000, { catalog, ownerSheet: true });
  }, 180_000);
  afterAll(async () => {
    await db?.dispose();
  });

  it("publishes only the owner's items, as real items; everything else is archived, not deleted", async () => {
    const products = await rowsOf<{ slug: string; status: string; is_demo: number }>(db.d1, "SELECT slug, status, is_demo FROM products");
    expect(products.length).toBe(catalog.products.length + DEMO_STORE_SETS.length);
    const published = products.filter((row) => row.status === "published").map((row) => row.slug).sort();
    expect(published).toEqual(["dualsense", "playstation-5-slim", CHAIR.slug, PS4_GAME.slug].sort());
    for (const row of products) expect(row.is_demo, row.slug).toBe(OWNER_SLUGS.has(row.slug) ? 0 : 1);
    expect(products.find((row) => row.slug === NO_PRICE.slug)?.status).toBe("draft");
  });

  it("sells each sheet row at the sheet price with one unit whose opening balance names the sheet — no cost, serial or 'was' price", async () => {
    const sku = defaultSku(SLIM);
    const variantId = demoId.variant(sku);
    expect(await one(db.d1, "SELECT price_iqd, compare_at_iqd, is_active, track_serials FROM variants WHERE id = ?", variantId)).toEqual({ price_iqd: 700_000, compare_at_iqd: null, is_active: 1, track_serials: 1 });
    expect(await one(db.d1, "SELECT on_hand, reserved, reorder_point FROM stock_levels WHERE variant_id = ? AND location_id = ?", variantId, DEFAULT_LOCATION_ID)).toEqual({ on_hand: 1, reserved: 0, reorder_point: null });
    const movements = await rowsOf<{ id: string; qty_delta: number; ref_type: string; reason: string; unit_cost_iqd: number | null }>(db.d1, "SELECT id, qty_delta, ref_type, reason, unit_cost_iqd FROM stock_movements WHERE variant_id = ?", variantId);
    expect(movements).toEqual([{ id: demoId.sheetOpening(sku), qty_delta: 1, ref_type: "owner_sheet", reason: expect.stringContaining("الصف 2"), unit_cost_iqd: null }]);
    expect(movements[0].reason).not.toMatch(/DEMO/);
    // (a demo used unit of this model keeps its own trade-in serial: it is not new stock)
    expect((await one<{ n: number }>(db.d1, "SELECT count(*) AS n FROM serials WHERE variant_id = ? AND source = 'purchase'", variantId)).n).toBe(0);
    expect((await one<{ n: number }>(db.d1, "SELECT count(*) AS n FROM variant_costs WHERE variant_id = ?", variantId)).n).toBe(0);
    expect((await one<{ n: number }>(db.d1, "SELECT count(*) AS n FROM cost_layers WHERE variant_id = ?", variantId)).n).toBe(0);
    // a variant of a real product that is not on the sheet: hidden, no price, nothing on hand
    expect(await one(db.d1, "SELECT v.price_iqd, v.is_active, l.on_hand FROM variants v JOIN stock_levels l ON l.variant_id = v.id WHERE v.sku = 'TEST-CHAIR-GREY'")).toEqual({ price_iqd: 0, is_active: 0, on_hand: 0 });
  });

  it("files the PS4 game on the PS4 device and the chair under gaming chairs", async () => {
    expect(await one(db.d1, "SELECT platform_id, generation_id, device_kind, status FROM device_models WHERE slug = 'ps4'")).toEqual({ platform_id: "plt_playstation", generation_id: "gen_ps4", device_kind: "console", status: "published" });
    expect(await one(db.d1, "SELECT target_id, status FROM compatibility_rules WHERE subject_id = ?", demoId.product(PS4_GAME.slug))).toEqual({ target_id: "dvm_ps4", status: "verified" });
    expect(await one(db.d1, "SELECT platform_id, category_id FROM products WHERE slug = ?", PS4_GAME.slug)).toEqual({ platform_id: "plt_playstation", category_id: "cat_playstation-games" });
    expect(await one(db.d1, "SELECT p.category_id, c.parent_id FROM products p JOIN categories c ON c.id = p.category_id WHERE p.slug = ?", CHAIR.slug)).toEqual({ category_id: "cat_gaming-chairs", parent_id: null });
    expect(await one(db.d1, "SELECT parent_id FROM categories WHERE slug = 'keyboards'")).toEqual({ parent_id: "cat_pc-peripherals" });
  });

  it("takes the demo used units off the listing", async () => {
    const statuses = await rowsOf<{ status: string }>(db.d1, "SELECT status FROM used_units");
    expect(statuses.length).toBe(DEMO_USED_UNITS.length);
    expect(statuses.every((row) => row.status === "ready")).toBe(true);
  });

  it("changes nothing on a second run", () => {
    expect(changedTotal(first)).toBeGreaterThan(0);
    expect(second.changed).toEqual(Object.fromEntries(Object.keys(second.changed).map((table) => [table, 0])));
  });
});

// ───────────────────────────────────────────────────────────────── production: a database with the demo

describe("owner's sheet: moving a database seeded with the demo catalogue", () => {
  let prod: TestDb;
  const slimSku = () => defaultSku(SLIM);
  const dsSku = () => defaultSku(DUALSENSE);
  let dualsenseBefore: { price_iqd: number; on_hand: number };
  let moved: SeedDemoResult;
  let again: SeedDemoResult;
  let afterMove: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    prod = await createTestDb();
    // what production holds today: the demo catalogue, inserted if missing
    await seedDemo(prod.db, prod.now, { catalog });
    // staff at work since: a price change on the DualSense, a stock movement of its own, a product saved in the admin
    const ds = demoId.variant(dsSku());
    await prod.d1.prepare("INSERT INTO price_changes (id, variant_id, old_price_iqd, new_price_iqd, status, created_at, source) VALUES ('prc_test', ?, 1, 2, 'applied', ?, 'manual')").bind(ds, prod.now).run();
    await prod.d1.batch([
      prod.d1.prepare("INSERT INTO stock_movements (id, variant_id, location_id, kind, qty_delta, reserved_delta, ref_type, ref_id, reason, actor_kind, actor_id, at) VALUES ('smv_test', ?, ?, 'adjust', 2, 0, 'manual', 'x', 'count', 'employee', 'emp_test', ?)").bind(ds, DEFAULT_LOCATION_ID, prod.now),
      prod.d1.prepare("UPDATE stock_levels SET on_hand = on_hand + 2 WHERE variant_id = ? AND location_id = ?").bind(ds, DEFAULT_LOCATION_ID),
      prod.d1.prepare("UPDATE products SET updated_by = 'emp_test' WHERE slug = 'xbox-series-s'"),
    ]);
    dualsenseBefore = await one(prod.d1, "SELECT v.price_iqd, l.on_hand FROM variants v JOIN stock_levels l ON l.variant_id = v.id WHERE v.id = ?", ds);
    moved = await seedDemo(prod.db, prod.now + 60_000, { catalog, ownerSheet: true, overwrite: true });
    afterMove = await snapshot(prod.d1);
    again = await seedDemo(prod.db, prod.now + 120_000, { catalog, ownerSheet: true, overwrite: true });
  }, 240_000);
  afterAll(async () => {
    await prod?.dispose();
  });

  it("moves an untouched demo variant to its sheet price and ONE real unit, explained by its movements", async () => {
    const variantId = demoId.variant(slimSku());
    expect(await one(prod.d1, "SELECT price_iqd, compare_at_iqd, is_active FROM variants WHERE id = ?", variantId)).toEqual({ price_iqd: 700_000, compare_at_iqd: null, is_active: 1 });
    const level = await one<{ on_hand: number }>(prod.d1, "SELECT on_hand FROM stock_levels WHERE variant_id = ? AND location_id = ?", variantId, DEFAULT_LOCATION_ID);
    const sum = await one<{ total: number }>(prod.d1, "SELECT coalesce(sum(qty_delta), 0) AS total FROM stock_movements WHERE variant_id = ? AND location_id = ?", variantId, DEFAULT_LOCATION_ID);
    expect(level.on_hand).toBe(1);
    expect(sum.total).toBe(1);
    expect((await one<{ n: number }>(prod.d1, "SELECT count(*) AS n FROM stock_movements WHERE id = ? AND ref_type = 'owner_sheet'", demoId.sheetOpening(slimSku()))).n).toBe(1);
    // the fake serials are set aside, the invented cost is gone
    expect((await one<{ n: number }>(prod.d1, "SELECT count(*) AS n FROM serials WHERE variant_id = ? AND status = 'in_stock' AND source = 'purchase'", variantId)).n).toBe(0);
    expect((await one<{ n: number }>(prod.d1, "SELECT count(*) AS n FROM variant_costs WHERE variant_id = ?", variantId)).n).toBe(0);
    expect((await one<{ n: number }>(prod.d1, "SELECT coalesce(sum(qty_remaining), 0) AS n FROM cost_layers WHERE variant_id = ?", variantId)).n).toBe(0);
    expect(await one(prod.d1, "SELECT status, is_demo, category_id FROM products WHERE slug = 'playstation-5-slim'")).toEqual({ status: "published", is_demo: 0, category_id: "cat_playstation-consoles" });
  });

  it("never touches a price staff changed or stock staff moved", async () => {
    const ds = demoId.variant(dsSku());
    expect(await one(prod.d1, "SELECT v.price_iqd, l.on_hand FROM variants v JOIN stock_levels l ON l.variant_id = v.id WHERE v.id = ?", ds)).toEqual(dualsenseBefore);
    expect((await one<{ n: number }>(prod.d1, "SELECT count(*) AS n FROM stock_movements WHERE variant_id = ? AND ref_type = 'owner_sheet'", ds)).n).toBe(0);
    // the product itself is the owner's now
    expect(await one(prod.d1, "SELECT status, is_demo FROM products WHERE slug = 'dualsense'")).toEqual({ status: "published", is_demo: 0 });
  });

  it("archives the demo products the admin never saved, adds the new items, and lists no demo used unit", async () => {
    const rows = await rowsOf<{ slug: string; status: string; is_demo: number }>(prod.d1, "SELECT slug, status, is_demo FROM products");
    for (const row of rows) {
      if (OWNER_SLUGS.has(row.slug)) continue;
      expect(row.status, row.slug).toBe(row.slug === "xbox-series-s" ? "published" : "archived");
      expect(row.is_demo, row.slug).toBe(1);
    }
    expect(await one(prod.d1, "SELECT v.price_iqd, l.on_hand FROM variants v JOIN stock_levels l ON l.variant_id = v.id WHERE v.sku = 'TEST-CHAIR-BLACK'")).toEqual({ price_iqd: 224_000, on_hand: 1 });
    expect((await one<{ n: number }>(prod.d1, "SELECT count(*) AS n FROM used_units WHERE status = 'listed'")).n).toBe(0);
    expect(changedTotal(moved)).toBeGreaterThan(0);
    expect(moved.changed[OWNER_TRANSITION]).toBeGreaterThan(0);
  });

  it("is idempotent: a second run changes no row and never doubles stock", async () => {
    expect(again.changed[OWNER_TRANSITION]).toBe(0);
    // (overwrite rewrites descriptive content, so products and variants count as written — their state does not move)
    for (const table of ["stock_levels", "stock_movements", "serials", "cost_layers", "variant_costs"]) expect(again.changed[table] ?? 0, table).toBe(0);
    expect(await snapshot(prod.d1)).toEqual(afterMove);
  });
});

// ───────────────────────────────────────────────────────────────── the SQL file production gets

describe("owner's sheet: the SQL file (npm run db:owner-sheet)", () => {
  it("moves a demo-seeded database to the same state as the direct run, and can be applied twice", async () => {
    // the file: recorded on an empty database (scripts/seed.ts --sql), reference + owner seed with overwrite
    const scratch = await createTestDb({ seed: false });
    const target = await createTestDb();
    const direct = await createTestDb();
    try {
      const recorded: RecordedStatement[] = [];
      const recording = createDb(recordWrites(scratch.d1, recorded));
      await seedReference(recording, TEST_NOW);
      await seedDemo(recording, TEST_NOW, { catalog, ownerSheet: true, overwrite: true });
      const statements = recorded.map(statementToSql);
      // D1-friendly: one line each, no compound SELECT
      expect(statements.every((line) => !/\bunion\b/i.test(line) && Buffer.byteLength(line, "utf8") < 100_000)).toBe(true);

      // a production-like database: the demo catalogue; and the same database moved by the direct seed
      await seedDemo(target.db, TEST_NOW - 86_400_000, { catalog });
      await seedDemo(direct.db, TEST_NOW - 86_400_000, { catalog });
      await seedDemo(direct.db, TEST_NOW, { catalog, ownerSheet: true, overwrite: true });

      const apply = async () => {
        for (let start = 0; start < statements.length; start += 50) await target.d1.batch(statements.slice(start, start + 50).map((line) => target.d1.prepare(line)));
      };
      await apply();
      const once = await snapshot(target.d1);
      expect(once).toEqual(await snapshot(direct.d1));
      await apply();
      expect(await snapshot(target.d1)).toEqual(once);
    } finally {
      await scratch.dispose();
      await target.dispose();
      await direct.dispose();
    }
  }, 300_000);
});
