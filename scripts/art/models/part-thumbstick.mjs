/**
 * part-thumbstick — 18 × 18 × 20 mm.
 * Replacement analog stick module: a small metal can on solder legs, a round collar on top with
 * the black stick post rising out of it, a green potentiometer on the front and on the right-hand
 * side (the two axes) and the click switch at the back. It stands on its legs as it would on the
 * circuit board. No markings.
 */
export const views = { hero: { azimuth: 34, elevation: 24 } };

export function build(kit) {
  const { clay, metal, hollow, colors } = kit;
  const CAN = 15, HALF = CAN / 2; // the can is square seen from above
  const LEGS = 2.6, PLATE = 1; // legs under the base plate
  const BASE = LEGS + PLATE; // where the can starts
  const TOP = BASE + 7.3; // top of the can
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));
  const steel = metal(colors.silver), black = clay(colors.black, { finish: 'satin' });

  // ── can on its base plate ────────────────────────────────────────────────
  add(kit.slab(kit.rect(CAN + 0.6, CAN + 0.6, 0.9), PLATE, { bevel: 0.25, axis: 'y' }), clay('#3b2f2a'), [0, LEGS + PLATE / 2, 0]);
  add(kit.slab(kit.rect(CAN, CAN, 1.9), TOP - BASE, { bevel: 1.3, bevelBack: 0.2, bevelSegments: 6, rings: 8, axis: 'y' }), steel, [0, (BASE + TOP) / 2, 0]);
  // collar, the dark of the opening, the ball the stick turns on
  add(kit.ring(6.1, 3.9, 1.6, { bevel: 0.65 }), steel, [0, TOP - 0.15, 0]);
  add(kit.puck(4, 0.5, { bevel: 0 }), hollow(), [0, TOP + 0.05, 0]);
  add(kit.puck(3.4, 2, { bevel: 1.6, top: 0.5 }), black, [0, TOP + 0.1, 0]);
  // stick post: flat-sided, so a cap can only go on one way
  add(kit.slab(kit.rect(4.6, 3.3, 0.85), 6.2, { bevel: 0.85, axis: 'y' }), black, [0, TOP + 1.5 + 3.1, 0]);

  // ── legs: four tabs of the can ───────────────────────────────────────────
  const tab = kit.box(2.2, BASE + 1.6, 0.5, 0.2);
  for (const x of [-HALF + 1.9, HALF - 1.9]) for (const z of [-HALF, HALF]) add(tab, steel, [x, (BASE + 1.6) / 2, z]);

  // ── potentiometers on the front and on the right-hand side ───────────────
  const green = clay('#2d8a5c', { finish: 'satin' });
  const pot = (placement) => kit.group([
    kit.mesh(kit.slab(kit.rect(9.8, 7.4, 1.3), 2.7, { bevel: 0.7 }), green, { at: [0, 0, 1.35] }),
    kit.mesh(kit.puck(2.1, 0.5, { bevel: 0.2, axis: 'z' }), clay(colors.white), { at: [0, 0.3, 2.55] }), // the wiper hub
    kit.vents([[0, 0]], { size: [2.9, 0.75], at: [0, 0.3, 3.05] }),
    ...[-2.6, 0, 2.6].map((x) => kit.mesh(kit.box(0.8, BASE + 0.6, 0.4, 0.15), steel, { at: [x, -3.7 - (BASE + 0.6) / 2 + 0.6, 1.3] })),
  ], placement);
  const potY = BASE + 3.7 + 0.25;
  parts.push(pot({ at: [0, potY, HALF - 0.1] }));
  parts.push(pot({ at: [HALF - 0.1, potY, 0], rot: [0, 90, 0] }));

  // ── click switch at the back ─────────────────────────────────────────────
  add(kit.box(6.4, 4.6, 2.4, 0.5), black, [0, BASE + 2.3, -HALF - 1.1]);
  add(kit.puck(1.1, 0.5, { bevel: 0.2, axis: '-z' }), clay(colors.coral), [0, BASE + 2.5, -HALF - 2.25]);
  for (const x of [-2.2, 2.2]) add(kit.box(0.8, BASE + 0.4, 0.4, 0.15), steel, [x, (BASE + 0.4) / 2, -HALF - 1.2]);

  return kit.group(parts);
}
