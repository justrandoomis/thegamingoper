/**
 * <NumberMorph value format /> — digits roll per column to the new value (160 ms, water curve; DESIGN.md §7.2
 * "Currency number morph"). This is the only motion money is allowed.
 *
 *   const f = useFormat();
 *   <NumberMorph value={product.priceIqd} format={f.money} />       // also morphs when the display currency changes
 *   <NumberMorph value={cart.count} />
 *
 * - Assistive technology gets the final text immediately (a visually hidden copy); the animated glyphs are aria-hidden.
 * - Only digits and their separators are split into slots, inside a left-to-right island, so Arabic currency text
 *   keeps its shaping and the bidi order is the same as plain text. Works with Latin and Arabic-Indic digits.
 * - Tabular cells: a changing digit never nudges its neighbours, so equal digit counts never change the width. When
 *   the number of characters changes the row takes its new width once, at the start — nothing animates layout.
 * - Rolls up when the value grows, down when it shrinks. Text around the digits (the currency label) is never
 *   animated: it is visible in every frame and simply swaps when it changes.
 * - Reduced motion: the number replaces the number. Server-rendered output is the plain final value.
 */
import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";

import { useHydrating } from "./bubble";
import { getMotionTier } from "./env";

export type NumberMorphProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  value: number;
  /** Turns the value into display text (e.g. `useFormat().money`). Default: `String(value)`. */
  format?: (value: number) => string;
};

type Segment = { number: boolean; text: string };

/** A digit, optionally followed by more digits with grouping/decimal separators between them. */
const NUMBER_RUN = /\p{Nd}(?:[\p{Nd}.,٫٬'    ]*\p{Nd})?/gu;

function segment(text: string): Segment[] {
  const out: Segment[] = [];
  let index = 0;
  for (const match of text.matchAll(NUMBER_RUN)) {
    const start = match.index;
    if (start > index) out.push({ number: false, text: text.slice(index, start) });
    out.push({ number: true, text: match[0] });
    index = start + match[0].length;
  }
  if (index < text.length) out.push({ number: false, text: text.slice(index) });
  return out;
}

type Snapshot = { text: string; value: number; previous: string | null; direction: 1 | -1; tick: number };

export function NumberMorph({ value, format, className, style, ...rest }: NumberMorphProps) {
  const text = format ? format(value) : String(value);

  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ text, value, previous: null, direction: 1, tick: 0 }));
  let current = snapshot;
  if (snapshot.text !== text) {
    current = { text, value, previous: snapshot.text, direction: value < snapshot.value ? -1 : 1, tick: snapshot.tick + 1 };
    setSnapshot(current);
  }

  const now = segment(current.text);
  const before = current.previous === null ? null : segment(current.previous);
  const beforeNumbers = before?.filter((s) => s.number) ?? [];
  let numberIndex = 0;

  return (
    <span className={className ? `tt-num ${className}` : "tt-num"} style={style} {...rest}>
      <span className="tt-num-sr">{current.text}</span>
      <span aria-hidden="true" style={{ "--tt-num-dir": current.direction } as CSSProperties}>
        {now.map((part, partIndex) => {
          // Labels (currency, units) are visible in every frame: they swap, they never fade.
          if (!part.number) return <span key={`t${partIndex}`}>{part.text}</span>;
          const chars = Array.from(part.text);
          const old = beforeNumbers[numberIndex++];
          const oldChars = old ? Array.from(old.text) : null;
          return (
            <span key={`n${partIndex}`} className="tt-num-run">
              {chars.map((char, i) => {
                const fromEnd = chars.length - i;
                const previous = oldChars ? oldChars[oldChars.length - fromEnd] : undefined;
                const changed = before !== null && previous !== char;
                // Western digits get a fixed 1ch box: not every font honours tabular-nums (heavy weights often do not).
                const digit = char >= "0" && char <= "9";
                return (
                  <span key={fromEnd} className={digit ? "tt-num-slot tt-num-digit" : "tt-num-slot"}>
                    {changed && previous !== undefined ? (
                      <span key={`o${current.tick}`} className="tt-num-out">
                        {previous}
                      </span>
                    ) : null}
                    <span key={changed ? `i${current.tick}` : "s"} className={changed ? "tt-num-in" : undefined}>
                      {char}
                    </span>
                  </span>
                );
              })}
            </span>
          );
        })}
      </span>
    </span>
  );
}

/* ───────────────────────────── CountUp (Design v2.1 G6) ───────────────────────────── */

export type CountUpProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** The number to land on (an integer: points, an offer, a KPI). */
  value: number;
  /** Where the count starts. Default 0. */
  from?: number;
  /** Turns a number into display text (e.g. `useFormat().number`). Default: `String(value)`. */
  format?: (value: number) => string;
  /** Length of the count in ms. Default 640 (eased out; never longer than 900). */
  duration?: number;
  /**
   * The page's ONE focus figure (a trade-in offer, the rewards balance): it counts on a direct open too. The server
   * keeps the final value; once the page is live, with full motion and the figure on screen, it counts from 70% of
   * the way to the value in about half a second — never down to zero, no layout shift. Off: a server-rendered figure
   * on the first screen keeps its value (no flash), as every other CountUp.
   */
  playOnLoad?: boolean;
};

/** Where a count starts (pure; exported for tests): `from`, or — for a server-rendered `playOnLoad` figure — 70% of the
 *  way to the value (the shopper saw the final value first; it never drops to zero). */
export function countUpStart({ value, from, serverRendered, playOnLoad }: { value: number; from: number; serverRendered: boolean; playOnLoad: boolean }): number {
  return serverRendered && playOnLoad ? Math.round(from + (value - from) * 0.7) : from;
}

/** The eased value at time `t` (0…1) of a count from `from` to `to`, rounded to an integer (pure, for tests). */
export function countAt(from: number, to: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const eased = 1 - Math.pow(1 - clamped, 3); // ease-out cubic: fast, then settles
  return Math.round(from + (to - from) * eased);
}

/**
 * What a CountUp does once it has mounted (pure; exported for tests). Off screen it waits at its start (`from`, out of
 * sight, so the shopper never sees the final value drop to zero when it arrives) and counts when it comes into view; a
 * server-rendered number already on screen keeps its final value; a client mount on screen counts at once; without
 * full motion it is simply the final value.
 */
export function countUpPlan(env: { serverRendered: boolean; visible: boolean; full: boolean; playOnLoad?: boolean }): { show: "final" | "from"; count: "never" | "now" | "on-view" } {
  if (!env.full) return { show: "final", count: "never" };
  if (!env.visible) return { show: "from", count: "on-view" };
  return env.serverRendered && !env.playOnLoad ? { show: "final", count: "never" } : { show: "from", count: "now" };
}

/**
 * <CountUp value={2000} format={f.number} /> — a number that matters counts up ONCE, when it first comes into view
 * (points on the rewards page, a trade-in offer, a dashboard KPI). For a value that CHANGES (a total, a price after a
 * currency switch) use <NumberMorph>, which rolls its digits.
 *
 * - No layout shift: the final text reserves the width (an invisible copy in the same grid cell), the counting text
 *   sits on top of it. Assistive technology reads the final text only.
 * - Server-rendered output and the first paint of a hydrated page show the final value: a number that was already on
 *   the first screen of a server-rendered page does not drop to zero and count again (no flash). A number that mounts
 *   on a client navigation, or one that is scrolled into view later, counts up.
 * - Reduced motion (OS or the store's switch) and the lite tier: the final value, no count.
 */
export function CountUp({ value, from = 0, format, duration = 640, playOnLoad = false, className, style, ...rest }: CountUpProps) {
  const text = (n: number) => (format ? format(n) : String(n));
  const hydrating = useHydrating();
  const element = useRef<HTMLSpanElement>(null);
  // Decided once, when the element mounts: a client mount may start from `from` at once (nothing was painted yet).
  const [startsCounted] = useState(() => hydrating || typeof window === "undefined");
  const [shown, setShown] = useState<number>(() => (startsCounted ? value : getMotionTier() === "full" ? from : value));
  const played = useRef(false);

  useEffect(() => {
    const el = element.current;
    if (!el || played.current) return;
    const box = el.getBoundingClientRect();
    const plan = countUpPlan({
      serverRendered: startsCounted,
      visible: box.top < window.innerHeight && box.bottom > 0,
      full: getMotionTier() === "full" && typeof IntersectionObserver === "function",
      playOnLoad,
    });
    if (plan.count === "never") {
      played.current = true;
      setShown(value);
      return;
    }
    // a server-rendered focus figure counts the last 30% of the way (it was shown final first: never down to zero)
    const origin = countUpStart({ value, from, serverRendered: startsCounted, playOnLoad });
    let frame = 0;
    const run = () => {
      played.current = true;
      const start = performance.now();
      const length = playOnLoad && startsCounted ? 520 : Math.min(900, Math.max(200, duration));
      const step = (now: number) => {
        const t = (now - start) / length;
        setShown(countAt(origin, value, t));
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };
    // wait at the start — out of sight below the fold (never the final value that then drops to zero on arrival) — and
    // count once 40% of it is in view; a client mount on screen ("now") is in view at the observer's first report. The
    // count always starts from the observer (never inside this effect), so the value effect below cannot cut it short
    // and a development double mount starts it again.
    setShown(origin);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        io.disconnect();
        run();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, from, duration, startsCounted, playOnLoad]);

  // a new value after the count has played lands at once (a changing number belongs to <NumberMorph>)
  useEffect(() => {
    if (played.current) setShown(value);
  }, [value]);

  const finalText = text(value);
  return (
    <span ref={element} className={className ? `count ${className}` : "count"} style={style} {...rest}>
      <span className="tt-num-sr">{finalText}</span>
      <span className="count__final" aria-hidden="true">
        {finalText}
      </span>
      <span className="count__live" aria-hidden="true">
        {text(shown)}
      </span>
    </span>
  );
}
