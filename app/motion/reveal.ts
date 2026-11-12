/**
 * Section reveal — Design v2.1 G6 ("sections fade up as they enter with a small stagger"). Started once by
 * <MotionRoot>; feature code only marks elements (or uses <Reveal> from ~/ui/reveal):
 *
 *   <section data-reveal>…</section>              the section fades up 16px as it first enters the viewport
 *   <div className="cards" data-reveal="stagger">  its children do, 60ms apart (six steps at most)
 *
 * How it stays honest (no CLS, nothing hidden that should be seen, no hydration mismatch):
 *   - Nothing hides before JavaScript: the server's page is complete. Once the engine is live, only elements that are
 *     BELOW the fold at that moment are held hidden (opacity 0, 16px down — transform only); what is already on screen
 *     never moves.
 *   - It never writes an attribute, a class or a style: the hold and the arrival are Web Animations on the element
 *     (or its children), so React hydrating a streamed boundary later finds exactly the markup it rendered.
 *   - A held element arrives the first time it enters the viewport (IntersectionObserver), on the `settle` curve.
 *   - Elements added later (client navigation, streamed content) are picked up by a MutationObserver.
 *   - Reduced motion (OS or the store's switch), the lite tier, a hidden tab and automation (navigator.webdriver:
 *     screenshots, tests) skip it: everything is simply there; turning motion down while reading releases every hold.
 */
import { getMotionTier } from "./env";
import { easings } from "./tokens";

const SELECTOR = "[data-reveal]";
const STEP_MS = 60;
const MAX_STEPS = 5;
const DURATION_MS = 460;
const FROM: Keyframe = { opacity: 0, translate: "0 16px" };
const TO: Keyframe = { opacity: 1, translate: "0 0" };

/** Whether reveals run at all right now (pure inputs, exported for tests). */
export function revealEnabled(env: { tier: string; webdriver: boolean; hidden: boolean; io: boolean; waapi: boolean }): boolean {
  return env.tier === "full" && !env.webdriver && !env.hidden && env.io && env.waapi;
}

/** "pending" for an element whose top is below the fold, else "shown" (pure, exported for tests). */
export function initialRevealState(top: number, viewportHeight: number): "pending" | "shown" {
  return top >= viewportHeight * 0.94 ? "pending" : "shown";
}

/** The arrival delay of the i-th staggered child (pure, exported for tests): 60ms steps, the sixth and later together. */
export function revealDelay(index: number): number {
  return Math.min(Math.max(0, index), MAX_STEPS) * STEP_MS;
}

export function installReveal(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const enabled = revealEnabled({
    tier: getMotionTier(),
    webdriver: Boolean((navigator as Navigator & { webdriver?: boolean }).webdriver),
    hidden: document.visibilityState === "hidden",
    io: typeof IntersectionObserver === "function",
    waapi: typeof Element !== "undefined" && typeof Element.prototype.animate === "function",
  });
  if (!enabled) return () => {};

  const seen = new WeakSet<Element>();
  /** The hold animations of each waiting element (its own, or its children's). */
  const holds = new Map<Element, Animation[]>();

  const targetsOf = (element: HTMLElement): HTMLElement[] =>
    element.getAttribute("data-reveal") === "stagger" ? Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement) : [element];

  const hold = (element: HTMLElement) => {
    holds.set(
      element,
      targetsOf(element).map((target) => target.animate([FROM, FROM], { duration: 1, fill: "both" })),
    );
  };
  const release = (element: Element) => {
    for (const animation of holds.get(element) ?? []) animation.cancel();
    holds.delete(element);
  };
  const arrive = (element: HTMLElement) => {
    const waiting = holds.get(element) ?? [];
    targetsOf(element).forEach((target, index) => {
      target.animate([FROM, TO], { duration: DURATION_MS, delay: revealDelay(index), easing: easings.settle, fill: "backwards" });
    });
    // the arrivals hold their own first frame through their delay (fill: backwards), so the holds can go at once
    for (const animation of waiting) animation.cancel();
    holds.delete(element);
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        io.unobserve(element);
        if (getMotionTier() === "full") arrive(element);
        else release(element);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );

  const adopt = (element: HTMLElement) => {
    if (seen.has(element)) return;
    seen.add(element);
    if (initialRevealState(element.getBoundingClientRect().top, window.innerHeight) !== "pending") return;
    hold(element);
    io.observe(element);
  };
  const scan = (root: Element | Document) => {
    if (root instanceof HTMLElement && root.matches(SELECTOR)) adopt(root);
    for (const element of root.querySelectorAll<HTMLElement>(SELECTOR)) adopt(element);
  };
  scan(document);

  const mo =
    typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement) scan(node);
        })
      : null;
  mo?.observe(document.body, { childList: true, subtree: true });

  // the shopper turned motion down while reading: show everything that still waits
  const settle = () => {
    if (getMotionTier() === "full") return;
    for (const element of [...holds.keys()]) {
      io.unobserve(element);
      release(element);
    }
  };
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  media?.addEventListener("change", settle);
  const tierWatch = typeof MutationObserver === "function" ? new MutationObserver(settle) : null;
  tierWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  // printing (or saving as PDF) before scrolling down: nothing may stay held at opacity 0 on paper
  const printAll = () => {
    for (const element of [...holds.keys()]) {
      io.unobserve(element);
      release(element);
    }
  };
  window.addEventListener("beforeprint", printAll);

  return () => {
    io.disconnect();
    mo?.disconnect();
    tierWatch?.disconnect();
    media?.removeEventListener("change", settle);
    window.removeEventListener("beforeprint", printAll);
    // leave nothing hidden behind
    for (const element of [...holds.keys()]) release(element);
  };
}
