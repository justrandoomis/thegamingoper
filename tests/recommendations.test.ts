/**
 * Recommendations and their signals (services/recommendations.server.ts) against a real local D1.
 *
 *   · a TEST WORLD on its own platform ("zz-rec") where every answer is written down: which products are verified,
 *     partial, incompatible or unknown on the device, which are in stock, which links the store made, which orders
 *     exist — so the hard compatibility filter, stock suppression, editorial order, diversity, admin pins / excludes /
 *     boosts, "bought together" thresholds, personal shelves and the cold start are checked exactly;
 *   · the DEMO catalogue for properties that must hold everywhere: on every device hub and every console's product
 *     page, nothing recommended as fitting is anything but VERIFIED on that device, nothing out of stock, no repeats.
 *   · signals: nothing without consent, guests keyed by a hashed first-party session only, de-duplication,
 *     forgetting, retention.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductCardData, Shelf } from "~/lib/dto";
import { sha256Hex } from "~/lib/ids";
import type { L10n } from "~/lib/locales";
import { compatibilityRules, consents, deviceModels, platforms, productRelations, products, recommendationEvents, recommendationRules, stockLevels, variants } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { isAppError } from "~/server/errors";
import { getCompatibilityForProduct } from "~/server/services/compatibility.server";
import {
  forgetEvents,
  getRecommendations,
  MIN_CO_PURCHASE_ORDERS,
  personalizationFor,
  purgeRecommendationEvents,
  recordEvent,
  RECOMMENDATION_EVENT_RETENTION_DAYS,
  takeTurns,
} from "~/server/services/recommendations.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
/** One fixture set for the file: its counter keeps phone numbers and references unique. */
let make: Fixtures;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const t3 = (ar: string, en: string, ckb: string): L10n => ({ ar, en, ckb });
const ids = (shelf: Shelf<ProductCardData> | undefined) => (shelf?.items ?? []).map((card) => card.id);
const allIds = (shelves: Shelf<ProductCardData>[]) => shelves.flatMap((shelf) => ids(shelf));

// ───────────────────────────────────────────────────────────────── the test world

const R = "dvm_zzrec"; // the device
const R2 = "dvm_zzrec2"; // another device of the platform
const P = {
  device: "prd_zr_device", // IS R, in stock
  other: "prd_zr_other", // IS R2 (an alternative)
  a1: "prd_zr_a1", // controller, verified, in stock
  a2: "prd_zr_a2", // headset, verified, in stock
  a3: "prd_zr_a3", // controller, verified, OUT of stock
  a4: "prd_zr_a4", // storage, partial
  a5: "prd_zr_a5", // accessory, incompatible
  a6: "prd_zr_a6", // accessory, no rule at all
  a7: "prd_zr_a7", // storage, verified, linked by the store as "setup"
  g1: "prd_zr_g1", // game, verified
  g2: "prd_zr_g2", // game, incompatible
  x: "prd_zr_x", // accessory, verified — bought together with y
  y: "prd_zr_y", // headset, verified
} as const;
const SKU = (productId: string) => `SKU-${productId}`;
const VAR = (productId: string) => productId.replace(/^prd_/, "var_");

async function buildWorld(now: number) {
  const db = t.db;
  const statements: BatchStatement[] = [
    db.insert(platforms).values({ id: "plt_zzrec", slug: "zz-rec", name: t3("منصة التوصيات", "Rec platform", "پلاتفۆرمی پێشنیار"), accent: "nintendo", sort: 95, isActive: true }),
    db.insert(deviceModels).values({ id: R, platformId: "plt_zzrec", slug: "zz-rec-device", name: t3("Recbox", "Recbox", "Recbox"), status: "published", deviceKind: "console", sort: 1 }),
    db.insert(deviceModels).values({ id: R2, platformId: "plt_zzrec", slug: "zz-rec-device-2", name: t3("Recbox Two", "Recbox Two", "Recbox Two"), status: "published", deviceKind: "console", sort: 2 }),
  ];
  const kinds: Record<string, "console" | "controller" | "headset" | "storage" | "accessory" | "game"> = {
    [P.device]: "console",
    [P.other]: "console",
    [P.a1]: "controller",
    [P.a2]: "headset",
    [P.a3]: "controller",
    [P.a4]: "storage",
    [P.a5]: "accessory",
    [P.a6]: "accessory",
    [P.a7]: "storage",
    [P.g1]: "game",
    [P.g2]: "game",
    [P.x]: "accessory",
    [P.y]: "headset",
  };
  for (const [id, kind] of Object.entries(kinds)) {
    statements.push(
      db.insert(products).values({
        id,
        slug: id.replace(/^prd_/, "").replace(/_/g, "-"),
        kind,
        name: t3(`منتج ${id}`, `Product ${id}`, `بەرهەم ${id}`),
        status: "published",
        platformId: "plt_zzrec",
        deviceModelId: id === P.device ? R : id === P.other ? R2 : null,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(variants).values({ id: VAR(id), productId: id, sku: SKU(id), priceIqd: 50_000, isDefault: true }),
    );
    if (id !== P.a3) statements.push(db.insert(stockLevels).values({ variantId: VAR(id), locationId: DEFAULT_LOCATION_ID, onHand: 10 }));
  }
  const rule = (id: string, productId: string, status: "verified" | "partial" | "incompatible") =>
    db.insert(compatibilityRules).values({ id, subjectType: "product", subjectId: productId, targetType: "device_model", targetId: R, status, note: status === "partial" ? t3("بشرط", "With a condition", "بە مەرج") : null });
  statements.push(
    rule("cr_zr_1", P.a1, "verified"),
    rule("cr_zr_2", P.a2, "verified"),
    rule("cr_zr_3", P.a3, "verified"),
    rule("cr_zr_4", P.a4, "partial"),
    rule("cr_zr_5", P.a5, "incompatible"),
    rule("cr_zr_7", P.a7, "verified"),
    rule("cr_zr_8", P.g1, "verified"),
    rule("cr_zr_9", P.g2, "incompatible"),
    rule("cr_zr_10", P.x, "verified"),
    rule("cr_zr_11", P.y, "verified"),
  );
  const relation = (productId: string, relatedProductId: string, kind: "setup" | "accessory" | "upsell" | "alternative", sort: number) => db.insert(productRelations).values({ productId, relatedProductId, kind, sort });
  statements.push(
    relation(P.device, P.a7, "setup", 0),
    relation(P.device, P.a6, "setup", 1),
    relation(P.device, P.a1, "accessory", 2),
    relation(P.device, P.g1, "upsell", 3),
    relation(P.device, P.a5, "accessory", 4),
    relation(P.device, P.other, "alternative", 5),
    relation(P.a1, P.a2, "accessory", 0),
    relation(P.a1, P.a5, "accessory", 1),
  );
  await runBatch(db, statements);
}

async function setRules(list: { kind: "pin" | "exclude" | "boost"; productId: string; context?: Record<string, string>; weight?: number }[]) {
  await t.d1.prepare("DELETE FROM recommendation_rules WHERE id LIKE 'rr_zr_%'").run();
  if (list.length === 0) return;
  await runBatch(
    t.db,
    list.map((entry, index) => t.db.insert(recommendationRules).values({ id: `rr_zr_${index}`, kind: entry.kind, productId: entry.productId, context: entry.context ?? null, weight: entry.weight ?? 0 })),
  );
}

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, t.now);
  await seedDemo(t.db, t.now);
  await buildWorld(t.now);
});

afterAll(async () => {
  await t?.dispose();
});

const hub = (extra: Record<string, unknown> = {}) => getRecommendations(t.db, { locale: "en", context: "device_hub", deviceModelId: R, consent: false, now: t.now, ...extra }, 8);

// ───────────────────────────────────────────────────────────────── the device hub

describe("device hub — complete your setup", () => {
  beforeEach(() => setRules([]));

  it("recommends only VERIFIED add-ons that can be bought, the store's own links first, kinds taking turns", async () => {
    const shelves = await hub();
    expect(shelves).toHaveLength(1);
    expect(shelves[0].key).toBe("device_hub:setup:zz-rec-device");
    expect(ids(shelves[0])).toEqual([P.a7, P.a1, P.a2, P.x, P.y]); // store links first, then kinds take turns
    expect(shelves[0].title).toContain("Recbox");
    expect(shelves[0].reason).toContain("Recbox");
    // partial, incompatible, unknown, out of stock, games and the device itself are never here
    for (const id of [P.a3, P.a4, P.a5, P.a6, P.g1, P.g2, P.device]) expect(ids(shelves[0])).not.toContain(id);
  });

  it("honours admin pins, excludes and boosts — but a pin cannot break the compatibility rule", async () => {
    await setRules([{ kind: "pin", productId: P.a2, context: { placement: "device_hub" } }]);
    expect(ids((await hub())[0])).toEqual([P.a2, P.a7, P.a1, P.x, P.y]);
    await setRules([{ kind: "exclude", productId: P.a1, context: { deviceModelId: R } }]);
    expect(ids((await hub())[0])).toEqual([P.a7, P.a2, P.x, P.y]);
    await setRules([
      { kind: "pin", productId: P.a4 }, // partial
      { kind: "pin", productId: P.a5 }, // incompatible
      { kind: "pin", productId: P.a3 }, // out of stock
    ]);
    expect(ids((await hub())[0])).toEqual([P.a7, P.a1, P.a2, P.x, P.y]);
    await setRules([{ kind: "boost", productId: P.a2, weight: 500 }]);
    expect(ids((await hub())[0])[0]).toBe(P.a2);
    // a rule for another placement or device does not apply
    await setRules([{ kind: "exclude", productId: P.a7, context: { placement: "cart" } }, { kind: "exclude", productId: P.a1, context: { deviceModelId: R2 } }]);
    expect(ids((await hub())[0])).toEqual([P.a7, P.a1, P.a2, P.x, P.y]);
  });

  it("cold start: a device with nothing verified gets the newest consoles of its platform — alternatives, never add-ons", async () => {
    const shelves = await hub({ deviceModelId: R2 });
    expect(shelves.map((shelf) => shelf.key)).toEqual(["device_hub:new:zz-rec-device-2"]);
    expect(ids(shelves[0])).toEqual([P.device]); // not its own product, nothing that claims to fit it
    expect(shelves[0].title).toContain("Rec platform");
  });

  it("returns nothing for unknown or unpublished devices, and rejects malformed input", async () => {
    expect(await hub({ deviceModelId: "dvm_nope" })).toEqual([]);
    await expect(getRecommendations(t.db, { locale: "en", context: "device_hub", deviceModelId: "x y", consent: false }, 8)).rejects.toSatisfy((error) => isAppError(error, "invalid"));
    await expect(getRecommendations(t.db, { locale: "xx" as "en", context: "home", consent: false }, 8)).rejects.toSatisfy((error) => isAppError(error, "invalid"));
  });
});

// ───────────────────────────────────────────────────────────────── a product, a cart

describe("product and cart contexts", () => {
  beforeEach(() => setRules([]));

  it("a device's page: its setup, then the store's links that fit it, then alternatives — nothing twice", async () => {
    const shelves = await getRecommendations(t.db, { locale: "en", context: "product", productId: P.device, consent: false, now: t.now }, 8);
    const byKey = new Map(shelves.map((shelf) => [shelf.key.split(":")[1], shelf]));
    expect(ids(byKey.get("setup"))).toEqual([P.a7, P.a1, P.a2, P.x, P.y]);
    expect(ids(byKey.get("related"))).toEqual([P.g1]); // a6 has no rule, a5 does not fit, a7 / a1 are already shown
    expect(byKey.get("related")?.reason).toContain("Recbox"); // one device: the shelf may say they all work with it
    expect(ids(byKey.get("alternatives"))).toEqual([P.other]);
    expect(byKey.has("together")).toBe(false); // no orders
    const seen = allIds(shelves);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(P.device);
  });

  it("an accessory's page: only links that are verified on a device the accessory is verified on", async () => {
    const shelves = await getRecommendations(t.db, { locale: "en", context: "product", productId: P.a1, consent: false, now: t.now }, 8);
    const related = shelves.find((shelf) => shelf.key === "product:related");
    expect(ids(related)).toEqual([P.a2]); // a5 is incompatible with Recbox
  });

  it("'bought together' needs real orders past the threshold; demo and cancelled orders do not count", async () => {
    const lines = [
      { variantId: VAR(P.x), sku: SKU(P.x), unitPriceIqd: 50_000 },
      { variantId: VAR(P.y), sku: SKU(P.y), unitPriceIqd: 50_000 },
    ];
    const together = async () => (await getRecommendations(t.db, { locale: "en", context: "product", productId: P.x, consent: false, now: t.now }, 8)).find((shelf) => shelf.key === "product:together");
    for (let i = 0; i < MIN_CO_PURCHASE_ORDERS - 1; i++) await make.order(lines);
    await make.order(lines, { isDemo: true });
    await make.order(lines, { status: "cancelled", cancelledAt: t.now, cancelReason: "test" });
    expect(await together()).toBeUndefined();
    await make.order(lines);
    const shelf = await together();
    expect(ids(shelf)).toEqual([P.y]);
    expect(shelf?.reason).toContain(String(MIN_CO_PURCHASE_ORDERS));
  });

  it("a cart with the device: complete it, never what is already in the cart", async () => {
    const shelves = await getRecommendations(t.db, { locale: "en", context: "cart", cartVariantIds: [VAR(P.device), VAR(P.a7)], consent: false, now: t.now }, 8);
    const setup = shelves.find((shelf) => shelf.key === "cart:setup:zz-rec-device");
    expect(setup?.title).toContain("Recbox");
    expect(ids(setup)).toEqual([P.a1, P.a2, P.x, P.y]);
    expect(allIds(shelves)).not.toContain(P.a7);
    expect(allIds(shelves)).not.toContain(P.device);
  });
});

// ───────────────────────────────────────────────────────────────── home and search

describe("home and search", () => {
  beforeEach(() => setRules([]));

  it("cold start: the store's picks, which say they do not use browsing, and follow the chosen platforms", async () => {
    const shelves = await getRecommendations(t.db, { locale: "en", context: "home", consent: false, now: t.now }, 8);
    expect(shelves.map((shelf) => shelf.key)).toEqual(["home:picks"]);
    expect(shelves[0].reason).toBe("Picks for everyone, not based on your browsing");
    expect(shelves[0].items.every((card) => card.stock !== "out_of_stock")).toBe(true);
    const mine = await getRecommendations(t.db, { locale: "en", context: "search", platformSlugs: ["zz-rec"], consent: false, now: t.now }, 24);
    expect(mine[0].items.length).toBeGreaterThan(0);
    expect(mine[0].items.every((card) => card.platformSlug === "zz-rec")).toBe(true);
    expect(mine[0].reason).toContain("Rec platform");
  });

  it("a consenting shopper's own signals add a shelf of things that fit what they looked at — never without consent", async () => {
    const sessionHash = await sha256Hex("zz-session-personal-0000000000000000");
    await recordEvent(t.db, { consent: true, sessionHash, customerId: null }, { kind: "view", productId: P.device }, t.now);
    const withConsent = await getRecommendations(t.db, { locale: "en", context: "home", consent: true, sessionHash, now: t.now + 1000 }, 8);
    const personal = withConsent.find((shelf) => shelf.key === "home:personal");
    expect(personal).toBeDefined();
    expect(personal?.reason).toContain("with your permission");
    for (const id of ids(personal)) expect([P.a1, P.a2, P.a7, P.g1, P.x, P.y]).toContain(id);
    expect(ids(personal)).not.toContain(P.device);
    const without = await getRecommendations(t.db, { locale: "en", context: "home", consent: false, sessionHash, now: t.now + 1000 }, 8);
    expect(without.find((shelf) => shelf.key === "home:personal")).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────── the demo catalogue

describe("the demo catalogue", { timeout: 180_000 }, () => {
  beforeEach(() => setRules([]));
  const compatCache = new Map<string, Awaited<ReturnType<typeof getCompatibilityForProduct>>>();
  const compatOf = async (productId: string) => {
    let list = compatCache.get(productId);
    if (!list) compatCache.set(productId, (list = await getCompatibilityForProduct(t.db, "en", productId)));
    return list;
  };

  it("on every device hub: only verified add-ons, in stock or pre-order, never twice, never the device's own products", async () => {
    const models = await rows<{ id: string; slug: string }>("SELECT dm.id, dm.slug FROM device_models dm JOIN platforms p ON p.id = dm.platform_id WHERE dm.status = 'published' AND p.is_active = 1 AND p.slug NOT LIKE 'zz-%'");
    let shown = 0;
    for (const model of models) {
      const shelves = await getRecommendations(t.db, { locale: "ar", context: "device_hub", deviceModelId: model.id, consent: false, now: t.now }, 12);
      const own = new Set((await rows<{ id: string }>("SELECT id FROM products WHERE device_model_id = ?", model.id)).map((row) => row.id));
      const seen = allIds(shelves);
      expect(new Set(seen).size, model.slug).toBe(seen.length);
      for (const shelf of shelves) {
        for (const card of shelf.items) {
          expect(card.stock, `${model.slug}: ${card.slug}`).not.toBe("out_of_stock");
          expect(own.has(card.id), `${model.slug}: ${card.slug} is the device`).toBe(false);
          if (shelf.key.includes(":setup:")) {
            const compat = await compatOf(card.id);
            expect(compat.find((row) => row.deviceSlug === model.slug)?.status, `${model.slug}: ${card.slug}`).toBe("verified");
            shown++;
          } else {
            expect(card.kind, `${model.slug}: fallback shelves hold consoles only`).toBe("console");
          }
        }
      }
    }
    expect(shown).toBeGreaterThan(20);
  });

  it("on every console's page: what is said to fit is verified on that console", async () => {
    const consoles = await rows<{ id: string; slug: string; model_slug: string }>(
      "SELECT p.id, p.slug, dm.slug AS model_slug FROM products p JOIN device_models dm ON dm.id = p.device_model_id JOIN platforms pl ON pl.id = dm.platform_id WHERE p.status = 'published' AND p.kind = 'console' AND pl.is_active = 1 AND pl.slug NOT LIKE 'zz-%'",
    );
    expect(consoles.length).toBeGreaterThan(10);
    for (const product of consoles) {
      const shelves = await getRecommendations(t.db, { locale: "en", context: "product", productId: product.id, consent: false, now: t.now }, 8);
      const seen = allIds(shelves);
      expect(seen).not.toContain(product.id);
      expect(new Set(seen).size).toBe(seen.length);
      for (const shelf of shelves) {
        if (!shelf.key.endsWith(":setup:" + product.model_slug) && shelf.key !== "product:related") continue;
        for (const card of shelf.items) {
          if (card.kind === "console") continue; // the related shelf may name the console a game runs on (its own model)
          const compat = await compatOf(card.id);
          expect(compat.find((row) => row.deviceSlug === product.model_slug)?.status, `${product.slug} → ${card.slug}`).toBe("verified");
        }
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── signals

describe("signals", () => {
  it("records nothing without consent, and nothing without a subject", async () => {
    const before = (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM recommendation_events"))[0].n;
    expect(await recordEvent(t.db, { consent: false, sessionHash: await sha256Hex("a".repeat(40)), customerId: null }, { kind: "view", productId: P.a1 }, t.now)).toEqual({ recorded: false, reason: "no_consent" });
    expect(await recordEvent(t.db, { consent: true, sessionHash: null, customerId: null }, { kind: "view", productId: P.a1 }, t.now)).toEqual({ recorded: false, reason: "no_subject" });
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM recommendation_events"))[0].n).toBe(before);
  });

  it("keys a guest by the session hash only, stores a repeat once per window, refuses unknown products", async () => {
    const sessionHash = await sha256Hex("zz-session-signals-000000000000000000");
    const who = { consent: true, sessionHash, customerId: null };
    expect(await recordEvent(t.db, who, { kind: "click", productId: P.a2, source: "device_hub:setup:zz-rec-device" }, t.now)).toEqual({ recorded: true, reason: "recorded" });
    expect(await recordEvent(t.db, who, { kind: "click", productId: P.a2 }, t.now + 60_000)).toEqual({ recorded: false, reason: "duplicate" });
    expect((await recordEvent(t.db, who, { kind: "click", productId: P.a2 }, t.now + 31 * 60_000)).recorded).toBe(true);
    expect(await recordEvent(t.db, who, { kind: "view", productId: "prd_does_not_exist" }, t.now)).toEqual({ recorded: false, reason: "unknown_product" });
    const stored = await rows<{ session_hash: string | null; customer_id: string | null; source: string | null }>("SELECT session_hash, customer_id, source FROM recommendation_events WHERE session_hash = ? ORDER BY at", sessionHash);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual({ session_hash: sessionHash, customer_id: null, source: "device_hub:setup:zz-rec-device" });
    // the table has no column for an IP address or a user agent
    const columns = (await rows<{ name: string }>("PRAGMA table_info(recommendation_events)")).map((column) => column.name).sort();
    expect(columns).toEqual(["at", "customer_id", "id", "kind", "product_id", "session_hash", "source"]);
    await expect(recordEvent(t.db, who, { kind: "share" as "view", productId: P.a2 }, t.now)).rejects.toSatisfy((error) => isAppError(error, "invalid"));
  });

  it("keys a customer by id (never a session), forgets on request, and drops what is older than the retention", async () => {
    const customerId = await make.customer();
    expect((await recordEvent(t.db, { consent: true, sessionHash: await sha256Hex("ignored-for-customers-000000000000"), customerId }, { kind: "add", productId: P.a1 }, t.now)).recorded).toBe(true);
    expect(await rows("SELECT session_hash FROM recommendation_events WHERE customer_id = ?", customerId)).toEqual([{ session_hash: null }]);
    expect(await forgetEvents(t.db, { sessionHash: null, customerId })).toBe(1);
    expect(await rows("SELECT id FROM recommendation_events WHERE customer_id = ?", customerId)).toEqual([]);

    const sessionHash = await sha256Hex("zz-session-retention-0000000000000000");
    const old = t.now - (RECOMMENDATION_EVENT_RETENTION_DAYS + 1) * 86_400_000;
    await t.db.insert(recommendationEvents).values({ id: "rev_zz_old", sessionHash, kind: "view", productId: P.a1, at: old });
    await t.db.insert(recommendationEvents).values({ id: "rev_zz_new", sessionHash, kind: "view", productId: P.a2, at: t.now });
    expect(await purgeRecommendationEvents(t.db, t.now)).toBeGreaterThanOrEqual(1);
    expect((await rows<{ id: string }>("SELECT id FROM recommendation_events WHERE session_hash = ?", sessionHash)).map((row) => row.id)).toEqual(["rev_zz_new"]);
  });

  it("reads consent from the customer's latest answer, else the device's cookie; a session key only with consent", async () => {
    const token = "Z".repeat(43);
    const cookies = (values: Record<string, string>) => (name: string) => values[name] ?? null;
    expect(await personalizationFor(t.db, { cookie: cookies({ tt_consent: "1", tt_rs: token }), customerId: null })).toEqual({ consent: true, sessionHash: await sha256Hex(token), customerId: null });
    expect(await personalizationFor(t.db, { cookie: cookies({ tt_consent: "0", tt_rs: token }), customerId: null })).toEqual({ consent: false, sessionHash: null, customerId: null });
    expect(await personalizationFor(t.db, { cookie: cookies({ tt_consent: "1", tt_rs: "short" }), customerId: null })).toEqual({ consent: true, sessionHash: null, customerId: null });
    const customerId = await make.customer();
    await t.db.insert(consents).values({ id: "cns_zz_1", subjectType: "customer", subjectId: customerId, kind: "personalization", granted: false, at: t.now });
    expect((await personalizationFor(t.db, { cookie: cookies({ tt_consent: "1" }), customerId })).consent).toBe(false);
    await t.db.insert(consents).values({ id: "cns_zz_2", subjectType: "customer", subjectId: customerId, kind: "personalization", granted: true, at: t.now + 1 });
    expect(await personalizationFor(t.db, { cookie: cookies({ tt_rs: token }), customerId })).toEqual({ consent: true, sessionHash: null, customerId });
  });
});

describe("takeTurns", () => {
  it("visits groups in the order of their best item, one at a time", () => {
    expect(takeTurns(["c1", "c2", "h1", "s1", "c3", "h2"], (item) => item[0])).toEqual(["c1", "h1", "s1", "c2", "h2", "c3"]);
    expect(takeTurns([], () => "x")).toEqual([]);
  });
});
