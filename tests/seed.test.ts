/**
 * The DEMO catalogue seed (app/server/db/seed/demo.ts) against a real, throw-away D1:
 * it is idempotent, flags everything it can as demo, creates no people or orders, and what it
 * writes is internally consistent (stock ↔ movements ↔ serials, pictures ↔ art catalogue,
 * compatibility ↔ catalogue, trees ↔ articles) and complete in Arabic, English and Kurdish.
 * Also covers the SQL-file path used for `wrangler d1 execute --remote --file`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "~/server/db/drizzle.server";
import { normalizeSearchText, searchProductIds } from "~/server/db/search.server";
import { assertDemoDataConsistent, demoId, demoSerialsOf, placeholderCost, seedDemo, type SeedDemoResult } from "~/server/db/seed/demo";
import { DEMO_CATEGORIES } from "~/server/db/seed/demo/categories";
import { DEMO_COMPATIBILITY, DEMO_RELATIONS } from "~/server/db/seed/demo/compatibility";
import { DEMO_DEVICE_MODELS, DEMO_GENERATIONS, DEMO_PLATFORMS } from "~/server/db/seed/demo/devices";
import { DEMO_ARTICLES } from "~/server/db/seed/demo/knowledge";
import { DEMO_PRODUCTS, DEMO_VARIANTS } from "~/server/db/seed/demo/products";
import { DEMO_SYNONYM_GROUPS } from "~/server/db/seed/demo/search";
import { inlineParams, recordWrites, sqlLiteral, statementToSql, toSqlScript, type RecordedStatement } from "~/server/db/seed/demo/sql";
import { DEMO_TREES } from "~/server/db/seed/demo/trees";
import { DEMO_TRADE_IN_GUIDES, DEMO_USED_UNITS, TRADE_IN_GRADE_MULTIPLIERS } from "~/server/db/seed/demo/used";
import { DEFAULT_LOCATION_ID, seedReference } from "~/server/db/seed/reference";
import { createTestDb, type TestDb } from "./helpers/db";
import { PROJECT_ROOT, applyMigrations, dropEverything } from "./helpers/migrations";

// ───────────────────────────────────────────────────────────────── the art catalogue

type ArtCatalog = { items: Array<{ key: string; group: string; views: string[] }>; games: { items: Array<{ slug: string; platform: string }> }; platformColors: Record<string, string> };
const catalog = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "scripts/art/catalog.json"), "utf8")) as ArtCatalog;
/** Every name `media.art_key` may hold: "switch-2", "switch-2@front", "game-mario-kart-world"… */
const artNames = new Set<string>([
  ...catalog.items.flatMap((item) => item.views.map((view) => (view === "hero" ? item.key : `${item.key}@${view}`))),
  ...catalog.games.items.map((game) => `game-${game.slug}`),
]);

// ───────────────────────────────────────────────────────────────── helpers

const USER_TABLES =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'search\\_index\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name";

async function countAll(d1: D1Database): Promise<Record<string, number>> {
  const names = (await d1.prepare(USER_TABLES).all<{ name: string }>()).results.map((row) => row.name);
  const counts: Record<string, number> = {};
  for (let start = 0; start < names.length; start += 50) {
    const part = names.slice(start, start + 50);
    const results = await d1.batch<{ n: number }>(part.map((name) => d1.prepare(`SELECT count(*) AS n FROM "${name}"`)));
    part.forEach((name, index) => (counts[name] = results[index].results[0].n));
  }
  return counts;
}

let t: TestDb;
let before: Record<string, number>;
let first: SeedDemoResult;
let afterFirst: Record<string, number>;
let second: SeedDemoResult;
let afterSecond: Record<string, number>;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const scalar = async (query: string, ...params: unknown[]): Promise<number> => Number(Object.values((await rows(query, ...params))[0] ?? { n: 0 })[0]);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

type L10nValue = { ar?: string; en?: string; ckb?: string };

beforeAll(async () => {
  t = await createTestDb();
  before = await countAll(t.d1);
  first = await seedDemo(t.db, t.now);
  afterFirst = await countAll(t.d1);
  second = await seedDemo(t.db, t.now + 60_000);
  afterSecond = await countAll(t.d1);
});

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── definitions (no database)

describe("demo seed definitions", () => {
  it("are consistent with each other", () => {
    expect(() => assertDemoDataConsistent()).not.toThrow();
  });

  it("hold about 50 products of every kind the brief lists", () => {
    const byKind = Object.groupBy(DEMO_PRODUCTS, (product) => product.kind);
    expect(DEMO_PRODUCTS.length).toBe(51);
    expect(Object.fromEntries(Object.entries(byKind).map(([kind, list]) => [kind, list?.length]))).toEqual({
      console: 11,
      controller: 6,
      headset: 2,
      storage: 4,
      accessory: 6,
      game: 16,
      digital: 3,
      part: 3,
    });
    expect(DEMO_VARIANTS.length).toBeGreaterThanOrEqual(70);
  });

  it("cover the eleven device models and the ten categories of the task", () => {
    expect(DEMO_PLATFORMS.map((platform) => platform.slug)).toEqual(["nintendo", "playstation", "xbox", "handheld"]);
    expect(DEMO_DEVICE_MODELS.map((model) => model.slug)).toEqual([
      "switch-2", "switch-oled", "switch-lite", "ps5-slim", "ps5-pro", "ps-portal", "xbox-series-x", "xbox-series-s", "steam-deck-oled", "rog-ally-x", "legion-go",
    ]);
    expect(DEMO_CATEGORIES.filter((category) => !category.parent).map((category) => category.slug)).toEqual([
      "consoles", "handheld-pcs", "games", "controllers", "headsets", "storage", "accessories", "digital-cards", "parts", "used-devices",
    ]);
    // Every console product is one of the device models, and every device model is sold.
    const sold = new Set(DEMO_PRODUCTS.filter((product) => product.kind === "console").map((product) => product.deviceModel));
    expect([...sold].sort()).toEqual(DEMO_DEVICE_MODELS.map((model) => model.slug).sort());
  });

  it("take platform accents from the art catalogue", () => {
    for (const platform of DEMO_PLATFORMS) {
      expect(Object.keys(catalog.platformColors), platform.slug).toContain(platform.accent);
      expect(platform.accent).toBe(platform.slug);
    }
  });

  it("use every picture of the art catalogue, and only pictures that exist in it", () => {
    const used = new Set<string>();
    for (const product of DEMO_PRODUCTS) for (const name of [...product.art, ...product.variants.flatMap((variant) => variant.art ?? [])]) used.add(name);
    for (const model of DEMO_DEVICE_MODELS) used.add(model.artKey);
    for (const name of used) expect(artNames, name).toContain(name);
    for (const category of DEMO_CATEGORIES) expect(artNames, category.slug).toContain(category.artKey);
    for (const platform of DEMO_PLATFORMS) expect(artNames, platform.slug).toContain(platform.artKey);
    // "Cover the controllers, headsets, storage and accessories in the catalogue" — and everything else in it.
    const unused = catalog.items.map((item) => item.key).filter((key) => !used.has(key));
    expect(unused).toEqual([]);
    // The 16 physical games are exactly the catalogue's games, on the catalogue's platforms.
    const games = DEMO_PRODUCTS.filter((product) => product.kind === "game");
    expect(games.map((game) => game.slug).sort()).toEqual(catalog.games.items.map((game) => game.slug).sort());
    for (const game of games) expect(game.platform, game.slug).toBe(catalog.games.items.find((entry) => entry.slug === game.slug)?.platform);
  });

  it("price everything in whole IQD rounded to 250, with reduced prices only where a deal is shown", () => {
    for (const { variant } of DEMO_VARIANTS) {
      expect(variant.priceIqd % 250, variant.sku).toBe(0);
      expect(variant.priceIqd, variant.sku).toBeGreaterThan(0);
      if (variant.compareAtIqd !== undefined) expect(variant.compareAtIqd, variant.sku).toBeGreaterThan(variant.priceIqd);
    }
    const deals = DEMO_VARIANTS.filter(({ variant }) => variant.compareAtIqd !== undefined);
    expect(deals.length).toBeGreaterThanOrEqual(3);
    expect(deals.length).toBeLessThanOrEqual(8);
  });

  it("derive placeholder costs that respect the minimum margin, also for reduced prices", () => {
    for (const { product, variant } of DEMO_VARIANTS) {
      if (variant.cost === false || variant.bundle) continue;
      const cost = placeholderCost(product.kind, variant.priceIqd, variant.compareAtIqd);
      const marginBps = Math.floor(((variant.priceIqd - cost.landedCostIqd) * 10_000) / variant.priceIqd);
      expect(cost.landedCostIqd % 250, variant.sku).toBe(0);
      expect(cost.unitCostMinor, variant.sku).toBeGreaterThan(0);
      expect(marginBps, variant.sku).toBeGreaterThanOrEqual(cost.minMarginBps);
    }
  });

  it("keep Arabic and Kurdish text in their own letters", () => {
    // Kurdish-only letters in an Arabic string, or Arabic-only letters in a Kurdish string, are typing slips.
    const kurdishOnly = /[کیەێۆڕڵ]/u;
    const arabicOnly = /[كيةى]/u;
    const problems: string[] = [];
    const visit = (value: unknown, trail: string) => {
      if (Array.isArray(value)) return value.forEach((entry, index) => visit(entry, `${trail}[${index}]`));
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (typeof record.ar === "string" && typeof record.ckb === "string" && typeof record.en === "string") {
        if (kurdishOnly.test(record.ar)) problems.push(`${trail}.ar has Kurdish letters: ${record.ar}`);
        if (arabicOnly.test(record.ckb)) problems.push(`${trail}.ckb has Arabic letters: ${record.ckb}`);
        if (/[؀-ۿ]/u.test(record.en)) problems.push(`${trail}.en has Arabic-script letters: ${record.en}`);
        for (const locale of ["ar", "en", "ckb"] as const) if (!String(record[locale]).trim()) problems.push(`${trail}.${locale} is empty`);
        return;
      }
      for (const [key, entry] of Object.entries(record)) visit(entry, `${trail}.${key}`);
    };
    visit({ DEMO_PLATFORMS, DEMO_GENERATIONS, DEMO_DEVICE_MODELS, DEMO_CATEGORIES, DEMO_PRODUCTS, DEMO_COMPATIBILITY, DEMO_USED_UNITS, DEMO_ARTICLES, DEMO_TREES }, "seed");
    expect(problems).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── idempotency and scope

describe("seedDemo", () => {
  it("writes exactly the rows it defines, in one transaction", () => {
    for (const [table, defined] of Object.entries(first.rows)) {
      expect(afterFirst[table] - (before[table] ?? 0), table).toBe(defined);
      expect(first.changed[table], `${table} changed`).toBe(defined);
    }
    // …and touches no other table.
    for (const table of Object.keys(afterFirst)) {
      if (!(table in first.rows)) expect(afterFirst[table], table).toBe(before[table]);
    }
    expect(first.statements).toBeGreaterThan(100);
  });

  it("runs a second time without error, duplicates or changes", () => {
    expect(afterSecond).toEqual(afterFirst);
    expect(second.rows).toEqual(first.rows);
    for (const [table, changed] of Object.entries(second.changed)) expect(changed, table).toBe(0);
  });

  it("reports counts per table", () => {
    expect(first.rows).toMatchObject({
      platforms: 4,
      device_generations: 7,
      device_models: 11,
      categories: 16,
      products: 51,
      variants: DEMO_VARIANTS.length,
      bundle_items: 2,
      stock_levels: DEMO_VARIANTS.length,
      search_synonyms: DEMO_SYNONYM_GROUPS.length * 3,
      search_index: 51 * 3,
      used_units: 6,
      trade_in_price_guides: 11,
      fx_rates: 1,
      coupons: 2,
      knowledge_articles: 8,
      troubleshooting_trees: 2,
    });
  });

  it("flags every row that has an is_demo column", async () => {
    const tables = await rows<{ name: string }>("SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'is_demo' WHERE m.type = 'table' ORDER BY m.name");
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(["products", "used_units", "fx_rates", "coupons", "knowledge_articles", "troubleshooting_trees"]));
    const withRows: string[] = [];
    for (const { name } of tables) {
      expect(await scalar(`SELECT count(*) FROM "${name}" WHERE is_demo IS NOT 1`), `${name} has rows that are not flagged`).toBe(0);
      if ((await scalar(`SELECT count(*) FROM "${name}"`)) > 0) withRows.push(name);
    }
    expect(withRows.sort()).toEqual(["coupons", "fx_rates", "knowledge_articles", "products", "troubleshooting_trees", "used_units"]);
    // Tables without the column say so in words.
    expect(await scalar("SELECT count(*) FROM stock_movements WHERE ref_type <> 'demo_seed' OR reason NOT LIKE '%DEMO%'")).toBe(0);
    expect(await scalar("SELECT count(*) FROM serials WHERE source_ref <> 'demo_seed' OR notes NOT LIKE '%DEMO%' OR serial NOT LIKE 'DEMO-%'")).toBe(0);
  });

  it("creates no reviews, ratings, customers, orders, employees or accounts", async () => {
    for (const table of [
      "reviews", "customers", "guest_contacts", "addresses", "customer_sessions", "carts", "orders", "order_items", "payments", "payment_proofs",
      "wallet_ledger", "loyalty_ledger", "employees", "employee_roles", "employee_sessions", "trade_ins", "repair_tickets", "support_tickets",
      "digital_codes", "price_changes", "product_versions", "audit_events", "journal_entries",
    ]) {
      expect(afterSecond[table], table).toBe(0);
    }
  });

  it("restores descriptive content with overwrite, and never prices, stock or a unit's status", async () => {
    const productId = demoId.product("nintendo-switch-2");
    const variantId = demoId.variant("NSW2-CON-256");
    const unitId = demoId.usedUnit("used-ps5-slim-disc-01");
    await t.d1.batch([
      t.d1.prepare(`UPDATE products SET name = '{"ar":"اسم معدّل"}', status = 'archived' WHERE id = ?`).bind(productId),
      t.d1.prepare("UPDATE variants SET price_iqd = 700000 WHERE id = ?").bind(variantId),
      t.d1.prepare("UPDATE stock_levels SET on_hand = 9 WHERE variant_id = ?").bind(variantId),
      t.d1.prepare("UPDATE used_units SET status = 'sold', price_iqd = 500000 WHERE id = ?").bind(unitId),
      t.d1.prepare("UPDATE fx_rates SET iqd_per_unit = 1500").bind(),
      t.d1.prepare("DELETE FROM search_index WHERE product_id = ? AND locale = 'ckb'").bind(productId),
      t.d1.prepare("UPDATE search_index SET name = 'edited in admin' WHERE product_id = ? AND locale = 'ar'").bind(productId),
    ]);

    // Without overwrite nothing that exists is touched; only the missing index row comes back.
    const plain = await seedDemo(t.db, t.now + 120_000);
    expect(Object.entries(plain.changed).filter(([, changed]) => changed > 0)).toEqual([["search_index", 1]]);
    expect(await rows("SELECT name, status FROM products WHERE id = ?", productId)).toEqual([{ name: '{"ar":"اسم معدّل"}', status: "archived" }]);
    expect(await rows("SELECT locale, name FROM search_index WHERE product_id = ? ORDER BY locale", productId)).toEqual([
      { locale: "ar", name: "edited in admin" },
      { locale: "ckb", name: "nintendo switch 2" },
      { locale: "en", name: "nintendo switch 2" },
    ]);

    const restored = await seedDemo(t.db, t.now + 180_000, { overwrite: true });
    expect(restored.overwrite).toBe(true);
    expect(await countAll(t.d1)).toEqual(afterFirst);
    const product = (await rows<{ name: string; status: string; created_at: number }>("SELECT name, status, created_at FROM products WHERE id = ?", productId))[0];
    expect(parse<L10nValue>(product.name)).toEqual({ ar: "Nintendo Switch 2", en: "Nintendo Switch 2", ckb: "Nintendo Switch 2" });
    expect(product.status).toBe("published");
    expect(product.created_at).toBe(t.now);
    expect(await rows("SELECT name FROM search_index WHERE product_id = ? AND locale = 'ar'", productId)).toEqual([{ name: "nintendo switch 2" }]);
    // Money, stock and state are not the seed's to reset.
    expect(await scalar("SELECT price_iqd FROM variants WHERE id = ?", variantId)).toBe(700_000);
    expect(await scalar("SELECT on_hand FROM stock_levels WHERE variant_id = ?", variantId)).toBe(9);
    expect(await rows("SELECT status, price_iqd FROM used_units WHERE id = ?", unitId)).toEqual([{ status: "sold", price_iqd: 500_000 }]);
    expect(await scalar("SELECT iqd_per_unit FROM fx_rates")).toBe(1500);

    // Put the fixture back for the tests below.
    await t.d1.batch([
      t.d1.prepare("UPDATE variants SET price_iqd = 675000 WHERE id = ?").bind(variantId),
      t.d1.prepare("UPDATE stock_levels SET on_hand = 4 WHERE variant_id = ?").bind(variantId),
      t.d1.prepare("UPDATE used_units SET status = 'listed', price_iqd = 560000 WHERE id = ?").bind(unitId),
      t.d1.prepare("UPDATE fx_rates SET iqd_per_unit = 1310").bind(),
    ]);
  });
});

// ───────────────────────────────────────────────────────────────── catalogue

describe("seeded catalogue", () => {
  it("gives every product a default variant, a price, a picture from the art catalogue and a name in three languages", async () => {
    const products = await rows<{ id: string; slug: string; name: string; short: string; description: string; status: string; category_id: string | null }>(
      "SELECT id, slug, name, short, description, status, category_id FROM products",
    );
    expect(products.length).toBe(51);
    for (const product of products) {
      const variants = await rows<{ sku: string; price_iqd: number; is_default: number; compare_at_iqd: number | null }>("SELECT sku, price_iqd, is_default, compare_at_iqd FROM variants WHERE product_id = ? ORDER BY sort", product.id);
      expect(variants.length, product.slug).toBeGreaterThan(0);
      expect(variants.filter((variant) => variant.is_default === 1).length, `${product.slug} default variant`).toBe(1);
      expect(variants[0].is_default, `${product.slug}: the first variant is the default`).toBe(1);
      for (const variant of variants) {
        expect(variant.price_iqd, variant.sku).toBeGreaterThan(0);
        expect(variant.price_iqd % 250, variant.sku).toBe(0);
      }
      const pictures = await rows<{ art_key: string | null; is_illustration: number; kind: string; file_id: string | null }>(
        "SELECT art_key, is_illustration, kind, file_id FROM media WHERE owner_type = 'product' AND owner_id = ? ORDER BY sort",
        product.id,
      );
      expect(pictures.length, `${product.slug} pictures`).toBeGreaterThan(0);
      expect(pictures.some((picture) => picture.art_key !== null && artNames.has(picture.art_key)), `${product.slug} art`).toBe(true);
      for (const text of [product.name, product.short, product.description]) {
        const value = parse<L10nValue>(text);
        for (const locale of ["ar", "en", "ckb"] as const) expect(value[locale]?.trim(), `${product.slug} ${locale}`).toBeTruthy();
      }
      expect(product.status).toBe("published");
      expect(product.category_id, product.slug).not.toBeNull();
    }
  });

  it("flags every picture as an illustration from the art catalogue", async () => {
    const pictures = await rows<{ id: string; owner_type: string; art_key: string | null; is_illustration: number; kind: string; file_id: string | null; alt: string }>("SELECT * FROM media");
    expect(pictures.length).toBe(first.rows.media);
    for (const picture of pictures) {
      expect(picture.art_key && artNames.has(picture.art_key), `${picture.id}: ${picture.art_key}`).toBe(true);
      expect([picture.is_illustration, picture.kind, picture.file_id], picture.id).toEqual([1, "render", null]);
      const alt = parse<L10nValue>(picture.alt);
      expect(alt.ar && alt.en && alt.ckb, picture.id).toBeTruthy();
    }
    expect(new Set(pictures.map((picture) => picture.owner_type))).toEqual(new Set(["product", "variant", "device_model", "used_unit"]));
    for (const table of ["platforms", "device_models", "categories"]) {
      for (const row of await rows<{ art_key: string | null }>(`SELECT art_key FROM ${table}`)) expect(row.art_key && artNames.has(row.art_key), `${table}: ${row.art_key}`).toBe(true);
    }
  });

  it("stores complete localized text everywhere", async () => {
    const columns: Array<[table: string, column: string]> = [
      ["platforms", "name"], ["device_generations", "name"], ["device_models", "name"], ["device_models", "summary"], ["categories", "name"], ["categories", "description"],
      ["products", "name"], ["products", "short"], ["products", "description"], ["products", "search_keywords"], ["variants", "title"], ["media", "alt"],
      ["compatibility_rules", "note"], ["used_units", "cosmetic_notes"], ["knowledge_articles", "title"], ["knowledge_articles", "summary"], ["troubleshooting_trees", "title"],
    ];
    for (const [table, column] of columns) {
      const incomplete = await scalar(
        `SELECT count(*) FROM ${table} WHERE ${column} IS NOT NULL AND (coalesce(json_extract(${column}, '$.ar'), '') = '' OR coalesce(json_extract(${column}, '$.en'), '') = '' OR coalesce(json_extract(${column}, '$.ckb'), '') = '')`,
      );
      expect(incomplete, `${table}.${column}`).toBe(0);
    }
    expect(await scalar("SELECT count(*) FROM products WHERE name IS NULL OR short IS NULL OR description IS NULL OR search_keywords IS NULL")).toBe(0);
  });

  it("builds the device graph with published models and their specifications", async () => {
    const models = await rows<{ slug: string; status: string; specs: string; released_on: string; device_kind: string; platform: string; generation: string }>(
      "SELECT m.slug, m.status, m.specs, m.released_on, m.device_kind, p.slug AS platform, g.slug AS generation FROM device_models m JOIN platforms p ON p.id = m.platform_id JOIN device_generations g ON g.id = m.generation_id ORDER BY m.sort",
    );
    expect(models.map((model) => model.slug)).toEqual(DEMO_DEVICE_MODELS.map((model) => model.slug));
    for (const model of models) {
      expect(model.status).toBe("published");
      expect(model.released_on).toMatch(/^\d{4}(-\d{2}-\d{2})?$/);
      expect(Object.keys(parse<Record<string, unknown>>(model.specs)).length, model.slug).toBeGreaterThanOrEqual(6);
    }
    expect(models.filter((model) => model.device_kind === "handheld_pc").map((model) => model.slug)).toEqual(["steam-deck-oled", "rog-ally-x", "legion-go"]);
    const specs = Object.fromEntries(models.map((model) => [model.slug, parse<Record<string, unknown>>(model.specs)]));
    expect(specs["switch-2"]).toMatchObject({ display_in: 7.9, storage_gb: 256, battery_mah: 5220 });
    expect(specs["ps5-pro"]).toMatchObject({ storage_gb: 2000, ram_gb: 16 });
    expect(specs["steam-deck-oled"]).toMatchObject({ display_type: "OLED", battery_wh: 50, ram_gb: 16 });
    // Console products carry their model's sheet plus what is in the box.
    const consoleSpecs = parse<Record<string, unknown>>((await rows<{ specs: string }>("SELECT specs FROM products WHERE slug = 'xbox-series-x'"))[0].specs);
    expect(consoleSpecs).toMatchObject({ storage_gb: 1000, disc_drive: "4K UHD Blu-ray" });
    expect(consoleSpecs.in_box).toBeTruthy();
  });

  it("links the category tree and files every product under a leaf", async () => {
    expect(await scalar("SELECT count(*) FROM categories WHERE parent_id IS NULL")).toBe(10);
    expect(await scalar("SELECT count(*) FROM categories c WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.id = c.parent_id)")).toBe(0);
    // No product sits on a category that has children (it would be missing from the child pages).
    expect(await scalar("SELECT count(*) FROM products p WHERE EXISTS (SELECT 1 FROM categories c WHERE c.parent_id = p.category_id)")).toBe(0);
    const perTop = await rows<{ slug: string; n: number }>(
      "SELECT top.slug, count(p.id) AS n FROM categories top LEFT JOIN categories c ON c.id = top.id OR c.parent_id = top.id LEFT JOIN products p ON p.category_id = c.id WHERE top.parent_id IS NULL GROUP BY top.id ORDER BY top.sort",
    );
    expect(Object.fromEntries(perTop.map((row) => [row.slug, row.n]))).toEqual({
      consoles: 8, "handheld-pcs": 3, games: 16, controllers: 6, headsets: 2, storage: 4, accessories: 6, "digital-cards": 3, parts: 3, "used-devices": 0,
    });
  });

  it("sells the Switch 2 bundle as a variant made of the console and Mario Kart World", async () => {
    const bundle = demoId.variant("NSW2-BUNDLE-MKW");
    const components = await rows<{ sku: string; qty: number; price_iqd: number }>(
      "SELECT v.sku, b.qty, v.price_iqd FROM bundle_items b JOIN variants v ON v.id = b.component_variant_id WHERE b.bundle_variant_id = ? ORDER BY v.sku",
      bundle,
    );
    expect(components.map((component) => [component.sku, component.qty])).toEqual([["NSW2-CON-256", 1], ["NSW2-MKW", 1]]);
    const bundleRow = (await rows<{ price_iqd: number; track_serials: number; product: string }>("SELECT v.price_iqd, v.track_serials, p.slug AS product FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?", bundle))[0];
    expect(bundleRow.product).toBe("nintendo-switch-2");
    expect(bundleRow.track_serials).toBe(0);
    expect(bundleRow.price_iqd).toBeLessThan(components.reduce((sum, component) => sum + component.price_iqd * component.qty, 0));
    // The bundle has no stock or cost of its own: both come from its components.
    expect(await scalar("SELECT on_hand FROM stock_levels WHERE variant_id = ?", bundle)).toBe(0);
    expect(await scalar("SELECT count(*) FROM variant_costs WHERE variant_id = ?", bundle)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── stock, serials, costs

describe("seeded stock", () => {
  it("has a level at the main location for every variant, explained by its opening movements", async () => {
    expect(await scalar("SELECT count(*) FROM variants v WHERE NOT EXISTS (SELECT 1 FROM stock_levels s WHERE s.variant_id = v.id AND s.location_id = ?)", DEFAULT_LOCATION_ID)).toBe(0);
    const mismatches = await rows(
      "SELECT v.sku, s.on_hand, coalesce((SELECT sum(m.qty_delta) FROM stock_movements m WHERE m.variant_id = v.id AND m.location_id = s.location_id), 0) AS moved FROM stock_levels s JOIN variants v ON v.id = s.variant_id WHERE s.on_hand <> moved",
    );
    expect(mismatches).toEqual([]);
    expect(await scalar("SELECT count(*) FROM stock_levels WHERE reserved <> 0 OR incoming <> 0 OR allow_oversell <> 0")).toBe(0);
    expect(await scalar("SELECT count(*) FROM stock_movements WHERE kind <> 'adjust' OR actor_kind <> 'system' OR qty_delta <= 0")).toBe(0);
  });

  it("shows in-stock, low-stock and out-of-stock items", async () => {
    const states = await rows<{ sku: string; kind: string; on_hand: number; reorder_point: number | null }>(
      "SELECT v.sku, p.kind, s.on_hand, s.reorder_point FROM stock_levels s JOIN variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id",
    );
    const physical = states.filter((row) => row.reorder_point !== null);
    const out = physical.filter((row) => row.on_hand === 0).map((row) => row.sku);
    const low = physical.filter((row) => row.on_hand > 0 && row.on_hand <= (row.reorder_point ?? 0)).map((row) => row.sku);
    expect(out.sort()).toEqual(["DS-RED", "NSW-LITE-TRQ", "PS5-GOY", "SEC-2TB", "XSS-1TB-WHT"]);
    expect(low.sort()).toEqual(["NSW2-PLZA-ED", "NSW2-PRO", "PART-SDO-BATT", "PS5-ER", "PS5-PRO-2TB", "PSSD-2TB", "SDO-1TB", "XSX-1TB-BLK", "XWC-BLU"]);
    expect(physical.length - out.length - low.length).toBeGreaterThan(40);
    // Digital top-ups have no codes loaded, so nothing is on hand.
    expect(states.filter((row) => row.kind === "digital").every((row) => row.on_hand === 0 && row.reorder_point === null)).toBe(true);
  });

  it("tracks consoles and handhelds by serial, one in-stock serial per unit on hand", async () => {
    const tracked = await rows<{ sku: string; kind: string; on_hand: number; serials: number }>(
      "SELECT v.sku, p.kind, s.on_hand, (SELECT count(*) FROM serials x WHERE x.variant_id = v.id AND x.source = 'purchase' AND x.status = 'in_stock') AS serials FROM variants v JOIN products p ON p.id = v.product_id JOIN stock_levels s ON s.variant_id = v.id WHERE v.track_serials = 1",
    );
    expect(tracked.length).toBe(15);
    for (const row of tracked) {
      expect(row.kind, row.sku).toBe("console");
      expect(row.serials, row.sku).toBe(row.on_hand);
    }
    expect(await scalar("SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id WHERE p.kind <> 'console' AND v.track_serials = 1")).toBe(0);
    expect(await scalar("SELECT count(*) FROM serials")).toBe(tracked.reduce((sum, row) => sum + row.on_hand, 0) + DEMO_USED_UNITS.length);
    expect((await rows<{ serial: string }>("SELECT serial FROM serials WHERE variant_id = ? AND source = 'purchase' ORDER BY serial", demoId.variant("PS5-SLIM-DISC"))).map((row) => row.serial)).toEqual(demoSerialsOf("PS5-SLIM-DISC", 5));
    // Each serial has its own opening movement.
    expect(await scalar("SELECT count(*) FROM serials x WHERE x.source = 'purchase' AND (SELECT count(*) FROM stock_movements m WHERE m.serial_id = x.id AND m.qty_delta = 1) <> 1")).toBe(0);
  });

  it("gives most variants a cost with a margin above the minimum, and matching cost layers", async () => {
    const total = await scalar("SELECT count(*) FROM variants");
    const costed = await scalar("SELECT count(*) FROM variant_costs");
    expect(costed / total).toBeGreaterThan(0.85);
    expect(costed).toBeLessThan(total);
    const bad = await rows(
      "SELECT v.sku FROM variant_costs c JOIN variants v ON v.id = c.variant_id WHERE c.landed_cost_iqd <= 0 OR c.landed_cost_iqd >= v.price_iqd OR (v.price_iqd - c.landed_cost_iqd) * 10000 / v.price_iqd < c.min_margin_bps OR c.currency <> 'USD' OR c.fx_rate_micros <> 1310000000 OR c.unit_cost_minor <= 0",
    );
    expect(bad).toEqual([]);
    // FIFO layers: one opening layer per costed variant that has stock, holding exactly what is on hand.
    const layerMismatch = await rows(
      "SELECT v.sku FROM variant_costs c JOIN variants v ON v.id = c.variant_id JOIN stock_levels s ON s.variant_id = v.id LEFT JOIN cost_layers l ON l.variant_id = v.id WHERE (s.on_hand > 0 AND (l.id IS NULL OR l.qty_remaining <> s.on_hand OR l.unit_cost_iqd <> c.landed_cost_iqd OR l.source <> 'opening')) OR (s.on_hand = 0 AND l.id IS NOT NULL)",
    );
    expect(layerMismatch).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── compatibility and relations

describe("seeded compatibility", () => {
  const status = async (subject: string, target: string) => (await rows<{ status: string }>("SELECT status FROM compatibility_rules WHERE subject_id = ? AND target_id = ?", subject, target))[0]?.status ?? null;

  it("points every rule at a real subject and target", async () => {
    expect(await scalar("SELECT count(*) FROM compatibility_rules")).toBe(DEMO_COMPATIBILITY.length);
    expect(await scalar("SELECT count(*) FROM compatibility_rules r WHERE (r.subject_type = 'product' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = r.subject_id)) OR (r.subject_type = 'variant' AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.id = r.subject_id))")).toBe(0);
    expect(
      await scalar(
        "SELECT count(*) FROM compatibility_rules r WHERE (r.target_type = 'device_model' AND NOT EXISTS (SELECT 1 FROM device_models m WHERE m.id = r.target_id)) OR (r.target_type = 'generation' AND NOT EXISTS (SELECT 1 FROM device_generations g WHERE g.id = r.target_id)) OR (r.target_type = 'platform' AND NOT EXISTS (SELECT 1 FROM platforms p WHERE p.id = r.target_id))",
      ),
    ).toBe(0);
    const byStatus = await rows<{ status: string; n: number }>("SELECT status, count(*) AS n FROM compatibility_rules GROUP BY status");
    expect(byStatus.map((row) => row.status).sort()).toEqual(["incompatible", "partial", "unverified", "verified"]);
    const targets = await rows<{ target_type: string }>("SELECT DISTINCT target_type FROM compatibility_rules ORDER BY target_type");
    expect(targets.map((row) => row.target_type)).toEqual(["device_model", "generation", "platform"]);
  });

  it("states the facts the task lists", async () => {
    const product = demoId.product;
    const model = demoId.deviceModel;
    expect(await status(product("dualsense-wireless-controller"), model("ps5-slim"))).toBe("verified");
    expect(await status(product("dualsense-wireless-controller"), model("ps5-pro"))).toBe("verified");
    expect(await status(product("xbox-wireless-controller"), demoId.generation("xbox-series"))).toBe("verified");
    expect(await status(product("sandisk-microsd-express"), model("switch-2"))).toBe("verified");
    expect(await status(product("sandisk-microsd-express"), model("switch-oled"))).toBe("partial");
    expect(await status(product("sandisk-microsd-express"), model("switch-lite"))).toBe("partial");
    expect(await status(product("wd-black-sn850x-nvme-ssd-heatsink"), model("ps5-slim"))).toBe("verified");
    expect(await status(product("seagate-storage-expansion-card-xbox"), demoId.generation("xbox-series"))).toBe("verified");
    expect(await status(product("joy-con-2-pair"), model("switch-2"))).toBe("verified");
    expect(await status(product("joy-con-2-pair"), model("switch-oled"))).toBe("incompatible");
    // A disc cannot be read by a console without a drive.
    expect(await status(product("forza-horizon-5"), model("xbox-series-s"))).toBe("incompatible");
    expect(await status(product("spider-man-2"), model("ps5-pro"))).toBe("partial");
    // Editions of one game differ: rules sit on the variant.
    expect(await status(demoId.variant("NSW-TOTK"), model("switch-oled"))).toBe("verified");
    expect(await status(demoId.variant("NSW2-TOTK-ED"), model("switch-oled"))).toBe("incompatible");
    // Unknown pairs stay absent — never inferred.
    expect(await status(product("dualsense-wireless-controller"), model("ps-portal"))).toBeNull();
    expect(await status(product("xbox-wireless-controller"), model("steam-deck-oled"))).toBeNull();
    expect(await status(product("nintendo-switch-2-dock-set"), model("switch-oled"))).toBeNull();
  });

  it("explains everything that is not plainly verified, and claims no in-store testing", async () => {
    expect(await scalar("SELECT count(*) FROM compatibility_rules WHERE status <> 'verified' AND note IS NULL")).toBe(0);
    expect(await scalar("SELECT count(*) FROM compatibility_rules WHERE verified_by IS NOT NULL")).toBe(0);
    expect(await scalar("SELECT count(*) FROM compatibility_rules WHERE status = 'unverified' AND (verified_at IS NOT NULL OR source IS NOT NULL)")).toBe(0);
    expect(await scalar("SELECT count(*) FROM compatibility_rules WHERE status <> 'unverified' AND (verified_at IS NULL OR source NOT IN ('manufacturer', 'standard'))")).toBe(0);
    // Generic and third-party items are never presented as verified.
    const generic = await rows<{ slug: string; status: string }>(
      "SELECT p.slug, r.status FROM compatibility_rules r JOIN products p ON p.id = r.subject_id WHERE p.brand IS NULL",
    );
    expect(generic.length).toBeGreaterThan(0);
    expect(generic.every((row) => row.status === "unverified")).toBe(true);
  });

  it("never puts something incompatible on a console's setup shelf", async () => {
    expect(await scalar("SELECT count(*) FROM product_relations")).toBe(DEMO_RELATIONS.length);
    const shelves = await rows<{ console: string; model_id: string; generation_id: string; platform_id: string; related: string; related_id: string }>(
      "SELECT p.slug AS console, m.id AS model_id, m.generation_id, m.platform_id, q.slug AS related, q.id AS related_id FROM product_relations r JOIN products p ON p.id = r.product_id JOIN device_models m ON m.id = p.device_model_id JOIN products q ON q.id = r.related_product_id WHERE r.kind IN ('setup', 'accessory') AND p.kind = 'console'",
    );
    expect(new Set(shelves.map((row) => row.console)).size).toBe(11);
    for (const row of shelves) {
      const applicable = await rows<{ status: string; subject_type: string }>(
        "SELECT r.status, r.subject_type FROM compatibility_rules r WHERE (r.subject_id = ?1 OR r.subject_id IN (SELECT id FROM variants WHERE product_id = ?1)) AND r.target_id IN (?2, ?3, ?4)",
        row.related_id, row.model_id, row.generation_id, row.platform_id,
      );
      const productRules = applicable.filter((rule) => rule.subject_type === "product");
      const variantRules = applicable.filter((rule) => rule.subject_type === "variant");
      expect(productRules.some((rule) => rule.status === "incompatible"), `${row.console} → ${row.related}`).toBe(false);
      if (variantRules.length > 0) expect(variantRules.some((rule) => rule.status !== "incompatible"), `${row.console} → ${row.related}`).toBe(true);
    }
    const kinds = await rows<{ kind: string }>("SELECT DISTINCT kind FROM product_relations ORDER BY kind");
    expect(kinds.map((row) => row.kind)).toEqual(["accessory", "alternative", "setup", "upgrade", "upsell"]);
  });
});

// ───────────────────────────────────────────────────────────────── search

describe("seeded search", () => {
  const find = async (query: string) => (await searchProductIds(t.db, query, { limit: 100 })).map((hit) => hit.productId);

  it("indexes every product in the three languages", async () => {
    expect(await scalar("SELECT count(*) FROM search_index")).toBe(153);
    expect(await scalar("SELECT count(*) FROM products p WHERE (SELECT count(DISTINCT locale) FROM search_index s WHERE s.product_id = p.id) <> 3")).toBe(0);
    expect(await scalar("SELECT count(*) FROM search_index WHERE name = '' OR keywords = '' OR body = ''")).toBe(0);
  });

  it("stores normalized synonym sets per language", async () => {
    const synonyms = await rows<{ locale: string; term: string; synonyms: string }>("SELECT locale, term, synonyms FROM search_synonyms");
    expect(synonyms.length).toBe(DEMO_SYNONYM_GROUPS.length * 3);
    for (const row of synonyms) {
      expect(row.term, row.term).toBe(normalizeSearchText(row.term));
      const list = parse<string[]>(row.synonyms);
      expect(list.length, row.term).toBeGreaterThan(0);
      for (const entry of list) expect(entry, `${row.term} → ${entry}`).toBe(normalizeSearchText(entry));
      expect(list, row.term).not.toContain(row.term);
      expect(new Set(list).size, row.term).toBe(list.length);
    }
    expect(new Set(synonyms.map((row) => row.locale))).toEqual(new Set(["ar", "en", "ckb"]));
    const terms = (locale: string) => synonyms.filter((row) => row.locale === locale).map((row) => row.term);
    expect(terms("ar")).toEqual(expect.arrayContaining(["بلايستيشن", "سويتش", "اكس بوكس", "يد تحكم", "سماعه", "ذاكره", "مستعمل"].map(normalizeSearchText)));
    const playstation = synonyms.find((row) => row.locale === "ar" && row.term === normalizeSearchText("بلايستيشن"));
    expect(parse<string[]>(playstation!.synonyms)).toEqual(expect.arrayContaining(["بلي ستيشن", "سوني", "playstation"].map(normalizeSearchText)));
  });

  it("finds products by the words shoppers type, in any of the three languages", async () => {
    const product = demoId.product;
    expect(await find("بلي ستيشن")).toContain(product("playstation-5-slim"));
    expect(await find("PS5")).toEqual(expect.arrayContaining([product("playstation-5-slim"), product("playstation-5-pro")]));
    expect(await find("سويتش 2")).toContain(product("nintendo-switch-2"));
    expect(await find("اكس بوكس")).toEqual(expect.arrayContaining([product("xbox-series-x"), product("xbox-series-s")]));
    expect(await find("جوستك")).toEqual(expect.arrayContaining([product("dualsense-wireless-controller"), product("xbox-wireless-controller")]));
    expect(await find("كنترولر")).toContain(product("joy-con-2-pair"));
    expect(await find("هيدسيت")).toEqual(expect.arrayContaining([product("pulse-elite-wireless-headset"), product("xbox-wireless-headset")]));
    expect(await find("ميموري")).toContain(product("sandisk-microsd-express"));
    expect(await find("فيفا")).toEqual(expect.arrayContaining([product("ea-sports-fc-26-ps5"), product("ea-sports-fc-26-xbox")]));
    expect(await find("ماريو كارت")).toContain(product("mario-kart-world"));
    expect(await find("پلەیستەیشن")).toContain(product("playstation-5-slim"));
    expect(await find("دەسکی یاری")).toContain(product("dualsense-wireless-controller"));
    expect(await find("هێدسێت")).toContain(product("xbox-wireless-headset"));
    expect(await find("steam deck")).toContain(product("steam-deck-oled"));
    expect(await find("spider-man")).toContain(product("spider-man-2"));
    expect(await find("zzz-no-such-thing")).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── used devices

describe("seeded used devices", () => {
  it("lists six demo units across the four grades, with illustrations only", async () => {
    const units = await rows<{
      id: string; slug: string; grade: string; status: string; is_demo: number; battery_health_pct: number | null; price_iqd: number; acquisition_cost_iqd: number; warranty_days: number;
      checklist: string; included: string; defects: string; serial_source: string; serial_status: string; device_kind: string; new_price: number; listed_at: number; ownership_checked_at: number; data_wiped_at: number; trade_in_id: string | null;
    }>(
      "SELECT u.*, s.source AS serial_source, s.status AS serial_status, m.device_kind, v.price_iqd AS new_price FROM used_units u JOIN serials s ON s.id = u.serial_id JOIN variants v ON v.id = u.variant_id JOIN products p ON p.id = v.product_id JOIN device_models m ON m.id = p.device_model_id ORDER BY u.listed_at DESC",
    );
    expect(units.length).toBe(6);
    expect(units.map((unit) => unit.grade).sort()).toEqual(["A", "A", "A+", "B", "B", "C"]);
    for (const unit of units) {
      expect([unit.status, unit.is_demo, unit.serial_source, unit.serial_status, unit.trade_in_id], unit.slug).toEqual(["listed", 1, "trade_in", "in_stock", null]);
      expect(unit.price_iqd, unit.slug).toBeLessThan(unit.new_price);
      expect(unit.acquisition_cost_iqd, unit.slug).toBeLessThan(unit.price_iqd);
      expect(unit.price_iqd % 250, unit.slug).toBe(0);
      expect(unit.listed_at, unit.slug).toBeLessThanOrEqual(t.now);
      expect(unit.ownership_checked_at && unit.data_wiped_at, unit.slug).toBeTruthy();
      expect(parse<unknown[]>(unit.included).length, unit.slug).toBeGreaterThan(0);

      // The checklist is the reference seed's template for this kind of device, filled in completely.
      const checklist = parse<{ templateId: string; completedAt: number | null; items: Array<{ key: string; result: string | null; value?: unknown }> }>(unit.checklist);
      expect(checklist.templateId).toBe(unit.device_kind === "handheld_pc" ? "itpl_handheld_pc_v1" : "itpl_console_v1");
      expect(checklist.completedAt).not.toBeNull();
      const template = parse<Array<{ key: string; required: boolean; critical?: boolean; input: string }>>((await rows<{ items: string }>("SELECT items FROM inspection_templates WHERE id = ?", checklist.templateId))[0].items);
      expect(checklist.items.map((item) => item.key), unit.slug).toEqual(template.map((item) => item.key));
      for (const item of template) {
        const answer = checklist.items.find((entry) => entry.key === item.key)!;
        if (item.critical) expect(answer.result, `${unit.slug} ${item.key}`).toBe("pass");
        if (item.required) expect(answer.result, `${unit.slug} ${item.key}`).not.toBeNull();
        if (item.input === "text") expect(answer.value, `${unit.slug} ${item.key}`).toBeTruthy();
      }
      // Battery health is recorded exactly where the device has a battery.
      const batteryAnswer = checklist.items.find((entry) => entry.key === "battery");
      if (unit.battery_health_pct === null) expect(batteryAnswer?.result, unit.slug).toBe("na");
      else expect(batteryAnswer?.value, unit.slug).toBe(unit.battery_health_pct);

      const pictures = await rows<{ is_illustration: number; kind: string; file_id: string | null; art_key: string }>("SELECT is_illustration, kind, file_id, art_key FROM media WHERE owner_type = 'used_unit' AND owner_id = ?", unit.id);
      expect(pictures.length, unit.slug).toBeGreaterThan(0);
      expect(pictures.every((picture) => picture.is_illustration === 1 && picture.file_id === null && picture.kind === "render"), unit.slug).toBe(true);
    }
    const withBattery = units.filter((unit) => unit.battery_health_pct !== null).map((unit) => unit.slug).sort();
    expect(withBattery).toEqual(["used-legion-go-512-01", "used-steam-deck-oled-512-01", "used-switch-lite-turquoise-01", "used-switch-oled-white-01"]);
    // Lower grades disclose their faults.
    for (const unit of units.filter((entry) => entry.grade === "B" || entry.grade === "C")) expect(parse<unknown[]>(unit.defects).length, unit.slug).toBeGreaterThan(0);
  });

  it("has a trade-in price guide for every device model, and costs that follow it", async () => {
    const guides = await rows<{ slug: string; base_iqd: number; grade_multipliers: string; deductions: string; variant_id: string | null }>(
      "SELECT m.slug, g.base_iqd, g.grade_multipliers, g.deductions, g.variant_id FROM trade_in_price_guides g JOIN device_models m ON m.id = g.device_model_id",
    );
    expect(guides.map((guide) => guide.slug).sort()).toEqual(DEMO_DEVICE_MODELS.map((model) => model.slug).sort());
    for (const guide of guides) {
      expect(parse(guide.grade_multipliers)).toEqual({ "A+": 10_000, A: 9_000, B: 7_500, C: 5_500 });
      expect(guide.base_iqd % 250).toBe(0);
      expect(guide.variant_id).toBeNull();
    }
    for (const unit of DEMO_USED_UNITS) {
      const product = DEMO_VARIANTS.find((entry) => entry.variant.sku === unit.sku)!.product;
      const guide = DEMO_TRADE_IN_GUIDES.find((entry) => entry.deviceModel === product.deviceModel)!;
      const byGrade = (guide.baseIqd * TRADE_IN_GRADE_MULTIPLIERS[unit.grade]) / 10_000;
      expect(unit.acquisitionCostIqd, unit.slug).toBeLessThanOrEqual(byGrade);
      expect(byGrade - unit.acquisitionCostIqd, unit.slug).toBeLessThanOrEqual(Math.max(0, ...Object.values(guide.deductions)));
    }
  });
});

// ───────────────────────────────────────────────────────────────── rate, coupons, knowledge

describe("seeded rate, coupons and knowledge", () => {
  it("sets a clearly labelled DEMO dollar rate", async () => {
    expect(await rows("SELECT quote, iqd_per_unit, source, is_demo, effective_at FROM fx_rates")).toEqual([
      { quote: "USD", iqd_per_unit: 1310, source: "سعر تجريبي — يحدده المتجر", is_demo: 1, effective_at: t.now },
    ]);
  });

  it("creates one percent and one fixed coupon, both limited", async () => {
    const coupons = await rows<Record<string, unknown>>("SELECT code, kind, value, min_subtotal_iqd, max_discount_iqd, usage_limit, per_customer_limit, is_active, is_demo FROM coupons ORDER BY code");
    expect(coupons).toEqual([
      { code: "DEMO10", kind: "percent", value: 1000, min_subtotal_iqd: 50_000, max_discount_iqd: 25_000, usage_limit: 500, per_customer_limit: 1, is_active: 1, is_demo: 1 },
      { code: "DEMO5000", kind: "fixed", value: 5000, min_subtotal_iqd: 100_000, max_discount_iqd: null, usage_limit: 200, per_customer_limit: 1, is_active: 1, is_demo: 1 },
    ]);
  });

  it("publishes approved articles as block arrays with the same structure in every language", async () => {
    const allowed = new Set(["h2", "p", "ul", "ol", "steps", "callout", "table", "art"]);
    const articles = await rows<{ slug: string; kind: string; body: string; audience: string; status: string; approved_by: string | null; approved_at: number | null; device: string | null; platform: string | null }>(
      "SELECT a.slug, a.kind, a.body, a.audience, a.status, a.approved_by, a.approved_at, m.slug AS device, p.slug AS platform FROM knowledge_articles a LEFT JOIN device_models m ON m.id = a.device_model_id LEFT JOIN platforms p ON p.id = a.platform_id ORDER BY a.sort",
    );
    expect(articles.map((article) => [article.slug, article.kind, article.device, article.platform])).toEqual([
      ["switch-2-first-setup", "setup", "switch-2", "nintendo"],
      ["switch-2-safe-troubleshooting", "troubleshooting", "switch-2", "nintendo"],
      ["ps5-first-setup", "setup", "ps5-slim", "playstation"],
      ["ps5-safe-troubleshooting", "troubleshooting", "ps5-slim", "playstation"],
      ["xbox-series-x-first-setup", "setup", "xbox-series-x", "xbox"],
      ["xbox-series-x-safe-troubleshooting", "troubleshooting", "xbox-series-x", "xbox"],
      ["handheld-pc-first-setup", "setup", null, "handheld"],
      ["handheld-pc-safe-troubleshooting", "troubleshooting", null, "handheld"],
    ]);
    type Block = { type: string; text?: string; title?: string; tone?: string; name?: string; alt?: string; items?: Array<string | { title: string; text?: string }> };
    for (const article of articles) {
      expect([article.audience, article.status, article.approved_by], article.slug).toEqual(["public", "approved", null]);
      expect(article.approved_at, article.slug).not.toBeNull();
      const body = parse<Record<"ar" | "en" | "ckb", Block[]>>(article.body);
      expect(Object.keys(body).sort()).toEqual(["ar", "ckb", "en"]);
      expect(body.ar.length, article.slug).toBeGreaterThanOrEqual(5);
      for (const locale of ["en", "ckb"] as const) expect(body[locale].map((block) => block.type), `${article.slug} ${locale}`).toEqual(body.ar.map((block) => block.type));
      for (const locale of ["ar", "en", "ckb"] as const) {
        for (const block of body[locale]) {
          expect(allowed, `${article.slug}: ${block.type}`).toContain(block.type);
          if (block.type === "art") expect(artNames, `${article.slug} art`).toContain(block.name);
          if (block.type === "callout") expect(["info", "warning", "danger"]).toContain(block.tone);
          // Plain text only — never markup.
          expect(JSON.stringify(block), article.slug).not.toMatch(/<[a-z/][^>]*>|\*\*|\]\(/i);
        }
      }
      // Safety: every article carries a warning or danger callout, and troubleshooting ends by sending the shopper to a repair.
      expect(body.ar.some((block) => block.type === "callout" && (block.tone === "warning" || block.tone === "danger")), `${article.slug} safety callout`).toBe(true);
      if (article.kind === "troubleshooting") {
        expect(body.ar.some((block) => block.type === "callout" && block.tone === "danger"), article.slug).toBe(true);
        expect(body.en.at(-1)?.text, article.slug).toMatch(/book a repair/i);
        expect(body.ar.at(-1)?.text, article.slug).toContain("احجز صيانة");
      }
    }
  });

  it("stores two approved troubleshooting trees whose every path ends safely", async () => {
    const trees = await rows<{ symptom_key: string; tree: string; status: string; device_model_id: string | null; platform_id: string | null; is_demo: number }>("SELECT * FROM troubleshooting_trees ORDER BY symptom_key");
    expect(trees.map((tree) => [tree.symptom_key, tree.status, tree.device_model_id, tree.platform_id])).toEqual([
      ["no_power", "approved", null, null],
      ["stick_drift", "approved", null, null],
    ]);
    const articleSlugs = new Set((await rows<{ slug: string }>("SELECT slug FROM knowledge_articles WHERE status = 'approved' AND audience = 'public'")).map((row) => row.slug));
    type Node = { id: string; kind: string; text: L10nValue; warning?: L10nValue; options?: Array<{ label: L10nValue; next: string }>; outcome?: { type: string; articleSlug?: string } };
    for (const row of trees) {
      const tree = parse<{ start: string; nodes: Node[] }>(row.tree);
      const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
      expect(nodes.size, row.symptom_key).toBe(tree.nodes.length);
      const reached = new Set<string>();
      const outcomes = new Set<string>();
      let longest = 0;
      const walk = (id: string, trail: string[]) => {
        expect(trail, `${row.symptom_key}: cycle through ${id}`).not.toContain(id);
        const node = nodes.get(id);
        expect(node, `${row.symptom_key}: ${id}`).toBeDefined();
        if (!node) return;
        reached.add(id);
        if (node.kind === "outcome") {
          expect(["resolved", "article", "repair", "human"], `${row.symptom_key}: ${id}`).toContain(node.outcome?.type);
          if (node.outcome?.type === "article") expect(articleSlugs, `${row.symptom_key}: ${id}`).toContain(node.outcome.articleSlug);
          outcomes.add(node.outcome!.type);
          longest = Math.max(longest, trail.length + 1);
          return;
        }
        expect(node.options?.length, `${row.symptom_key}: ${id} has choices`).toBeGreaterThanOrEqual(2);
        for (const choice of node.options ?? []) walk(choice.next, [...trail, id]);
      };
      walk(tree.start, []);
      expect([...reached].sort(), `${row.symptom_key}: every node is reachable`).toEqual([...nodes.keys()].sort());
      expect(outcomes.has("repair") && outcomes.has("resolved"), row.symptom_key).toBe(true);
      expect(longest, row.symptom_key).toBeLessThanOrEqual(8);
      // No step asks the shopper to open anything.
      for (const node of tree.nodes) expect(node.text.en ?? "", `${row.symptom_key}: ${node.id}`).not.toMatch(/\b(unscrew|disassemble|pry|solder it|open the (console|controller|device) and)\b/i);
    }
    // The no-power tree asks about danger signs before anything else.
    const noPower = parse<{ start: string; nodes: Node[] }>(trees[0].tree);
    const start = noPower.nodes.find((node) => node.id === noPower.start)!;
    expect(start.text.en).toMatch(/burning smell/i);
    expect(noPower.nodes.find((node) => node.id === start.options![0].next)?.outcome?.type).toBe("repair");
  });
});

// ───────────────────────────────────────────────────────────────── SQL file

describe("SQL export of the seed", () => {
  it("writes literals exactly as D1 would have bound them", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
    expect(sqlLiteral(675000)).toBe("675000");
    expect(sqlLiteral(7.9)).toBe("7.9");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral("")).toBe("''");
    expect(sqlLiteral("سعر تجريبي — يحدده المتجر")).toBe("'سعر تجريبي — يحدده المتجر'");
    expect(sqlLiteral("line one\nline two")).toBe("('line one' || char(10) || 'line two')");
    expect(sqlLiteral("\n")).toBe("char(10)");
    expect(sqlLiteral(new Uint8Array([0, 255]))).toBe("X'00ff'");
    expect(() => sqlLiteral(Number.NaN)).toThrow();
    expect(() => sqlLiteral({})).toThrow();
  });

  it("inlines parameters without touching question marks inside text", () => {
    expect(inlineParams("insert into t (a, b) values (?, ?)", ["x?", 2])).toBe("insert into t (a, b) values ('x?', 2)");
    expect(inlineParams("select '?' as q, \"col?\" from t where a = ? -- why?", [1])).toBe("select '?' as q, \"col?\" from t where a = 1 -- why?");
    expect(inlineParams("select 'it''s ?' , ?", ["ok"])).toBe("select 'it''s ?' , 'ok'");
    expect(inlineParams("select ?2, ?1", ["a", "b"])).toBe("select 'b', 'a'");
    expect(() => inlineParams("select ?", [])).toThrow();
    expect(() => inlineParams("select 1", [1])).toThrow();
    expect(statementToSql({ sql: "insert into t\n  values (?);", params: ["a"] })).toBe("insert into t values ('a')");
  });

  it("produces a script that reproduces the whole seed on an empty database, and can be run twice", async () => {
    const scratch = await createTestDb({ seed: false });
    try {
      // Record what reference + demo seeding really executes…
      const recorded: RecordedStatement[] = [];
      const recordingDb = createDb(recordWrites(scratch.d1, recorded));
      await seedReference(recordingDb, t.now);
      const direct = await seedDemo(recordingDb, t.now);
      const expected = await countAll(scratch.d1);
      expect(recorded.length).toBeGreaterThan(direct.statements);
      expect(recorded.every((statement) => /^\s*insert\b/i.test(statement.sql))).toBe(true);

      // …turn it into a script…
      const script = toSqlScript(recorded, ["demo seed", "second header line"]);
      const lines = script.trimEnd().split("\n");
      expect(lines.slice(0, 2)).toEqual(["-- demo seed", "-- second header line"]);
      const statements = lines.filter((line) => !line.startsWith("--"));
      expect(statements.length).toBe(recorded.length);
      expect(statements.every((line) => line.endsWith(";") && !line.includes("?,"))).toBe(true);
      expect(Math.max(...statements.map((line) => Buffer.byteLength(line, "utf8")))).toBeLessThan(100_000);
      expect(script).not.toMatch(/BEGIN TRANSACTION|COMMIT/i);

      // …and replay the script on an empty, migrated database.
      await dropEverything(scratch.d1);
      await applyMigrations(scratch.d1);
      const replay = async () => {
        for (let start = 0; start < statements.length; start += 50) {
          await scratch.d1.batch(statements.slice(start, start + 50).map((line) => scratch.d1.prepare(line.slice(0, -1))));
        }
      };
      await replay();
      expect(await countAll(scratch.d1)).toEqual(expected);
      await replay();
      expect(await countAll(scratch.d1)).toEqual(expected);

      // Spot-check that values survived the trip through SQL text.
      const product = await scratch.d1.prepare("SELECT name, is_demo, specs FROM products WHERE slug = 'playstation-5-slim'").first<{ name: string; is_demo: number; specs: string }>();
      expect(parse<L10nValue>(product!.name)).toEqual({ ar: "PlayStation 5 (النموذج النحيف)", en: "PlayStation 5 (Slim)", ckb: "PlayStation 5 (مۆدێلی باریک)" });
      expect(product!.is_demo).toBe(1);
      expect(parse<Record<string, unknown>>(product!.specs).storage_gb).toBe(1000);
      const hits = await searchProductIds(createDb(scratch.d1), "بلي ستيشن", { limit: 100 });
      expect(hits.map((hit) => hit.productId)).toContain(demoId.product("playstation-5-slim"));
    } finally {
      await scratch.dispose();
    }
  }, 120_000);
});
