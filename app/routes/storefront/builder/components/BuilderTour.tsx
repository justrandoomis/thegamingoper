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
 * open sheet or dialog. «تخطَّ» (Escape, Android's back) turns the automatic start off for every step; finishing only
 * marks that step as seen. `replay()` (the page's «?» key) shows the current step's guide again at any time. The
 * memory is localStorage `tt.sb.tour.v1` plus this visit's own copy (./tour-steps createTourMemory; wrapped — without
 * storage the guide starts again only on the next visit, never right after it closed). A step change closes an open
 * guide. Client only: nothing renders on the server or before hydration.
 *
 * When the guide has gone and the focus has nowhere to be (a guide that started by itself had no opener), the focus
 * goes to the page's main landmark, never <body> (the home Intro's rule).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { useFormat, useT } from "~/i18n/react";
import { toGiB } from "~/lib/switch-builder/storage";
import type { BuilderStep } from "~/lib/switch-builder/types";
import { isolate } from "~/ui/BidiText";
import { useOverlayDepth, usePresence } from "~/ui/Dialog";
import { SpotlightTour, visibleTarget, type SpotlightLabels, type SpotlightStep } from "./SpotlightTour";
import {
  CLOSED_TOUR,
  createTourMemory,
  shouldAutoStart,
  TOUR_TEXT_KEY,
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

/** The card the memory step's guide takes as its example (`tour.part.cardUsable.text`). */
const EXAMPLE_CARD_GB = 256;

/** localStorage `tt.sb.tour.v1` plus this visit's own copy (a blocked or full storage never makes a guide loop). */
const tourMemory = createTourMemory(tourStorage);

type OpenTour = Extract<TourState, { status: "open" }>;

/** `ready` = the step's targets are on screen (e.g. the game list has loaded); the guide starts only then. */
export function useBuilderTour(step: BuilderStep, options: { ready: boolean }): BuilderTour {
  const t = useT("switch-builder-sheet");
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

  // the first time this step is shown: once it is ready, nothing else is open over the page, and the tab is visible
  // (a page opened in a background tab gets its guide when the shopper comes to it)
  useEffect(() => {
    if (!ready || open || depth > 0) return;
    if (!shouldAutoStart(tourMemory.read(), step)) return;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        if (document.visibilityState !== "hidden") start("auto");
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
    // the label-versus-console example: a 256GB card is about 238 GB on the console (decimal vs binary gigabytes),
    // in the shopper's numerals, each figure isolated so «238 GB» never reads «GB 238» inside Arabic or Sorani
    const vars = {
      label: isolate(`${f.number(EXAMPLE_CARD_GB)}GB`),
      shown: isolate(`${f.number(toGiB(EXAMPLE_CARD_GB * 1e9, 0))} GB`),
    };
    return (targets ?? []).map((target) => ({
      target,
      title: t(`tour.part.${TOUR_TEXT_KEY[target]}.title`),
      text: t(`tour.part.${TOUR_TEXT_KEY[target]}.text`, vars),
    }));
  }, [targets, t, f]);
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
