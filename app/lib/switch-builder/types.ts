/**
 * Switch bundle builder — shared, client-safe types (contract: docs/switch-builder.md).
 *
 * Three kinds of data meet in the builder:
 *  - the OPEN game list (`LibraryGame`, `GameDetails`): Nintendo Switch 1 games from Wikidata (CC0) and
 *    Wikipedia extracts (CC BY-SA 4.0, shown with attribution), shipped as static files under public/library/switch/;
 *  - TamTam's OWN per-game data (`LibraryExtras`): sizes, prices, trailers, pictures, descriptions and licensed
 *    scores that staff enter in /admin/catalog/switch-library (D1 table switch_library_entries);
 *  - the store's CATALOGUE (consoles, memory cards, cartridges, eShop cards), read by the builder's server module.
 *
 * Nothing in these shapes comes from nintendo.com, its regional stores, assets.nintendo.com or metacritic.com.
 */

/** A Nintendo US store product slug, e.g. "hades-switch" — the library's stable key (Wikidata P8084). */
export type LibraryGameId = string;

/** Display genres the builder filters by (Wikidata P136 values are mapped onto these). */
export const GENRE_KEYS = [
  "action",
  "adventure",
  "platformer",
  "rpg",
  "puzzle",
  "racing",
  "sports",
  "fighting",
  "shooter",
  "simulation",
  "strategy",
  "party",
  "music",
  "horror",
  "other",
] as const;
export type GenreKey = (typeof GENRE_KEYS)[number];

/** Play modes (Wikidata P404 values are mapped onto these). */
export const PLAY_MODES = ["single", "multi", "coop", "online"] as const;
export type PlayMode = (typeof PLAY_MODES)[number];

/** One game of the open list — kept small: ~4,900 of these load on the client. */
export interface LibraryGame {
  id: LibraryGameId;
  /** Wikidata item id, e.g. "Q55584563". */
  qid: string;
  /** English (or "mul") label from Wikidata — the official Latin title. */
  title: string;
  /** Arabic label, when Wikidata has one. */
  titleAr?: string;
  /** Sorani label, when Wikidata has one. */
  titleCkb?: string;
  /** Release year on Switch when known, else the first publication year. */
  year?: number;
  /** ISO date (YYYY-MM-DD) of the Switch release when Wikidata qualifies one, else the first publication date. */
  released?: string;
  publishers: string[];
  genres: GenreKey[];
  modes: PlayMode[];
  /** Number of Wikipedia language editions with an article (Wikidata sitelinks) — the "popular" sort. */
  popularity: number;
  /** Index of the details chunk that holds this game's GameDetails (see LibraryList.chunks). */
  chunk: number;
  /** Metacritic game slug from Wikidata (P12054) — for a plain "see on Metacritic" link, never a score. */
  metacriticSlug?: string;
  /** Extra search terms: aliases (en/ar), series names. */
  aliases?: string[];
}

/** Longer, lazily loaded facts for the details sheet. */
export interface GameDetails {
  id: LibraryGameId;
  developers: string[];
  series?: string[];
  /** OpenCritic id (Wikidata P2864) — for a plain link. */
  opencriticId?: string;
  /** Wikipedia lead extracts. Shown only with their attribution line and link (CC BY-SA 4.0). */
  wikipedia?: Partial<Record<"en" | "ar" | "ckb", WikipediaExtract>>;
}

export interface WikipediaExtract {
  /** Plain text lead (no markup), at most ~900 characters, cut at a sentence end. */
  text: string;
  /** Article title as on Wikipedia. */
  title: string;
  /** Canonical article URL. */
  url: string;
  /** ISO date the extract was fetched. */
  asOf: string;
}

/** The static list file: public/library/switch/list.<hash>.json. */
export interface LibraryList {
  version: 1;
  /** ISO date of the Wikidata snapshot. */
  asOf: string;
  /** Licence/attribution lines the page shows in its footer note. */
  sources: { wikidata: string; wikipedia: string };
  /** File names (no path) of the details chunks, by chunk index: public/library/switch/d/<name>. */
  chunks: string[];
  games: LibraryGame[];
}

/** One details chunk: public/library/switch/d/<n>.<hash>.json. */
export interface LibraryChunk {
  version: 1;
  details: Record<LibraryGameId, GameDetails>;
}

/** TamTam's own data for one game (admin-entered; every field optional). */
export interface LibraryExtras {
  /** Full installed size of the DIGITAL game in bytes: base + latest update, no DLC (measured by TamTam). */
  sizeBytes?: number;
  /** Space a CARTRIDGE copy needs on the console in bytes (updates + DLC data). */
  cartridgeBytes?: number;
  /** ISO date the sizes were measured. */
  sizeAsOf?: string;
  /** Nintendo eShop (US) price in US cents, as checked by staff. */
  priceUsdCents?: number;
  priceAsOf?: string;
  /** YouTube video id of an official trailer (embedded only after the shopper taps play). */
  trailerYouTubeId?: string;
  /** Public media key of a picture TamTam uploaded (served at /media/<key>). */
  imageKey?: string;
  imageWidth?: number;
  imageHeight?: number;
  /** TamTam's own short description. */
  description?: Partial<Record<"ar" | "en" | "ckb", string>>;
  /** A Metacritic score — entered only when TamTam holds the Metacritic licence; shown with its source and date. */
  metacritic?: { score: number; reviews: number; asOf: string };
  /** Hidden from the builder (e.g. delisted). */
  hidden?: boolean;
}

/** GET /api/switch-library — TamTam's data for the builder. */
export interface LibraryExtrasPayload {
  /** Changes whenever staff save; lets clients drop a stale copy. */
  rev: string;
  extras: Record<LibraryGameId, LibraryExtras>;
  capacity: CapacityConfig;
}

/** Switch 1 models the builder plans for (device_models slugs). */
export const SWITCH_MODELS = ["switch-oled", "switch", "switch-lite"] as const;
export type SwitchModel = (typeof SWITCH_MODELS)[number];

/** Card sizes offered, by their LABEL in decimal GB (1000 = 1TB). 0 = no card. */
export const CARD_SIZES = [0, 64, 128, 256, 512, 1000] as const;
export type CardSize = (typeof CARD_SIZES)[number];

/** Planner constants; defaults in ./storage.ts, overridable by the setting `builder.switch.capacity`. */
export interface CapacityConfig {
  /** Space the console shows as usable in system memory, in GiB ("GB" on the console), by model. */
  internalUsableGiB: Record<SwitchModel, number>;
  /** Kept free in system memory for saves, screenshots and system updates (GiB). */
  internalReserveGiB: number;
  /** Share of a card's label capacity that is usable after formatting and cards running slightly small. */
  cardMargin: number;
  /** Kept free on the card for future updates and DLC: clamp(fraction × usable, minGiB, maxGiB). */
  cardHeadroom: { fraction: number; minGiB: number; maxGiB: number };
}

/** The page's steps, in order (`?step=` in the URL; no query = the first step). */
export const BUILDER_STEPS = ["device", "memory", "games", "review"] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

/** How a chosen game is bought. */
export type GameFormat = "digital" | "cartridge";

/** The shopper's plan (kept in localStorage `tt.sb.plan.v1`; sent to the server to quote and add to the cart). */
export interface BuilderPlan {
  v: 1;
  device: {
    model: SwitchModel;
    /** true = the shopper already has this console (no console line in the cart). */
    owned: boolean;
    /** TamTam variant to buy (colour), when not owned. */
    variantId?: string;
  };
  card: {
    sizeGB: CardSize;
    /** true = the shopper already has a card of this size. */
    owned: boolean;
    /** TamTam storage variant to buy, when not owned and one is sold. */
    variantId?: string;
  };
  games: Array<{ id: LibraryGameId; format: GameFormat }>;
}

/** Hard limits that keep a plan small enough for one request. */
export const PLAN_LIMITS = { maxGames: 120 } as const;

/** A buyable (or currently not buyable) catalogue variant the builder can put in the cart. */
export interface CatalogOption {
  variantId: string;
  productSlug: string;
  /** Product name in the page's language. */
  name: string;
  /** Variant title (colour, size, card value) in the page's language. */
  variantTitle?: string;
  priceIqd: number;
  orderable: boolean;
  reason?: "out_of_stock" | "unavailable";
  /** Catalogue picture key for <Art> (e.g. "nintendo-switch-oled--1"), when the product has one. */
  art?: string;
}

/** What the store sells for the builder right now (builder.server.ts → loadBuilderCatalog; loader data). */
export interface BuilderCatalog {
  /** Consoles TamTam sells, by model; null = TamTam does not sell this model now (the shopper may still own one). */
  devices: Record<SwitchModel, { productSlug: string; name: string; art?: string; variants: CatalogOption[] } | null>;
  /** The card TamTam sells for each label size (cheapest orderable, else any), for Switch 1. Missing = not sold. */
  cards: Partial<Record<Exclude<CardSize, 0>, CatalogOption>>;
  /** TamTam's physical copies of library games (published Switch 1 cartridges), by library id. */
  cartridges: Record<LibraryGameId, CatalogOption>;
  /** US Nintendo eShop cards TamTam sells; `sold` false = none buyable now. */
  eshop: { sold: boolean; denominations: Array<{ cents: number; variantId: string; priceIqd: number; orderable: boolean }> };
}

/** One line of the server's quote (builder.server.ts → quoteBuilderPlan). */
export interface QuoteLine {
  kind: "device" | "card" | "cartridge" | "eshop";
  /** For cartridges: the library game. */
  gameId?: LibraryGameId;
  variantId: string;
  productSlug: string;
  qty: number;
  name: string;
  /** Variant title (colour, size, card value). */
  variantTitle?: string;
  unitPriceIqd: number;
  /** false when it cannot be bought right now; `reason` says why (an error key). */
  orderable: boolean;
  reason?: "out_of_stock" | "unavailable" | "insufficient_stock";
  /** Catalogue picture key for <Art>, when the product has one. */
  art?: string;
}

/** The server's answer for the review step. */
export interface BuilderQuote {
  lines: QuoteLine[];
  /** Sum of the orderable lines (catalogue prices; the cart prices the order). */
  totalIqd: number;
  digital: {
    /** Digital games with a TamTam price: their eShop total in US cents. */
    pricedCents: number;
    pricedCount: number;
    /** Digital games without a price yet (the shopper checks them on the eShop). */
    unpricedIds: LibraryGameId[];
    /** eShop card value the suggested cards add up to (US cents); 0 when no cards are sold. */
    cardsCents: number;
    /** false when TamTam sells no eShop card right now. */
    cardsSold: boolean;
  };
  /** Parts of the plan TamTam cannot sell right now (for the notes). */
  notSold: Array<{ kind: "device" | "card"; sizeGB?: CardSize; model?: SwitchModel }>;
}
