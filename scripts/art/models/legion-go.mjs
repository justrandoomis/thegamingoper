/**
 * legion-go — 299 × 131 × 40.7 mm.
 * Dark grey handheld PC: a big tablet with an 8.8-inch screen, a detachable controller on each
 * side (visible seams, deep grips), a small trackpad under the right stick and a wide kickstand
 * folded flat on the back. No logos: plain shapes on the buttons.
 */
export const views = {
  hero: { azimuth: 28, elevation: 17 },
};

export function build(kit) {
  const { clay, glass, hollow, colors } = kit;
  const W = 299, H = 131;
  const D = 19, F = D / 2; // tablet thickness; F: the front surface
  const GRIP = 15; // how much deeper the controllers are at the back
  const TABLET = 210, SEAM = TABLET / 2;
  const GAP = 1.6; // the slit between tablet and controller, over a dark rail
  const CON = W / 2 - SEAM - GAP; // width of a controller
  const PAD = SEAM + GAP + CON / 2; // middle of a controller
  const CH = H - 3; // the controllers are a touch shorter than the tablet
  const SCREEN = [189.5, 118.4]; // 8.8" at 16:10

  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  // dark grey, a step lighter than the kit's graphite so it does not read as a black handheld
  const shell = clay(new kit.THREE.Color(colors.graphite).lerp(new kit.THREE.Color(colors.slate), 0.4));
  const key = clay(colors.black, { finish: 'satin' }); // darker than the shell, as on the real unit
  const trim = clay(colors.slate, { finish: 'satin' });
  const rubber = clay(colors.jet, { finish: 'soft' });
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── tablet ───────────────────────────────────────────────────────────────
  add(kit.slab(kit.rect(TABLET, H, 5), D, { bevel: 2.4 }), shell, [0, 0, 0]);
  add(kit.slab(kit.rect(SCREEN[0], SCREEN[1], 3), 1.2, { bevel: 0.4 }), glass({ aspect: SCREEN[0] / SCREEN[1] }), [0, 0, F - 0.25]);

  // ── controllers: same face as the tablet, the back swells into a grip ────
  /** How far the back of a controller stands behind the tablet's back at (x, y), x from its middle. */
  const swell = (x, y) => GRIP * smooth(-CON / 2 + 2, 4, x) * (1 - 0.4 * smooth(0, CH / 2, y));
  const controller = kit.mesh(kit.deform(
    kit.slab(kit.rect(CON, CH, [3, 17, 21, 3], { edge: 14 }), D, { bevel: 3, bevelBack: 6, rings: 22 }),
    (p) => { p.z -= swell(p.x, p.y) * Math.min(1, Math.max(0, (F - 3 - p.z) / (D - 3))); },
  ), shell, { at: [PAD, 0, 0] });
  parts.push(controller, kit.mirrorX(controller));
  const rail = kit.slab(kit.rect(D - 4.4, CH - 8, 2), GAP + 2, { bevel: 0.3, axis: 'x' });
  add(rail, rubber, [SEAM + GAP / 2, 0, 0]);
  add(rail, rubber, [-SEAM - GAP / 2, 0, 0]);

  // ── sticks ───────────────────────────────────────────────────────────────
  const cap = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]]
    .map(([r, y]) => [r, y + 0.8]);
  const stick = (x, y) => parts.push(kit.group([
    kit.mesh(kit.ring(12, 9.4, 1, { bevel: 0.35, axis: 'z' }), trim),
    kit.mesh(kit.puck(9.5, 0.3, { bevel: 0, axis: 'z' }), dark),
    kit.mesh(kit.puck(4.6, 4.4, { bevel: 0.3, axis: 'z' }), rubber),
    kit.mesh(kit.lathe(cap, { axis: 'z' }), rubber),
  ], { at: [x, y, F] }));
  stick(-PAD, 29);
  stick(PAD, -6);

  // ── d-pad, face buttons, trackpad, small buttons ─────────────────────────
  add(kit.puck(12.6, 1.2, { bevel: 0.5, top: -0.3, axis: 'z' }), key, [-PAD, -9, F - 0.2]);
  add(kit.slab(kit.plus(19.5, 6.8, 1.3), 1.6, { bevel: 0.7, dome: 0.3 }), trim, [-PAD, -9, F + 1.4]);
  const round = kit.puck(4.2, 1.6, { bevel: 0.75, top: 0.3, axis: 'z' });
  for (const [dx, dy] of [[0, 8.6], [8.6, 0], [0, -8.6], [-8.6, 0]]) add(round, key, [PAD + dx, 31 + dy, F - 0.25]);
  add(kit.slab(kit.rect(22, 22, 4), 1.4, { bevel: 0.5 }), key, [PAD, -40, F - 0.3]); // trackpad
  const small = kit.slab(kit.pill(6.4, 3.4), 1.4, { bevel: 0.45 });
  for (const side of [-1, 1]) for (const dx of [-9.5, 3]) add(small, key, [side * (PAD + dx), 54, F + 0.2]);
  for (const dy of [-37, -46]) add(small, key, [-(PAD - 4), dy, F + 0.2]);

  // ── bumpers and triggers on each controller ──────────────────────────────
  const CTOP = CH / 2;
  const bumper = kit.slab(kit.rect(30, 8, [3, 5, 3, 3]), 4.4, { bevel: 1.3, axis: 'y' });
  const trigger = kit.slab(kit.rect(26, 12, [4, 6, 4, 4]), 7, { bevel: 2.2, dome: 0.8, axis: 'y' });
  for (const side of [-1, 1]) {
    parts.push(kit.mesh(bumper, key, { at: [side * (PAD - 2.5), CTOP - 0.9, 3.4], scale: [side, 1, 1] }));
    parts.push(kit.mesh(trigger, key, { at: [side * (PAD - 1), CTOP - 1.2, -8.6], scale: [side, 1, 1] }));
  }

  // ── top edge of the tablet: vent, power, volume, port ────────────────────
  const TOP = H / 2;
  parts.push(kit.vents(kit.grid(22, 1, 3.5), { size: [1.8, 7.4], material: dark, at: [-8, TOP, 0], rot: [-90, 0, 0] }));
  add(kit.slab(kit.pill(10, 3.4), 1.4, { bevel: 0.45, axis: 'y' }), key, [-78, TOP - 0.2, 0]); // power
  add(kit.slab(kit.pill(20, 3.4), 1.4, { bevel: 0.45, axis: 'y' }), key, [62, TOP - 0.2, 0]); // volume
  parts.push(kit.vents([[0, 0]], { size: [9.4, 3.4], material: dark, at: [86, TOP, 0], rot: [-90, 0, 0] })); // USB-C

  // ── back: the wide kickstand, folded flat, with its hinge ────────────────
  add(kit.slab(kit.rect(TABLET - 16, 66, [2, 2, 6, 6]), 1.3, { bevel: 0.45, axis: '-z' }), trim, [0, -27, -F - 0.15]);
  add(kit.capsule(1.5, TABLET - 30, { axis: 'x' }), key, [0, 6.4, -F - 0.1]);
  parts.push(kit.vents(kit.grid(26, 4, 5.4, 4.4), { size: [3.6, 1.7], material: dark, at: [0, 34, -F], rot: [0, 180, 0] }));

  return kit.group(parts);
}
