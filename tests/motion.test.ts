/**
 * TamTam Motion Engine — the pure parts: spring solver and its CSS/WAAPI output, gesture maths, flight path,
 * quality-tier resolution, the navigation grammar, and guards that keep motion.css honest
 * (tokens in sync with tokens.ts, keyframes limited to transform and opacity).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import messages from "~/i18n/messages/motion";
import { resolveTier } from "~/motion/env";
import { counterScaleKeyframes } from "~/motion/morph";
import { resolveNav, reverseNav, type NavDescriptor, type NavRecord, type ResolveInput } from "~/motion/nav-plan";
import { arcControl, pickSnap, project, quadBezier, rubberBand, rubberBandClamp, samplePath, velocityFrom } from "~/motion/physics";
import { springDuration, springEasing, springKeyframes, springValue, springVelocity } from "~/motion/spring";
import { staggerStep } from "~/motion/stagger";
import { bubble, durations, fly, springs, type Spring } from "~/motion/tokens";
import { renderTokenCss, replaceTokenBlock } from "~/motion/tokens-css";

const motionCss = readFileSync(fileURLToPath(new URL("../app/motion/motion.css", import.meta.url)), "utf8");
const extrasCss = readFileSync(fileURLToPath(new URL("../app/motion/extras.css", import.meta.url)), "utf8");

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

  it("is a valid linear() from 0 to 1 with increasing stops", () => {
    for (const spring of Object.values(springs)) {
      const { easing, duration } = springEasing(spring);
      const stops = parse(easing);
      expect(stops[0]).toEqual({ x: 0, y: 0 });
      expect(stops[stops.length - 1]).toEqual({ x: 1, y: 1 });
      for (let i = 1; i < stops.length; i++) expect(stops[i].x).toBeGreaterThan(stops[i - 1].x);
      expect(stops.length).toBeLessThanOrEqual(40);
      expect(duration).toBe(Math.round(springDuration(spring) * 1000));
    }
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

  it("keeps the overshoot of bouncy springs and has none for critically damped ones", () => {
    const peak = (spring: Spring) => Math.max(...parse(springEasing(spring).easing).map((s) => s.y));
    expect(peak(springs.bouncy)).toBeGreaterThan(1.1);
    expect(peak(springs.gentle)).toBeGreaterThan(1.02);
    expect(peak(springs.fly)).toBeLessThanOrEqual(1);
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

  it("arcs above both ends, higher for longer throws, within its limits", () => {
    const control = arcControl(from, to);
    expect(control.y).toBeLessThan(Math.min(from.y, to.y));
    const near = arcControl({ x: 100, y: 100 }, { x: 130, y: 100 });
    const far = arcControl({ x: 0, y: 800 }, { x: 390, y: 0 });
    expect(100 - near.y).toBeCloseTo(fly.arcMin, 6);
    expect(0 - far.y).toBeCloseTo(fly.arcMax, 6);
    expect(Math.min(from.y, to.y) - arcControl(from, to, 0.5).y).toBeCloseTo((Math.min(from.y, to.y) - control.y) / 2, 6);
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
  const capable = { reducedMotion: false, saveData: false, deviceMemory: 8, hardwareConcurrency: 8 };

  it("is full on a capable device and when nothing is known (Safari reports no memory)", () => {
    expect(resolveTier(capable)).toBe("full");
    expect(resolveTier({ reducedMotion: false, saveData: false })).toBe("full");
    expect(resolveTier({ reducedMotion: false, saveData: false, hardwareConcurrency: 4 })).toBe("full");
  });

  it("reduces for prefers-reduced-motion before anything else", () => {
    expect(resolveTier({ ...capable, reducedMotion: true })).toBe("reduced");
    expect(resolveTier({ ...capable, reducedMotion: true, saveData: true })).toBe("reduced");
  });

  it("goes lite for Save-Data and for low-memory or low-core devices", () => {
    expect(resolveTier({ ...capable, saveData: true })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 2 })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 1 })).toBe("lite");
    expect(resolveTier({ ...capable, hardwareConcurrency: 2 })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 4, hardwareConcurrency: 4 })).toBe("lite");
    expect(resolveTier({ ...capable, deviceMemory: 4, hardwareConcurrency: 8 })).toBe("full");
  });

  it("lets the shopper's override win in both directions", () => {
    expect(resolveTier({ ...capable, reducedMotion: true, override: "full" })).toBe("full");
    expect(resolveTier({ ...capable, override: "reduced" })).toBe("reduced");
    expect(resolveTier({ ...capable, saveData: true, override: "full" })).toBe("full");
    expect(resolveTier({ ...capable, override: "lite" })).toBe("lite");
    expect(resolveTier({ ...capable, override: null })).toBe("full");
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

describe("theme reveal keyframes", () => {
  it("keep the picture still: clip scale × picture scale is 1 at and between every stop", () => {
    const { clip, picture } = counterScaleKeyframes(20 / 940);
    expect(clip.length).toBe(picture.length);
    expect(clip.length).toBeGreaterThan(20);
    const scale = (frame: Keyframe) => Number(/scale\(([\d.]+)\)/.exec(String(frame.transform))![1]);
    expect(clip[0].offset).toBe(0);
    expect(clip[clip.length - 1].offset).toBe(1);
    expect(scale(clip[clip.length - 1])).toBe(1);
    for (let i = 0; i < clip.length; i++) {
      expect(scale(clip[i]) * scale(picture[i])).toBeCloseTo(1, 3);
      expect(clip[i].offset).toBe(picture[i].offset);
      if (i === 0) continue;
      expect(Number(clip[i].offset)).toBeGreaterThan(Number(clip[i - 1].offset));
      // halfway between two stops both sides are linearly interpolated: the product may drift by < 0.1 %
      const mid = ((scale(clip[i - 1]) + scale(clip[i])) / 2) * ((scale(picture[i - 1]) + scale(picture[i])) / 2);
      expect(Math.abs(mid - 1)).toBeLessThan(0.001);
    }
  });
});

describe("motion.css", () => {
  it("has the tokens generated from tokens.ts (run: npx tsx app/motion/__checks__/gen-css.mjs)", () => {
    expect(replaceTokenBlock(motionCss)).toBe(motionCss);
    const block = renderTokenCss();
    for (const [name, ms] of Object.entries(durations)) expect(block).toContain(`--motion-duration-${name}: ${ms}ms;`);
    for (const name of Object.keys(springs)) expect(block).toMatch(new RegExp(`--motion-spring-${name}: linear\\(`));
    expect(block).toContain(`--motion-bubble-from: ${bubble.fromScale};`);
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

  it("keeps the stagger cap: the last bubble of a wave never starts later than the maximum", () => {
    for (const count of [0, 1, 2, 3, 6, 12, 40, 200]) {
      for (const requested of [0, 20, bubble.staggerStep, 120, 1000]) {
        const step = staggerStep(count, requested, bubble.staggerMax);
        const lastSlot = count > 1 ? Math.min(count, 12) - 1 : 11;
        expect(step * lastSlot).toBeLessThanOrEqual(bubble.staggerMax);
        expect(step).toBeLessThanOrEqual(Math.max(requested, 0));
      }
    }
    expect(staggerStep(6, bubble.staggerStep, bubble.staggerMax)).toBe(bubble.staggerStep); // six items: 45 ms apart
    expect(staggerStep(12, bubble.staggerStep, bubble.staggerMax)).toBe(36.3); // twelve: squeezed into 400 ms
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
