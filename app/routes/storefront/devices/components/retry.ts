/**
 * «أعد المحاولة» for a streamed part of a page (the hub's setup shelf, the shared recommendation shelves): the page's
 * data is asked again (revalidation) — but never while the browser is offline. A revalidation that cannot reach the
 * server fails the whole route, and the error page would replace everything the shopper was reading; offline, the
 * part keeps its offline sentence (the kit's ErrorState says it) and asks again by itself once the connection is back.
 *
 *   const { retry, retrying } = useSafeRetry();
 *   <ErrorState onRetry={retry} retrying={retrying} />
 */
import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

export function useSafeRetry(): { retry: () => void; retrying: boolean } {
  const revalidator = useRevalidator();
  const waiting = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (waiting.current) window.removeEventListener("online", waiting.current);
    },
    [],
  );
  const retry = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (waiting.current) return;
      const onOnline = () => {
        waiting.current = null;
        void revalidator.revalidate();
      };
      waiting.current = onOnline;
      window.addEventListener("online", onOnline, { once: true });
      return;
    }
    void revalidator.revalidate();
  };
  return { retry, retrying: revalidator.state === "loading" };
}
