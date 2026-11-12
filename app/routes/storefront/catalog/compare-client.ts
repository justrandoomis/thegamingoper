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

import type { ImageRef, ProductKind } from "~/lib/dto";
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

/* ───────────────────────────── thumbnails for the tray (names and pictures; same device, same rules) ───────────────────────────── */

/** What the compare tray draws for a product: its name and its picture (a catalogue art key or an uploaded file). */
export type CompareThumb = { name: string; artKey: string | null; mediaKey: string | null };

const THUMBS_KEY = "tt:compare:items";
const NO_THUMBS: Readonly<Record<string, CompareThumb>> = Object.freeze({});
let thumbs: Readonly<Record<string, CompareThumb>> = NO_THUMBS;
let thumbsLoaded = false;

function parseThumbs(text: string | null): Readonly<Record<string, CompareThumb>> {
  if (!text) return NO_THUMBS;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, CompareThumb> = {};
    for (const [id, raw] of Object.entries(value ?? {})) {
      const entry = raw as Partial<CompareThumb> | null;
      if (!ID.test(id) || !entry || typeof entry.name !== "string") continue;
      out[id] = {
        name: entry.name.slice(0, 160),
        artKey: typeof entry.artKey === "string" ? entry.artKey.slice(0, 160) : null,
        mediaKey: typeof entry.mediaKey === "string" ? entry.mediaKey.slice(0, 200) : null,
      };
    }
    return out;
  } catch {
    return NO_THUMBS;
  }
}

function loadThumbs(): Readonly<Record<string, CompareThumb>> {
  if (!thumbsLoaded && typeof window !== "undefined") {
    thumbsLoaded = true;
    try {
      thumbs = parseThumbs(window.localStorage.getItem(THUMBS_KEY));
    } catch {
      thumbs = NO_THUMBS;
    }
  }
  return thumbs;
}

/** Keep the thumbnails of the products in the list (and only those). */
function saveThumbs(next: Record<string, CompareThumb>): void {
  const ids = new Set(load().ids);
  const kept: Record<string, CompareThumb> = {};
  for (const [id, thumb] of Object.entries(next)) if (ids.has(id)) kept[id] = thumb;
  thumbs = Object.keys(kept).length > 0 ? kept : NO_THUMBS;
  try {
    if (thumbs === NO_THUMBS) window.localStorage.removeItem(THUMBS_KEY);
    else window.localStorage.setItem(THUMBS_KEY, JSON.stringify(thumbs));
  } catch {
    // storage unavailable: the tray shows the count without pictures
  }
  for (const listener of listeners) listener();
}

/** Remember how to draw these products in the tray (the compare page and the add key know their names and pictures). */
export function rememberCompareThumbs(entries: readonly { id: string; name: string; image?: Pick<ImageRef, "artKey" | "mediaKey"> | null }[]): void {
  const next: Record<string, CompareThumb> = { ...loadThumbs() };
  let changed = false;
  for (const entry of entries) {
    if (!ID.test(entry.id) || !entry.name) continue;
    const thumb: CompareThumb = { name: entry.name, artKey: entry.image?.artKey ?? null, mediaKey: entry.image?.mediaKey ?? null };
    const before = next[entry.id];
    if (before && before.name === thumb.name && before.artKey === thumb.artKey && before.mediaKey === thumb.mediaKey) continue;
    next[entry.id] = thumb;
    changed = true;
  }
  if (changed) saveThumbs(next);
}

/** The tray's thumbnails, keyed by product id (empty on the server and while hydrating). */
export function useCompareThumbs(): Readonly<Record<string, CompareThumb>> {
  return useSyncExternalStore(subscribe, loadThumbs, () => NO_THUMBS);
}

/** Add a product. A product of another kind starts a new list; a full list refuses. `name` and `image` feed the tray. */
export function addToCompare(item: { id: string; kind: ProductKind; name?: string; image?: Pick<ImageRef, "artKey" | "mediaKey"> | null }): CompareAddResult {
  if (!ID.test(item.id)) return "invalid";
  const current = load();
  if (current.ids.includes(item.id)) return "present";
  if (current.kind !== null && current.kind !== item.kind) {
    save({ kind: item.kind, ids: [item.id] });
    if (item.name) rememberCompareThumbs([{ id: item.id, name: item.name, image: item.image }]);
    return "replaced";
  }
  if (current.ids.length >= MAX_COMPARE) return "full";
  save({ kind: item.kind, ids: [...current.ids, item.id] });
  if (item.name) rememberCompareThumbs([{ id: item.id, name: item.name, image: item.image }]);
  return "added";
}

export function removeFromCompare(id: string): void {
  const current = load();
  if (!current.ids.includes(id)) return;
  save({ kind: current.kind, ids: current.ids.filter((entry) => entry !== id) });
  saveThumbs({ ...loadThumbs() });
}

export function clearCompare(): void {
  save(EMPTY);
  saveThumbs({});
}

/** The tray's thumbnails outside React (tests, event handlers). */
export const readCompareThumbs = (): Readonly<Record<string, CompareThumb>> => loadThumbs();

/**
 * Make the stored list equal to what /compare shows (its URL is the source of truth). `items` (names and pictures)
 * feed the tray's thumbnails.
 */
export function syncCompare(next: CompareState & { items?: readonly { id: string; name: string; image?: Pick<ImageRef, "artKey" | "mediaKey"> | null }[] }): void {
  const current = load();
  const ids = [...new Set(next.ids)].slice(0, MAX_COMPARE);
  if (current.kind !== next.kind || current.ids.join("|") !== ids.join("|")) save({ kind: ids.length > 0 ? next.kind : null, ids });
  if (next.items?.length) rememberCompareThumbs(next.items);
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

/**
 * Where «افتح المقارنة» goes after an add: the list that add made. Another kind started a new list — link to it alone:
 * /compare compares the FIRST product's kind and makes this device's list equal to what it shows, so "the old ids + the
 * new one" would show the old list and undo the new one. `before` is the list as it was before the add.
 */
export function compareAfterAdd(outcome: CompareAddResult, before: readonly string[], id: string): string {
  if (outcome === "replaced") return compareHref([id]);
  if (outcome === "added") return compareHref([...before, id]);
  return compareHref(before);
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
