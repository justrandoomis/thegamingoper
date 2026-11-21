/**
 * Switch game library (admin) — the list's pure logic, client-safe: the filters in the address, the open list merged
 * with TamTam's rows, search, filters and sorting. The page (switch-library.tsx) runs it in the browser; tests run it
 * as it is.
 */
import type { LibraryGame } from "~/lib/switch-builder/types";
import type { LibraryListRow } from "~/server/services/admin/switch-library.server";
import { foldSearch, normalizeGameId } from "./switch-library-input";

export const LIBRARY_PAGE_SIZE = 50;
export const SIZE_FILTERS = ["", "added", "missing"] as const;
export const PRICE_FILTERS = ["", "priced", "unpriced"] as const;
export const HIDDEN_FILTERS = ["", "shown", "hidden"] as const;
export const LIBRARY_SORTS = ["popular", "title", "updated", "newest"] as const;

export type LibraryFilters = {
  q: string;
  size: (typeof SIZE_FILTERS)[number];
  price: (typeof PRICE_FILTERS)[number];
  hidden: (typeof HIDDEN_FILTERS)[number];
  sort: (typeof LIBRARY_SORTS)[number];
  page: number;
};

export const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T => (value !== null && (list as readonly string[]).includes(value) ? (value as T) : fallback);

/** The filters an address carries (anything unknown falls back to its default). */
export function readFilters(params: URLSearchParams): LibraryFilters {
  const page = Number(params.get("page"));
  return {
    q: (params.get("q") ?? "").slice(0, 120),
    size: oneOf(SIZE_FILTERS, params.get("size"), ""),
    price: oneOf(PRICE_FILTERS, params.get("price"), ""),
    hidden: oneOf(HIDDEN_FILTERS, params.get("hidden"), ""),
    sort: oneOf(LIBRARY_SORTS, params.get("sort"), "popular"),
    page: Number.isSafeInteger(page) && page > 1 ? page : 1,
  };
}

/** The address's query for the filters ("" for the defaults). */
export function filtersQuery(filters: LibraryFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.size) params.set("size", filters.size);
  if (filters.price) params.set("price", filters.price);
  if (filters.hidden) params.set("hidden", filters.hidden);
  if (filters.sort !== "popular") params.set("sort", filters.sort);
  if (filters.page > 1) params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** One line of the list: a game of the open list and/or TamTam's row for it. */
export type LibraryItem = {
  id: string;
  /** Null: TamTam has data for a game the open list does not have. */
  game: LibraryGame | null;
  row: LibraryListRow | null;
  popularity: number;
  /** Folded title, Arabic and Sorani titles, aliases, publishers and id. */
  haystack: string;
};

/** The open list's games with TamTam's rows, then the rows of games the list does not have. */
export function libraryItems(games: readonly LibraryGame[], rows: readonly LibraryListRow[]): LibraryItem[] {
  const byId = new Map(rows.map((row) => [row.gameId, row]));
  const items: LibraryItem[] = games.map((game) => ({
    id: game.id,
    game,
    row: byId.get(game.id) ?? null,
    popularity: game.popularity ?? 0,
    haystack: foldSearch([game.title, game.titleAr, game.titleCkb, ...(game.aliases ?? []), ...(game.publishers ?? []), game.id.replace(/-/g, " ")].filter(Boolean).join(" ")),
  }));
  const inList = new Set(games.map((game) => game.id));
  for (const row of rows) {
    if (!inList.has(row.gameId)) items.push({ id: row.gameId, game: null, row, popularity: -1, haystack: foldSearch(row.gameId.replace(/-/g, " ")) });
  }
  return items;
}

/** The items the filters keep, sorted (the page cuts them into pages). */
export function filterLibrary(items: readonly LibraryItem[], filters: LibraryFilters): LibraryItem[] {
  const tokens = foldSearch(filters.q).split(" ").filter(Boolean);
  const exactId = normalizeGameId(filters.q);
  const shown = items.filter((item) => {
    if (tokens.length > 0 && item.id !== exactId && !tokens.every((token) => item.haystack.includes(token))) return false;
    const sized = item.row?.sizeBytes != null;
    if (filters.size === "added" && !sized) return false;
    if (filters.size === "missing" && sized) return false;
    const priced = item.row?.priceUsdCents != null;
    if (filters.price === "priced" && !priced) return false;
    if (filters.price === "unpriced" && priced) return false;
    const hidden = item.row?.hidden === true;
    if (filters.hidden === "hidden" && !hidden) return false;
    if (filters.hidden === "shown" && hidden) return false;
    return true;
  });
  const title = (item: LibraryItem) => item.game?.title ?? item.id;
  const byTitle = (a: LibraryItem, b: LibraryItem) => title(a).localeCompare(title(b), "en", { sensitivity: "base" });
  const released = (item: LibraryItem) => item.game?.released ?? (item.game?.year ? String(item.game.year) : "");
  const sorters: Record<LibraryFilters["sort"], (a: LibraryItem, b: LibraryItem) => number> = {
    popular: (a, b) => b.popularity - a.popularity || byTitle(a, b),
    title: byTitle,
    updated: (a, b) => (b.row?.updatedAt ?? 0) - (a.row?.updatedAt ?? 0) || b.popularity - a.popularity || byTitle(a, b),
    newest: (a, b) => released(b).localeCompare(released(a)) || byTitle(a, b),
  };
  return shown.sort(sorters[filters.sort]);
}
