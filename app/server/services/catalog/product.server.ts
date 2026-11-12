/**
 * Product detail — everything /p/:slug and the quick-preview sheet show about one product (docs/CONTRACTS.md §3, row
 * "product"; the view model and its rules are in ./product-types.ts).
 *
 *   const product = await getProductDetail(db, ctx.locale, params.slug, { now: ctx.now });
 *   if (!product) throw data({ error: "not_found" }, { status: 404 });
 *
 * Returns null for an unknown slug, a product that is not live (draft, review, archived, scheduled for later) or one
 * without an active variant. A live product is `published`, or `scheduled` with its publish time passed — the same
 * rule the cart sells by (cart.server isSellableProduct).
 *
 * HOW (three round trips, no N+1)
 *   1. the product row (+ platform and device model)
 *   2. one db.batch: active variants, pictures of the product and its variants, store-set components, relations,
 *      the category trail, the devices a game is for — and, in parallel, the delivery / returns settings
 *   3. stock states (the commerce core's getAvailability — never re-implemented here) and the related products'
 *      cards (the catalogue read layer's getCardsByIds), in parallel
 *
 * PRIVACY: no cost, margin, serial or stock quantity is selected or returned — only states. Availability numbers
 * stay inside this function (they decide `orderable`).
 *
 * HONESTY, the same rules as the cards (cards.server.ts, card-facts.ts): a variant's compare-at is struck only when
 * an applied price change set it (really charged) or as a demo row's demo value (`compareAtDemo`); a demo product
 * never says "low_stock"; `isNew` only from the researched release date or a real (non-demo) listing; pictures that
 * are not cut-outs carry `opaque` (design v2 spec §7.5).
 *
 * Facts come from the researched catalogue as imported (products.specs, products.attributes — shape in
 * app/server/db/seed/demo/import.ts ProductAttributes). Attributes are JSON that staff may edit later, so they are
 * read defensively: anything malformed is left out, never guessed.
 *
 * Services take `db` first and never import "cloudflare:workers" (tests run them against a local D1).
 */
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { getArt, isPhoto } from "~/art";
import type { ImageRef, ProductCardData, ProductKind, StockState } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { deviceModels, files, media, platforms, productRelations, products, variants } from "~/server/db/schema";
import { batchSql, runBatch, type BatchStatement } from "~/server/db/tx.server";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { getSettings } from "~/server/settings.server";
import { isNewProduct, kindLabelOf, qualifiedLine, qualifierOf, withOpaque } from "./card-facts";
import { getCardsByIds } from "./cards.server";
import {
  baghdadMidnight,
  gelOfPlatformName,
  selectorDimension,
  variantLabels,
  type ArabicSupport,
  type BundleComponent,
  type GameFacts,
  type GameFormat,
  type ImageCredit,
  type ProductDetail,
  type ProductGel,
  type ProductLifecycle,
  type ProductPlatform,
  type RelatedKind,
  type RelatedShelf,
  type SourceLink,
  type SpecRow,
  type VariantDetail,
} from "./product-types";

export type { ProductDetail, ProductPreview, VariantDetail } from "./product-types";

/** Slugs are lowercase words joined by "-" or "_" (the catalogue's shape), at most 80 characters. */
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** At most this many cards per related shelf. */
export const RELATED_PER_SHELF = 12;

const GELS: readonly ProductGel[] = ["nintendo", "playstation", "xbox", "handheld"];
const gelOf = (accent: string | null | undefined): ProductGel | null =>
  accent && (GELS as readonly string[]).includes(accent) ? (accent as ProductGel) : null;

const LIFECYCLES: readonly ProductLifecycle[] = ["available", "preorder", "upcoming", "discontinued", "limited"];
const GAME_FORMATS: readonly GameFormat[] = ["cartridge", "game-key-card", "disc", "code-in-box"];
const ARABIC: readonly ArabicSupport[] = ["voice+subtitles+interface", "subtitles+interface", "interface", "none", "unknown"];

/** Relation kinds as shelves: what completes the product (setup, plus upsell and upgrade), accessories, alternatives. */
const SHELF_OF: Record<string, RelatedKind> = {
  setup: "setup",
  upsell: "setup",
  upgrade: "setup",
  accessory: "accessory",
  alternative: "alternative",
};
const SHELF_ORDER: readonly RelatedKind[] = ["setup", "accessory", "alternative"];

/** Words for a yes/no spec value (the only spec values the service has to word itself). */
const YES: L10n = { ar: "نعم", en: "Yes", ckb: "بەڵێ" };
const NO: L10n = { ar: "لا", en: "No", ckb: "نەخێر" };

// ───────────────────────────────────────────────────────────────── defensive readers for JSON columns

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** A localized text: an object with a non-empty Arabic string (the source language). */
const asL10n = (value: unknown): L10n | null => (isObject(value) && typeof value.ar === "string" && value.ar.trim() !== "" ? (value as L10n) : null);
const l10nList = (value: unknown): L10n[] => (Array.isArray(value) ? value.map(asL10n).filter((entry): entry is L10n => entry !== null) : []);
const text = (value: unknown, locale: Locale): string | null => {
  const l10n = asL10n(value);
  const picked = l10n ? pick(l10n, locale).trim() : "";
  return picked !== "" ? picked : null;
};
/** JSON columns read through raw SQL arrive as text; through the query builder they are already parsed. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────── pictures

type MediaRow = {
  ownerType: string;
  ownerId: string;
  artKey: string | null;
  alt: unknown;
  isIllustration: boolean | number;
  storageKey: string | null;
  visibility: string | null;
  width: number | null;
  height: number | null;
};

/** One media row as an ImageRef: a catalogue photo key, or a PUBLIC uploaded file (private files are never shown). */
function imageOf(row: MediaRow, fallbackAlt: string, locale: Locale): ImageRef | null {
  const mediaKey = row.storageKey && row.visibility === "public" ? row.storageKey : null;
  const artKey = mediaKey ? null : row.artKey;
  if (!mediaKey && !artKey) return null;
  return withOpaque({
    artKey,
    mediaKey,
    alt: text(parsed(row.alt), locale) ?? fallbackAlt,
    isIllustration: row.isIllustration !== false && row.isIllustration !== 0,
    ...(mediaKey && row.width && row.height ? { width: row.width, height: row.height } : {}),
  });
}

type ImageJson = {
  a: string | null;
  k: string | null;
  w: number | null;
  h: number | null;
  alt: unknown;
  i: number | null;
};

/** The first-picture JSON the bundle query builds (same shape as the card read layer's). */
function imageFromJson(raw: unknown, fallbackAlt: string, locale: Locale): ImageRef {
  const image = parsed(raw) as ImageJson | null;
  if (!isObject(image))
    return {
      artKey: null,
      mediaKey: null,
      alt: fallbackAlt,
      isIllustration: true,
    };
  const mediaKey = asString(image.k);
  return withOpaque({
    artKey: mediaKey ? null : asString(image.a),
    mediaKey,
    alt: text(image.alt, locale) ?? fallbackAlt,
    isIllustration: image.i !== 0,
    ...(mediaKey && image.w && image.h ? { width: image.w, height: image.h } : {}),
  });
}

/** Owners of the catalogue photos shown, once each, with the page the first of their photos came from. */
function creditsOf(images: readonly ImageRef[]): ImageCredit[] {
  const credits = new Map<string, ImageCredit>();
  for (const image of images) {
    if (!image.artKey) continue;
    const art = getArt(image.artKey);
    if (!isPhoto(art) || !art.credit) continue;
    const page = art.source.page && /^https:\/\//.test(art.source.page) ? art.source.page : null;
    if (!credits.has(art.credit)) credits.set(art.credit, { owner: art.credit, page });
  }
  return [...credits.values()];
}

// ───────────────────────────────────────────────────────────────── specs and attributes

function specsOf(raw: unknown, locale: Locale): SpecRow[] {
  const specs = parsed(raw);
  if (!isObject(specs)) return [];
  const rows: SpecRow[] = [];
  for (const [key, value] of Object.entries(specs)) {
    let label: string | null = null;
    let shown: string | null = null;
    if (isObject(value)) {
      label = text(value.label, locale);
      shown = text(value, locale);
    } else if (typeof value === "string") {
      shown = asString(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      shown = String(value);
    } else if (typeof value === "boolean") {
      shown = pick(value ? YES : NO, locale);
    }
    if (shown)
      rows.push({
        key,
        label: label ?? key.replace(/[_-]+/g, " "),
        value: shown,
      });
  }
  return rows;
}

function sourcesOf(raw: unknown): SourceLink[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SourceLink[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const url = asString(entry.url);
    if (!url || !/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: asString(entry.title),
      publisher: asString(entry.publisher),
    });
  }
  return out;
}

/** A spec row by any of its keys (the research is not uniform: "age" / "ageRating", "platform" / "platforms"). */
const specValue = (specs: readonly SpecRow[], ...keys: string[]): string | null => specs.find((row) => keys.includes(row.key))?.value ?? null;

function gameOf(raw: unknown, specs: readonly SpecRow[], devices: ReadonlyMap<string, string>, locale: Locale): GameFacts | null {
  if (!isObject(raw)) return null;
  const rating = isObject(raw.ageRating) ? raw.ageRating : {};
  const format = asString(raw.physicalFormat);
  const arabic = asString(raw.arabic);
  const platformsRaw = Array.isArray(raw.platforms) ? raw.platforms : [];
  return {
    platforms: platformsRaw
      .map((slug) => (typeof slug === "string" ? { slug, name: devices.get(slug) ?? null } : null))
      .filter((entry): entry is { slug: string; name: string } => entry !== null && entry.name !== null),
    genres: l10nList(raw.genres)
      .map((entry) => pick(entry, locale))
      .filter((entry) => entry !== ""),
    format: format && (GAME_FORMATS as readonly string[]).includes(format) ? (format as GameFormat) : null,
    sizeGb: asNumber(raw.sizeGb),
    players: specValue(specs, "players"),
    online: text(raw.online, locale),
    arabic: arabic && (ARABIC as readonly string[]).includes(arabic) ? (arabic as ArabicSupport) : "unknown",
    ageRating: { pegi: asNumber(rating.pegi), esrb: asString(rating.esrb) },
    developer: asString(raw.developer),
    publisher: asString(raw.publisher),
  };
}

// ───────────────────────────────────────────────────────────────── the service

export type ProductDetailOptions = {
  /** Request time (ctx.now): decides live / scheduled, pre-order and release dates. Defaults to Date.now(). */
  now?: number;
  /** Leave out the related products (one query less) — the quick preview does not show them. */
  related?: boolean;
};

type ProductRow = {
  id: string;
  slug: string;
  kind: ProductKind;
  name: L10n;
  short: L10n | null;
  description: L10n | null;
  brand: string | null;
  specs: unknown;
  attributes: unknown;
  warrantyMonths: number | null;
  ageRating: string | null;
  region: string | null;
  mediaFormat: "physical" | "digital" | null;
  status: string;
  publishAt: number | null;
  publishedAt: number | null;
  createdAt: number;
  isDemo: boolean;
  seo: unknown;
  preorderReleaseAt: number | null;
  categoryId: string | null;
  platformSlug: string | null;
  platformName: L10n | null;
  platformAccent: string | null;
  platformActive: boolean | null;
  modelSlug: string | null;
  modelName: L10n | null;
  modelStatus: string | null;
};

type VariantRow = {
  id: string;
  sku: string;
  title: L10n | null;
  options: unknown;
  priceIqd: number;
  compareAtIqd: number | null;
  isDefault: boolean;
};
type RelationRow = { relatedId: string; kind: string };
type TrailRow = { slug: string; name: string; depth: number };
type DeviceRow = {
  slug: string;
  name: L10n;
  platformSlug: string;
  platformName: string | L10n;
  accent: string;
  platformActive: number | boolean;
};
type BundleRow = {
  bundle: string;
  qty: number;
  price_iqd: number;
  variant_title: string | null;
  product_id: string;
  slug: string;
  name: string;
  status: string;
  publish_at: number | null;
  variant_count: number;
  image: string | null;
};

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

const isLive = (status: string, publishAt: number | null, now: number) =>
  status === "published" || (status === "scheduled" && publishAt !== null && publishAt <= now);

/**
 * The product page's data for `slug`, in `locale`; null when there is no live product with an active variant under
 * that slug (the page answers 404). A slug that differs only in letter case finds the product — compare
 * `result.slug` with the URL to redirect to the canonical address.
 */
export async function getProductDetail(db: Db, locale: Locale, slug: string, options: ProductDetailOptions = {}): Promise<ProductDetail | null> {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("getProductDetail: `now` must be epoch milliseconds");
  const wanted = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  if (wanted.length === 0 || wanted.length > 80 || !SLUG.test(wanted)) return null;

  // ── 1. the product ────────────────────────────────────────────────────────────────────────────
  const row = (await db
    .select({
      id: products.id,
      slug: products.slug,
      kind: products.kind,
      name: products.name,
      short: products.short,
      description: products.description,
      brand: products.brand,
      specs: products.specs,
      attributes: products.attributes,
      warrantyMonths: products.warrantyMonths,
      ageRating: products.ageRating,
      region: products.region,
      mediaFormat: products.mediaFormat,
      status: products.status,
      publishAt: products.publishAt,
      publishedAt: products.publishedAt,
      createdAt: products.createdAt,
      isDemo: products.isDemo,
      seo: products.seo,
      preorderReleaseAt: products.preorderReleaseAt,
      categoryId: products.categoryId,
      platformSlug: platforms.slug,
      platformName: platforms.name,
      platformAccent: platforms.accent,
      platformActive: platforms.isActive,
      modelSlug: deviceModels.slug,
      modelName: deviceModels.name,
      modelStatus: deviceModels.status,
    })
    .from(products)
    .leftJoin(platforms, eq(platforms.id, products.platformId))
    .leftJoin(deviceModels, eq(deviceModels.id, products.deviceModelId))
    .where(eq(products.slug, wanted))
    .get()) as ProductRow | undefined;
  if (!row || !isLive(row.status, row.publishAt, now)) return null;

  const attributes = parsed(row.attributes);
  const attrs: Json = isObject(attributes) ? attributes : {};
  const game = isObject(attrs.game) ? attrs.game : null;
  const gameDevices =
    game && Array.isArray(game.platforms) ? game.platforms.filter((entry): entry is string => typeof entry === "string" && SLUG.test(entry)).slice(0, 20) : [];
  const productVariantIds = sql`(SELECT id FROM variants WHERE product_id = ${row.id})`;

  // ── 2. everything else about it, in one batch ─────────────────────────────────────────────────
  const statements: BatchStatement[] = [
    db
      .select({
        id: variants.id,
        sku: variants.sku,
        title: variants.title,
        options: variants.options,
        priceIqd: variants.priceIqd,
        compareAtIqd: variants.compareAtIqd,
        isDefault: variants.isDefault,
      })
      .from(variants)
      .where(and(eq(variants.productId, row.id), eq(variants.isActive, true)))
      .orderBy(desc(variants.isDefault), asc(variants.sort), asc(variants.id)),
    db
      .select({
        ownerType: media.ownerType,
        ownerId: media.ownerId,
        artKey: media.artKey,
        alt: media.alt,
        isIllustration: media.isIllustration,
        storageKey: files.storageKey,
        visibility: files.visibility,
        width: files.width,
        height: files.height,
      })
      .from(media)
      .leftJoin(files, eq(files.id, media.fileId))
      .where(
        and(
          inArray(media.kind, ["image", "render"]),
          or(
            and(eq(media.ownerType, "product"), eq(media.ownerId, row.id)),
            and(eq(media.ownerType, "variant"), sql`${media.ownerId} IN ${productVariantIds}`),
          ),
        ),
      )
      .orderBy(asc(media.sort), asc(media.id)),
    batchSql(db, bundleStatement(row.id)),
    db
      .select({
        relatedId: productRelations.relatedProductId,
        kind: productRelations.kind,
      })
      .from(productRelations)
      .where(eq(productRelations.productId, row.id))
      .orderBy(desc(productRelations.pinned), asc(productRelations.sort), asc(productRelations.relatedProductId)),
    batchSql(db, trailStatement(row.categoryId)),
    // compare-at prices the store really charged: an applied price change set them (cards.server.ts previousPriceEvidence)
    batchSql(
      db,
      sql`SELECT DISTINCT pcw.variant_id, pcw.new_compare_at_iqd FROM price_changes AS pcw
        WHERE pcw.variant_id IN ${productVariantIds} AND pcw.status = 'applied' AND pcw.new_compare_at_iqd IS NOT NULL`,
    ),
  ];
  if (gameDevices.length > 0) {
    // Inside db.batch rows are mapped by column NAME: the platform's slug and name are aliased so they do not
    // overwrite the device's own (raw values come back as text, read with parsed()).
    statements.push(
      db
        .select({
          slug: deviceModels.slug,
          name: deviceModels.name,
          platformSlug: sql<string>`${platforms.slug}`.as("platform_slug"),
          platformName: sql<string>`${platforms.name}`.as("platform_name"),
          accent: sql<string>`${platforms.accent}`.as("platform_accent"),
          platformActive: sql<number>`${platforms.isActive}`.as("platform_active"),
        })
        .from(deviceModels)
        .innerJoin(platforms, eq(platforms.id, deviceModels.platformId))
        .where(inArray(deviceModels.slug, gameDevices)),
    );
  }
  const [results, settings] = await Promise.all([
    runBatch(db, statements),
    getSettings(db, ["shipping.flat_fee_iqd", "shipping.overrides_enabled", "returns.window_days"]),
  ]);
  const variantRows = results[0] as VariantRow[];
  const mediaRows = results[1] as MediaRow[];
  const bundleRows = rowsOf<BundleRow>(results[2]);
  const relationRows = results[3] as RelationRow[];
  const trailRows = rowsOf<TrailRow>(results[4]);
  const chargedRows = rowsOf<{ variant_id: string; new_compare_at_iqd: number }>(results[5]);
  const deviceRows = (gameDevices.length > 0 ? results[6] : []) as DeviceRow[];
  if (variantRows.length === 0) return null;
  const charged = new Set(chargedRows.map((entry) => `${entry.variant_id}:${Number(entry.new_compare_at_iqd)}`));

  // ── 3. stock states and related cards ─────────────────────────────────────────────────────────
  const relatedIds = [...new Set(relationRows.map((relation) => relation.relatedId).filter((id) => id !== row.id))];
  const [availability, cards] = await Promise.all([
    getAvailability(
      db,
      variantRows.map((variant) => variant.id),
    ),
    options.related === false || relatedIds.length === 0 ? Promise.resolve([]) : getCardsByIds(db, locale, relatedIds.slice(0, 60), { now }),
  ]);

  // ── shape ─────────────────────────────────────────────────────────────────────────────────────
  const name = pick(row.name, locale);
  const productGel = gelOf(row.platformAccent);
  const productReleaseAt = row.preorderReleaseAt !== null && row.preorderReleaseAt > now ? row.preorderReleaseAt : null;
  const variantNotes = isObject(attrs.variantNotes) ? attrs.variantNotes : {};
  const variantDates = isObject(attrs.variantReleaseDates) ? attrs.variantReleaseDates : {};

  const productImages: ImageRef[] = [];
  const imagesByVariant = new Map<string, ImageRef[]>();
  for (const entry of mediaRows) {
    const image = imageOf(entry, name, locale);
    if (!image) continue;
    if (entry.ownerType === "product") productImages.push(image);
    else imagesByVariant.set(entry.ownerId, [...(imagesByVariant.get(entry.ownerId) ?? []), image]);
  }

  const bundles = new Map<string, BundleComponent[]>();
  for (const component of bundleRows) {
    const componentName = text(parsed(component.name), locale) ?? component.slug;
    const variantTitle = component.variant_count > 1 ? text(parsed(component.variant_title), locale) : null;
    const entry: BundleComponent = {
      productId: component.product_id,
      slug: component.slug,
      name: componentName,
      variantTitle,
      qty: Math.max(1, Math.trunc(component.qty)),
      priceIqd: Number(component.price_iqd),
      image: imageFromJson(component.image, componentName, locale),
      linkable: isLive(component.status, component.publish_at, now),
    };
    bundles.set(component.bundle, [...(bundles.get(component.bundle) ?? []), entry]);
  }

  const titles = variantRows.map((variant) => text(parsed(variant.title), locale) ?? name);
  const labels = variantLabels(titles);
  const variantOptions = variantRows.map((variant) => {
    const raw = parsed(variant.options);
    const out: Record<string, string> = {};
    if (isObject(raw)) for (const [key, value] of Object.entries(raw)) if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
    return out;
  });

  const variantsOut: VariantDetail[] = variantRows.map((variant, index) => {
    const { model, ...options } = variantOptions[index];
    const ownDate = baghdadMidnight(typeof variantDates[variant.sku] === "string" ? (variantDates[variant.sku] as string) : null);
    const releaseAt = ownDate !== null && ownDate > now ? ownDate : productReleaseAt;
    const units = availability.get(variant.id) ?? {
      available: 0,
      state: "out_of_stock" as StockState,
    };
    const orderable = units.available > 0;
    // a demo product's stock is a placeholder: it never says "low" (no scarcity from demo data)
    const shownState: StockState = row.isDemo && units.state === "low_stock" ? "in_stock" : units.state;
    const stock: StockState = !orderable && releaseAt !== null ? "preorder" : shownState;
    const reduced = variant.compareAtIqd !== null && variant.compareAtIqd > variant.priceIqd;
    const reallyCharged = reduced && charged.has(`${variant.id}:${variant.compareAtIqd}`);
    const compareAtIqd = reduced && (reallyCharged || row.isDemo) ? variant.compareAtIqd : null;
    return {
      id: variant.id,
      sku: variant.sku,
      title: titles[index],
      label: labels[index],
      options,
      modelNumber: model ?? null,
      priceIqd: variant.priceIqd,
      compareAtIqd,
      compareAtDemo: compareAtIqd !== null && !reallyCharged,
      stock,
      orderable,
      releaseAt,
      isDefault: variant.isDefault,
      note: text(variantNotes[variant.sku], locale),
      images: imagesByVariant.get(variant.id) ?? [],
      gel: gelOfPlatformName(options.platform) ?? productGel,
      bundle: bundles.get(variant.id) ?? null,
    };
  });
  const defaultVariant = variantsOut.find((variant) => variant.isDefault) ?? variantsOut[0];

  const devices = new Map(deviceRows.map((device) => [device.slug, text(parsed(device.name), locale) ?? device.slug]));
  const specs = specsOf(row.specs, locale);
  const gameFacts = gameOf(game, specs, devices, locale);

  const platform: ProductPlatform | null =
    row.platformSlug && row.platformActive
      ? {
          slug: row.platformSlug,
          name: pick(row.platformName, locale),
          gel: productGel,
        }
      : null;
  const forPlatforms: ProductPlatform[] = [];
  if (!platform) {
    for (const slugOf of gameDevices) {
      const device = deviceRows.find((entry) => entry.slug === slugOf);
      const active = device?.platformActive === true || device?.platformActive === 1;
      if (!device || !active || forPlatforms.some((entry) => entry.slug === device.platformSlug)) continue;
      forPlatforms.push({
        slug: device.platformSlug,
        name: text(parsed(device.platformName), locale) ?? device.platformSlug,
        gel: gelOf(device.accent),
      });
    }
  }

  const catalogue = isObject(attrs.catalogue) ? attrs.catalogue : {};
  const lifecycle = asString(catalogue.status);
  const seo = parsed(row.seo);

  const allImages = [...productImages, ...variantsOut.flatMap((variant) => variant.images)];
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    // the noun alone (no device: the page names the platform beside it), the research's kind first (handheld PC, VR)
    kindLabel: kindLabelOf({ kind: row.kind, researchKind: asString(catalogue.kind), families: [] }, locale),
    name,
    // the qualifier a Latin title leaves out («نسخة الأقراص») leads the line under the name (spec §4.11)
    qualifier: qualifierOf(attrs, locale) || null,
    short: qualifiedLine(qualifierOf(attrs, locale), text(row.short, locale)),
    description: text(row.description, locale),
    brand: row.brand,
    platform,
    forPlatforms,
    categories: trailRows.map((entry) => ({
      slug: entry.slug,
      name: text(parsed(entry.name), locale) ?? entry.slug,
    })),
    deviceModel: row.modelSlug && row.modelStatus === "published" ? { slug: row.modelSlug, name: pick(row.modelName, locale) } : null,
    ageRating: row.ageRating,
    region: row.region,
    mediaFormat: row.mediaFormat,
    lifecycle: lifecycle && (LIFECYCLES as readonly string[]).includes(lifecycle) ? (lifecycle as ProductLifecycle) : null,
    releaseAt: productReleaseAt,
    isNew: productReleaseAt === null && isNewProduct({ releasedOn: asString(catalogue.releaseDate), listedAt: row.publishedAt ?? row.createdAt, isDemo: row.isDemo, now }),
    isDemo: row.isDemo,
    images: productImages,
    variants: variantsOut,
    defaultVariantId: defaultVariant.id,
    selector: selectorDimension(variantOptions.map(({ model: _model, ...rest }) => rest)),
    highlights: l10nList(attrs.highlights)
      .map((entry) => pick(entry, locale))
      .filter((entry) => entry !== ""),
    specs,
    inTheBox: l10nList(attrs.inTheBox)
      .map((entry) => pick(entry, locale))
      .filter((entry) => entry !== ""),
    game: gameFacts,
    notes: text(attrs.notes, locale),
    makerWarranty: specValue(specs, "warranty"),
    storeWarrantyMonths: row.warrantyMonths !== null && row.warrantyMonths > 0 ? row.warrantyMonths : null,
    returnsWindowDays: settings["returns.window_days"],
    delivery: {
      flatFeeIqd: settings["shipping.flat_fee_iqd"],
      overridesEnabled: settings["shipping.overrides_enabled"],
    },
    related: relatedShelves(relationRows, cards, row.id),
    credits: creditsOf(allImages),
    sources: sourcesOf(attrs.sources),
    seo: {
      title: isObject(seo) ? text(seo.title, locale) : null,
      description: isObject(seo) ? text(seo.description, locale) : null,
      noindex: isObject(seo) && seo.noindex === true,
    },
  };
}

/** Relations → shelves in editorial order; each product once (the first shelf it belongs to), never the product itself. */
function relatedShelves(relations: readonly RelationRow[], cards: readonly ProductCardData[], self: string): RelatedShelf[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const placed = new Set<string>([self]);
  const shelves = new Map<RelatedKind, RelatedShelf>();
  for (const kind of SHELF_ORDER) {
    for (const relation of relations) {
      if (SHELF_OF[relation.kind] !== kind || placed.has(relation.relatedId)) continue;
      const card = byId.get(relation.relatedId);
      if (!card) continue; // not published, or no active variant
      const shelf = shelves.get(kind) ?? { kind, items: [] };
      if (shelf.items.length >= RELATED_PER_SHELF) continue;
      shelf.items.push(card);
      shelves.set(kind, shelf);
      placed.add(relation.relatedId);
    }
  }
  return SHELF_ORDER.map((kind) => shelves.get(kind)).filter((shelf): shelf is RelatedShelf => shelf !== undefined);
}

/** Store-set components of the product's active variants, each with its first picture (variant's before product's). */
function bundleStatement(productId: string): SQL {
  return sql`
SELECT bi.bundle_variant_id AS bundle, bi.qty, v.price_iqd, v.title AS variant_title, p.id AS product_id, p.slug, p.name, p.status, p.publish_at,
  (SELECT COUNT(*) FROM variants AS vv WHERE vv.product_id = p.id AND vv.is_active = 1) AS variant_count,
  (
    SELECT json_object('a', m.art_key, 'k', CASE WHEN f.visibility = 'public' THEN f.storage_key END, 'w', f.width, 'h', f.height, 'alt', json(m.alt), 'i', m.is_illustration)
    FROM media AS m
    LEFT JOIN files AS f ON f.id = m.file_id
    WHERE m.kind IN ('image', 'render')
      AND ((m.owner_type = 'variant' AND m.owner_id = v.id) OR (m.owner_type = 'product' AND m.owner_id = p.id))
      AND (m.art_key IS NOT NULL OR (f.storage_key IS NOT NULL AND f.visibility = 'public'))
    ORDER BY CASE WHEN m.owner_type = 'variant' THEN 0 ELSE 1 END, m.sort, m.id
    LIMIT 1
  ) AS image
FROM bundle_items AS bi
JOIN variants AS v ON v.id = bi.component_variant_id
JOIN products AS p ON p.id = v.product_id
WHERE bi.bundle_variant_id IN (SELECT id FROM variants WHERE product_id = ${productId} AND is_active = 1)
ORDER BY bi.bundle_variant_id, p.slug, v.id`;
}

/** The category and its parents, top level first; inactive categories are left out (their pages do not exist). */
function trailStatement(categoryId: string | null): SQL {
  return sql`
WITH RECURSIVE trail(id, parent_id, slug, name, is_active, depth) AS (
  SELECT id, parent_id, slug, name, is_active, 0 FROM categories WHERE id = ${categoryId ?? ""}
  UNION ALL
  SELECT c.id, c.parent_id, c.slug, c.name, c.is_active, t.depth + 1 FROM categories AS c JOIN trail AS t ON c.id = t.parent_id WHERE t.depth < 8
)
SELECT slug, name, depth FROM trail WHERE is_active = 1 ORDER BY depth DESC`;
}
