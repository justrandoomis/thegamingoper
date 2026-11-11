/**
 * Product area — getProductDetail (app/server/services/catalog/product.server.ts), getReviewSummary /
 * listVerifiedReviews (app/server/services/reviews.server.ts), and the pure helpers the page and the quick preview
 * build on (product-types.ts, routes/storefront/product/useVariant.ts and jsonld.ts) — against a real local D1.
 *
 * Two kinds of data, on purpose (as tests/catalog-cards.test.ts does):
 *   · the DEMO catalogue (seedDemo): every published product is read, and every expectation is derived from the
 *     database itself (SQL, getAvailability, the photo manifests) — never from a product slug — so the tests keep
 *     holding when the researched catalogue changes;
 *   · a TEST WORLD built here: products that must answer 404 (draft, review, archived, scheduled for later, no active
 *     variant), one that is scheduled and already live, uploaded pictures (public and private), a store warranty, and
 *     reviews of every status.
 *
 * Covered: what is found and what is not; variants, prices, genuine reductions, stock STATES identical to the commerce
 * core (and `orderable` exactly when it would accept the add); release dates of products and variants; warranty
 * (maker's vs store's); store sets; related shelves (published only, never itself, no duplicates); pictures and
 * credits; game facts; multi-platform products; localization; privacy (no quantity, cost, serial anywhere); reviews
 * (approved verified purchases only, never the author); the JSON-LD rules (no offers in demo mode, no invented rating).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getArt, isPhoto } from "~/art";
import { LOCALE_CODES, pick, type L10n, type Locale } from "~/lib/locales";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { customers, files, media, products, reviews, stockLevels, variants } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { getProductDetail, RELATED_PER_SHELF } from "~/server/services/catalog/product.server";
import {
  baghdadMidnight,
  galleryFor,
  gelOfPlatformName,
  selectorDimension,
  selectVariant,
  toProductPreview,
  variantLabels,
  type ProductDetail,
  type VariantDetail,
} from "~/server/services/catalog/product-types";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { getReviewSummary, listVerifiedReviews } from "~/server/services/reviews.server";
import { splitMixed } from "~/routes/storefront/product/components/MixedText";
import { jsonForScript, productJsonLd } from "~/routes/storefront/product/jsonld";
import { onlyVariantChanged, searchFor } from "~/routes/storefront/product/useVariant";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
const DAY = 86_400_000;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const parse = <T>(text: string | null | undefined): T | null => (text ? (JSON.parse(text) as T) : null);
const name3 = (ar: string, en: string, ckb: string): L10n => ({ ar, en, ckb });

/** Every published product slug of the demo catalogue that has an active variant. */
async function liveSlugs(): Promise<string[]> {
  const found = await rows<{ slug: string }>(
    "SELECT p.slug FROM products p WHERE p.status = 'published' AND p.slug NOT LIKE 'zz-%' AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) ORDER BY p.slug",
  );
  return found.map((row) => row.slug);
}

/** Every key anywhere in a JSON value (to prove that protected fields never appear). */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => keysOf(entry, out));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      out.add(key);
      keysOf(entry, out);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── the test world

const W = {
  draft: { id: "prd_zz_draft", v: "var_zz_draft" },
  review: { id: "prd_zz_review", v: "var_zz_review" },
  archived: { id: "prd_zz_archived", v: "var_zz_archived" },
  later: { id: "prd_zz_later", v: "var_zz_later" },
  liveScheduled: { id: "prd_zz_live_scheduled", v: "var_zz_live_scheduled" },
  noVariant: { id: "prd_zz_novariant", v: "var_zz_novariant" },
  uploads: { id: "prd_zz_uploads", v: "var_zz_uploads", v2: "var_zz_uploads_b" },
  reviewed: { id: "prd_zz_reviewed", v: "var_zz_reviewed" },
} as const;

async function buildTestWorld(now: number) {
  const db = t.db;
  const product = (key: keyof typeof W, status: "draft" | "review" | "published" | "scheduled" | "archived", extra: Partial<typeof products.$inferInsert> = {}) =>
    db.insert(products).values({
      id: W[key].id,
      slug: `zz-${key.toLowerCase()}`,
      kind: "accessory",
      name: name3(`منتج ${key}`, `Product ${key}`, `بەرهەمی ${key}`),
      status,
      isDemo: false,
      createdAt: now - 10 * DAY,
      updatedAt: now - DAY,
      publishedAt: now - DAY,
      ...extra,
    });
  const variant = (id: string, productId: string, priceIqd: number, extra: Partial<typeof variants.$inferInsert> = {}) =>
    db.insert(variants).values({ id, productId, sku: id.toUpperCase().replace(/_/g, "-"), priceIqd, isDefault: true, ...extra });

  const statements: BatchStatement[] = [
    product("draft", "draft"),
    variant(W.draft.v, W.draft.id, 10_000),
    product("review", "review"),
    variant(W.review.v, W.review.id, 10_000),
    product("archived", "archived"),
    variant(W.archived.v, W.archived.id, 10_000),
    product("later", "scheduled", { publishAt: now + DAY }),
    variant(W.later.v, W.later.id, 10_000),
    product("liveScheduled", "scheduled", { publishAt: now - DAY }),
    variant(W.liveScheduled.v, W.liveScheduled.id, 20_000),
    db.insert(stockLevels).values({ variantId: W.liveScheduled.v, locationId: DEFAULT_LOCATION_ID, onHand: 7 }),
    product("noVariant", "published"),
    variant(W.noVariant.v, W.noVariant.id, 10_000, { isActive: false }),

    // uploads: a public product photo, a PRIVATE file that must never show, a store warranty, two colour variants
    product("uploads", "published", {
      warrantyMonths: 12,
      specs: {
        warranty: { ar: "سنتان من الشركة", en: "Two years from the maker", ckb: "دوو ساڵ", label: name3("الضمان", "Warranty", "گەرەنتی") } as never,
        weight: 250,
        wireless: true,
      },
    }),
    variant(W.uploads.v, W.uploads.id, 30_000, { options: { color: "Red", model: "ZZ-1" }, title: name3("أحمر", "Red", "سوور"), sort: 0 }),
    variant(W.uploads.v2, W.uploads.id, 31_000, { options: { color: "Blue" }, title: name3("أزرق", "Blue", "شین"), isDefault: false, sort: 1, compareAtIqd: 31_000 }),
    db.insert(stockLevels).values({ variantId: W.uploads.v, locationId: DEFAULT_LOCATION_ID, onHand: 2 }),
    db.insert(files).values({ id: "fil_zz_public", storageKey: "pub_zz_photo.webp", visibility: "public", kind: "product_image", mime: "image/webp", bytes: 1000, sha256: "a".repeat(64), width: 800, height: 600, createdAt: now }),
    db.insert(files).values({ id: "fil_zz_private", storageKey: "prv_zz_secret.webp", visibility: "private", kind: "payment_proof", mime: "image/webp", bytes: 1000, sha256: "b".repeat(64), width: 800, height: 600, createdAt: now }),
    db.insert(media).values({ id: "med_zz_public", ownerType: "product", ownerId: W.uploads.id, fileId: "fil_zz_public", kind: "image", alt: name3("صورة", "Photo", "وێنە"), isIllustration: false, sort: 0 }),
    db.insert(media).values({ id: "med_zz_private", ownerType: "product", ownerId: W.uploads.id, fileId: "fil_zz_private", kind: "image", alt: name3("سرّي", "Secret", "نهێنی"), sort: 1 }),

    product("reviewed", "published"),
    variant(W.reviewed.v, W.reviewed.id, 40_000),
  ];
  await runBatch(db, statements);

  // reviews of every status (customers first: reviews reference them)
  const customerIds = ["cus_zz_1", "cus_zz_2", "cus_zz_3", "cus_zz_4", "cus_zz_5"];
  await runBatch(
    db,
    customerIds.map((id, index) => db.insert(customers).values({ id, phoneE164: `+96477000000${index + 1}`, name: `Reviewer ${index + 1}`, createdAt: now })),
  );
  const review = (id: string, customerId: string, rating: number, status: "pending" | "approved" | "rejected", verified: boolean, daysAgo: number) =>
    db.insert(reviews).values({
      id,
      productId: W.reviewed.id,
      customerId,
      rating,
      status,
      isVerifiedPurchase: verified,
      title: `T${rating}`,
      body: `Body ${rating}`,
      createdAt: now - daysAgo * DAY,
      locale: "ar",
    });
  await runBatch(db, [
    review("rev_zz_1", "cus_zz_1", 5, "approved", true, 3),
    review("rev_zz_2", "cus_zz_2", 4, "approved", true, 1),
    review("rev_zz_3", "cus_zz_3", 1, "approved", false, 2), // not a verified purchase → never counted
    review("rev_zz_4", "cus_zz_4", 2, "pending", true, 2), // not approved
    review("rev_zz_5", "cus_zz_5", 1, "rejected", true, 2),
  ]);
}

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
  await buildTestWorld(t.now);
});

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── pure helpers

describe("pure helpers", () => {
  it("variantLabels drops the words every title starts with, and keeps whole titles otherwise", () => {
    expect(variantLabels(["DualSense – أبيض", "DualSense – أسود Midnight Black"])).toEqual(["أبيض", "أسود Midnight Black"]);
    expect(variantLabels(["1TB", "2TB", "4TB"])).toEqual(["1TB", "2TB", "4TB"]);
    expect(variantLabels(["Steam Deck", "Steam Deck OLED"])).toEqual(["Steam Deck", "OLED"]); // a label that would be empty stays whole
    expect(variantLabels(["Only one"])).toEqual(["Only one"]);
    expect(variantLabels(["Legion Go S Powered by SteamOS", "Legion Go S with Windows 11"])).toEqual(["Powered by SteamOS", "With Windows 11"]);
  });

  it("selectorDimension names the one option that varies, ignores the model number, and says 'version' otherwise", () => {
    expect(selectorDimension([{ color: "White", model: "A" }, { color: "Black", model: "B" }])).toBe("color");
    expect(selectorDimension([{ storage: "1TB", heatsink: "yes" }, { storage: "2TB", heatsink: "yes" }])).toBe("storage");
    expect(selectorDimension([{ edition: "Core", color: "White" }, { edition: "Full", color: "Black" }])).toBe("version");
    // every variant has its own colour; only some add an edition → still a colour choice
    expect(selectorDimension([{ color: "White" }, { color: "Black" }, { color: "Flare Orange", edition: "Prism Collection" }])).toBe("color");
    // the colour repeats across editions → several things change
    expect(selectorDimension([{ edition: "7", color: "Black" }, { edition: "7P", color: "Black" }, { edition: "7", color: "White" }])).toBe("version");
    expect(selectorDimension([{ colour: "x" }, { colour: "y" }])).toBe("version"); // an unknown key → a neutral name
    expect(selectorDimension([{}, {}])).toBe("version");
    expect(selectorDimension([{ color: "White" }])).toBeNull();
  });

  it("selectVariant follows ?v= in any letter case and falls back to the default", () => {
    const variant = (id: string, sku: string) => ({ id, sku }) as VariantDetail;
    const product = { variants: [variant("a", "ZZ-RED"), variant("b", "ZZ-BLUE")], defaultVariantId: "a" };
    expect(selectVariant(product, "zz-blue").id).toBe("b");
    expect(selectVariant(product, " ZZ-BLUE ").id).toBe("b");
    expect(selectVariant(product, "nope").id).toBe("a");
    expect(selectVariant(product, "<script>").id).toBe("a");
    expect(selectVariant(product, null).id).toBe("a");
  });

  it("splitMixed isolates each Latin run but leaves brackets, separators and a final full stop to the sentence", () => {
    const ltr = (text: string) => splitMixed(text).filter((part) => part.ltr).map((part) => part.text);
    expect(ltr("مجموعة Prism الشفافة (Flare Orange وEmerald Green)")).toEqual(["Prism", "Flare Orange", "Emerald Green"]);
    expect(ltr("اهتزاز Haptic · Adaptive triggers")).toEqual(["Haptic", "Adaptive triggers"]);
    expect(ltr("يد التحكم الأصلية لجهاز PS5.")).toEqual(["PS5"]);
    expect(ltr("من 2–4 لاعبين، USB-C و3.5 ملم")).toEqual(["2–4", "USB-C", "3.5"]);
    expect(ltr("بدقة 1920×1080 وتردد متغير (VRR)، الطراز BEE-001(-01)")).toEqual(["1920×1080", "VRR", "BEE-001(-01)"]);
    expect(splitMixed("Mario Kart World")).toEqual([{ text: "Mario Kart World", ltr: false }]); // nothing to isolate on its own
    expect(splitMixed("لجهاز PS5.").map((part) => part.text).join("")).toBe("لجهاز PS5."); // nothing lost
  });

  it("gelOfPlatformName maps platform options to stage light", () => {
    expect(gelOfPlatformName("PS5")).toBe("playstation");
    expect(gelOfPlatformName("PS4")).toBe("playstation");
    expect(gelOfPlatformName("XBOX Series X|S")).toBe("xbox");
    expect(gelOfPlatformName("Nintendo Switch 2")).toBe("nintendo");
    expect(gelOfPlatformName("Windows 11")).toBeNull();
    expect(gelOfPlatformName(undefined)).toBeNull();
  });

  it("baghdadMidnight is 00:00 at UTC+3, and refuses anything that is not a date", () => {
    expect(baghdadMidnight("2027-02-04")).toBe(Date.UTC(2027, 1, 3, 21, 0, 0));
    expect(baghdadMidnight("04/02/2027")).toBeNull();
    expect(baghdadMidnight(null)).toBeNull();
  });

  it("galleryFor: own pictures; the default shows the product gallery; a picture-less sibling borrows and says so", () => {
    const image = (key: string) => ({ artKey: key, mediaKey: null, alt: key, isIllustration: false });
    const v = (id: string, images: ReturnType<typeof image>[]) => ({ id, images, label: id }) as unknown as VariantDetail;
    const product = { images: [image("p1"), image("p2")], defaultVariantId: "white", variants: [v("white", [image("w1")]), v("black", [image("b1")]), v("pink", [])] };
    expect(galleryFor(product, product.variants[1])).toMatchObject({ images: [image("b1")], borrowed: false });
    expect(galleryFor(product, product.variants[2])).toMatchObject({ images: [image("w1")], borrowed: true, from: { id: "white" } });
    const plain = { images: [image("p1")], defaultVariantId: "a", variants: [v("a", []), v("b", [])] };
    expect(galleryFor(plain, plain.variants[1])).toMatchObject({ images: [image("p1")], borrowed: false });
    const defaultFull = { images: [image("p1")], defaultVariantId: "a", variants: [v("a", []), v("b", [image("b1")])] };
    expect(galleryFor(defaultFull, defaultFull.variants[0])).toMatchObject({ images: [image("p1")], borrowed: false });
  });

  it("the URL keeps ?v= for every variant but the default, and only a change of v skips the loader", () => {
    const product = { variants: [{ id: "a", sku: "ZZ-A" }, { id: "b", sku: "ZZ-B" }] as VariantDetail[], defaultVariantId: "a" };
    expect(searchFor("", product, product.variants[1])).toBe("?v=ZZ-B");
    expect(searchFor("?v=ZZ-B&utm=x", product, product.variants[0])).toBe("?utm=x");
    expect(onlyVariantChanged(new URLSearchParams("v=A"), new URLSearchParams("v=B"))).toBe(true);
    expect(onlyVariantChanged(new URLSearchParams(""), new URLSearchParams("v=B"))).toBe(true);
    expect(onlyVariantChanged(new URLSearchParams("v=A"), new URLSearchParams("v=A"))).toBe(false); // a revalidation: let it run
    expect(onlyVariantChanged(new URLSearchParams("v=A"), new URLSearchParams("v=B&page=2"))).toBe(false);
  });

  it("JSON-LD never closes its script, has no offers in demo mode and no rating without real reviews", () => {
    expect(jsonForScript({ a: "</script><b>&" })).not.toMatch(/[<>&]/);
    const variant = { sku: "ZZ-1", modelNumber: "M1", priceIqd: 99_000, stock: "in_stock" } as VariantDetail;
    const base = {
      product: { name: "X", slug: "x", description: "d", short: null, brand: "B", categories: [{ slug: "c", name: "C" }] },
      variant,
      origin: "https://tamtamgames.com",
      locale: "en" as Locale,
      image: "/products/x/1.jpg",
    };
    const demo = productJsonLd({ ...base, reviews: { count: 0, average: null, distribution: [0, 0, 0, 0, 0] }, storeMode: "demo" });
    expect(demo).not.toHaveProperty("offers");
    expect(demo).not.toHaveProperty("aggregateRating");
    expect(demo).toMatchObject({ "@type": "Product", url: "https://tamtamgames.com/en/p/x", sku: "ZZ-1", mpn: "M1", image: ["https://tamtamgames.com/products/x/1.jpg"] });
    const live = productJsonLd({ ...base, reviews: { count: 2, average: 4.5, distribution: [0, 0, 0, 1, 1] }, storeMode: "live" });
    expect(live).toMatchObject({ offers: { price: 99_000, priceCurrency: "IQD", availability: "https://schema.org/InStock" }, aggregateRating: { ratingValue: 4.5, reviewCount: 2 } });
  });
});

// ───────────────────────────────────────────────────────────────── what is found

describe("getProductDetail — what is found", () => {
  it("finds every live product of the catalogue, with exactly its active variants and its default first", async () => {
    const slugs = await liveSlugs();
    expect(slugs.length).toBeGreaterThan(100);
    for (const slug of slugs) {
      const detail = await getProductDetail(t.db, "ar", slug, { now: t.now, related: false });
      expect(detail, slug).not.toBeNull();
      const expected = await rows<{ id: string; is_default: number }>(
        "SELECT v.id, v.is_default FROM variants v JOIN products p ON p.id = v.product_id WHERE p.slug = ? AND v.is_active = 1 ORDER BY v.is_default DESC, v.sort, v.id",
        slug,
      );
      expect(detail!.slug).toBe(slug);
      expect(detail!.variants.map((variant) => variant.id)).toEqual(expected.map((row) => row.id));
      expect(detail!.defaultVariantId).toBe(expected[0].id);
    }
  });

  it("answers null for what must 404: unknown, malformed, draft, review, archived, scheduled for later, no active variant", async () => {
    for (const slug of ["no-such-product", "", "../etc/passwd", "a".repeat(81), "zz-draft", "zz-review", "zz-archived", "zz-later", "zz-novariant"]) {
      expect(await getProductDetail(t.db, "ar", slug, { now: t.now }), slug).toBeNull();
    }
  });

  it("shows a scheduled product once its time has come, and finds a slug written in other letter case", async () => {
    expect((await getProductDetail(t.db, "en", "zz-livescheduled", { now: t.now }))?.id).toBe(W.liveScheduled.id);
    const [first] = await liveSlugs();
    const upper = await getProductDetail(t.db, "ar", first.toUpperCase(), { now: t.now });
    expect(upper?.slug).toBe(first); // the page redirects to this canonical slug
  });
});

// ───────────────────────────────────────────────────────────────── money, stock, dates

describe("getProductDetail — prices, stock and release dates", () => {
  let all: ProductDetail[] = [];
  beforeAll(async () => {
    all = [];
    for (const slug of await liveSlugs()) all.push((await getProductDetail(t.db, "ar", slug, { now: t.now, related: false }))!);
  });

  it("prices are whole dinars; a compare-at price is shown only for a genuine reduction", async () => {
    const stored = new Map(
      (await rows<{ id: string; price_iqd: number; compare_at_iqd: number | null }>("SELECT id, price_iqd, compare_at_iqd FROM variants")).map((row) => [row.id, row]),
    );
    let reductions = 0;
    for (const variant of all.flatMap((product) => product.variants)) {
      const row = stored.get(variant.id)!;
      expect(Number.isSafeInteger(variant.priceIqd) && variant.priceIqd >= 0).toBe(true);
      expect(variant.priceIqd).toBe(row.price_iqd);
      if (row.compare_at_iqd !== null && row.compare_at_iqd > row.price_iqd) {
        expect(variant.compareAtIqd).toBe(row.compare_at_iqd);
        reductions++;
      } else expect(variant.compareAtIqd).toBeNull();
    }
    expect(reductions).toBeGreaterThan(0);
    // a compare-at price equal to the price is not a reduction
    const uploads = await getProductDetail(t.db, "ar", "zz-uploads", { now: t.now });
    expect(uploads?.variants.find((variant) => variant.id === W.uploads.v2)?.compareAtIqd).toBeNull();
  });

  it("stock is the commerce core's state (a demo product never 'low'), and orderable exactly when units are available", async () => {
    const ids = all.flatMap((product) => product.variants.map((variant) => variant.id));
    const availability = await getAvailability(t.db, ids);
    let orderable = 0;
    for (const product of all) {
      for (const variant of product.variants) {
        const units = availability.get(variant.id)!;
        expect(variant.orderable).toBe(units.available > 0);
        if (variant.orderable) {
          // scarcity from placeholder stock is not information (design v2 spec §4.7): demo rows say in stock
          expect(variant.stock).toBe(product.isDemo && units.state === "low_stock" ? "in_stock" : units.state);
          orderable++;
        } else expect(["out_of_stock", "preorder"]).toContain(variant.stock);
      }
    }
    expect(orderable).toBeGreaterThan(50);
  });

  it("variants that come out later carry their date, have no stock and cannot be ordered", async () => {
    const dated = await rows<{ slug: string; sku: string; date: string }>(
      "SELECT p.slug, d.key AS sku, d.value AS date FROM products p, json_each(p.attributes, '$.variantReleaseDates') d WHERE p.status = 'published'",
    );
    const ahead = dated.filter((row) => (baghdadMidnight(row.date) ?? 0) > t.now);
    expect(ahead.length).toBeGreaterThan(0);
    for (const row of ahead) {
      const variant = all.find((product) => product.slug === row.slug)!.variants.find((entry) => entry.sku === row.sku)!;
      expect(variant.releaseAt).toBe(baghdadMidnight(row.date));
      expect(variant.orderable).toBe(false);
      expect(variant.stock).toBe("preorder");
    }
  });

  it("pre-order products carry their release date; nothing is offered before stock exists", async () => {
    const preorders = await rows<{ slug: string; at: number }>("SELECT slug, preorder_release_at AS at FROM products WHERE status = 'published' AND preorder_release_at > ?", t.now);
    expect(preorders.length).toBeGreaterThan(0);
    for (const row of preorders) {
      const product = all.find((entry) => entry.slug === row.slug)!;
      expect(product.releaseAt).toBe(row.at);
      for (const variant of product.variants) {
        expect(variant.releaseAt).not.toBeNull();
        if (!variant.orderable) expect(variant.stock).toBe("preorder");
      }
    }
    const released = all.filter((product) => !preorders.some((row) => row.slug === product.slug));
    expect(released.every((product) => product.releaseAt === null)).toBe(true);
  });

  it("delivery and returns come from settings", async () => {
    const fee = await rows<{ value: string }>("SELECT value FROM settings WHERE key = 'shipping.flat_fee_iqd'");
    for (const product of all.slice(0, 5)) {
      expect(product.delivery).toEqual({ flatFeeIqd: Number(JSON.parse(fee[0].value)), overridesEnabled: false });
      expect(product.returnsWindowDays).toBe(7);
    }
  });
});

// ───────────────────────────────────────────────────────────────── facts

describe("getProductDetail — facts", () => {
  it("never makes the maker's warranty the store's: the store warranty comes only from warranty_months", async () => {
    const withSpec = await rows<{ slug: string; warranty: string }>(
      "SELECT slug, json_extract(specs, '$.warranty.ar') AS warranty FROM products WHERE status = 'published' AND json_extract(specs, '$.warranty') IS NOT NULL AND slug NOT LIKE 'zz-%'",
    );
    expect(withSpec.length).toBeGreaterThan(0);
    for (const row of withSpec) {
      const detail = await getProductDetail(t.db, "ar", row.slug, { now: t.now, related: false });
      expect(detail!.makerWarranty).toBe(row.warranty);
      expect(detail!.storeWarrantyMonths).toBeNull(); // the demo leaves warranty_months empty on purpose
    }
    const uploads = await getProductDetail(t.db, "en", "zz-uploads", { now: t.now });
    expect(uploads!.storeWarrantyMonths).toBe(12);
    expect(uploads!.makerWarranty).toBe("Two years from the maker");
  });

  it("reads specs in their order with their localized labels; plain numbers and yes/no become text", async () => {
    const uploads = await getProductDetail(t.db, "ar", "zz-uploads", { now: t.now });
    expect(uploads!.specs).toEqual([
      { key: "warranty", label: "الضمان", value: "سنتان من الشركة" },
      { key: "weight", label: "weight", value: "250" },
      { key: "wireless", label: "wireless", value: "نعم" },
    ]);
    const [withSpecs] = await rows<{ slug: string }>("SELECT slug FROM products WHERE status = 'published' AND specs IS NOT NULL AND slug NOT LIKE 'zz-%' ORDER BY slug LIMIT 1");
    const ar = await getProductDetail(t.db, "ar", withSpecs.slug, { now: t.now, related: false });
    const en = await getProductDetail(t.db, "en", withSpecs.slug, { now: t.now, related: false });
    expect(ar!.specs.map((row) => row.key)).toEqual(en!.specs.map((row) => row.key));
    expect(ar!.specs.map((row) => row.label)).not.toEqual(en!.specs.map((row) => row.label));
  });

  it("store sets list their components with quantities; nothing else claims to be a set", async () => {
    const sets = await rows<{ bundle: string; component: string; qty: number; slug: string }>(
      "SELECT bi.bundle_variant_id AS bundle, cp.id AS component, bi.qty, p.slug FROM bundle_items bi JOIN variants v ON v.id = bi.bundle_variant_id JOIN products p ON p.id = v.product_id JOIN variants cv ON cv.id = bi.component_variant_id JOIN products cp ON cp.id = cv.product_id",
    );
    expect(sets.length).toBeGreaterThan(0);
    for (const slug of new Set(sets.map((row) => row.slug))) {
      const detail = await getProductDetail(t.db, "ar", slug, { now: t.now, related: false });
      for (const variant of detail!.variants) {
        const expected = sets.filter((row) => row.bundle === variant.id);
        if (expected.length === 0) {
          expect(variant.bundle).toBeNull();
          continue;
        }
        expect(variant.bundle!.map((entry) => `${entry.productId}×${entry.qty}`).sort()).toEqual(expected.map((row) => `${row.component}×${row.qty}`).sort());
        expect(variant.bundle!.every((entry) => entry.name.length > 0 && entry.image.artKey !== null)).toBe(true);
      }
    }
    const other = await getProductDetail(t.db, "ar", "zz-uploads", { now: t.now });
    expect(other!.variants.every((variant) => variant.bundle === null)).toBe(true);
  });

  it("game facts: formats, Arabic support and the devices a game is for; multi-platform games name their platforms", async () => {
    const games = await rows<{ slug: string; format: string | null; arabic: string | null; platforms: string | null; platform_id: string | null }>(
      "SELECT slug, json_extract(attributes, '$.game.physicalFormat') AS format, json_extract(attributes, '$.game.arabic') AS arabic, json_extract(attributes, '$.game.platforms') AS platforms, platform_id FROM products WHERE status = 'published' AND json_extract(attributes, '$.game') IS NOT NULL",
    );
    expect(games.some((row) => row.format === "game-key-card")).toBe(true);
    for (const row of games) {
      const detail = await getProductDetail(t.db, "en", row.slug, { now: t.now, related: false });
      expect(detail!.game, row.slug).not.toBeNull();
      expect(detail!.game!.format).toBe(row.format);
      expect(detail!.game!.arabic).toBe(row.arabic ?? "unknown");
      const devices = parse<string[]>(row.platforms) ?? [];
      expect(detail!.game!.platforms.map((entry) => entry.slug)).toEqual(devices);
      expect(detail!.game!.platforms.every((entry) => entry.name.length > 0)).toBe(true);
      if (row.platform_id === null) {
        expect(detail!.platform).toBeNull();
        expect(detail!.forPlatforms.length).toBeGreaterThan(0);
      } else expect(detail!.forPlatforms).toEqual([]);
    }
  });

  it("variant labels are the localized titles without the shared words; the selector names what varies", async () => {
    const [many] = await rows<{ slug: string }>(
      "SELECT p.slug FROM products p WHERE p.status = 'published' AND (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) >= 5 ORDER BY p.slug LIMIT 1",
    );
    for (const locale of LOCALE_CODES) {
      const detail = await getProductDetail(t.db, locale, many.slug, { now: t.now, related: false });
      expect(detail!.selector).not.toBeNull();
      expect(detail!.variants.map((variant) => variant.label)).toEqual(variantLabels(detail!.variants.map((variant) => variant.title)));
      expect(new Set(detail!.variants.map((variant) => variant.label)).size).toBe(detail!.variants.length);
    }
    const uploads = await getProductDetail(t.db, "en", "zz-uploads", { now: t.now });
    expect(uploads!.selector).toBe("color");
    expect(uploads!.variants.map((variant) => [variant.label, variant.modelNumber])).toEqual([
      ["Red", "ZZ-1"],
      ["Blue", null],
    ]);
    expect(uploads!.variants[0].options).toEqual({ color: "Red" }); // the model number is not an option
  });

  it("is localized: the name follows the language", async () => {
    const [slug] = await liveSlugs();
    const row = (await rows<{ name: string }>("SELECT name FROM products WHERE slug = ?", slug))[0];
    for (const locale of LOCALE_CODES) {
      const detail = await getProductDetail(t.db, locale, slug, { now: t.now, related: false });
      expect(detail!.name).toBe(pick(parse<L10n>(row.name), locale));
    }
  });
});

// ───────────────────────────────────────────────────────────────── pictures, related, privacy

describe("getProductDetail — pictures, related products and privacy", () => {
  it("pictures: product photos as stored; public uploads by key; private files never", async () => {
    const [slug] = await liveSlugs();
    const detail = await getProductDetail(t.db, "ar", slug, { now: t.now, related: false });
    const stored = await rows<{ art_key: string }>("SELECT m.art_key FROM media m JOIN products p ON p.id = m.owner_id WHERE m.owner_type = 'product' AND p.slug = ? ORDER BY m.sort, m.id", slug);
    expect(detail!.images.map((image) => image.artKey)).toEqual(stored.map((row) => row.art_key));
    expect(detail!.images.every((image) => image.artKey !== null && getArt(image.artKey) !== undefined)).toBe(true);

    const uploads = await getProductDetail(t.db, "ar", "zz-uploads", { now: t.now });
    expect(uploads!.images).toEqual([{ artKey: null, mediaKey: "pub_zz_photo.webp", alt: "صورة", isIllustration: false, width: 800, height: 600 }]);
    expect(JSON.stringify(uploads)).not.toContain("prv_zz_secret");
  });

  it("credits name the owners of the photos shown, once each", async () => {
    for (const slug of (await liveSlugs()).slice(0, 15)) {
      const detail = await getProductDetail(t.db, "ar", slug, { now: t.now, related: false });
      const keys = [...detail!.images, ...detail!.variants.flatMap((variant) => variant.images)].map((image) => image.artKey).filter((key): key is string => key !== null);
      const owners = [...new Set(keys.map((key) => getArt(key)).filter(isPhoto).map((art) => art.credit))];
      expect(detail!.credits.map((credit) => credit.owner).sort()).toEqual(owners.sort());
      expect(detail!.credits.every((credit) => credit.page === null || credit.page.startsWith("https://"))).toBe(true);
    }
  });

  it("related shelves: published products only, never the product itself, each once, in editorial order", async () => {
    const withRelations = await rows<{ slug: string; id: string }>(
      "SELECT DISTINCT p.slug, p.id FROM products p JOIN product_relations r ON r.product_id = p.id WHERE p.status = 'published' ORDER BY p.slug LIMIT 20",
    );
    expect(withRelations.length).toBeGreaterThan(0);
    for (const { slug, id } of withRelations) {
      const detail = await getProductDetail(t.db, "ar", slug, { now: t.now });
      const related = detail!.related.flatMap((shelf) => shelf.items.map((item) => item.id));
      expect(new Set(related).size).toBe(related.length);
      expect(related).not.toContain(id);
      const allowed = await rows<{ id: string; kind: string }>(
        "SELECT r.related_product_id AS id, r.kind FROM product_relations r JOIN products p ON p.id = r.related_product_id WHERE r.product_id = ? AND p.status = 'published' ORDER BY r.pinned DESC, r.sort, r.related_product_id",
        id,
      );
      expect(related.every((relatedId) => allowed.some((row) => row.id === relatedId))).toBe(true);
      for (const shelf of detail!.related) {
        expect(shelf.items.length).toBeGreaterThan(0);
        expect(shelf.items.length).toBeLessThanOrEqual(RELATED_PER_SHELF);
        const kinds = shelf.kind === "setup" ? ["setup", "upsell", "upgrade"] : [shelf.kind];
        const order = allowed.filter((row) => kinds.includes(row.kind) && shelf.items.some((item) => item.id === row.id)).map((row) => row.id);
        expect(shelf.items.map((item) => item.id)).toEqual([...new Set(order)]);
      }
    }
    // the quick preview leaves them out
    const [first] = withRelations;
    expect((await getProductDetail(t.db, "ar", first.slug, { now: t.now, related: false }))!.related).toEqual([]);
  });

  it("never returns a stock quantity, a cost, a margin or a serial — and the preview is a subset of the page", async () => {
    const forbidden = ["available", "onHand", "on_hand", "reserved", "cost", "landedCostIqd", "landed_cost_iqd", "unitCostMinor", "margin", "minMarginBps", "serial", "serials", "acquisitionCostIqd"];
    for (const slug of (await liveSlugs()).slice(0, 25)) {
      const detail = await getProductDetail(t.db, "ar", slug, { now: t.now });
      const keys = keysOf(detail);
      for (const key of forbidden) expect(keys.has(key), `${slug}: ${key}`).toBe(false);
      const preview = toProductPreview(detail!);
      expect(preview.variants).toBe(detail!.variants);
      expect(preview.highlights.length).toBeLessThanOrEqual(3);
      expect(keysOf(preview).has("related")).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────── reviews

describe("reviews", () => {
  it("count only approved reviews from verified purchases", async () => {
    expect(await getReviewSummary(t.db, W.reviewed.id)).toEqual({ count: 2, average: 4.5, distribution: [0, 0, 0, 1, 1] });
  });

  it("say nothing when there are none — no invented rating", async () => {
    const [slug] = await liveSlugs();
    const detail = await getProductDetail(t.db, "ar", slug, { now: t.now });
    expect(await getReviewSummary(t.db, detail!.id)).toEqual({ count: 0, average: null, distribution: [0, 0, 0, 0, 0] });
    expect(await getReviewSummary(t.db, "not an id; DROP TABLE reviews")).toEqual({ count: 0, average: null, distribution: [0, 0, 0, 0, 0] });
  });

  it("list the newest approved verified reviews as text only — never who wrote them", async () => {
    const list = await listVerifiedReviews(t.db, W.reviewed.id);
    expect(list.map((entry) => entry.id)).toEqual(["rev_zz_2", "rev_zz_1"]);
    const keys = keysOf(list);
    for (const key of ["customerId", "customer_id", "name", "phone", "phoneE164", "orderItemId"]) expect(keys.has(key)).toBe(false);
    expect(await listVerifiedReviews(t.db, W.reviewed.id, { limit: 1 })).toHaveLength(1);
  });
});
