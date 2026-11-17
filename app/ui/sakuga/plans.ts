/**
 * The drawn moments' choreography (./fx.ts plays it): pure plans, one per moment — which of the core's effects, where
 * round the control's box (page coordinates, mirrored in RTL), with what options and when. Loaded together with the
 * vendored core (a dynamic import on the first moment), so none of this is in a route's initial bundle; unit-tested in
 * tests/sakuga.test.ts (every moment ends within MOMENT_MS).
 */

/** A control's box: its centre in page coordinates, and its size (CSS px). */
export type Box = { x: number; y: number; w: number; h: number };

export type FxName = "puff" | "burst" | "shards" | "ring" | "splash" | "slash" | "lines" | "ticks" | "wob" | "kira" | "sfx";
export type FxOptions = { life: number } & Record<string, number | string | boolean>;
/** One effect of a moment: what, where, its options for the core, and when (ms after the moment). */
export type Step = { fx: FxName; x: number; y: number; o: FxOptions; at?: number; word?: string };
export type Plan = Step[];

/**
 * The sound-effect lettering (ドン!, ズザッ… painted katakana) stays OFF: Japanese onomatopoeia is foreign to an Arabic,
 * Sorani and English store. The owner can flip it; the plans then add one word per moment.
 */
export const LETTERING = false;
/** No moment lasts longer than this (DESIGN.md §7.1: nothing outside the intro lasts longer than 600 ms). */
export const MOMENT_MS = 600;

const TAU = Math.PI * 2;
const UP = -Math.PI / 2;

/** When a step has finished (ms after the moment): a splash's drops may outlive its crown by 15 %. */
export function stepEnd(step: Step): number {
  const stretch = step.fx === "splash" ? 1.15 : 1;
  return (step.at ?? 0) + step.o.life * 1000 * stretch;
}

/** A plan's length in ms. */
export function planEnd(plan: Plan): number {
  return plan.reduce((end, step) => Math.max(end, stepEnd(step)), 0);
}

/* ───────────────────────────── the plans (pure) ───────────────────────────── */

/** +1 toward the inline end (right in LTR, left in RTL). */
const endward = (rtl: boolean) => (rtl ? -1 : 1);
/** An angle mirrored for RTL (a direction drawn toward the inline end turns round). */
const mirror = (angle: number, rtl: boolean) => (rtl ? Math.PI - angle : angle);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function word(plan: Plan, name: string, x: number, y: number, size: number): Plan {
  if (!LETTERING) return plan;
  return [...plan, { fx: "sfx", word: name, x, y, o: { size, rot: -0.12, life: 0.6 } }];
}

/** A confirmed add: wedges over the key, chips off its end corner, two puffs at its feet, a glint. */
export function planAdded(b: Box, rtl: boolean): Plan {
  const s = endward(rtl);
  const top = b.y - b.h / 2;
  const bottom = b.y + b.h / 2;
  const corner = b.x + s * (b.w / 2 - Math.min(10, b.w / 4));
  return word(
    [
      { fx: "ticks", x: b.x, y: top - 2, o: { dir: UP, n: 3, r: 4, len: 11, fan: 0.5, life: 0.34 } },
      { fx: "shards", x: corner, y: top + 2, o: { n: 4, speed: 130, size: 3.6, dir: UP + s * 0.5, arc: 1.8, grav: 320, life: 0.46 } },
      { fx: "puff", x: b.x - b.w / 2 + 6, y: bottom + 1, o: { size: 5.5, n: 3, vx: -18, vy: -6, life: 0.42 } },
      { fx: "puff", x: b.x + b.w / 2 - 6, y: bottom + 1, o: { size: 5.5, n: 3, vx: 18, vy: -6, life: 0.42 } },
      { fx: "kira", x: corner + s * 4, y: top - 4, o: { r: 7, life: 0.3 }, at: 200 },
    ],
    "don",
    b.x,
    top - 24,
    72,
  );
}

/** A checkbox ticked: two crescents swing round the box, crystal chips, a late glint. Unticked: one small puff. */
export function planCheck(b: Box, checked: boolean, rtl: boolean): Plan {
  if (!checked) return [{ fx: "puff", x: b.x, y: b.y, o: { size: 5, n: 3, life: 0.34 } }];
  const s = endward(rtl);
  return word(
    [
      { fx: "slash", x: b.x + s * 4, y: b.y + 1, o: { len: 56, ang: mirror(-0.42, rtl), thick: 6, life: 0.38 } },
      { fx: "slash", x: b.x - s * 4, y: b.y + 7, o: { len: 40, ang: mirror(2.72, rtl), thick: 4, life: 0.4 } },
      { fx: "shards", x: b.x, y: b.y, o: { n: 5, speed: 120, size: 3.2, arc: TAU, grav: 220, life: 0.42 } },
      { fx: "kira", x: b.x + s * 14, y: b.y - 14, o: { r: 6, life: 0.3 }, at: 240 },
    ],
    "zuza",
    b.x + s * 20,
    b.y - 30,
    64,
  );
}

/** A switch flipped on: speed lines behind the knob, a splash where it lands at the inline end, wobble marks, a glint. */
export function planToggle(b: Box, on: boolean, rtl: boolean): Plan {
  const s = endward(rtl);
  const knob = b.h / 2;
  const end = b.x + s * (b.w / 2 - knob);
  const start = b.x - s * (b.w / 2 - knob);
  if (!on) return [{ fx: "puff", x: start, y: b.y, o: { size: 5, n: 3, life: 0.34 }, at: 100 }];
  return word(
    [
      { fx: "lines", x: end - s * knob * 1.6, y: b.y, o: { n: 3, dir: rtl ? 0 : Math.PI, len: 16, spread: 5, life: 0.24 } },
      { fx: "splash", x: end, y: b.y - b.h / 2 + 2, o: { w: 22, h: 14, life: 0.4 }, at: 120 },
      { fx: "wob", x: end + s * (knob + 2), y: b.y, o: { dir: s, r: 7, life: 0.32 }, at: 120 },
      { fx: "kira", x: end + s * 4, y: b.y - b.h / 2 - 8, o: { r: 5, life: 0.28 }, at: 260 },
    ],
    "kachi",
    end,
    b.y - 30,
    56,
  );
}

/** Stars chosen: each lit star throws a fan of wedges, one after another (45 ms apart); five stars add a ring and chips. */
export function planRate(stars: readonly Box[], rtl: boolean): Plan {
  const n = Math.min(5, stars.length);
  if (n === 0) return [];
  const s = endward(rtl);
  const five = n === 5;
  const plan: Plan = [];
  stars.slice(0, n).forEach((c, i) => {
    plan.push({ fx: "ticks", x: c.x, y: c.y - 2, o: { dir: UP, n: 5, r: 11, len: five && i === n - 1 ? 12 : 8, fan: 0.6, life: 0.32 }, at: i * 45 });
  });
  const last = stars[n - 1];
  const at = (n - 1) * 45;
  plan.push({ fx: "puff", x: last.x, y: last.y + 11, o: { size: 4, n: 2, life: 0.34 }, at });
  if (five) {
    plan.push({ fx: "ring", x: last.x, y: last.y, o: { rx: 20, ry: 20, w: 3, life: 0.36 }, at });
    plan.push({ fx: "shards", x: last.x, y: last.y, o: { n: 5, speed: 140, size: 3.2, arc: TAU, grav: 240, life: 0.4 }, at });
  }
  plan.push({ fx: "kira", x: last.x + s * 14, y: last.y - 14, o: { r: 6, life: 0.26 }, at: at + 120 });
  return word(plan, "pon", last.x + s * 18, last.y - 34, 60);
}

/** A toast lands: dust at its feet, wobble marks at its sides, two wedges off its top end corner. */
export function planToast(b: Box, rtl: boolean): Plan {
  const s = endward(rtl);
  const left = b.x - b.w / 2;
  const right = b.x + b.w / 2;
  const bottom = b.y + b.h / 2;
  const at = 120;
  return word(
    [
      // just under its edge: the toast sits above the canvas (--z-toast), so dust drawn on its edge would hide under it
      { fx: "puff", x: left + 14, y: bottom + 7, o: { size: 7, n: 3, vx: -22, vy: -2, life: 0.44 }, at },
      { fx: "puff", x: right - 14, y: bottom + 7, o: { size: 7, n: 3, vx: 22, vy: -2, life: 0.44 }, at },
      { fx: "wob", x: left - 4, y: b.y, o: { dir: -1, r: 9, life: 0.32 }, at },
      { fx: "wob", x: right + 4, y: b.y, o: { dir: 1, r: 9, life: 0.32 }, at },
      { fx: "ticks", x: b.x + s * (b.w / 2 - 24), y: b.y - b.h / 2 - 4, o: { dir: mirror(-0.9, rtl), n: 2, r: 4, len: 10, life: 0.34 }, at },
    ],
    "zuza",
    b.x - s * (b.w / 2 - 40),
    b.y - b.h / 2 - 26,
    72,
  );
}

/**
 * Progress complete: a ring opens round the mark, chips fly, four puffs roll off its diagonals, a glint. A bar (wider than
 * three times its height) completes at its inline end, where the fill arrived.
 */
export function planComplete(b: Box, rtl: boolean): Plan {
  const s = endward(rtl);
  const bar = b.w > b.h * 3;
  const c = bar ? { x: b.x + s * (b.w / 2), y: b.y } : { x: b.x, y: b.y };
  const R = bar ? 12 : Math.min(b.w, b.h) / 2;
  const plan: Plan = [
    { fx: "ring", x: c.x, y: c.y, o: { rx: R + 6, ry: R + 6, w: 3.5, life: 0.42 } },
    { fx: "shards", x: c.x, y: c.y, o: { n: 7, speed: 150 + R, size: 3.6 + R / 24, arc: TAU, grav: 260, life: 0.48 } },
  ];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    plan.push({
      fx: "puff",
      x: c.x + Math.cos(a) * (R + 4),
      y: c.y + Math.sin(a) * (R + 4),
      o: { size: clamp(R * 0.16, 4.5, 9), n: 3, vx: Math.cos(a) * 28, vy: Math.sin(a) * 20 - 6, life: 0.46 },
    });
  }
  plan.push({ fx: "kira", x: c.x + s * R * 0.8, y: c.y - R * 0.8, o: { r: 8, life: 0.28 }, at: 280 });
  return word(plan, "don", c.x, c.y - R - 26, 80);
}
