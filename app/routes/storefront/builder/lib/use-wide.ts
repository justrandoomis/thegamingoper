/**
 * Whether the page is at its wide layout (≥ 1024px: the sticky aside holds the meter, the chosen games and the keys;
 * below it the task bar does). False on the server and while hydrating, then the browser's answer.
 *
 * The guide (useBuilderTour) highlights ONE element per target name: a target drawn twice — once in the task bar,
 * once in the aside — carries its `data-tour` only on the copy the shopper can see (`tourOn(name, wide)`).
 */
import { useSyncExternalStore } from "react";

export const WIDE_QUERY = "(min-width: 64rem)";

function subscribe(notify: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

export function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/** `data-tour` for a copy that is shown only at one layout: on it when that layout is the current one. */
export function tourOn(name: string, show: boolean): { "data-tour"?: string } {
  return show ? { "data-tour": name } : {};
}
