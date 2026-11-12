import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in the server HTML and while React hydrates it; true from then on, and true at once for a page opened by a
 * client-side navigation (useSyncExternalStore's server snapshot is used for hydration only, so nothing mismatches).
 *
 * The account's forms use it for their no-script fallbacks (they worked without script before the v2 rebuild): a kit
 * control that needs script (the governorate picker, the segmented language control) submits its value only once
 * script runs, and before that a native control inside <noscript> carries the same field name — never both, so the
 * form never sends two values for one field.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
