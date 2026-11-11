/**
 * The researched product catalogue (catalog/products/<slug>.json, shape in catalog/README.md) as the
 * demo seed reads it. These are the facts the research agents recorded, with their sources; the seed
 * maps them onto the schema and adds only what research does not cover (demo prices, costs, stock).
 *
 * Types only. The files are read by Node code (seed scripts and tests) through ./load.ts; nothing
 * here imports them, so the catalogue never ends up in the Worker or client bundle.
 */

/** Every catalogue text exists in Arabic, English and Kurdish (Sorani) — the validator enforces it. */
export type CatalogL10n = { ar: string; en: string; ckb: string };

export const CATALOG_KINDS = ["console", "handheld_pc", "game", "controller", "headset", "storage", "accessory", "vr", "digital"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const CATALOG_PLATFORMS = ["nintendo", "playstation", "xbox", "pc_handheld", "multi"] as const;
export type CatalogPlatform = (typeof CATALOG_PLATFORMS)[number];

/** Availability on the research date: preorder = date announced and orders open; upcoming = announced, no orders. */
export const CATALOG_STATUSES = ["available", "preorder", "upcoming", "discontinued", "limited"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

/** "unknown" is not written by the current research but is read as "unverified" — never as a better status. */
export const CATALOG_COMPAT_STATUSES = ["verified", "partial", "incompatible", "unverified", "unknown"] as const;
export type CatalogCompatStatus = (typeof CATALOG_COMPAT_STATUSES)[number];

export const CATALOG_RELATION_KINDS = ["setup", "accessory", "upsell", "alternative"] as const;
export type CatalogRelationKind = (typeof CATALOG_RELATION_KINDS)[number];

export type CatalogImageKind = "hero" | "angle" | "detail" | "in-box" | "box-art" | "screenshot";

export type CatalogSpec = { key: string; label: CatalogL10n; value: CatalogL10n };

export type CatalogVariant = {
  sku: string;
  title: CatalogL10n;
  options?: Record<string, string>;
  modelNumber?: string;
  barcodes?: string[];
  /**
   * "YYYY-MM-DD", only for a variant that comes out after its product (a new colour, a later
   * platform version): until then it is a pre-order and the demo seed never stocks it.
   */
  releaseDate?: string;
  isDefault: boolean;
  /** Keys of the product's images that show this variant. */
  images?: string[];
  notes?: CatalogL10n;
};

export type CatalogGame = {
  /** Device models the game exists for (digital or physical) — not a compatibility statement of the box. */
  platforms: string[];
  genres: CatalogL10n[];
  players: string;
  online: CatalogL10n;
  ageRating: { pegi?: number; esrb?: string };
  arabic: "voice+subtitles+interface" | "subtitles+interface" | "interface" | "none" | "unknown";
  physicalFormat?: "cartridge" | "game-key-card" | "disc" | "code-in-box";
  sizeGb?: number;
  developer?: string;
  publisher: string;
};

export type CatalogCompatibility = { deviceModel: string; status: CatalogCompatStatus; note?: CatalogL10n; source?: string };

export type CatalogImage = {
  /** "<slug>--<n>" — also the photo key of app/art/photos and `media.art_key`. */
  key: string;
  file: string;
  sourceUrl: string;
  sourcePage?: string;
  kind: CatalogImageKind;
  alt: CatalogL10n;
  credit: string;
  width?: number;
  height?: number;
  transparent?: boolean;
};

export type CatalogSource = { url: string; title?: string; publisher?: string; retrieved?: string; supports?: string };

export type CatalogProduct = {
  slug: string;
  group: string;
  kind: CatalogKind;
  platform: CatalogPlatform;
  brand: string;
  /** Consoles and handhelds: the device this product IS. */
  deviceModel?: string;
  /** Editions of the same device share a family. */
  family?: string;
  status: CatalogStatus;
  /** "YYYY-MM-DD" of the first release of this product or edition. */
  releaseDate?: string;
  name: CatalogL10n;
  short: CatalogL10n;
  description: CatalogL10n;
  highlights: CatalogL10n[];
  specs: CatalogSpec[];
  inTheBox?: CatalogL10n[];
  variants: CatalogVariant[];
  game?: CatalogGame;
  compatibility?: CatalogCompatibility[];
  related: Array<{ slug: string; kind: CatalogRelationKind }>;
  images: CatalogImage[];
  sources: CatalogSource[];
  notes?: CatalogL10n;
  verification: { checkedBy?: string; secondSource?: boolean; unverified?: string[] };
};

/** What the demo seed imports: the researched products, and the photo keys built for them (app/art/photos). */
export type DemoCatalog = {
  products: readonly CatalogProduct[];
  /** Keys "<slug>--<n>" that have a built photo manifest. */
  photoKeys: ReadonlySet<string>;
};
