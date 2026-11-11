/**
 * Recent searches — kept ON THIS DEVICE ONLY (localStorage), never sent to the server, and consent-aware:
 *
 *   · the shopper's own choice on the search page ("remember my searches on this device") wins;
 *   · without one, it follows the store-wide personalisation consent (root loader `personalizationConsent`,
 *     cookie `tt_consent`): on only when the shopper agreed (true); not asked yet (null) or refused (false) → off;
 *   · switching it off deletes what was kept. At most 8 searches, each forgotten after 30 days.
 *
 *   const recent = useRecentSearches();
 *   recent.enabled · recent.items · recent.add(q) · recent.remove(q) · recent.clear() · recent.setEnabled(on)
 *
 * Server render and hydration see "off and empty" (the server snapshot), so nothing mismatches.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";

const LIST_KEY = "tt:search:recent";
const CHOICE_KEY = "tt:search:remember";
export const MAX_RECENT = 8;
export const RECENT_DAYS = 30;
const DAY_MS = 86_400_000;

type Entry = { q: string; at: number };
type Snapshot = { choice: boolean | null; items: readonly Entry[] };

const EMPTY: Snapshot = Object.freeze({ choice: null, items: Object.freeze([]) as readonly Entry[] });
let snapshot: Snapshot = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

function read(): Snapshot {
  try {
    const choiceText = window.localStorage.getItem(CHOICE_KEY);
    const choice = choiceText === "1" ? true : choiceText === "0" ? false : null;
    const raw = JSON.parse(window.localStorage.getItem(LIST_KEY) ?? "[]") as unknown;
    const now = Date.now();
    const items = Array.isArray(raw)
      ? raw
          .filter((entry): entry is Entry => !!entry && typeof (entry as Entry).q === "string" && typeof (entry as Entry).at === "number")
          .filter((entry) => entry.q.trim().length > 0 && entry.q.length <= 120 && now - entry.at < RECENT_DAYS * DAY_MS)
          .slice(0, MAX_RECENT)
      : [];
    return { choice, items };
  } catch {
    return EMPTY;
  }
}

function load(): Snapshot {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    snapshot = read();
    window.addEventListener("storage", (event) => {
      if (event.key !== LIST_KEY && event.key !== CHOICE_KEY) return;
      snapshot = read();
      emit();
    });
  }
  return snapshot;
}

function write(next: Snapshot): void {
  snapshot = next;
  try {
    if (next.choice === null) window.localStorage.removeItem(CHOICE_KEY);
    else window.localStorage.setItem(CHOICE_KEY, next.choice ? "1" : "0");
    if (next.items.length > 0) window.localStorage.setItem(LIST_KEY, JSON.stringify(next.items));
    else window.localStorage.removeItem(LIST_KEY);
  } catch {
    // storage unavailable: nothing is kept, which is the safe outcome
  }
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const sameQuery = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

export type RecentSearches = {
  /** Kept at all (the shopper's choice, else their personalisation consent). */
  enabled: boolean;
  /** Whether the shopper chose on this device (false = following the consent). */
  chosen: boolean;
  items: readonly Entry[];
  add: (q: string) => void;
  remove: (q: string) => void;
  clear: () => void;
  setEnabled: (on: boolean) => void;
};

export function useRecentSearches(): RecentSearches {
  const root = useRouteLoaderData("root") as { personalizationConsent?: boolean | null } | undefined;
  const state = useSyncExternalStore(subscribe, load, () => EMPTY);
  const enabled = state.choice ?? root?.personalizationConsent === true;
  // not allowed (any more): forget what this device kept
  useEffect(() => {
    if (!enabled && state.items.length > 0) write({ ...state, items: [] });
  }, [enabled, state]);
  return {
    enabled,
    chosen: state.choice !== null,
    items: enabled ? state.items : [],
    add: (q) => {
      const text = q.trim().slice(0, 120);
      if (!enabled || !text) return;
      const current = load();
      write({ ...current, items: [{ q: text, at: Date.now() }, ...current.items.filter((entry) => !sameQuery(entry.q, text))].slice(0, MAX_RECENT) });
    },
    remove: (q) => {
      const current = load();
      write({ ...current, items: current.items.filter((entry) => !sameQuery(entry.q, q)) });
    },
    clear: () => write({ ...load(), items: [] }),
    // turning it off forgets everything kept
    setEnabled: (on) => write({ choice: on, items: on ? load().items : [] }),
  };
}
