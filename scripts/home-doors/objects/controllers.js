// «أيدي التحكم» — a current-generation wireless gamepad, built as a product rather than a cut-out.
// The body is sculpted from signed distance fields (a 2D outline × a domed top × a deep underside, every edge
// filleted) and polygonised here. Two tones meet at real parting lines: a white shell that wraps the shoulders and
// the long, splayed, crowned grips all the way round, and a satin-black core that shows as the centre deck and the
// chin. On it: a large gloss-black touch pad that rolls over the top edge (the name is pad-printed on its gently
// crowned face), blue light guides along its sides, the d-pad and face buttons up beside the pad's lower corners,
// rubber thumbsticks (concave dish, knurled crown and band) lower and further in, in soft-gloss wells with thin
// brand-red bezels, moulded bumper crescents with the triggers tucked behind them, a gunmetal home key and a
// perforated metal grille. Units: centimetres (≈ 17.5 × 12 × 7); core.js scales and frames it.
import { THREE, M, extrude, slab, roundedRect, smoothNormals, titleMaterial } from "../kit.js";

export const meta = { turn: -0.24, tilt: 0, gap: 0.02, margin: [0.79, 0.78], centerY: 0.16 };
// The controller leans its top towards the camera by itself — before core.js turns it — so both grips stay level
// (a world-space tilt after the turn would roll it and split its shadow). The small counter-roll levels the grips,
// which the turn's perspective would otherwise drop on the near side.
const LEAN = 0.06;
const ROLL = 0.075;

// ───────────────────────────── scalar helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
function sstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
const len = (x, y) => Math.sqrt(x * x + y * y);
/** Polynomial smooth minimum (k = blend width). */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
/** Booleans with a true circular round of radius r (hg_sdf). */
function rInter(a, b, r) {
  const u = Math.max(r + a, 0);
  const v = Math.max(r + b, 0);
  return Math.min(-r, Math.max(a, b)) + Math.sqrt(u * u + v * v);
}
const rDiff = (a, b, r) => rInter(a, -b, r);

// ───────────────────────────── 2D distances
function box2(x, y, hx, hy, r) {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const circle = (x, y, cx, cy, r) => len(x - cx, y - cy) - r;
function segment(px, py, ax, ay, bx, by, r) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0, 1);
  return len(px - ax - abx * t, py - ay - aby * t) - r;
}
/** A round cone (uneven capsule) from a (radius ra) to b (radius rb) — iq. */
function cone2(px, py, ax, ay, bx, by, ra, rb) {
  const bax = bx - ax;
  const bay = by - ay;
  const l2 = bax * bax + bay * bay;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax;
  const pay = py - ay;
  const y = pax * bax + pay * bay;
  const z = y - l2;
  const qx = pax * l2 - bax * y;
  const qy = pay * l2 - bay * y;
  const x2 = qx * qx + qy * qy;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}
/** Exact distance to a polygon [[x,y]…] — iq. */
function poly2(px, py, v) {
  let d = (px - v[0][0]) ** 2 + (py - v[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
    const ex = v[j][0] - v[i][0];
    const ey = v[j][1] - v[i][1];
    const wx = px - v[i][0];
    const wy = py - v[i][1];
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= v[i][1];
    const c2 = py < v[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

// ───────────────────────────── layout (cm; x right, y towards the shoulders, z out of the face)
// The touch pad: a rounded trapezoid (a core trapezoid grown by r), wide so the name can be large. Its top edge runs
// up onto the shell's top fillet, so the pad rolls back over the edge there; the name sits on its flat face.
const PAD = { cy: 2.85, top: 4.5, bot: 4.2, hh: 0.9, r: 0.7, gap: 0.085 };
PAD.core = [[-PAD.bot, -PAD.hh], [PAD.bot, -PAD.hh], [PAD.top, PAD.hh], [-PAD.top, PAD.hh]];
PAD.w = 2 * (PAD.top + PAD.r);
PAD.h = 2 * (PAD.hh + PAD.r);
// where the name's centre line sits on the pad: a little low for the taller scripts; the long Sorani line is short,
// so it rides higher, where the pad is wider
const textY = (lang) => PAD.cy - (lang === "ckb" ? 0.05 : 0.2);
// the pad's slanted right side: unit tangent (bottom → top) and outward normal
const SIDE = (() => {
  const dx = PAD.top - PAD.bot;
  const dy = 2 * PAD.hh;
  const l = len(dx, dy);
  return { tx: dx / l, ty: dy / l, nx: dy / l, ny: -dx / l, l };
})();
/** A point beside the pad's side s (±1): t along the side (0 bottom … 1 top), `off` out from the core edge. */
function sidePoint(s, t, off) {
  const x = PAD.bot + t * (PAD.top - PAD.bot) + SIDE.nx * off;
  const y = -PAD.hh + t * 2 * PAD.hh + SIDE.ny * off;
  return [s * x, y + PAD.cy];
}
const SLOT = { t0: 0.3, t1: 1.05, off: PAD.r + PAD.gap + 0.1, r: 0.1 };
// the d-pad and the face buttons sit up beside the pad's lower corners; the sticks sit 1.6 lower and further in
const DPAD = { x: -6.2, y: 0.95, dish: 1.3 };
const FACE = { x: 6.2, y: 0.95, r: 0.38, d: 0.8, dish: 1.3 };
const FACE_AT = [[0, 1], [1, 0], [0, -1], [-1, 0]].map(([u, v]) => [FACE.x + u * FACE.d, FACE.y + v * FACE.d]);
const STICK = { x: 2.65, y: -0.65, hole: 1.4 };
const HOME = { x: 0, y: -0.86, r: 0.3 };
const GRILLE = { x: 0, y: 0.45, w: 1.62, h: 0.44 };
// the two small menu keys beside the pad's upper corners, leaning with its sides
const MENU = { x: 5.92, y: 3.1, half: 0.19, r: 0.115 };
// the black deck: continues the pad's slanted sides down, round the sticks and over the chin
const DECK = [[-4.7, 1.95], [4.7, 1.95], [4.0, -0.65], [-4.0, -0.65]];
// the grips: long round cones that taper and splay outwards (≈ 18° off vertical), reaching well below the belly
const GRIP = { ax: 5.5, ay: 0.75, bx: 7.6, by: -5.6, ra: 2.35, rb: 1.45 };
const GRIP_SWELL = 0.35;

// ───────────────────────────── the body
/** The face-on outline (negative inside): shoulders, belly and the two splayed grips. */
function outline(x, y) {
  x = Math.abs(x);
  const upper = box2(x, y - 1.6, 6.95, 3.2, 2.5);
  const belly = box2(x, y + 1.1 - 0.02 * x * x, 4.4, 1.85, 1.85);
  const grip = cone2(x, y, GRIP.ax, GRIP.ay, GRIP.bx, GRIP.by, GRIP.ra, GRIP.rb);
  return smin(smin(upper, belly, 1.0), grip, 1.5);
}
/**
 * Height of the top surface: a gentle dome. The grips swell above the face plane just below their roots (a ridge along
 * each grip's axis, so its upper slope faces the key), are crowned across, and fall away towards their ends.
 */
function topZ(x, y) {
  const ax = Math.abs(x);
  const wx = sstep(2.8, 5.8, ax);
  const deck = 0.3 - 0.03 * Math.max(0, 2.8 - y) ** 1.35;
  const grip = 0.3 - 1.5 * sstep(0.4, -7.2, y) ** 1.2;
  const da = segment(ax, y, GRIP.ax, GRIP.ay, GRIP.bx, GRIP.by, 0);
  const crown = 0.24 * wx * sstep(0.5, -1.5, y) * da * da;
  const swell = GRIP_SWELL * wx * sstep(0.8, -0.6, y) * (1 - sstep(-1.2, -4.8, y)) * (1 - sstep(0.9, 2.2, da));
  return mix(deck, grip, wx) - 0.0045 * x * x - 0.04 * Math.max(0, y - 3.4) ** 2 - crown + swell;
}
/** Height of the underside: the grips hang far below the centre. */
function botZ(x, y) {
  const wx = sstep(2.8, 5.8, Math.abs(x));
  const centre = -2.45 - 0.95 * sstep(-2.6, 4.4, y);
  const grip = -3.0 - 3.4 * sstep(1.4, -7.2, y);
  return mix(centre, grip, wx);
}
function deckSD(x, y) {
  const ax = Math.abs(x);
  const upper = poly2(ax, y, DECK) - 0.12;
  const sticks = circle(ax, y, STICK.x, STICK.y, 1.65);
  const chin = box2(x, y + 2.6, 3.85, 2.6, 1.0);
  return smin(smin(upper, sticks, 0.7), chin, 0.9);
}
const EPS = 0.01;
const TOP_R = 0.85;
/** Everything about a column (x, y) the 3D fields need — computed once per column. */
function col(x, y) {
  const ax = Math.abs(x);
  const t = topZ(x, y);
  const b = botZ(x, y);
  const tgx = (topZ(x + EPS, y) - topZ(x - EPS, y)) / (2 * EPS);
  const tgy = (topZ(x, y + EPS) - topZ(x, y - EPS)) / (2 * EPS);
  const bgx = (botZ(x + EPS, y) - botZ(x - EPS, y)) / (2 * EPS);
  const bgy = (botZ(x, y + EPS) - botZ(x, y - EPS)) / (2 * EPS);
  const g = sstep(3.0, 5.6, ax) * sstep(0.5, -2.5, y);
  const deck = deckSD(x, y);
  // the touch pad's opening and the light-guide slots beside it
  let pad = 9;
  if (ax < 6.6 && y > 0.4 && y < 5.4) {
    pad = poly2(x, y - PAD.cy, PAD.core) - PAD.r - PAD.gap;
    const s = x < 0 ? -1 : 1;
    const [sx0, sy0] = sidePoint(s, SLOT.t0, SLOT.off);
    const [sx1, sy1] = sidePoint(s, SLOT.t1, SLOT.off);
    pad = Math.min(pad, segment(x, y, sx0, sy0, sx1, sy1, SLOT.r));
  }
  const dl = circle(x, y, DPAD.x, DPAD.y, DPAD.dish);
  const dr = circle(x, y, FACE.x, FACE.y, FACE.dish);
  let cross = 9;
  let btn = 9;
  if (dl < 0.5) {
    const u = x - DPAD.x;
    const v = y - DPAD.y;
    cross = smin(box2(u, v, 1.21, 0.405, 0.14), box2(u, v, 0.405, 1.21, 0.14), 0.16);
  }
  if (dr < 0.5) for (const [bx, by] of FACE_AT) btn = Math.min(btn, circle(x, y, bx, by, FACE.r + 0.07));
  let menu = 9;
  if (ax > 5.2 && ax < 6.8 && y > 2.3 && y < 4.0) {
    const [ex, ey] = [SIDE.tx * MENU.half * Math.sign(x), SIDE.ty * MENU.half];
    menu = segment(x, y, Math.sign(x) * MENU.x - ex, MENU.y - ey, Math.sign(x) * MENU.x + ex, MENU.y + ey, MENU.r + 0.06);
  }
  let well = 9;
  let home = 9;
  if (deck < 0.6) {
    well = circle(ax, y, STICK.x, STICK.y, STICK.hole);
    home = circle(x, y, HOME.x, HOME.y, HOME.r + 0.09);
  }
  // the chin's front edge takes a tighter round, so the sticks' bezels sit on the flat deck, clear of it
  const chin = (1 - sstep(-2.0, -0.8, y)) * (1 - sstep(3.4, 4.6, ax));
  return {
    x,
    y,
    o: outline(x, y),
    t,
    b,
    tn: 1 / Math.sqrt(1 + tgx * tgx + tgy * tgy),
    bn: 1 / Math.sqrt(1 + bgx * bgx + bgy * bgy),
    rt: mix(TOP_R, 0.6, chin) + 0.5 * g,
    rb: 1.25 + 0.5 * g,
    // the parting line: 60 % of the way down the centre body (so little of the black back shows over the top edge);
    // on the wings it drops below the body, so the shoulders and grips are white all the way round
    seam: mix(t - 0.6 * (t - b), b - 1, sstep(3.3, 4.5, ax)),
    deck,
    inset: mix(0.08, 0.15, sstep(0.3, -0.3, deck)),
    pad,
    dish: Math.min(dl, dr),
    cross,
    btn,
    menu,
    well,
    home,
    shoulder: ax > 3.7 && y > 2.9,
  };
}
// The shoulder buttons are moulded crescents on the upper corner arc (centred at CORNER): each swells in the middle,
// where its crowned outer face stands proud of the outline, and sinks below the shell at its ends. Both sit in one
// round-ended opening in the shoulder (see shoulderSlotSD). The bumper sits on the side wall just behind the face; the
// trigger is tucked behind it and shows only as a thin tab above the bumper.
const CORNER = { x: 4.45, y: 2.3, r: 2.5 };
const BUMPER = { a0: 0.45, a1: 1.75, zc: -1.05, half: 0.38, rise: 0.25, sink: 0.16, crown: 0.09, inner: 0.36, round: 0.12 };
const TRIGGER = { a0: 0.6, a1: 1.64, zc: -2.3, half: 0.62, rise: 0.08, sink: 0.22, crown: 0.16, inner: 0.42, round: 0.3 };
function shoulderSD(x, y, z, o, p) {
  const ang = Math.atan2(y - CORNER.y, Math.abs(x) - CORNER.x);
  // sunk below the shell near the ends, emerging over the first and last third, proudest in the middle
  const t = (ang - p.a0) / (p.a1 - p.a0);
  const w = sstep(0.07, 0.45, t) * sstep(0.07, 0.45, 1 - t);
  const zc = z - p.zc;
  const top = -p.sink + (p.rise + p.sink) * w - p.crown * (zc / p.half) ** 2;
  let d = Math.max(o - top, -p.inner - o);
  d = rInter(d, Math.abs(zc) - p.half, p.round);
  return rInter(d, Math.max(p.a0 - ang, ang - p.a1) * CORNER.r, 0.25);
}
const bumperSD = (x, y, z, o) => shoulderSD(x, y, z, o, BUMPER);
const triggerSD = (x, y, z, o) => shoulderSD(x, y, z, o, TRIGGER);
// the opening: a trench of fixed width with round ends and a parting gap clear of both parts; where a part sinks (its
// ends) the opening shows its dark floor, so no gap ever fades out into slivers
const SH_GAP = 0.08;
const SH_SLOT = (() => {
  const zf = BUMPER.zc + BUMPER.half + SH_GAP;
  const zb = TRIGGER.zc - TRIGGER.half - SH_GAP;
  return { a0: Math.min(BUMPER.a0, TRIGGER.a0), a1: Math.max(BUMPER.a1, TRIGGER.a1), zc: (zf + zb) / 2, half: (zf - zb) / 2, inner: Math.max(BUMPER.inner, TRIGGER.inner) + SH_GAP };
})();
function shoulderSlotSD(x, y, z, o) {
  const ang = Math.atan2(y - CORNER.y, Math.abs(x) - CORNER.x);
  // full depth where the parts stand proud; towards its ends the floor rises to a shallow groove (no notch in the outline)
  const t = (ang - SH_SLOT.a0) / (SH_SLOT.a1 - SH_SLOT.a0);
  const depth = 0.06 + (SH_SLOT.inner - 0.06) * sstep(0.0, 0.22, t) * sstep(0.0, 0.22, 1 - t);
  const d = rInter(-depth - o, Math.abs(z - SH_SLOT.zc) - SH_SLOT.half, 0.12);
  return rInter(d, Math.max(SH_SLOT.a0 - ang, ang - SH_SLOT.a1) * CORNER.r - SH_GAP, 0.3);
}
/** The whole outer body, with the button dishes and the shoulder openings. */
function shellAt(c, z) {
  let d = rInter(rInter(c.o, (z - c.t) * c.tn, c.rt), (c.b - z) * c.bn, c.rb);
  if (c.dish < 0.5) d = rDiff(d, Math.max(c.dish, (c.t - 0.1 - z) * c.tn), 0.22);
  if (c.shoulder) d = rDiff(d, shoulderSlotSD(c.x, c.y, z, c.o), 0.06);
  return d;
}
/** The white shell: outside the deck and above the parting line, opened for the pad and the buttons. */
function whiteAt(c, z) {
  let d = shellAt(c, z);
  // the parting line rounds off more where it meets the outline low on the chin (no nub at the grip's root)
  d = rInter(d, -c.deck, mix(0.12, 0.22, sstep(-1.5, -2.6, c.y)));
  d = rInter(d, c.seam - z, 0.08);
  d = rDiff(d, c.pad, 0.1);
  if (c.cross < 0.3) d = rDiff(d, c.cross, 0.08);
  if (c.btn < 0.3) d = rDiff(d, c.btn, 0.08);
  if (c.menu < 0.3) d = rDiff(d, c.menu, 0.07);
  return d;
}
/** The black core: the body a little inside the shell (so the deck sits lower), with the wells and holes. */
function blackAt(c, z) {
  let d = shellAt(c, z) + c.inset;
  const floor = c.t - c.inset - z;
  if (c.well < 0.3) d = rDiff(d, Math.max(c.well, floor - 0.7), 0.05);
  if (c.home < 0.3) d = rDiff(d, Math.max(c.home, floor - 0.4), 0.05);
  return d;
}
const whiteField = { col, at: whiteAt };
const blackField = { col, at: blackAt };
// The pad: its flat face carries the name; above it the pad rolls back over the top edge with a curvature that ramps
// up (k³), so its reflection sweeps smoothly from the table through the dark sky to a crisp glint of the key light.
// At its top edge it sits a hair below the shell's own fillet, never proud of it.
// The face is crowned: across by a hair, and up the face by a parabola that peaks just under the band, so the lower
// face tips a little towards the floor. Its reflection then climbs the studio's front light from the bottom edge up:
// a soft gradient from a deep black at the bottom to a lifted black under the band.
const PAD_ROLL = { start: -1.2, c: 0.3 };
const padCrown = (x, y) => 0.06 - 0.06 * (clamp((y - PAD.cy) / (PAD.h / 2), -1, 1) - 0.5) ** 2 + 0.03 * (1 - clamp(x / (PAD.w / 2), -1, 1) ** 2);
function padTop(x, y) {
  const k = outline(x, y) - PAD_ROLL.start;
  return topZ(x, y) + padCrown(x, y) - (k > 0 ? PAD_ROLL.c * k * k * k : 0);
}
const padField = {
  col: (x, y) => {
    const t = padTop(x, y);
    const gx = (padTop(x + EPS, y) - padTop(x - EPS, y)) / (2 * EPS);
    const gy = (padTop(x, y + EPS) - padTop(x, y - EPS)) / (2 * EPS);
    return { t, n: 1 / Math.sqrt(1 + gx * gx + gy * gy), d: poly2(x, y - PAD.cy, PAD.core) - PAD.r };
  },
  at: (c, z) => Math.max(rInter(c.d, (z - c.t) * c.n, 0.12), c.t - 0.42 - z),
};
const shoulderCol = (x, y) => ({ x, y, o: outline(x, y) });
const bumperField = { col: shoulderCol, at: (c, z) => bumperSD(c.x, c.y, z, c.o) };
const triggerField = { col: shoulderCol, at: (c, z) => triggerSD(c.x, c.y, z, c.o) };

// ───────────────────────────── polygoniser: narrow-band surface nets, vertices projected onto the surface
function sampleField(field, x0, y0, z0, nx, ny, nz, h) {
  const B = 4;
  const H = h * B;
  const cnx = Math.ceil((nx - 1) / B) + 1;
  const cny = Math.ceil((ny - 1) / B) + 1;
  const cnz = Math.ceil((nz - 1) / B) + 1;
  const C = new Float32Array(cnx * cny * cnz);
  for (let J = 0; J < cny; J++)
    for (let I = 0; I < cnx; I++) {
      const c = field.col(x0 + I * H, y0 + J * H);
      for (let K = 0; K < cnz; K++) C[I + cnx * (J + cny * K)] = field.at(c, z0 + K * H);
    }
  // a coarse cell is "near" when the surface may pass through it
  const lim = H * 2.3;
  const near = new Uint8Array((cnx - 1) * (cny - 1) * (cnz - 1));
  for (let K = 0; K < cnz - 1; K++)
    for (let J = 0; J < cny - 1; J++)
      for (let I = 0; I < cnx - 1; I++) {
        let m = Infinity;
        for (let c = 0; c < 8; c++) m = Math.min(m, Math.abs(C[I + (c & 1) + cnx * (J + ((c >> 1) & 1) + cny * (K + (c >> 2)))]));
        if (m < lim) near[I + (cnx - 1) * (J + (cny - 1) * K)] = 1;
      }
  const F = new Float32Array(nx * ny * nz);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const I = Math.min(cnx - 2, (i / B) | 0);
      const J = Math.min(cny - 2, (j / B) | 0);
      let c = null;
      for (let k = 0; k < nz; k++) {
        const K = Math.min(cnz - 2, (k / B) | 0);
        const o = i + nx * (j + ny * k);
        if (near[I + (cnx - 1) * (J + (cny - 1) * K)]) {
          if (!c) c = field.col(x0 + i * h, y0 + j * h);
          F[o] = field.at(c, z0 + k * h);
        } else F[o] = C[I + cnx * (J + cny * K)];
      }
    }
  return F;
}
/**
 * Meshes the zero level of a field {col(x,y), at(col,z)} inside bounds [x0,y0,z0,x1,y1,z1] at cell size h.
 * Vertices are pulled onto the surface along the field's gradient; the shading normals are then taken from the mesh
 * itself (they agree with the facets the rays hit, so fewer bounces are rejected and the render is less noisy).
 * `cull(x,y,z)` drops triangles hidden inside another part.
 */
function polygonize(field, [x0, y0, z0, x1, y1, z1], h, { cull = null, uv = 0.12 } = {}) {
  const nx = Math.ceil((x1 - x0) / h) + 1;
  const ny = Math.ceil((y1 - y0) / h) + 1;
  const nz = Math.ceil((z1 - z0) / h) + 1;
  const F = sampleField(field, x0, y0, z0, nx, ny, nz, h);
  const sy = nx;
  const sz = nx * ny;
  const cnx = nx - 1;
  const cny = ny - 1;
  const cnz = nz - 1;
  const cell = new Int32Array(cnx * cny * cnz).fill(-1);
  const P = [];
  const OFF = [0, 1, sy, 1 + sy, sz, 1 + sz, sy + sz, 1 + sy + sz];
  const CX = [0, 1, 0, 1, 0, 1, 0, 1];
  const CY = [0, 0, 1, 1, 0, 0, 1, 1];
  const CZ = [0, 0, 0, 0, 1, 1, 1, 1];
  const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
  const EB = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
  const v = new Float64Array(8);
  for (let k = 0; k < cnz; k++)
    for (let j = 0; j < cny; j++)
      for (let i = 0; i < cnx; i++) {
        const base = i + j * sy + k * sz;
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = F[base + OFF[c]];
          if (v[c] < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        let ax = 0;
        let ay = 0;
        let az = 0;
        let n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EA[e];
          const b = EB[e];
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          ax += CX[a] + t * (CX[b] - CX[a]);
          ay += CY[a] + t * (CY[b] - CY[a]);
          az += CZ[a] + t * (CZ[b] - CZ[a]);
          n++;
        }
        cell[i + cnx * (j + cny * k)] = P.length / 3;
        P.push(x0 + (i + ax / n) * h, y0 + (j + ay / n) * h, z0 + (k + az / n) * h);
      }
  const cid = (i, j, k) => cell[i + cnx * (j + cny * k)];
  const quads = [];
  const quad = (inside, a, b, c, d) => (inside ? quads.push(a, b, c, d) : quads.push(a, d, c, b));
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = F[i + j * sy + k * sz];
        if (a < 0 === F[i + 1 + j * sy + k * sz] < 0) continue;
        quad(a < 0, cid(i, j - 1, k - 1), cid(i, j, k - 1), cid(i, j, k), cid(i, j - 1, k));
      }
  for (let k = 1; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const a = F[i + j * sy + k * sz];
        if (a < 0 === F[i + (j + 1) * sy + k * sz] < 0) continue;
        quad(a < 0, cid(i - 1, j, k - 1), cid(i - 1, j, k), cid(i, j, k), cid(i, j, k - 1));
      }
  for (let k = 0; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const a = F[i + j * sy + k * sz];
        if (a < 0 === F[i + j * sy + (k + 1) * sz] < 0) continue;
        quad(a < 0, cid(i - 1, j - 1, k), cid(i, j - 1, k), cid(i, j, k), cid(i - 1, j, k));
      }
  // project the vertices onto the surface (a Newton step along the gradient, then a cheap correction)
  const V = P.length / 3;
  const pos = new Float32Array(V * 3);
  const hidden = new Uint8Array(V);
  const f = (x, y, z) => field.at(field.col(x, y), z);
  const e = h * 0.25;
  for (let n = 0; n < V; n++) {
    let x = P[n * 3];
    let y = P[n * 3 + 1];
    let z = P[n * 3 + 2];
    const cx = field.col(x, y);
    const d = field.at(cx, z);
    const gz = (field.at(cx, z + e) - field.at(cx, z - e)) / (2 * e);
    const gx = (f(x + e, y, z) - f(x - e, y, z)) / (2 * e);
    const gy = (f(x, y + e, z) - f(x, y - e, z)) / (2 * e);
    const g2 = gx * gx + gy * gy + gz * gz;
    const gl = Math.sqrt(g2) || 1;
    if (g2 > 1e-10) {
      let s = d / g2;
      const step = Math.abs(s) * gl;
      if (step > h) s *= h / step;
      x -= s * gx;
      y -= s * gy;
      z -= s * gz;
      const d2 = f(x, y, z);
      let s2 = d2 / g2;
      if (Math.abs(s2) * gl > h * 0.5) s2 *= (h * 0.5) / (Math.abs(s2) * gl);
      x -= s2 * gx;
      y -= s2 * gy;
      z -= s2 * gz;
    }
    pos.set([x, y, z], n * 3);
    if (cull && cull(x, y, z)) hidden[n] = 1;
  }
  const idx = [];
  const d2 = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
  const tri = (a, b, c) => {
    if (!(hidden[a] && hidden[b] && hidden[c])) idx.push(a, b, c);
  };
  for (let q = 0; q < quads.length; q += 4) {
    const [a, b, c, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
    if (d2(a, c) <= d2(b, d)) {
      tri(a, b, c);
      tri(a, c, d);
    } else {
      tri(a, b, d);
      tri(b, c, d);
    }
  }
  // compact
  const remap = new Int32Array(V).fill(-1);
  let m = 0;
  for (const i of idx) if (remap[i] < 0) remap[i] = m++;
  const P2 = new Float32Array(m * 3);
  const U2 = new Float32Array(m * 2);
  for (let i = 0; i < V; i++) {
    const r = remap[i];
    if (r < 0) continue;
    P2.set(pos.subarray(i * 3, i * 3 + 3), r * 3);
    U2[r * 2] = pos[i * 3] * uv;
    U2[r * 2 + 1] = pos[i * 3 + 1] * uv;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(P2, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(U2, 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx.map((i) => remap[i])), 1));
  geo.computeVertexNormals();
  return geo;
}
/** A mirrored copy (x → −x) of a geometry, with its winding and normals fixed. */
function mirrorX(geo) {
  const g = geo.clone();
  const p = g.attributes.position;
  const n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    p.setX(i, -p.getX(i));
    n.setX(i, -n.getX(i));
  }
  const ix = g.index.array;
  for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]];
  return g;
}

// ───────────────────────────── turned parts (axis = z, towards the camera)
/**
 * Spins a profile [[r, z]…] (from the top centre outwards and down) round the z axis. Optional ridges: `knurl`
 * = [{ n, from, to, dr, dz }…] adds n ridges to the profile points from…to (radially by dr, axially by dz).
 */
function revolve(profile, mat, { segments = 96, knurl = [] } = {}) {
  const P = profile.length;
  const S = segments + 1;
  const pos = new Float32Array(P * S * 3);
  const uvs = new Float32Array(P * S * 2);
  for (let j = 0; j < S; j++) {
    const a = (j / segments) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let i = 0; i < P; i++) {
      let [r, z] = profile[i];
      for (const kn of knurl) {
        if (i < kn.from || i > kn.to) continue;
        const w = i === kn.from || i === kn.to ? 0.45 : 1;
        const ridge = 0.5 + 0.5 * Math.cos(kn.n * a);
        r += (kn.dr ?? 0) * ridge * w;
        z += (kn.dz ?? 0) * ridge * w;
      }
      const k = j * P + i;
      pos[k * 3] = r * ca;
      pos[k * 3 + 1] = r * sa;
      pos[k * 3 + 2] = z;
      uvs[k * 2] = j / segments;
      uvs[k * 2 + 1] = i / (P - 1);
    }
  }
  const idx = [];
  for (let j = 0; j < segments; j++)
    for (let i = 0; i < P - 1; i++) {
      const a = j * P + i;
      const b = (j + 1) * P + i;
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam's normals and point the poles straight along the axis
  const n = g.attributes.normal;
  for (let i = 0; i < P; i++) {
    const a = i;
    const b = segments * P + i;
    const x = n.getX(a) + n.getX(b);
    const y = n.getY(a) + n.getY(b);
    const z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
  for (const i of [0, P - 1])
    if (profile[i][0] === 0) for (let j = 0; j < S; j++) n.setXYZ(j * P + i, 0, 0, i === 0 ? 1 : -1);
  return new THREE.Mesh(g, mat);
}
/** Orients a part so its +z follows the top surface's normal at (x, y), and seats it `dz` above that surface. */
function seat(obj, x, y, dz) {
  const gx = (topZ(x + EPS, y) - topZ(x - EPS, y)) / (2 * EPS);
  const gy = (topZ(x, y + EPS) - topZ(x, y - EPS)) / (2 * EPS);
  const n = new THREE.Vector3(-gx, -gy, 1).normalize();
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  obj.position.set(x, y, topZ(x, y) + dz);
  return obj;
}

/**
 * A thumbstick, its z = 0 on the deck: a thin brand-red bezel framing a soft-gloss well, a domed base (its crest
 * below the bezel's lip) and stem, and a rubber cap — a deep concave dish, a knurled crown and a knurled side band.
 */
function thumbstick(mat) {
  const g = new THREE.Group();
  const H = STICK.hole;
  g.add(revolve([[H - 0.072, -0.3], [H - 0.072, -0.05], [H - 0.067, -0.025], [H - 0.056, -0.008], [H - 0.04, 0.002], [H - 0.022, 0.003], [H - 0.009, -0.007], [H - 0.001, -0.027], [H + 0.003, -0.05], [H + 0.003, -0.3]], mat.ring, { segments: 160 }));
  g.add(revolve([[0.72, -0.42], [0.85, -0.412], [0.96, -0.392], [1.06, -0.352], [1.14, -0.295], [1.2, -0.226], [1.25, -0.152], [1.29, -0.09], [H - 0.06, -0.04]], mat.well, { segments: 128 }));
  const R = 1.35;
  const dome = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.asin(0.81 / R);
    dome.push([R * Math.sin(a), -0.03 - R + R * Math.cos(a)]);
  }
  dome.push([0.81, -0.5], [0, -0.5]);
  g.add(revolve(dome, mat.base, { segments: 112 }));
  g.add(revolve([[0, 0.54], [0.37, 0.54], [0.37, -0.2], [0, -0.2]], mat.base, { segments: 64 }));
  const cap = [
    [0, 0.68], [0.12, 0.685], [0.24, 0.701], [0.36, 0.727], [0.47, 0.762], [0.57, 0.805], [0.65, 0.846], [0.705, 0.878], [0.735, 0.891],
    [0.76, 0.896], [0.785, 0.897],
    [0.802, 0.912], [0.815, 0.94], [0.833, 0.972], [0.856, 0.997], [0.884, 1.011], [0.913, 1.012], [0.938, 1.0], [0.955, 0.978], [0.965, 0.95],
    [0.968, 0.92], [0.968, 0.885], [0.967, 0.85], [0.966, 0.815], [0.964, 0.78], [0.962, 0.745], [0.959, 0.71], [0.955, 0.68],
    [0.947, 0.655], [0.93, 0.636], [0.905, 0.624], [0.87, 0.618], [0.6, 0.615], [0, 0.615],
  ].map(([r, z]) => [r, z - 0.12]);
  // the dish is a smoother, slightly glossy rubber (a crisp crescent of light shows its hollow); crown and band are
  // matte, their knurls coarse enough to read
  g.add(revolve(cap.slice(0, 11), mat.dish, { segments: 160 }));
  g.add(revolve(cap.slice(10), mat.rubber, { segments: 240, knurl: [{ n: 24, from: 3, to: 7, dz: 0.03 }, { n: 40, from: 10, to: 17, dr: 0.03 }] }));
  return g;
}
/** A round face button standing on z = 0, its top gently domed. */
function faceButton(mat) {
  return revolve([[0, 0.34], [0.12, 0.338], [0.23, 0.332], [0.31, 0.32], [0.36, 0.303], [0.392, 0.28], [0.405, 0.255], [0.41, 0.225], [0.41, -0.2], [0, -0.2]], mat, { segments: 80 });
}
/** A polygon outline with rounded corners (radii per corner). */
function roundedPoly(pts, radii) {
  const s = new THREE.Shape();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const c = pts[i];
    const q = pts[(i + 1) % n];
    const r = radii[i];
    const l1 = len(p[0] - c[0], p[1] - c[1]);
    const l2 = len(q[0] - c[0], q[1] - c[1]);
    const a = [c[0] + ((p[0] - c[0]) / l1) * r, c[1] + ((p[1] - c[1]) / l1) * r];
    const b = [c[0] + ((q[0] - c[0]) / l2) * r, c[1] + ((q[1] - c[1]) / l2) * r];
    if (i === 0) s.moveTo(a[0], a[1]);
    else s.lineTo(a[0], a[1]);
    s.quadraticCurveTo(c[0], c[1], b[0], b[1]);
  }
  s.closePath();
  return s;
}
/** The d-pad: four separate arrow keys round a centre, standing on z = 0 and leaning outwards a little. */
function dpad(mat) {
  const g = new THREE.Group();
  const shape = roundedPoly([[0.25, 0], [0.52, 0.335], [1.14, 0.335], [1.14, -0.335], [0.52, -0.335]], [0.07, 0.1, 0.13, 0.13, 0.1]);
  for (let k = 0; k < 4; k++) {
    const key = smoothNormals(extrude(shape, 0.5, 0.075, mat, { bevelSegments: 6, curveSegments: 12 }));
    const lean = new THREE.Group();
    lean.add(key);
    lean.rotation.y = -0.07;
    const turn = new THREE.Group();
    turn.add(lean);
    turn.rotation.z = (k * Math.PI) / 2;
    g.add(turn);
  }
  return g;
}
/** A light guide's glow: brightest along its middle, fading towards its ends (CapsuleGeometry v runs along it). */
function guideGlow() {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createLinearGradient(0, 0, 0, 128);
  for (const [t, v] of [[0, 120], [0.18, 200], [0.5, 255], [0.82, 200], [1, 120]]) grd.addColorStop(t, `rgb(${v},${v},${v})`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
/** The speaker grille: a perforated metal pill plate over a black backing, its top at z = 0. */
function grille(mat) {
  const s = roundedRect(GRILLE.w, GRILLE.h, GRILLE.h / 2);
  for (const [row, y] of [[0, -0.1], [1, 0], [2, 0.1]])
    for (let i = 0; i < 11 - (row % 2); i++) {
      const hole = new THREE.Path();
      hole.absarc(-0.65 + (row % 2) * 0.065 + i * 0.13, y, 0.03, 0, Math.PI * 2, true);
      s.holes.push(hole);
    }
  const plate = extrude(s, 0.06, 0.014, mat.grille, { bevelSegments: 3, curveSegments: 10 });
  plate.position.z = -0.03;
  const back = extrude(roundedRect(GRILLE.w - 0.04, GRILLE.h - 0.04, GRILLE.h / 2 - 0.02), 0.1, 0.02, mat.hole, { bevelSegments: 2, curveSegments: 16 });
  back.position.z = -0.13;
  const g = new THREE.Group();
  g.add(plate, back);
  return g;
}

/**
 * The touch pad's material: the name printed (titleMaterial) on a black glass-like face. The face is made a dark
 * metal with a 4–8 % reflectance — optically a gloss black, but with a single clean mirror lobe, so its reflections stay
 * free of the speckle a dielectric's diffuse/specular lobe lottery leaves at preview sample counts. The ink stays a
 * white paint: a metalness map (blue channel) is derived from the title's roughness map (ink is rougher than face).
 */
function padMaterial(text, lang) {
  const FACE_R = 0.08;
  const INK_R = 0.55;
  const FACE = 0x4a;
  // a flush pad-print: the ink is a matte white paint with only a whisper of relief (no embossed rim)
  const m = titleMaterial(text, lang, PAD.w, PAD.h, M.gloss({ color: "#4a4a4a", roughness: FACE_R, clearcoat: 0 }), {
    fitW: lang === "ar" ? 0.92 : 0.95,
    fitH: 0.6,
    weight: 900,
    inkRoughness: INK_R,
    relief: 0.15,
  });
  // A smoked-glass face: its tint deepens towards the bottom edge (reflectance ≈ 3.6 % there, 8 % under the band), so
  // the mirrored studio fades in one soft gradient from a lifted black under the band to a deep black at the bottom.
  // The ink keeps its white (each pixel keeps its ink share, so the antialiased edges stay clean).
  {
    const cm = m.map.image;
    const cc = document.createElement("canvas");
    cc.width = cm.width;
    cc.height = cm.height;
    const cg = cc.getContext("2d");
    cg.drawImage(cm, 0, 0);
    const ci = cg.getImageData(0, 0, cc.width, cc.height);
    const ty = textY(lang);
    for (let r = 0; r < cc.height; r++) {
      const y = ty + PAD.h / 2 - ((r + 0.5) / cc.height) * PAD.h;
      const t = clamp(((y - PAD.cy) / (PAD.h / 2) + 1) / 1.6, 0, 1);
      const face = mix(0x36, 0x50, t);
      for (let q = 0; q < cc.width; q++) {
        const i = (r * cc.width + q) * 4;
        const a = clamp((ci.data[i] - FACE) / (255 - FACE), 0, 1);
        ci.data[i] = ci.data[i + 1] = ci.data[i + 2] = Math.round(face + a * (255 - face));
      }
    }
    cg.putImageData(ci, 0, 0);
    const map = new THREE.CanvasTexture(cc);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 16;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.repeat.copy(m.map.repeat);
    map.offset.copy(m.map.offset);
    map.updateMatrix();
    m.map = map;
  }
  const src = m.roughnessMap.image;
  // the kit centres the line by its advance; right-to-left tails push the ink off centre. Measure the ink box (the
  // ink is rougher than the face) so build() can centre the ink itself on the pad.
  {
    const sg = src.getContext("2d").getImageData(0, 0, src.width, src.height).data;
    let c0 = src.width;
    let c1 = -1;
    for (let r = 0; r < src.height; r += 2)
      for (let q = 0; q < src.width; q++) if (sg[(r * src.width + q) * 4 + 1] > 80) {
        c0 = Math.min(c0, q);
        c1 = Math.max(c1, q);
      }
    m.userData.inkDx = c1 >= c0 ? ((c0 + c1 + 1) / 2 / src.width - 0.5) * PAD.w : 0;
  }
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext("2d");
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const f = 255 * FACE_R;
  const k = 255 * INK_R;
  for (let i = 0; i < img.data.length; i += 4) img.data[i + 2] = Math.round(255 * (1 - clamp((img.data[i + 1] - f) / (k - f), 0, 1)));
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 16;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.copy(m.roughnessMap.repeat);
  tex.offset.copy(m.roughnessMap.offset);
  tex.updateMatrix();
  m.roughnessMap = tex;
  m.metalnessMap = tex;
  m.metalness = 1;
  return m;
}

// ───────────────────────────── build
export function build({ text, lang }) {
  const mat = {
    // a console-white moulding with a light gloss lobe (crisp highlights along the top edge and the shoulders)
    white: M.white({ color: "#e8e8e4", normalMap: null, roughness: 0.28, clearcoat: 0.55, clearcoatRoughness: 0.1, specularIntensity: 0.8 }),
    black: M.satin({ color: "#2c2d33", roughness: 0.5, clearcoat: 0.28, clearcoatRoughness: 0.3 }),
    pad: padMaterial(text, lang),
    light: M.glow("#2f6bff", 6, { emissiveMap: guideGlow() }),
    rubber: M.rubber({ normalMap: null, color: "#3d3f46", roughness: 0.5, sheen: 0.5, sheenRoughness: 0.5, sheenColor: new THREE.Color("#666a74") }),
    dish: M.rubber({ normalMap: null, color: "#36383e", roughness: 0.25, sheen: 0.3, sheenRoughness: 0.4, sheenColor: new THREE.Color("#666a74") }),
    // soft gloss in the wells: a gradient highlight on the dome rather than a hard mirror wedge
    base: M.gloss({ color: "#141418", roughness: 0.26, clearcoat: 0.6, clearcoatRoughness: 0.18 }),
    well: M.gloss({ color: "#0e0e11", roughness: 0.2 }),
    ring: M.red({ roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.15 }),
    keys: M.satin({ color: "#1c1d22", roughness: 0.22, clearcoat: 0.9, clearcoatRoughness: 0.08 }),
    bumper: M.satin({ color: "#2c2d33", roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }),
    trigger: M.satin({ color: "#1b1c21", roughness: 0.45, clearcoat: 0.25, clearcoatRoughness: 0.35 }),
    home: M.gunmetal({ color: "#8a8f98", roughness: 0.22 }),
    grille: M.gunmetal({ color: "#4a4e57", roughness: 0.28 }),
    hole: M.satin({ color: "#050506", roughness: 0.9, clearcoat: 0 }),
  };
  const o = new THREE.Group();

  // the shell and the core (added to the root below, with the pose baked in)
  const BOX = [-9.2, -7.5, -6.9, 9.2, 5.5, 0.6];
  const white = polygonize(whiteField, BOX, 0.067, { cull: (x, y, z) => blackAt(col(x, y), z) < -0.03 });
  const black = polygonize(blackField, BOX, 0.095, { cull: (x, y, z) => whiteAt(col(x, y), z) < -0.03 });

  // the touch pad (its UVs are its own face coordinates, centred where the name goes)
  const pad = polygonize(padField, [-5.5, 0.95, -0.6, 5.5, 4.75, 0.5], 0.047, { uv: 1, cull: (x, y, z) => z < padTop(x, y) - 0.25 });
  const uv = pad.attributes.uv;
  const ty = textY(lang);
  const dx = mat.pad.userData.inkDx;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + dx, uv.getY(i) - ty);
  o.add(new THREE.Mesh(pad, mat.pad));

  // the light guides in the slots beside the pad
  for (const s of [-1, 1]) {
    const [x0, y0] = sidePoint(s, SLOT.t0 + 0.04, SLOT.off);
    const [x1, y1] = sidePoint(s, SLOT.t1 - 0.04, SLOT.off);
    const l = len(x1 - x0, y1 - y0);
    const strip = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, l, 8, 24), mat.light);
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    strip.position.set(mx, my, topZ(mx, my) - 0.1);
    strip.rotation.z = Math.atan2(-(x1 - x0), y1 - y0);
    o.add(strip);
  }

  // thumbsticks on the deck (the deck sits 0.15 below the top surface)
  for (const s of [-1, 1]) o.add(seat(thumbstick(mat), s * STICK.x, STICK.y, -0.15));
  // d-pad and face buttons in their dishes
  o.add(seat(dpad(mat.keys), DPAD.x, DPAD.y, -0.1));
  for (const [bx, by] of FACE_AT) o.add(seat(faceButton(mat.keys), bx, by, -0.1));
  // home button and speaker grille between the sticks
  const home = new THREE.Group();
  home.add(revolve([[0, 0.15], [0.12, 0.148], [0.2, 0.142], [0.25, 0.131], [0.28, 0.115], [0.297, 0.093], [0.3, 0.07], [0.3, -0.25], [0, -0.25]], mat.home, { segments: 96 }));
  home.add(revolve([[0.335, -0.15], [0.335, 0.0], [0.346, 0.022], [0.37, 0.036], [0.403, 0.04], [0.433, 0.031], [0.452, 0.013], [0.461, -0.018], [0.461, -0.15]], mat.well, { segments: 96 }));
  o.add(seat(home, HOME.x, HOME.y, -0.15));
  // the grille plate sits on the deck, a hair proud (no recess: a sub-cell recess left a lit sliver under it)
  o.add(seat(grille(mat), GRILLE.x, GRILLE.y, -0.12));

  // the two menu keys
  for (const s of [-1, 1]) {
    const key = smoothNormals(slab(2 * MENU.r, 2 * (MENU.half + MENU.r), 0.36, MENU.r, mat.keys, 0.05, { bevelSegments: 5, curveSegments: 12 }));
    key.rotation.z = -s * Math.atan2(SIDE.tx, SIDE.ty);
    const holder = new THREE.Group();
    holder.add(key);
    o.add(seat(holder, s * MENU.x, MENU.y, -0.1));
  }

  // bumpers and triggers (modelled on the right, mirrored to the left)
  const bumper = polygonize(bumperField, [3.6, 2.9, -1.75, 7.8, 5.4, -0.5], 0.04);
  const trigger = polygonize(triggerField, [3.8, 2.9, -3.2, 7.6, 5.4, -1.4], 0.05);
  for (const g of [bumper, mirrorX(bumper)]) o.add(new THREE.Mesh(g, mat.bumper));
  for (const g of [trigger, mirrorX(trigger)]) o.add(new THREE.Mesh(g, mat.trigger));

  // core.js sets the floor under the world box it gets by turning each mesh's own box with it. The shell's box has
  // empty corners in front of the grips that the lean swings below them, which would float the controller twice as
  // high as `gap` says. The pose is baked into the shell and the core (the lowest parts), so their boxes are tight and
  // `gap` is the real float height of the lower grip.
  const pose = new THREE.Euler(LEAN, 0, ROLL);
  const root = new THREE.Group();
  const baked = new THREE.Matrix4().makeRotationFromEuler(pose);
  root.add(new THREE.Mesh(white.applyMatrix4(baked), mat.white), new THREE.Mesh(black.applyMatrix4(baked), mat.black));
  o.rotation.copy(pose);
  root.add(o);
  root.scale.setScalar(0.15);
  return root;
}
