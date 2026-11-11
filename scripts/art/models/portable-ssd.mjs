/**
 * portable-ssd — 100 × 55 × 10 mm.
 * Pocket SSD in a dark blue rubberised shell with a carabiner loop: a real three-cornered hole
 * through one corner, lined in light blue. Slanted grip ridges in the opposite corner, the USB-C
 * port and a status light on the short edge. It stands on its long edge, leaning back. No logos.
 */
export const views = { hero: { azimuth: 28, elevation: 18 } };

export function build(kit) {
  const { clay, colors } = kit;
  const W = 100, H = 55, D = 10, F = D / 2;
  const EDGE = 2.3; // rounding of the rubber edge
  const BAR = 6.8; // width of the loop that is left around the hole
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── shell with the loop: a three-cornered hole in the top right corner ───
  const right = W / 2 - BAR, top = H / 2 - BAR;
  const hole = (grow) => kit.polygon(
    [[right - 25 - 2.4 * grow, top + grow], [right + grow, top + grow], [right + grow, top - 25 - 2.4 * grow]],
    [2.4 + grow, 10.5 - BAR + grow, 2.4 + grow],
    { segments: 10 },
  );
  const shell = kit.deform(
    kit.extrude(kit.rect(W, H, 10.5), D, { bevel: EDGE, bevelSegments: 6, holes: [hole(0)] }),
    () => {}, // no bending: this only cuts the big faces into small triangles so they shade evenly
    { maxEdge: 2.4 },
  );
  const rubber = clay(colors.navy, { finish: 'soft' });
  add(shell, rubber, [0, 0, 0]);
  // lining of the loop: a light blue sleeve through the hole
  add(kit.extrude(hole(0.5), D - 2 * EDGE + 1.2, { bevel: 0.45, holes: [hole(-1.1)] }), clay(colors.lightBlue, { finish: 'satin' }), [0, 0, 0]);

  // ── grip ridges in the bottom left corner, slanted like the loop ─────────
  const ridge = clay('#2a4079', { finish: 'satin' }); // a shade lighter than the shell, so the ridges read
  for (const [i, length] of [34, 27, 20, 13].entries()) {
    const offset = 6.6 * i; // each ridge sits further into the corner
    add(kit.slab(kit.pill(length, 2.7), 1.5, { bevel: 0.7 }), ridge, [-22.5 - offset * 0.707, -5.2 - offset * 0.707, F - 0.45], [0, 0, -45]);
  }

  // ── USB-C port and status light on the right-hand edge ──────────────────
  add(kit.slab(kit.rect(4.8, 11.6, 2.2), 0.8, { bevel: 0.25, axis: 'x' }), clay('#2c4380', { finish: 'satin' }), [W / 2 - 0.25, -13, 0]);
  parts.push(kit.vents([[0, 0]], { size: [2.8, 8.8], at: [W / 2 + 0.15, -13, 0], rot: [0, 90, 0] }));
  add(kit.puck(0.75, 0.5, { bevel: 0.2, axis: 'x' }), kit.glow('#7fd6ff', 1.6), [W / 2 - 0.15, -4, 0]);

  // stand it on its long edge, leaning back
  return kit.group([kit.group(parts, { at: [0, H / 2, 0] })], { rot: [-11, 0, 0] });
}
