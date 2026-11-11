/**
 * TamTam Motion Engine — the pure parts: spring solver and its CSS/WAAPI output, gesture maths, flight path,
 * quality-tier resolution (and the head script that repeats it), the navigation grammar, when a bubble inflates
 * (never while hydrating — checked in Chromium on /design-system#reveal), and guards that keep the
 * stylesheets honest (tokens in sync with tokens.ts and with the design tokens of docs/DESIGN.md §7.1, keyframes
 * limited to transform and opacity).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import messages from "~/i18n/messages/motion";
import { Bubble, BubbleGroup, inflateOnMount, type InflateInput } from "~/motion/bubble";
import { resolveTier, type MotionTier, type TierSignals } from "~/motion/env";
import { resolveNav, reverseNav, type NavDescriptor, type NavRecord, type ResolveInput } from "~/motion/nav-plan";
import { arcControl, flightMs, pickSnap, project, quadBezier, rubberBand, rubberBandClamp, samplePath, velocityFrom } from "~/motion/physics";
import { springDuration, springEasing, springKeyframes, springValue, springVelocity } from "~/motion/spring";
import { staggerStep } from "~/motion/stagger";
import { MOTION_TIER_SCRIPT } from "~/motion/tier-script";
import { bubble, durations, easings, fly, SPRING_NAMES, springs, travel, type Spring } from "~/motion/tokens";
import { canonicalSpring, renderTokenCss, replaceTokenBlock } from "~/motion/tokens-css";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const motionCss = read("../app/motion/motion.css");
const extrasCss = read("../app/motion/extras.css");
/** The design system's copy of the DESIGN.md §7.1 tokens (owner: design system). */
const designTokens = read("../app/styles/tokens.css");

describe("spring solver", () => {
  const all = Object.entries(springs) as Array<[string, Spring]>;

  it("starts at `from` and comes to rest at `to`", () => {
    for (const [, spring] of all) {
      expect(springValue(spring, 0)).toBeCloseTo(0, 10);
      expect(springValue(spring, 5)).toBeCloseTo(1, 6);
      expect(springValue(spring, 0, { from: 320, to: 0 })).toBeCloseTo(320, 8);
      expect(springValue(spring, 5, { from: 320, to: 0 })).toBeCloseTo(0, 3);
    }
  });

  it("a critically damped spring never overshoots; an overdamped one neither", () => {
    for (const spring of [springs.fly, { response: 0.4, dampingRatio: 1.6 }]) {
      let previous = 0;
      for (let t = 0; t <= 2; t += 0.005) {
        const x = springValue(spring, t);
        expect(x).toBeLessThanOrEqual(1 + 1e-9);
        expect(x).toBeGreaterThanOrEqual(previous - 1e-9); // monotonic
        previous = x;
      }
    }
  });

  it("an underdamped spring overshoots by exp(−πζ/√(1−ζ²))", () => {
    for (const spring of [springs.bouncy, springs.gentle]) {
      const zeta = spring.dampingRatio;
      const expected = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
      let peak = 0;
      for (let t = 0; t <= 2; t += 0.0005) peak = Math.max(peak, springValue(spring, t));
      expect(peak - 1).toBeCloseTo(expected, 3);
    }
  });

  it("reports the true derivative as velocity", () => {
    const h = 1e-5;
    for (const [, spring] of all) {
      for (const t of [0.01, 0.05, 0.12, 0.3]) {
        const numeric = (springValue(spring, t + h, { velocity: 2 }) - springValue(spring, t - h, { velocity: 2 })) / (2 * h);
        expect(springVelocity(spring, t, { velocity: 2 })).toBeCloseTo(numeric, 4);
      }
    }
  });

  it("carries an initial velocity (a flicked sheet keeps moving the way it was thrown)", () => {
    const away = { from: 300, to: 0, velocity: 1800 }; // thrown away from the target
    expect(springVelocity(springs.sheet, 0, away)).toBeCloseTo(1800, 6);
    expect(springValue(springs.sheet, 0.005, away)).toBeGreaterThan(300); // still travelling the way it was thrown
    expect(springValue(springs.sheet, 3, away)).toBeCloseTo(0, 2);
    // thrown toward the target it gets there sooner than from rest
    const toward = { from: 300, to: 0, velocity: -1800 };
    expect(springValue(springs.sheet, 0.05, toward)).toBeLessThan(springValue(springs.sheet, 0.05, { from: 300, to: 0 }));
    // and the first frame continues at the finger's speed (no stall at hand-off)
    expect(300 - springValue(springs.sheet, 1 / 120, toward)).toBeGreaterThan((1800 / 120) * 0.8);
  });

  it("can be interrupted and resumed without a seam", () => {
    // Stop a settle at t1, restart from the sampled position and velocity: the path must be the same curve.
    const original = { from: 420, to: 0, velocity: -900 };
    for (const t1 of [0.02, 0.07, 0.15]) {
      const x1 = springValue(springs.sheet, t1, original);
      const v1 = springVelocity(springs.sheet, t1, original);
      for (const dt of [0.01, 0.05, 0.2]) {
        expect(springValue(springs.sheet, dt, { from: x1, to: 0, velocity: v1 })).toBeCloseTo(springValue(springs.sheet, t1 + dt, original), 6);
      }
    }
  });

  it("knows when it is at rest", () => {
    for (const [, spring] of all) {
      const seconds = springDuration(spring);
      expect(seconds).toBeGreaterThan(0.05);
      expect(seconds).toBeLessThan(1);
      for (let t = seconds; t < seconds + 1; t += 0.01) expect(Math.abs(springValue(spring, t) - 1)).toBeLessThanOrEqual(0.002 + 1e-9);
    }
    expect(springDuration(springs.snappy)).toBeLessThan(springDuration(springs.gentle));
    expect(springDuration(springs.gentle)).toBeLessThan(springDuration(springs.bouncy));
    // pixel precision: a 400px throw is not "at rest" until it is within half a pixel
    const px = springDuration(springs.sheet, { from: 400, to: 0 }, 0.5);
    expect(Math.abs(springValue(springs.sheet, px, { from: 400, to: 0 }))).toBeLessThanOrEqual(0.5);
  });
});

describe("spring → CSS linear()", () => {
  function parse(easing: string): Array<{ x: number; y: number }> {
    expect(easing.startsWith("linear(") && easing.endsWith(")")).toBe(true);
    const parts = easing.slice(7, -1).split(", ");
    return parts.map((part, i) => {
      const [value, percent] = part.split(" ");
      const x = percent ? parseFloat(percent) / 100 : i === 0 ? 0 : 1;
      return { x, y: Number(value) };
    });
  }
  function evaluate(stops: Array<{ x: number; y: number }>, x: number): number {
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i].x) {
        const a = stops[i - 1];
        const b = stops[i];
        return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
      }
    }
    return 1;
  }

  it("is a valid linear() from 0 to 1 with increasing stops, lasting the published settle time", () => {
    for (const spring of Object.values(springs) as Spring[]) {
      const { easing, duration } = springEasing(spring);
      const stops = parse(easing);
      expect(stops[0]).toEqual({ x: 0, y: 0 });
      expect(stops[stops.length - 1]).toEqual({ x: 1, y: 1 });
      for (let i = 1; i < stops.length; i++) expect(stops[i].x).toBeGreaterThan(stops[i - 1].x);
      expect(stops.length).toBeLessThanOrEqual(40);
      expect(duration).toBe(spring.settleMs);
      // The published settle time is the solver's 0.2 % settle time rounded to 10 ms (DESIGN.md §7.1).
      expect(Math.abs(spring.settleMs! - springDuration(spring) * 1000)).toBeLessThanOrEqual(10);
      expect(Math.abs(springValue(spring, spring.settleMs! / 1000) - 1)).toBeLessThan(0.002);
    }
    const computed = springEasing({ response: 0.3, dampingRatio: 0.7 });
    expect(computed.duration).toBe(Math.round(springDuration({ response: 0.3, dampingRatio: 0.7 }) * 1000));
  });

  it("follows the spring curve to within half a percent everywhere", () => {
    for (const spring of Object.values(springs)) {
      const { easing, duration } = springEasing(spring);
      const stops = parse(easing);
      for (let i = 0; i <= 200; i++) {
        const x = i / 200;
        const exact = i === 200 ? 1 : springValue(spring, (x * duration) / 1000);
        expect(Math.abs(evaluate(stops, x) - exact)).toBeLessThan(0.005);
      }
    }
  });

  it("keeps DESIGN.md's overshoot for each preset (8 %, 16 %, 5 %, none, 0.5 %)", () => {
    const peak = (spring: Spring) => Math.max(...parse(springEasing(spring).easing).map((s) => s.y));
    expect(peak(springs.press)).toBeCloseTo(1.083, 2);
    expect(peak(springs.squish)).toBeCloseTo(1.163, 2);
    expect(peak(springs.inflate)).toBeCloseTo(1.054, 2);
    expect(peak(springs.settle)).toBeLessThanOrEqual(1);
    expect(peak(springs.sheet)).toBeCloseTo(1.005, 2);
    // the earlier names are the same objects
    expect(springs.snappy).toBe(springs.press);
    expect(springs.gentle).toBe(springs.inflate);
    expect(springs.bouncy).toBe(springs.squish);
    expect(springs.fly).toBe(springs.settle);
  });

  it("samples WAAPI keyframes that end exactly on the target", () => {
    const { values, duration } = springKeyframes(springs.sheet, { from: 320, to: 0, velocity: -2400 });
    expect(values[0]).toBeCloseTo(320, 6);
    expect(values[values.length - 1]).toBe(0);
    expect(320 - values[1]).toBeGreaterThan(25); // one 60 Hz frame at 2400 px/s is 40 px: the hand-off keeps the speed
    expect(Math.min(...values)).toBeLessThan(0); // carried past the target, then settles
    expect(duration).toBeGreaterThan(100);
    expect(Math.abs(values.length - 1 - duration / (1000 / 60))).toBeLessThan(1); // one value per 60 Hz frame
    // a spring that is already at rest still yields a valid, tiny animation
    const still = springKeyframes(springs.sheet, { from: 0, to: 0 });
    expect(still.values[still.values.length - 1]).toBe(0);
    expect(still.duration).toBeGreaterThan(0);
  });
});

describe("momentum, rubber band, snapping", () => {
  it("projects momentum like a decelerating scroll view", () => {
    expect(project(0)).toBe(0);
    expect(project(1000)).toBeCloseTo(499, 0); // 1000 px/s coasts ≈ 499 px at rate 0.998
    expect(project(-1000)).toBeCloseTo(-499, 0);
    expect(project(1000, 0.99)).toBeCloseTo(99, 0);
  });

  it("rubber-bands: follows at first, then resists, never reaches the limit", () => {
    expect(rubberBand(0, 600)).toBe(0);
    expect(rubberBand(1, 600)).toBeCloseTo(0.55, 2);
    expect(rubberBand(150, 600)).toBeLessThan(150);
    expect(rubberBand(150, 600)).toBeGreaterThan(40);
    expect(rubberBand(1e6, 600)).toBeLessThan(600);
    expect(rubberBand(-150, 600)).toBeCloseTo(-rubberBand(150, 600), 10);
    let previous = 0;
    for (let offset = 10; offset <= 2000; offset += 10) {
      const value = rubberBand(offset, 600);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
    expect(rubberBandClamp(100, 0, 320, 640)).toBe(100);
    expect(rubberBandClamp(-80, 0, 320, 640)).toBeCloseTo(rubberBand(-80, 640), 10);
    expect(rubberBandClamp(400, 0, 320, 640)).toBeCloseTo(320 + rubberBand(80, 640), 10);
  });

  it("picks the snap point the gesture is aiming at", () => {
    const points = [320, 0, 640]; // half open, fully open, closed (px pushed down)
    expect(pickSnap(points, 200, 0)).toBe(0); // resting nearer to half
    expect(pickSnap(points, 120, 0)).toBe(1); // resting nearer to open
    expect(pickSnap(points, 300, -900)).toBe(1); // flicked up from half → open
    expect(pickSnap(points, 330, 1400)).toBe(2); // flicked down from half → closed
    expect(pickSnap(points, 330, 200)).toBe(0); // a lazy drift stays
    expect(pickSnap([], 0, 0)).toBe(-1);
  });

  it("reads release velocity from the last 100 ms and treats a held finger as still", () => {
    const moving = Array.from({ length: 12 }, (_, i) => ({ t: 1000 + i * 16, v: i * 32 })); // 2 px/ms
    expect(velocityFrom(moving, 1000 + 11 * 16)).toBeCloseTo(2000, -1);
    expect(velocityFrom(moving, 1000 + 11 * 16 + 200)).toBe(0); // lifted long after the last move
    const slowThenFast = [
      { t: 0, v: 0 },
      { t: 400, v: 4 },
      { t: 416, v: 36 },
      { t: 432, v: 68 },
    ];
    expect(velocityFrom(slowThenFast, 432)).toBeCloseTo(2000, -1); // the slow start is outside the window
    expect(velocityFrom([{ t: 0, v: 0 }], 0)).toBe(0);
  });
});

describe("fly-to-cart path", () => {
  const from = { x: 80, y: 600 };
  const to = { x: 340, y: 40 };

  it("is a quadratic Bézier through both ends", () => {
    const control = arcControl(from, to);
    expect(quadBezier(from, control, to, 0)).toEqual(from);
    expect(quadBezier(from, control, to, 1)).toEqual(to);
    const mid = quadBezier(from, control, to, 0.5);
    expect(mid.x).toBeCloseTo(0.25 * from.x + 0.5 * control.x + 0.25 * to.x, 10);
    expect(mid.y).toBeCloseTo(0.25 * from.y + 0.5 * control.y + 0.25 * to.y, 10);
  });

  it("has its control point halfway across, 70px above the higher end (DESIGN.md §7.2)", () => {
    const control = arcControl(from, to);
    expect(control).toEqual({ x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - fly.lift });
    expect(fly.lift).toBe(70);
    // Going up into a cart at the top: the bead rises above the cart and drops into it.
    const apex = Math.min(...samplePath(from, control, to, 200).map((p) => p.y));
    expect(apex).toBeLessThan(to.y);
    expect(arcControl({ x: 0, y: 0 }, { x: 100, y: 0 }, 0)).toEqual({ x: 50, y: 0 }); // no lift: a straight line
  });

  it("takes 420 ms + 0.3 ms per px, at most 600 ms", () => {
    expect(flightMs(0)).toBe(420);
    expect(flightMs(200)).toBe(480);
    expect(flightMs(600)).toBe(600);
    expect(flightMs(5000)).toBe(600);
    expect(fly.maxConcurrent).toBe(3);
    expect(fly.endScale).toBe(0.55);
  });

  it("samples the whole path and bows away from the straight line", () => {
    const control = arcControl(from, to);
    const path = samplePath(from, control, to, 20);
    expect(path).toHaveLength(21);
    expect(path[0]).toEqual(from);
    expect(path[20]).toEqual(to);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const bow = Math.max(...path.map((p) => Math.abs((to.x - from.x) * (from.y - p.y) - (from.x - p.x) * (to.y - from.y)) / length));
    expect(bow).toBeGreaterThan(20);
    const eased = samplePath(from, control, to, 4, (t) => t * t);
    expect(eased[2]).toEqual(quadBezier(from, control, to, 0.25));
  });
});

describe("quality tier", () => {
  const capable: TierSignals = { reducedMotion: false, saveData: false, deviceMemory: 8, hardwareConcurrency: 8, smallScreen: true };

  it("is full on a capable device and when nothing is known", () => {
    expect(resolveTier(capable)).toBe("full");
    expect(resolveTier({ reducedMotion: false, saveData: false })).toBe("full");
  });

  it("keeps every iPhone on full: WebKit reports 4 cores for any device below 8 and no deviceMemory", () => {
    expect(resolveTier({ reducedMotion: false, saveData: false, hardwareConcurrency: 4, smallScreen: true })).toBe("full");
  });

  it("reduces for prefers-reduced-motion before anything else", () => {
    expect(resolveTier({ ...capable, reducedMotion: true })).toBe("reduced");
    expect(resolveTier({ ...capable, reducedMotion: true, saveData: true })).toBe("reduced");
  });

  it("goes lite (DESIGN.md §6.5) for Save-Data, ≤ 2 GB, ≤ 4 cores on a phone, and after measured jank", () => {
    expect(resolveTier({ ...capable, saveData: true })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 2 })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 1, smallScreen: false })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 4, hardwareConcurrency: 4 })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 4, hardwareConcurrency: 4, smallScreen: false })).toBe("full"); // a 4-core laptop
    expect(resolveTier({ ...capable, deviceMemory: 4, hardwareConcurrency: 8 })).toBe("full");
    expect(resolveTier({ ...capable, janky: true })).toBe("lite");
  });

  it("lets the shopper's override win in both directions", () => {
    expect(resolveTier({ ...capable, reducedMotion: true, override: "full" })).toBe("full");
    expect(resolveTier({ ...capable, override: "reduced" })).toBe("reduced");
    expect(resolveTier({ ...capable, saveData: true, override: "full" })).toBe("full");
    expect(resolveTier({ ...capable, janky: true, override: "full" })).toBe("full");
    expect(resolveTier({ ...capable, override: "lite" })).toBe("lite");
    expect(resolveTier({ ...capable, override: null })).toBe("full");
  });

  it("the head script (MOTION_TIER_SCRIPT) decides exactly like resolveTier for every combination", () => {
    let combinations = 0;
    for (const override of [null, "full", "lite", "reduced"] as const)
      for (const reducedMotion of [false, true])
        for (const saveData of [false, true])
          for (const janky of [false, true])
            for (const deviceMemory of [undefined, 1, 2, 4, 8])
              for (const hardwareConcurrency of [undefined, 2, 4, 8])
                for (const smallScreen of [false, true]) {
                  const signals: TierSignals = { override, reducedMotion, saveData, janky, deviceMemory, hardwareConcurrency, smallScreen };
                  const classes = new Set<string>();
                  const attributes: Record<string, string> = {};
                  runInNewContext(MOTION_TIER_SCRIPT, {
                    document: {
                      documentElement: {
                        setAttribute: (name: string, value: string) => void (attributes[name] = value),
                        classList: { toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)) },
                      },
                    },
                    navigator: { connection: { saveData }, deviceMemory, hardwareConcurrency },
                    screen: smallScreen ? { width: 390, height: 844 } : { width: 1440, height: 900 },
                    localStorage: { getItem: (key: string) => (key === "tt:motion" ? override : null) },
                    sessionStorage: { getItem: (key: string) => (key === "tt:motion-low" && janky ? "1" : null) },
                    matchMedia: (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion }),
                  });
                  const expected: MotionTier = resolveTier(signals);
                  expect(attributes["data-motion"], JSON.stringify(signals)).toBe(expected);
                  expect(classes.has("fx-low")).toBe(expected === "lite");
                  combinations++;
                }
    expect(combinations).toBe(4 * 2 * 2 * 2 * 5 * 4 * 2);
    // and it never throws, even with no storage at all
    expect(() =>
      runInNewContext(MOTION_TIER_SCRIPT, { document: { documentElement: {} }, navigator: {}, matchMedia: () => ({ matches: false }) }),
    ).not.toThrow();
  });
});

describe("navigation grammar", () => {
  const at = (pathname: string, extra: Partial<NavDescriptor> = {}): NavDescriptor => ({ key: pathname + (extra.search ?? ""), pathname, search: "", order: null, group: null, nav: null, ...extra });
  const base: ResolveInput = { type: "PUSH", delta: null, from: at("/"), to: at("/cart"), intent: null, arrivedBy: null, destination: null, fromOrder: null, claim: null };
  const record = (nav: NavRecord["nav"], back = false, extra: Partial<NavRecord> = {}): NavRecord => ({ nav, back, origin: null, share: null, ...extra });

  it("fades between unrelated pages and stays out of same-page changes", () => {
    expect(resolveNav(base)).toMatchObject({ nav: "fade", back: false });
    expect(resolveNav({ ...base, to: at("/", { search: "?q=ps5" }) })).toBeNull();
    expect(resolveNav({ ...base, type: "REPLACE", to: at("/", { search: "?sort=price" }) })).toBeNull();
  });

  it("honours an explicit intent and remembers the tapped shared element", () => {
    const claim = { name: "product-image:abc", slot: null };
    const plan = resolveNav({ ...base, to: at("/p/abc"), intent: { nav: "zoom", origin: { x: 120, y: 300 } }, claim });
    expect(plan).toEqual({ nav: "zoom", back: false, origin: { x: 120, y: 300 }, share: claim, order: null });
    expect(resolveNav({ ...base, intent: { nav: "rise" } })).toMatchObject({ nav: "rise", back: false });
    expect(resolveNav({ ...base, intent: { nav: "zoom", back: true } })).toMatchObject({ nav: "zoom", back: true });
    // an intent can animate a same-page change (a tab kept in the query string)
    expect(resolveNav({ ...base, to: at("/", { search: "?tab=b" }), intent: { nav: "push" } })).toMatchObject({ nav: "push-forward" });
    expect(resolveNav({ ...base, intent: { nav: "direction" }, claim })).toMatchObject({ nav: "direction", share: null });
  });

  it("pushes siblings sideways by their order, in the right direction", () => {
    const tab = (n: number) => at("/account", { search: `?tab=${n}`, order: n, group: "account" });
    expect(resolveNav({ ...base, from: tab(1), to: tab(3) })).toMatchObject({ nav: "push-forward", back: false, order: 3 });
    expect(resolveNav({ ...base, from: tab(3), to: tab(1) })).toMatchObject({ nav: "push-back", back: true, order: 1 });
    expect(resolveNav({ ...base, from: tab(2), to: tab(2) })).toBeNull();
    // same order numbers in different groups are not siblings
    expect(resolveNav({ ...base, from: at("/a", { order: 1, group: "x" }), to: at("/b", { order: 2, group: "y" }) })).toMatchObject({ nav: "fade" });
    // an intent's order is compared with where we are
    expect(resolveNav({ ...base, from: tab(2), to: at("/account"), intent: { nav: "push", order: 0 } })).toMatchObject({ nav: "push-back", order: 0 });
    expect(resolveNav({ ...base, fromOrder: 1, intent: { nav: "push", order: 4 } })).toMatchObject({ nav: "push-forward", order: 4 });
    expect(resolveNav({ ...base, intent: { nav: "push", back: true } })).toMatchObject({ nav: "push-back", back: true });
  });

  it("uses the route handle when nothing else says", () => {
    expect(resolveNav({ ...base, to: at("/cart", { nav: "rise" }) })).toMatchObject({ nav: "rise", back: false });
    expect(resolveNav({ ...base, to: at("/steps/2", { nav: "push" }) })).toMatchObject({ nav: "push-forward" });
  });

  it("plays Back as the reverse of what brought the shopper here, and Forward as a replay", () => {
    const share = { name: "product-image:abc", slot: "trending" };
    const arrived = record("zoom", false, { origin: { x: 10, y: 20 }, share });
    const back = resolveNav({ ...base, type: "POP", delta: -1, from: at("/p/abc"), to: at("/"), arrivedBy: arrived });
    expect(back).toEqual({ nav: "zoom", back: true, origin: { x: 10, y: 20 }, share, order: null });
    const forward = resolveNav({ ...base, type: "POP", delta: 1, from: at("/"), to: at("/p/abc"), destination: arrived });
    expect(forward).toMatchObject({ nav: "zoom", back: false, share });
    expect(resolveNav({ ...base, type: "POP", delta: -1, arrivedBy: record("push-forward") })).toMatchObject({ nav: "push-back", back: true });
    expect(resolveNav({ ...base, type: "POP", delta: -1, arrivedBy: record("push-back", true) })).toMatchObject({ nav: "push-forward", back: false });
    expect(resolveNav({ ...base, type: "POP", delta: -1, arrivedBy: record("rise") })).toMatchObject({ nav: "rise", back: true });
    // a pending intent never hijacks Back/Forward
    expect(resolveNav({ ...base, type: "POP", delta: -1, arrivedBy: record("rise"), intent: { nav: "zoom" } })).toMatchObject({ nav: "rise", back: true });
  });

  it("falls back to structure when there is no memory of the step", () => {
    expect(resolveNav({ ...base, type: "POP", delta: -1 })).toMatchObject({ nav: "fade", back: true });
    expect(resolveNav({ ...base, type: "POP", delta: -3, arrivedBy: record("zoom") })).toMatchObject({ nav: "fade", back: true });
    expect(resolveNav({ ...base, type: "POP", delta: null, to: at("/", { search: "?page=2" }) })).toBeNull();
    const step = (n: number) => at(`/steps/${n}`, { order: n, group: "steps" });
    expect(resolveNav({ ...base, type: "POP", delta: -1, from: step(3), to: step(2) })).toMatchObject({ nav: "push-back" });
  });

  it("reverses every transition to its own inverse", () => {
    for (const nav of ["fade", "zoom", "rise", "direction", "push-forward", "push-back"] as const) {
      const start = { nav, back: nav === "push-back" };
      expect(reverseNav(reverseNav(start))).toEqual(start);
    }
  });
});

describe("design tokens (docs/DESIGN.md §7.1, app/styles/tokens.css)", () => {
  const value = (name: string) => {
    const match = new RegExp(`${name}:\\s*([^;]+);`).exec(designTokens);
    if (!match) throw new Error(`${name} is missing from app/styles/tokens.css`);
    return match[1].trim();
  };
  const curve = (css: string) => css.replace(/\s+/g, "").replace(/(^|[(,])\./g, "$10");

  it("has the same durations", () => {
    for (const name of ["press", "release", "micro", "exit", "reveal", "sheet", "page", "fly", "theme"] as const) {
      expect(value(`--t-${name}`), name).toBe(`${durations[name]}ms`);
    }
  });

  it("has the same curves", () => {
    for (const name of ["settle", "squish", "exit", "water"] as const) expect(curve(value(`--ease-${name}`)), name).toBe(curve(easings[name]));
  });

  it("has the same five springs: {response, dampingRatio}, settle time, and the same curve", () => {
    for (const name of SPRING_NAMES) {
      const spring = springs[name];
      expect(value(`--spring-${name}-t`), name).toBe(`${spring.settleMs}ms`);
      // the pair is written beside the settle time: --spring-press-t: 260ms; /* {.16, .62} */
      const pair = new RegExp(`--spring-${name}-t:[^;]+;\\s*/\\*\\s*\\{([\\d.]+),\\s*([\\d.]+)\\}`).exec(designTokens);
      expect(pair, name).not.toBeNull();
      expect(Number(pair![1])).toBe(spring.response);
      expect(Number(pair![2])).toBe(spring.dampingRatio);
      // DESIGN.md samples each spring at 21 equal steps; every sample sits on the engine's curve.
      const samples = value(`--spring-${name}`).slice(7, -1).split(",").map(Number);
      expect(samples).toHaveLength(21);
      samples.forEach((sample, i) => expect(Math.abs(sample - springValue(spring, ((i / 20) * spring.settleMs) / 1000)), `${name}[${i}]`).toBeLessThan(0.003));
    }
  });

  it("names every earlier alias after the design spring it now is", () => {
    expect(canonicalSpring("snappy")).toBe("press");
    expect(canonicalSpring("gentle")).toBe("inflate");
    expect(canonicalSpring("bouncy")).toBe("squish");
    expect(canonicalSpring("fly")).toBe("settle");
    expect(canonicalSpring("sheet")).toBe("sheet");
  });
});

describe("motion.css", () => {
  it("has the tokens generated from tokens.ts (run: npx tsx app/motion/__checks__/gen-css.mjs)", () => {
    expect(replaceTokenBlock(motionCss)).toBe(motionCss);
    const block = renderTokenCss();
    for (const name of ["press", "exit", "micro", "release", "theme", "base", "reveal", "sheet", "page", "fly", "slow"] as const) {
      expect(block).toContain(`--motion-duration-${name}: ${durations[name]}ms;`);
    }
    expect(block).toContain("--motion-duration-instant: var(--motion-duration-press);");
    expect(block).toContain("--motion-ease-in-out: var(--motion-ease-water);");
    for (const name of SPRING_NAMES) {
      expect(block).toMatch(new RegExp(`--motion-spring-${name}: linear\\(`));
      expect(block).toContain(`--motion-spring-${name}-duration: ${springs[name].settleMs}ms;`);
    }
    // the earlier spring names point at the design spring they now are
    expect(block).toContain("--motion-spring-gentle: var(--motion-spring-inflate);");
    expect(block).toContain("--motion-spring-fly-duration: var(--motion-spring-settle-duration);");
    // without linear(): DESIGN.md's fallback curve with its duration token
    expect(block).toContain(`--motion-spring-press: ${easings.squish};\n  --motion-spring-press-duration: ${durations.release}ms;`);
    expect(block).toContain(`--motion-spring-settle: ${easings.settle};\n  --motion-spring-settle-duration: ${durations.page}ms;`);
    expect(block).toContain(`--motion-bubble-from: ${bubble.fromScale};`);
    for (const [name, px] of Object.entries(travel)) expect(block).toContain(`--motion-travel-${name}: ${px}px;`);
  });

  it("follows the grammar's numbers: push 24px, language 16px, reduced = 120 ms cross-fade", () => {
    expect(travel.push).toBe(24);
    expect(travel.direction).toBe(16);
    expect(travel.menu).toBe(8);
    expect(motionCss).toMatch(/html\[data-motion="reduced"\]\[data-nav\]::view-transition-old\(root\)\s*\{[^}]*tt-fade-out 120ms linear/);
    expect(motionCss).toMatch(/html\[data-motion="reduced"\]\[data-nav\]::view-transition-new\(root\)\s*\{[^}]*tt-fade-in 120ms linear/);
    expect(motionCss).toMatch(/::view-transition-group\(\.tt-share\)\s*\{[^}]*--motion-spring-settle/);
  });

  it("animates nothing but transform and opacity (both stylesheets)", () => {
    const allowed = new Set(["opacity", "transform", "scale", "translate", "rotate"]);
    const names: string[] = [];
    for (const css of [motionCss, extrasCss]) {
      const pattern = /@keyframes\s+([\w-]+)\s*\{/g;
      for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
        // walk to the matching closing brace of the @keyframes block
        let depth = 1;
        let index = pattern.lastIndex;
        while (depth > 0 && index < css.length) {
          if (css[index] === "{") depth++;
          else if (css[index] === "}") depth--;
          index++;
        }
        const body = css.slice(pattern.lastIndex, index - 1);
        names.push(match[1]);
        for (const declaration of body.matchAll(/([\w-]+)\s*:\s*[^;{}]+;/g)) {
          expect(allowed.has(declaration[1]), `@keyframes ${match[1]} animates "${declaration[1]}"`).toBe(true);
        }
      }
      expect(css).not.toMatch(/transition(-property)?\s*:/); // no CSS transitions that could animate layout
    }
    expect(names.length).toBeGreaterThan(20);
    expect(new Set(names).size).toBe(names.length); // no keyframes name defined twice
  });

  it("keeps the stagger cap: six slots 45 ms apart, the last never later than the maximum", () => {
    for (const count of [0, 1, 2, 3, 6, 12, 40, 200]) {
      for (const requested of [0, 20, bubble.staggerStep, 120, 1000]) {
        const step = staggerStep(count, requested, bubble.staggerMax, bubble.staggerSlots);
        const lastSlot = count > 1 ? Math.min(count, bubble.staggerSlots) - 1 : bubble.staggerSlots - 1;
        expect(step * lastSlot).toBeLessThanOrEqual(bubble.staggerMax);
        expect(step).toBeLessThanOrEqual(Math.max(requested, 0));
      }
    }
    expect(staggerStep(6, bubble.staggerStep, bubble.staggerMax)).toBe(45); // DESIGN.md: 45 ms apart
    expect(staggerStep(40, bubble.staggerStep, bubble.staggerMax)).toBe(45); // the rest appear with the sixth
    expect(staggerStep(40, 1000, bubble.staggerMax)).toBe(80); // a custom step is capped at 400 ms for the wave
    // CSS: children 1–5 get slots 0–4 and every later child the sixth slot
    expect(motionCss).toContain(".tt-bubbles > :nth-child(n + 6) { --tt-i: 5; }");
    // Design System v2 §2.11: content inflates from .94 (was .86 — open v2 cards have no box to inflate).
    expect(bubble.fromScale).toBe(0.94);
  });
});

/**
 * Design System v2 §2.10b / §2.11: an element with a view-transition-name is a backdrop root — glass inside it frosts
 * nothing — so no element may carry a name at rest. Stylesheets name things only under `html:active-view-transition`;
 * scripts never name an element (React's <ViewTransition> names its boundaries only while its transition runs; the
 * engine names <html> "root", which is a backdrop root anyway). The browser side of the same rule, on real pages:
 * app/motion/__checks__/check-glass.mjs.
 */
describe("no view-transition-name at rest (glass keeps frosting)", () => {
  const appDir = fileURLToPath(new URL("../app/", import.meta.url));
  const filesIn = (pattern: RegExp) =>
    (readdirSync(appDir, { recursive: true }) as string[])
      .map((name) => name.split("\\").join("/"))
      .filter((name) => pattern.test(name) && !name.includes("node_modules"));
  /** Top-level comma split (not inside parentheses or brackets). */
  const splitSelectors = (prelude: string) => {
    const parts: string[] = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < prelude.length; i++) {
      const ch = prelude[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(prelude.slice(from, i).trim());
        from = i + 1;
      }
    }
    parts.push(prelude.slice(from).trim());
    return parts.filter(Boolean);
  };
  /** Every `view-transition-name` declaration of a stylesheet, with the selectors of the rule that holds it. */
  const nameDeclarations = (css: string) => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")); // offsets kept
    const found: Array<{ value: string; selectors: string[]; line: number }> = [];
    const preludes: string[] = [];
    let segment = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{" || ch === "}") {
        for (const match of text.slice(segment, i).matchAll(/(?:^|[;\s])view-transition-name\s*:\s*([^;]+)/g)) {
          const at = segment + (match.index ?? 0);
          found.push({ value: match[1].replace(/!important/, "").trim(), selectors: splitSelectors(preludes.at(-1) ?? ""), line: text.slice(0, at).split("\n").length });
        }
        if (ch === "{") {
          // the prelude is what follows the last declaration (or block edge) before the brace
          const before = text.slice(segment, i);
          preludes.push(before.slice(before.lastIndexOf(";") + 1).trim());
        } else preludes.pop();
        segment = i + 1;
      }
    }
    return found;
  };
  const active = /^(html|:root):active-view-transition\s/;

  it("names elements in stylesheets only while a view transition runs", () => {
    const stylesheets = filesIn(/\.css$/);
    expect(stylesheets).toContain("motion/motion.css");
    const offenders: string[] = [];
    let named = 0;
    for (const file of stylesheets) {
      for (const declaration of nameDeclarations(readFileSync(appDir + file, "utf8"))) {
        if (declaration.value.toLowerCase() === "none") continue;
        named++;
        for (const selector of declaration.selectors) {
          if (!active.test(selector)) offenders.push(`app/${file}:${declaration.line} "${selector}" → ${declaration.value}`);
        }
      }
    }
    expect(offenders, "a view-transition-name at rest makes the element a backdrop root: glass inside it stops frosting").toEqual([]);
    expect(named).toBeGreaterThanOrEqual(11); // the four chrome layers, six anchors, the lab bar
    // The guard itself: a name at rest is caught, a scoped one passes.
    expect(nameDeclarations(".shell-header { view-transition-name: tt-persist-header; }")[0].selectors.every((s) => active.test(s))).toBe(false);
    expect(nameDeclarations("@layer x { html:active-view-transition .a, html:active-view-transition .b { view-transition-name: x; } }")[0].selectors.every((s) => active.test(s))).toBe(true);
  });

  it("names the persistent chrome and the six language-switch anchors under that scope; the theme morph unnames both", () => {
    for (const persist of ["header", "nav", "bar", "float"]) {
      expect(motionCss).toMatch(new RegExp(`html:active-view-transition \\[data-motion-persist="${persist}"\\]\\s*\\{\\s*view-transition-name: tt-persist-${persist};`));
    }
    for (let n = 0; n < 6; n++) {
      expect(motionCss).toMatch(new RegExp(`html:active-view-transition \\[data-motion-anchored="${n}"\\]\\s*\\{\\s*view-transition-name: tt-anchor-${n};`));
    }
    expect(motionCss).toMatch(/html:active-view-transition \[data-motion-persist\]\s*\{\s*view-transition-class: tt-persist;/);
    expect(motionCss).toMatch(/html:active-view-transition \[data-motion-anchored\]\s*\{\s*view-transition-class: tt-anchor;/);
    expect(extrasCss).toMatch(/html\[data-morph="theme"\] :is\(\[data-motion-persist\], \[data-motion-anchored\]\)\s*\{\s*view-transition-name: none !important;/);
  });

  it("never names an element from script (only <html> gets \"root\", for the page snapshots)", () => {
    const offenders: string[] = [];
    for (const file of filesIn(/\.tsx?$/)) {
      const source = readFileSync(appDir + file, "utf8");
      for (const match of source.matchAll(/([\w.$]*)\.style\.viewTransitionName\s*=(?!=)\s*([^;\n]+)/g)) {
        const allowed = file === "motion/nav.tsx" && match[1] === "root" && /^("root"|"")$/.test(match[2].trim());
        if (!allowed) offenders.push(`app/${file}: ${match[0].trim()}`);
      }
      for (const match of source.matchAll(/setProperty\(\s*["']view-transition-name["']|viewTransitionName\s*:(?!:)/g)) offenders.push(`app/${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
    // nav.tsx's `root` is the document element, and anchors are marked for motion.css instead of named
    const nav = readFileSync(appDir + "motion/nav.tsx", "utf8");
    expect(nav).toMatch(/const root = document\.documentElement;[\s\S]*root\.style\.viewTransitionName = "root";/);
    expect(nav).toContain('element.setAttribute("data-motion-anchored", String(anchored.length))');
    expect(nav).toContain('element.removeAttribute("data-motion-anchored")');
  });
});

describe("bubble — when content inflates (hydration-safe)", () => {
  const base: InflateInput = { hydrating: false, live: true, always: false, inNavigation: false };

  it("never inflates server HTML or content that hydrates — even a streamed section after the engine went live", () => {
    expect(inflateOnMount({ ...base, hydrating: true })).toBe(false);
    expect(inflateOnMount({ ...base, hydrating: true, always: true })).toBe(false);
    expect(inflateOnMount({ ...base, live: false })).toBe(false);
  });

  it("inflates content that arrives on the client, unless a page navigation is drawing it (`always` opts in)", () => {
    expect(inflateOnMount(base)).toBe(true);
    expect(inflateOnMount({ ...base, inNavigation: true })).toBe(false);
    expect(inflateOnMount({ ...base, inNavigation: true, always: true })).toBe(true);
  });

  it("renders no animation class on the server", () => {
    const html = renderToStaticMarkup(createElement(BubbleGroup, null, createElement(Bubble, { className: "card" }, "x")));
    expect(html).not.toContain("tt-bubble-in");
    expect(html).toContain('class="card"');
  });
});

describe("motion lab strings", () => {
  it("exist in Arabic, English and Kurdish with identical keys", () => {
    const keys = (tree: unknown, prefix = ""): string[] =>
      Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => (typeof value === "string" ? [prefix + key] : keys(value, `${prefix}${key}.`)));
    const ar = keys(messages.ar).sort();
    expect(keys(messages.en).sort()).toEqual(ar);
    expect(keys(messages.ckb).sort()).toEqual(ar);
    expect(ar.length).toBeGreaterThan(80);
  });
});
