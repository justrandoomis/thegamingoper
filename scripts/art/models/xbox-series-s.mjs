/**
 * xbox-series-s — 151 × 275 × 63.5 mm, standing vertically.
 * White slab. Its big side face looks at the viewer and carries the large black circular vent
 * grille; round vent holes on top; the narrow front panel (+X) has the power button and a port.
 * No logos: the power button is a plain lit dot.
 */
export const views = {
  hero: { azimuth: 34, elevation: 27 }, // the same stance as xbox-series-x
  front: { elevation: 7 },
};

export function build(kit) {
  const { clay, glow, hollow, colors } = kit;
  const W = 151, H = 275, D = 63.5, HALF = W / 2, F = D / 2;
  const FOOT = 1.8; // the shell stands on low rubber feet
  const BODY = H - FOOT, MID = FOOT + BODY / 2;
  const CORNER = 8, EDGE = 3.4;
  const VENT = 60, VENT_Y = H - 80; // radius and height of the round grille
  const SINK = 2.4; // the grille sits this far below the surface

  const white = clay(colors.white);
  const black = clay(colors.black);
  const key = clay(colors.grey, { finish: 'satin' });
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── body: a white shell with a round opening in its big face ─────────────
  add(kit.extrude(kit.rect(W, BODY, CORNER), D, { bevel: EDGE, bevelSegments: 6, holes: [kit.circle(VENT).move(0, VENT_Y - MID)] }), white, [0, MID, 0]);
  // the far face is one plain panel, which also closes the opening from behind (hard crease:
  // smoothing its tiny bevel into such a large flat face would show the fan of triangles)
  add(kit.slab(kit.rect(W - 2 * EDGE, BODY - 2 * EDGE, CORNER - EDGE), 3, { bevel: 0.3, crease: 5, axis: '-z' }), white, [0, MID, -F + 1.25]);
  const foot = kit.box(44, FOOT + 1.4, 9, 1.2);
  add(foot, clay(colors.jet, { finish: 'soft' }), [-42, (FOOT + 1.4) / 2, 0]);
  add(foot, clay(colors.jet, { finish: 'soft' }), [42, (FOOT + 1.4) / 2, 0]);

  // ── the round grille: rings of holes that get smaller towards the rim ────
  add(kit.slab(kit.circle(VENT + 1.5), 8, { bevel: 0.5 }), black, [0, VENT_Y, F - SINK - 4]);
  parts.push(kit.vents([[0, 0]], { radius: 2.9, material: dark, at: [0, VENT_Y, F - SINK] }));
  for (let i = 1; i <= 7; i++) {
    parts.push(kit.vents(kit.radial(6 * i, 7.7 * i, { start: i % 2 ? 0 : 30 / i }), { radius: 3 - 0.16 * i, material: dark, at: [0, VENT_Y, F - SINK] }));
  }

  // ── top: rows of round vent holes ────────────────────────────────────────
  parts.push(kit.vents(kit.grid(15, 5, 8.2, 8.2), { radius: 2.3, material: dark, at: [0, H, 0], rot: [-90, 0, 0] }));

  // ── front panel (+X): power button above, port and pairing button below ──
  add(kit.ring(7.3, 5.4, 0.9, { bevel: 0.3, axis: 'x' }), key, [HALF - 0.2, 249, 0]);
  add(kit.puck(5.5, 1.2, { bevel: 0.5, top: 0.25, axis: 'x' }), glow('#f4f6f8', 0.8), [HALF - 0.2, 249, 0]);
  parts.push(kit.vents([[0, 0]], { size: [5.6, 13], material: dark, at: [HALF, 30, 0], rot: [0, 90, 0] })); // USB
  add(kit.puck(2.1, 1, { bevel: 0.4, axis: 'x' }), key, [HALF - 0.2, 48, 0]); // pairing

  // ── back panel (−X): ports ───────────────────────────────────────────────
  const port = (y, w, h) => parts.push(kit.vents([[0, 0]], { size: [w, h], material: dark, at: [-HALF, y, 0], rot: [0, -90, 0] }));
  port(34, 10, 15); // power
  port(58, 6, 15); // display
  port(80, 6, 13); // USB
  port(98, 6, 13); // USB
  port(120, 12, 13); // network
  port(152, 11, 30); // storage expansion

  return kit.group(parts);
}
