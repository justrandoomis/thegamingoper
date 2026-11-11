/**
 * xbox-series-x — 151 × 301 × 151 mm, standing vertically.
 * Matte black monolith; concave top vent with a grid of round holes and a green tint underneath;
 * a small slot and a button on the front face. No logos: the power button is a plain lit dot.
 */
export const views = {
  hero: { azimuth: 34, elevation: 27 }, // high enough to look into the top vent
  front: { elevation: 7 },
  back: { azimuth: 214, elevation: 27 },
};

export function build(kit) {
  const { clay, glow, hollow, colors } = kit;
  const W = 151, H = 301, HALF = W / 2;
  const FOOT = 5; // height of the round stand
  const WALL = 6.2; // shell thickness around the top vent
  const OPEN = W - 2 * WALL; // the top opening
  const DISH_RIM = H - 3.2, DISH_SAG = 6.5; // the vent plate hangs like a shallow bowl

  const shell = clay(colors.black);
  const key = clay(colors.graphite, { finish: 'satin' });
  const dark = hollow();
  const green = '#17b02a';
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── body: a square tube, open at the top, on a round foot ────────────────
  add(kit.puck(59, FOOT + 2, { bevel: 1.5, bevelBottom: 1.5 }), clay(colors.jet, { finish: 'soft' }), [0, 0, 0]);
  add(kit.extrude(kit.rect(W, W, 8.5), H - FOOT, { bevel: 2.7, bevelSegments: 6, holes: [kit.rect(OPEN, OPEN, 15)], axis: 'y' }), shell, [0, FOOT + (H - FOOT) / 2, 0]);
  add(kit.slab(kit.rect(OPEN + 1, OPEN + 1, 15), H - FOOT - 22, { bevel: 2, axis: 'y' }), dark, [0, FOOT + (H - FOOT - 22) / 2 + 0.5, 0]); // fills the tube

  // ── top vent ─────────────────────────────────────────────────────────────
  const squircle = (x, z, half) => ((Math.abs(x) / half) ** 4 + (Math.abs(z) / half) ** 4) ** 0.25;
  const sag = (x, z) => DISH_SAG * Math.max(0, 1 - squircle(x, z, OPEN / 2) ** 2.4);
  // Two perforated plates, one on the other: a thin black skin, and under it a thick green
  // one. The green you see is the inside of its holes — that is what tints the vent from any angle.
  const PITCH = 11.7, HOLE = 4.6, SKIN = 1.1, LINING = 4.4;
  const centres = kit.grid(11, 11, PITCH, PITCH, { keep: (x, y) => squircle(x, y, 66) <= 1 });
  const perforated = (thickness, bevel, radius) => kit.deform(
    kit.extrude(kit.rect(OPEN - 0.5, OPEN - 0.5, 14.8), thickness, { bevel, holes: centres.map(([x, y]) => kit.circle(radius, { segments: 28 }).move(x, y)), axis: 'y' }),
    (p) => { p.y -= sag(p.x, p.z); },
    { maxEdge: 3 },
  );
  add(perforated(SKIN, 0.4, HOLE), shell, [0, DISH_RIM - SKIN / 2, 0]);
  add(perforated(LINING, 0.3, HOLE + 0.12), glow(green, 0.5), [0, DISH_RIM - SKIN - LINING / 2, 0]);
  for (const [x, z] of [[-34, -34], [34, -34], [-34, 34], [34, 34], [0, 0]]) {
    parts.push(kit.accentLight(green, 0.5, 26).translateX(x).translateY(DISH_RIM - 9 - sag(x, z)).translateZ(z));
  }

  // ── front: power button, disc slot, eject, port, pairing button ──────────
  const FRONT = HALF;
  add(kit.ring(7.6, 5.7, 0.9, { bevel: 0.3, axis: 'z' }), key, [-56.5, 282.5, FRONT - 0.2]);
  add(kit.puck(5.8, 1.2, { bevel: 0.5, top: 0.25, axis: 'z' }), glow('#f4f6f8', 0.8), [-56.5, 282.5, FRONT - 0.2]);
  add(kit.slab(kit.pill(6.6, 128), 0.9, { bevel: 0.3 }), key, [-55, 112, FRONT + 0.2]);
  parts.push(kit.vents([[0, 0]], { size: [2.6, 121], at: [-55, 112, FRONT + 0.65] }));
  add(kit.puck(2.3, 1.1, { bevel: 0.45, axis: 'z' }), key, [-43.5, 57, FRONT - 0.2]); // eject
  add(kit.slab(kit.rect(16.4, 9, 2.4), 0.9, { bevel: 0.3 }), key, [53, 28, FRONT + 0.2]);
  parts.push(kit.vents([[0, 0]], { size: [12.6, 5.4], at: [53, 28, FRONT + 0.65] })); // USB
  add(kit.puck(2.1, 1, { bevel: 0.4, axis: 'z' }), key, [38, 28, FRONT - 0.2]); // pairing

  // ── back: large oval vents above, ports below ────────────────────────────
  const BACK = -HALF;
  parts.push(kit.vents(kit.grid(8, 11, 15, 14.5, { stagger: true }), { size: [9.5, 6.4], at: [-3.75, 196, BACK], rot: [0, 180, 0] }));
  const port = (x, y, w, h) => {
    add(kit.slab(kit.rect(w + 3.6, h + 3.6, 2.4), 0.9, { bevel: 0.3, axis: '-z' }), key, [x, y, BACK - 0.2]);
    parts.push(kit.vents([[0, 0]], { size: [w, h], at: [x, y, BACK - 0.65], rot: [0, 180, 0] }));
  };
  port(46, 64, 22, 30); // expansion slot
  port(14, 76, 13, 5.6); // USB
  port(14, 62, 13, 5.6); // USB
  port(-12, 70, 15, 6); // display
  port(-36, 70, 13, 11.5); // network
  port(-12, 46, 15, 10); // power

  return kit.group(parts);
}
