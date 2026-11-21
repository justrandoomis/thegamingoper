/**
 * The games step's list model (pure, client-safe; docs/switch-builder.md §6.4): the open list merged with TamTam's own
 * data and the catalogue's cartridges, then searched, filtered and sorted.
 *
 *   mergeLibrary(list, extras, cartridges)        LibraryEntry[] — hidden games dropped
 *   viewLibrary(entries, { query, filters, sort, remainingBytes, chosen })
 *                                                 the cards to show, in order: games TamTam has a size for come first
 *                                                 in every sort (only they can join the space bar), then how well
 *                                                 they match the search, then the sort
 *
 * The filters (a sheet on the page): genre and play mode (any of the chosen values), one size band, one eShop price
 * band (priced games only), "fits the space left", "TamTam sells the cartridge", "size added". The sorts: popular
 * (Wikipedia language editions — the list's `popularity`), newest, A–Z, smallest, cheapest (eShop price), and the
 * Metacritic score — offered only when TamTam has entered a licensed score for some game.
 */
import { defaultFormat, isGameId } from "~/lib/switch-builder/plan";
import { gameSearchKey, matchTier, searchTerms, type GameSearchKey } from "~/lib/switch-builder/search";
import { fits, GIB, spaceNeeded } from "~/lib/switch-builder/storage";
import type { BuilderCatalog, CatalogOption, GameFormat, GenreKey, LibraryExtras, LibraryGame, LibraryGameId, PlayMode } from "~/lib/switch-builder/types";

export type LibraryEntry = {
  game: LibraryGame;
  extras: LibraryExtras | undefined;
  /** TamTam's cartridge of this game, when the catalogue has one. */
  cartridge: CatalogOption | undefined;
  /** How the game is chosen by default: TamTam's cartridge when it can be ordered now, else digital. */
  format: GameFormat;
  key: GameSearchKey;
};

/** The open list joined with TamTam's data (by library id) and the catalogue's cartridges; hidden games are left out. */
export function mergeLibrary(games: readonly LibraryGame[], extras: Readonly<Record<LibraryGameId, LibraryExtras>>, cartridges: BuilderCatalog["cartridges"]): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const game of games) {
    if (seen.has(game.id) || !isGameId(game.id)) continue;
    seen.add(game.id);
    const own = extras[game.id];
    if (own?.hidden) continue;
    out.push({ game, extras: own, cartridge: cartridges[game.id], format: defaultFormat(game.id, cartridges), key: gameSearchKey(game) });
  }
  return out;
}

/** Bytes the game needs in this format (its default when not given); null = TamTam has not measured it. */
export function needOf(entry: LibraryEntry, format: GameFormat = entry.format): number | null {
  return spaceNeeded(entry.extras, format);
}

// ───────────────────────────────────────────────────────────────── filters

export const SIZE_BANDS = [
  { id: "upTo2", minGiB: 0, maxGiB: 2 },
  { id: "2to8", minGiB: 2, maxGiB: 8 },
  { id: "8to16", minGiB: 8, maxGiB: 16 },
  { id: "over16", minGiB: 16, maxGiB: null },
] as const;
export type SizeBand = (typeof SIZE_BANDS)[number]["id"];

/** eShop (US) price bands, in US cents. */
export const PRICE_BANDS = [
  { id: "upTo10", min: 0, max: 1000 },
  { id: "10to30", min: 1000, max: 3000 },
  { id: "30to50", min: 3000, max: 5000 },
  { id: "over50", min: 5000, max: null },
] as const;
export type PriceBand = (typeof PRICE_BANDS)[number]["id"];

export type LibraryFilters = {
  genres: GenreKey[];
  modes: PlayMode[];
  size: SizeBand | null;
  price: PriceBand | null;
  /** Only games that fit in the space left (chosen games stay). */
  fits: boolean;
  /** Only games TamTam sells as a cartridge. */
  cartridge: boolean;
  /** Only games TamTam has a size for. */
  sized: boolean;
};

export const NO_FILTERS: LibraryFilters = { genres: [], modes: [], size: null, price: null, fits: false, cartridge: false, sized: false };

/** Filter groups in use (the «الفلاتر (n)» count, and the removable chips' order). */
export function activeFilterGroups(filters: LibraryFilters): Array<keyof LibraryFilters> {
  const out: Array<keyof LibraryFilters> = [];
  if (filters.genres.length > 0) out.push("genres");
  if (filters.modes.length > 0) out.push("modes");
  if (filters.size) out.push("size");
  if (filters.price) out.push("price");
  if (filters.fits) out.push("fits");
  if (filters.cartridge) out.push("cartridge");
  if (filters.sized) out.push("sized");
  return out;
}

const inSizeBand = (need: number | null, band: SizeBand): boolean => {
  if (need === null) return false;
  const spec = SIZE_BANDS.find((entry) => entry.id === band);
  if (!spec) return true;
  return need > spec.minGiB * GIB && (spec.maxGiB === null || need <= spec.maxGiB * GIB);
};

const inPriceBand = (cents: number | undefined, band: PriceBand): boolean => {
  if (typeof cents !== "number" || cents <= 0) return false;
  const spec = PRICE_BANDS.find((entry) => entry.id === band);
  if (!spec) return true;
  return cents > spec.min && (spec.max === null || cents <= spec.max);
};

// ───────────────────────────────────────────────────────────────── sorts

export const LIBRARY_SORTS = ["popular", "newest", "az", "smallest", "cheapest", "score"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export function isLibrarySort(value: unknown): value is LibrarySort {
  return typeof value === "string" && (LIBRARY_SORTS as readonly string[]).includes(value);
}

/** The sorts to offer: the score only when TamTam has entered a licensed Metacritic score for at least one game. */
export function sortsFor(entries: readonly LibraryEntry[]): LibrarySort[] {
  const scored = entries.some((entry) => typeof entry.extras?.metacritic?.score === "number");
  return LIBRARY_SORTS.filter((sort) => sort !== "score" || scored);
}

const releasedKey = (game: LibraryGame): string => game.released ?? (typeof game.year === "number" ? `${String(game.year).padStart(4, "0")}-00-00` : "");
const titleCollator = typeof Intl !== "undefined" ? new Intl.Collator("en", { sensitivity: "base", numeric: true }) : null;
const byTitle = (a: LibraryEntry, b: LibraryEntry) => (titleCollator ? titleCollator.compare(a.game.title, b.game.title) : a.game.title.localeCompare(b.game.title));
const byPopular = (a: LibraryEntry, b: LibraryEntry) => b.game.popularity - a.game.popularity || byTitle(a, b);

/** Missing values (no date, no price, no score) go after the ones that have them, whatever the direction. */
function present<T>(a: T | null | undefined, b: T | null | undefined, compare: (x: T, y: T) => number): number | null {
  const hasA = a !== null && a !== undefined;
  const hasB = b !== null && b !== undefined;
  if (hasA && hasB) return compare(a as T, b as T);
  if (hasA !== hasB) return hasA ? -1 : 1;
  return null;
}

export function compareBy(sort: LibrarySort, chosenFormat: (entry: LibraryEntry) => GameFormat): (a: LibraryEntry, b: LibraryEntry) => number {
  switch (sort) {
    case "popular":
      return byPopular;
    case "newest":
      return (a, b) => {
        const left = releasedKey(a.game) || null;
        const right = releasedKey(b.game) || null;
        return present(left, right, (x, y) => (x === y ? 0 : x < y ? 1 : -1)) || byPopular(a, b);
      };
    case "az":
      return (a, b) => byTitle(a, b) || byPopular(a, b);
    case "smallest":
      return (a, b) => present(needOf(a, chosenFormat(a)), needOf(b, chosenFormat(b)), (x, y) => x - y) || byPopular(a, b);
    case "cheapest":
      return (a, b) => present(priceOf(a), priceOf(b), (x, y) => x - y) || byPopular(a, b);
    case "score":
      return (a, b) => present(a.extras?.metacritic?.score, b.extras?.metacritic?.score, (x, y) => y - x) || byPopular(a, b);
  }
}

const priceOf = (entry: LibraryEntry): number | null => (typeof entry.extras?.priceUsdCents === "number" && entry.extras.priceUsdCents > 0 ? entry.extras.priceUsdCents : null);

// ───────────────────────────────────────────────────────────────── the view

export type LibraryView = {
  query: string;
  filters: LibraryFilters;
  sort: LibrarySort;
  /** Bytes left in the plan (for "fits the space left"). */
  remainingBytes: number;
  /** The plan's games and how each is chosen. */
  chosen: ReadonlyMap<LibraryGameId, GameFormat>;
};

/**
 * The cards to show, in order. Games TamTam has a size for come first in every sort (only they can join the space
 * bar); then, when the shopper searches, how well each matches (titles first); then the chosen sort. Chosen games are
 * never filtered out by "fits the space left". Pure.
 */
export function viewLibrary(entries: readonly LibraryEntry[], view: LibraryView): LibraryEntry[] {
  const terms = searchTerms(view.query);
  const { filters } = view;
  const formatOf = (entry: LibraryEntry) => view.chosen.get(entry.game.id) ?? entry.format;
  const rows: Array<{ entry: LibraryEntry; tier: number; plannable: boolean }> = [];
  for (const entry of entries) {
    const tier = matchTier(terms, entry.key);
    if (tier === null) continue;
    const format = formatOf(entry);
    const need = needOf(entry, format);
    if (filters.genres.length > 0 && !entry.game.genres.some((genre) => filters.genres.includes(genre))) continue;
    if (filters.modes.length > 0 && !entry.game.modes.some((mode) => filters.modes.includes(mode))) continue;
    if (filters.size && !inSizeBand(need, filters.size)) continue;
    if (filters.price && !inPriceBand(entry.extras?.priceUsdCents, filters.price)) continue;
    if (filters.cartridge && !entry.cartridge) continue;
    if (filters.sized && need === null) continue;
    if (filters.fits && !view.chosen.has(entry.game.id) && !fits(need, view.remainingBytes)) continue;
    rows.push({ entry, tier, plannable: need !== null });
  }
  const compare = compareBy(view.sort, formatOf);
  rows.sort((a, b) => Number(b.plannable) - Number(a.plannable) || a.tier - b.tier || compare(a.entry, b.entry));
  return rows.map((row) => row.entry);
}

/** How many games match each value of a filter group, with the other filters as they are (the sheet's counts). */
export function countsFor(entries: readonly LibraryEntry[], view: LibraryView, group: "genres" | "modes"): Map<string, number> {
  const without = viewLibrary(entries, { ...view, filters: { ...view.filters, [group]: [] } });
  const counts = new Map<string, number>();
  for (const entry of without) for (const value of group === "genres" ? entry.game.genres : entry.game.modes) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
