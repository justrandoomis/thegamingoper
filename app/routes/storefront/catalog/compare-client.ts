/**
 * The compare list on this device — a tiny client store (catalog area; exported for the product page and cards).
 *
 *   const compare = useCompare();
 *   compare.has(product.id) · compare.add({ id, kind }) → "added" | "replaced" | "full" | "present" | "invalid"
 *   compare.remove(id) · compare.clear() · compare.ids · compare.kind
 *   compareHref(compare.ids)                       "/compare?ids=prd_1,prd_2" (locale-less: wrap in LocaleLink)
 *
 * Rules: at most MAX_COMPARE products, all of ONE kind (consoles with consoles, headsets with headsets) — adding a
 * product of another kind starts a new list ("replaced"). The URL of /compare is the source of truth for what the
 * page shows; this store only remembers the last list so it can be reopened, and lives in localStorage (this
 * device only, never sent anywhere; it holds product ids, nothing about the shopper). Server render and hydration
 * see an empty list (useSyncExternalStore's server snapshot), so nothing mismatches.
 */
import { useSyncExternalStore } from "react";

import type { ProductKind } from "~/lib/dto";
import { MAX_COMPARE } from "./listing-model";

export { MAX_COMPARE };

const STORAGE_KEY = "tt:compare";
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type CompareState = { kind: ProductKind | null; ids: readonly string[] };
export type CompareAddResult = "added" | "replaced" | "full" | "present" | "invalid";

const EMPTY: CompareState = Object.freeze({ kind: null, ids: Object.freeze([]) as readonly string[] });
let state: CompareState = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function parse(text: string | null): CompareState {
  if (!text) return EMPTY;
  try {
    const value = JSON.parse(text) as { kind?: unknown; ids?: unknown };
    const ids = Array.isArray(value.ids) ? [...new Set(value.ids.filter((id): id is string => typeof id === "string" && ID.test(id)))].slice(0, MAX_COMPARE) : [];
    const kind = typeof value.kind === "string" && ids.length > 0 ? (value.kind as ProductKind) : null;
    return ids.length > 0 ? { kind, ids } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function load(): CompareState {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try {
      state = parse(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      state = EMPTY;
    }
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      state = parse(event.newValue);
      for (const listener of listeners) listener();
    });
  }
  return state;
}

function save(next: CompareState): void {
  state = next.ids.length > 0 ? next : EMPTY;
  try {
    if (state.ids.length > 0) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode / storage full: the list still works for this page view
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Read the list outside React (e.g. to build a link in an event handler). */
export const readCompare = (): CompareState => load();

/** Add a product. A product of another kind starts a new list; a full list refuses. */
export function addToCompare(item: { id: string; kind: ProductKind }): CompareAddResult {
  if (!ID.test(item.id)) return "invalid";
  const current = load();
  if (current.ids.includes(item.id)) return "present";
  if (current.kind !== null && current.kind !== item.kind) {
    save({ kind: item.kind, ids: [item.id] });
    return "replaced";
  }
  if (current.ids.length >= MAX_COMPARE) return "full";
  save({ kind: item.kind, ids: [...current.ids, item.id] });
  return "added";
}

export function removeFromCompare(id: string): void {
  const current = load();
  if (!current.ids.includes(id)) return;
  save({ kind: current.kind, ids: current.ids.filter((entry) => entry !== id) });
}

export function clearCompare(): void {
  save(EMPTY);
}

/** Make the stored list equal to what /compare shows (its URL is the source of truth). */
export function syncCompare(next: CompareState): void {
  const current = load();
  const ids = [...new Set(next.ids)].slice(0, MAX_COMPARE);
  if (current.kind === next.kind && current.ids.join("|") === ids.join("|")) return;
  save({ kind: ids.length > 0 ? next.kind : null, ids });
}

/**
 * "/compare?ids=a&ids=b" (locale-less). One `ids` per product rather than "a,b": the same text however a server or
 * browser re-encodes the query (a comma may come back as "%2C"). The page accepts both forms.
 */
export function compareHref(ids: readonly string[]): string {
  const list = ids.filter((id) => ID.test(id)).slice(0, MAX_COMPARE);
  if (list.length === 0) return "/compare";
  const params = new URLSearchParams();
  for (const id of list) params.append("ids", id);
  return `/compare?${params.toString()}`;
}

export type UseCompare = CompareState & {
  has: (id: string) => boolean;
  add: typeof addToCompare;
  remove: typeof removeFromCompare;
  clear: typeof clearCompare;
};

export function useCompare(): UseCompare {
  const current = useSyncExternalStore(subscribe, load, () => EMPTY);
  return { ...current, has: (id) => current.ids.includes(id), add: addToCompare, remove: removeFromCompare, clear: clearCompare };
}
