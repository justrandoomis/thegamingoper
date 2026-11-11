/**
 * Catalogue read layer — the types other areas code against (docs/CONTRACTS.md §2).
 * Client-safe: types and constants only, so components may import them too.
 *
 *   import { listCards, getCardsByIds, getNewArrivals, getDeals, getUsedSpotlight } from "~/server/services/catalog/cards.server";
 *   import { getPlatforms, getCategoryTree, getNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
 *
 *   const page = await listCards(db, ctx.locale, { platform: "playstation", sort: "newest", limit: 24, cursor: url.searchParams.get("cursor") });
 *   // page.items: ProductCardData[] · page.total: every match · page.nextCursor: pass back for the next page (null = last page)
 *
 * What a card says (never more than the shop knows):
 *   · Only `published` products, and only active variants. The CARD VARIANT is the default variant (else the first
 *     active one by sort) — its price, compare-at price and id are what the card shows and what "add" adds.
 *   · `stock` is a state, never a number. One-variant products: that variant's state. Products with several variants:
 *     the best state among them (the card opens a chooser). States follow the commerce core's getAvailability():
 *     sellable, active locations only; bundles count complete sets; low = at or below the reorder point (3 if unset).
 *     A product whose `preorder_release_at` is still in the future is "preorder".
 *   · `compareAtIqd` is set only when it is above the price (a reduction); otherwise null.
 *   · `badge`: "preorder" (release date in the future) › "deal" (a reduction) › "new" (sold new, the counterpart of a
 *     used unit's grade). Exactly one per card.
 *   · `rating` counts approved, verified-purchase reviews only; null when there are none. Nothing is invented.
 *   · No cost, margin, serial or stock quantity ever leaves these functions.
 */
import type { CategoryNode, PlatformSummary, ProductKind } from "~/lib/dto";

/** listCards sort orders. "featured" = what can be bought now first, newest first within that (no popularity signal exists). */
export const CARD_SORTS = ["featured", "newest", "price_asc", "price_desc"] as const;
export type CardSort = (typeof CARD_SORTS)[number];

/** Largest page listCards returns. */
export const MAX_CARD_PAGE = 60;

export type CardFilters = {
  /** Platform slug(s): "nintendo" | "playstation" | "xbox" | "handheld" (any active platform). */
  platform?: string | readonly string[];
  /** Category slug; the category's active sub-categories are included. */
  category?: string;
  kind?: ProductKind | readonly ProductKind[];
  /**
   * Device model slug: products that ARE the model or are made for it (`device_model_id`), plus products whose most
   * specific compatibility rule for the model (model › generation › platform, product or variant level) is
   * `verified` or `partial`. A missing rule is never read as "compatible".
   */
  deviceModel?: string;
  /** Free text, matched through the search index in every language (trigram FTS; 1–2 letter terms by substring). */
  q?: string;
  /** Inclusive bounds on the card variant's price, integer IQD. */
  priceMin?: number;
  priceMax?: number;
  /** Only products that can be bought now (in stock or low stock). */
  inStockOnly?: boolean;
  /** Only products whose card variant has a genuine reduction (compare-at above the price). */
  dealsOnly?: boolean;
};

export type ListCardsOptions = CardFilters & {
  sort: CardSort;
  /** 1 … MAX_CARD_PAGE. */
  limit: number;
  /** `nextCursor` of the previous page. A cursor only fits the sort it was made with. */
  cursor?: string | null;
  /** Request time (ctx.now) — decides "preorder". Defaults to Date.now(). */
  now?: number;
};

/** Options of the shelf helpers (home, hubs). */
export type ShelfOptions = {
  platform?: string | readonly string[];
  /** Default 12 (used spotlight: 8). */
  limit?: number;
  now?: number;
};

// ───────────────────────────────────────────────────────────────── navigation taxonomy

/** A link in the navigation. `href` is locale-less ("/c/controllers?platform=xbox"); wrap it in <LocaleLink>. */
export type NavLink = { label: string; href: string };

export type NavCategory = NavLink & {
  slug: string;
  /** Navigation group of the category ("consoles", "games", "controllers", …). */
  kind: string;
  /** Published products in the category and its sub-categories. */
  count: number;
  /** Sub-categories that have published products. */
  children: (NavLink & { slug: string; count: number })[];
};

/** One platform with everything its desktop mega menu and the categories sheet need. */
export type NavPlatform = PlatformSummary & {
  /** Art key of the platform's lead device (for the lit stage in the mega menu), or null. */
  artKey: string | null;
  /** "/platform/<slug>" — the platform hub. */
  href: string;
  /** Published products of this platform. */
  productCount: number;
  /** "Everything about this device" hubs: "/device/<slug>". */
  devices: NavLink[];
  /** Controllers, headsets, storage, accessories, digital cards, parts… that have products for this platform. */
  accessories: NavLink[];
  /** The platform's games categories. */
  games: NavLink[];
  /** Newest console products of the platform ("/p/<slug>"), at most 5. */
  consoles: NavLink[];
  /** The platform's consoles category, when it has products. */
  allConsoles: NavLink | null;
  /** "/used?platform=<slug>" while used units of the platform are listed; null when none are. */
  used: NavLink | null;
};

export type NavTaxonomy = {
  platforms: NavPlatform[];
  /** Top-level categories with published products (in them or their sub-categories), in menu order. */
  categories: NavCategory[];
  /** Listed used units across the store. */
  usedCount: number;
  /** When this snapshot was built (epoch ms). */
  builtAt: number;
};

export type { CategoryNode, PlatformSummary };
