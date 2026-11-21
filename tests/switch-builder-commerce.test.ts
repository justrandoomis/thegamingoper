/**
 * Switch bundle builder — the store side (app/routes/storefront/builder/builder.server.ts) and the eShop card mix
 * (app/lib/switch-builder/eshop-mix.ts). Contract: docs/switch-builder.md §5.
 *
 *   · loadBuilderCatalog on the owner's catalogue as production has it (seedDemo in owner-sheet mode: the OLED in two
 *     colours, the 1TB SanDisk Ultra, five Switch 1 cartridges, the eShop card archived) — and on fixtures for each
 *     rule: orderable or not (never a count), verified compatibility only, Switch 2 variants and games excluded, one
 *     library id per product, US eShop values only;
 *   · parsePlan refuses junk;
 *   · quoteBuilderPlan: lines, totals, the eShop mix with the units in stock, notSold, nothing trusted from the browser;
 *   · mixEshopCards: the rule (least left over, then fewest cards, then fewest values), its bounds, and a brute-force
 *     cross-check.
 *
 * Real local D1 (tests/helpers/db.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { MAX_UNITS_PER_VALUE, allEshopCards, mixEshopCards, usableValues, type EshopValue } from "~/lib/switch-builder/eshop-mix";
import { PLAN_LIMITS, type BuilderCatalog, type BuilderPlan, type LibraryExtras } from "~/lib/switch-builder/types";
import { cardSizeOf, libraryIdOf, loadBuilderCatalog, parsePlan, quoteBuilderPlan, usdCentsOf } from "~/routes/storefront/builder/builder.server";
import { compatibilityRules, deviceModels, media, products, stockLevels, variants, type ProductKind } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { PROJECT_ROOT } from "./helpers/migrations";

const DAY = 24 * 60 * 60 * 1000;

let t: TestDb;
let NOW: number;
/** device model slug → id (as seeded). */
const modelId = new Map<string, string>();
let switchGenerationId: string | null = null;

beforeAll(async () => {
  t = await createTestDb();
  NOW = t.now + DAY;
  // the owner's state: sheet prices, one real unit per sheet row, everything else archived (what production holds)
  await seedDemo(t.db, t.now, { ownerSheet: true });
  for (const row of await t.db.select({ id: deviceModels.id, slug: deviceModels.slug, generationId: deviceModels.generationId }).from(deviceModels)) {
    modelId.set(row.slug, row.id);
    if (row.slug === "switch-oled") switchGenerationId = row.generationId;
  }
});
afterAll(async () => {
  await t?.dispose();
});

const SWITCH_1 = ["switch-oled", "switch", "switch-lite"] as const;
const US = (key: string) => `https://www.nintendo.com/us/store/products/${key}/`;

async function priceOf(variantId: string): Promise<number> {
  return (await t.db.select({ price: variants.priceIqd }).from(variants).where(eq(variants.id, variantId)).get())?.price ?? -1;
}

async function setStock(variantId: string, onHand: number) {
  const level = await t.db.select({ id: stockLevels.variantId }).from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
  if (level) await t.db.update(stockLevels).set({ onHand, reserved: 0 }).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));
  else await t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand, allowOversell: false });
}

type VariantInput = { sku: string; title?: string; options?: Record<string, string>; priceIqd: number; stock?: number; isActive?: boolean; isDefault?: boolean };
type RuleInput = { target: "device_model" | "generation"; slug?: string; status: "verified" | "partial" | "unverified" | "incompatible" };

/** A product with its variants, stock at the main location, a first picture and compatibility rules — written in one batch. */
async function addProduct(input: {
  slug: string;
  kind: ProductKind;
  status?: "draft" | "published" | "archived" | "scheduled";
  publishAt?: number;
  deviceModel?: string;
  mediaFormat?: "physical" | "digital";
  licenseType?: "wallet_topup" | "subscription";
  attributes?: Record<string, unknown>;
  variants: VariantInput[];
  rules?: RuleInput[];
}): Promise<{ productId: string; variantIds: string[] }> {
  const productId = `prd_${input.slug}`;
  const statements: BatchStatement[] = [
    t.db.insert(products).values({
      id: productId,
      slug: input.slug,
      kind: input.kind,
      name: { ar: `منتج ${input.slug}`, en: `Product ${input.slug}`, ckb: `بەرهەم ${input.slug}` },
      status: input.status ?? "published",
      publishAt: input.publishAt ?? null,
      deviceModelId: input.deviceModel ? (modelId.get(input.deviceModel) ?? null) : null,
      mediaFormat: input.mediaFormat ?? null,
      licenseType: input.licenseType ?? null,
      attributes: input.attributes ?? null,
      isDemo: false,
      createdAt: NOW - DAY,
      updatedAt: NOW - DAY,
    }),
    t.db.insert(media).values({ id: newId("med"), ownerType: "product", ownerId: productId, artKey: `${input.slug}--1`, kind: "image", sort: 0 }),
  ];
  const variantIds: string[] = [];
  input.variants.forEach((variant, index) => {
    const id = `var_${variant.sku.toLowerCase()}`;
    variantIds.push(id);
    statements.push(
      t.db.insert(variants).values({
        id,
        productId,
        sku: variant.sku,
        title: variant.title ? { ar: variant.title, en: variant.title, ckb: variant.title } : null,
        options: variant.options ?? null,
        priceIqd: variant.priceIqd,
        isDefault: variant.isDefault ?? index === 0,
        isActive: variant.isActive ?? true,
        sort: index,
      }),
    );
    if (variant.stock !== undefined) statements.push(t.db.insert(stockLevels).values({ variantId: id, locationId: DEFAULT_LOCATION_ID, onHand: variant.stock, allowOversell: false }));
  });
  for (const rule of input.rules ?? []) {
    const targetId = rule.target === "generation" ? (switchGenerationId as string) : (modelId.get(rule.slug as string) as string);
    statements.push(t.db.insert(compatibilityRules).values({ id: newId("cmp"), subjectType: "product", subjectId: productId, targetType: rule.target, targetId, status: rule.status }));
  }
  await runBatch(t.db, statements);
  return { productId, variantIds };
}

const verifiedOnSwitch1 = (status: RuleInput["status"] = "verified"): RuleInput[] => SWITCH_1.map((slug) => ({ target: "device_model", slug, status }));

/** Every key anywhere in a value (to prove no stock count leaves the server). */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, into);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      keysOf(entry, into);
    }
  }
  return into;
}
const OPTION_KEYS = new Set(["variantId", "productSlug", "name", "variantTitle", "priceIqd", "orderable", "reason", "art"]);
const CATALOG_KEYS = new Set([...OPTION_KEYS, "devices", "cards", "cartridges", "eshop", "variants", "sold", "denominations", "cents", "switch-oled", "switch", "switch-lite"]);

function assertNoCounts(catalog: BuilderCatalog) {
  const unexpected = [...keysOf(catalog)].filter((key) => !CATALOG_KEYS.has(key) && !/^\d+$/.test(key) && !/-switch$/.test(key));
  expect(unexpected).toEqual([]);
  expect(JSON.stringify(catalog)).not.toMatch(/"(available|onHand|on_hand|reserved|stock|units|free)"/);
}

// ───────────────────────────────────────────────────────────────── loadBuilderCatalog — production's catalogue

const FIVE_CARTRIDGES = ["mario-tennis-aces-switch", "new-pokemon-snap-switch", "paper-mario-the-origami-king-switch", "pokemon-brilliant-diamond-switch", "pokemon-shining-pearl-switch"];

describe("loadBuilderCatalog — the owner's catalogue (seedDemo in owner-sheet mode, as production holds it)", () => {
  test("the OLED in two colours, the 1TB Ultra card, five Switch 1 cartridges, no eShop card — orderable flags, never a count", async () => {
    const catalog = await loadBuilderCatalog(t.db, "ar", NOW);
    assertNoCounts(catalog);

    const oled = catalog.devices["switch-oled"];
    expect(oled).toMatchObject({ productSlug: "nintendo-switch-oled" });
    expect(oled?.variants.map((option) => option.variantId)).toEqual(["var_nsw-oled-wht", "var_nsw-oled-neon"]);
    for (const option of oled?.variants ?? []) {
      expect(option).toMatchObject({ productSlug: "nintendo-switch-oled", orderable: true, priceIqd: await priceOf(option.variantId) });
      expect(option.reason).toBeUndefined();
      expect(option.art).toMatch(/^nintendo-switch-oled--\d+$/);
    }
    expect(oled?.variants[0].variantTitle).toBe("أبيض");
    // the original Switch and the Lite are archived demo rows: TamTam does not sell them now
    expect(catalog.devices.switch).toBeNull();
    expect(catalog.devices["switch-lite"]).toBeNull();

    // the 256GB Extreme is an unpriced draft, the microSD Express cards are archived Switch 2 cards: only the 1TB Ultra
    expect(Object.keys(catalog.cards)).toEqual(["1000"]);
    expect(catalog.cards[1000]).toMatchObject({ variantId: "var_sandisk-ultra-1tb", productSlug: "sandisk-ultra-microsd", orderable: true, priceIqd: await priceOf("var_sandisk-ultra-1tb") });

    // the five Switch 1 cartridges by their nintendo.com US keys; the 2026 Ocarina of Time remake (Switch 2 only) never
    for (const id of FIVE_CARTRIDGES) expect(catalog.cartridges[id], id).toMatchObject({ orderable: true, art: expect.stringMatching(/--\d+$/) });
    expect(Object.keys(catalog.cartridges).every((id) => id.endsWith("-switch"))).toBe(true);
    expect(Object.values(catalog.cartridges).some((option) => option.productSlug === "the-legend-of-zelda-ocarina-of-time")).toBe(false);
    expect(catalog.cartridges["mario-tennis-aces-switch"]).toMatchObject({ productSlug: "mario-tennis-aces", variantId: "var_nsg-mario-tennis-aces", priceIqd: await priceOf("var_nsg-mario-tennis-aces") });

    // the eShop card product is archived demo data
    expect(catalog.eshop).toEqual({ sold: false, denominations: [] });
  });

  test("names and titles follow the page's language", async () => {
    const catalog = await loadBuilderCatalog(t.db, "en", NOW);
    expect(catalog.devices["switch-oled"]?.variants.map((option) => option.variantTitle)).toEqual(["White", "Neon Blue / Neon Red"]);
    expect(catalog.cards[1000]?.name).toMatch(/SanDisk Ultra/);
  });
});

// ───────────────────────────────────────────────────────────────── loadBuilderCatalog — the rules

describe("loadBuilderCatalog — the rules, on fixtures", () => {
  test("consoles: every live colour of the model; a sold-out one stays listed with orderable false and its reason, never a count", async () => {
    await setStock("var_nsw-oled-neon", 0);
    await addProduct({ slug: "test-oled-special", kind: "console", deviceModel: "switch-oled", variants: [{ sku: "TEST-OLED-SPECIAL", title: "Special", priceIqd: 600_000, stock: 2 }] });
    await addProduct({ slug: "test-oled-draft", kind: "console", status: "draft", deviceModel: "switch-oled", variants: [{ sku: "TEST-OLED-DRAFT", priceIqd: 500_000, stock: 2 }] });
    await addProduct({ slug: "test-oled-later", kind: "console", status: "scheduled", publishAt: NOW + DAY, deviceModel: "switch-oled", variants: [{ sku: "TEST-OLED-LATER", priceIqd: 500_000, stock: 2 }] });
    try {
      const catalog = await loadBuilderCatalog(t.db, "en", NOW);
      const oled = catalog.devices["switch-oled"];
      expect(oled?.productSlug).toBe("nintendo-switch-oled");
      expect(oled?.variants.map((option) => [option.variantId, option.orderable, option.reason])).toEqual([
        ["var_nsw-oled-wht", true, undefined],
        ["var_nsw-oled-neon", false, "out_of_stock"],
        ["var_test-oled-special", true, undefined],
      ]);
      assertNoCounts(catalog);
      // a scheduled console counts once its time has come
      const later = await loadBuilderCatalog(t.db, "en", NOW + 2 * DAY);
      expect(later.devices["switch-oled"]?.variants.map((option) => option.variantId)).toContain("var_test-oled-later");
    } finally {
      await setStock("var_nsw-oled-neon", 1);
    }
  });

  test("cards: only storage VERIFIED on every Switch 1 model; per size the cheapest orderable, else the cheapest; Express (partial) and half-checked cards are not offered", async () => {
    await addProduct({
      slug: "test-card-a",
      kind: "storage",
      rules: verifiedOnSwitch1(),
      variants: [
        { sku: "TEST-CARD-A-64", title: "64GB", options: { storage: "64GB" }, priceIqd: 30_000, stock: 2 },
        { sku: "TEST-CARD-A-128", title: "128GB", options: { storage: "128GB" }, priceIqd: 45_000, stock: 0 },
        { sku: "TEST-CARD-A-512", title: "512GB", options: { storage: "512GB" }, priceIqd: 99_000, stock: 3, isActive: false },
        { sku: "TEST-CARD-A-2TB", title: "2TB", options: { storage: "2TB" }, priceIqd: 299_000, stock: 3 },
      ],
    });
    await addProduct({
      slug: "test-card-b",
      kind: "storage",
      rules: verifiedOnSwitch1(),
      variants: [
        { sku: "TEST-CARD-B-64", title: "64GB", options: { storage: "64GB" }, priceIqd: 25_000, stock: 0 },
        { sku: "TEST-CARD-B-128", title: "128GB", options: { storage: "128 GB" }, priceIqd: 40_000, stock: 0 },
      ],
    });
    await addProduct({ slug: "test-card-express", kind: "storage", rules: verifiedOnSwitch1("partial"), variants: [{ sku: "TEST-CARD-EXPRESS-256", options: { storage: "256GB" }, priceIqd: 70_000, stock: 5 }] });
    await addProduct({ slug: "test-card-oled-only", kind: "storage", rules: [{ target: "device_model", slug: "switch-oled", status: "verified" }], variants: [{ sku: "TEST-CARD-OLED-512", options: { storage: "512GB" }, priceIqd: 90_000, stock: 5 }] });
    await addProduct({ slug: "test-card-draft", kind: "storage", status: "draft", rules: verifiedOnSwitch1(), variants: [{ sku: "TEST-CARD-DRAFT-512", options: { storage: "512GB" }, priceIqd: 90_000, stock: 5 }] });
    await addProduct({ slug: "test-card-free", kind: "storage", rules: verifiedOnSwitch1(), variants: [{ sku: "TEST-CARD-FREE-512", options: { storage: "512GB" }, priceIqd: 0, stock: 5 }] });
    // a rule on the whole Switch generation decides when no model rule is more specific
    await addProduct({ slug: "test-card-generation", kind: "storage", rules: [{ target: "generation", status: "verified" }], variants: [{ sku: "TEST-CARD-GEN-256", options: { storage: "256GB" }, priceIqd: 60_000, stock: 1 }] });
    // …and a more specific model rule beats it
    await addProduct({
      slug: "test-card-generation-but-lite",
      kind: "storage",
      rules: [{ target: "generation", status: "verified" }, { target: "device_model", slug: "switch-lite", status: "incompatible" }],
      variants: [{ sku: "TEST-CARD-GENLITE-256", options: { storage: "256GB" }, priceIqd: 10_000, stock: 9 }],
    });

    const catalog = await loadBuilderCatalog(t.db, "en", NOW);
    expect(Object.keys(catalog.cards).sort((a, b) => Number(a) - Number(b))).toEqual(["64", "128", "256", "1000"]);
    expect(catalog.cards[64]).toMatchObject({ variantId: "var_test-card-a-64", orderable: true, priceIqd: 30_000 });
    expect(catalog.cards[128]).toMatchObject({ variantId: "var_test-card-b-128", orderable: false, reason: "out_of_stock", priceIqd: 40_000 });
    expect(catalog.cards[256]).toMatchObject({ variantId: "var_test-card-gen-256", orderable: true });
    expect(catalog.cards[512]).toBeUndefined();
    expect(catalog.cards[1000]?.variantId).toBe("var_sandisk-ultra-1tb");
    assertNoCounts(catalog);
  });

  test("cartridges: Switch 1 cartridges by their US store key; Switch 2 variants and games, codes and ambiguous sources never; several products for one game → the orderable one", async () => {
    const platforms = ["switch", "switch-oled", "switch-lite", "switch-2"];
    await addProduct({
      slug: "test-game-one",
      kind: "game",
      mediaFormat: "physical",
      attributes: { game: { platforms, physicalFormat: "cartridge" }, sources: [{ url: US("test-game-one-switch") }, { url: US("test-game-one-110001") }] },
      variants: [{ sku: "TEST-GAME-ONE", title: "Nintendo Switch physical edition", options: { platform: "Nintendo Switch", format: "Game card" }, priceIqd: 70_000, stock: 1 }],
    });
    await addProduct({
      slug: "test-game-one-cheaper",
      kind: "game",
      mediaFormat: "physical",
      attributes: { game: { platforms, physicalFormat: "cartridge" }, sources: [{ url: US("test-game-one-switch") }] },
      variants: [{ sku: "TEST-GAME-ONE-CHEAPER", priceIqd: 50_000, stock: 0 }],
    });
    await addProduct({
      slug: "test-game-two",
      kind: "game",
      mediaFormat: "physical",
      attributes: { game: { platforms: ["switch-2", ...SWITCH_1], physicalFormat: "cartridge" }, sources: [{ url: US("test-game-two-nintendo-switch-2-edition-switch-2") }, { url: US("test-game-two-switch") }] },
      variants: [
        { sku: "TEST-GAME-TWO-NS2", options: { edition: "Nintendo Switch 2 Edition", platform: "Nintendo Switch 2" }, priceIqd: 40_000, stock: 5 },
        { sku: "TEST-GAME-TWO-NSW", options: { edition: "Standard", platform: "Nintendo Switch" }, priceIqd: 60_000, stock: 0 },
      ],
    });
    await addProduct({ slug: "test-game-ns2-only", kind: "game", mediaFormat: "physical", attributes: { game: { platforms: ["switch-2"], physicalFormat: "cartridge" }, sources: [{ url: US("test-game-ns2-only-switch") }] }, variants: [{ sku: "TEST-GAME-NS2-ONLY", priceIqd: 90_000, stock: 2 }] });
    await addProduct({
      slug: "test-compilation",
      kind: "game",
      mediaFormat: "physical",
      attributes: { game: { platforms, physicalFormat: "cartridge" }, sources: [{ url: US("test-game-alpha-switch") }, { url: US("test-compilation-switch") }, { url: US("test-game-beta-switch") }] },
      variants: [{ sku: "TEST-COMPILATION", priceIqd: 80_000, stock: 1 }],
    });
    await addProduct({ slug: "test-game-ambiguous", kind: "game", mediaFormat: "physical", attributes: { game: { platforms }, sources: [{ url: US("test-game-gamma-switch") }, { url: US("test-game-delta-switch") }] }, variants: [{ sku: "TEST-GAME-AMBIGUOUS", priceIqd: 30_000, stock: 1 }] });
    await addProduct({ slug: "test-game-code", kind: "game", mediaFormat: "physical", attributes: { game: { platforms, physicalFormat: "code-in-box" }, sources: [{ url: US("test-game-code-switch") }] }, variants: [{ sku: "TEST-GAME-CODE", priceIqd: 30_000, stock: 1 }] });
    await addProduct({ slug: "test-game-key", kind: "game", mediaFormat: "physical", attributes: { game: { platforms }, sources: [{ url: US("test-game-key-switch") }] }, variants: [{ sku: "TEST-GAME-KEY", options: { format: "Game-Key Card" }, priceIqd: 30_000, stock: 1 }] });
    await addProduct({ slug: "test-game-ps5", kind: "game", mediaFormat: "physical", attributes: { game: { platforms: ["ps5"] }, sources: [{ url: US("test-game-ps5-switch") }] }, variants: [{ sku: "TEST-GAME-PS5", priceIqd: 30_000, stock: 1 }] });
    await addProduct({ slug: "test-game-broken", kind: "game", mediaFormat: "physical", attributes: { game: { platforms: "switch" }, sources: "not a list" }, variants: [{ sku: "TEST-GAME-BROKEN", priceIqd: 30_000, stock: 1 }] });
    // malformed attributes JSON (staff tools write JSON, but a hand edit could break it): left out, never a failed read
    await t.d1.prepare("UPDATE products SET attributes = ? WHERE id = ?").bind("{not json", "prd_test-game-broken").run();

    const catalog = await loadBuilderCatalog(t.db, "en", NOW);
    expect(catalog.cartridges["test-game-one-switch"]).toMatchObject({ productSlug: "test-game-one", variantId: "var_test-game-one", orderable: true, priceIqd: 70_000, art: "test-game-one--1", variantTitle: "Nintendo Switch physical edition" });
    // the Switch 1 copy, even though the Switch 2 Edition is cheaper and in stock
    expect(catalog.cartridges["test-game-two-switch"]).toMatchObject({ variantId: "var_test-game-two-nsw", orderable: false, reason: "out_of_stock" });
    expect(catalog.cartridges["test-game-ns2-only-switch"]).toBeUndefined();
    expect(catalog.cartridges["test-compilation-switch"]).toMatchObject({ productSlug: "test-compilation" });
    for (const id of ["test-game-alpha-switch", "test-game-beta-switch", "test-game-gamma-switch", "test-game-delta-switch", "test-game-code-switch", "test-game-key-switch", "test-game-ps5-switch", "test-game-broken-switch"]) expect(catalog.cartridges[id], id).toBeUndefined();
    for (const id of FIVE_CARTRIDGES) expect(catalog.cartridges[id], id).toBeDefined();
    assertNoCounts(catalog);
  });

  test("eShop cards: US wallet top-ups verified on Switch 1, one per value, sold when one is orderable", async () => {
    expect((await loadBuilderCatalog(t.db, "en", NOW)).eshop.sold).toBe(false);
    await addProduct({
      slug: "test-eshop",
      kind: "digital",
      mediaFormat: "digital",
      licenseType: "wallet_topup",
      rules: [...verifiedOnSwitch1(), { target: "device_model", slug: "switch-2", status: "verified" }],
      variants: [
        { sku: "TEST-ESHOP-US-10", title: "US account · $10", options: { region: "United States", value: "10 USD" }, priceIqd: 14_000, stock: 5 },
        { sku: "TEST-ESHOP-US-20", title: "US account · $20", options: { region: "United States", value: "20 USD" }, priceIqd: 27_000, stock: 2 },
        { sku: "TEST-ESHOP-US-50", title: "US account · $50", options: { region: "United States", value: "50 USD" }, priceIqd: 66_000, stock: 1 },
        { sku: "TEST-ESHOP-US-100", title: "US account · $100", options: { region: "United States", value: "100 USD" }, priceIqd: 130_000, stock: 0 },
        { sku: "TEST-ESHOP-UK-15", title: "UK account · £15", options: { region: "United Kingdom", value: "15 GBP" }, priceIqd: 25_000, stock: 5 },
        { sku: "TEST-ESHOP-US-ODD", options: { region: "United States", value: "a gift" }, priceIqd: 5_000, stock: 5 },
      ],
    });
    // a top-up with no Switch rule (another store's card) and a Switch subscription are not eShop cards
    await addProduct({ slug: "test-other-wallet", kind: "digital", mediaFormat: "digital", licenseType: "wallet_topup", variants: [{ sku: "TEST-OTHER-US-10", options: { region: "United States", value: "10 USD" }, priceIqd: 9_000, stock: 5 }] });
    await addProduct({ slug: "test-nso", kind: "digital", mediaFormat: "digital", licenseType: "subscription", rules: verifiedOnSwitch1(), variants: [{ sku: "TEST-NSO-US-20", options: { region: "United States", value: "20 USD" }, priceIqd: 1_000, stock: 5 }] });

    const catalog = await loadBuilderCatalog(t.db, "en", NOW);
    expect(catalog.eshop).toEqual({
      sold: true,
      denominations: [
        { cents: 1_000, variantId: "var_test-eshop-us-10", priceIqd: 14_000, orderable: true },
        { cents: 2_000, variantId: "var_test-eshop-us-20", priceIqd: 27_000, orderable: true },
        { cents: 5_000, variantId: "var_test-eshop-us-50", priceIqd: 66_000, orderable: true },
        { cents: 10_000, variantId: "var_test-eshop-us-100", priceIqd: 130_000, orderable: false },
      ],
    });
    assertNoCounts(catalog);
  });

  test("the small readers: card sizes, US cents, library ids", () => {
    expect([cardSizeOf("64GB"), cardSizeOf("128 GB"), cardSizeOf("256gb"), cardSizeOf("512GB"), cardSizeOf("1TB"), cardSizeOf("2TB"), cardSizeOf("32GB"), cardSizeOf(undefined), cardSizeOf("1.5TB")]).toEqual([64, 128, 256, 512, 1000, null, null, null, null]);
    expect([usdCentsOf("10 USD"), usdCentsOf("10.5 USD"), usdCentsOf("70usd"), usdCentsOf("0 USD"), usdCentsOf("15 GBP"), usdCentsOf("$10"), usdCentsOf(null)]).toEqual([1_000, 1_050, 7_000, null, null, null, null]);
    expect(libraryIdOf("hades", JSON.stringify([{ url: "https://www.nintendo.com/us/store/products/hades-switch/" }]))).toBe("hades-switch");
    expect(libraryIdOf("x", [{ url: "https://www.nintendo.com/us/store/products/hades-switch?x=1" }, { url: "https://www.nintendo.com/en-gb/Games/hades-switch/" }])).toBe("hades-switch");
    expect(libraryIdOf("x", [{ url: "https://www.nintendo.com/us/store/products/mario-kart-world-switch-2/" }])).toBeNull();
    expect(libraryIdOf("x", [{ url: "https://evil.example/us/store/products/hades-switch/" }])).toBeNull();
    expect(libraryIdOf("x", null)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── parsePlan

const VALID: BuilderPlan = {
  v: 1,
  device: { model: "switch-oled", owned: false, variantId: "var_nsw-oled-wht" },
  card: { sizeGB: 256, owned: false, variantId: "var_sandisk-extreme-256" },
  games: [
    { id: "hades-switch", format: "digital" },
    { id: "mario-tennis-aces-switch", format: "cartridge" },
  ],
};

describe("parsePlan", () => {
  test("a valid plan — the object or its JSON — comes back clean: unknown keys dropped, a game listed twice counts once, ids of owned parts dropped", () => {
    expect(parsePlan(VALID)).toEqual(VALID);
    expect(parsePlan(JSON.stringify(VALID))).toEqual(VALID);
    const messy = { ...VALID, priceIqd: 1, device: { ...VALID.device, priceIqd: 1 }, games: [...VALID.games, { id: "hades-switch", format: "cartridge", sizeBytes: 1 }] };
    expect(parsePlan(messy)).toEqual(VALID);
    expect(parsePlan({ ...VALID, device: { model: "switch-lite", owned: true, variantId: "var_x" }, card: { sizeGB: 0, owned: true, variantId: "var_y" } })).toEqual({ ...VALID, device: { model: "switch-lite", owned: true }, card: { sizeGB: 0, owned: false } });
    expect(parsePlan({ ...VALID, card: { sizeGB: 1000, owned: true, variantId: "var_y" }, games: [] })).toEqual({ ...VALID, card: { sizeGB: 1000, owned: true }, games: [] });
    const full = { ...VALID, games: Array.from({ length: PLAN_LIMITS.maxGames }, (_, i) => ({ id: `game-${i}-switch`, format: "digital" as const })) };
    expect(parsePlan(full)?.games).toHaveLength(PLAN_LIMITS.maxGames);
  });

  test("junk is refused (null)", () => {
    const junk: unknown[] = [
      null,
      undefined,
      42,
      "",
      "not json",
      "{",
      [],
      { ...VALID, v: 2 },
      { ...VALID, v: "1" },
      { ...VALID, device: { ...VALID.device, model: "switch-2" } },
      { ...VALID, device: { ...VALID.device, owned: "no" } },
      { ...VALID, device: { ...VALID.device, variantId: "not an id" } },
      { ...VALID, device: undefined },
      { ...VALID, card: { ...VALID.card, sizeGB: 300 } },
      { ...VALID, card: { ...VALID.card, sizeGB: "256" } },
      { ...VALID, card: { ...VALID.card, variantId: "x".repeat(200) } },
      { ...VALID, games: "hades-switch" },
      { ...VALID, games: [{ id: "Hades Switch", format: "digital" }] },
      { ...VALID, games: [{ id: "../hades", format: "digital" }] },
      { ...VALID, games: [{ id: "__proto__", format: "digital" }] },
      { ...VALID, games: [{ id: "hades-switch", format: "physical" }] },
      { ...VALID, games: [{ id: "hades-switch" }] },
      { ...VALID, games: Array.from({ length: PLAN_LIMITS.maxGames + 1 }, (_, i) => ({ id: `game-${i}-switch`, format: "digital" })) },
      JSON.stringify({ ...VALID, padding: "x".repeat(40_000) }),
    ];
    for (const raw of junk) expect(parsePlan(raw), JSON.stringify(raw)?.slice(0, 90)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── quoteBuilderPlan

const EXTRAS: Record<string, LibraryExtras> = {
  "mario-tennis-aces-switch": { priceUsdCents: 5_999, sizeBytes: 2_576_980_378 },
  "hades-switch": { priceUsdCents: 2_499 },
  "hidden-switch": { priceUsdCents: 1_999, hidden: true },
  "zelda-switch": { sizeBytes: 15_000_000_000 },
};

describe("quoteBuilderPlan", () => {
  test("lines and totals: the console, the card, cartridges (a cartridge TamTam does not sell counts as digital), digital games and the eShop cards that cover them", async () => {
    const plan: BuilderPlan = {
      v: 1,
      device: { model: "switch-oled", owned: false, variantId: "var_nsw-oled-wht" },
      card: { sizeGB: 1000, owned: false },
      games: [
        { id: "test-game-one-switch", format: "cartridge" },
        { id: "test-game-two-switch", format: "cartridge" },
        { id: "mario-tennis-aces-switch", format: "digital" },
        { id: "hades-switch", format: "cartridge" },
        { id: "zelda-switch", format: "digital" },
        { id: "hidden-switch", format: "digital" },
      ],
    };
    const quote = await quoteBuilderPlan(t.db, "en", plan, EXTRAS, NOW);
    const white = await priceOf("var_nsw-oled-wht");
    const ultra = await priceOf("var_sandisk-ultra-1tb");
    expect(quote.lines.map((line) => [line.kind, line.variantId, line.qty, line.orderable, line.gameId])).toEqual([
      ["device", "var_nsw-oled-wht", 1, true, undefined],
      ["card", "var_sandisk-ultra-1tb", 1, true, undefined],
      ["cartridge", "var_test-game-one", 1, true, "test-game-one-switch"],
      ["cartridge", "var_test-game-two-nsw", 1, false, "test-game-two-switch"],
      // $59.99 + $24.99 = $84.98 → $90 in three cards ($50 + 2 × $20) beats four ($50 + $20 + 2 × $10)
      ["eshop", "var_test-eshop-us-50", 1, true, undefined],
      ["eshop", "var_test-eshop-us-20", 2, true, undefined],
    ]);
    expect(quote.lines[0]).toMatchObject({ productSlug: "nintendo-switch-oled", name: expect.stringMatching(/Switch/), variantTitle: "White", unitPriceIqd: white, art: expect.stringMatching(/^nintendo-switch-oled--/) });
    expect(quote.lines[3]).toMatchObject({ reason: "out_of_stock", unitPriceIqd: 60_000 });
    expect(quote.lines[4]).toMatchObject({ name: "Product test-eshop", variantTitle: "US account · $50", unitPriceIqd: 66_000 });
    expect(quote.totalIqd).toBe(white + ultra + 70_000 + 66_000 + 2 * 27_000);
    expect(quote.digital).toEqual({ pricedCents: 8_498, pricedCount: 2, unpricedIds: ["zelda-switch", "hidden-switch"], cardsCents: 9_000, cardsSold: true });
    expect(quote.notSold).toEqual([]);
  });

  test("nothing is trusted from the browser: a foreign or stale colour is not sold, and the card is the catalogue's choice for the size", async () => {
    const plan: BuilderPlan = { v: 1, device: { model: "switch-oled", owned: false, variantId: "var_test-game-one" }, card: { sizeGB: 64, owned: false, variantId: "var_test-card-b-64" }, games: [] };
    const quote = await quoteBuilderPlan(t.db, "ar", plan, {}, NOW);
    expect(quote.lines.map((line) => [line.kind, line.variantId, line.unitPriceIqd])).toEqual([["card", "var_test-card-a-64", 30_000]]);
    expect(quote.notSold).toEqual([{ kind: "device", model: "switch-oled" }]);
    expect(quote.totalIqd).toBe(30_000);
    // no colour chosen yet: nothing to quote, nothing "not sold" (the model is sold)
    expect((await quoteBuilderPlan(t.db, "ar", { ...plan, device: { model: "switch-oled", owned: false } }, {}, NOW)).notSold).toEqual([]);
  });

  test("notSold: a console model and a card size TamTam does not sell; owned parts add nothing", async () => {
    const plan: BuilderPlan = { v: 1, device: { model: "switch-lite", owned: false }, card: { sizeGB: 512, owned: false }, games: [] };
    const quote = await quoteBuilderPlan(t.db, "en", plan, {}, NOW);
    expect(quote).toEqual({ lines: [], totalIqd: 0, digital: { pricedCents: 0, pricedCount: 0, unpricedIds: [], cardsCents: 0, cardsSold: true }, notSold: [{ kind: "device", model: "switch-lite" }, { kind: "card", sizeGB: 512 }] });
    const owned = await quoteBuilderPlan(t.db, "en", { ...plan, device: { model: "switch-lite", owned: true }, card: { sizeGB: 512, owned: true } }, {}, NOW);
    expect(owned.lines).toEqual([]);
    expect(owned.notSold).toEqual([]);
    const noCard = await quoteBuilderPlan(t.db, "en", { ...plan, device: { model: "switch", owned: true }, card: { sizeGB: 0, owned: false } }, {}, NOW);
    expect(noCard.notSold).toEqual([]);
  });

  test("eShop stock that cannot cover the total: every card in stock is proposed, and cardsCents < pricedCents says so", async () => {
    const extras: Record<string, LibraryExtras> = { "big-a-switch": { priceUsdCents: 30_000 }, "big-b-switch": { priceUsdCents: 20_000 } };
    const plan: BuilderPlan = { v: 1, device: { model: "switch-oled", owned: true }, card: { sizeGB: 0, owned: false }, games: [{ id: "big-a-switch", format: "digital" }, { id: "big-b-switch", format: "digital" }] };
    const quote = await quoteBuilderPlan(t.db, "en", plan, extras, NOW);
    expect(quote.lines.map((line) => [line.variantId, line.qty])).toEqual([
      ["var_test-eshop-us-50", 1],
      ["var_test-eshop-us-20", 2],
      ["var_test-eshop-us-10", 5],
    ]);
    expect(quote.digital).toMatchObject({ pricedCents: 50_000, pricedCount: 2, cardsCents: 14_000, cardsSold: true });
  });

  test("no eShop card can be bought: no card lines, cardsSold false, the digital total still said", async () => {
    for (const sku of ["test-eshop-us-10", "test-eshop-us-20", "test-eshop-us-50"]) await setStock(`var_${sku}`, 0);
    try {
      const plan: BuilderPlan = { v: 1, device: { model: "switch-oled", owned: true }, card: { sizeGB: 0, owned: false }, games: [{ id: "hades-switch", format: "digital" }] };
      const quote = await quoteBuilderPlan(t.db, "en", plan, EXTRAS, NOW);
      expect(quote).toEqual({ lines: [], totalIqd: 0, digital: { pricedCents: 2_499, pricedCount: 1, unpricedIds: [], cardsCents: 0, cardsSold: false }, notSold: [] });
    } finally {
      await setStock("var_test-eshop-us-10", 5);
      await setStock("var_test-eshop-us-20", 2);
      await setStock("var_test-eshop-us-50", 1);
    }
  });

  test("quoted prices are today's catalogue prices, and quoting never touches a cart", async () => {
    const cartRows = async () => Number((await t.db.all<{ n: number }>(sql`SELECT (SELECT count(*) FROM carts) + (SELECT count(*) FROM cart_items) AS n`))[0]?.n ?? 0);
    const before = await cartRows();
    await t.db.update(variants).set({ priceIqd: 75_000 }).where(eq(variants.id, "var_test-game-one"));
    const quote = await quoteBuilderPlan(t.db, "en", { v: 1, device: { model: "switch", owned: true }, card: { sizeGB: 0, owned: false }, games: [{ id: "test-game-one-switch", format: "cartridge" }] }, {}, NOW);
    expect(quote.lines[0]).toMatchObject({ kind: "cartridge", unitPriceIqd: 75_000 });
    expect(quote.totalIqd).toBe(75_000);
    expect(await cartRows()).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────── the production SQL for the memory sizes

/** The statements of an SQL file: comment lines dropped, split at the `;` that ends each statement. */
function statementsOf(file: string): string[] {
  const text = readFileSync(path.join(PROJECT_ROOT, file), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return text
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("scripts/sql/2026-11-21-switch-builder.sql — the memory sizes for production", () => {
  test("adds the 64GB, 128GB, 512GB and 1TB Extreme variants switched off at price 0 with no stock, leaves everything else alone, and a second run changes nothing", async () => {
    const added = ["SANDISK-EXTREME-64", "SANDISK-EXTREME-128", "SANDISK-EXTREME-512", "SANDISK-EXTREME-1TB"].map((sku) => `var_${sku.toLowerCase()}`);
    // production today: the draft product with its 256GB variant only (the catalogue import above wrote the new sizes)
    await t.d1.batch([
      t.d1.prepare("DELETE FROM stock_levels WHERE variant_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(added)),
      t.d1.prepare("DELETE FROM variants WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(added)),
    ]);
    // …where staff added a 128GB size by hand (another SKU, typed «128 gb»: the admin's storage option is free text, and
    // the builder reads that spelling as 128GB): the file leaves that size alone
    expect(cardSizeOf("128 gb")).toBe(128);
    await t.d1.prepare("INSERT INTO variants (id, product_id, sku, options, price_iqd, is_default, is_active, sort, created_at, updated_at) VALUES ('var_staff-extreme-128', 'prd_sandisk-extreme-microsd', 'STAFF-EXTREME-128', ?, 0, 0, 0, 9, 1, 1)").bind(JSON.stringify({ storage: "128 gb" })).run();

    const tables = ["products", "stock_levels", "stock_movements", "media", "variant_costs", "price_changes", "search_index", "compatibility_rules"];
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await t.d1.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0] as const)));
    const productRow = () => t.d1.prepare("SELECT * FROM products WHERE slug = 'sandisk-extreme-microsd'").first();
    const variantRows = async () => (await t.d1.prepare("SELECT id, sku, barcode, title, options, price_iqd, compare_at_iqd, is_default, is_active, track_serials, sort, weight_grams, created_at, updated_at FROM variants WHERE product_id = 'prd_sandisk-extreme-microsd' ORDER BY sort, id").all()).results;
    const beforeCounts = await counts();
    const beforeProduct = await productRow();
    const before256 = (await variantRows()).find((row) => row.sku === "SANDISK-EXTREME-256");

    const statements = statementsOf("scripts/sql/2026-11-21-switch-builder.sql");
    expect(statements).toHaveLength(4);
    expect(statements.every((statement) => statement.startsWith("INSERT INTO variants"))).toBe(true);
    await t.d1.batch(statements.map((statement) => t.d1.prepare(statement)));
    const once = await variantRows();
    await t.d1.batch(statements.map((statement) => t.d1.prepare(statement)));
    expect(await variantRows()).toEqual(once);

    expect(once.map((row) => [row.sku, row.barcode, row.price_iqd, row.compare_at_iqd, row.is_default, row.is_active, row.track_serials, row.sort])).toEqual([
      ["SANDISK-EXTREME-256", "619659188504", 0, null, 1, 0, 0, 0],
      ["SANDISK-EXTREME-64", "619659193409", 0, null, 0, 0, 0, 1],
      ["SANDISK-EXTREME-512", "619659189648", 0, null, 0, 0, 0, 3],
      ["SANDISK-EXTREME-1TB", "619659188474", 0, null, 0, 0, 0, 4],
      ["STAFF-EXTREME-128", null, 0, null, 0, 0, 0, 9],
    ]);
    const bySku = new Map(once.map((row) => [row.sku as string, row]));
    expect(JSON.parse(bySku.get("SANDISK-EXTREME-64")?.options as string)).toEqual({ storage: "64GB", model: "SDSQXAH-064G-GN6MA" });
    expect(JSON.parse(bySku.get("SANDISK-EXTREME-1TB")?.title as string)).toEqual({ ar: "1TB", en: "1TB", ckb: "1TB" });
    expect(Number(bySku.get("SANDISK-EXTREME-512")?.created_at)).toBeGreaterThan(1_700_000_000_000);
    // the same rows the catalogue import writes (id, options, title), so a later import finds them
    expect(bySku.get("SANDISK-EXTREME-1TB")?.id).toBe("var_sandisk-extreme-1tb");
    // nothing else: the product, the 256GB variant, no stock, cost, price change, picture or search row
    expect(once.find((row) => row.sku === "SANDISK-EXTREME-256")).toEqual(before256);
    expect(await productRow()).toEqual(beforeProduct);
    expect(await counts()).toEqual(beforeCounts);
    // and the builder still offers no Extreme card (switched off, unpriced, a draft)
    const catalog = await loadBuilderCatalog(t.db, "en", NOW);
    expect(Object.values(catalog.cards).some((option) => option?.productSlug === "sandisk-extreme-microsd")).toBe(false);

    // a 1TB card staff typed as «1000 GB» is the same size (the builder reads it so): a later run adds no second 1TB
    expect(cardSizeOf("1000 GB")).toBe(1000);
    await t.d1.batch([
      t.d1.prepare("DELETE FROM variants WHERE id = 'var_sandisk-extreme-1tb'"),
      t.d1.prepare("INSERT INTO variants (id, product_id, sku, options, price_iqd, is_default, is_active, sort, created_at, updated_at) VALUES ('var_staff-extreme-1000', 'prd_sandisk-extreme-microsd', 'STAFF-EXTREME-1000', ?, 0, 0, 0, 10, 1, 1)").bind(JSON.stringify({ storage: "1000 GB" })),
    ]);
    await t.d1.batch(statements.map((statement) => t.d1.prepare(statement)));
    expect((await variantRows()).map((row) => row.sku)).toEqual(["SANDISK-EXTREME-256", "SANDISK-EXTREME-64", "SANDISK-EXTREME-512", "STAFF-EXTREME-128", "STAFF-EXTREME-1000"]);
  });
});

// ───────────────────────────────────────────────────────────────── mixEshopCards

const US_CARDS = (max = MAX_UNITS_PER_VALUE): EshopValue[] => [1_000, 2_000, 5_000, 7_000, 10_000].map((cents) => ({ cents, max }));

/** Exhaustive search with the same rule, for the cross-check. */
function bruteForce(amount: number, values: EshopValue[]) {
  const offer = usableValues(values);
  let best: { counts: number[]; total: number; count: number; distinct: number } | null = null;
  const counts = new Array(offer.length).fill(0);
  const visit = (i: number) => {
    if (i === offer.length) {
      const total = counts.reduce((sum, k, j) => sum + k * offer[j].cents, 0);
      if (total < amount) return;
      const count = counts.reduce((sum, k) => sum + k, 0);
      const distinct = counts.filter((k) => k > 0).length;
      const lexBetter = () => {
        for (let j = 0; j < counts.length; j++) if (counts[j] !== best!.counts[j]) return counts[j] > best!.counts[j];
        return false;
      };
      if (!best || total < best.total || (total === best.total && (count < best.count || (count === best.count && (distinct < best.distinct || (distinct === best.distinct && lexBetter())))))) best = { counts: [...counts], total, count, distinct };
      return;
    }
    for (let k = 0; k <= offer[i].max; k++) {
      counts[i] = k;
      visit(i + 1);
    }
    counts[i] = 0;
  };
  visit(0);
  return best as { counts: number[]; total: number; count: number } | null;
}

describe("mixEshopCards", () => {
  test("nothing to cover needs no card", () => {
    expect(mixEshopCards(0, US_CARDS())).toEqual({ cards: [], totalCents: 0, overshootCents: 0, count: 0 });
    expect(mixEshopCards(-500, US_CARDS())).toEqual({ cards: [], totalCents: 0, overshootCents: 0, count: 0 });
  });

  test("the least money left over first, then the fewest cards, then the fewest values, then more of the larger", () => {
    // exact: one $70 card
    expect(mixEshopCards(6_999, US_CARDS())).toMatchObject({ cards: [{ cents: 7_000, qty: 1 }], totalCents: 7_000, overshootCents: 1 });
    // $60: $50 + $10 (nothing left over) beats one $70 card
    expect(mixEshopCards(6_000, US_CARDS())?.cards).toEqual([{ cents: 5_000, qty: 1 }, { cents: 1_000, qty: 1 }]);
    // $40: two $20 cards, not four $10
    expect(mixEshopCards(4_000, US_CARDS())?.cards).toEqual([{ cents: 2_000, qty: 2 }]);
    // $80 with 50/40/30/10: 2 × $40 (one value) beats $50 + $30
    expect(mixEshopCards(8_000, [5_000, 4_000, 3_000, 1_000].map((cents) => ({ cents, max: 5 })))?.cards).toEqual([{ cents: 4_000, qty: 2 }]);
    // $120: $100 + $20 and $70 + $50 tie (two cards, two values) → more of the larger
    expect(mixEshopCards(12_000, US_CARDS())?.cards).toEqual([{ cents: 10_000, qty: 1 }, { cents: 2_000, qty: 1 }]);
  });

  test("within the units available of each value", () => {
    // no $10 card: $60 becomes $50 + $20 ($10 left over)
    expect(mixEshopCards(6_000, [{ cents: 5_000, max: 1 }, { cents: 2_000, max: 2 }, { cents: 1_000, max: 0 }])).toMatchObject({ cards: [{ cents: 5_000, qty: 1 }, { cents: 2_000, qty: 1 }], overshootCents: 1_000 });
    // one $50 only: $100 needs $50 + $20 + $20 + $10
    expect(mixEshopCards(10_000, [{ cents: 5_000, max: 1 }, { cents: 2_000, max: 2 }, { cents: 1_000, max: 5 }])?.cards).toEqual([{ cents: 5_000, qty: 1 }, { cents: 2_000, qty: 2 }, { cents: 1_000, qty: 1 }]);
    // not enough cards: null
    expect(mixEshopCards(20_000, [{ cents: 5_000, max: 1 }, { cents: 2_000, max: 2 }])).toBeNull();
    // at most 10 of a value (a cart line's limit), whatever the stock
    expect(mixEshopCards(15_000, [{ cents: 1_000, max: 50 }])).toBeNull();
    expect(mixEshopCards(10_000, [{ cents: 1_000, max: 50 }])?.cards).toEqual([{ cents: 1_000, qty: 10 }]);
    expect(allEshopCards([{ cents: 1_000, max: 50 }, { cents: 2_000, max: 2 }])).toEqual({ cards: [{ cents: 2_000, qty: 2 }, { cents: 1_000, qty: 10 }], totalCents: 14_000, overshootCents: 0, count: 12 });
  });

  test("junk values are ignored; a value offered twice counts once with the larger allowance", () => {
    const junk = [{ cents: -1_000, max: 3 }, { cents: 1.5, max: 3 }, { cents: Number.NaN, max: 3 }, { cents: 1_000, max: 0 }, { cents: 2_000, max: Number.NaN }] as EshopValue[];
    expect(mixEshopCards(1_000, junk)).toBeNull();
    expect(mixEshopCards(Number.NaN, US_CARDS())).toBeNull();
    expect(usableValues([{ cents: 1_000, max: 3 }, { cents: 1_000, max: 5 }, ...junk])).toEqual([{ cents: 1_000, max: 5 }]);
    expect(mixEshopCards(5_000, [{ cents: 1_000, max: 3 }, { cents: 1_000, max: 5 }])?.cards).toEqual([{ cents: 1_000, qty: 5 }]);
  });

  test("big totals stay exact and fast (bounded search)", () => {
    const started = Date.now();
    const mix = mixEshopCards(239_850, US_CARDS());
    expect(mix).not.toBeNull();
    expect(mix?.totalCents).toBe(240_000);
    expect(mix?.cards.every((card) => card.qty <= MAX_UNITS_PER_VALUE)).toBe(true);
    // more than every card on offer (10 of each US value = $2,500): null, at once
    expect(mixEshopCards(840_000, US_CARDS())).toBeNull();
    // odd values with a 1-cent step stay bounded: null rather than a slow request
    expect(mixEshopCards(5_000_000, [{ cents: 999_999, max: 10 }, { cents: 1_000_001, max: 10 }])).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("cross-check against an exhaustive search (random small cases)", () => {
    let seed = 20261121;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pool = [500, 1_000, 1_500, 2_000, 2_500, 3_000, 5_000, 7_000, 10_000];
    for (let round = 0; round < 250; round++) {
      const values = pool.filter(() => random() < 0.45).map((cents) => ({ cents, max: Math.floor(random() * 5) }));
      const amount = Math.floor(random() * 40_000);
      const expected = bruteForce(amount, values);
      const mix = mixEshopCards(amount, values);
      if (amount <= 0) {
        expect(mix?.count).toBe(0);
        continue;
      }
      if (!expected) {
        expect(mix, `${amount} ${JSON.stringify(values)}`).toBeNull();
        continue;
      }
      const offer = usableValues(values);
      const counts = offer.map((value) => mix?.cards.find((card) => card.cents === value.cents)?.qty ?? 0);
      expect({ total: mix?.totalCents, counts }, `${amount} ${JSON.stringify(values)}`).toEqual({ total: expected.total, counts: expected.counts });
    }
  });
});
