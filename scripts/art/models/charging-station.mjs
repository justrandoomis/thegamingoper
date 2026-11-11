/**
 * charging-station — 160 × 60 × 100 mm.
 * Dual controller charging dock: a low white base and, on it, a black cradle whose top slopes
 * down towards the front, with a well for each controller and a charging contact standing in
 * each well. A small charge light on the front of the base, the power socket at the back.
 * No logos.
 */
export const views = { hero: { azimuth: 28, elevation: 22 } };

export function build(kit) {
  const { clay, metal, glow, colors } = kit;
  const W = 160, H = 60, D = 100;
  const BASE = 20; // height of the white base
  const CRADLE = [140, 74], SUNK = 8; // the cradle seen from above, and how far it sits in the base
  const TALL = H - BASE + SUNK; // its height at the back
  const DROP = 22; // how much lower its top is at the front
  const WELL = [48, 44], WELL_X = 34; // the two wells
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // Everything in the cradle follows the same slope: full height at the back (z = −37), DROP less at the front.
  const lowered = (z) => (DROP * (z + CRADLE[1] / 2)) / CRADLE[1];
  const slope = (thickness) => (p) => { p.y -= ((p.y + thickness / 2) / thickness) * lowered(p.z); };
  const tilt = (Math.atan(DROP / CRADLE[1]) * 180) / Math.PI;

  // ── base ─────────────────────────────────────────────────────────────────
  add(kit.slab(kit.superellipse(W, D, 4.6), BASE, { bevel: 7, bevelBack: 2.4, bevelSegments: 8, rings: 10, axis: 'y' }), clay(colors.white), [0, BASE / 2, 0]);

  // ── cradle: a block with two real wells, its top sloped ──────────────────
  const wells = [-WELL_X, WELL_X].map((x) => kit.rect(WELL[0], WELL[1], 13, { segments: 8 }).move(x, 0));
  const cradle = kit.deform(
    kit.extrude(kit.superellipse(CRADLE[0], CRADLE[1], 5), TALL, { bevel: 3.4, bevelSegments: 6, holes: wells, axis: 'y' }),
    slope(TALL),
    { maxEdge: 3 },
  );
  const bottom = BASE - SUNK;
  add(cradle, clay(colors.black), [0, bottom + TALL / 2, 0]);
  // the floor of the wells, 13 mm down
  const FLOOR = TALL - 13;
  add(kit.deform(kit.slab(kit.rect(124, 58, 14, { edge: 10 }), FLOOR, { bevel: 1, rings: 8, axis: 'y' }), (p) => { p.y -= ((p.y + FLOOR / 2) / FLOOR) * lowered(p.z) * (TALL / FLOOR); }), clay(colors.jet, { finish: 'soft' }), [0, bottom + FLOOR / 2, 0]);
  // a charging contact in each well
  for (const x of [-WELL_X, WELL_X]) {
    const y = bottom + FLOOR - lowered(2) * 1;
    parts.push(kit.group([
      kit.mesh(kit.slab(kit.rect(17, 9, 2.6), 5, { bevel: 1.4, axis: 'y' }), clay(colors.graphite, { finish: 'satin' }), { at: [0, 1.6, 0] }),
      kit.mesh(kit.slab(kit.pill(9.6, 3.2), 3.4, { bevel: 0.9, axis: 'y' }), metal(colors.silver), { at: [0, 4.6, 0] }),
    ], { at: [x, y, 2], rot: [tilt, 0, 0] }));
  }

  // ── charge light on the front of the base, power socket at the back ──────
  add(kit.slab(kit.pill(10, 2.2), 1, { bevel: 0.45 }), glow('#ffb24a', 1.5), [0, 8.6, D / 2 - 0.1]);
  add(kit.slab(kit.rect(15, 9, 2.4), 0.9, { bevel: 0.3, axis: '-z' }), clay(colors.silver), [0, 9.5, -D / 2 + 0.35]);
  parts.push(kit.vents([[0, 0]], { size: [10.4, 4.6], at: [0, 9.5, -D / 2 - 0.1], rot: [0, 180, 0] }));

  return kit.group(parts);
}
