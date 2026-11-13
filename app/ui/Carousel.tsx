import {
  Children,
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent,
} from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { durations, easings, getMotionTier, useMotionTier, type MotionTier } from "~/motion";
import { cx } from "./cx";
import { IconKey } from "./IconKey";

/**
 * Carousel — Design v2.1 G6 (the home hero's several banners; maybe the product gallery). A native CSS scroll-snap
 * track — touch and trackpad swipe for free, no scroll-jacking — and a small hook that tracks the slide in view,
 * plays and pauses, and moves with the arrows, the dots and the keyboard.
 *
 *   <Carousel label={t("offers")} autoplay={6000} aspect="390 / 220"
 *             slides={banners.map((b) => <Banner key={b.id} {...b} />)} />
 *
 *   // your own layout: the hook and the parts
 *   const c = useCarousel({ count: banners.length, autoplay: 6000 });
 *   <section {...c.rootProps} aria-label={t("offers")} className="carousel">
 *     <div {...c.trackProps} className="carousel__track">
 *       {banners.map((b, i) => <div key={b.id} {...c.slideProps(i)} className="carousel__slide">…</div>)}
 *     </div>
 *     <div className="carousel__bar"><CarouselDots api={c} /><CarouselPlay api={c} /><CarouselArrows api={c} /></div>
 *   </section>
 *
 * Behaviour
 * - Autoplay (`autoplay` ms, 6000 is a good value) moves to the next slide and wraps; it PAUSES while the pointer is
 *   over the carousel, while focus is inside it, while a finger is on the track, while the tab is hidden and while the
 *   carousel is off screen. It STOPS when the shopper takes over: a swipe that moves the track (a finger, or a sideways
 *   trackpad swipe) or a press of an arrow or a dot. A vertical page scroll that merely starts on the carousel is not a
 *   take-over. The pause / play key (<CarouselPlay>) is always there while autoplay can run (WCAG 2.2.2); pressing play
 *   starts it even while focus or the pointer is inside (the APG rotation control). The rules are the pure
 *   `carouselHold()` / `autoplayWaits()` below.
 * - Moves (`carouselMove()` below): the next or the previous slide slides in (a smooth scroll); anything further — the
 *   autoplay wrap from the last slide to the first, «next» on the last, a dot two slides away, Home / End — fades the
 *   track out (140ms), jumps and fades it in (220ms), so the slides in between never rush past (client notes 1–2:
 *   "switches with smooth animation"; the wrap used to scroll back across every banner). The slides keep
 *   `scroll-snap-stop: always`, so a hard fling still stops at the next slide; the jump suspends snapping for its one
 *   instant scroll (Chromium stops even an instant programmatic scroll at such a slide).
 * - Reduced motion (the OS or the store's switch) and the lite tier: no autoplay, and moves are instant.
 * - Keyboard: ← → move in the reading direction (in Arabic → is "previous"), Home / End; on the track or a control.
 *   Keys pressed in a dialog the carousel opened (a React portal bubbles through it) are left alone.
 * - The pause / play key appears once the page is live (nothing plays without JavaScript). `running` says whether the
 *   slides are moving on by themselves right now; <CarouselDots progress> fills the current dot with the time left.
 * - Semantics: a region with aria-roledescription «عرض شرائح» and your label; each slide a group «2 من 3»; the
 *   track is a polite live region only while autoplay is off.
 * - The slide's shape is one custom property: `aspect` (→ --carousel-aspect). The first slide's image should be eager
 *   with fetchpriority high, the others lazy (the page decides; nothing here loads images).
 * - `.carousel__parallax` on an element inside a slide makes it drift a little against the swipe (CSS scroll-driven
 *   animation; none under reduced motion).
 */
export type CarouselOptions = {
  count: number;
  /** Milliseconds between automatic moves (e.g. 6000). 0 / undefined: no autoplay. */
  autoplay?: number;
  /** Wrap at the ends. Default: true with autoplay, false without. */
  loop?: boolean;
  /** Called with the slide in view. */
  onIndexChange?: (index: number) => void;
};

export type CarouselApi = {
  index: number;
  count: number;
  /** Autoplay can run here (an interval was given, motion is full, the page is live). */
  canPlay: boolean;
  /** The shopper's choice: autoplay on (not paused or stopped by the pause key or a touch). */
  playing: boolean;
  /** The slides are moving on by themselves right now: playing, and nothing holds it (pointer, focus, a finger, a
   *  hidden tab, off screen). What a progress look follows. */
  running: boolean;
  /** The autoplay interval in milliseconds (0: none). */
  autoplay: number;
  goTo: (index: number, options?: { instant?: boolean }) => void;
  next: () => void;
  previous: () => void;
  /** The pause / play key. */
  toggle: () => void;
  /** Stop autoplay for good (a touch, an arrow, a dot). */
  stop: () => void;
  rootProps: {
    ref: RefObject<HTMLElement | null>;
    "aria-roledescription": string;
    onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
  trackProps: {
    ref: RefObject<HTMLDivElement | null>;
    id: string;
    tabIndex: number;
    "aria-live": "off" | "polite";
    /** A finger or a pen on the track: autoplay waits until it lifts. */
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
    /** The track moved under the finger: a swipe — the shopper took over. */
    onScroll: () => void;
    /** A sideways trackpad swipe stops autoplay; a vertical wheel (a page scroll) does not. */
    onWheel: (event: WheelEvent<HTMLDivElement>) => void;
  };
  slideProps: (index: number) => {
    role: "group";
    "aria-roledescription": string;
    "aria-label": string;
    "data-carousel-slide": number;
  };
};

/** The next index, wrapped or clamped (pure; exported for tests). */
export function stepIndex(index: number, delta: number, count: number, loop: boolean): number {
  if (count <= 0) return 0;
  const next = index + delta;
  if (loop) return ((next % count) + count) % count;
  return Math.min(count - 1, Math.max(0, next));
}

/**
 * How a move from the slide in view to another is drawn (pure; exported for tests). "smooth": the next or previous
 * slide slides in (and a half-swiped track re-aligns). "fade": anything further — the autoplay wrap, «next» on the last
 * slide, a dot two away, Home / End — fades the track out, jumps and fades it in, so the slides in between never rush
 * past. "jump": reduced motion and the lite tier, every move at once.
 */
export function carouselMove(from: number, to: number, tier: MotionTier): "smooth" | "fade" | "jump" {
  if (tier !== "full") return "jump";
  return Math.abs(to - from) > 1 ? "fade" : "smooth";
}

/** Arrow keys in the reading direction: in a right-to-left page ArrowLeft is "next" (pure; exported for tests). */
export function keyDelta(key: string, rtl: boolean): -1 | 0 | 1 {
  if (key === "ArrowRight") return rtl ? -1 : 1;
  if (key === "ArrowLeft") return rtl ? 1 : -1;
  return 0;
}

/** The shopper's side of autoplay: their choice (`playing`) and the three things that hold it while they last. */
export type CarouselHold = { playing: boolean; hovered: boolean; focused: boolean; touching: boolean };
export type CarouselHoldEvent =
  | { type: "hover"; on: boolean }
  | { type: "focus"; on: boolean }
  | { type: "touch"; on: boolean }
  /** the track scrolled (only a take-over while a finger is on it) */
  | { type: "swipe" }
  | { type: "wheel"; deltaX: number; deltaY: number }
  /** the pause / play key */
  | { type: "toggle" }
  /** an arrow, a dot, a key press: the shopper took over */
  | { type: "stop" };

/**
 * How the shopper's actions hold or stop autoplay (pure; exported for tests). Hover, focus and a finger on the track
 * PAUSE it while they last; a swipe that moves the track, a sideways trackpad swipe, an arrow or a dot STOP it; a
 * vertical wheel or a page scroll that starts on the carousel does nothing; play (the rotation control) starts it
 * even with focus or the pointer inside.
 */
export function carouselHold(state: CarouselHold, event: CarouselHoldEvent): CarouselHold {
  switch (event.type) {
    case "hover":
      return state.hovered === event.on ? state : { ...state, hovered: event.on };
    case "focus":
      return state.focused === event.on ? state : { ...state, focused: event.on };
    case "touch":
      return state.touching === event.on ? state : { ...state, touching: event.on };
    case "swipe":
      return state.touching && state.playing ? { ...state, playing: false } : state;
    case "wheel":
      return state.playing && Math.abs(event.deltaX) > Math.abs(event.deltaY) ? { ...state, playing: false } : state;
    case "toggle":
      return state.playing ? { ...state, playing: false } : { ...state, playing: true, hovered: false, focused: false };
    case "stop":
      return state.playing ? { ...state, playing: false } : state;
  }
}

/** Whether autoplay waits right now (pure; exported for tests). */
export function autoplayWaits(state: CarouselHold & { canPlay: boolean; hidden: boolean; offscreen: boolean }): boolean {
  return !state.canPlay || !state.playing || state.hovered || state.focused || state.touching || state.hidden || state.offscreen;
}

const STILL: CarouselHold = { playing: true, hovered: false, focused: false, touching: false };

/** How far the track scrolls to bring slide `target` to its start edge (the scroll padding kept; both directions);
 *  null when there is no such slide. */
function slideOffset(element: HTMLElement, target: number): number | null {
  const slide = element.querySelector<HTMLElement>(`[data-carousel-slide="${target}"]`);
  if (!slide) return null;
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const item = slide.getBoundingClientRect();
  return style.direction === "rtl"
    ? item.right - box.right + (parseFloat(style.scrollPaddingRight) || 0)
    : item.left - box.left - (parseFloat(style.scrollPaddingLeft) || 0);
}

/**
 * Brings slide `target` in at once. The slides keep `scroll-snap-stop: always` (a fling stops at the next slide), and
 * Chromium applies it to programmatic scrolls too — even an instant one stopped at the next slide (measured 2026-11-13:
 * a jump four slides away landed one away) — so snapping is suspended for this one scroll and restored at once; the
 * track then sits exactly on the target's snap position and stays there.
 */
function jumpTo(element: HTMLElement, target: number) {
  const delta = slideOffset(element, target);
  if (delta === null) return;
  const snap = element.style.scrollSnapType;
  element.style.scrollSnapType = "none";
  element.scrollBy({ left: delta, behavior: "instant" });
  element.style.scrollSnapType = snap;
}

export function useCarousel({ count, autoplay = 0, loop, onIndexChange }: CarouselOptions): CarouselApi {
  const t = useT("ui");
  const fmt = useFormat();
  const trackId = useId();
  const root = useRef<HTMLElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const tier = useMotionTier();
  const wraps = loop ?? autoplay > 0;
  // the page is live: nothing plays before (or without) JavaScript, so the pause key and the progress wait for it
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  const canPlay = autoplay > 0 && count > 1 && tier === "full" && live;
  const [index, setIndex] = useState(0);
  // the shopper's choice and what holds it while it lasts (pointer, focus, a finger): carouselHold() above
  const [hold, dispatch] = useReducer(carouselHold, STILL);
  const { playing } = hold;
  // reasons autoplay waits that are not the shopper's
  const [hidden, setHidden] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  const indexRef = useRef(0);
  indexRef.current = index;
  const onChange = useRef(onIndexChange);
  onChange.current = onIndexChange;

  // the slide in view: the one most inside the track (IntersectionObserver on the slides, the track as the root)
  useEffect(() => {
    const element = track.current;
    if (!element || typeof IntersectionObserver !== "function") return;
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratios.set(Number((entry.target as HTMLElement).dataset.carouselSlide), entry.intersectionRatio);
        let best = indexRef.current;
        let bestRatio = -1;
        for (const [i, r] of ratios) if (r > bestRatio + 0.01) (best = i), (bestRatio = r);
        if (bestRatio >= 0.55 && best !== indexRef.current) {
          setIndex(best);
          onChange.current?.(best);
        }
      },
      { root: element, threshold: [0, 0.25, 0.55, 0.75, 1] },
    );
    for (const slide of element.querySelectorAll<HTMLElement>("[data-carousel-slide]")) io.observe(slide);
    return () => io.disconnect();
  }, [count]);

  // the tab's visibility and whether the carousel is on screen
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    const element = root.current;
    const io =
      element && typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => setOffscreen(!entries.some((entry) => entry.isIntersecting)), { threshold: 0.25 })
        : null;
    if (element) io?.observe(element);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
    };
  }, []);

  // the fade of a move further than one slide (carouselMove "fade"): a later move takes over from it
  const fading = useRef<Animation | null>(null);
  const goTo = useCallback((target: number, options?: { instant?: boolean }) => {
    const element = track.current;
    if (!element || slideOffset(element, target) === null) return;
    fading.current?.cancel();
    fading.current = null;
    const kind = carouselMove(indexRef.current, target, options?.instant ? "reduced" : getMotionTier());
    if (kind === "smooth") {
      element.scrollBy({ left: slideOffset(element, target) ?? 0, behavior: "smooth" });
      return;
    }
    if (kind === "jump" || typeof element.animate !== "function") {
      jumpTo(element, target);
      return;
    }
    // fade out (from wherever an earlier fade left it), jump, fade in: one switch, never a rewind across every slide
    const out = element.animate({ opacity: 0 }, { duration: durations.exit, easing: easings.exit, fill: "forwards" });
    fading.current = out;
    out.finished.then(
      () => {
        if (fading.current !== out) return;
        fading.current = null;
        jumpTo(element, target);
        element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: durations.base, easing: easings.settle });
        out.cancel();
      },
      // cancelled by a later move: that move draws itself
      () => undefined,
    );
  }, []);
  useEffect(() => () => fading.current?.cancel(), []);

  const move = useCallback((delta: number) => goTo(stepIndex(indexRef.current, delta, count, wraps)), [goTo, count, wraps]);
  const stop = useCallback(() => dispatch({ type: "stop" }), []);

  // autoplay
  const waiting = autoplayWaits({ ...hold, canPlay, hidden, offscreen });
  useEffect(() => {
    if (waiting) return;
    const timer = setTimeout(() => goTo(stepIndex(indexRef.current, 1, count, true)), autoplay);
    return () => clearTimeout(timer);
  }, [waiting, index, autoplay, count, goTo]);

  return {
    index,
    count,
    canPlay,
    playing: canPlay && playing,
    running: !waiting,
    autoplay: canPlay ? autoplay : 0,
    goTo,
    next: () => move(1),
    previous: () => move(-1),
    toggle: () => dispatch({ type: "toggle" }),
    stop,
    rootProps: {
      ref: root,
      "aria-roledescription": t("carousel.role"),
      onPointerEnter: (event) => {
        if (event.pointerType === "mouse") dispatch({ type: "hover", on: true });
      },
      onPointerLeave: (event) => {
        if (event.pointerType === "mouse") dispatch({ type: "hover", on: false });
      },
      onFocus: () => dispatch({ type: "focus", on: true }),
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dispatch({ type: "focus", on: false });
      },
      onKeyDown: (event) => {
        // a key pressed in a dialog this carousel opened is the dialog's: React bubbles a portal's events through the
        // carousel, so ← → Home End on the dialog's keys moved the slides behind it (home review 2026-11-13)
        if (!event.currentTarget.contains(event.target as Node)) return;
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select, [contenteditable]")) return;
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        let to: number | null = null;
        const delta = keyDelta(event.key, rtl);
        if (delta !== 0) to = stepIndex(indexRef.current, delta, count, wraps);
        else if (event.key === "Home") to = 0;
        else if (event.key === "End") to = count - 1;
        if (to === null) return;
        event.preventDefault();
        dispatch({ type: "stop" });
        goTo(to);
      },
    },
    trackProps: {
      ref: track,
      id: trackId,
      tabIndex: 0,
      "aria-live": canPlay && playing ? "off" : "polite",
      // A finger holds autoplay while it is down. The browser fires pointercancel as soon as it takes the gesture for
      // a scroll, so the hold ends on touchend (or pointerup for a tap and a pen), and a scroll of the TRACK in between
      // is a swipe — a vertical page scroll that starts here never moves the track.
      onPointerDown: (event) => {
        if (event.pointerType === "touch" || event.pointerType === "pen") dispatch({ type: "touch", on: true });
      },
      onPointerUp: (event) => {
        if (event.pointerType === "touch" || event.pointerType === "pen") dispatch({ type: "touch", on: false });
      },
      onTouchEnd: () => dispatch({ type: "touch", on: false }),
      onTouchCancel: () => dispatch({ type: "touch", on: false }),
      onScroll: () => dispatch({ type: "swipe" }),
      onWheel: (event) => dispatch({ type: "wheel", deltaX: event.deltaX, deltaY: event.deltaY }),
    },
    slideProps: (i: number) => ({
      role: "group",
      "aria-roledescription": t("carousel.slide"),
      "aria-label": t("carousel.of", { index: fmt.number(i + 1), count: fmt.number(count) }),
      "data-carousel-slide": i,
    }),
  };

}

/**
 * The dots: one 44px button per slide («اعرض الشريحة 2 من 3»), the current one a wider red pill (aria-current).
 * `progress`: while the slides move on by themselves (`api.running`), the current dot's pill is a grey track that fills
 * in red over the interval; held, paused or stopped it is the full pill again (none under reduced motion: no autoplay).
 */
export function CarouselDots({ api, progress = false, className }: { api: CarouselApi; progress?: boolean; className?: string }) {
  const t = useT("ui");
  const fmt = useFormat();
  if (api.count < 2) return null;
  const run = progress && api.running && api.autoplay > 0;
  return (
    <div
      className={cx("carousel__dots", className)}
      data-run={run ? "" : undefined}
      style={run ? ({ "--carousel-autoplay": `${api.autoplay}ms` } as CSSProperties) : undefined}
    >
      {Array.from({ length: api.count }, (_, i) => (
        <button
          key={i}
          type="button"
          className="carousel__dot"
          aria-label={t("carousel.goTo", { index: fmt.number(i + 1), count: fmt.number(api.count) })}
          aria-current={i === api.index ? "true" : undefined}
          onClick={() => {
            api.stop();
            api.goTo(i);
          }}
        />
      ))}
    </div>
  );
}

/** Previous / next: 44px clay circles (G2; frosted discs with `over`). `size="sm"` (36px, the hit area still 44) for a
 *  dense rail. */
export function CarouselArrows({ api, over = false, size = "md", className }: { api: CarouselApi; over?: boolean; size?: "md" | "sm"; className?: string }) {
  const t = useT("ui");
  if (api.count < 2) return null;
  const variant = over ? "onImage" : "outline";
  return (
    <div className={cx("carousel__tools", className)}>
      <IconKey
        icon="caret-left"
        variant={variant}
        size={size}
        label={t("carousel.previous")}
        onClick={() => {
          api.stop();
          api.previous();
        }}
      />
      <IconKey
        icon="caret-right"
        variant={variant}
        size={size}
        label={t("carousel.next")}
        onClick={() => {
          api.stop();
          api.next();
        }}
      />
    </div>
  );
}

/** The pause / play key (WCAG 2.2.2) — rendered only while autoplay can run (once the page is live). A 44px clay
 *  circle like the arrows; `size="sm"` for a dense rail. */
export function CarouselPlay({ api, over = false, size = "md", className }: { api: CarouselApi; over?: boolean; size?: "md" | "sm"; className?: string }) {
  const t = useT("ui");
  if (!api.canPlay) return null;
  return (
    <IconKey
      icon={<Icon name={api.playing ? "media-pause" : "media-play"} size={size === "md" ? 20 : 18} />}
      variant={over ? "onImage" : "outline"}
      size={size}
      label={api.playing ? t("carousel.pause") : t("carousel.play")}
      onClick={api.toggle}
      className={className}
    />
  );
}

export type CarouselProps = {
  /** What the slides are («عروض المتجر»): the region's accessible name. */
  label: string;
  slides: ReactNode[] | ReactNode;
  /** Milliseconds between automatic moves (6000 is a good value). Omit for none. */
  autoplay?: number;
  loop?: boolean;
  /** The slide's aspect ratio ("390 / 220"): the one custom property a page sets (--carousel-aspect). */
  aspect?: string;
  /** The next slide shows at the edge (phones): 88% slides, the page gutter kept. */
  peek?: boolean;
  /** Where the controls go: "below" (default; dots centred, the keys at the end) or "over" the slide (frosted). */
  controls?: "below" | "over" | "none";
  /** Show the arrows (default true from the stylesheet's point of view: they are keys, not hover-only). */
  arrows?: boolean;
  /** The current dot fills with the time left while autoplay runs (default true; CarouselDots `progress`). */
  progress?: boolean;
  onIndexChange?: (index: number) => void;
  className?: string;
  slideClassName?: string;
  style?: CSSProperties;
};

export function Carousel({ label, slides, autoplay, loop, aspect, peek = false, controls = "below", arrows = true, progress = true, onIndexChange, className, slideClassName, style }: CarouselProps) {
  const items = Children.toArray(slides);
  const api = useCarousel({ count: items.length, autoplay, loop, onIndexChange });
  const over = controls === "over";
  return (
    <section
      {...api.rootProps}
      aria-label={label}
      className={cx("carousel", peek && "carousel--peek", className)}
      style={{ ...style, ...(aspect ? ({ "--carousel-aspect": aspect } as CSSProperties) : null) }}
    >
      <div {...api.trackProps} className="carousel__track">
        {items.map((slide, i) => (
          <div key={i} {...api.slideProps(i)} className={cx("carousel__slide", slideClassName)}>
            {slide}
          </div>
        ))}
      </div>
      {controls === "none" || items.length < 2 ? null : over ? (
        <div className="carousel__over">
          <CarouselPlay api={api} over />
          {arrows ? <CarouselArrows api={api} over /> : null}
        </div>
      ) : (
        <div className="carousel__bar">
          <CarouselDots api={api} progress={progress} />
          <CarouselPlay api={api} />
          {arrows ? <CarouselArrows api={api} className="max-md:hidden" /> : null}
        </div>
      )}
      {over && items.length > 1 ? (
        <div className="carousel__bar">
          <CarouselDots api={api} progress={progress} />
        </div>
      ) : null}
    </section>
  );
}
