/**
 * ps-portal — 300 × 120 × 50 mm.
 * An 8-inch screen held between two white controller halves. The black core shows as a band on
 * each side of the screen and runs down the inside of the grips, where the sticks sit; the grips
 * deepen towards the bottom; thin blue light strips beside the screen. No logos: plain shapes on
 * the buttons.
 */
export const views = {
  hero: { azimuth: 28, elevation: 17 },
};

export function build(kit) {
  const { clay, glass, glow, hollow, colors } = kit;
  const SCREEN = [177.1, 99.6]; // 8" at 16:9
  const PANEL = [204, 116]; // the screen unit
  const EDGE = PANEL[0] / 2; // where the controller halves begin
  const X = 150, TOP = 58, LOW = -60; // outer edge, top and bottom of a half
  const D = 20; // thickness of a half at the top
  const FW = 8.5, FB = 6.9, FS = 5; // front surfaces: white shell, black core, screen unit
  const SWELL = 24; // how much deeper the grips are at the bottom
  const STICK = [114, -22], FACE = [132, 23];
  const BLUE = '#2f7bff';

  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const white = clay(colors.white);
  const core = clay(colors.black);
  const key = clay('#d6d7d5', { finish: 'satin' }); // light grey buttons on the white shell
  const trim = clay(colors.graphite, { finish: 'satin' });
  const rubber = clay(colors.jet, { finish: 'soft' });
  const light = glow(BLUE, 3);
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));
  const both = (geometry, material, at) => { const right = kit.mesh(geometry, material, { at }); parts.push(right, kit.mirrorX(right)); };

  // ── screen unit: black front, white back ─────────────────────────────────
  add(kit.slab(kit.rect(PANEL[0], PANEL[1], 6), 6.5, { bevel: 1.6, bevelBack: 0.2 }), core, [0, 0, FS - 3.25]);
  add(kit.slab(kit.rect(PANEL[0] - 1.2, PANEL[1] - 1.2, 5.4), 6.5, { bevel: 0.2, bevelBack: 2.4 }), white, [0, 0, FS - 9]);
  add(kit.slab(kit.rect(SCREEN[0], SCREEN[1], 2.6), 1.2, { bevel: 0.4 }), glass({ aspect: SCREEN[0] / SCREEN[1] }), [0, 0, FS - 0.25]);

  // ── controller halves (the right one; the left is its mirror) ────────────
  /** The grips go down and back: how far the back stands behind the top of the half at height y. */
  const grip = (front) => (p) => { p.z -= SWELL * smooth(46, -58, p.y) * Math.min(1, Math.max(0, (front - 4.5 - p.z) / (D - 4.5))); };
  // white shell: the top and the outside of the half. Its inner edge runs down beside the
  // screen, then steps out round the stick: two tangents of a circle of radius R about the
  // stick (at 45° and at 0°), so the rounded corner between them is an arc centred on it.
  const R = 13.5, K = R * Math.tan(Math.PI / 8);
  const shellOutline = kit.polygon(
    [[STICK[0] + R, LOW], [X - 9, LOW], [X - 0.5, -16], [X, 34], [X - 14, TOP], [STICK[0], TOP], [STICK[0], STICK[1] + K + R], [STICK[0] + R, STICK[1] + K]],
    [7, 10, 34, 24, 15, 4, 10, R],
    { edge: 14 },
  );
  both(kit.deform(kit.slab(shellOutline, D, { bevel: 4.5, bevelBack: 7, rings: 24 }), grip(D / 2)), white, [0, 0, FW - D / 2]);
  // black core: the band beside the screen, the stick well and the inside of the grip; it
  // reaches M mm under the shell
  const M = 4, MK = M * (Math.SQRT2 - 1);
  const coreOutline = kit.polygon(
    [[EDGE - 3, TOP - 1], [EDGE - 3, -38], [EDGE + 5, -46], [EDGE + 16, LOW], [STICK[0] + R + M, LOW], [STICK[0] + R + M, STICK[1] + K + MK], [STICK[0] + M, STICK[1] + K + R + MK], [STICK[0] + M, TOP - 1]],
    [3, 6, 8, 7, 4, 4, 4, 3],
    { edge: 14 },
  );
  both(kit.deform(kit.slab(coreOutline, D - 3, { bevel: 2.6, bevelBack: 5, rings: 24 }), grip((D - 3) / 2)), core, [0, 0, FB - (D - 3) / 2]);

  // ── sticks, in the black core ────────────────────────────────────────────
  const cap = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]]
    .map(([r, y]) => [r * 0.88, y]);
  const stick = (x, y) => parts.push(kit.group([
    kit.mesh(kit.ring(9.8, 7.5, 0.9, { bevel: 0.3, axis: 'z' }), trim),
    kit.mesh(kit.puck(7.6, 0.3, { bevel: 0, axis: 'z' }), dark),
    kit.mesh(kit.puck(4.1, 3.6, { bevel: 0.3, axis: 'z' }), rubber),
    kit.mesh(kit.lathe(cap, { axis: 'z' }), rubber),
  ], { at: [x, y, FB] }));
  stick(-STICK[0], STICK[1]);
  stick(STICK[0], STICK[1]);

  // ── direction pad (four separate petals) and face buttons ────────────────
  const petal = kit.polygon([[-3.4, 10.6], [-3.4, 5.2], [0, 2.2], [3.4, 5.2], [3.4, 10.6]], [1.5, 1.1, 1.1, 1.1, 1.5]);
  for (const turn of [0, 90, 180, 270]) add(kit.slab(petal.rotate(turn), 1.8, { bevel: 0.6 }), key, [-FACE[0], FACE[1], FW + 0.35]);
  const round = kit.puck(4.4, 1.6, { bevel: 0.75, top: 0.3, axis: 'z' });
  for (const [dx, dy] of [[0, 9.8], [9.8, 0], [0, -9.8], [-9.8, 0]]) add(round, key, [FACE[0] + dx, FACE[1] + dy, FW - 0.25]);

  // ── on the black band: two small buttons, a light strip, a round button ──
  const pill = kit.slab(kit.pill(3, 7.6), 1.3, { bevel: 0.45 });
  both(pill, key, [EDGE + 8, 45, FB + 0.2]);
  both(kit.slab(kit.pill(1.5, 30), 1, { bevel: 0.3 }), light, [EDGE + 3.6, 22, FB + 0.15]);
  both(kit.puck(2.7, 1.1, { bevel: 0.45, axis: 'z' }), trim, [EDGE + 11.5, -44, FB - 0.2]);
  for (const side of [-1, 1]) parts.push(kit.accentLight(BLUE, 0.8, 30).translateX(side * (EDGE + 3.6)).translateY(22).translateZ(FB + 5));

  // ── bumpers: a bar along the top that bends down the shoulder; triggers behind ──
  const A = [X - 14, TOP], B = [X, 34];
  const length = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const along = [(B[0] - A[0]) / length, (B[1] - A[1]) / length], out = [-along[1], along[0]];
  // where a line `d` mm outside the top edge meets the line `d` mm outside the shoulder
  const corner = (d) => { const t = (TOP + d - (A[1] + out[1] * d)) / along[1]; return [A[0] + out[0] * d + along[0] * t, TOP + d]; };
  const down = (d, reach) => [A[0] + along[0] * reach + out[0] * d, A[1] + along[1] * reach + out[1] * d];
  const bumper = kit.polygon([[EDGE + 5, TOP - 3], corner(-3), down(-3, 13), down(1.2, 13), corner(1.2), [EDGE + 5, TOP + 1.2]], [1.5, 9, 1.5, 1.5, 12, 1.5], { segments: 6 });
  both(kit.extrude(bumper, 8.6, { bevel: 1.5 }), core, [0, 0, FW - 9]);
  both(kit.slab(kit.rect(30, 24, [9, 9, 5, 5]), 12, { bevel: 4, dome: 1.6, axis: '-z' }), core, [X - 20.5, TOP - 15, FW - D - 3]);

  // ── top edge of the screen unit: power and volume ────────────────────────
  add(kit.slab(kit.pill(9, 3), 1.3, { bevel: 0.4, axis: 'y' }), trim, [-72, PANEL[1] / 2 - 0.2, FS - 3]);
  add(kit.slab(kit.pill(17, 3), 1.3, { bevel: 0.4, axis: 'y' }), trim, [-52, PANEL[1] / 2 - 0.2, FS - 3]);

  // ── back of the screen unit: a vent strip ────────────────────────────────
  parts.push(kit.vents(kit.grid(28, 2, 4.6, 4.2), { size: [3.2, 1.6], material: dark, at: [0, 30, FS - 12.25], rot: [0, 180, 0] }));

  return kit.group(parts);
}
