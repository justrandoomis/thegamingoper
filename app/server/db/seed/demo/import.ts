/**
 * The researched catalogue (catalog/products/*.json) mapped onto the schema — everything the demo
 * seed writes about products, as plain data (no database, no clock). seedDemo() turns it into rows;
 * the tests read it to check the database against the catalogue.
 *
 * Where each catalogue fact goes:
 *   kind            products.kind (handheld PCs → console, VR → accessory; attributes.catalogue.kind keeps the research kind)
 *   platform        products.platform_id (pc_handheld → handheld; multi → none)
 *   deviceModel     products.device_model_id for the products that ARE a device (./devices.ts)
 *   specs           products.specs: { [key]: { ar, en, ckb, label: { ar, en, ckb } } } in research order
 *   highlights, inTheBox, notes, game, variant notes, variant release dates, extra barcodes, sources,
 *   unverified points
 *                   products.attributes (shape: ProductAttributes below)
 *   game.ageRating  products.age_rating "PEGI 18" (PEGI first, else "ESRB M")
 *   warranty spec   stays a spec, nothing more. products.warranty_months is the STORE's warranty: the
 *                   cart copies it to order_items and delivery opens a `warranties` row the store must
 *                   honour (orders/manage.server.ts). A maker's limited warranty (regional, often capped
 *                   by TBW) is not the store's promise, so the import leaves the column empty for the
 *                   owner's warranty policy to fill.
 *   region          products.region when every variant is for the same account/store region
 *   variants        variants (sku, title, options + `model` = the maker's model number, first barcode, default flag)
 *   images          media (art_key = photo key, kind image, is_illustration 0 — official product photos,
 *                   alt as researched); a variant that shows a different set of pictures gets its own rows
 *   compatibility   compatibility_rules on the product, status exactly as researched ("unknown" → unverified), source URL
 *   related         product_relations
 *   status, releaseDate  attributes.catalogue; a release date still ahead makes the product a pre-order
 *                   (products.preorder_release_at); discontinued products stay published, and say so
 *   variant releaseDate  attributes.variantReleaseDates; a variant that comes out later than its
 *                   product (a new colour, the PS5 version of an Xbox game) is never stocked before
 *                   that date (./pricing.ts demoStock) — the schema has no pre-order flag per variant
 * Prices, costs, deals and stock are not research: ./pricing.ts.
 */
import type { L10n } from "~/lib/locales";
import type { CompatibilityStatus, LicenseType, MediaFormat, ProductKind, ProductRelationKind, Specs } from "../../schema";
import {
  CATALOG_COMPAT_STATUSES,
  CATALOG_KINDS,
  CATALOG_PLATFORMS,
  CATALOG_RELATION_KINDS,
  CATALOG_STATUSES,
  type CatalogCompatStatus,
  type CatalogL10n,
  type CatalogProduct,
  type CatalogStatus,
  type CatalogVariant,
  type DemoCatalog,
} from "./catalog/types";
import { DEMO_CATEGORIES, categoryOf } from "./categories";
import { DEMO_DEVICE_MODELS, DEMO_GENERATIONS, DEMO_PLATFORMS, PLATFORM_OF_CATALOG, deviceModelsOfProducts, type DeviceModelSeed, type PlatformSlug } from "./devices";
import { capacityGb, demoCost, demoDeals, demoPrice, licenseTypeOf, productKindOf, releaseAtOf, type DemoCost } from "./pricing";
import { productSearchKeywords } from "./search";
import { DEMO_STORE_SETS } from "./sets";
import { t3, type T3 } from "./text";

// ───────────────────────────────────────────────────────────────── shapes

export type DemoImage = { key: string; alt: T3 };

/** `products.attributes` of a catalogue product. */
export type ProductAttributes = {
  /** The research record: group, kind and platform as researched, availability on the research date, release date. */
  catalogue: { group: string; kind: string; platform: string; status: CatalogStatus; releaseDate: string | null; family: string | null; deviceModel: string | null };
  highlights: L10n[];
  inTheBox: L10n[];
  notes: L10n | null;
  /** Games only: platforms, genres, players, online needs, age ratings, Arabic support, format, size, developer, publisher. */
  game: CatalogProduct["game"] | null;
  /** Per SKU, what the research notes about that variant. */
  variantNotes: Record<string, L10n>;
  /** Per SKU, every researched barcode when there is more than one (the variant row holds the first). */
  variantBarcodes: Record<string, string[]>;
  /** Per SKU, the release date of a variant that comes out after its product ("YYYY-MM-DD"). */
  variantReleaseDates: Record<string, string>;
  sources: CatalogProduct["sources"];
  /** What the research could not confirm. */
  unverified: string[];
};

/** A store set's attributes: what it is made of (it is not a researched product). */
export type StoreSetAttributes = { storeSet: { components: Array<{ sku: string; qty: number }> } };

export type DemoVariant = {
  sku: string;
  title: T3 | null;
  options: Record<string, string> | null;
  barcode: string | null;
  isDefault: boolean;
  sort: number;
  /** Pictures of this variant only — empty when it shows what the product gallery shows. */
  images: DemoImage[];
  priceIqd: number;
  compareAtIqd: number | null;
  /** null for a store set: its cost is its components'. */
  cost: DemoCost | null;
  /** A store set's components. */
  bundle: Array<{ sku: string; qty: number }> | null;
  /** Units are tracked one by one (consoles and handheld PCs; never a set). */
  trackSerials: boolean;
  /** The researched variant (null for a store set). */
  source: CatalogVariant | null;
};

export type DemoProduct = {
  slug: string;
  /** The researched product; null for a store set. */
  source: CatalogProduct | null;
  kind: ProductKind;
  name: T3;
  short: T3;
  description: T3;
  brand: string | null;
  platform: PlatformSlug | null;
  /** Platforms the product is for (its own, or those of the devices a multi-platform product is for). */
  platforms: PlatformSlug[];
  deviceModel: string | null;
  category: string;
  specs: Specs | null;
  attributes: ProductAttributes | StoreSetAttributes;
  warrantyMonths: number | null;
  ageRating: string | null;
  region: string | null;
  licenseType: LicenseType | null;
  mediaFormat: MediaFormat | null;
  /** Release date (midnight in Baghdad); a product is a pre-order while it lies ahead. */
  releaseAt: number | null;
  searchKeywords: T3;
  images: DemoImage[];
  variants: DemoVariant[];
  /** SKUs, model numbers and barcodes, for the search index. */
  codes: string[];
};

export type DemoDeviceModel = DeviceModelSeed & { summary: T3; specs: Specs | null; releasedOn: string | null; artKey: string | null; images: DemoImage[] };

export type DemoCompatibility = { product: string; deviceModel: string; status: CompatibilityStatus; note: T3 | null; source: string | null };

export type DemoRelation = { product: string; related: string; kind: ProductRelationKind; sort: number };

export type DemoData = {
  products: DemoProduct[];
  deviceModels: DemoDeviceModel[];
  compatibility: DemoCompatibility[];
  relations: DemoRelation[];
  /** Every variant with its product, by SKU. */
  variantsBySku: Map<string, { product: DemoProduct; variant: DemoVariant }>;
};

// ───────────────────────────────────────────────────────────────── validation

const REGION_CODES: Readonly<Record<string, string>> = { "united states": "US", us: "US", "united kingdom": "UK", uk: "UK", europe: "EU", "saudi arabia": "SA" };
const LOCALES = ["ar", "en", "ckb"] as const;

const isL10n = (value: unknown): value is CatalogL10n =>
  !!value && typeof value === "object" && LOCALES.every((locale) => typeof (value as Record<string, unknown>)[locale] === "string" && ((value as Record<string, string>)[locale] ?? "").trim() !== "");

/**
 * Checks that the catalogue can be imported as it is — before anything is written, so a research
 * edit that the seed cannot place fails with its own message instead of a foreign-key error.
 * Returns the problems found (empty = importable).
 */
export function catalogImportProblems(catalog: DemoCatalog): string[] {
  const problems: string[] = [];
  const bySlug = new Map<string, CatalogProduct>();
  const skus = new Set<string>();
  const models = new Set(DEMO_DEVICE_MODELS.map((model) => model.slug));
  const generations = new Set(DEMO_GENERATIONS.map((generation) => generation.slug));
  const platforms = new Set(DEMO_PLATFORMS.map((platform) => platform.slug));
  const categories = new Set(DEMO_CATEGORIES.map((category) => category.slug));

  for (const product of catalog.products) {
    if (bySlug.has(product.slug)) problems.push(`duplicate product slug "${product.slug}"`);
    bySlug.set(product.slug, product);
  }
  const deviceOf = deviceModelsOfProducts(catalog.products);

  for (const product of catalog.products) {
    const at = `catalog/products/${product.slug}.json`;
    if (!(CATALOG_KINDS as readonly string[]).includes(product.kind)) problems.push(`${at}: unknown kind "${product.kind}"`);
    if (!(CATALOG_PLATFORMS as readonly string[]).includes(product.platform)) problems.push(`${at}: unknown platform "${product.platform}"`);
    if (!(CATALOG_STATUSES as readonly string[]).includes(product.status)) problems.push(`${at}: unknown status "${product.status}"`);
    if (product.releaseDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(product.releaseDate)) problems.push(`${at}: releaseDate must be YYYY-MM-DD`);
    for (const field of ["name", "short", "description"] as const) if (!isL10n(product[field])) problems.push(`${at}: ${field} is not complete in ar/en/ckb`);
    try {
      if (!categories.has(categoryOf(product))) problems.push(`${at}: category "${categoryOf(product)}" does not exist`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    const model = deviceOf.get(product.slug);
    if (model && !models.has(model)) problems.push(`${at}: device model "${model}" is not in app/server/db/seed/demo/devices.ts`);
    for (const entry of product.compatibility ?? []) {
      if (!models.has(entry.deviceModel)) problems.push(`${at}: compatibility names unknown device "${entry.deviceModel}"`);
      if (!(CATALOG_COMPAT_STATUSES as readonly string[]).includes(entry.status)) problems.push(`${at}: compatibility status "${entry.status}" is not known`);
      if (entry.note !== undefined && !isL10n(entry.note)) problems.push(`${at}: compatibility note for ${entry.deviceModel} is incomplete`);
    }
    const edges = (product.compatibility ?? []).map((entry) => entry.deviceModel);
    if (new Set(edges).size !== edges.length) problems.push(`${at}: a device appears twice in compatibility`);
    for (const key of product.game?.platforms ?? []) if (!models.has(key)) problems.push(`${at}: game.platforms names unknown device "${key}"`);
    const imageKeys = new Set(product.images.map((image) => image.key));
    for (const image of product.images) {
      if (!catalog.photoKeys.has(image.key)) problems.push(`${at}: image ${image.key} has no built photo in app/art/photos (run node scripts/products/images.mjs --only ${product.slug})`);
      if (!isL10n(image.alt)) problems.push(`${at}: image ${image.key} alt is incomplete`);
    }
    if (product.images.length === 0) problems.push(`${at}: no images`);
    const specKeys = product.specs.map((spec) => spec.key);
    if (new Set(specKeys).size !== specKeys.length) problems.push(`${at}: a spec key appears twice`);
    if (product.variants.filter((variant) => variant.isDefault).length !== 1) problems.push(`${at}: needs exactly one default variant`);
    for (const variant of product.variants) {
      if (skus.has(variant.sku)) problems.push(`${at}: duplicate SKU ${variant.sku}`);
      skus.add(variant.sku);
      for (const key of variant.images ?? []) if (!imageKeys.has(key)) problems.push(`${at}: variant ${variant.sku} shows unknown image ${key}`);
      if (variant.releaseDate !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(variant.releaseDate) || Number.isNaN(Date.parse(variant.releaseDate))) problems.push(`${at}: variant ${variant.sku} releaseDate must be YYYY-MM-DD`);
        else if (product.releaseDate && variant.releaseDate <= product.releaseDate) problems.push(`${at}: variant ${variant.sku} releaseDate is not after the product's (leave it out)`);
        if (variant.isDefault) problems.push(`${at}: the default variant ${variant.sku} cannot come out after its product (move releaseDate to the product)`);
      }
    }
    for (const relation of product.related) {
      if (!bySlug.has(relation.slug)) problems.push(`${at}: related product "${relation.slug}" does not exist`);
      if (relation.slug === product.slug) problems.push(`${at}: related to itself`);
      if (!(CATALOG_RELATION_KINDS as readonly string[]).includes(relation.kind)) problems.push(`${at}: relation kind "${relation.kind}" is not known`);
    }
    const links = product.related.map((relation) => `${relation.slug}:${relation.kind}`);
    if (new Set(links).size !== links.length) problems.push(`${at}: a relation appears twice`);
  }

  // The device table and the catalogue agree.
  for (const model of DEMO_DEVICE_MODELS) {
    if (!platforms.has(model.platform) || !generations.has(model.generation)) problems.push(`device model "${model.slug}" has an unknown platform or generation`);
    if (!model.product) {
      if (!model.summary) problems.push(`device model "${model.slug}" has neither a product nor a summary`);
      continue;
    }
    const product = bySlug.get(model.product);
    if (!product) {
      problems.push(`device model "${model.slug}" takes its facts from "${model.product}", which is not in the catalogue`);
      continue;
    }
    if (model.variant ? !product.variants.some((variant) => variant.sku === model.variant) : deviceOf.get(product.slug) !== model.slug) {
      problems.push(`device model "${model.slug}": "${model.product}" is not that device`);
    }
  }
  for (const generation of DEMO_GENERATIONS) if (!platforms.has(generation.platform)) problems.push(`generation "${generation.slug}" has an unknown platform`);

  // Store sets are made of catalogue variants.
  for (const set of DEMO_STORE_SETS) {
    if (bySlug.has(set.slug)) problems.push(`store set "${set.slug}" has the slug of a catalogue product`);
    if (skus.has(set.sku)) problems.push(`store set "${set.slug}" has the SKU of a catalogue variant`);
    if (!categories.has(set.category)) problems.push(`store set "${set.slug}" has an unknown category`);
    if (set.deviceModel && !models.has(set.deviceModel)) problems.push(`store set "${set.slug}" has an unknown device model`);
    for (const component of set.components) if (!skus.has(component.sku)) problems.push(`store set "${set.slug}": component ${component.sku} is not a catalogue SKU`);
    for (const key of set.images) if (!catalog.photoKeys.has(key)) problems.push(`store set "${set.slug}": no photo ${key}`);
  }

  // Tiles.
  for (const platform of DEMO_PLATFORMS) if (platform.artKey && !catalog.photoKeys.has(platform.artKey)) problems.push(`platform "${platform.slug}": no photo ${platform.artKey}`);
  for (const category of DEMO_CATEGORIES) if (category.artKey && !catalog.photoKeys.has(category.artKey)) problems.push(`category "${category.slug}": no photo ${category.artKey}`);
  return problems;
}

export function assertCatalogImportable(catalog: DemoCatalog): void {
  const problems = catalogImportProblems(catalog);
  if (problems.length > 0) throw new Error(`Demo seed: the catalogue cannot be imported as it is:\n  ${problems.join("\n  ")}`);
}

// ───────────────────────────────────────────────────────────────── mapping

const t3Of = (value: CatalogL10n): T3 => ({ ar: value.ar, en: value.en, ckb: value.ckb });

/** The researched spec sheet, each value carrying its label. */
function specsOf(product: CatalogProduct): Specs | null {
  if (product.specs.length === 0) return null;
  const specs: Record<string, L10n & { label: L10n }> = {};
  for (const spec of product.specs) specs[spec.key] = { ...t3Of(spec.value), label: t3Of(spec.label) };
  return specs;
}

/** "PEGI 18" when PEGI rated the game, else "ESRB M". */
const ageRatingOf = (product: CatalogProduct): string | null => {
  const rating = product.game?.ageRating;
  if (rating?.pegi !== undefined) return `PEGI ${rating.pegi}`;
  if (rating?.esrb) return `ESRB ${rating.esrb}`;
  return null;
};

const regionOf = (product: CatalogProduct): string | null => {
  const regions = new Set(product.variants.map((variant) => variant.options?.region?.toLowerCase() ?? ""));
  if (regions.size !== 1) return null;
  const [region] = [...regions];
  return region ? (REGION_CODES[region] ?? null) : null;
};

const mediaFormatOf = (product: CatalogProduct): MediaFormat | null => (product.kind === "game" ? "physical" : product.kind === "digital" ? "digital" : null);

/** Which store platforms a product is for: its own, or — sold for several — those of the devices it lists. */
function platformsOf(product: CatalogProduct): PlatformSlug[] {
  const own = PLATFORM_OF_CATALOG[product.platform];
  if (own) return [own];
  const keys = product.game?.platforms ?? (product.compatibility ?? []).filter((entry) => entry.status === "verified" || entry.status === "partial").map((entry) => entry.deviceModel);
  const found = new Set<PlatformSlug>();
  for (const key of keys) {
    const model = DEMO_DEVICE_MODELS.find((entry) => entry.slug === key);
    if (model && model.platform !== "pc") found.add(model.platform);
  }
  return [...found];
}

/** A variant's options as stored: the researched options, plus the maker's model number. */
const optionsOf = (variant: CatalogVariant): Record<string, string> | null => {
  const options = { ...(variant.options ?? {}), ...(variant.modelNumber ? { model: variant.modelNumber } : {}) };
  return Object.keys(options).length > 0 ? options : null;
};

const imageOf = (product: CatalogProduct, key: string): DemoImage => {
  const image = product.images.find((entry) => entry.key === key);
  if (!image) throw new Error(`Demo seed: ${product.slug} has no image ${key}`);
  return { key, alt: t3Of(image.alt) };
};

/** Pictures specific to a variant: its own list, unless it is simply the whole product gallery. */
function variantImagesOf(product: CatalogProduct, variant: CatalogVariant): DemoImage[] {
  const keys = variant.images ?? [];
  if (keys.length === 0 || keys.join("|") === product.images.map((image) => image.key).join("|")) return [];
  return keys.map((key) => imageOf(product, key));
}

function attributesOf(product: CatalogProduct, deviceModel: string | null): ProductAttributes {
  const variantNotes: Record<string, L10n> = {};
  const variantBarcodes: Record<string, string[]> = {};
  const variantReleaseDates: Record<string, string> = {};
  for (const variant of product.variants) {
    if (variant.notes) variantNotes[variant.sku] = t3Of(variant.notes);
    if ((variant.barcodes?.length ?? 0) > 1) variantBarcodes[variant.sku] = [...(variant.barcodes ?? [])];
    if (variant.releaseDate) variantReleaseDates[variant.sku] = variant.releaseDate;
  }
  return {
    catalogue: { group: product.group, kind: product.kind, platform: product.platform, status: product.status, releaseDate: product.releaseDate ?? null, family: product.family ?? null, deviceModel },
    highlights: product.highlights.map(t3Of),
    inTheBox: (product.inTheBox ?? []).map(t3Of),
    notes: product.notes ? t3Of(product.notes) : null,
    game: product.game ?? null,
    variantNotes,
    variantBarcodes,
    variantReleaseDates,
    sources: product.sources,
    unverified: product.verification.unverified ?? [],
  };
}

function productOf(product: CatalogProduct, deviceModel: string | null, deals: ReadonlyMap<string, number>): DemoProduct {
  const kind = productKindOf(product.kind);
  const platforms = platformsOf(product);
  const variants = product.variants.map((variant, index): DemoVariant => {
    const priceIqd = demoPrice(product, variant);
    return {
      sku: variant.sku,
      title: t3Of(variant.title),
      options: optionsOf(variant),
      barcode: variant.barcodes?.[0] ?? null,
      isDefault: variant.isDefault,
      sort: index,
      images: variantImagesOf(product, variant),
      priceIqd,
      compareAtIqd: deals.get(variant.sku) ?? null,
      cost: demoCost(kind, variant.sku, priceIqd),
      bundle: null,
      trackSerials: kind === "console",
      source: variant,
    };
  });
  return {
    slug: product.slug,
    source: product,
    kind,
    name: t3Of(product.name),
    short: t3Of(product.short),
    description: t3Of(product.description),
    brand: product.brand,
    platform: PLATFORM_OF_CATALOG[product.platform],
    platforms,
    deviceModel,
    category: categoryOf(product),
    specs: specsOf(product),
    attributes: attributesOf(product, deviceModel),
    // The store's warranty, not the maker's (see the header): the owner's policy sets it.
    warrantyMonths: null,
    ageRating: ageRatingOf(product),
    region: regionOf(product),
    licenseType: licenseTypeOf(product),
    mediaFormat: mediaFormatOf(product),
    releaseAt: releaseAtOf(product),
    searchKeywords: productSearchKeywords({ slug: product.slug, kind, platforms }),
    images: product.images.map((image) => ({ key: image.key, alt: t3Of(image.alt) })),
    variants,
    codes: [...new Set(product.variants.flatMap((variant) => [variant.sku, variant.modelNumber, ...(variant.barcodes ?? [])]).filter((code): code is string => !!code))],
  };
}

/** A store set: priced 3–5 % below its components bought one by one. */
function storeSetOf(set: (typeof DEMO_STORE_SETS)[number], catalogue: ReadonlyMap<string, { product: CatalogProduct; variant: CatalogVariant }>, photoAlt: (key: string) => T3): DemoProduct {
  const separately = set.components.reduce((sum, component) => {
    const found = catalogue.get(component.sku);
    if (!found) throw new Error(`Demo seed: store set ${set.slug} needs ${component.sku}`);
    return sum + demoPrice(found.product, found.variant) * component.qty;
  }, 0);
  const priceIqd = Math.round((separately * 0.96) / 250) * 250;
  return {
    slug: set.slug,
    source: null,
    kind: "bundle",
    name: set.name,
    short: set.short,
    description: set.description,
    brand: null,
    platform: set.platform,
    platforms: [set.platform],
    deviceModel: set.deviceModel,
    category: set.category,
    specs: null,
    attributes: { storeSet: { components: set.components.map((component) => ({ ...component })) } },
    warrantyMonths: null,
    ageRating: null,
    region: null,
    licenseType: null,
    mediaFormat: null,
    releaseAt: null,
    searchKeywords: productSearchKeywords({ slug: set.slug, kind: "bundle", platforms: [set.platform], extra: set.keywords }),
    images: set.images.map((key) => ({ key, alt: photoAlt(key) })),
    variants: [
      {
        sku: set.sku,
        title: null,
        options: null,
        barcode: null,
        isDefault: true,
        sort: 0,
        images: [],
        priceIqd,
        compareAtIqd: null,
        cost: null,
        bundle: set.components.map((component) => ({ ...component })),
        trackSerials: false,
        source: null,
      },
    ],
    codes: [set.sku],
  };
}

function deviceModelOf(model: DeviceModelSeed, bySlug: ReadonlyMap<string, CatalogProduct>): DemoDeviceModel {
  const product = model.product ? bySlug.get(model.product) : undefined;
  if (!product) return { ...model, summary: model.summary ?? model.name, specs: null, releasedOn: null, artKey: null, images: [] };
  const variant = model.variant ? product.variants.find((entry) => entry.sku === model.variant) : undefined;
  // The device's own pictures: the variant's when the model is one variant, the product's otherwise — device shots only.
  const keys = variant?.images?.length ? variant.images : product.images.map((image) => image.key);
  const deviceShots = keys.filter((key) => ["hero", "angle", "detail"].includes(product.images.find((image) => image.key === key)?.kind ?? ""));
  const images = (deviceShots.length > 0 ? deviceShots : keys).slice(0, 4).map((key) => imageOf(product, key));
  return {
    ...model,
    summary: variant ? t3Of(variant.title) : t3Of(product.short),
    specs: specsOf(product),
    releasedOn: product.releaseDate ?? null,
    artKey: images[0]?.key ?? null,
    images,
  };
}

/** Exactly as researched; "unknown" is stored as "unverified" — never as anything better. */
const compatStatus = (status: CatalogCompatStatus): CompatibilityStatus => (status === "unknown" ? "unverified" : status);

/** Everything the seed writes about the catalogue, derived from it. Throws when the catalogue cannot be imported. */
export function buildDemoData(catalog: DemoCatalog): DemoData {
  assertCatalogImportable(catalog);
  const bySlug = new Map(catalog.products.map((product) => [product.slug, product]));
  const deviceOf = deviceModelsOfProducts(catalog.products);
  const deals = demoDeals(catalog.products);
  const catalogueVariants = new Map(catalog.products.flatMap((product) => product.variants.map((variant) => [variant.sku, { product, variant }] as const)));
  const photoAlt = (key: string): T3 => {
    for (const product of catalog.products) {
      const image = product.images.find((entry) => entry.key === key);
      if (image) return t3Of(image.alt);
    }
    return t3("", "", "");
  };

  const products = [...catalog.products.map((product) => productOf(product, deviceOf.get(product.slug) ?? null, deals)), ...DEMO_STORE_SETS.map((set) => storeSetOf(set, catalogueVariants, photoAlt))];
  const variantsBySku = new Map<string, { product: DemoProduct; variant: DemoVariant }>();
  for (const product of products) for (const variant of product.variants) variantsBySku.set(variant.sku, { product, variant });

  const compatibility: DemoCompatibility[] = catalog.products.flatMap((product) =>
    (product.compatibility ?? []).map((entry) => ({
      product: product.slug,
      deviceModel: entry.deviceModel,
      status: compatStatus(entry.status),
      note: entry.note ? t3Of(entry.note) : null,
      source: entry.source ?? null,
    })),
  );
  const relations: DemoRelation[] = catalog.products.flatMap((product) => product.related.map((relation, index) => ({ product: product.slug, related: relation.slug, kind: relation.kind, sort: index })));

  return { products, deviceModels: DEMO_DEVICE_MODELS.map((model) => deviceModelOf(model, bySlug)), compatibility, relations, variantsBySku };
}

/** Capacity of a variant in GB (re-exported for the tests' ordering checks). */
export { capacityGb };
