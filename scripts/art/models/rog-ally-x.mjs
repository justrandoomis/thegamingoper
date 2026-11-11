/**
 * rog-ally-x — 280 × 111 × 36.9 mm.
 * Black handheld PC: 7-inch screen, an angular shell with chamfered corners and angular grips,
 * offset sticks with ring lights, a round d-pad, slanted speaker slots. The ring lights use the
 * catalogue's handheld colour. No logos: plain shapes on the buttons.
 */
export const views = {
  hero: { azimuth: 28, elevation: 17 },
};

export function build(kit, options) {
  const { clay, glass, glow, hollow, colors } = kit;
  const W = 280, H = 111;
  const D = 19, F = D / 2; // the slab between the grips; F: the front surface
  const GRIP = 13; // how much deeper the grips are than the middle
  const TOP = H / 2, LOW = -H / 2;
  const CUT = [20, 21], CUT_LOW = [15, 19]; // the chamfers: [along x, along y]
  const SCREEN = [155, 87.2]; // 7" at 16:9
  const LIGHT = options?.platformColors?.handheld ?? colors.violet;

  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const shell = clay(colors.black);
  const key = clay(colors.graphite); // a shade lighter than the shell so the controls read
  const rubber = clay(colors.jet, { finish: 'soft' });
  const ringLight = glow(LIGHT, 1.3); // low enough to keep the colour: brighter washes out to lavender
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── body: an eight-sided slab whose back steps out into a grip at each end ──
  const X = W / 2;
  const outline = kit.polygon(
    [[-X, TOP - CUT[1]], [-X, LOW + CUT_LOW[1]], [-X + CUT_LOW[0], LOW], [X - CUT_LOW[0], LOW], [X, LOW + CUT_LOW[1]], [X, TOP - CUT[1]], [X - CUT[0], TOP], [-X + CUT[0], TOP]],
    [8, 11, 12, 12, 11, 8, 8, 8],
    { edge: 64 }, // finely cut, so the step below bends cleanly
  );
  /** How far the back stands behind the middle of the slab at (x, y): a steep, flat-topped step. */
  const swell = (x, y) => GRIP * smooth(84, 110, Math.abs(x)) * (1 - 0.35 * smooth(8, TOP, y));
  add(kit.deform(
    kit.slab(outline, D, { bevel: 2.8, bevelBack: 5, rings: 30 }),
    (p) => { p.z -= swell(p.x, p.y) * Math.min(1, Math.max(0, (F - 2.8 - p.z) / (D - 2.8))); },
  ), shell, [0, 0, 0]);
  add(kit.slab(kit.rect(SCREEN[0], SCREEN[1], 2.6), 1.2, { bevel: 0.4 }), glass({ aspect: SCREEN[0] / SCREEN[1] }), [0, 1, F - 0.25]);

  // ── sticks, each in a lit ring ───────────────────────────────────────────
  const cap = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]]
    .map(([r, y]) => [r, y + 0.6]);
  const stick = (x, y) => {
    parts.push(kit.group([
      kit.mesh(kit.ring(12.6, 10.2, 0.9, { bevel: 0.3, axis: 'z' }), ringLight),
      kit.mesh(kit.puck(10.3, 0.4, { bevel: 0, axis: 'z' }), dark),
      kit.mesh(kit.puck(4.5, 4.2, { bevel: 0.3, axis: 'z' }), rubber),
      kit.mesh(kit.lathe(cap, { axis: 'z' }), rubber),
    ], { at: [x, y, F] }));
    parts.push(kit.accentLight(LIGHT, 0.7, 34).translateX(x).translateY(y).translateZ(F + 5));
  };
  stick(-110, 21);
  stick(103, -16);

  // ── round d-pad, face buttons, small buttons ─────────────────────────────
  add(kit.puck(12.4, 1.3, { bevel: 0.5, top: -0.3, axis: 'z' }), key, [-103, -17, F - 0.2]);
  add(kit.slab(kit.plus(19, 6.6, 1.3), 1.6, { bevel: 0.7, dome: 0.3 }), clay(colors.slate), [-103, -17, F + 1.5]);
  const round = kit.puck(4.3, 1.6, { bevel: 0.75, top: 0.3, axis: 'z' });
  for (const [dx, dy] of [[0, 8.8], [8.8, 0], [0, -8.8], [-8.8, 0]]) add(round, key, [110 + dx, 22 + dy, F - 0.25]);
  const small = kit.slab(kit.rect(6, 4.2, 1.5), 1.4, { bevel: 0.45 });
  for (const x of [-89, 89]) for (const y of [41, 30]) add(small, key, [x, y, F + 0.2]);

  // ── speakers: slanted slots in the bottom corners of the face ────────────
  const slots = (side) => kit.grid(6, 1, 4.2).map(([x, y]) => [x, y, 0, side * 62]);
  parts.push(kit.vents(slots(1), { size: [9, 1.7], material: dark, at: [-93, -40, F] }));
  parts.push(kit.vents(slots(-1), { size: [9, 1.7], material: dark, at: [93, -40, F] }));

  // ── bumpers and triggers: bars along each chamfered top corner ───────────
  const A = [X - CUT[0], TOP], B = [X, TOP - CUT[1]];
  const length = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const along = [(B[0] - A[0]) / length, (B[1] - A[1]) / length], out = [-along[1], along[0]];
  /** A bar lying on the top edge from x = `from`, bent down the chamfer for `reach` mm. */
  const cornerBar = (inset, outset, from, reach) => {
    // where a line `d` mm outside the top edge meets the line `d` mm outside the chamfer
    const corner = (d) => { const t = (TOP + d - (A[1] + out[1] * d)) / along[1]; return [A[0] + out[0] * d + along[0] * t, TOP + d]; };
    const down = (d) => [A[0] + along[0] * reach + out[0] * d, A[1] + along[1] * reach + out[1] * d];
    return kit.polygon([[from, TOP - inset], corner(-inset), down(-inset), down(outset), corner(outset), [from, TOP + outset]], [1.4, 4, 1.4, 1.4, 6, 1.4], { segments: 5 });
  };
  const bumper = cornerBar(3.4, 0.9, 92, 22);
  const trigger = cornerBar(4.2, 2.6, 101, 17);
  for (const side of [bumper, bumper.mirror()]) add(kit.extrude(side, 7.6, { bevel: 1.2 }), key, [0, 0, 2.2]);
  for (const side of [trigger, trigger.mirror()]) add(kit.extrude(side, 11, { bevel: 1.7 }), key, [0, 0, -8.2]);

  // ── top edge: two vents, power, volume, ports ────────────────────────────
  parts.push(kit.vents(kit.grid(9, 1, 3.4), { size: [1.7, 7], material: dark, at: [-52, TOP, 0], rot: [-90, 0, 0] }));
  parts.push(kit.vents(kit.grid(9, 1, 3.4), { size: [1.7, 7], material: dark, at: [-12, TOP, 0], rot: [-90, 0, 0] }));
  parts.push(kit.vents([[0, 0], [14, 0]], { size: [9.4, 3.4], material: dark, at: [20, TOP, 0], rot: [-90, 0, 0] })); // two USB-C
  add(kit.slab(kit.pill(17, 3), 1.4, { bevel: 0.45, axis: 'y' }), key, [56, TOP - 0.2, 0]); // volume
  add(kit.slab(kit.pill(9, 3.6), 1.4, { bevel: 0.45, axis: 'y' }), key, [76, TOP - 0.2, 0]); // power

  // ── back: intake slots ───────────────────────────────────────────────────
  parts.push(kit.vents(kit.grid(14, 4, 5, 4.2).map(([x, y]) => [x, y, 0, 62]), { size: [3.6, 1.6], material: dark, at: [0, 10, -F], rot: [0, 180, 0] }));

  return kit.group(parts);
}
