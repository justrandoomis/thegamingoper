/**
 * The lab's pretend cart: an in-memory counter, so the badge can live in the lab bar while the buttons that add to it
 * are on other tabs and routes. Browser-only state (the server always renders 0).
 */
import { useSyncExternalStore } from "react";

let count = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function useLabCart(): number {
  return useSyncExternalStore(
    subscribe,
    () => count,
    () => 0,
  );
}

export function addToLabCart(): void {
  count += 1;
  emit();
}

export function clearLabCart(): void {
  count = 0;
  emit();
}
