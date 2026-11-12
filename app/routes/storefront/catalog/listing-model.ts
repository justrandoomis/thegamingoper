/**
 * The catalog area's listing model — CLIENT-SAFE (types, constants and pure URL helpers only). Shared by the
 * services (`~/server/services/catalog/listing.server`, `~/server/services/search.server`, which re-export what
 * callers need) and by the pages of this folder, so a filter means the same thing on both sides.
 *
 * URL grammar of every product list (category hub, platform hub, search results) — the filter state lives in the
 * URL, so a list is shareable, survives Back and works without script (a plain GET form):
 *
 *   platform=xbox&platform=playstation   researched platforms (any of them); not on platform hubs
 *   cat=controllers                      a category and its sub-categories
 *   device=ps5-pro                       made for this device model, or verified / partly compatible with it
 *   min=50000&max=250000                 the card price, integer IQD, inclusive
 *   stock=1                              can be bought now (in stock or low stock)
 *   deals=1                              a genuine reduction (compare-at price above the price)
 *   arabic=interface|subtitles|voice     games: Arabic menus at least · Arabic subtitles at least · Arabic voices
 *   format=disc&format=cartridge         games: physical format, as researched
 *   sort=featured|newest|price_asc|price_desc|relevance   (relevance: search only, and its default)
 *   cursor=…                             the list up to and including the page after this cursor ("show more")
 *   q=…                                  search only
 *
 * Unknown or malformed values are dropped (never an error page): a hand-edited URL still shows a list.
 */

// ───────────────────────────────────────────────────────────────── vocabulary

/** Sort orders of a product list. "featured" = can be bought now first, newest within that (no popularity data). */
export const LISTING_SORTS = ["featured", "newest", "price_asc", "price_desc"] as const;
/** Search adds "relevance" (its default): exact name first, then how much of the query the name covers. */
export const SEARCH_SORTS = ["relevance", ...LISTING_SORTS] as const;
export type ListingSort = (typeof SEARCH_SORTS)[number];

/**
 * Arabic support of a game, as researched (`attributes.game.arabic`). Levels nest: voices come with subtitles and
 * menus, subtitles with menus. "unknown" and "none" match no level; "unknown" is never shown as "no Arabic".
 */
export const ARABIC_LEVELS = ["interface", "subtitles", "voice"] as const;
export type ArabicLevel = (typeof ARABIC_LEVELS)[number];
/** Research value → level (1–3); 0 = no Arabic; null = not known. */
export const ARABIC_RANK: Readonly<Record<string, number | null>> = {
  "voice+subtitles+interface": 3,
  "subtitles+interface": 2,
  interface: 1,
  none: 0,
  unknown: null,
};
export const arabicLevelRank = (level: ArabicLevel): number => ARABIC_LEVELS.indexOf(level) + 1;

/** Physical format of a boxed game, as researched (`attributes.game.physicalFormat`). */
export const PHYSICAL_FORMATS = ["cartridge", "game-key-card", "disc", "code-in-box"] as const;
export type PhysicalFormat = (typeof PHYSICAL_FORMATS)[number];

/** Quick price ranges offered next to the two price fields (integer IQD, inclusive; null = open). */
export const PRICE_BANDS: readonly { min: number | null; max: number | null }[] = [
  { min: null, max: 50_000 },
  { min: 50_000, max: 100_000 },
  { min: 100_000, max: 250_000 },
  { min: 250_000, max: 500_000 },
  { min: 500_000, max: 1_000_000 },
  { min: 1_000_000, max: null },
];

/** Largest price a filter accepts (one billion dinars; anything above is a typo). */
export const MAX_PRICE_IQD = 1_000_000_000;
/** Products per page ("show more" adds this many). */
export const LISTING_PAGE_SIZE = 24;
/** A cumulative list stops growing here; past it, a page is shown on its own with a link back to the start. */
export const MAX_CUMULATIVE = 240;
/** Platforms a list may filter by at once. */
export const MAX_PLATFORM_FILTERS = 6;
/** Products a comparison holds at most (the compare page, its client store, the service). */
export const MAX_COMPARE = 4;

/**
 * "/search?q=…" encoded the way a submitted form encodes it (spaces as "+"), so a link and the header's search form
 * produce the same URL — and the server renders the same `location.search` the browser hydrates with.
 */
export const searchPath = (q: string): string => `/search?${new URLSearchParams({ q }).toString()}`;

/** The filter groups — each one can be removed on its own (zero-result recovery, active-filter chips). */
export const FILTER_GROUPS = ["platforms", "category", "device", "price", "inStock", "deals", "arabic", "formats"] as const;
export type FilterGroup = (typeof FILTER_GROUPS)[number];

export type ListingFilters = {
  platforms: string[];
  category: string | null;
  device: string | null;
  priceMin: number | null;
  priceMax: number | null;
  inStock: boolean;
  deals: boolean;
  arabic: ArabicLevel | null;
  formats: PhysicalFormat[];
};

export const NO_FILTERS: ListingFilters = Object.freeze({
  platforms: [],
  category: null,
  device: null,
  priceMin: null,
  priceMax: null,
  inStock: false,
  deals: false,
  arabic: null,
  formats: [],
}) as ListingFilters;

/** Is this filter group in use? */
export function isActive(filters: ListingFilters, group: FilterGroup): boolean {
  switch (group) {
    case "platforms":
      return filters.platforms.length > 0;
    case "category":
      return filters.category !== null;
    case "device":
      return filters.device !== null;
    case "price":
      return filters.priceMin !== null || filters.priceMax !== null;
    case "inStock":
      return filters.inStock;
    case "deals":
      return filters.deals;
    case "arabic":
      return filters.arabic !== null;
    case "formats":
      return filters.formats.length > 0;
  }
}

export const activeGroups = (filters: ListingFilters): FilterGroup[] => FILTER_GROUPS.filter((group) => isActive(filters, group));

/** The same filters without one group. */
export function withoutGroup(filters: ListingFilters, group: FilterGroup): ListingFilters {
  switch (group) {
    case "platforms":
      return { ...filters, platforms: [] };
    case "category":
      return { ...filters, category: null };
    case "device":
      return { ...filters, device: null };
    case "price":
      return { ...filters, priceMin: null, priceMax: null };
    case "inStock":
      return { ...filters, inStock: false };
    case "deals":
      return { ...filters, deals: false };
    case "arabic":
      return { ...filters, arabic: null };
    case "formats":
      return { ...filters, formats: [] };
  }
}

// ───────────────────────────────────────────────────────────────── results (what the services return)

export type FacetOption = { value: string; label: string; count: number };

export type ListingFacets = {
  /** The chip rail under the hub header: sub-categories of a category, else top-level categories of the list. */
  categories: (FacetOption & { artKey: string | null })[];
  /** Researched platforms (empty on a platform hub). */
  platforms: (FacetOption & { accent: string })[];
  /** Device models the products are made for or (partly) verified with. */
  devices: (FacetOption & { platform: string; artKey: string | null })[];
  /** Cheapest and dearest card price among the matches of the other filters; null when there are none. */
  price: { min: number; max: number } | null;
  priceBands: { min: number | null; max: number | null; count: number }[];
  inStock: number;
  deals: number;
  arabic: { value: ArabicLevel; count: number }[];
  formats: { value: PhysicalFormat; count: number }[];
  /** How many products the list would show without each filter group (the "All" chip of a rail). */
  without: Record<FilterGroup, number>;
};

/** A device model shortcut (→ /device/<slug>, the devices area's hub). */
/** `short`: the model's short name for the hub's model switcher ("PS5 Pro"; catalogue read layer, card-facts.ts shortModelName). */
export type DeviceShortcut = { slug: string; name: string; short?: string; platform: string; artKey: string | null; count: number };

/** What the search start and the zero-result page offer to browse: every platform and department, with the hubs' counts. */
export type StoreBrowse = {
  platforms: { slug: string; count: number }[];
  categories: { slug: string; label: string; count: number; artKey: string | null }[];
};

// ───────────────────────────────────────────────────────────────── URL ⇄ query

export type ListingQuery = ListingFilters & { sort: ListingSort | null; cursor: string | null };

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

const isSlug = (value: string | null): value is string => typeof value === "string" && value.length <= 80 && SLUG.test(value);

/**
 * A price bound from the URL. Read the way a shopper types it (parsePriceInput: Arabic-Indic or Persian digits,
 * separators, the currency), because the no-script form sends the field exactly as typed — «١٠٠٬٠٠٠» must filter, not
 * vanish. Written back in Western digits (listingSearch), so the list keeps one URL.
 */
function amount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = parsePriceInput(value.slice(0, 40));
  return typeof parsed === "number" ? parsed : null;
}

/** All values of a repeatable key, also accepting "a,b" in one value. */
function many(params: URLSearchParams, key: string): string[] {
  const out: string[] = [];
  for (const raw of params.getAll(key)) for (const part of raw.split(",")) if (part.trim()) out.push(part.trim().toLowerCase());
  return [...new Set(out)];
}

/** Reads a list's query from the URL. `sorts` = which sorts this list offers (search adds "relevance"). */
export function readListingQuery(params: URLSearchParams, sorts: readonly ListingSort[] = LISTING_SORTS): ListingQuery {
  let priceMin = amount(params.get("min"));
  let priceMax = amount(params.get("max"));
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
  const arabic = params.get("arabic");
  const sort = params.get("sort");
  const cursor = params.get("cursor");
  const category = params.get("cat");
  const device = params.get("device");
  return {
    platforms: many(params, "platform").filter(isSlug).slice(0, MAX_PLATFORM_FILTERS),
    category: isSlug(category) ? category : null,
    device: isSlug(device) ? device : null,
    priceMin,
    priceMax,
    inStock: params.get("stock") === "1",
    deals: params.get("deals") === "1",
    arabic: (ARABIC_LEVELS as readonly string[]).includes(arabic ?? "") ? (arabic as ArabicLevel) : null,
    formats: many(params, "format").filter((value): value is PhysicalFormat => (PHYSICAL_FORMATS as readonly string[]).includes(value)),
    sort: (sorts as readonly string[]).includes(sort ?? "") ? (sort as ListingSort) : null,
    cursor: cursor && CURSOR.test(cursor) ? cursor : null,
  };
}

/**
 * The URL search string of a list ("?…", or "" for none). Default values are left out and keys come in a fixed
 * order, so one list has one URL. `extra` comes first (e.g. `{ q }` on the search page).
 */
export function listingSearch(query: Partial<ListingQuery>, extra: Record<string, string | null | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  for (const platform of query.platforms ?? []) params.append("platform", platform);
  if (query.category) params.set("cat", query.category);
  if (query.device) params.set("device", query.device);
  if (query.priceMin !== null && query.priceMin !== undefined) params.set("min", String(query.priceMin));
  if (query.priceMax !== null && query.priceMax !== undefined) params.set("max", String(query.priceMax));
  if (query.inStock) params.set("stock", "1");
  if (query.deals) params.set("deals", "1");
  if (query.arabic) params.set("arabic", query.arabic);
  for (const format of query.formats ?? []) params.append("format", format);
  if (query.sort) params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * What a shopper typed in a price field → whole dinars. Accepts Arabic-Indic and Persian digits, thousands
 * separators and the currency ("٢٥٠٬٠٠٠ د.ع" → 250000). "" → null (no bound); anything else → "invalid".
 */
export function parsePriceInput(text: string): number | null | "invalid" {
  const latin = text.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  const cleaned = latin.replace(/د\.?\s?ع|iqd/gi, "").replace(/[\s,٬،]/g, "");
  if (cleaned === "") return null;
  if (!/^\d{1,10}$/.test(cleaned)) return "invalid";
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value <= MAX_PRICE_IQD ? value : "invalid";
}

/**
 * Does this link change the list on the page `here` (a chip, «اعرض المزيد», a removable filter, the zero-result
 * recovery: same origin, same path, another query)? Then "path?query", else null (another page, another site, a hash on
 * this page). Offline, the catalog pages hold such a tap and follow it when the connection is back
 * (components/use-listing-nav.ts) instead of failing it.
 */
export function listChangeHref(href: string, here: string): string | null {
  let current: URL;
  let target: URL;
  try {
    current = new URL(here);
    target = new URL(href, current);
  } catch {
    return null;
  }
  if (target.origin !== current.origin || target.pathname !== current.pathname || target.search === current.search) return null;
  return `${target.pathname}${target.search}`;
}

/** The filters part of a query. */
export function filtersOf(query: ListingFilters): ListingFilters {
  return {
    platforms: [...query.platforms],
    category: query.category,
    device: query.device,
    priceMin: query.priceMin,
    priceMax: query.priceMax,
    inStock: query.inStock,
    deals: query.deals,
    arabic: query.arabic,
    formats: [...query.formats],
  };
}

/** Same filters? (Order of multi-values does not matter.) */
export function sameFilters(a: ListingFilters, b: ListingFilters): boolean {
  const set = (values: readonly string[]) => [...values].sort().join("|");
  return (
    set(a.platforms) === set(b.platforms) &&
    a.category === b.category &&
    a.device === b.device &&
    a.priceMin === b.priceMin &&
    a.priceMax === b.priceMax &&
    a.inStock === b.inStock &&
    a.deals === b.deals &&
    a.arabic === b.arabic &&
    set(a.formats) === set(b.formats)
  );
}
