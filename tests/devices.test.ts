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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompatibilityStatus } from "~/lib/dto";
import { pick, type L10n } from "~/lib/locales";
import { compatibilityRules, deviceGenerations, deviceModels, knowledgeArticles, media, platforms, products, stockLevels, variants } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { isAppError } from "~/server/errors";
import { decidingRule, getCompatibilityForProduct, resolveForModel, type RuleLite, type VariantLite } from "~/server/services/compatibility.server";
import { artSlug, buildComparison, getDeviceHub, groupSpecs, listDeviceHubs, type DeviceHub } from "~/server/services/devices.server";
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
});
