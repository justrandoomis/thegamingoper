/**
 * The DEMO seed (app/server/db/seed/demo.ts) against a real, throw-away D1: it imports every product
 * of the researched catalogue (catalog/products/*.json) faithfully — texts, specs, variants, official
 * photos, compatibility exactly as researched, relations — puts demo prices, costs and stock around
 * it, is idempotent, flags everything it can as demo, creates no people or orders, and what it writes
 * is internally consistent (stock ↔ movements ↔ serials, pictures ↔ photo manifests, trees ↔
 * articles) and complete in Arabic, English and Kurdish. Also covers the SQL-file path used for
 * `wrangler d1 execute --remote --file`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret } from "~/server/crypto.server";
import { createDb } from "~/server/db/drizzle.server";
import { normalizeSearchText, searchProductIds } from "~/server/db/search.server";
import { codeHashOf, demoCodeId, demoCodeText, seedDemoDigitalCodes } from "~/server/db/seed/demo/codes";
import { codeContext } from "~/server/services/admin/devices/codes.server";
import { assertDemoDataConsistent, buildDemoData, demoId, demoSerialsOf, demoTradeInGuides, demoUsedUnits, loadDemoCatalog, seedDemo, type SeedDemoResult } from "~/server/db/seed/demo";
import type { CatalogProduct } from "~/server/db/seed/demo/catalog/types";
import { DEMO_CATEGORIES } from "~/server/db/seed/demo/categories";
import { DEMO_COUPONS, DEMO_FX_RATE } from "~/server/db/seed/demo/commerce";
import { DEMO_DEVICE_MODELS, DEMO_GENERATIONS, DEMO_PLATFORMS, deviceModelsOfProducts } from "~/server/db/seed/demo/devices";
import { capacityGb, catalogImportProblems } from "~/server/db/seed/demo/import";
import { DEMO_ARTICLES } from "~/server/db/seed/demo/knowledge";
import { COST_SHARE, DEAL_MIN_DAYS_ON_SALE, DEMO_CODES_PER_VARIANT, PRICE_REFERENCE_DATE, demoCodeCount, demoCost, demoStock, isPreorderAt, unitHash } from "~/server/db/seed/demo/pricing";
import { DEMO_SYNONYM_GROUPS, NICKNAMED_PRODUCTS } from "~/server/db/seed/demo/search";
import { DEMO_STORE_SETS } from "~/server/db/seed/demo/sets";
import { inlineParams, recordWrites, sqlLiteral, statementToSql, toSqlScript, type RecordedStatement } from "~/server/db/seed/demo/sql";
import { DEMO_TREES } from "~/server/db/seed/demo/trees";
import { DEMO_USED_UNITS, TRADE_IN_GRADE_MULTIPLIERS } from "~/server/db/seed/demo/used";
import { DEFAULT_LOCATION_ID, seedReference } from "~/server/db/seed/reference";
import { createTestDb, TEST_VARS, type TestDb } from "./helpers/db";
import { PROJECT_ROOT, applyMigrations, dropEverything } from "./helpers/migrations";

// ───────────────────────────────────────────────────────────────── the catalogue

const catalog = loadDemoCatalog();
const data = buildDemoData(catalog);
const bySlug = new Map(catalog.products.map((product) => [product.slug, product]));
const deviceOf = deviceModelsOfProducts(catalog.products);
const catalogVariants = catalog.products.flatMap((product) => product.variants.map((variant, index) => ({ product, variant, index })));
const productKindOf = (product: CatalogProduct) => (product.kind === "handheld_pc" ? "console" : product.kind === "vr" ? "accessory" : product.kind);
const platformOf = (product: CatalogProduct) => (product.platform === "pc_handheld" ? "handheld" : product.platform === "multi" ? null : product.platform);

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
  first = await seedDemo(t.db, t.now, { catalog });
  afterFirst = await countAll(t.d1);
  second = await seedDemo(t.db, t.now + 60_000, { catalog });
  afterSecond = await countAll(t.d1);
});

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── definitions (no database)

describe("demo seed definitions", () => {
  it("import the whole researched catalogue as it is", () => {
    expect(catalog.products.length).toBe(105);
    expect(catalogImportProblems(catalog)).toEqual([]);
    expect(() => assertDemoDataConsistent(catalog, data)).not.toThrow();
    // Every product, plus the one store set; the set is the only product that is not researched.
    expect(data.products.map((product) => product.slug).sort()).toEqual([...catalog.products.map((product) => product.slug), ...DEMO_STORE_SETS.map((set) => set.slug)].sort());
    expect(data.products.filter((product) => product.source === null).map((product) => product.slug)).toEqual(DEMO_STORE_SETS.map((set) => set.slug));
  });

  it("read the catalogue in Node only: no module under app/ imports catalog/**", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(full);
      }
    };
    walk(path.join(PROJECT_ROOT, "app"));
    const offenders = files.filter((file) => /(from\s+|import\(|glob[^(]*\()\s*["'`][^"'`]*catalog\/products/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("map the research kinds onto the store's", () => {
    for (const product of data.products) {
      if (!product.source) continue;
      expect(product.kind, product.slug).toBe(productKindOf(product.source));
    }
    const handhelds = data.products.filter((product) => product.source?.kind === "handheld_pc");
    expect(handhelds.length).toBe(12);
    for (const product of handhelds) {
      expect(product.category, product.slug).toBe("handheld-pcs");
      expect(DEMO_DEVICE_MODELS.find((model) => model.slug === product.deviceModel)?.deviceKind, product.slug).toBe("handheld_pc");
    }
    const vr = data.products.find((product) => product.slug === "playstation-vr2")!;
    expect([vr.kind, vr.category, vr.deviceModel]).toEqual(["accessory", "vr", "ps-vr2"]);
    for (const product of data.products.filter((entry) => entry.kind === "digital")) {
      expect([product.licenseType, product.mediaFormat], product.slug).toEqual([product.category === "subscriptions" ? "subscription" : "wallet_topup", "digital"]);
    }
    expect(data.products.filter((product) => product.category === "subscriptions").map((product) => product.slug).sort()).toEqual(["playstation-plus", "xbox-game-pass"]);
  });

  it("price every variant the same way on every run, in whole IQD rounded to 250", () => {
    const again = buildDemoData(loadDemoCatalog());
    for (const [sku, { variant }] of data.variantsBySku) {
      expect(variant.priceIqd % 250, sku).toBe(0);
      expect(variant.priceIqd, sku).toBeGreaterThan(0);
      expect(again.variantsBySku.get(sku)?.variant.priceIqd, sku).toBe(variant.priceIqd);
      if (variant.compareAtIqd !== null) expect(variant.compareAtIqd, sku).toBeGreaterThan(variant.priceIqd);
    }
    expect(unitHash("PS5-SLIM-DISC-1TB")).toBe(unitHash("PS5-SLIM-DISC-1TB"));
  });

  it("keep demo prices plausible: bands per kind, more capacity never cheaper, gift cards at face value", () => {
    const band: Record<string, [number, number]> = {
      console: [250_000, 1_400_000],
      handheld_pc: [400_000, 2_300_000],
      game: [40_000, 150_000],
      controller: [40_000, 350_000],
      headset: [40_000, 350_000],
      storage: [60_000, 900_000],
      accessory: [25_000, 600_000],
      vr: [400_000, 600_000],
    };
    for (const { product, variant } of catalogVariants) {
      if (product.kind === "digital") continue;
      const price = data.variantsBySku.get(variant.sku)!.variant.priceIqd;
      const [min, max] = band[product.kind];
      expect(price, `${variant.sku} (${product.kind})`).toBeGreaterThanOrEqual(min);
      expect(price, `${variant.sku} (${product.kind})`).toBeLessThanOrEqual(max);
    }
    // Within a product, a bigger capacity of the same chip and edition costs more.
    for (const product of catalog.products) {
      const sized = product.variants.filter((variant) => capacityGb(variant) !== null);
      for (const a of sized) {
        for (const b of sized) {
          const same = a.options?.chip === b.options?.chip && a.options?.edition === b.options?.edition;
          if (same && capacityGb(a)! < capacityGb(b)!) expect(data.variantsBySku.get(a.sku)!.variant.priceIqd, `${a.sku} < ${b.sku}`).toBeLessThan(data.variantsBySku.get(b.sku)!.variant.priceIqd);
        }
      }
    }
    // Gift cards: face value at the demo dollar rate.
    for (const sku of ["PSN-US-10", "XBOX-GC-US-50", "ESHOP-US-100", "STEAM-USD-20"]) {
      const face = Number(/\d+/.exec(sku.split("-").at(-1)!)![0]);
      expect(data.variantsBySku.get(sku)!.variant.priceIqd, sku).toBe(Math.round((face * DEMO_FX_RATE.iqdPerUnit) / 250) * 250);
    }
  });

  it("show a handful of genuine-looking deals on in-stock default variants", () => {
    const deals = [...data.variantsBySku.values()].filter(({ variant }) => variant.compareAtIqd !== null);
    expect(deals.length).toBeGreaterThanOrEqual(3);
    expect(deals.length).toBeLessThanOrEqual(8);
    for (const { product, variant } of deals) {
      expect(variant.isDefault, variant.sku).toBe(true);
      const saving = (variant.compareAtIqd! - variant.priceIqd) / variant.compareAtIqd!;
      expect(saving, variant.sku).toBeGreaterThan(0.05);
      expect(saving, variant.sku).toBeLessThan(0.2);
      expect(demoStock(product.source!, variant.source!, t.now).onHand, variant.sku).toBeGreaterThan(0);
      // A "was" price needs a time it was charged: no deal on something that only just came out
      // (the XBOX Nano Controller, out 4 November 2026, once showed a previous price a week later).
      expect(product.source!.status, variant.sku).toBe("available");
      if (product.source!.releaseDate) {
        const daysOnSale = (Date.parse(`${PRICE_REFERENCE_DATE}T00:00:00Z`) - Date.parse(`${product.source!.releaseDate}T00:00:00Z`)) / 86_400_000;
        expect(daysOnSale, variant.sku).toBeGreaterThanOrEqual(DEAL_MIN_DAYS_ON_SALE);
      }
    }
    expect(deals.map(({ variant }) => variant.sku)).not.toContain("XNANO-STD");
  });

  it("derive costs of 70–85 % of the price (digital codes 92–96 %), above the minimum margin", () => {
    for (const [sku, { product, variant }] of data.variantsBySku) {
      if (!variant.cost) {
        expect(variant.bundle, `${sku} has no cost`).not.toBeNull();
        continue;
      }
      const ratio = variant.cost.landedCostIqd / variant.priceIqd;
      // Exactly inside the band — rounding to 250 IQD must not step out of it (it once gave 69.9 % and 96.2 %).
      const [low, high] = product.kind === "digital" ? [0.92, 0.96] : [0.7, 0.85];
      expect(COST_SHARE[product.kind === "digital" ? "digital" : "physical"]).toEqual([low, high]);
      expect(ratio, sku).toBeGreaterThanOrEqual(low);
      expect(ratio, sku).toBeLessThanOrEqual(high);
      expect(variant.cost.landedCostIqd % 250, sku).toBe(0);
      expect(variant.cost.unitCostMinor, sku).toBeGreaterThan(0);
      expect(Math.floor(((variant.priceIqd - variant.cost.landedCostIqd) * 10_000) / variant.priceIqd), sku).toBeGreaterThanOrEqual(variant.cost.minMarginBps);
    }
    // Every price a hash can draw stays inside the band, at the step edges too.
    for (const [kind, low, high] of [["controller", 0.7, 0.85], ["digital", 0.92, 0.96]] as const) {
      for (let price = 6_500; price <= 2_000_000; price = Math.round(price * 1.37 / 250) * 250) {
        for (const sku of ["A", "B", "XWC-PUR", "ESHOP-US-10", "NBA2K27-PS5-STD", "Z"]) {
          const share = demoCost(kind, sku, price).landedCostIqd / price;
          expect(share, `${kind} ${sku} ${price}`).toBeGreaterThanOrEqual(low);
          expect(share, `${kind} ${sku} ${price}`).toBeLessThanOrEqual(high);
        }
      }
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
    const keywords = data.products.map((product) => product.searchKeywords);
    visit({ DEMO_PLATFORMS, DEMO_GENERATIONS, DEMO_DEVICE_MODELS, DEMO_CATEGORIES, DEMO_STORE_SETS, DEMO_USED_UNITS, DEMO_ARTICLES, DEMO_TREES, keywords, catalogue: catalog.products }, "seed");
    expect(problems).toEqual([]);
    for (const slug of NICKNAMED_PRODUCTS) expect(bySlug.has(slug), `nickname for unknown product ${slug}`).toBe(true);
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
    const variants = data.variantsBySku.size;
    const media =
      data.products.reduce((sum, product) => sum + product.images.length + product.variants.reduce((inner, variant) => inner + variant.images.length, 0), 0) +
      data.deviceModels.reduce((sum, model) => sum + model.images.length, 0) +
      demoUsedUnits(data).reduce((sum, unit) => sum + unit.images.length, 0);
    expect(first.rows).toMatchObject({
      platforms: DEMO_PLATFORMS.length,
      device_generations: DEMO_GENERATIONS.length,
      device_models: DEMO_DEVICE_MODELS.length,
      categories: DEMO_CATEGORIES.length,
      products: catalog.products.length + DEMO_STORE_SETS.length,
      variants,
      variant_costs: variants - DEMO_STORE_SETS.length,
      bundle_items: DEMO_STORE_SETS.reduce((sum, set) => sum + set.components.length, 0),
      media,
      stock_levels: variants,
      compatibility_rules: catalog.products.reduce((sum, product) => sum + (product.compatibility?.length ?? 0), 0),
      product_relations: catalog.products.reduce((sum, product) => sum + product.related.length, 0),
      search_synonyms: DEMO_SYNONYM_GROUPS.length * 3,
      search_index: (catalog.products.length + DEMO_STORE_SETS.length) * 3,
      used_units: 6,
      trade_in_price_guides: demoTradeInGuides(data).length,
      fx_rates: 1,
      coupons: DEMO_COUPONS.length,
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
    const variantId = demoId.variant("NS2-STD");
    const unitId = demoId.usedUnit("used-ps5-slim-disc-01");
    const price = await scalar("SELECT price_iqd FROM variants WHERE id = ?", variantId);
    const onHand = await scalar("SELECT on_hand FROM stock_levels WHERE variant_id = ?", variantId);
    const unit = (await rows<{ status: string; price_iqd: number }>("SELECT status, price_iqd FROM used_units WHERE id = ?", unitId))[0];
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
    const plain = await seedDemo(t.db, t.now + 120_000, { catalog });
    expect(Object.entries(plain.changed).filter(([, changed]) => changed > 0)).toEqual([["search_index", 1]]);
    expect(await rows("SELECT name, status FROM products WHERE id = ?", productId)).toEqual([{ name: '{"ar":"اسم معدّل"}', status: "archived" }]);
    expect(await rows("SELECT locale, name FROM search_index WHERE product_id = ? ORDER BY locale", productId)).toEqual([
      { locale: "ar", name: "edited in admin" },
      { locale: "ckb", name: "nintendo switch 2" },
      { locale: "en", name: "nintendo switch 2" },
    ]);

    const restored = await seedDemo(t.db, t.now + 180_000, { overwrite: true, catalog });
    expect(restored.overwrite).toBe(true);
    expect(await countAll(t.d1)).toEqual(afterFirst);
    const product = (await rows<{ name: string; status: string; created_at: number }>("SELECT name, status, created_at FROM products WHERE id = ?", productId))[0];
    expect(parse<L10nValue>(product.name)).toEqual({ ar: "Nintendo Switch 2", en: "Nintendo Switch 2", ckb: "Nintendo Switch 2" });
    expect(product.status).toBe("published");
    expect(await rows("SELECT name FROM search_index WHERE product_id = ? AND locale = 'ar'", productId)).toEqual([{ name: "nintendo switch 2" }]);
    // Money, stock and state are not the seed's to reset.
    expect(await scalar("SELECT price_iqd FROM variants WHERE id = ?", variantId)).toBe(700_000);
    expect(await scalar("SELECT on_hand FROM stock_levels WHERE variant_id = ?", variantId)).toBe(9);
    expect(await rows("SELECT status, price_iqd FROM used_units WHERE id = ?", unitId)).toEqual([{ status: "sold", price_iqd: 500_000 }]);
    expect(await scalar("SELECT iqd_per_unit FROM fx_rates")).toBe(1500);

    // Put the fixture back for the tests below.
    await t.d1.batch([
      t.d1.prepare("UPDATE variants SET price_iqd = ? WHERE id = ?").bind(price, variantId),
      t.d1.prepare("UPDATE stock_levels SET on_hand = ? WHERE variant_id = ?").bind(onHand, variantId),
      t.d1.prepare("UPDATE used_units SET status = ?, price_iqd = ? WHERE id = ?").bind(unit.status, unit.price_iqd, unitId),
      t.d1.prepare("UPDATE fx_rates SET iqd_per_unit = ?").bind(DEMO_FX_RATE.iqdPerUnit),
    ]);
  });
});

// ───────────────────────────────────────────────────────────────── the imported catalogue

describe("imported catalogue", () => {
  type ProductRow = {
    id: string; slug: string; kind: string; name: string; short: string; description: string; brand: string | null; platform: string | null; device: string | null; category: string;
    specs: string | null; attributes: string; age_rating: string | null; region: string | null; license_type: string | null; media_format: string | null; warranty_months: number | null;
    status: string; is_demo: number; preorder_release_at: number | null;
  };
  let products: Map<string, ProductRow>;
  beforeAll(async () => {
    const list = await rows<ProductRow>(
      "SELECT p.*, pl.slug AS platform, dm.slug AS device, c.slug AS category FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id LEFT JOIN device_models dm ON dm.id = p.device_model_id JOIN categories c ON c.id = p.category_id",
    );
    products = new Map(list.map((row) => [row.slug, row]));
  });

  it("publishes every catalogue product with its researched texts, brand, platform, device and kind", () => {
    expect(products.size).toBe(catalog.products.length + DEMO_STORE_SETS.length);
    for (const product of catalog.products) {
      const row = products.get(product.slug)!;
      expect(row, product.slug).toBeDefined();
      expect([parse(row.name), parse(row.short), parse(row.description)], product.slug).toEqual([product.name, product.short, product.description]);
      expect([row.kind, row.brand, row.platform, row.device, row.status, row.is_demo], product.slug).toEqual([productKindOf(product), product.brand, platformOf(product), deviceOf.get(product.slug) ?? null, "published", 1]);
      expect(row.media_format, product.slug).toBe(product.kind === "game" ? "physical" : product.kind === "digital" ? "digital" : null);
    }
  });

  it("stores the spec sheet with labels, and the rest of the research in attributes", () => {
    for (const product of catalog.products) {
      const row = products.get(product.slug)!;
      const specs = parse<Record<string, L10nValue & { label: L10nValue }>>(row.specs);
      expect(Object.keys(specs), product.slug).toEqual(product.specs.map((spec) => spec.key));
      for (const spec of product.specs) expect(specs[spec.key], `${product.slug}.${spec.key}`).toEqual({ ...spec.value, label: spec.label });
      const attributes = parse<{ catalogue: { status: string; releaseDate: string | null; kind: string }; highlights: unknown; inTheBox: unknown; notes: unknown; game: unknown; sources: unknown; unverified: unknown }>(row.attributes);
      expect(attributes.catalogue.status, product.slug).toBe(product.status);
      expect(attributes.catalogue.kind, product.slug).toBe(product.kind);
      expect(attributes.catalogue.releaseDate, product.slug).toBe(product.releaseDate ?? null);
      expect(attributes.highlights, product.slug).toEqual(product.highlights);
      expect(attributes.inTheBox, product.slug).toEqual(product.inTheBox ?? []);
      expect(attributes.notes, product.slug).toEqual(product.notes ?? null);
      expect(attributes.game, product.slug).toEqual(product.game ?? null);
      expect(attributes.sources, product.slug).toEqual(product.sources);
      expect(attributes.unverified, product.slug).toEqual(product.verification.unverified ?? []);
    }
  });

  it("keeps a Latin title clean: the words it leaves out are the qualifier, stored for the cards' meta line (v2 §4.11)", () => {
    const ARABIC = /[؀-ۿ]/;
    const opensLatin = (text: string) => /^[^A-Za-z؀-ۿ]*[A-Za-z]/.test(text);
    let qualified = 0;
    for (const product of catalog.products) {
      const row = products.get(product.slug)!;
      const name = parse<L10nValue>(row.name);
      // «PlayStation 5 (الطراز الأصلي 2020)» reordered in RTL rows: a name that opens with Latin carries no Arabic script
      for (const locale of ["ar", "en", "ckb"] as const) {
        const text = name[locale] ?? "";
        expect(opensLatin(text) && ARABIC.test(text), `${product.slug} name.${locale}`).toBe(false);
      }
      const attributes = parse<{ qualifier?: L10nValue | null }>(row.attributes);
      expect(attributes.qualifier ?? null, product.slug).toEqual(product.qualifier ?? null);
      if (product.qualifier) qualified++;
    }
    // the two PS5 consoles at least: «PlayStation 5 Slim · 1TB» + «نسخة الأقراص», «PlayStation 5 (2020)» + «الطراز الأصلي»
    expect(qualified).toBeGreaterThanOrEqual(2);
  });

  it("rates games PEGI first, and records the region where all variants share one", () => {
    for (const product of catalog.products) {
      const row = products.get(product.slug)!;
      const rating = product.game?.ageRating;
      expect(row.age_rating, product.slug).toBe(rating?.pegi !== undefined ? `PEGI ${rating.pegi}` : rating?.esrb ? `ESRB ${rating.esrb}` : null);
    }
    expect(products.get("xbox-gift-card")!.region).toBe("US");
    expect(products.get("playstation-store-gift-card")!.region).toBeNull();
  });

  it("never turns a maker's warranty into a store warranty: warranty_months stays empty, the maker's terms stay a spec", () => {
    // warranty_months is what the cart copies into an order and what delivery turns into a `warranties`
    // record the store must honour; "5-year limited warranty or the TBW limit" is Samsung's or WD's, not ours.
    for (const product of catalog.products) expect(products.get(product.slug)!.warranty_months, product.slug).toBeNull();
    const withWarrantySpec = catalog.products.filter((product) => product.specs.some((spec) => spec.key === "warranty"));
    expect(withWarrantySpec.length).toBeGreaterThan(5);
    for (const product of withWarrantySpec) {
      const spec = product.specs.find((entry) => entry.key === "warranty")!;
      expect(parse<Record<string, unknown>>(products.get(product.slug)!.specs).warranty, product.slug).toEqual({ ...spec.value, label: spec.label });
    }
  });

  it("sells products that are not out yet as pre-orders, never from stock; discontinued ones stay published and say so", async () => {
    const levels = new Map((await rows<{ sku: string; on_hand: number }>("SELECT v.sku, s.on_hand FROM stock_levels s JOIN variants v ON v.id = s.variant_id")).map((row) => [row.sku, row.on_hand]));
    const ahead = catalog.products.filter((product) => isPreorderAt(product, t.now));
    expect(ahead.map((product) => product.slug)).toEqual(expect.arrayContaining(["grand-theft-auto-vi"]));
    for (const product of catalog.products) {
      const row = products.get(product.slug)!;
      if (ahead.includes(product)) {
        expect(row.preorder_release_at, product.slug).toBe(Date.parse(`${product.releaseDate}T00:00:00+03:00`));
        for (const variant of product.variants) expect(levels.get(variant.sku), variant.sku).toBe(0);
      } else {
        expect(row.preorder_release_at, product.slug).toBeNull();
      }
      if (product.status === "discontinued") {
        expect(row.status, product.slug).toBe("published");
        expect(parse<{ catalogue: { status: string } }>(row.attributes).catalogue.status).toBe("discontinued");
        for (const variant of product.variants) expect(levels.get(variant.sku), variant.sku).toBeLessThanOrEqual(2);
      }
    }
  });

  it("never stocks a variant that comes out after its product (a new colour, a later platform version)", async () => {
    const levels = new Map((await rows<{ sku: string; on_hand: number }>("SELECT v.sku, s.on_hand FROM stock_levels s JOIN variants v ON v.id = s.variant_id")).map((row) => [row.sku, row.on_hand]));
    const later = catalogVariants.filter(({ variant }) => variant.releaseDate !== undefined);
    // The DualSense Prism colours (out 4 February 2027) and Forza Horizon 6 on PS5 (26 January 2027).
    expect(later.map(({ variant }) => variant.sku).sort()).toEqual(expect.arrayContaining(["DSENSE-PRISM-EMERALD-GREEN", "DSENSE-PRISM-FLARE-ORANGE", "DSENSE-PRISM-GRAPHITE-GRAY", "FH6-PS5-STD"]));
    for (const { product, variant } of later) {
      expect(variant.isDefault, variant.sku).toBe(false);
      expect(variant.releaseDate! > (product.releaseDate ?? ""), variant.sku).toBe(true);
      if (Date.parse(`${variant.releaseDate}T00:00:00+03:00`) > t.now) expect(levels.get(variant.sku), variant.sku).toBe(0);
      expect(parse<{ variantReleaseDates: Record<string, string> }>(products.get(product.slug)!.attributes).variantReleaseDates[variant.sku], variant.sku).toBe(variant.releaseDate);
    }
    // A variant whose notes or title announce a pre-order carries a release date (the stock rule reads only the date).
    for (const { variant } of catalogVariants) {
      if (/pre-?order/i.test(`${variant.title.en} ${variant.notes?.en ?? ""}`) && !/pre-order bonus/i.test(variant.notes?.en ?? "")) {
        const product = catalogVariants.find((entry) => entry.variant === variant)!.product;
        expect(variant.releaseDate ?? (isPreorderAt(product, t.now) ? product.releaseDate : undefined), `${variant.sku} says pre-order`).toBeDefined();
      }
    }
  });

  it("refuses a variant release date it cannot use", () => {
    const base = bySlug.get("dualsense")!;
    const withVariant = (patch: Partial<CatalogProduct["variants"][number]>, index: number) => ({
      ...catalog,
      products: catalog.products.map((product) => (product === base ? { ...product, variants: product.variants.map((variant, at) => (at === index ? { ...variant, ...patch } : variant)) } : product)),
    });
    const defaultIndex = base.variants.findIndex((variant) => variant.isDefault);
    const otherIndex = base.variants.findIndex((variant) => !variant.isDefault);
    expect(catalogImportProblems(withVariant({ releaseDate: "4 Feb 2027" }, otherIndex)).join("\n")).toMatch(/releaseDate must be YYYY-MM-DD/);
    expect(catalogImportProblems(withVariant({ releaseDate: "2019-01-01" }, otherIndex)).join("\n")).toMatch(/not after the product's/);
    expect(catalogImportProblems(withVariant({ releaseDate: "2027-02-04" }, defaultIndex)).join("\n")).toMatch(/default variant .* cannot come out after its product/);
  });

  it("writes every variant as researched: SKU, title, options with the model number, first barcode, default flag, order", async () => {
    const variants = new Map(
      (await rows<{ sku: string; product: string; title: string; options: string | null; barcode: string | null; is_default: number; sort: number; track_serials: number; is_active: number }>(
        "SELECT v.*, p.slug AS product FROM variants v JOIN products p ON p.id = v.product_id",
      )).map((row) => [row.sku, row]),
    );
    expect(variants.size).toBe(data.variantsBySku.size);
    for (const { product, variant, index } of catalogVariants) {
      const row = variants.get(variant.sku)!;
      expect(row.product, variant.sku).toBe(product.slug);
      expect(parse(row.title), variant.sku).toEqual(variant.title);
      expect(row.options === null ? null : parse(row.options), variant.sku).toEqual({ ...(variant.options ?? {}), ...(variant.modelNumber ? { model: variant.modelNumber } : {}) });
      expect(row.barcode, variant.sku).toBe(variant.barcodes?.[0] ?? null);
      expect([row.is_default, row.sort, row.is_active], variant.sku).toEqual([variant.isDefault ? 1 : 0, index, 1]);
      expect(row.track_serials, variant.sku).toBe(productKindOf(product) === "console" ? 1 : 0);
    }
  });

  it("shows the official photos: one row per catalogue image, illustrations only for used units, every key built", async () => {
    const media = await rows<{ id: string; owner_type: string; owner_id: string; art_key: string | null; kind: string; file_id: string | null; is_illustration: number; alt: string; sort: number }>("SELECT * FROM media ORDER BY owner_type, owner_id, sort");
    expect(media.length).toBe(first.rows.media);
    for (const picture of media) {
      expect(picture.art_key && catalog.photoKeys.has(picture.art_key), `${picture.id}: ${picture.art_key}`).toBe(true);
      expect([picture.kind, picture.file_id, picture.is_illustration], picture.id).toEqual(["image", null, picture.owner_type === "used_unit" ? 1 : 0]);
      const alt = parse<L10nValue>(picture.alt);
      expect(alt.ar && alt.en && alt.ckb, picture.id).toBeTruthy();
    }
    expect(new Set(media.map((picture) => picture.owner_type))).toEqual(new Set(["product", "variant", "device_model", "used_unit"]));
    for (const product of catalog.products) {
      const own = media.filter((picture) => picture.owner_type === "product" && picture.owner_id === demoId.product(product.slug));
      expect(own.map((picture) => [picture.art_key, parse(picture.alt), picture.sort]), product.slug).toEqual(product.images.map((image, index) => [image.key, image.alt, index]));
      for (const variant of product.variants) {
        const keys = media.filter((picture) => picture.owner_type === "variant" && picture.owner_id === demoId.variant(variant.sku)).map((picture) => picture.art_key);
        const wholeGallery = (variant.images ?? []).join("|") === product.images.map((image) => image.key).join("|");
        expect(keys, variant.sku).toEqual(wholeGallery ? [] : (variant.images ?? []));
      }
    }
    for (const table of ["platforms", "device_models", "categories"]) {
      for (const row of await rows<{ slug: string; art_key: string | null }>(`SELECT slug, art_key FROM ${table}`)) {
        if (row.art_key !== null) expect(catalog.photoKeys.has(row.art_key), `${table}: ${row.art_key}`).toBe(true);
        else expect(["pc", "windows-pc", "parts"], `${table} ${row.slug} has no picture`).toContain(row.slug);
      }
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

  it("never hides Arabic-script words inside a Latin name: products, device models, categories, store sets (v2 §4.11)", async () => {
    const ARABIC = /[؀-ۿ]/;
    const opensLatin = (text: string) => /^[^A-Za-z؀-ۿ]*[A-Za-z]/.test(text);
    for (const table of ["products", "device_models", "device_generations", "platforms", "categories"]) {
      const named = await rows<{ slug: string; name: string }>(`SELECT slug, name FROM ${table}`);
      expect(named.length, table).toBeGreaterThan(0);
      for (const row of named) {
        const name = parse<L10nValue>(row.name);
        for (const locale of ["ar", "en", "ckb"] as const) {
          const text = name[locale] ?? "";
          expect(opensLatin(text) && ARABIC.test(text), `${table} ${row.slug} name.${locale}: «${text}»`).toBe(false);
        }
      }
    }
  });

  it("builds the device graph: every device the catalogue names, on its platform and generation, with the researched specs", async () => {
    const models = await rows<{ slug: string; status: string; specs: string | null; released_on: string | null; device_kind: string; platform: string; generation: string; platform_active: number }>(
      "SELECT m.slug, m.status, m.specs, m.released_on, m.device_kind, p.slug AS platform, p.is_active AS platform_active, g.slug AS generation FROM device_models m JOIN platforms p ON p.id = m.platform_id JOIN device_generations g ON g.id = m.generation_id ORDER BY m.sort",
    );
    expect(models.map((model) => model.slug)).toEqual(DEMO_DEVICE_MODELS.map((model) => model.slug));
    const known = new Set(models.map((model) => model.slug));
    for (const product of catalog.products) {
      const keys = [deviceOf.get(product.slug), ...(product.compatibility ?? []).map((entry) => entry.deviceModel), ...(product.game?.platforms ?? [])].filter((key): key is string => !!key);
      for (const key of keys) expect(known.has(key), `${product.slug} names ${key}`).toBe(true);
    }
    for (const model of models) {
      expect(model.status, model.slug).toBe("published");
      const seed = DEMO_DEVICE_MODELS.find((entry) => entry.slug === model.slug)!;
      const product = seed.product ? bySlug.get(seed.product)! : null;
      expect(model.released_on, model.slug).toBe(product?.releaseDate ?? null);
      if (product) expect(Object.keys(parse<Record<string, unknown>>(model.specs)), model.slug).toEqual(product.specs.map((spec) => spec.key));
      else expect(model.specs, model.slug).toBeNull();
    }
    // 12 handheld PC products, 11 devices: the ROG Xbox Ally X20 is an edition of the ROG Xbox Ally X.
    expect(models.filter((model) => model.device_kind === "handheld_pc").length).toBe(11);
    const pc = models.find((model) => model.slug === "windows-pc")!;
    expect([pc.platform, pc.platform_active, pc.generation, pc.device_kind]).toEqual(["pc", 0, "windows-pc", "other"]);
    // The two MSI Claw models share the catalogue's "msi-claw" line: each family is a model, the line their generation.
    expect(models.filter((model) => model.generation === "msi-claw").map((model) => model.slug).sort()).toEqual(["msi-claw-8-ex-ai-plus", "msi-claw-a8"]);
    const switch2 = parse<Record<string, L10nValue & { label: L10nValue }>>(models.find((model) => model.slug === "switch-2")!.specs);
    expect(switch2.display.label.en).toBe("Display");
    expect(switch2.display.en).toContain("7.9-inch");
  });

  it("links the category tree and files every product under a leaf", async () => {
    expect((await rows<{ slug: string }>("SELECT slug FROM categories WHERE parent_id IS NULL ORDER BY sort")).map((row) => row.slug)).toEqual([
      "consoles", "handheld-pcs", "games", "controllers", "headsets", "storage", "accessories", "vr", "digital-cards", "parts", "used-devices",
    ]);
    expect(await scalar("SELECT count(*) FROM categories c WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.id = c.parent_id)")).toBe(0);
    // No product sits on a category that has children (it would be missing from the child pages).
    expect(await scalar("SELECT count(*) FROM products p WHERE EXISTS (SELECT 1 FROM categories c WHERE c.parent_id = p.category_id)")).toBe(0);
    const perCategory = Object.fromEntries((await rows<{ slug: string; n: number }>("SELECT c.slug, count(p.id) AS n FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id")).map((row) => [row.slug, row.n]));
    expect(perCategory).toMatchObject({ "handheld-pcs": 12, vr: 1, "gift-cards": 4, subscriptions: 2, "multiplatform-games": 11, "xbox-games": 0, parts: 0, "used-devices": 0 });
    for (const product of catalog.products.filter((entry) => entry.kind === "game" && entry.platform === "multi")) expect(products.get(product.slug)!.category).toBe("multiplatform-games");
  });

  it("sells the store set as its components: priced below them, with no stock or cost of its own", async () => {
    for (const set of DEMO_STORE_SETS) {
      const id = demoId.variant(set.sku);
      const components = await rows<{ sku: string; qty: number; price_iqd: number; on_hand: number }>(
        "SELECT v.sku, b.qty, v.price_iqd, s.on_hand FROM bundle_items b JOIN variants v ON v.id = b.component_variant_id JOIN stock_levels s ON s.variant_id = v.id WHERE b.bundle_variant_id = ? ORDER BY v.sku",
        id,
      );
      expect(components.map((component) => [component.sku, component.qty])).toEqual(set.components.map((component) => [component.sku, component.qty]).sort());
      const row = (await rows<{ price_iqd: number; track_serials: number; kind: string }>("SELECT v.price_iqd, v.track_serials, p.kind FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?", id))[0];
      expect([row.kind, row.track_serials]).toEqual(["bundle", 0]);
      expect(row.price_iqd).toBeLessThan(components.reduce((sum, component) => sum + component.price_iqd * component.qty, 0));
      expect(await scalar("SELECT on_hand FROM stock_levels WHERE variant_id = ?", id)).toBe(0);
      expect(await scalar("SELECT count(*) FROM variant_costs WHERE variant_id = ?", id)).toBe(0);
    }
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

  it("shows in-stock, low-stock and out-of-stock items; digital codes and pre-orders have none", async () => {
    const states = await rows<{ sku: string; kind: string; on_hand: number; reorder_point: number | null }>(
      "SELECT v.sku, p.kind, s.on_hand, s.reorder_point FROM stock_levels s JOIN variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id",
    );
    for (const row of states) {
      const found = data.variantsBySku.get(row.sku)!;
      const expected = found.product.source && found.variant.source ? demoStock(found.product.source, found.variant.source, t.now) : { onHand: 0, reorderPoint: null };
      expect([row.on_hand, row.reorder_point], row.sku).toEqual([expected.onHand, expected.reorderPoint]);
    }
    const physical = states.filter((row) => row.reorder_point !== null);
    const out = physical.filter((row) => row.on_hand === 0);
    const low = physical.filter((row) => row.on_hand > 0 && row.on_hand <= (row.reorder_point ?? 0));
    expect(out.length).toBeGreaterThan(5);
    expect(low.length).toBeGreaterThan(10);
    expect(physical.length - out.length - low.length).toBeGreaterThan(100);
    // A digital variant has as many units on hand as its demo codes (demo/codes.ts): orderable, one code per unit —
    // DEMO_CODES_PER_VARIANT, the last 2 of a discontinued card, never a reorder point.
    const digital = states.filter((row) => row.kind === "digital");
    expect(digital.length).toBeGreaterThan(30);
    for (const row of digital) expect([row.on_hand, row.reorder_point], row.sku).toEqual([demoCodeCount(data.variantsBySku.get(row.sku)!.product.source!), null]);
    expect(digital.filter((row) => row.on_hand === DEMO_CODES_PER_VARIANT).length).toBeGreaterThan(25);
  });

  it("tracks consoles and handheld PCs by serial, one in-stock serial per unit on hand", async () => {
    const tracked = await rows<{ sku: string; kind: string; on_hand: number; serials: number }>(
      "SELECT v.sku, p.kind, s.on_hand, (SELECT count(*) FROM serials x WHERE x.variant_id = v.id AND x.source = 'purchase' AND x.status = 'in_stock') AS serials FROM variants v JOIN products p ON p.id = v.product_id JOIN stock_levels s ON s.variant_id = v.id WHERE v.track_serials = 1",
    );
    expect(tracked.length).toBe(catalogVariants.filter(({ product }) => productKindOf(product) === "console").length);
    for (const row of tracked) {
      expect(row.kind, row.sku).toBe("console");
      expect(row.serials, row.sku).toBe(row.on_hand);
    }
    expect(await scalar("SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id WHERE p.kind <> 'console' AND v.track_serials = 1")).toBe(0);
    expect(await scalar("SELECT count(*) FROM serials")).toBe(tracked.reduce((sum, row) => sum + row.on_hand, 0) + DEMO_USED_UNITS.length);
    const slim = tracked.find((row) => row.sku === "PS5-SLIM-DISC-1TB")!;
    expect((await rows<{ serial: string }>("SELECT serial FROM serials WHERE variant_id = ? AND source = 'purchase' ORDER BY serial", demoId.variant("PS5-SLIM-DISC-1TB"))).map((row) => row.serial)).toEqual(demoSerialsOf("PS5-SLIM-DISC-1TB", slim.on_hand));
    // Each serial has its own opening movement.
    expect(await scalar("SELECT count(*) FROM serials x WHERE x.source = 'purchase' AND (SELECT count(*) FROM stock_movements m WHERE m.serial_id = x.id AND m.qty_delta = 1) <> 1")).toBe(0);
  });

  it("gives every variant except the store set a cost, and matching cost layers", async () => {
    expect(await scalar("SELECT count(*) FROM variants v WHERE NOT EXISTS (SELECT 1 FROM variant_costs c WHERE c.variant_id = v.id)")).toBe(DEMO_STORE_SETS.length);
    const bad = await rows(
      `SELECT v.sku FROM variant_costs c JOIN variants v ON v.id = c.variant_id WHERE c.landed_cost_iqd <= 0 OR c.landed_cost_iqd >= v.price_iqd OR (v.price_iqd - c.landed_cost_iqd) * 10000 / v.price_iqd < c.min_margin_bps OR c.currency <> 'USD' OR c.fx_rate_micros <> ${DEMO_FX_RATE.iqdPerUnit * 1_000_000} OR c.unit_cost_minor <= 0`,
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

describe("seeded compatibility and relations", () => {
  it("writes every researched rule with its status exactly as researched, its note and its source", async () => {
    const stored = new Map(
      (await rows<{ product: string; model: string; status: string; note: string | null; source: string | null; subject_type: string; target_type: string; verified_by: string | null; verified_at: number | null }>(
        "SELECT p.slug AS product, m.slug AS model, r.* FROM compatibility_rules r JOIN products p ON p.id = r.subject_id JOIN device_models m ON m.id = r.target_id",
      )).map((row) => [`${row.product}|${row.model}`, row]),
    );
    expect(await scalar("SELECT count(*) FROM compatibility_rules")).toBe(stored.size);
    let total = 0;
    for (const product of catalog.products) {
      for (const entry of product.compatibility ?? []) {
        total++;
        const row = stored.get(`${product.slug}|${entry.deviceModel}`)!;
        expect(row, `${product.slug} → ${entry.deviceModel}`).toBeDefined();
        expect([row.subject_type, row.target_type, row.status], `${product.slug} → ${entry.deviceModel}`).toEqual(["product", "device_model", entry.status === "unknown" ? "unverified" : entry.status]);
        expect(row.note === null ? null : parse(row.note), `${product.slug} → ${entry.deviceModel}`).toEqual(entry.note ?? null);
        expect(row.source, `${product.slug} → ${entry.deviceModel}`).toBe(entry.source ?? null);
        // Nobody has tested anything in the store: no one is named as having verified a rule.
        expect(row.verified_by).toBeNull();
        // When the documented fact was recorded (an overwrite records it again); never for an unverified one.
        expect(row.verified_at === null, `${product.slug} → ${entry.deviceModel}`).toBe(row.status === "unverified");
      }
    }
    expect(stored.size).toBe(total);
    // What the research could not confirm stays unconfirmed.
    expect(stored.get("hyperx-cloud-iii-s-wireless|switch-2")).toMatchObject({ status: "unverified", source: null, verified_at: null });
    expect(stored.get("battlefield-6|xbox-series-s")?.status).toBe("incompatible");
    expect(new Set([...stored.values()].map((row) => row.status))).toEqual(new Set(["verified", "partial", "incompatible", "unverified"]));
  });

  it("keeps disc games consistent with the Disc Drive research: a disc plays on a console without a drive only through the add-on drive", async () => {
    // The consoles with no disc drive of their own (their catalogue entries: PS5 Pro "No disc drive",
    // the Digital Editions, the all-digital Series S).
    const noDrive = ["ps5-digital", "ps5-slim-digital", "ps5-pro", "xbox-series-s", "xbox-series-x-digital"];
    const drive = bySlug.get("ps5-disc-drive")!;
    const takesAddOn = new Set((drive.compatibility ?? []).filter((entry) => entry.status === "verified").map((entry) => entry.deviceModel));
    // The add-on Disc Drive fits the slim Digital Edition and PS5 Pro, not the original 2020 Digital Edition.
    expect([...takesAddOn].sort()).toEqual(["ps5-pro", "ps5-slim-digital"]);
    expect(drive.compatibility?.find((entry) => entry.deviceModel === "ps5-digital")?.status).toBe("incompatible");
    const stored = new Map(
      (await rows<{ product: string; model: string; status: string }>("SELECT p.slug AS product, m.slug AS model, r.status FROM compatibility_rules r JOIN products p ON p.id = r.subject_id JOIN device_models m ON m.id = r.target_id")).map((row) => [`${row.product}|${row.model}`, row.status]),
    );
    const discGames = catalog.products.filter((product) => product.kind === "game" && product.game?.physicalFormat === "disc");
    expect(discGames.length).toBeGreaterThan(10);
    let checked = 0;
    for (const game of discGames) {
      for (const entry of game.compatibility ?? []) {
        if (!noDrive.includes(entry.deviceModel)) continue;
        const expected = takesAddOn.has(entry.deviceModel) ? "partial" : "incompatible";
        expect(entry.status, `${game.slug} → ${entry.deviceModel}`).toBe(expected);
        expect(stored.get(`${game.slug}|${entry.deviceModel}`), `${game.slug} → ${entry.deviceModel} in the database`).toBe(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    // Shopper-facing notes say which Digital Edition takes the drive (they once said "PS5 Digital Edition
    // and PS5 Pro need the add-on Disc Drive", which is wrong for the 2020 Digital Edition).
    for (const game of discGames) {
      for (const variant of game.variants) {
        const note = variant.notes?.en ?? "";
        if (/add-on Disc Drive/i.test(note) && /Digital Edition/.test(note)) expect(note, variant.sku).toMatch(/original PS5 Digital Edition \(2020\) cannot play discs/);
      }
    }
  });

  it("links related products exactly as researched", async () => {
    const stored = await rows<{ product: string; related: string; kind: string; sort: number; pinned: number }>(
      "SELECT p.slug AS product, q.slug AS related, r.kind, r.sort, r.pinned FROM product_relations r JOIN products p ON p.id = r.product_id JOIN products q ON q.id = r.related_product_id ORDER BY p.slug, r.sort",
    );
    const expected = catalog.products.flatMap((product) => product.related.map((relation, index) => ({ product: product.slug, related: relation.slug, kind: relation.kind, sort: index, pinned: 0 })));
    expect(stored).toEqual(expected.sort((a, b) => (a.product === b.product ? a.sort - b.sort : a.product < b.product ? -1 : 1)));
  });

  it("never puts something incompatible on a console's setup shelf", async () => {
    const shelves = await rows<{ console: string; model_id: string; related_id: string; related: string }>(
      "SELECT p.slug AS console, p.device_model_id AS model_id, q.id AS related_id, q.slug AS related FROM product_relations r JOIN products p ON p.id = r.product_id JOIN products q ON q.id = r.related_product_id WHERE r.kind IN ('setup', 'accessory') AND p.kind = 'console' AND p.device_model_id IS NOT NULL",
    );
    expect(shelves.length).toBeGreaterThan(20);
    for (const row of shelves) {
      expect(await scalar("SELECT count(*) FROM compatibility_rules WHERE subject_id = ? AND target_id = ? AND status = 'incompatible'", row.related_id, row.model_id), `${row.console} → ${row.related}`).toBe(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────── search

describe("seeded search", () => {
  const find = async (query: string) => (await searchProductIds(t.db, query, { limit: 100 })).map((hit) => hit.productId);

  it("indexes every product in the three languages", async () => {
    expect(await scalar("SELECT count(*) FROM search_index")).toBe((catalog.products.length + DEMO_STORE_SETS.length) * 3);
    expect(await scalar("SELECT count(*) FROM products p WHERE (SELECT count(DISTINCT locale) FROM search_index s WHERE s.product_id = p.id) <> 3")).toBe(0);
    expect(await scalar("SELECT count(*) FROM search_index WHERE name = '' OR keywords = '' OR body = ''")).toBe(0);
  });

  it("stores normalized synonym sets per language, old and new names", async () => {
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
    expect(terms("ar")).toEqual(expect.arrayContaining(["بلايستيشن", "سويتش", "اكس بوكس", "يد تحكم", "سماعه", "ذاكره", "مستعمل", "سويتش 2", "بلايستيشن 5 برو", "ستيم ديك"].map(normalizeSearchText)));
    const playstation = synonyms.find((row) => row.locale === "ar" && row.term === normalizeSearchText("بلايستيشن"));
    expect(parse<string[]>(playstation!.synonyms)).toEqual(expect.arrayContaining(["بلي ستيشن", "سوني", "playstation"].map(normalizeSearchText)));
  });

  it("finds products by the words shoppers type, in any of the three languages", async () => {
    const product = demoId.product;
    expect(await find("بلي ستيشن")).toContain(product("playstation-5-slim"));
    expect(await find("PS5")).toEqual(expect.arrayContaining([product("playstation-5-slim"), product("playstation-5-pro")]));
    expect(await find("سويتش 2")).toContain(product("nintendo-switch-2"));
    expect(await find("سويتش ٢")).toContain(product("nintendo-switch-2"));
    expect(await find("بلايستيشن ٥ برو")).toContain(product("playstation-5-pro"));
    expect(await find("ستيم ديك")).toEqual(expect.arrayContaining([product("steam-deck-oled"), product("steam-deck-lcd")]));
    expect(await find("اكس بوكس")).toEqual(expect.arrayContaining([product("xbox-series-x"), product("xbox-series-s")]));
    expect(await find("جوستك")).toEqual(expect.arrayContaining([product("dualsense"), product("xbox-wireless-controller")]));
    expect(await find("كنترولر")).toContain(product("joy-con-2"));
    expect(await find("هيدسيت")).toEqual(expect.arrayContaining([product("pulse-elite"), product("xbox-wireless-headset")]));
    expect(await find("ميموري")).toContain(product("sandisk-microsd-express"));
    expect(await find("فيفا")).toEqual(expect.arrayContaining([product("ea-sports-fc-27"), product("ea-sports-fc-27-nintendo-switch-2")]));
    expect(await find("ماريو كارت")).toContain(product("mario-kart-world"));
    expect(await find("جي تي اي")).toContain(product("grand-theft-auto-vi"));
    expect(await find("پلەیستەیشن")).toContain(product("playstation-5-slim"));
    expect(await find("دەسکی یاری")).toContain(product("dualsense"));
    expect(await find("هێدسێت")).toContain(product("xbox-wireless-headset"));
    expect(await find("steam deck")).toContain(product("steam-deck-oled"));
    expect(await find("spider-man")).toContain(product("marvels-spider-man-2"));
    expect(await find("CFI-ZCT2W")).toContain(product("dualsense"));
    expect(await find("zzz-no-such-thing")).toEqual([]);
    // Spellings that once found nothing: they lived only in search_synonyms, which this search does not expand.
    expect(await find("بليستيشن ٥")).toContain(product("playstation-5-slim"));
    expect(await find("بلستيشن")).toContain(product("playstation-5-slim"));
    expect(await find("ايكس بوكس سيريس اس")).toContain(product("xbox-series-s"));
    expect(await find("مشغل اقراص بلايستيشن")).toContain(product("ps5-disc-drive"));
    expect(await find("ستاند بلايستيشن")).toContain(product("ps5-vertical-stand"));
    expect((await find("قاعدة شحن يد"))[0]).toBe(product("dualsense-charging-station"));
  });

  it("indexes every spelling of a platform's synonym set with the platform's products", async () => {
    const representative: Record<string, string> = { playstation: "playstation-5-slim", "nintendo-switch": "nintendo-switch-2", xbox: "xbox-series-s", handheld: "steam-deck-oled" };
    for (const [group, slug] of Object.entries(representative)) {
      const spellings = DEMO_SYNONYM_GROUPS.find((entry) => entry.key === group)!;
      for (const locale of ["ar", "en", "ckb"] as const) {
        for (const spelling of spellings[locale]) expect(await find(spelling), `${locale} «${spelling}» → ${slug}`).toContain(demoId.product(slug));
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── used devices

describe("seeded used devices", () => {
  it("lists six demo units across the four grades, showing the model's official photos as illustrations", async () => {
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

      const pictures = await rows<{ is_illustration: number; kind: string; file_id: string | null; art_key: string; alt: string }>("SELECT is_illustration, kind, file_id, art_key, alt FROM media WHERE owner_type = 'used_unit' AND owner_id = ?", unit.id);
      expect(pictures.length, unit.slug).toBeGreaterThan(0);
      for (const picture of pictures) {
        expect([picture.is_illustration, picture.kind, picture.file_id], unit.slug).toEqual([1, "image", null]);
        expect(catalog.photoKeys.has(picture.art_key), picture.art_key).toBe(true);
        expect(parse<L10nValue>(picture.alt).ar, unit.slug).toContain("صورة توضيحية");
      }
    }
    const withBattery = units.filter((unit) => unit.battery_health_pct !== null).map((unit) => unit.slug).sort();
    expect(withBattery).toEqual(["used-legion-go-512-01", "used-steam-deck-oled-512-01", "used-switch-lite-turquoise-01", "used-switch-oled-white-01"]);
    // Lower grades disclose their faults.
    for (const unit of units.filter((entry) => entry.grade === "B" || entry.grade === "C")) expect(parse<unknown[]>(unit.defects).length, unit.slug).toBeGreaterThan(0);
  });

  it("has a trade-in price guide for every console and handheld PC model, and costs that follow it", async () => {
    const guides = await rows<{ slug: string; base_iqd: number; grade_multipliers: string; deductions: string; variant_id: string | null }>(
      "SELECT m.slug, g.base_iqd, g.grade_multipliers, g.deductions, g.variant_id FROM trade_in_price_guides g JOIN device_models m ON m.id = g.device_model_id",
    );
    const expected = demoTradeInGuides(data);
    expect(guides.map((guide) => guide.slug).sort()).toEqual(DEMO_DEVICE_MODELS.filter((model) => model.product && (model.deviceKind === "console" || model.deviceKind === "handheld_pc")).map((model) => model.slug).sort());
    for (const guide of guides) {
      const definition = expected.find((entry) => entry.deviceModel === guide.slug)!;
      expect([guide.base_iqd, parse(guide.deductions)], guide.slug).toEqual([definition.baseIqd, definition.deductions]);
      expect(parse(guide.grade_multipliers)).toEqual({ "A+": 10_000, A: 9_000, B: 7_500, C: 5_500 });
      expect(guide.base_iqd % 5_000).toBe(0);
      expect(guide.variant_id).toBeNull();
    }
    for (const unit of demoUsedUnits(data)) {
      const guide = expected.find((entry) => entry.deviceModel === unit.deviceModel)!;
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
          if (block.type === "art") expect(catalog.photoKeys.has(block.name ?? ""), `${article.slug} photo ${block.name}`).toBe(true);
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

describe("demo digital codes (demo/codes.ts)", () => {
  let c: TestDb;
  beforeAll(async () => {
    c = await createTestDb();
    await seedReference(c.db, c.now);
    await seedDemo(c.db, c.now, { catalog });
  });
  afterAll(async () => {
    await c?.dispose();
  });
  const codeRows = async () =>
    (
      await c.d1
        .prepare("SELECT d.id, d.code_enc, d.code_hash, d.status, d.is_demo, d.cost_iqd, d.expires_at, d.order_item_id, v.sku, p.kind, p.status AS product_status FROM digital_codes d JOIN variants v ON v.id = d.variant_id JOIN products p ON p.id = v.product_id ORDER BY d.id")
        .all<{ id: string; code_enc: string; code_hash: string; status: string; is_demo: number; cost_iqd: number | null; expires_at: number | null; order_item_id: string | null; sku: string; kind: string; product_status: string }>()
    ).results;

  it("writes nothing without the environment's DATA_KEY (a code its store could not decrypt is worse than none)", async () => {
    expect(await seedDemoDigitalCodes(c.db, c.now, { catalog, dataKey: null })).toEqual({ written: 0, defined: 0, skipped: "no_data_key" });
    expect(await seedDemoDigitalCodes(c.db, c.now, { catalog, dataKey: "  " })).toEqual({ written: 0, defined: 0, skipped: "no_data_key" });
    expect(await codeRows()).toEqual([]);
  });

  it("gives every digital variant as many demo codes as it has units on hand, each one its own, DEMO and readable only with its key and row", async () => {
    const first = await seedDemoDigitalCodes(c.db, c.now, { catalog, dataKey: TEST_VARS.DATA_KEY });
    const digital = data.products.filter((product) => product.kind === "digital" && product.source).flatMap((product) => product.variants.map((variant) => ({ variant, count: demoCodeCount(product.source!) })));
    expect(digital.length).toBeGreaterThan(30);
    const total = digital.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBeGreaterThan(25 * DEMO_CODES_PER_VARIANT);
    expect(first).toEqual({ written: total, defined: total });
    const codes = await codeRows();
    expect(codes.every((row) => row.kind === "digital" && row.status === "available" && row.is_demo === 1 && row.expires_at === null && row.order_item_id === null)).toBe(true);
    expect(new Set(codes.map((row) => row.code_hash)).size).toBe(codes.length);
    for (const { variant, count } of digital) {
      const own = codes.filter((row) => row.sku === variant.sku);
      expect(own.length, variant.sku).toBe(count);
      // as many codes as units on hand (pricing.ts demoStock): one code per unit sold
      expect(Number((await c.d1.prepare("SELECT on_hand FROM stock_levels WHERE variant_id = ?").bind(demoId.variant(variant.sku)).first<{ on_hand: number }>())?.on_hand), variant.sku).toBe(count);
      for (const [index, row] of own.entries()) {
        expect(row.id).toBe(demoCodeId(variant.sku, index + 1));
        expect(row.cost_iqd, variant.sku).toBe(variant.cost?.landedCostIqd ?? null);
        // the text says DEMO; it is module 13's encryption, bound to this row (another row's context refuses it)
        const text = await decryptSecret(row.code_enc, TEST_VARS.DATA_KEY, codeContext(row.id));
        expect(text).toBe(demoCodeText(variant.sku, index + 1));
        expect(text.startsWith("DEMO-")).toBe(true);
        expect(row.code_hash).toBe(await codeHashOf(text));
        await expect(decryptSecret(row.code_enc, TEST_VARS.DATA_KEY, codeContext(`${row.id}x`))).rejects.toThrow();
      }
    }
    // a second run finds every code and writes nothing
    expect(await seedDemoDigitalCodes(c.db, c.now + 60_000, { catalog, dataKey: TEST_VARS.DATA_KEY })).toEqual(first.defined === 0 ? first : { written: 0, defined: first.defined });
    expect((await codeRows()).length).toBe(codes.length);
  });
});

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
      const direct = await seedDemo(recordingDb, t.now, { catalog });
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
      const slim = bySlug.get("playstation-5-slim")!;
      const product = await scratch.d1.prepare("SELECT name, is_demo, specs FROM products WHERE slug = 'playstation-5-slim'").first<{ name: string; is_demo: number; specs: string }>();
      expect(parse<L10nValue>(product!.name)).toEqual(slim.name);
      expect(product!.is_demo).toBe(1);
      expect(parse<Record<string, unknown>>(product!.specs).storage).toEqual({ ...slim.specs.find((spec) => spec.key === "storage")!.value, label: slim.specs.find((spec) => spec.key === "storage")!.label });
      const hits = await searchProductIds(createDb(scratch.d1), "بلي ستيشن", { limit: 100 });
      expect(hits.map((hit) => hit.productId)).toContain(demoId.product("playstation-5-slim"));
    } finally {
      await scratch.dispose();
    }
  }, 180_000);
});
