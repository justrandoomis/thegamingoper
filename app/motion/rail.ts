/**
 * Rail behaviour (loaded on demand through ./extras; the public entry is the `useRail` hook in ./rail-hook).
 *
 * Scrolling itself is native (CSS scroll-snap, momentum, touch, trackpad, Shift+wheel). This adds what the platform
 * does not give a horizontal scroller: arrow / Home / End / Page keys, and a small rubber bump when someone with a
 * mouse or keyboard pushes past an edge (touch platforms already have their own overscroll feedback).
 * Vertical wheel and touch movement are never intercepted.
 */
import { getMotionTier } from "./env";
import { springTiming } from "./timing";
import { durations, easings } from "./tokens";

export type RailController = {
  /** Scroll one item toward the end (true) or the start (false); bumps at the edge. */
  step(forward: boolean): void;
  detach(): void;
};

export function attachRail(rail: HTMLElement): RailController {
  const isRtl = () => getComputedStyle(rail).direction === "rtl";
  const span = () => Math.max(rail.scrollWidth - rail.clientWidth, 0);
  /** Distance scrolled from the start edge, direction-agnostic (RTL scrollLeft is 0 → negative). */
  const travelled = () => Math.abs(rail.scrollLeft);
  const itemStep = () => {
    const first = rail.firstElementChild;
    if (!first) return rail.clientWidth * 0.8;
    const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
    return first.getBoundingClientRect().width + gap;
  };
  const finePointer = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;

  let lastBump = 0;
  const bump = (forward: boolean, force = false) => {
    if (getMotionTier() !== "full" || (!finePointer && !force)) return;
    const now = performance.now();
    if (now - lastBump < 450) return;
    lastBump = now;
    // Content is pulled a little further the way it was pushed, then springs back.
    const pull = (forward ? -1 : 1) * (isRtl() ? -1 : 1) * 14;
    const spring = springTiming("gentle");
    rail.animate(
      [
        { translate: "0 0", easing: easings.out },
        { translate: `${pull}px 0`, offset: 0.22, easing: spring.easing },
        { translate: "0 0" },
      ],
      { duration: durations.quick + spring.duration },
    );
  };

  const scrollBy = (forward: boolean, amount: number) => {
    if (span() <= 1) return;
    if (forward ? travelled() >= span() - 1 : travelled() <= 1) {
      bump(forward, true);
      return;
    }
    const left = (forward ? 1 : -1) * (isRtl() ? -1 : 1) * amount;
    rail.scrollBy({ left, behavior: getMotionTier() === "reduced" ? "auto" : "smooth" });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== rail || event.altKey || event.ctrlKey || event.metaKey) return;
    const rtl = isRtl();
    switch (event.key) {
      case "ArrowRight":
        scrollBy(!rtl, itemStep());
        break;
      case "ArrowLeft":
        scrollBy(rtl, itemStep());
        break;
      case "PageDown":
        scrollBy(true, rail.clientWidth * 0.9);
        break;
      case "PageUp":
        scrollBy(false, rail.clientWidth * 0.9);
        break;
      case "Home":
        scrollBy(false, span());
        break;
      case "End":
        scrollBy(true, span());
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onWheel = (event: WheelEvent) => {
    // Only a deliberate sideways push at an edge; vertical scrolling passes straight through.
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || Math.abs(event.deltaX) < 8 || span() <= 1) return;
    const forward = event.deltaX * (isRtl() ? -1 : 1) > 0;
    if (forward ? travelled() >= span() - 1 : travelled() <= 1) bump(forward);
  };

  rail.addEventListener("keydown", onKeyDown);
  rail.addEventListener("wheel", onWheel, { passive: true });
  if (rail.hasAttribute("data-rail-tilt")) enableTilt(rail);

  return {
    step: (forward) => scrollBy(forward, itemStep()),
    detach() {
      rail.removeEventListener("keydown", onKeyDown);
      rail.removeEventListener("wheel", onWheel);
      if (rail.getAttribute("data-rail-tilt") === "on") rail.setAttribute("data-rail-tilt", "");
    },
  };
}

const tiltProbes = new Map<string, Promise<boolean>>();

/**
 * Is the browser's horizontal view timeline right for this writing direction?
 * Measured once per direction on a tiny invisible rail: an item that is completely inside must be flat. If it is
 * leaning, the timeline is wrong — Chromium 157 does this for RTL horizontal scrollers, where every item stays in
 * its "not yet entered" state. A view timeline only gets its time when a frame is produced, hence the two frames.
 */
function tiltWorks(rtl: boolean): Promise<boolean> {
  const key = rtl ? "rtl" : "ltr";
  let probe = tiltProbes.get(key);
  if (probe) return probe;
  probe = new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    host.dir = key;
    host.className = "tt-rail";
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("data-rail-tilt", "on");
    host.style.cssText = "position:fixed;top:0;left:0;width:200px;height:20px;gap:0;visibility:hidden;pointer-events:none;contain:strict";
    for (let i = 0; i < 4; i++) {
      const item = document.createElement("div");
      item.style.cssText = "width:100px;height:10px";
      host.appendChild(item);
    }
    document.body.appendChild(host);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // m31 is the sine of the Y rotation: zero when the item is flat.
        const lean = host.firstElementChild ? new DOMMatrixReadOnly(getComputedStyle(host.firstElementChild).transform).m31 : 1;
        host.remove();
        resolve(Math.abs(lean) < 1e-4);
      }),
    );
  });
  tiltProbes.set(key, probe);
  return probe;
}

/** The stylesheet tilts items when data-rail-tilt="on"; that is only set where the timeline has been checked. */
function enableTilt(rail: HTMLElement): void {
  if (typeof CSS === "undefined" || !CSS.supports("animation-timeline: view()") || getMotionTier() !== "full") return;
  void tiltWorks(getComputedStyle(rail).direction === "rtl").then((ok) => {
    if (ok && rail.isConnected && rail.getAttribute("data-rail-tilt") === "") rail.setAttribute("data-rail-tilt", "on");
  });
}
