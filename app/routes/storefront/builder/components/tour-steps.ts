/**
 * The builder's spotlight guide — what it points at on each step, and what it remembers (docs/switch-builder.md §6.7).
 * Pure and client-safe: no React, no DOM (the page's parts are passed in as a `present` test), so the rules are tested
 * on their own (tests/switch-builder-sheet.test.ts). The words live in the `switch-builder-sheet` namespace under
 * `tour.part.<key>.title|text` (TOUR_TEXT_KEY).
 *
 * Rules
 *   · each step has its own short guide over the page's `data-tour` parts, in reading order; a part that is not on the
 *     page (not rendered, hidden, nothing to show yet) is skipped, and the counter counts only what is shown;
 *   · the guide starts by itself the first time each step is shown (once the step says it is ready) — unless the
 *     shopper is already at work on it (a key or a press since the step was shown): then the step counts as offered
 *     (seen) and only the «?» key shows its guide;
 *   · «تخطَّ» (and Escape / Android's back) turns the automatic start off for EVERY step;
 *   · finishing a step's guide only marks that step as seen; the other steps still start once;
 *   · the page's «?» key (data-tour="help") replays the current step's guide at any time, even after «تخطَّ»;
 *   · the very first guide a shopper sees ends on the «?» key, so they know where to find it again.
 *
 * Memory: localStorage `tt.sb.tour.v1` = {"off": boolean, "seen": ["device", …]} — a per-device convenience (listed in
 * the privacy policy by the integration owner); every read and write is wrapped, and without storage the guide still
 * works: this visit keeps its own copy (createTourMemory), so the guide simply starts again on the next visit.
 */
import type { BuilderStep } from "~/lib/switch-builder/types";
import { BUILDER_STEPS } from "~/lib/switch-builder/types";

/** Every part of the page the guide may point at (`data-tour="…"`), as the contract lists them. */
export const TOUR_TARGETS = [
  "steps",
  "help",
  "device-mode",
  "device-list",
  "card-list",
  "card-usable",
  "card-owned",
  "meter",
  "search",
  "filters",
  "game-card",
  "game-size",
  "game-info",
  "chosen",
  "continue",
  "review-lines",
  "review-notes",
  "add-all",
] as const;
export type TourTarget = (typeof TOUR_TARGETS)[number];

/** Each step's guide, in reading order. */
export const TOUR_STEPS: Readonly<Record<BuilderStep, readonly TourTarget[]>> = {
  device: ["steps", "device-mode", "device-list", "continue", "help"],
  memory: ["card-list", "card-usable", "card-owned", "continue"],
  games: ["meter", "search", "filters", "game-card", "game-size", "game-info", "chosen", "continue"],
  review: ["review-lines", "review-notes", "add-all"],
};

/** The message key of each part: `tour.part.<key>.title` and `tour.part.<key>.text` in `switch-builder-sheet`. */
export const TOUR_TEXT_KEY: Readonly<Record<TourTarget, string>> = {
  steps: "steps",
  help: "help",
  "device-mode": "deviceMode",
  "device-list": "deviceList",
  "card-list": "cardList",
  "card-usable": "cardUsable",
  "card-owned": "cardOwned",
  meter: "meter",
  search: "search",
  filters: "filters",
  "game-card": "gameCard",
  "game-size": "gameSize",
  "game-info": "gameInfo",
  chosen: "chosen",
  continue: "continue",
  "review-lines": "reviewLines",
  "review-notes": "reviewNotes",
  "add-all": "addAll",
};

/**
 * Parts that keep their END in view when they are taller than the room the note leaves (a phone): the review's lines
 * end on the total their note talks about. Every other part keeps its start (a list's first options, under its title).
 */
export const TOUR_KEEP_END: readonly TourTarget[] = ["review-lines"];

/** Which end of a tall part stays in view. Pure. */
export function tourKeeps(target: TourTarget): "start" | "end" {
  return TOUR_KEEP_END.includes(target) ? "end" : "start";
}

/** The CSS selector of a part. */
export function tourSelector(target: TourTarget): string {
  return `[data-tour="${target}"]`;
}

/* ───────────────────────────── memory (localStorage) ───────────────────────────── */

export const TOUR_STORAGE_KEY = "tt.sb.tour.v1";

export type TourMemory = {
  /** «تخطَّ» was pressed: no guide starts by itself any more (the «?» key still replays). */
  off: boolean;
  /** Steps whose guide has been shown once. */
  seen: BuilderStep[];
};

export const EMPTY_TOUR_MEMORY: TourMemory = { off: false, seen: [] };

const isStep = (value: unknown): value is BuilderStep => typeof value === "string" && (BUILDER_STEPS as readonly string[]).includes(value);

/** The stored text, checked field by field; anything else is a fresh memory. Pure. */
export function parseTourMemory(text: string | null | undefined): TourMemory {
  if (!text) return EMPTY_TOUR_MEMORY;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return EMPTY_TOUR_MEMORY;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_TOUR_MEMORY;
  const record = value as { off?: unknown; seen?: unknown };
  const stored = Array.isArray(record.seen) ? record.seen.filter(isStep) : [];
  return { off: record.off === true, seen: BUILDER_STEPS.filter((step) => stored.includes(step)) };
}

export function serializeTourMemory(memory: TourMemory): string {
  return JSON.stringify({ off: memory.off, seen: BUILDER_STEPS.filter((step) => memory.seen.includes(step)) });
}

/** The browser's localStorage, or null where it is blocked (private modes, sandboxed frames) or on the server. */
export function tourStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readTourMemory(storage: Pick<Storage, "getItem"> | null | undefined): TourMemory {
  if (!storage) return EMPTY_TOUR_MEMORY;
  try {
    return parseTourMemory(storage.getItem(TOUR_STORAGE_KEY));
  } catch {
    return EMPTY_TOUR_MEMORY;
  }
}

/** False when the browser refused to store it (the guide still works for this visit). */
export function writeTourMemory(storage: Pick<Storage, "setItem"> | null | undefined, memory: TourMemory): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TOUR_STORAGE_KEY, serializeTourMemory(memory));
    return true;
  } catch {
    return false;
  }
}

export function withSeen(memory: TourMemory, step: BuilderStep): TourMemory {
  return memory.seen.includes(step) ? memory : { ...memory, seen: [...memory.seen, step] };
}

/** «تخطَّ»: the guide no longer starts by itself on any step. */
export function withOff(memory: TourMemory): TourMemory {
  return memory.off ? memory : { ...memory, off: true };
}

/** Should this step's guide start by itself now? */
export function shouldAutoStart(memory: TourMemory, step: BuilderStep): boolean {
  return !memory.off && !memory.seen.includes(step);
}

/** Two memories as one: off when either is off, and every step that either has seen. Pure. */
export function mergeTourMemory(a: TourMemory, b: TourMemory): TourMemory {
  return { off: a.off || b.off, seen: BUILDER_STEPS.filter((step) => a.seen.includes(step) || b.seen.includes(step)) };
}

export interface TourMemoryStore {
  /** What the browser stored, merged with what this visit already did. */
  read(): TourMemory;
  /** Change the memory: kept for this visit, and stored when the browser lets us. Returns the new memory. */
  update(change: (memory: TourMemory) => TourMemory): TourMemory;
}

/**
 * The guide's memory: localStorage when it works, plus this visit's own copy. The copy matters when storage is blocked
 * or full: without it a guide that has just closed — even after «تخطَّ» — would find nothing remembered and start by
 * itself again at once, over and over. `storage` is read on every call (it may be blocked at any time).
 */
export function createTourMemory(storage: () => Pick<Storage, "getItem" | "setItem"> | null): TourMemoryStore {
  let visit: TourMemory = EMPTY_TOUR_MEMORY;
  const read = () => mergeTourMemory(readTourMemory(storage()), visit);
  return {
    read,
    update(change) {
      const next = change(read());
      visit = mergeTourMemory(visit, next);
      writeTourMemory(storage(), next);
      return next;
    },
  };
}

/**
 * The parts this step's guide shows, in order: only those on the page now (`present`). The first guide a shopper ever
 * sees (`first`) also ends on the «?» key, wherever it is not already part of that step's guide.
 */
export function tourTargets(step: BuilderStep, present: (target: TourTarget) => boolean, options: { first?: boolean } = {}): TourTarget[] {
  const wanted = [...TOUR_STEPS[step]];
  if (options.first && !wanted.includes("help")) wanted.push("help");
  return wanted.filter((target) => present(target));
}

/* ───────────────────────────── the guide's state ───────────────────────────── */

export type TourState =
  | { status: "closed" }
  | { status: "open"; step: BuilderStep; targets: TourTarget[]; index: number; mode: "auto" | "replay"; run: number };

export const CLOSED_TOUR: TourState = { status: "closed" };

export type TourAction =
  | { type: "start"; step: BuilderStep; targets: TourTarget[]; mode: "auto" | "replay" }
  | { type: "next" }
  | { type: "back" }
  /** The part on screen left the page: drop it and show the next one (or close when none is left). */
  | { type: "drop"; target: TourTarget }
  /** «تخطَّ», Escape, Android's back, the last «التالي», or the step changed. */
  | { type: "close" };

export function tourReducer(state: TourState, action: TourAction): TourState {
  switch (action.type) {
    case "start":
      if (action.targets.length === 0) return state;
      return { status: "open", step: action.step, targets: action.targets, index: 0, mode: action.mode, run: (state.status === "open" ? state.run : 0) + 1 };
    case "next":
      if (state.status !== "open") return state;
      return state.index + 1 < state.targets.length ? { ...state, index: state.index + 1 } : CLOSED_TOUR;
    case "back":
      if (state.status !== "open" || state.index === 0) return state;
      return { ...state, index: state.index - 1 };
    case "drop": {
      if (state.status !== "open") return state;
      const at = state.targets.indexOf(action.target);
      if (at === -1) return state;
      const targets = state.targets.filter((target) => target !== action.target);
      // the part on screen was the last one: the guide is done
      if (targets.length === 0 || (at === state.index && at >= targets.length)) return CLOSED_TOUR;
      // a part before the one on screen left: the same part stays on screen; the part on screen left: the next one
      return { ...state, targets, index: at < state.index ? state.index - 1 : state.index };
    }
    case "close":
      return CLOSED_TOUR;
  }
}
