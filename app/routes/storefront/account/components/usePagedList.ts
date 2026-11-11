import { useEffect, useRef, useState } from "react";
import { useFetcher, useLocation } from "react-router";

import type { Paged } from "~/lib/dto";

/**
 * A keyset-paged list that grows in place: the first page comes from the route's loader, "show more" asks the same
 * route for `?cursor=<next>` with a fetcher and appends what comes back. A revalidation of the page (after an action)
 * starts again from the loader's first page.
 *
 *   const list = usePagedList(loaderData.orders, (data) => data.orders);
 *   <ShowMore shown={list.items.length} total={list.total} onMore={list.more} loading={list.loading} />
 */
export function usePagedList<T, D>(first: Paged<T>, pick: (data: D) => Paged<T> | undefined) {
  const fetcher = useFetcher<D>();
  const location = useLocation();
  const [extra, setExtra] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const seen = useRef<unknown>(null);

  useEffect(() => {
    setExtra([]);
    setCursor(first.nextCursor);
    seen.current = null;
  }, [first]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || seen.current === fetcher.data) return;
    seen.current = fetcher.data;
    // The fetcher answers with this route's own loader data (serialized the same way as the first page).
    const page = pick(fetcher.data as unknown as D);
    if (!page) return;
    setExtra((items) => [...items, ...page.items]);
    setCursor(page.nextCursor);
  }, [fetcher.state, fetcher.data, pick]);

  const more = cursor ? () => fetcher.load(`${location.pathname}?cursor=${encodeURIComponent(cursor)}`) : undefined;
  return { items: [...first.items, ...extra], total: first.total, more, loading: fetcher.state !== "idle" };
}
