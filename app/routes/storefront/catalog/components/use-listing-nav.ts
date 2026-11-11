/**
 * The list's state lives in the URL (listing-model.ts). This hook reads it — from the PENDING navigation while one
 * to the same page is under way, so a chip shows its new state on the tap, before the new results arrive — and
 * builds the hrefs and navigations that change it. Results are never held back for an animation: every change is
 * an ordinary navigation that fires at once.
 *
 *   const nav = useListingNav({ sorts: LISTING_SORTS });
 *   nav.query                          the list's query (optimistic)
 *   nav.href({ inStock: true })        "?stock=1" — cursor dropped (a new filter starts the list again)
 *   nav.go({ sort: "newest" })         navigate, keeping the scroll position
 *   nav.pending                        a navigation to this list is loading
 */
import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useNavigation } from "react-router";

import { LISTING_SORTS, listingSearch, readListingQuery, type ListingQuery, type ListingSort } from "../listing-model";

export type ListingNavOptions = {
  /** Sorts this list offers (search adds "relevance"). */
  sorts?: readonly ListingSort[];
  /** URL keys that are not part of the list's query but must be kept (the search page's `q`). */
  keep?: readonly string[];
};

export type ListingNav = {
  query: ListingQuery;
  /** Kept keys and their values ({ q } on the search page). */
  extra: Record<string, string>;
  pending: boolean;
  /** "?…" for this list with `change` applied; a change without `cursor` starts the list again. */
  href: (change: Partial<ListingQuery>) => string;
  go: (change: Partial<ListingQuery>, options?: { replace?: boolean }) => void;
};

export function useListingNav({ sorts = LISTING_SORTS, keep = [] }: ListingNavOptions = {}): ListingNav {
  const location = useLocation();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const pendingHere = navigation.state !== "idle" && navigation.location?.pathname === location.pathname;
  const search = pendingHere && navigation.location ? navigation.location.search : location.search;
  const keepKey = keep.join("|");
  const sortKey = sorts.join("|");

  const { query, extra } = useMemo(() => {
    const params = new URLSearchParams(search);
    const kept: Record<string, string> = {};
    for (const key of keepKey ? keepKey.split("|") : []) {
      const value = params.get(key);
      if (value) kept[key] = value;
    }
    return { query: readListingQuery(params, sortKey.split("|") as ListingSort[]), extra: kept };
  }, [search, keepKey, sortKey]);

  const href = useCallback((change: Partial<ListingQuery>) => listingSearch({ ...query, cursor: null, ...change }, extra) || "?", [query, extra]);
  const go = useCallback(
    (change: Partial<ListingQuery>, options: { replace?: boolean } = {}) => {
      const next = href(change);
      void navigate(`${location.pathname}${next === "?" ? "" : next}`, { preventScrollReset: true, replace: options.replace ?? false });
    },
    [href, navigate, location.pathname],
  );

  return { query, extra, pending: pendingHere, href, go };
}
