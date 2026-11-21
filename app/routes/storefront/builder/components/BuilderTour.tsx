/**
 * The builder's spotlight guide (docs/switch-builder.md §6.7).
 *
 *   const tour = useBuilderTour(step, { ready: libraryLoaded });
 *   <IconKey icon="question" label={t("help")} onClick={tour.replay} data-tour="help" />
 *   {tour.element}
 *
 * Each step has a short guide over the page's `data-tour` parts (./tour-steps TOUR_STEPS; a part that is not on the
 * page is skipped). It starts by itself the first time each step is shown — once the page says the step is `ready`
 * (its parts are on screen: for the games step, after the list has loaded), after a short pause, and never over an
 * open sheet or dialog, nor over a shopper who is already at work on the step: a key or a press since the step was
 * shown (typing in the search field as soon as it appears) makes the step count as offered, and only «?» shows its
 * guide then — the guide never takes the focus from under the shopper's fingers. «تخطَّ» (Escape, Android's back)
 * turns the automatic start off for every step; finishing only marks that step as seen. `replay()` (the page's «?»
 * key) shows the current step's guide again at any time. The memory is localStorage `tt.sb.tour.v1` plus this visit's
 * own copy (./tour-steps createTourMemory; wrapped — without storage the guide starts again only on the next visit,
 * never right after it closed). A step change closes an open guide. Client only: nothing renders on the server or
 * before hydration.
 *
 * The words quote the page's own key names from its namespace («عندي جهاز Switch», «بدون بطاقة»), so the guide names
 * them exactly as the page shows them, and the memory step's example is the card whose line the guide lights (64GB,
 * written as the page writes figures: «بنحو 59.6 GB»).
 *
 * When the guide has gone and the focus has nowhere to be (a guide that started by itself had no opener), the focus
 * goes to the page's main landmark, never <body> (the home Intro's rule).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { useFormat, useT } from "~/i18n/react";
import { CARD_SIZES, type BuilderStep } from "~/lib/switch-builder/types";
import { isolate } from "~/ui/BidiText";
import { useOverlayDepth, usePresence } from "~/ui/Dialog";
import { cardLabel, gbText } from "../lib/format";
import { SpotlightTour, visibleTarget, type SpotlightLabels, type SpotlightStep } from "./SpotlightTour";
import {
  CLOSED_TOUR,
  createTourMemory,
  shouldAutoStart,
  TOUR_TEXT_KEY,
  tourKeeps,
  tourReducer,
  tourStorage,
  tourTargets,
  withOff,
  withSeen,
  type TourState,
  type TourTarget,
} from "./tour-steps";

export interface BuilderTour {
  /** Render this once in the page (the overlay; null while closed). */
  element: ReactNode;
  /** Show this step's guide again (the page's «?» key). */
  replay: () => void;
  open: boolean;
}

/** The pause between a step being ready and its guide starting (the page settles: fonts, pictures, the plan). */
export const TOUR_AUTO_START_MS = 600;

/**
 * The card the memory step's guide takes as its example (`tour.part.cardUsable.text`): the one whose «≈ 55 GB للألعاب»
 * line it lights (MemoryStep puts data-tour="card-usable" on the first card size, CARD_SIZES[1]).
 */
const EXAMPLE_CARD_GB = CARD_SIZES[1];

/** localStorage `tt.sb.tour.v1` plus this visit's own copy (a blocked or full storage never makes a guide loop). */
const tourMemory = createTourMemory(tourStorage);

type OpenTour = Extract<TourState, { status: "open" }>;

/** `ready` = the step's targets are on screen (e.g. the game list has loaded); the guide starts only then. */
export function useBuilderTour(step: BuilderStep, options: { ready: boolean }): BuilderTour {
  const t = useT("switch-builder-sheet");
  const page = useT("switch-builder");
  const f = useFormat();
  const [state, dispatch] = useReducer(tourReducer, CLOSED_TOUR);
  const open = state.status === "open";
  const [present, exited] = usePresence(open);
  // while it fades out it keeps showing the part it was on
  const lastOpen = useRef<OpenTour | null>(null);
  if (state.status === "open") lastOpen.current = state;
  const depth = useOverlayDepth();
  const { ready } = options;

  const start = useCallback(
    (mode: "auto" | "replay") => {
      const memory = tourMemory.read();
      const present = (target: TourTarget) => visibleTarget(target) !== null;
      const targets = tourTargets(step, present, { first: memory.seen.length === 0 });
      if (targets.length === 0) return;
      tourMemory.update((current) => withSeen(current, step));
      dispatch({ type: "start", step, targets, mode });
    },
    [step],
  );

  // A shopper at work on this step — a key (typing in the search field the moment it appears) or a press since the
  // step was shown — is never interrupted by its automatic start: the guide would take the focus and the keystrokes.
  // Programmatic focus (the step's heading) is no work: only the shopper's own keys and presses count.
  const busy = useRef(false);
  useEffect(() => {
    busy.current = false;
    const mark = (event: Event) => {
      if (event.isTrusted) busy.current = true;
    };
    window.addEventListener("keydown", mark, true);
    window.addEventListener("pointerdown", mark, true);
    return () => {
      window.removeEventListener("keydown", mark, true);
      window.removeEventListener("pointerdown", mark, true);
    };
  }, [step]);

  // the first time this step is shown: once it is ready, nothing else is open over the page, and the tab is visible
  // (a page opened in a background tab gets its guide when the shopper comes to it); a shopper already at work there
  // gets none — the step counts as offered, and «?» still shows its guide
  useEffect(() => {
    if (!ready || open || depth > 0) return;
    if (!shouldAutoStart(tourMemory.read(), step)) return;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        if (document.visibilityState === "hidden") return;
        if (busy.current) tourMemory.update((current) => withSeen(current, step));
        else start("auto");
      }, TOUR_AUTO_START_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [ready, open, depth, step, start]);

  // another step (Back, a link): this guide is over
  const openStep = state.status === "open" ? state.step : null;
  useEffect(() => {
    if (openStep !== null && openStep !== step) dispatch({ type: "close" });
  }, [openStep, step]);

  const replay = useCallback(() => start("replay"), [start]);

  const skip = useCallback(() => {
    tourMemory.update(withOff);
    dispatch({ type: "close" });
  }, []);

  const onExited = useCallback(() => {
    exited();
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) document.getElementById("main")?.focus({ preventScroll: true });
    });
  }, [exited]);

  const shown = state.status === "open" ? state : lastOpen.current;
  const targets = shown?.targets;
  const steps = useMemo<SpotlightStep[]>(() => {
    // the label-versus-console example on the card the guide lights: a 64GB card is about 59.6 GB on the console
    // (decimal vs binary gigabytes) — the label as printed on the card, the figure as the page writes it (one decimal,
    // the shopper's numerals), each isolated so «59.6 GB» never reads «GB 59.6» inside Arabic or Sorani; and the
    // page's own key names, quoted as the page shows them
    const vars = {
      label: isolate(cardLabel(EXAMPLE_CARD_GB)),
      shown: gbText(f, EXAMPLE_CARD_GB * 1e9),
      have: page("device.have"),
      none: page("memory.none"),
    };
    return (targets ?? []).map((target) => ({
      target,
      title: t(`tour.part.${TOUR_TEXT_KEY[target]}.title`),
      text: t(`tour.part.${TOUR_TEXT_KEY[target]}.text`, vars),
      keep: tourKeeps(target),
    }));
  }, [targets, t, page, f]);
  const labels = useMemo<SpotlightLabels>(
    () => ({
      next: t("tour.next"),
      back: t("tour.back"),
      skip: t("tour.skip"),
      finish: t("tour.finish"),
      count: (n, total) => t("tour.count", { n: f.number(n), total: f.number(total) }),
      highlighted: (name) => t("tour.highlighted", { name }),
    }),
    [t, f],
  );

  const element =
    present && shown ? (
      <SpotlightTour
        key={shown.run}
        steps={steps}
        index={shown.index}
        labels={labels}
        leaving={!open}
        onNext={() => dispatch({ type: "next" })}
        onBack={() => dispatch({ type: "back" })}
        onFinish={() => dispatch({ type: "close" })}
        onSkip={skip}
        onMissing={(target) => dispatch({ type: "drop", target: target as TourTarget })}
        onExited={onExited}
      />
    ) : null;

  return { element, replay, open };
}
