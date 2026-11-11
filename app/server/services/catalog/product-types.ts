/**
 * Product detail — the view model of /p/:slug and of the quick-preview sheet (docs/CONTRACTS.md §3, row "product").
 * Client-safe: types and pure helpers only, so components import it directly. Built on the server by
 * getProductDetail() in ./product.server.ts.
 *
 *   const product = await getProductDetail(db, ctx.locale, params.slug, { now: ctx.now });   // ProductDetail | null
 *   const variant = selectVariant(product, url.searchParams.get("v"));                         // ?v=<sku>, else the default
 *
 * What it says — never more than the shop knows:
 *   · Prices are integer IQD; `compareAtIqd` only for a genuine reduction (above the price).
 *   · Stock is a STATE per variant, never a number. `orderable` is exactly what the commerce core's addToCart accepts
 *     (active variant of a sellable product with units available) — the page offers nothing else.
 *   · A release date still ahead (the product's pre-order date, or a variant that comes out later) is a date, said
 *     plainly; the store takes no pre-orders through the cart (nothing is stocked before release).
 *   · Warranty: `storeWarrantyMonths` is the STORE's warranty (products.warranty_months — empty until the owner sets
 *     a policy, docs/STATUS.md open item 15); `makerWarranty` is the manufacturer's terms from the researched specs and
 *     is shown only as the maker's.
 *   · Reviews are not part of this model: getReviewSummary() (~/server/services/reviews.server) counts approved,
 *     verified-purchase reviews only.
 *   · Compatibility statuses belong to the devices area (getCompatibilityForProduct) and are wired by the integration
 *     pass — nothing here infers compatibility.
 */
import type { ImageRef, ProductCardData, ProductKind, StockState } from "~/lib/dto";

/** Platform light of the stage (the four platforms the design system knows). */
export type ProductGel = "nintendo" | "playstation" | "xbox" | "handheld";

export type ProductPlatform = {
  slug: string;
  name: string;
  gel: ProductGel | null;
};

/** Availability on the research date, as the catalogue recorded it (attributes.catalogue.status). */
export type ProductLifecycle = "available" | "preorder" | "upcoming" | "discontinued" | "limited";

export type VariantDetail = {
  id: string;
  sku: string;
  /** Full localized title ("DualSense – أبيض"); the product name when the variant has none. */
  title: string;
  /** Short selector label: the title without the leading words every variant of the product shares. */
  label: string;
  /** Option values as stored (`{ color: "White" }`), without the maker's model number. */
  options: Record<string, string>;
  /** The maker's model number (options.model), e.g. "CFI-2016". */
  modelNumber: string | null;
  priceIqd: number;
  /**
   * The previous price to strike: above the price AND really charged (an applied price change set it), or a demo
   * row's demo value (`compareAtDemo`). Else null — exactly the rule of the cards (cards.server.ts).
   */
  compareAtIqd: number | null;
  /** `compareAtIqd` is a demo value: strike it only under the demo marking, never word it as a saving. */
  compareAtDemo?: boolean;
  /**
   * in_stock · low_stock · out_of_stock — or preorder: not out yet and nothing in stock. Never a number. A demo
   * product never says low_stock (its stock is a placeholder).
   */
  stock: StockState;
  /** The cart accepts it now (active, sellable product, units available). */
  orderable: boolean;
  /** Epoch ms (00:00 Baghdad) of a release still ahead — this variant's own date, else the product's pre-order date. */
  releaseAt: number | null;
  isDefault: boolean;
  /** What the research notes about this variant (localized). */
  note: string | null;
  /** Pictures of this variant only; empty when it shows the product gallery. */
  images: ImageRef[];
  /** Stage light for this variant: its platform option ("PS5" → playstation), else the product's. */
  gel: ProductGel | null;
  /**
   * A store set (bundle_items): what this variant is made of. Null for everything else — a catalogue bundle (a
   * console with a download code, …) lists its contents in `inTheBox` and the specs.
   */
  bundle: BundleComponent[] | null;
};

/** Option keys a selector can be named after (one varying key); "version" when several vary. */
export const SELECTOR_DIMENSIONS = [
  "color",
  "storage",
  "edition",
  "platform",
  "format",
  "value",
  "region",
  "tier",
  "duration",
  "memory",
  "chip",
  "os",
  "heatsink",
  "currency",
  "extras",
  "battery",
  "quantity",
  "version",
] as const;
export type SelectorDimension = (typeof SELECTOR_DIMENSIONS)[number];

export type SpecRow = { key: string; label: string; value: string };

export type GameFormat = "cartridge" | "game-key-card" | "disc" | "code-in-box";
export type ArabicSupport = "voice+subtitles+interface" | "subtitles+interface" | "interface" | "none" | "unknown";

/** Game facts (attributes.game), localized where the research is; Latin names stay as they are. */
export type GameFacts = {
  /** Devices the game exists for (device models, in the research's order). */
  platforms: { slug: string; name: string }[];
  genres: string[];
  format: GameFormat | null;
  /** Download / install size in GB as researched. */
  sizeGb: number | null;
  /** Localized players line (the researched "players" spec), when there is one. */
  players: string | null;
  /** Online requirement, localized. */
  online: string | null;
  arabic: ArabicSupport;
  ageRating: { pegi: number | null; esrb: string | null };
  developer: string | null;
  publisher: string | null;
};

/** One component of a store set (variants with bundle_items) — what the set is made of. */
export type BundleComponent = {
  productId: string;
  slug: string;
  name: string;
  /** The component variant's title when the product has several. */
  variantTitle: string | null;
  qty: number;
  image: ImageRef;
  /** The component's product page is live (published) — link to it only then. */
  linkable: boolean;
};

export type RelatedKind = "setup" | "accessory" | "alternative";
/** Editorial relations (product_relations) as shelves: setup (+ upsell, upgrade), accessories, alternatives. */
export type RelatedShelf = { kind: RelatedKind; items: ProductCardData[] };

/** Who owns the pictures shown (photo manifests), with the page they came from. */
export type ImageCredit = { owner: string; page: string | null };
export type SourceLink = {
  url: string;
  title: string | null;
  publisher: string | null;
};

export type ProductDetail = {
  id: string;
  slug: string;
  kind: ProductKind;
  name: string;
  /** One line under the name. */
  short: string | null;
  description: string | null;
  brand: string | null;
  /** The product's own platform; null for products sold for several platforms. */
  platform: ProductPlatform | null;
  /** Platforms a multi-platform product is for (from its game platforms); empty when `platform` is set. */
  forPlatforms: ProductPlatform[];
  /** Category trail from the top level down to the product's category. */
  categories: { slug: string; name: string }[];
  /** The device this product IS (consoles, handhelds) — the devices area links its hub. */
  deviceModel: { slug: string; name: string } | null;
  ageRating: string | null;
  region: string | null;
  mediaFormat: "physical" | "digital" | null;
  lifecycle: ProductLifecycle | null;
  /** Epoch ms of the product's release while it is still ahead (pre-order date), else null. */
  releaseAt: number | null;
  /** Released, or really listed, within the last 30 days — the only «جديد» (card-facts.ts isNewProduct). */
  isNew?: boolean;
  isDemo: boolean;
  /** The product gallery (variant pictures are on the variants). */
  images: ImageRef[];
  variants: VariantDetail[];
  defaultVariantId: string;
  /** What the selector chooses: the one option that varies, or "version". Null with a single variant. */
  selector: SelectorDimension | null;
  highlights: string[];
  specs: SpecRow[];
  inTheBox: string[];
  game: GameFacts | null;
  notes: string | null;
  /** The manufacturer's warranty terms from the specs — the maker's, not a store promise. */
  makerWarranty: string | null;
  /** The store's own warranty (products.warranty_months); null until the owner decides it. */
  storeWarrantyMonths: number | null;
  /** Settings `returns.window_days`. */
  returnsWindowDays: number;
  /** Settings `shipping.*`: the flat fee, and whether per-governorate overrides are switched on. */
  delivery: { flatFeeIqd: number; overridesEnabled: boolean };
  related: RelatedShelf[];
  credits: ImageCredit[];
  sources: SourceLink[];
  /** SEO overrides an editor set (products.seo). */
  seo: { title: string | null; description: string | null; noindex: boolean };
};

/** Reviews as shoppers see them (getReviewSummary in ~/server/services/reviews.server): approved, verified purchases only. */
export type ReviewSummary = {
  /** Approved reviews from verified purchases. */
  count: number;
  /** Mean rating, one decimal; null when there are none. */
  average: number | null;
  /** How many reviews gave 1, 2, 3, 4 and 5 stars (index 0 = one star). */
  distribution: [number, number, number, number, number];
};

export type VerifiedReview = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  createdAt: number;
  /** The language the review was written in, when known ("ar", "en", "ckb"). */
  locale: string | null;
};

/** What the quick-preview sheet needs — the essentials of a ProductDetail. */
export type ProductPreview = Pick<
  ProductDetail,
  | "id"
  | "slug"
  | "kind"
  | "name"
  | "short"
  | "platform"
  | "forPlatforms"
  | "lifecycle"
  | "releaseAt"
  | "isDemo"
  | "images"
  | "variants"
  | "defaultVariantId"
  | "selector"
  | "delivery"
  | "storeWarrantyMonths"
  | "makerWarranty"
  | "returnsWindowDays"
> & { highlights: string[] };

export function toProductPreview(detail: ProductDetail): ProductPreview {
  return {
    id: detail.id,
    slug: detail.slug,
    kind: detail.kind,
    name: detail.name,
    short: detail.short,
    platform: detail.platform,
    forPlatforms: detail.forPlatforms,
    lifecycle: detail.lifecycle,
    releaseAt: detail.releaseAt,
    isDemo: detail.isDemo,
    images: detail.images,
    variants: detail.variants,
    defaultVariantId: detail.defaultVariantId,
    selector: detail.selector,
    delivery: detail.delivery,
    storeWarrantyMonths: detail.storeWarrantyMonths,
    makerWarranty: detail.makerWarranty,
    returnsWindowDays: detail.returnsWindowDays,
    highlights: detail.highlights.slice(0, 3),
  };
}

// ───────────────────────────────────────────────────────────────── pure helpers

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The variant `?v=<sku>` names (any letter case), else the default one. */
export function selectVariant<T extends { variants: VariantDetail[]; defaultVariantId: string }>(product: T, sku: string | null | undefined): VariantDetail {
  const wanted = typeof sku === "string" && SKU.test(sku.trim()) ? sku.trim().toUpperCase() : null;
  const byQuery = wanted ? product.variants.find((variant) => variant.sku.toUpperCase() === wanted) : undefined;
  return byQuery ?? product.variants.find((variant) => variant.id === product.defaultVariantId) ?? product.variants[0];
}

/** "PS5" → playstation, "Xbox Series X" → xbox, "Nintendo Switch 2" → nintendo; anything else → null. */
export function gelOfPlatformName(value: string | null | undefined): ProductGel | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (/\bps[1-5]\b|playstation/.test(text)) return "playstation";
  if (/xbox/.test(text)) return "xbox";
  if (/switch|nintendo/.test(text)) return "nintendo";
  return null;
}

/** Separators a shared title prefix may end on ("DualSense – أبيض" → "أبيض"). */
const LEAD = /^[\s\-–—·:,،|/]+/u;

/**
 * Short labels for a set of variant titles: the words every title starts with are dropped ("DualSense – أبيض",
 * "DualSense – أسود Midnight Black" → "أبيض", "أسود Midnight Black"). A title that would become empty, or titles that
 * share nothing, keep their full text.
 */
export function variantLabels(titles: readonly string[]): string[] {
  if (titles.length < 2) return titles.map((title) => title.trim());
  const words = titles.map((title) => title.trim().split(/\s+/u));
  let shared = 0;
  const shortest = Math.min(...words.map((list) => list.length));
  while (shared < shortest && words.every((list) => list[shared] === words[0][shared])) shared++;
  return words.map((list, index) => {
    if (shared === 0) return titles[index].trim();
    const rest = list.slice(shared).join(" ").replace(LEAD, "").trim();
    // "with Windows 11, …" after "Legion Go S" was dropped → "With Windows 11, …"
    return rest.length > 0 ? rest.charAt(0).toLocaleUpperCase("en") + rest.slice(1) : titles[index].trim();
  });
}

/**
 * Which option the selector chooses: the one key whose values differ between variants (ignoring the maker's model
 * number); "version" when several differ, or none does although there are several variants. Null for one variant.
 */
export function selectorDimension(options: readonly Record<string, string>[]): SelectorDimension | null {
  if (options.length < 2) return null;
  const keys = new Set(options.flatMap((entry) => Object.keys(entry)));
  keys.delete("model");
  const named = (key: string | undefined): SelectorDimension => (key && (SELECTOR_DIMENSIONS as readonly string[]).includes(key) ? (key as SelectorDimension) : "version");
  const varying = [...keys].filter((key) => new Set(options.map((entry) => entry[key] ?? "")).size > 1);
  if (varying.length === 1) return named(varying[0]);
  // Several vary, but one of them names every variant on its own and the others are extras some variants carry
  // (DualSense: every colour is different; only the Prism ones add an edition) — the choice is that one.
  const everywhere = varying.filter((key) => options.every((entry) => entry[key] !== undefined));
  const identifying = everywhere.filter((key) => new Set(options.map((entry) => entry[key])).size === options.length);
  if (everywhere.length === 1 && identifying.length === 1) return named(identifying[0]);
  return "version";
}

/** "YYYY-MM-DD" → epoch ms of 00:00 in Baghdad (UTC+3, no daylight saving); null for anything else. */
export function baghdadMidnight(date: string | null | undefined): number | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? ms - 3 * 60 * 60 * 1000 : null;
}

/**
 * The pictures a variant's gallery shows (DESIGN.md §12: the product gallery leads with exactly the default edition):
 *   · its own pictures;
 *   · the default variant, or any variant while no variant has pictures of its own: the product gallery;
 *   · another variant without pictures while its siblings have some: the default variant's pictures (else the
 *     product gallery) — `borrowed` is true and `from` names whose pictures they are, so the page can say so.
 */
export function galleryFor(
  product: {
    images: ImageRef[];
    variants: VariantDetail[];
    defaultVariantId: string;
  },
  variant: VariantDetail,
): { images: ImageRef[]; borrowed: boolean; from: VariantDetail | null } {
  if (variant.images.length > 0) return { images: variant.images, borrowed: false, from: null };
  if (variant.id === product.defaultVariantId || !product.variants.some((entry) => entry.images.length > 0))
    return { images: product.images, borrowed: false, from: null };
  const fallback = product.variants.find((entry) => entry.id === product.defaultVariantId) ?? null;
  return {
    images: fallback && fallback.images.length > 0 ? fallback.images : product.images,
    borrowed: true,
    from: fallback,
  };
}
