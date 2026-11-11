/**
 * Small, defensive helpers around the View Transitions API. Browser-only functions; nothing runs at module scope.
 *
 * Facts these helpers encode (measured against React 19.3.1 + Chromium 157, see docs/MOTION.md):
 *  - React starts `document.startViewTransition` itself for transition commits that activate a <ViewTransition>.
 *  - While one of React's view transitions is still animating, React holds back every later transition commit
 *    ("Waiting for the previous Animation"). Ending the animation releases them at once.
 *  - Skipping a transition before its animation started makes React report "A ViewTransition was aborted early",
 *    so we only ever end a transition that is already animating.
 */

type ViewTransitionLike = { finished: Promise<unknown>; ready: Promise<unknown>; skipTransition(): void };
type TransitionDocument = Document & {
  startViewTransition?: (callback?: () => void | Promise<void>) => ViewTransitionLike;
  activeViewTransition?: ViewTransitionLike | null;
};

export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && typeof (document as TransitionDocument).startViewTransition === "function";
}

/** The running transition where the browser exposes it (`document.activeViewTransition`), otherwise undefined. */
export function activeTransition(): ViewTransitionLike | null | undefined {
  const doc = document as TransitionDocument;
  return "activeViewTransition" in doc ? (doc.activeViewTransition ?? null) : undefined;
}

/** True from `startViewTransition()` until the transition's animations are done (covers the update callback). */
export function isTransitionActive(): boolean {
  if (!supportsViewTransitions()) return false;
  const active = activeTransition();
  if (active !== undefined) return active !== null;
  try {
    return document.documentElement.matches(":active-view-transition");
  } catch {
    return false; // selector not supported: treat as "no transition" and let callers take their fallback
  }
}

function transitionAnimations(): Animation[] {
  return document.documentElement.getAnimations({ subtree: true }).filter((animation) => {
    const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement;
    return typeof pseudo === "string" && pseudo.startsWith("::view-transition");
  });
}

/**
 * Jump the running view transition to its end so the page is live and interactive again.
 * Does nothing while a transition is still preparing (no animations yet). Returns true if one was ended.
 */
export function endActiveTransition(): boolean {
  if (!isTransitionActive()) return false;
  const animations = transitionAnimations();
  if (animations.length === 0) return false;
  const active = activeTransition();
  if (active) {
    active.skipTransition(); // synchronous: hit-testing reaches the real page immediately
  } else {
    for (const animation of animations) {
      try {
        animation.finish();
      } catch {
        // infinite or already idle
      }
    }
  }
  return true;
}

/**
 * Call `done` once when the transition that is active right now has finished.
 * Uses the transition's own promise where the browser exposes it; elsewhere the caller also gets React's
 * <ViewTransition> cleanup callback and this timeout is only the safety net.
 */
export function whenTransitionEnds(done: () => void, safetyMs = 1200): () => void {
  let called = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (called) return;
    called = true;
    clearTimeout(timer);
    done();
  };
  const active = activeTransition();
  if (active) active.finished.then(finish, finish);
  else timer = setTimeout(finish, safetyMs);
  return finish;
}

/**
 * Do not let a page animation hold content back.
 *
 * While one of React's view transitions is animating, React parks every later transition or Suspense commit
 * ("Waiting for the previous Animation") — measured: data that was ready after 0.9 s appeared only when a slowed-down
 * 6 s transition had ended. React waits by reading `.finished` on the running transition, so that read is the
 * signal that something is ready to be shown. When it happens, what is left of the animation is fast-forwarded
 * (`rate` times faster) instead of being cut, and the waiting commit follows within a few frames.
 *
 * The watch is installed one task after the transition is ready, i.e. after React's own bookkeeping reads.
 * If React ever stops waiting this way, nothing here fires and behaviour is simply React's default.
 */
export function hurryWhenAwaited(transition: ViewTransitionLike, rate: number): void {
  const finished = transition.finished;
  let awaited = false;
  const watch = () => {
    try {
      Object.defineProperty(transition, "finished", {
        configurable: true,
        get() {
          if (!awaited) {
            awaited = true;
            for (const animation of transitionAnimations()) {
              if (animation.playState === "running") animation.updatePlaybackRate(rate);
            }
          }
          return finished;
        },
      });
    } catch {
      // the browser does not allow shadowing the property: keep React's default behaviour
    }
  };
  transition.ready.then(
    () => setTimeout(watch, 0),
    () => {},
  );
}

/**
 * Run `update` inside a view transition that we own (theme and similar morphs — never navigation, which is React's).
 * Ends a transition that is already animating first; resolves when ours has finished. Falls back to a plain call.
 */
export function runTransition(update: () => void, onReady?: () => void): Promise<void> {
  const doc = document as TransitionDocument;
  if (!supportsViewTransitions() || (isTransitionActive() && !endActiveTransition())) {
    // Unsupported, or another transition is still preparing: do not fight it.
    update();
    return Promise.resolve();
  }
  let transition: ViewTransitionLike;
  try {
    transition = doc.startViewTransition!(update);
  } catch {
    update();
    return Promise.resolve();
  }
  transition.ready.then(
    () => onReady?.(),
    () => {}, // skipped (hidden tab, interrupted): the update still ran
  );
  return transition.finished.then(
    () => {},
    () => {},
  );
}
