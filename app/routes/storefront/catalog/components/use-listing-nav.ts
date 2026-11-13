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
 *
 *   const hold = useOfflineHold();      <div className="page catalog-page" onClickCapture={hold}>
 */
import { useCallback, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { useLocation, useNavigate, useNavigation } from "react-router";

import { LISTING_SORTS, listChangeHref, listingSearch, readListingQuery, type ListingQuery, type ListingSort } from "../listing-model";

/**
 * Offline, a tap on a link that changes this page's list — a chip, «اعرض المزيد», a removable filter, the zero-result
 * recovery — is held: the page keeps what it shows (the toolbar says «لا يوجد اتصال. نحدّث النتائج حين يعود.» and the
 * shell's banner says it too) and the list follows the last held tap once the connection is back. Without it the
 * navigation fails and the results give way to the offline error page (v2 §6.2 states: "offline while filtering").
 * Links to other pages navigate as usual. Attach it to the page as a click CAPTURE handler, so it runs before the link.
 *
 * The root's offline guard (app/root.tsx OfflineNavigationGuard, a window capture listener — it runs first) cancels
 * every same-origin link while offline and says so in a toast. The tap is cancelled already then, but a list change is
 * still this page's to hold — so an offline tap is held whether or not the guard got to it first (wave B, 2026-11-13:
 * since the guard arrived the hold never held, and the toolbar's «نحدّث النتائج حين يعود» was not kept).
 */
export function useOfflineHold(): (event: MouseEvent<HTMLElement>) => void {
  const navigate = useNavigate();
  const held = useRef<string | null>(null);
  useEffect(() => {
    const resume = () => {
      const href = held.current;
      held.current = null;
      if (href) void navigate(href, { preventScrollReset: true });
    };
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, [navigate]);
  return useCallback((event: MouseEvent<HTMLElement>) => {
    // online: nothing to hold; a modified or other-button click is the browser's (a new tab), never held
    if (navigator.onLine || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(link instanceof HTMLAnchorElement) || (link.target !== "" && link.target !== "_self")) return;
    const href = listChangeHref(link.href, window.location.href);
    if (!href) return;
    event.preventDefault();
    held.current = href;
  }, []);
}

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
