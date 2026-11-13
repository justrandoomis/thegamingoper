/**
 * Device hubs (services/devices.server.ts) and compatibility (services/compatibility.server.ts) against a real local D1.
 *
 * Two kinds of data, on purpose (as tests/catalog-cards.test.ts does):
 *   · the DEMO catalogue (seedDemo): 26 researched device models and 391 researched rules. Expectations are derived
 *     from the database with raw SQL — never from a product slug — so they hold when the research changes.
 *   · a TEST WORLD on its own platforms ("zz-dev", inactive "zz-off"): models, products and rules whose exact
 *     answers are written down here — model › generation › platform precedence, variant over product, versions that
 *     disagree, explicit "unverified" fillers, the inactive platform, drafts, articles, used units.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompatibilityStatus, ProductCardData, StockState } from "~/lib/dto";
import { pick, type L10n } from "~/lib/locales";
import { compatibilityRules, deviceGenerations, deviceModels, knowledgeArticles, media, platforms, products, stockLevels, variants } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { isAppError } from "~/server/errors";
import { decidingRule, getCompatibilityForProduct, resolveForModel, type RuleLite, type VariantLite } from "~/server/services/compatibility.server";
import { getProductDetail } from "~/server/services/catalog/product.server";
import { artSlug, buildComparison, buildFaq, cheapestAvailable, getDeviceHub, groupSpecs, isolateLatin, listDeviceHubs, type DeviceHub } from "~/server/services/devices.server";
import {
  cheapestOrderable,
  currentSection,
  deviceIn,
  drawableShelves,
  expandedGrids,
  headFacts,
  headPrice,
  hubSections,
  keepTogether,
  onlyGridsChanged,
  sourceLang,
  toggleGrid,
} from "~/routes/storefront/devices/components/format";
import { SourceText } from "~/routes/storefront/devices/components/SourceText";
import { fromPriceOf } from "~/routes/storefront/devices/hub.server";
import devicesMessages from "~/i18n/messages/devices";
import { makeT, type MessageTree } from "~/i18n/translate";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const parse = (text: string | null): L10n | null => (text ? (JSON.parse(text) as L10n) : null);
const t3 = (ar: string, en: string, ckb: string): L10n => ({ ar, en, ckb });

/** Every product id on a hub, with the status the hub gives it. */
function statusesOf(hub: DeviceHub, part: "games" | "accessories"): Map<string, CompatibilityStatus> {
  const out = new Map<string, CompatibilityStatus>();
  for (const group of hub[part]) for (const item of group.items) out.set(item.card.id, item.status);
  return out;
}

// ───────────────────────────────────────────────────────────────── the test world

const W = {
  platform: "plt_zzdev",
  off: "plt_zzoff",
  generation: "gen_zzgen",
  alpha: "dvm_zzalpha",
  beta: "dvm_zzbeta",
  gamma: "dvm_zzgamma", // same platform, other generation, no rules
  draft: "dvm_zzdraft",
  offModel: "dvm_zzoffmodel",
  // products
  plat: "prd_zz_platform_rule", // platform-level verified, model-level incompatible on beta
  split: "prd_zz_split", // two versions that disagree on alpha
  variantWins: "prd_zz_variant_wins", // product verified on alpha, its variant unverified on alpha
  game: "prd_zz_game", // game.platforms lists alpha, no rule
  device: "prd_zz_device", // the product that IS alpha
  gen: "prd_zz_generation", // generation-level partial
  pc: "prd_zz_off", // rule only for the inactive platform's model
} as const;

async function buildWorld(now: number) {
  const db = t.db;
  const product = (id: string, kind: "accessory" | "game" | "console", extra: Partial<typeof products.$inferInsert> = {}) =>
    db.insert(products).values({ id, slug: id.replace(/^prd_/, "").replace(/_/g, "-"), kind, name: t3(`منتج ${id}`, `Product ${id}`, `بەرهەم ${id}`), status: "published", createdAt: now, updatedAt: now, ...extra });
  const variant = (id: string, productId: string, extra: Partial<typeof variants.$inferInsert> = {}) =>
    db.insert(variants).values({ id, productId, sku: `SKU-${id}`, priceIqd: 100_000, isDefault: true, title: t3(`نسخة ${id}`, `Version ${id}`, `وەشانی ${id}`), ...extra });
  const rule = (id: string, subjectType: "product" | "variant", subjectId: string, targetType: "device_model" | "generation" | "platform", targetId: string, status: CompatibilityStatus, note?: L10n) =>
    db.insert(compatibilityRules).values({ id, subjectType, subjectId, targetType, targetId, status, note: note ?? null });
  const spec = (ar: string, en: string, label: L10n) => ({ ar, en, ckb: ar, label });
  const statements: BatchStatement[] = [
    db.insert(platforms).values({ id: W.platform, slug: "zz-dev", name: t3("منصة الاختبار", "Test platform", "پلاتفۆرمی تاقیکردنەوە"), accent: "xbox", sort: 90, isActive: true }),
    db.insert(platforms).values({ id: W.off, slug: "zz-off", name: t3("منصة متوقفة", "Inactive platform", "پلاتفۆرمی ناچالاک"), sort: 91, isActive: false }),
    db.insert(deviceGenerations).values({ id: W.generation, platformId: W.platform, slug: "zz-gen", name: t3("جيل الاختبار", "Test generation", "نەوەی تاقیکردنەوە") }),
    db.insert(deviceModels).values({
      id: W.alpha,
      platformId: W.platform,
      generationId: W.generation,
      slug: "zz-alpha",
      name: t3("Alpha", "Alpha", "Alpha"),
      summary: t3("جهاز اختبار", "A test device", "ئامێری تاقیکردنەوە"),
      specs: {
        storage: spec("512 جيجابايت", "512GB", t3("التخزين", "Storage", "بیرگە")),
        expansion: spec("بطاقة microSD", "microSD card", t3("التوسعة", "Expansion", "زیادکردن")),
        battery: spec("6 ساعات", "6 hours", t3("البطارية", "Battery", "پاتری")),
        weight: spec("600 غرام", "600 g", t3("الوزن", "Weight", "کێش")),
      },
      releasedOn: "2025-03-04",
      status: "published",
      deviceKind: "console",
      artKey: "zz-device--1",
      sort: 1,
    }),
    db.insert(deviceModels).values({
      id: W.beta,
      platformId: W.platform,
      generationId: W.generation,
      slug: "zz-beta",
      name: t3("Beta", "Beta", "Beta"),
      specs: { storage: spec("1 تيرابايت", "1TB", t3("التخزين", "Storage", "بیرگە")) },
      releasedOn: "2024",
      status: "published",
      deviceKind: "console",
      sort: 2,
    }),
    db.insert(deviceModels).values({ id: W.gamma, platformId: W.platform, slug: "zz-gamma", name: t3("Gamma", "Gamma", "Gamma"), status: "published", deviceKind: "handheld_pc", sort: 3 }),
    db.insert(deviceModels).values({ id: W.draft, platformId: W.platform, generationId: W.generation, slug: "zz-draft", name: t3("Draft", "Draft", "Draft"), status: "draft", sort: 4 }),
    db.insert(deviceModels).values({ id: W.offModel, platformId: W.off, slug: "zz-off-model", name: t3("Off", "Off", "Off"), status: "published", deviceKind: "other", sort: 5 }),
    product(W.plat, "accessory", { platformId: W.platform }),
    product(W.split, "accessory", { platformId: W.platform }),
    product(W.variantWins, "accessory", { platformId: W.platform }),
    product(W.game, "game", { attributes: { game: { platforms: ["zz-alpha"] } } }),
    product(W.device, "console", { slug: "zz-device", platformId: W.platform, deviceModelId: W.alpha, warrantyMonths: 12, attributes: { notes: t3("ملاحظة قبل الشراء", "A note before you buy", "تێبینی"), inTheBox: [t3("كابل", "Cable", "کێبڵ")], variantReleaseDates: { "SKU-var_zz_device_b": "2027-01-02" } } }),
    product(W.gen, "accessory", { platformId: W.platform }),
    product(W.pc, "accessory"),
    variant("var_zz_plat", W.plat),
    variant("var_zz_split_a", W.split, { title: t3("النسخة أ", "Edition A", "وەشانی A"), sort: 0 }),
    variant("var_zz_split_b", W.split, { title: t3("النسخة ب", "Edition B", "وەشانی B"), isDefault: false, sort: 1 }),
    variant("var_zz_vw", W.variantWins),
    variant("var_zz_game", W.game),
    variant("var_zz_device_a", W.device, { options: { model: "ZZ-001" } }),
    variant("var_zz_device_b", W.device, { isDefault: false, sort: 1 }),
    variant("var_zz_gen", W.gen),
    variant("var_zz_pc", W.pc),
    ...["var_zz_plat", "var_zz_split_a", "var_zz_split_b", "var_zz_vw", "var_zz_game", "var_zz_device_a", "var_zz_pc"].map((variantId) => db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 5 })),
    // var_zz_gen has no stock at all (out of stock)
    rule("cr_zz_1", "product", W.plat, "platform", W.platform, "verified"),
    rule("cr_zz_2", "product", W.plat, "device_model", W.beta, "incompatible", t3("لا يناسب Beta", "Does not fit Beta", "لەگەڵ Beta ناگونجێت")),
    rule("cr_zz_3", "variant", "var_zz_split_a", "device_model", W.alpha, "verified"),
    rule("cr_zz_4", "variant", "var_zz_split_b", "device_model", W.alpha, "incompatible"),
    rule("cr_zz_5", "product", W.variantWins, "device_model", W.alpha, "verified"),
    rule("cr_zz_6", "variant", "var_zz_vw", "device_model", W.alpha, "unverified"),
    rule("cr_zz_7", "product", W.gen, "generation", W.generation, "partial", t3("يحتاج تحديثاً", "Needs an update", "نوێکردنەوەی پێویستە")),
    rule("cr_zz_8", "product", W.pc, "device_model", W.offModel, "verified"),
    db.insert(media).values({ id: "med_zz_1", ownerType: "variant", ownerId: "var_zz_device_a", artKey: "zz-device--1", kind: "image", isIllustration: false }),
    db.insert(knowledgeArticles).values({ id: "ka_zz_1", slug: "zz-setup", kind: "setup", title: t3("إعداد Alpha", "Set up Alpha", "ڕێکخستنی Alpha"), body: { ar: [{ type: "p", text: "نص" }] }, deviceModelId: W.alpha, platformId: W.platform, audience: "public", status: "approved", updatedAt: now }),
    db.insert(knowledgeArticles).values({ id: "ka_zz_2", slug: "zz-internal", kind: "guide", title: t3("داخلي", "Internal", "ناوخۆیی"), body: { ar: [{ type: "p", text: "نص" }] }, deviceModelId: W.alpha, audience: "internal", status: "approved", updatedAt: now }),
    db.insert(knowledgeArticles).values({ id: "ka_zz_3", slug: "zz-draft-article", kind: "guide", title: t3("مسودة", "Draft", "ڕەشنووس"), body: { ar: [{ type: "p", text: "نص" }] }, deviceModelId: W.alpha, audience: "public", status: "review", updatedAt: now }),
    db.insert(knowledgeArticles).values({ id: "ka_zz_4", slug: "zz-platform-guide", kind: "troubleshooting", title: t3("كل الأجهزة", "Every device", "هەموو ئامێرەکان"), body: { ar: [{ type: "p", text: "نص" }] }, platformId: W.platform, audience: "public", status: "approved", updatedAt: now }),
    db.insert(knowledgeArticles).values({ id: "ka_zz_5", slug: "zz-beta-guide", kind: "guide", title: t3("دليل Beta", "Beta guide", "ڕێنمایی Beta"), body: { ar: [{ type: "p", text: "نص" }] }, deviceModelId: W.beta, platformId: W.platform, audience: "public", status: "approved", updatedAt: now }),
  ];
  await runBatch(db, statements);
}

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
  await buildWorld(t.now);
});

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── pure resolution

describe("compatibility resolution (pure)", () => {
  const model = { id: "m1", generationId: "g1", platformId: "p1" };
  const base = { productId: "prd", note: null };
  const variantsOf = (...ids: string[]): VariantLite[] => ids.map((id, index) => ({ id, productId: "prd", title: { ar: id }, isDefault: index === 0, sort: index }));

  it("prefers the model over the generation over the platform, and a variant over its product at the same level", () => {
    const rules: RuleLite[] = [
      { ...base, subjectType: "product", subjectId: "prd", targetType: "platform", targetId: "p1", status: "verified" },
      { ...base, subjectType: "product", subjectId: "prd", targetType: "generation", targetId: "g1", status: "partial" },
      { ...base, subjectType: "variant", subjectId: "v1", targetType: "platform", targetId: "p1", status: "unverified" },
    ];
    expect(decidingRule(rules, "prd", "v1", model)?.status).toBe("partial"); // generation (product) beats platform (variant)
    rules.push({ ...base, subjectType: "product", subjectId: "prd", targetType: "device_model", targetId: "m1", status: "incompatible" });
    rules.push({ ...base, subjectType: "variant", subjectId: "v1", targetType: "device_model", targetId: "m1", status: "verified" });
    expect(decidingRule(rules, "prd", "v1", model)?.status).toBe("verified"); // variant beats product at model level
    expect(decidingRule(rules, "prd", "v2", model)?.status).toBe("incompatible");
    expect(decidingRule(rules, "prd", "v1", { id: "m2", generationId: "g9", platformId: "p9" })).toBeNull();
  });

  it("never rounds up: disagreeing versions are partial (one works) or unverified (none works), and say which", () => {
    const rules: RuleLite[] = [
      { ...base, subjectType: "variant", subjectId: "v1", targetType: "device_model", targetId: "m1", status: "verified" },
      { ...base, subjectType: "variant", subjectId: "v2", targetType: "device_model", targetId: "m1", status: "incompatible" },
    ];
    const mixed = resolveForModel("prd", variantsOf("v1", "v2"), rules, model);
    expect(mixed.status).toBe("partial");
    expect(mixed.split?.works.map((v) => v.id)).toEqual(["v1"]);
    const none = resolveForModel("prd", variantsOf("v2", "v3"), rules, model);
    expect(none.status).toBe("unverified");
    expect(none.split?.fails.map((v) => v.id)).toEqual(["v2", "v3"]);
    expect(resolveForModel("prd", variantsOf("v1"), rules, model).status).toBe("verified");
    expect(resolveForModel("prd", variantsOf("v9"), rules, model)).toEqual({ status: "unverified", note: null, level: null, split: null });
  });
});

// ───────────────────────────────────────────────────────────────── getCompatibilityForProduct

describe("getCompatibilityForProduct", { timeout: 120_000 }, () => {
  it("answers exactly as the rules say, with levels and notes in each language", async () => {
    const list = await getCompatibilityForProduct(t.db, "en", W.plat);
    const bySlug = new Map(list.map((row) => [row.deviceSlug, row]));
    expect(bySlug.get("zz-alpha")).toMatchObject({ status: "verified", level: "platform", hasHub: true, platformSlug: "zz-dev" });
    expect(bySlug.get("zz-beta")).toMatchObject({ status: "incompatible", level: "device_model", note: "Does not fit Beta" });
    // gamma is a handheld PC of the same platform: the platform rule covers it too
    expect(bySlug.get("zz-gamma")).toMatchObject({ status: "verified", level: "platform" });
    expect(bySlug.has("zz-draft")).toBe(false); // drafts are not devices yet
    const ar = await getCompatibilityForProduct(t.db, "ar", W.plat);
    expect(ar.find((row) => row.deviceSlug === "zz-beta")?.note).toBe("لا يناسب Beta");
  });

  it("a variant rule beats its product's rule; versions that disagree are partial and name the one that works", async () => {
    const wins = await getCompatibilityForProduct(t.db, "en", W.variantWins);
    expect(wins.find((row) => row.deviceSlug === "zz-alpha")?.status).toBe("unverified");
    const split = await getCompatibilityForProduct(t.db, "en", W.split);
    const alpha = split.find((row) => row.deviceSlug === "zz-alpha");
    expect(alpha?.status).toBe("partial");
    expect(alpha?.note).toContain("Edition A");
    expect(alpha?.note).not.toContain("Edition B");
  });

  it("lists the platform's other devices as explicitly unverified — never a device itself, never an inactive platform", async () => {
    const split = await getCompatibilityForProduct(t.db, "en", W.split);
    expect(split.find((row) => row.deviceSlug === "zz-beta")).toMatchObject({ status: "unverified", level: null, note: null });
    const game = await getCompatibilityForProduct(t.db, "en", W.game);
    expect(game.map((row) => row.deviceSlug).sort()).toEqual(["zz-alpha", "zz-beta", "zz-gamma"]);
    expect(game.every((row) => row.status === "unverified" && row.level === null)).toBe(true);
    const device = await getCompatibilityForProduct(t.db, "en", W.device);
    expect(device).toEqual([]); // the console IS alpha; no filler rows for a device
    const off = await getCompatibilityForProduct(t.db, "en", W.pc);
    expect(off).toEqual([expect.objectContaining({ deviceSlug: "zz-off-model", status: "verified", hasHub: false })]);
  });

  it("unknown products give an empty list; malformed ids are invalid", async () => {
    expect(await getCompatibilityForProduct(t.db, "ar", "prd_does_not_exist")).toEqual([]);
    await expect(getCompatibilityForProduct(t.db, "ar", "bad id; DROP")).rejects.toSatisfy((error) => isAppError(error, "invalid"));
  });

  it("matches the researched rules of the demo catalogue one for one (status and note), never better", async () => {
    const researched = await rows<{ product_id: string; slug: string; status: CompatibilityStatus; note: string | null }>(
      `SELECT r.subject_id AS product_id, dm.slug, r.status, r.note FROM compatibility_rules r JOIN device_models dm ON dm.id = r.target_id
       JOIN products p ON p.id = r.subject_id
       WHERE r.subject_type = 'product' AND r.target_type = 'device_model' AND p.is_demo = 1 AND p.status = 'published' AND r.id NOT LIKE 'cr_zz_%'`,
    );
    expect(researched.length).toBeGreaterThan(300);
    const byProduct = new Map<string, typeof researched>();
    for (const row of researched) byProduct.set(row.product_id, [...(byProduct.get(row.product_id) ?? []), row]);
    let checked = 0;
    for (const [productId, expected] of byProduct) {
      const list = await getCompatibilityForProduct(t.db, "en", productId);
      for (const row of expected) {
        const got = list.find((entry) => entry.deviceSlug === row.slug);
        expect(got?.status, `${productId} on ${row.slug}`).toBe(row.status);
        expect(got?.note ?? null).toBe(pick(parse(row.note), "en") || null);
        checked++;
      }
    }
    expect(checked).toBe(researched.length);
    // every partial stays partial
    expect(researched.filter((row) => row.status === "partial").length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────── hubs

describe("getDeviceHub — which devices have a hub", { timeout: 120_000 }, () => {
  it("answers every published model of an active platform, and listDeviceHubs names exactly those", async () => {
    const expected = await rows<{ slug: string }>(
      "SELECT dm.slug FROM device_models dm JOIN platforms p ON p.id = dm.platform_id WHERE dm.status = 'published' AND p.is_active = 1 ORDER BY p.sort, dm.sort, dm.id",
    );
    expect(expected.length).toBeGreaterThanOrEqual(26);
    const listed = await listDeviceHubs(t.db, "ar");
    expect(listed.map((hub) => hub.slug)).toEqual(expected.map((row) => row.slug));
    for (const { slug } of expected) {
      const hub = await getDeviceHub(t.db, "ar", slug, { now: t.now });
      expect(hub, slug).not.toBeNull();
      expect(hub?.model.slug).toBe(slug);
    }
  });

  it("has no hub for inactive platforms (the generic Windows PC), drafts, unknown or malformed slugs", async () => {
    const inactive = await rows<{ slug: string }>("SELECT dm.slug FROM device_models dm JOIN platforms p ON p.id = dm.platform_id WHERE p.is_active = 0");
    expect(inactive.map((row) => row.slug)).toContain("zz-off-model");
    expect(inactive.length).toBeGreaterThanOrEqual(2); // the demo's windows-pc too
    for (const { slug } of inactive) expect(await getDeviceHub(t.db, "ar", slug)).toBeNull();
    expect(await getDeviceHub(t.db, "ar", "zz-draft")).toBeNull();
    expect(await getDeviceHub(t.db, "ar", "no-such-device")).toBeNull();
    expect(await getDeviceHub(t.db, "ar", "../etc")).toBeNull();
    expect(await getDeviceHub(t.db, "ar", "")).toBeNull();
  });
});

describe("getDeviceHub — the test world", () => {
  let hub: DeviceHub;
  beforeAll(async () => {
    const found = await getDeviceHub(t.db, "en", "zz-alpha", { now: t.now });
    if (!found) throw new Error("no hub for zz-alpha");
    hub = found;
  });

  it("puts each product in the group its rule decides, games listed by research included", () => {
    const accessories = statusesOf(hub, "accessories");
    expect(accessories.get(W.plat)).toBe("verified");
    expect(accessories.get(W.split)).toBe("partial");
    expect(accessories.get(W.variantWins)).toBe("unverified");
    expect(accessories.get(W.gen)).toBe("partial");
    expect(accessories.has(W.device)).toBe(false); // the device itself is an edition, not an accessory
    expect(accessories.has(W.pc)).toBe(false); // a rule for another device says nothing about this one
    expect(statusesOf(hub, "games").get(W.game)).toBe("unverified");
    const partial = hub.accessories.find((group) => group.status === "partial")?.items.find((item) => item.card.id === W.gen);
    expect(partial?.note).toBe("Needs an update");
    expect(hub.counts.accessories).toEqual({ verified: 1, partial: 2, unverified: 1, incompatible: 0 });
  });

  it("lists the editions, versions with model numbers and later release dates, notes, the box and the store warranty", () => {
    expect(hub.editions.map((card) => card.id)).toEqual([W.device]);
    expect(hub.versions.map((version) => [version.variantId, version.modelNumber, version.releaseDate])).toEqual([
      ["var_zz_device_a", "ZZ-001", null],
      ["var_zz_device_b", null, "2027-01-02"],
    ]);
    expect(hub.notes.map((note) => note.text)).toEqual(["A note before you buy"]);
    expect(hub.inTheBox).toEqual(["Cable"]);
    expect(hub.warrantyMonths).toEqual([12]);
  });

  it("groups the researched specs and builds the comparison and the FAQ from them only", () => {
    expect(hub.specs.map((group) => group.id)).toEqual(["storage", "battery", "design"]);
    expect(hub.specs.flatMap((group) => group.rows.map((row) => `${row.label}=${row.value}`))).toEqual(["Storage=512GB", "Expansion=microSD card", "Battery=6 hours", "Weight=600 g"]);
    // siblings: same platform and category; beta (no category: it has no product) cannot be placed, gamma has no specs
    expect(hub.comparison).toBeNull();
    const faqIds = hub.faq.map((entry) => entry.id);
    expect(faqIds).toEqual(["storage", "battery", "box"]);
    expect(hub.faq[0].answer).toEqual(["512GB", "microSD card"]);
  });

  it("shows approved public guides of the model, of its platform and of its generation's siblings — nothing else", () => {
    expect(hub.articles.map((article) => [article.slug, article.scope, article.writtenFor])).toEqual([
      ["zz-setup", "device", null],
      ["zz-platform-guide", "platform", null],
      ["zz-beta-guide", "sibling", "Beta"],
    ]);
  });
});

describe("getDeviceHub — the demo catalogue", { timeout: 180_000 }, () => {
  it("never shows a product better than its rule on any hub, and lists every researched game of the model", async () => {
    const hubs = await rows<{ id: string; slug: string }>("SELECT dm.id, dm.slug FROM device_models dm JOIN platforms p ON p.id = dm.platform_id WHERE dm.status = 'published' AND p.is_active = 1 AND p.slug <> 'zz-dev'");
    for (const { id, slug } of hubs) {
      const hub = await getDeviceHub(t.db, "ar", slug, { now: t.now });
      if (!hub) throw new Error(`no hub for ${slug}`);
      const rules = await rows<{ product_id: string; status: CompatibilityStatus; kind: string }>(
        `SELECT r.subject_id AS product_id, r.status, p.kind FROM compatibility_rules r JOIN products p ON p.id = r.subject_id
         WHERE r.subject_type = 'product' AND r.target_type = 'device_model' AND r.target_id = ? AND p.status = 'published' AND p.kind NOT IN ('console')`,
        id,
      );
      const shown = new Map([...statusesOf(hub, "games"), ...statusesOf(hub, "accessories")]);
      const own = new Set(hub.editions.map((card) => card.id));
      for (const rule of rules) {
        if (own.has(rule.product_id) || rule.kind === "part") continue;
        expect(shown.get(rule.product_id), `${slug}: ${rule.product_id}`).toBe(rule.status);
      }
      const listedGames = await rows<{ id: string }>(
        "SELECT p.id FROM products p WHERE p.status = 'published' AND p.kind = 'game' AND EXISTS (SELECT 1 FROM json_each(p.attributes, '$.game.platforms') g WHERE g.value = ?)",
        slug,
      );
      for (const game of listedGames) expect(shown.has(game.id), `${slug} lists ${game.id}`).toBe(true);
      // games with a disc that does not fit stay "incompatible" even though the game exists for the model
      for (const group of hub.games) for (const item of group.items) expect(item.card.kind).toBe("game");
    }
  });

  it("gives a model that is one version of a shared product only its own version", async () => {
    // a variant belongs to the model whose photo is the variant's first picture (the 2020 PS5 disc / digital pair)
    const pairs = await rows<{ slug: string; model_id: string; variant_id: string; product_id: string; product_model: string | null }>(
      `SELECT dm.slug, dm.id AS model_id, v.id AS variant_id, v.product_id, p.device_model_id AS product_model FROM device_models dm
       JOIN media m ON m.owner_type = 'variant' AND m.art_key = dm.art_key AND m.sort = 0
       JOIN variants v ON v.id = m.owner_id
       JOIN products p ON p.id = v.product_id
       WHERE dm.status = 'published' AND p.status = 'published' AND v.is_active = 1`,
    );
    const shared = pairs.filter((pair) => pair.product_model !== null && pair.product_model !== pair.model_id);
    expect(shared.length).toBeGreaterThan(0); // the demo catalogue has the 2020 PS5 Digital Edition
    for (const pair of pairs) {
      const hub = await getDeviceHub(t.db, "en", pair.slug, { now: t.now });
      const versions = hub?.versions.map((version) => version.variantId) ?? [];
      expect(versions, pair.slug).toContain(pair.variant_id);
      expect(hub?.editions.map((card) => card.id)).toContain(pair.product_id);
      // the variants of the same product that are OTHER models never appear on this one
      for (const other of pairs) if (other.product_id === pair.product_id && other.model_id !== pair.model_id) expect(versions, pair.slug).not.toContain(other.variant_id);
      if (shared.includes(pair)) expect(versions, pair.slug).toEqual([pair.variant_id]);
    }
  });

  it("lists exactly the listed used units of each model", async () => {
    const units = await rows<{ id: string; slug: string }>(
      `SELECT u.id, dm.slug FROM used_units u JOIN variants v ON v.id = u.variant_id JOIN products p ON p.id = v.product_id
       JOIN device_models dm ON dm.id = p.device_model_id WHERE u.status = 'listed'`,
    );
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      const hub = await getDeviceHub(t.db, "ar", unit.slug, { now: t.now });
      expect(hub?.used.map((card) => card.id), unit.slug).toContain(unit.id);
    }
    const none = await getDeviceHub(t.db, "ar", "zz-alpha");
    expect(none?.used).toEqual([]);
  });

  it("speaks every language, takes spec labels from the research, and leaves out what it does not know", async () => {
    const [model] = await rows<{ slug: string; specs: string }>("SELECT slug, specs FROM device_models WHERE status = 'published' AND specs IS NOT NULL AND slug NOT LIKE 'zz-%' ORDER BY sort LIMIT 1");
    const specs = JSON.parse(model.specs) as Record<string, L10n & { label: L10n }>;
    const [firstKey] = Object.keys(specs);
    for (const locale of ["ar", "en", "ckb"] as const) {
      const hub = await getDeviceHub(t.db, locale, model.slug, { now: t.now });
      const row = hub?.specs.flatMap((group) => group.rows).find((entry) => entry.key === firstKey);
      expect(row?.label).toBe(pick(specs[firstKey].label, locale));
      expect(row?.value).toBe(pick(specs[firstKey], locale));
      expect(hub?.model.name.length).toBeGreaterThan(0);
    }
    // the comparison: the current model first, then siblings of the same platform; a value nobody gave is null
    const withSiblings = await getDeviceHub(t.db, "en", model.slug, { now: t.now });
    const comparison = withSiblings?.comparison;
    if (comparison) {
      expect(comparison.columns[0]).toMatchObject({ slug: model.slug, current: true });
      for (const row of comparison.rows) expect(row.cells).toHaveLength(comparison.columns.length);
    }
  });

  it("states the store's warranty only when the store set one (the demo catalogue sets none)", async () => {
    const [{ n }] = await rows<{ n: number }>("SELECT COUNT(*) AS n FROM products WHERE warranty_months IS NOT NULL AND id NOT LIKE 'prd_zz_%'");
    expect(n).toBe(0);
    const hub = await getDeviceHub(t.db, "ar", (await listDeviceHubs(t.db, "ar"))[0].slug);
    expect(hub?.warrantyMonths).toEqual([]);
  });

  it("prices the head «من …» at the cheapest version OF THIS DEVICE that can be ordered now, as the product read layer says", async () => {
    // expected, independently: every edition read in full (getProductDetail), only the hub's own versions, only
    // versions the cart accepts now — the hub's shortcut (a one-version edition is its card) must agree with it
    let shared = 0;
    for (const { slug } of await listDeviceHubs(t.db, "ar")) {
      const hub = await getDeviceHub(t.db, "ar", slug, { now: t.now });
      if (!hub) throw new Error(`no hub for ${slug}`);
      const own = new Set(hub.versions.map((version) => version.variantId));
      const details = await Promise.all(hub.editions.map((card) => getProductDetail(t.db, "ar", card.slug, { now: t.now, related: false })));
      const variants = details.flatMap((detail) => detail?.variants ?? []);
      const prices = variants.filter((variant) => own.has(variant.id) && variant.orderable).map((variant) => variant.priceIqd);
      const from = await fromPriceOf(t.db, "ar", hub, t.now);
      expect(from, slug).toBe(prices.length > 0 ? Math.min(...prices) : null);
      if (from !== null) expect(Number.isSafeInteger(from), slug).toBe(true);
      // the service says the same itself (DeviceHub.fromIqd), without the page reading every edition again
      expect(hub.fromIqd, slug).toBe(prices.length > 0 ? Math.min(...prices) : null);
      // a product that covers two models (the 2020 PS5 and its Digital Edition): the other model's version never counts
      if (variants.some((variant) => !own.has(variant.id))) shared++;
    }
    expect(shared).toBeGreaterThan(0);
  });
});

describe("the hub's head price — the test world", () => {
  it("counts only the versions that can be ordered now (a later release without stock does not)", async () => {
    const hub = await getDeviceHub(t.db, "en", "zz-alpha", { now: t.now });
    if (!hub) throw new Error("no hub for zz-alpha");
    // var_zz_device_a: 100,000 IQD, 5 in stock · var_zz_device_b: comes out later, no stock
    expect(await fromPriceOf(t.db, "en", hub, t.now)).toBe(100_000);
    expect(hub.fromIqd).toBe(100_000);
    expect(hubSections(hub)).toEqual(["versions", "specs", "accessories", "games", "help", "faq"]);
  });
});

describe("devices service — polish (data owner)", () => {
  it("isolates only the Latin parts of a name inside a FAQ question: «PlayStation 5 (الطراز الأصلي 2020)» reads name first", () => {
    const name = "PlayStation 5 (الطراز الأصلي 2020)";
    const isolated = isolateLatin(name);
    // the Latin name is one left-to-right isolate, the Arabic qualifier stays outside every isolate, nothing is lost
    expect(isolated.startsWith("⁦PlayStation 5⁩")).toBe(true);
    expect(isolated.replace(/⁦[^⁩]*⁩/g, "")).toContain("الطراز الأصلي");
    expect(isolated.replace(/[⁦⁩]/g, "")).toBe(name);
    expect(isolateLatin("Nintendo Switch 2")).toBe("⁦Nintendo Switch 2⁩");
    const faq = buildFaq({ deviceName: name, specs: { storage: { ar: "825GB", en: "825GB" } } as never, games: { verified: 0, partial: 0, unverified: 0, incompatible: 0 }, inTheBox: [] }, "ar");
    expect(faq[0].question).toContain("⁦PlayStation 5⁩ (الطراز الأصلي");
    // never one isolate around the whole name (it made the Arabic qualifier lead)
    expect(faq[0].question).not.toContain(`⁨${name}⁩`);
  });

  it("prices «من …» from the versions the cart accepts now (pure)", () => {
    const versions = [
      { id: "a", price_iqd: 500_000 },
      { id: "b", price_iqd: 450_000 },
      { id: "c", price_iqd: 400_000 },
    ];
    const available = new Map([
      ["a", { available: 2 }],
      ["b", { available: 1 }],
      ["c", { available: 0 }],
    ]);
    expect(cheapestAvailable(versions, available)).toBe(450_000);
    expect(cheapestAvailable(versions, new Map())).toBeNull();
    expect(cheapestAvailable([], available)).toBeNull();
  });
});

describe("pure helpers", () => {
  it("groups unknown spec keys under 'other', reads plain values, and skips empty ones", () => {
    const groups = groupSpecs({ cpu: { ar: "ثمانية", en: "Eight cores", label: { ar: "المعالج", en: "CPU" } }, mystery: "42", empty: { ar: "", en: "" }, flag: true }, "en");
    expect(groups).toEqual([
      { id: "performance", rows: [{ key: "cpu", label: "CPU", value: "Eight cores" }] },
      { id: "more", rows: [{ key: "mystery", label: "mystery", value: "42" }, { key: "flag", label: "flag", value: "Yes" }] },
    ]);
    expect(artSlug("playstation-5--2")).toBe("playstation-5");
    expect(artSlug("no-number")).toBeNull();
  });

  it("compares on fixed rows, keeps nulls for missing facts and drops rows nobody has", () => {
    const comparison = buildComparison(
      { slug: "a", name: "A", specs: { storage: { ar: "1", en: "1TB" }, disc: { ar: "نعم", en: "Ultra HD Blu-ray" } }, releasedOn: "2024-01-01", artKey: null, sort: 1 },
      [{ slug: "b", name: "B", specs: { storage: { ar: "2", en: "2TB" } }, releasedOn: null, artKey: null, sort: 2 }],
      "en",
    );
    expect(comparison?.rows).toEqual([
      { id: "released", cells: [["2024-01-01"], null] },
      { id: "storage", cells: [["1TB"], ["2TB"]] },
      { id: "discs", cells: [["Ultra HD Blu-ray"], null] },
    ]);
    expect(buildComparison({ slug: "a", name: "A", specs: {}, releasedOn: null, artKey: null, sort: 1 }, [], "en")).toBeNull();
  });

  it("finds the «من …» price among buyable versions of this device only, never a guess", () => {
    const card = (slug: string, variantId: string, priceIqd: number, stock: StockState, hasVariants = false) => ({ slug, variantId, priceIqd, stock, hasVariants });
    const offers = new Map([["pair", [{ variantId: "disc", priceIqd: 620_000, orderable: true }, { variantId: "digital", priceIqd: 549_000, orderable: true }]]]);
    // the shared product: on the disc model's hub the Digital Edition's lower price does not count
    expect(cheapestOrderable([card("pair", "disc", 620_000, "in_stock", true)], offers, new Set(["disc"]))).toBe(620_000);
    expect(cheapestOrderable([card("pair", "disc", 620_000, "in_stock", true)], offers, new Set(["digital"]))).toBe(549_000);
    // a one-version edition is its card: sold out and coming soon are not "from" prices
    expect(cheapestOrderable([card("a", "a1", 300_000, "out_of_stock"), card("b", "b1", 400_000, "low_stock")], new Map(), new Set(["a1", "b1"]))).toBe(400_000);
    expect(cheapestOrderable([card("a", "a1", 300_000, "preorder")], new Map(), new Set(["a1"]))).toBeNull();
    // an edition with several versions whose versions were not read does not count; a broken amount never shows
    expect(cheapestOrderable([card("c", "c1", 100_000, "in_stock", true)], new Map(), new Set(["c1"]))).toBeNull();
    expect(cheapestOrderable([card("d", "d1", 0, "in_stock"), card("e", "e1", 12.5, "in_stock")], new Map(), new Set(["d1", "e1"]))).toBeNull();
  });

  it("keeps a short last word with the name and offers only the sections a hub draws", () => {
    expect(keepTogether("Nintendo Switch 2")).toBe("Nintendo Switch\u00a02");
    expect(keepTogether("ROG Xbox Ally X")).toBe("ROG Xbox Ally\u00a0X");
    expect(keepTogether("PlayStation 5 Slim")).toBe("PlayStation 5 Slim");
    expect(keepTogether("Steam Deck OLED")).toBe("Steam Deck OLED");
    const bare = { editions: [], versions: [], notes: [], comparison: null, specs: [], accessories: [{ status: "verified" as const, items: [] }], games: [], faq: [], used: [] };
    expect(hubSections(bare)).toEqual(["help"]); // an empty group is no section
  });

  it("lists as accessories only what is compatible — verified, or with a condition (v2 §6.6: «verified only»)", () => {
    const item = (status: CompatibilityStatus) => ({ card: {} as ProductCardData, status, note: null });
    const base = { editions: [], versions: [], notes: [], comparison: null, specs: [], games: [], faq: [], used: [] };
    // the PlayStation VR2 hub records one accessory that does NOT work with it: that is no accessories section
    expect(hubSections({ ...base, accessories: [{ status: "incompatible", items: [item("incompatible")] }, { status: "unverified", items: [item("unverified")] }] })).toEqual(["help"]);
    expect(hubSections({ ...base, accessories: [{ status: "partial", items: [item("partial")] }] })).toEqual(["accessories", "help"]);
    // games keep every recorded state: a disc that does not fit a digital console is worth knowing before buying
    expect(hubSections({ ...base, accessories: [], games: [{ status: "incompatible", items: [item("incompatible")] }] })).toEqual(["games", "help"]);
  });

  it("isolates only the Latin runs of a device name inside Arabic text, so a qualifier keeps the sentence's order", () => {
    // one isolate around the whole name made «PlayStation 5 (الطراز الأصلي 2020)» read qualifier-first in Arabic
    expect(deviceIn("PlayStation 5 (الطراز الأصلي 2020)")).toBe("⁦PlayStation 5⁩ (الطراز الأصلي ⁦2020⁩)");
    expect(deviceIn("Nintendo Switch 2")).toBe("⁦Nintendo Switch 2⁩");
    expect(deviceIn("PlayStation 5 (original 2020 model)")).toBe("⁦PlayStation 5 (original 2020 model)⁩");
  });

  it("gives the head's facts in the spec's order, the release as its year alone on a phone (the row is one line)", () => {
    // the devices strings themselves, as the page renders them (Arabic plurals included)
    const t = makeT(devicesMessages.ar as unknown as MessageTree, "ar", "devices");
    const n = (value: number) => String(value);
    const day = { kind: "day" as const, text: "5 حزيران 2025", year: "2025" };
    const facts = headFacts({ released: day, generation: "PlayStation 5", games: 16, accessories: 12 }, t, n);
    expect(facts.map((fact) => fact.icon)).toEqual(["calendar-blank", "stack", "game-controller", "plug"]);
    expect(facts[0]).toEqual({ icon: "calendar-blank", text: "صدر في 5 حزيران 2025", phone: "صدر عام 2025" });
    expect(facts[1].text).toBe("من \u2066PlayStation 5\u2069");
    expect(facts.slice(1).every((fact) => fact.phone === undefined)).toBe(true);
    // a year is already short; nothing unknown or zero is said
    expect(headFacts({ released: { kind: "year", text: "2017", year: "2017" }, generation: null, games: 0, accessories: 0 }, t, n)).toEqual([{ icon: "calendar-blank", text: "صدر عام 2017" }]);
    expect(headFacts({ released: null, generation: null, games: 1, accessories: 0 }, t, n).map((fact) => fact.icon)).toEqual(["game-controller"]);
  });

  it("says in the head when nothing of THIS device can be ordered — even when its shared product's card is in stock", () => {
    // the 2020 PS5 Digital Edition is a version of the "playstation-5" product: the disc version in stock keeps the card
    // «متوفر», but no version of the digital model can be ordered → «نفد حالياً», never an empty line
    expect(headPrice({ amount: null }, [{ stock: "in_stock" }])).toEqual({ kind: "out" });
    expect(headPrice({ amount: null }, [{ stock: "out_of_stock" }, { stock: "preorder" }])).toEqual({ kind: "soon" });
    expect(headPrice({ amount: 549_000 }, [{ stock: "in_stock" }])).toEqual({ kind: "from", amount: 549_000 });
    // a failed read says nothing at all — never a guess, never a false «نفد»
    expect(headPrice({ failed: true }, [{ stock: "out_of_stock" }])).toEqual({ kind: "unknown" });
  });

  it("chooses no section chip while the head is on screen, and the last one at the very end of the page", () => {
    const tops = [
      { id: "versions", top: 520 },
      { id: "compare", top: 1400 },
      { id: "faq", top: 2600 },
    ];
    // back at the top of the page: the reader is on the head, no chip stays chosen
    expect(currentSection(tops, 300, false)).toBeNull();
    expect(currentSection(tops.map((s) => ({ ...s, top: s.top - 400 })), 300, false)).toBe("versions");
    expect(currentSection(tops.map((s) => ({ ...s, top: s.top - 1200 })), 300, false)).toBe("compare");
    // a short last section never reaches the reading line: at the end of the page it is the one being read
    expect(currentSection(tops.map((s) => ({ ...s, top: s.top - 2000 })), 300, true)).toBe("faq");
    expect(currentSection([], 300, true)).toBeNull();
  });

  it("keeps a grid shown in full in the URL, so it works without JavaScript and survives Back and a reload", () => {
    expect(toggleGrid("", "accessories:verified")).toBe("?all=accessories%3Averified");
    expect(toggleGrid("?all=accessories%3Averified&all=versions", "accessories:verified")).toBe("?all=versions");
    expect(toggleGrid("?all=versions", "versions")).toBe("");
    expect(toggleGrid("?utm=x", "games:verified")).toBe("?utm=x&all=games%3Averified");
    expect([...expandedGrids("?all=versions&all=games%3Apartial")]).toEqual(["versions", "games:partial"]);
    // the route reloads nothing for a change of `all` alone
    expect(onlyGridsChanged(new URLSearchParams(""), new URLSearchParams("all=versions"))).toBe(true);
    expect(onlyGridsChanged(new URLSearchParams("all=versions"), new URLSearchParams("all=versions&q=1"))).toBe(false);
    expect(onlyGridsChanged(new URLSearchParams("q=1"), new URLSearchParams("q=1"))).toBe(false);
  });

  it("draws only shelves of three cards or more, so a shelf that would not show leaves no empty box", () => {
    const shelf = (key: string, n: number) => ({ key, title: key, reason: null, items: Array.from({ length: n }, (_, i) => ({ id: `${key}${i}` })) });
    expect(drawableShelves([shelf("a", 2), shelf("b", 3), shelf("c", 0)]).map((s) => s.key)).toEqual(["b"]);
    expect(drawableShelves([shelf("a", 1)])).toEqual([]);
  });
});

describe("the hub, QA fixes (wave C, 2026-11-13)", () => {
  const area = (path: string) => readFileSync(fileURLToPath(new URL(`../app/routes/storefront/devices/${path}`, import.meta.url)), "utf8");

  it("reads its facts, notes and descriptions at 16 / 1.75 on phones and tablets (v2.1 G7); labels and meta stay small", () => {
    // QA 2026-11-13: highlights, spec values, edition and version notes, the rule's notes and the sources were 14 / 1.5
    // (13 / 1.5) on a phone — 328 runs of 14px and 93 of 13px against 8 of 16px on /device/steam-deck-oled at 390
    const css = area("devices.css");
    const components = css.slice(0, css.indexOf("@layer utilities"));
    const phone = components.slice(components.lastIndexOf("@media (max-width: 63.99rem) {"));
    const reading = phone.slice(0, phone.indexOf("}"));
    for (const selector of [".devhub-read", ".devhub-hint", ".devhub-specs dd", ".devhub-table td", ".devhub-sources .link"]) expect(reading, selector).toContain(selector);
    expect(reading).toMatch(/font: var\(--type-read\);/);
    expect(phone).toMatch(/\.devhub-read-strong,\s*\.devhub-table__link \{\s*font: var\(--type-read\);\s*font-weight: 600;/);
    // desktop columns keep v2's sizes
    expect(components).toMatch(/\.devhub-read \{\s*font: var\(--type-sm\);/);
    expect(components).toMatch(/\.devhub-hint \{\s*font: var\(--type-xs\);/);
    // the kit's compatibility note carries a type utility: its reading size lives in the utilities layer
    expect(css.slice(css.indexOf("@layer utilities"))).toMatch(/\.devhub-note \[data-compat\] > span \+ span \{\s*font: var\(--type-read\);/);
    // the reading runs use the reading classes, not v2's small type utilities
    const versions = area("components/VersionsSection.tsx");
    expect(versions).not.toMatch(/className="[^"]*\btype-sm\b[^"]*"/);
    expect(versions.match(/devhub-read text-ink-2/g)).toHaveLength(2);
    expect(versions).toContain('className="flex items-start gap-2 devhub-read text-ink"');
    const help = area("components/HelpSection.tsx");
    expect(help).not.toMatch(/\btype-sm\b/);
    expect(help).toContain('className="devhub-hint text-ink-2"');
    expect(area("components/SpecSection.tsx")).toContain('<p className="devhub-read text-ink-2">');
    expect(area("components/CompatSection.tsx")).not.toMatch(/\btype-sm text-ink-2\b|\btype-sm font-normal\b/);
    expect(area("components/UsedSection.tsx")).not.toMatch(/\btype-sm\b/);
    expect(area("components/CardGrid.tsx").match(/className="devhub-note /g)).toHaveLength(2);
  });

  it("names the language and direction of a source from its letters, and draws «publisher — title» as one run in the title's", () => {
    // QA 2026-11-13: «IGN Middle East — شركة Valve تعلن…» on /en and /ckb hubs had no lang, so it was read with the page's
    // voice and its direction was left to chance
    expect(sourceLang("شركة Valve تعلن عن رفع سعر جهاز Steam Deck")).toEqual({ lang: "ar", dir: "rtl" });
    expect(sourceLang("هەموو شتێک دەربارەی Steam Deck")).toEqual({ lang: "ckb", dir: "rtl" });
    expect(sourceLang("機能・仕様 | Nintendo Switch 2")).toEqual({ lang: "ja" });
    expect(sourceLang("PlayStation Portal 플레이어 - 미드나이트 블랙")).toEqual({ lang: "ko" });
    expect(sourceLang("Steam Deck :: Tech Specs (OLED)")).toEqual({ lang: "en", dir: "ltr" });
    expect(sourceLang("2026")).toBeNull();
    expect(sourceLang(null)).toBeNull();
    const html = renderToStaticMarkup(createElement(SourceText, { text: "شركة Valve تعلن عن رفع سعر جهاز Steam Deck", lead: "IGN Middle East" }));
    expect(html).toBe('<bdi lang="ar" dir="rtl"><bdi lang="en" dir="ltr">IGN Middle East</bdi> — شركة Valve تعلن عن رفع سعر جهاز Steam Deck</bdi>');
    expect(renderToStaticMarkup(createElement(SourceText, { text: "Steam Deck :: Tech Specs (OLED)" }))).toBe('<bdi lang="en" dir="ltr">Steam Deck :: Tech Specs (OLED)</bdi>');
    expect(area("components/SpecSection.tsx")).toContain("<SourceText text={source.title ?? source.publisher ?? hostOf(source.url)} lead={source.title ? source.publisher : null} />");
  });
});
