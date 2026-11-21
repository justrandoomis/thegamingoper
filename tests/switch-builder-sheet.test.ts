/**
 * The Switch builder's long press, spotlight guide and game details sheet (docs/switch-builder.md §6.5–6.7):
 *
 *   · useLongPress's timing (createLongPress, fake timers): fires at 450 ms, never before; cancelled by movement,
 *     pointercancel, leaving and scrolling; swallows exactly the click that follows a hold and forgets it when none
 *     comes; prevents the touch context menu only;
 *   · the guide's rules (tour-steps): missing parts are skipped, «تخطَّ» is remembered and stops the automatic start on
 *     every step, replay works after it, a broken storage never throws, the cut-out path;
 *   · the sheet as the server renders its body and foot (the kit Sheet itself is client only), in its main states:
 *     details loading / error / none, sized / unsized, fits / does not fit (both figures, two decimals when one would
 *     look equal), chosen / not chosen, cartridge vs digital, licensed score present / absent, the Wikipedia
 *     attribution, TamTam's description first, the English fallback, the click-to-load trailer.
 */
import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import switchBuilderSheet from "~/i18n/messages/switch-builder-sheet";
import { messagesFor } from "~/i18n/i18n.server";
import type { MessageTree } from "~/i18n/translate";
import { LOCALE_CODES, LOCALES, localePath, type Locale } from "~/lib/locales";
import { DEFAULT_PREFS, PrefsProvider, type Prefs } from "~/lib/prefs";
import { bytesFromGiB, GIB } from "~/lib/switch-builder/storage";
import { BUILDER_STEPS, type CatalogOption, type GameDetails, type LibraryExtras, type LibraryGame } from "~/lib/switch-builder/types";
import {
  aboutFor,
  defaultFormat,
  fitFor,
  GameSheetBody,
  GameSheetFoot,
  gameSheetModel,
  isoDay,
  localTitle,
  WIKIPEDIA_LICENCE_URL,
  type GameSheetInput,
  type GameSheetView,
} from "~/routes/storefront/builder/components/GameSheet";
import { holeAround, spotlightClip } from "~/routes/storefront/builder/components/SpotlightTour";
import {
  CLOSED_TOUR,
  createTourMemory,
  EMPTY_TOUR_MEMORY,
  mergeTourMemory,
  parseTourMemory,
  readTourMemory,
  shouldAutoStart,
  TOUR_STEPS,
  TOUR_STORAGE_KEY,
  TOUR_TARGETS,
  TOUR_TEXT_KEY,
  tourReducer,
  tourTargets,
  withOff,
  withSeen,
  writeTourMemory,
  type TourState,
  type TourTarget,
} from "~/routes/storefront/builder/components/tour-steps";
import { trailerSrc } from "~/routes/storefront/builder/components/TrailerEmbed";
import { createLongPress, LONG_PRESS_CLICK_WINDOW_MS, LONG_PRESS_DELAY_MS, LONG_PRESS_SWALLOW_MAX_MS, type PressPoint } from "~/routes/storefront/builder/lib/use-long-press";

/* ───────────────────────────── long press ───────────────────────────── */

const point = (over: Partial<PressPoint> = {}): PressPoint => ({ pointerId: 1, pointerType: "touch", button: 0, isPrimary: true, clientX: 100, clientY: 200, ...over });

function cancelable() {
  const event = {
    prevented: false,
    stopped: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
  };
  return event;
}

describe("useLongPress — the hold that opens a game's details", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once at 450 ms and not a millisecond before", () => {
    expect(LONG_PRESS_DELAY_MS).toBe(450);
    const onLongPress = vi.fn();
    const press = createLongPress(() => ({ onLongPress }), null);
    press.down(point());
    expect(press.pressing).toBe(true);
    vi.advanceTimersByTime(449);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(press.pressing).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("a quick tap never fires, and its click goes through untouched", () => {
    const onLongPress = vi.fn();
    const press = createLongPress(() => ({ onLongPress }), null);
    press.down(point());
    vi.advanceTimersByTime(200);
    press.up();
    vi.advanceTimersByTime(1000);
    const click = cancelable();
    press.click(click);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(click.prevented).toBe(false);
    expect(click.stopped).toBe(false);
  });

  it("moving more than 6 px cancels the hold; a 6 px jitter does not", () => {
    const onLongPress = vi.fn();
    const press = createLongPress(() => ({ onLongPress }), null);
    press.down(point());
    press.move(point({ clientX: 104, clientY: 204 })); // 5.7 px
    press.move(point({ clientX: 106, clientY: 200 })); // exactly 6 px
    vi.advanceTimersByTime(450);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    press.down(point());
    press.move(point({ clientX: 100, clientY: 207 })); // 7 px: a scroll starting
    vi.advanceTimersByTime(1000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // another pointer's movement is not this hold's
    press.down(point());
    press.move(point({ pointerId: 2, clientX: 400 }));
    vi.advanceTimersByTime(450);
    expect(onLongPress).toHaveBeenCalledTimes(2);
  });

  it("pointercancel and leaving the card cancel the hold", () => {
    const onLongPress = vi.fn();
    const press = createLongPress(() => ({ onLongPress }), null);
    press.down(point());
    vi.advanceTimersByTime(300);
    press.cancel(); // pointercancel: the browser took the gesture for a scroll
    vi.advanceTimersByTime(1000);
    press.down(point({ pointerType: "mouse" }));
    vi.advanceTimersByTime(300);
    press.cancel(); // pointerleave
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("any scroll during the hold cancels it (a capturing listener, removed again)", () => {
    const onLongPress = vi.fn();
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const press = createLongPress(() => ({ onLongPress }), target);
    press.down(point());
    expect(add).toHaveBeenCalledWith("scroll", expect.any(Function), expect.objectContaining({ capture: true, passive: true }));
    target.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), expect.objectContaining({ capture: true }));
  });

  it("swallows exactly the click that follows a fired hold — so the hold never also toggles the card", () => {
    const onLongPress = vi.fn();
    const press = createLongPress(() => ({ onLongPress }), null);
    press.down(point({ pointerType: "mouse" }));
    vi.advanceTimersByTime(450);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(press.swallowing).toBe(true);
    press.up();
    const first = cancelable();
    press.click(first);
    expect(first.prevented).toBe(true);
    expect(first.stopped).toBe(true);
    const second = cancelable();
    press.click(second);
    expect(second.prevented).toBe(false);
  });

  it("forgets the swallow when no click comes (Android after a long press), so a later keyboard click is not eaten", () => {
    const press = createLongPress(() => ({ onLongPress: () => undefined }), null);
    press.down(point());
    vi.advanceTimersByTime(450);
    press.up();
    vi.advanceTimersByTime(LONG_PRESS_CLICK_WINDOW_MS);
    expect(press.swallowing).toBe(false);
    const keyboard = cancelable();
    press.click(keyboard);
    expect(keyboard.prevented).toBe(false);

    // and a new press forgets it at once
    press.down(point());
    vi.advanceTimersByTime(450);
    press.down(point());
    press.up();
    const tap = cancelable();
    press.click(tap);
    expect(tap.prevented).toBe(false);
  });

  it("swallows the release click wherever it lands — the sheet's scrim now lies over the card — and only that one", () => {
    const win = new EventTarget();
    const press = createLongPress(() => ({ onLongPress: () => undefined }), win);
    press.down(point());
    vi.advanceTimersByTime(450);
    // the window's capturing listener runs before React's root: stopping it there keeps the scrim's onClick from running
    const release = new Event("click", { cancelable: true });
    win.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(true);
    expect(release.cancelBubble).toBe(true);
    expect(press.swallowing).toBe(false);
    const next = new Event("click", { cancelable: true });
    win.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    expect(next.cancelBubble).toBe(false);
  });

  it("forgets the swallow once the pointer comes up anywhere, and never keeps it longer than its limit", () => {
    const win = new EventTarget();
    const press = createLongPress(() => ({ onLongPress: () => undefined }), win);
    press.down(point({ pointerType: "mouse" }));
    vi.advanceTimersByTime(450);
    win.dispatchEvent(new Event("pointerup")); // released over the sheet, not over the inert card
    vi.advanceTimersByTime(LONG_PRESS_CLICK_WINDOW_MS - 1);
    expect(press.swallowing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(press.swallowing).toBe(false);
    const keyboard = new Event("click", { cancelable: true }); // Enter on the card the sheet gave the focus back to
    win.dispatchEvent(keyboard);
    expect(keyboard.defaultPrevented).toBe(false);

    press.down(point());
    vi.advanceTimersByTime(450); // fired, and the finger stays down, the release never seen
    vi.advanceTimersByTime(LONG_PRESS_SWALLOW_MAX_MS);
    expect(press.swallowing).toBe(false);
  });

  it("a new press anywhere means the hold's click is not coming: a quick tap on the opened sheet is never eaten", () => {
    const win = new EventTarget();
    const press = createLongPress(() => ({ onLongPress: () => undefined }), win);
    press.down(point());
    vi.advanceTimersByTime(450);
    win.dispatchEvent(new Event("pointerup")); // Android: the release, and no click after a long press
    // a second finger of the same hand is not a new press
    win.dispatchEvent(Object.assign(new Event("pointerdown"), { isPrimary: false }));
    expect(press.swallowing).toBe(true);
    win.dispatchEvent(Object.assign(new Event("pointerdown"), { isPrimary: true })); // 150 ms later: «أضف إلى جهازي»
    expect(press.swallowing).toBe(false);
    const tap = new Event("click", { cancelable: true });
    win.dispatchEvent(tap);
    expect(tap.defaultPrevented).toBe(false);
    expect(tap.cancelBubble).toBe(false);
  });

  it("prevents the touch long-press menu; a mouse's right click keeps the browser's menu", () => {
    const press = createLongPress(() => ({ onLongPress: () => undefined }), null);
    press.down(point({ pointerType: "touch" }));
    const touchMenu = cancelable();
    press.contextMenu(touchMenu);
    expect(touchMenu.prevented).toBe(true);
    press.cancel();

    press.down(point({ pointerType: "mouse", button: 2 }));
    expect(press.pressing).toBe(false);
    const mouseMenu = cancelable();
    press.contextMenu(mouseMenu);
    expect(mouseMenu.prevented).toBe(false);
  });

  it("only the primary pointer starts a hold, a second finger cancels it, and a disabled card never fires", () => {
    const onLongPress = vi.fn();
    let disabled = false;
    const press = createLongPress(() => ({ onLongPress, disabled }), null);
    press.down(point());
    press.down(point({ pointerId: 2, isPrimary: false })); // a pinch
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();

    disabled = true;
    press.down(point());
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();

    // disabled while being held: it does not fire either
    disabled = false;
    press.down(point());
    disabled = true;
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(press.swallowing).toBe(false);
  });

  it("takes its own delay and tolerance, and reads the newest callback", () => {
    let calls = "";
    let onLongPress = () => {
      calls += "a";
    };
    const press = createLongPress(() => ({ onLongPress, delayMs: 300, moveTolerancePx: 20 }), null);
    press.down(point());
    press.move(point({ clientX: 115 }));
    onLongPress = () => {
      calls += "b";
    };
    vi.advanceTimersByTime(300);
    expect(calls).toBe("b");
  });
});

/* ───────────────────────────── the guide ───────────────────────────── */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const openState = (state: TourState) => {
  if (state.status !== "open") throw new Error("the guide is closed");
  return state;
};

describe("the spotlight guide's rules", () => {
  it("every part it points at is one the contract lists, with its words in ar, en and ckb", () => {
    for (const step of BUILDER_STEPS) {
      expect(TOUR_STEPS[step].length, step).toBeGreaterThan(0);
      for (const target of TOUR_STEPS[step]) expect(TOUR_TARGETS).toContain(target);
    }
    for (const locale of LOCALE_CODES) {
      const tour = (switchBuilderSheet[locale] as unknown as { tour: { part: Record<string, { title: string; text: string }> } }).tour;
      for (const target of TOUR_TARGETS) {
        const words = tour.part[TOUR_TEXT_KEY[target]];
        expect(words?.title?.trim(), `${locale} ${target}`).toBeTruthy();
        expect(words?.text?.trim(), `${locale} ${target}`).toBeTruthy();
      }
    }
  });

  it("skips the parts that are not on the page, and counts only the ones it shows", () => {
    const onPage = new Set<TourTarget>(["meter", "game-card", "game-size", "continue"]);
    const targets = tourTargets("games", (target) => onPage.has(target));
    expect(targets).toEqual(["meter", "game-card", "game-size", "continue"]);

    let state = tourReducer(CLOSED_TOUR, { type: "start", step: "games", targets, mode: "auto" });
    expect(openState(state)).toMatchObject({ index: 0, targets });
    for (let i = 1; i < targets.length; i++) {
      state = tourReducer(state, { type: "next" });
      expect(openState(state).index).toBe(i);
    }
    expect(tourReducer(state, { type: "next" })).toEqual(CLOSED_TOUR); // past the last part: done
    // nothing on the page: nothing opens
    expect(tourReducer(CLOSED_TOUR, { type: "start", step: "games", targets: tourTargets("games", () => false), mode: "auto" })).toEqual(CLOSED_TOUR);
  });

  it("a part that leaves the page while the guide is open is dropped; the guide goes on or ends", () => {
    let state = tourReducer(CLOSED_TOUR, { type: "start", step: "memory", targets: ["card-list", "card-usable", "card-owned"], mode: "auto" });
    state = tourReducer(state, { type: "next" }); // on card-usable
    state = tourReducer(state, { type: "drop", target: "card-usable" });
    expect(openState(state)).toMatchObject({ index: 1, targets: ["card-list", "card-owned"] }); // the next part
    state = tourReducer(state, { type: "drop", target: "card-list" });
    expect(openState(state)).toMatchObject({ index: 0, targets: ["card-owned"] }); // the same part stays on screen
    expect(tourReducer(state, { type: "drop", target: "card-owned" })).toEqual(CLOSED_TOUR);
    // «السابق» stops at the first part
    expect(openState(tourReducer(state, { type: "back" })).index).toBe(0);
  });

  it("the first guide a shopper ever sees ends on the «?» key", () => {
    const all = () => true;
    expect(tourTargets("games", all, { first: true }).at(-1)).toBe("help");
    expect(tourTargets("games", all, { first: false })).not.toContain("help");
    expect(tourTargets("device", all, { first: true }).filter((target) => target === "help")).toHaveLength(1);
  });

  it("starts by itself once per step; «تخطَّ» is remembered and stops the automatic start on every step", () => {
    const storage = new MemoryStorage();
    expect(readTourMemory(storage)).toEqual(EMPTY_TOUR_MEMORY);
    for (const step of BUILDER_STEPS) expect(shouldAutoStart(readTourMemory(storage), step)).toBe(true);

    writeTourMemory(storage, withSeen(readTourMemory(storage), "device"));
    expect(shouldAutoStart(readTourMemory(storage), "device")).toBe(false);
    expect(shouldAutoStart(readTourMemory(storage), "memory")).toBe(true);

    writeTourMemory(storage, withOff(readTourMemory(storage)));
    expect(storage.getItem(TOUR_STORAGE_KEY)).toBe('{"off":true,"seen":["device"]}');
    for (const step of BUILDER_STEPS) expect(shouldAutoStart(readTourMemory(storage), step)).toBe(false);
  });

  it("replay works after «تخطَّ»: the guide opens again from its first part, and again while open", () => {
    const targets: TourTarget[] = ["review-lines", "review-notes", "add-all"];
    let state = tourReducer(CLOSED_TOUR, { type: "start", step: "review", targets, mode: "replay" });
    expect(openState(state)).toMatchObject({ mode: "replay", index: 0, run: 1 });
    state = tourReducer(state, { type: "next" });
    state = tourReducer(state, { type: "start", step: "review", targets, mode: "replay" });
    expect(openState(state)).toMatchObject({ index: 0, run: 2 });
    expect(tourReducer(state, { type: "close" })).toEqual(CLOSED_TOUR);
  });

  it("without storage (blocked or full) the visit still remembers: a guide that closed never starts again by itself", () => {
    const blocked = {
      getItem(): string | null {
        throw new Error("SecurityError");
      },
      setItem(): void {
        throw new Error("QuotaExceededError");
      },
    };
    const memory = createTourMemory(() => blocked);
    expect(shouldAutoStart(memory.read(), "device")).toBe(true);
    memory.update((current) => withSeen(current, "device")); // the device guide was shown
    expect(shouldAutoStart(memory.read(), "device")).toBe(false);
    expect(shouldAutoStart(memory.read(), "memory")).toBe(true);
    memory.update(withOff); // «تخطَّ»
    for (const step of BUILDER_STEPS) expect(shouldAutoStart(memory.read(), step)).toBe(false);

    // with a working storage, what is stored and what this visit did are one memory
    const storage = new MemoryStorage();
    storage.setItem(TOUR_STORAGE_KEY, '{"off":false,"seen":["games"]}');
    const both = createTourMemory(() => storage);
    both.update((current) => withSeen(current, "device"));
    expect(storage.getItem(TOUR_STORAGE_KEY)).toBe('{"off":false,"seen":["device","games"]}');
    storage.setItem(TOUR_STORAGE_KEY, "{"); // cleared or broken mid-visit
    expect(both.read()).toEqual({ off: false, seen: ["device", "games"] });
    expect(mergeTourMemory({ off: true, seen: ["review"] }, { off: false, seen: ["device"] })).toEqual({ off: true, seen: ["device", "review"] });
  });

  it("a blocked or broken storage never throws, and odd values read as a fresh memory", () => {
    const blocked = {
      getItem(): string | null {
        throw new Error("SecurityError");
      },
      setItem(): void {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readTourMemory(blocked)).toEqual(EMPTY_TOUR_MEMORY);
    expect(writeTourMemory(blocked, withOff(EMPTY_TOUR_MEMORY))).toBe(false);
    expect(readTourMemory(null)).toEqual(EMPTY_TOUR_MEMORY);
    for (const odd of ["", "{", "[]", "null", '"off"', '{"off":"yes","seen":"device"}', '{"seen":["device","nope",3]}']) {
      const memory = parseTourMemory(odd);
      expect(memory.off, odd).toBe(false);
      expect(memory.seen.every((step) => BUILDER_STEPS.includes(step)), odd).toBe(true);
    }
    expect(parseTourMemory('{"off":true,"seen":["games","device","games"]}')).toEqual({ off: true, seen: ["device", "games"] });
  });

  it("the dim's cut-out is the viewport minus a rounded hole kept on screen (no box-shadow spread)", () => {
    const hole = holeAround({ left: -20, top: 100, right: 200, bottom: 140 }, { width: 390, height: 844 });
    expect(hole).toEqual({ left: 4, top: 92, right: 208, bottom: 148 });
    const clip = spotlightClip({ width: 390, height: 844 }, hole, 20);
    expect(clip.startsWith('path(evenodd, "M0 0H390V844H0Z M24 92H188A20 20 0 0 1 208 112')).toBe(true);
    // a radius larger than half the hole is cut to fit
    expect(spotlightClip({ width: 100, height: 100 }, { left: 10, top: 10, right: 30, bottom: 20 }, 40)).toContain("A5 5 0 0 1");
  });
});

/* ───────────────────────────── the details sheet ───────────────────────────── */

const GAME: LibraryGame = {
  id: "the-legend-of-zelda-tears-of-the-kingdom-switch",
  qid: "Q55584563",
  title: "The Legend of Zelda: Tears of the Kingdom",
  titleAr: "أسطورة زيلدا: دموع المملكة",
  year: 2023,
  publishers: ["Nintendo"],
  genres: ["adventure", "action"],
  modes: ["single"],
  popularity: 80,
  chunk: 3,
  metacriticSlug: "the-legend-of-zelda-tears-of-the-kingdom",
};

const EXTRAS: LibraryExtras = {
  sizeBytes: bytesFromGiB(16.5),
  cartridgeBytes: bytesFromGiB(1.2),
  sizeAsOf: "2026-11-20",
  priceUsdCents: 6999,
  priceAsOf: "2026-11-19",
};

const DETAILS: GameDetails = {
  id: GAME.id,
  developers: ["Nintendo EPD"],
  wikipedia: {
    en: { text: "Tears of the Kingdom is a 2023 action-adventure game.", title: "The Legend of Zelda: Tears of the Kingdom", url: "https://en.wikipedia.org/wiki/The_Legend_of_Zelda:_Tears_of_the_Kingdom", asOf: "2026-11-21" },
    ar: { text: "دموع المملكة لعبة مغامرات صدرت سنة 2023.", title: "ذا ليجند أوف زيلدا: تيرز أوف ذا كينغدم", url: "https://ar.wikipedia.org/wiki/x", asOf: "2026-11-21" },
  },
};

const CARTRIDGE: CatalogOption = { variantId: "var_zelda", productSlug: "zelda-totk", name: "Zelda TotK", priceIqd: 85000, orderable: true };

/** The page's genre and play-mode words (the storefront-ui owner's namespace; only what the sheet reads). */
const PAGE_WORDS: Record<Locale, MessageTree> = {
  ar: { genre: { adventure: "مغامرة", action: "حركة" }, mode: { single: "لاعب واحد" } },
  en: { genre: { adventure: "Adventure", action: "Action" }, mode: { single: "Single player" } },
  ckb: { genre: { adventure: "سەرکێشی", action: "ئاکشن" }, mode: { single: "یەک یاریزان" } },
};

function viewOf(over: Partial<GameSheetInput> = {}, locale: Locale = "ar"): GameSheetView {
  const input: GameSheetInput = { game: GAME, extras: EXTRAS, details: DETAILS, cartridge: null, selected: null, remainingBytes: 100 * GIB, locale, ...over };
  return { ...input, model: gameSheetModel(input), onFormat: () => undefined };
}

/** The body and the pinned foot as the server renders them, isolates removed so figures read plainly. */
function renderSheet(view: GameSheetView, locale: Locale = "ar", prefs: Prefs = DEFAULT_PREFS): string {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      children: [
        {
          id: "page",
          path: "*",
          Component: () =>
            createElement(PrefsProvider, {
              value: prefs,
              children: createElement(Fragment, null, createElement(GameSheetBody, { view }), createElement(GameSheetFoot, { view, onAdd: () => undefined, onRemove: () => undefined })),
            }),
        },
      ],
    },
  ]);
  const html = renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [localePath("/build/switch?step=games", locale)],
      hydrationData: {
        loaderData: {
          root: { locale, dir: LOCALES[locale].dir, fx: null, i18n: messagesFor(locale, "common", "ui", "ui-shop", "ui-overlays") },
          page: { i18n: { ...messagesFor(locale, "switch-builder-sheet"), "switch-builder": PAGE_WORDS[locale] } },
        },
      },
    }),
  );
  return html.replace(/[⁦-⁩]/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

const NB = " ";

describe("the game details sheet — decisions", () => {
  it("a game TamTam sells as an orderable cartridge starts as a cartridge, any other as digital", () => {
    expect(defaultFormat(CARTRIDGE, null)).toBe("cartridge");
    expect(defaultFormat({ ...CARTRIDGE, orderable: false, reason: "out_of_stock" }, null)).toBe("digital");
    expect(defaultFormat(null, null)).toBe("digital");
    expect(defaultFormat(CARTRIDGE, { format: "digital" })).toBe("digital");
  });

  it("fits on exact bytes, and says both figures with two decimals when one would look equal", () => {
    expect(fitFor(null, GIB, false)).toEqual({ kind: "unsized" });
    expect(fitFor(GIB, GIB, false)).toEqual({ kind: "fits", need: GIB, left: 0 });
    expect(fitFor(GIB + 1, GIB, false)).toMatchObject({ kind: "full", digits: 2 });
    expect(fitFor(bytesFromGiB(20), bytesFromGiB(6), false)).toMatchObject({ kind: "full", digits: 1 });
    expect(fitFor(bytesFromGiB(20), bytesFromGiB(6), true)).toMatchObject({ kind: "chosen", left: bytesFromGiB(-14) });
    expect(fitFor(null, GIB, true)).toEqual({ kind: "chosen", need: null, left: null });
  });

  it("description: TamTam's in the page language first, then Wikipedia's, then English — waiting while it loads", () => {
    const own = { ...EXTRAS, description: { ar: "وصف طمطم.", en: "TamTam's words." } };
    expect(aboutFor(own, DETAILS, "ar")).toEqual({ kind: "tamtam", text: "وصف طمطم.", lang: "ar" });
    expect(aboutFor(own, "loading", "ar")).toMatchObject({ kind: "tamtam" }); // no need to wait
    expect(aboutFor(EXTRAS, "loading", "ar")).toEqual({ kind: "loading" });
    expect(aboutFor(EXTRAS, DETAILS, "ar")).toMatchObject({ kind: "wikipedia", lang: "ar" });
    expect(aboutFor(EXTRAS, DETAILS, "ckb")).toMatchObject({ kind: "wikipedia", lang: "en" });
    expect(aboutFor(own, DETAILS, "ckb")).toEqual({ kind: "tamtam", text: "TamTam's words.", lang: "en" });
    expect(aboutFor(EXTRAS, "error", "ar")).toEqual({ kind: "error" });
    expect(aboutFor(own, "error", "ckb")).toMatchObject({ kind: "tamtam", lang: "en" });
    expect(aboutFor(EXTRAS, null, "en")).toEqual({ kind: "none" });
  });

  it("links out by plain URLs only (eShop page, Metacritic page, Wikipedia article)", () => {
    const model = viewOf().model;
    expect(model.eshopUrl).toBe(`https://www.nintendo.com/us/store/products/${GAME.id}/`);
    expect(model.metacriticUrl).toBe("https://www.metacritic.com/game/the-legend-of-zelda-tears-of-the-kingdom/");
    expect(model.wikipediaUrl).toBe("https://ar.wikipedia.org/wiki/x");
    expect(viewOf({}, "ckb").model.wikipediaUrl).toBe(DETAILS.wikipedia?.en?.url);
    expect(viewOf({ game: { ...GAME, metacriticSlug: undefined }, details: null }).model).toMatchObject({ metacriticUrl: null, wikipediaUrl: null });
  });

  it("titles and dates", () => {
    expect(localTitle(GAME, "ar")).toEqual({ text: "أسطورة زيلدا: دموع المملكة", lang: "ar" });
    expect(localTitle(GAME, "ckb")).toEqual({ text: "أسطورة زيلدا: دموع المملكة", lang: "ar" });
    expect(localTitle({ ...GAME, titleCkb: "زێلدا" }, "ckb")).toEqual({ text: "زێلدا", lang: "ckb" });
    expect(localTitle(GAME, "en")).toBeNull();
    expect(isoDay("2026-11-21")).toBe(Date.UTC(2026, 10, 21, 12));
    expect(isoDay("21/11/2026")).toBeNull();
    expect(isoDay(undefined)).toBeNull();
  });

  it("the YouTube player address is built only for a real video id", () => {
    expect(trailerSrc("dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1");
    expect(trailerSrc("javascript:alert(1)")).toBeNull();
    expect(trailerSrc("dQw4w9WgXcQ&list=x")).toBeNull();
  });
});

describe("the game details sheet — server render of its states", () => {
  it("sized, fits, not chosen: the full size, why it is bigger, saves stay on the console, the add key", () => {
    const html = renderSheet(viewOf());
    expect(html).toContain(`16.5${NB}GB`);
    expect(html).toContain("الرقم هو حجم اللعبة بعد تثبيت آخر تحديث");
    expect(html).toContain("ملفات الحفظ لا تُحسب");
    expect(html).toContain("قسنا الحجم على أجهزة طمطم بتاريخ 20/11/2026.");
    expect(html).toContain(`تتّسع: يبقى بعدها 83.5${NB}GB.`);
    expect(html).toContain("أضف إلى جهازي");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*أضف إلى جهازي/);
    // year · publisher · developer, the genre and play-mode words
    expect(html).toContain("2023");
    expect(html).toContain("Nintendo EPD");
    expect(html).toContain("مغامرة");
    expect(html).toContain("لاعب واحد");
    // the eShop price is the US eShop's, with its date
    expect(html).toContain("سعر النسخة الرقمية في Nintendo eShop الأمريكي: $69.99، بتاريخ 19/11/2026.");
  });

  it("unsized: no figure is invented, the key rests with its reason", () => {
    const html = renderSheet(viewOf({ extras: { priceUsdCents: 1999 } }));
    expect(html).toContain("لم يُضف بعد");
    expect(html).toContain("لم نضف حجم هذه اللعبة بعد، فلا يمكن أن تدخل في حساب المساحة.");
    expect(html).toContain("لم يُضف حجمها بعد، فلا يمكن اختيارها.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*أضف إلى جهازي/);
    expect(html).not.toContain("GB.");
  });

  it("does not fit: both figures, with two decimals where one decimal would print the same number", () => {
    const close = renderSheet(viewOf({ extras: { sizeBytes: bytesFromGiB(6.04) }, remainingBytes: bytesFromGiB(6.01) }));
    expect(close).toContain(`لا تتّسع: تحتاج 6.04${NB}GB، والمتبقي 6.01${NB}GB.`);
    expect(close).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*أضف إلى جهازي/);
    const far = renderSheet(viewOf({ extras: { sizeBytes: bytesFromGiB(20) }, remainingBytes: bytesFromGiB(6) }), "en");
    expect(far).toContain(`Does not fit: it needs 20.0${NB}GB and 6.0${NB}GB is left.`);
  });

  it("chosen: the same key now removes it, and says what it takes", () => {
    const html = renderSheet(viewOf({ selected: { format: "digital" }, remainingBytes: bytesFromGiB(40) }));
    expect(html).toContain("أزلها من جهازي");
    expect(html).not.toContain("أضف إلى جهازي");
    expect(html).toContain(`في جهازك: تأخذ 16.5${NB}GB، ويبقى 23.5${NB}GB.`);
  });

  it("cartridge vs digital: the choice only when TamTam sells the cartridge, each with its space and price", () => {
    const digitalOnly = renderSheet(viewOf());
    expect(digitalOnly).not.toContain("كيف ستشتريها");
    expect(digitalOnly).not.toContain("الشريط");

    const both = renderSheet(viewOf({ cartridge: CARTRIDGE }));
    expect(both).toContain("كيف ستشتريها");
    expect(both).toContain("شريط من طمطم");
    expect(both).toContain("نسخة رقمية من eShop");
    expect(both).toContain(`يأخذ 1.2${NB}GB على الجهاز للتحديثات`);
    expect(both).toContain(`تأخذ 16.5${NB}GB على الجهاز`);
    expect(both).toContain("85,000");
    // the cartridge is the default when it can be ordered: the fit is about its space
    expect(both).toContain(`تتّسع: يبقى بعدها 98.8${NB}GB.`);

    // a cartridge not measured yet is counted at the full size, and says so
    const unmeasured = renderSheet(viewOf({ cartridge: CARTRIDGE, extras: { ...EXTRAS, cartridgeBytes: undefined } }));
    expect(unmeasured).toContain("نحسبه بالحجم الكامل حتى نقيس الشريط");
    expect(unmeasured).toContain(`نحسبه 16.5${NB}GB، بالحجم الكامل، حتى نقيسه`);

    // chosen as a cartridge, the digital copy that does not fit cannot be picked, and says why
    const tight = renderSheet(viewOf({ cartridge: CARTRIDGE, selected: { format: "cartridge" }, remainingBytes: bytesFromGiB(5) }));
    expect(tight).toContain(`لا تتّسع: تحتاج 16.5${NB}GB، والمتبقي 5.0${NB}GB`);
    expect(tight).toMatch(/<input[^>]*value="digital"[^>]*disabled=""|<input[^>]*disabled=""[^>]*value="digital"/);

    // sold out: the words, no price
    const out = renderSheet(viewOf({ cartridge: { ...CARTRIDGE, orderable: false, reason: "out_of_stock" } }));
    expect(out).toContain("نفد حالياً");
    expect(out).not.toContain("85,000");
  });

  it("a Metacritic score only when TamTam entered a licensed one — with its source, reviews and date", () => {
    const without = renderSheet(viewOf());
    expect(without).not.toContain("تقييم Metacritic");
    expect(without).toContain("صفحتها على Metacritic"); // the plain link out stays
    const licensed = renderSheet(viewOf({ extras: { ...EXTRAS, metacritic: { score: 96, reviews: 120, asOf: "2026-11-01" } } }));
    expect(licensed).toContain("تقييم Metacritic");
    expect(licensed).toContain("Metacritic 96");
    expect(licensed).toContain("120 مراجعة");
    expect(licensed).toContain("بتاريخ 01/11/2026");
    // words, never stars
    expect(licensed).not.toContain("#star");
    expect(licensed).not.toContain("★");
    // every figure in the shopper's numerals (the Arabic-Indic preference), the review count too
    const arab = renderSheet(viewOf({ extras: { ...EXTRAS, metacritic: { score: 96, reviews: 1200, asOf: "2026-11-01" } } }), "ar", { ...DEFAULT_PREFS, numbering: "arab" });
    expect(arab).toContain("Metacritic ٩٦");
    expect(arab).toMatch(/١٬?٢٠٠ مراجعة/);
    expect(arab).not.toContain("1200");
  });

  it("a Wikipedia lead carries its attribution line: the article and the licence, both linked", () => {
    const html = renderSheet(viewOf());
    expect(html).toContain("دموع المملكة لعبة مغامرات صدرت سنة 2023.");
    expect(html).toContain('href="https://ar.wikipedia.org/wiki/x"');
    expect(html).toContain(`href="${WIKIPEDIA_LICENCE_URL}"`);
    expect(html).toContain("CC BY-SA 4.0");
    expect(html).toContain("على Wikipedia، ومتاح بترخيص");
    expect(html).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/);
  });

  it("TamTam's own description wins, with no Wikipedia attribution", () => {
    const html = renderSheet(viewOf({ extras: { ...EXTRAS, description: { ar: "وصف كتبته طمطم." } } }));
    expect(html).toContain("وصف كتبته طمطم.");
    expect(html).not.toContain("دموع المملكة لعبة مغامرات");
    expect(html).not.toContain(WIKIPEDIA_LICENCE_URL);
  });

  it("no text in the page's language: the English lead, marked lang=\"en\" and said so", () => {
    const html = renderSheet(viewOf({}, "ckb"), "ckb");
    expect(html).toMatch(/<p class="sbs-read" lang="en" dir="ltr">Tears of the Kingdom is a 2023 action-adventure game\.<\/p>/);
    expect(html).toContain("هێشتا وەسفی کوردی نییە، بۆیە ئەم وەسفە بە ئینگلیزییە.");
    expect(html).toContain("https://en.wikipedia.org/wiki/The_Legend_of_Zelda:_Tears_of_the_Kingdom");
  });

  it("details loading, failed, or none: the space is reserved, a retry is offered, or the section is left out", () => {
    const loading = renderSheet(viewOf({ details: "loading" }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("نحمّل وصف اللعبة");
    expect(loading).toContain(`16.5${NB}GB`); // what TamTam knows shows at once

    const failed = renderSheet(viewOf({ details: "error" }));
    expect(failed).toContain("تعذّر تحميل وصف اللعبة.");
    expect(failed).toContain("أعد المحاولة");

    const none = renderSheet(viewOf({ details: null }));
    expect(none).not.toContain("عن اللعبة");
    expect(none).not.toContain("مقالتها على Wikipedia");
  });

  it("the trailer is TamTam's own play key: nothing from YouTube is loaded before the tap", () => {
    const html = renderSheet(viewOf({ extras: { ...EXTRAS, trailerYouTubeId: "dQw4w9WgXcQ" } }));
    expect(html).toContain("شغّل الإعلان");
    expect(html).toContain("يُحمَّل الفيديو من YouTube فقط عندما تضغط تشغيل.");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("youtube-nocookie.com");
    expect(html).not.toContain("ytimg");
    expect(html).not.toContain("dQw4w9WgXcQ");
    // an id that is not a video id shows no trailer at all
    expect(renderSheet(viewOf({ extras: { ...EXTRAS, trailerYouTubeId: "<script>" } }))).not.toContain("شغّل الإعلان");
  });

  it("renders in every language", () => {
    for (const locale of LOCALE_CODES) {
      const html = renderSheet(viewOf({ cartridge: CARTRIDGE }, locale), locale);
      expect(html, locale).toContain(`16.5${NB}GB`);
      expect(html, locale).toContain("Nintendo eShop");
    }
  });
});

/** Lower case, without Arabic diacritics or tatweel, without hyphens — so spelling variants read as one word. */
const fold = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/-/g, "");

/**
 * The words the contract's rule 1 bans (docs/switch-builder.md §1), read from the contract itself so that this file
 * never spells them (the rule covers code, comments and tests too). Latin words also as their stems (other endings).
 */
function bannedWords(): string[] {
  const contract = readFileSync(new URL("../docs/switch-builder.md", import.meta.url), "utf8");
  const rule = /\n1\. \*\*Legitimate purchases only\.\*\*([\s\S]*?)\n2\. /.exec(contract)?.[1] ?? "";
  const quoted = [...rule.matchAll(/"([^"]+)"|«([^»]+)»/g)].map((match) => fold(match[1] ?? match[2] ?? ""));
  return [...new Set(quoted.flatMap((word) => (/^[a-z]{6,}$/.test(word) ? [word, word.slice(0, -2), word.slice(0, 6)] : [word])))].filter(Boolean);
}

/** The files this area owns (contract §9). */
const OWNED_FILES = [
  "app/routes/storefront/builder/components/GameSheet.tsx",
  "app/routes/storefront/builder/components/BuilderTour.tsx",
  "app/routes/storefront/builder/components/SpotlightTour.tsx",
  "app/routes/storefront/builder/components/TrailerEmbed.tsx",
  "app/routes/storefront/builder/components/tour-steps.ts",
  "app/routes/storefront/builder/lib/use-long-press.ts",
  "app/routes/storefront/builder/builder-sheet.css",
  "app/i18n/messages/switch-builder-sheet.ts",
  "tests/switch-builder-sheet.test.ts",
];

describe("the namespace's words", () => {
  it("never suggest anything but a legitimate purchase — in the copy, the code, the comments or these tests", () => {
    const banned = bannedWords();
    expect(banned.length, "rule 1 of docs/switch-builder.md lists the banned words").toBeGreaterThanOrEqual(7);
    const sources: Array<[string, string]> = [
      ["the switch-builder-sheet messages", JSON.stringify(switchBuilderSheet)],
      ...OWNED_FILES.map((file): [string, string] => [file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")]),
    ];
    for (const [name, text] of sources) {
      const words = fold(text);
      for (const word of banned) expect(words.includes(word), `${name}: ${word}`).toBe(false);
    }
    expect(JSON.stringify(switchBuilderSheet)).not.toMatch(/!/);
  });
});
