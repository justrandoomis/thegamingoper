/**
 * steam-deck-oled — 298 × 117 × 49 mm.
 * Black handheld PC: 7.4-inch screen, a thumbstick on each side of it, d-pad and face buttons in
 * the top corners, two square trackpads below, deep grips at the back, an orange power button on
 * the top edge. No logos: plain shapes on the buttons.
 */
export const views = {
  hero: { azimuth: 28, elevation: 17 },
};

export function build(kit) {
  const { clay, glass, hollow, colors } = kit;
  const W = 298, H = 117;
  const D = 21, F = D / 2; // the slab between the grips; F: the front surface
  const GRIP = 21; // how much deeper the grips are than the middle
  const TOP = H / 2, LOW = -H / 2, WAIST = LOW + 5.5; // the bottom edge rises between the grips
  const CORNER = 26; // top corners
  const SCREEN = [159.4, 99.6], SCREEN_Y = (TOP + WAIST) / 2; // 7.4" at 16:10
  const STICK = [100, 31], PADS = [127.5, 26], TRACK = [113, -17.5];

  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const shell = clay(colors.black);
  const key = clay(colors.graphite); // a shade lighter than the shell so the controls read
  const pad = clay(colors.graphite, { finish: 'satin' });
  const rubber = clay(colors.jet, { finish: 'soft' });
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── body: one slab whose back swells into a grip at each end ─────────────
  const outline = kit.polygon(
    [[-W / 2, TOP], [-W / 2, LOW], [-104, LOW], [-86, WAIST], [86, WAIST], [104, LOW], [W / 2, LOW], [W / 2, TOP]],
    [CORNER, 32, 12, 16, 16, 12, 32, CORNER],
    { edge: 48 }, // finely cut, so the back bends cleanly
  );
  /** How far the back stands behind the middle of the slab at (x, y). */
  const swell = (x, y) => GRIP * smooth(72, 124, Math.abs(x)) * (1 - 0.45 * smooth(0, TOP, y));
  add(kit.deform(
    kit.slab(outline, D, { bevel: 3.4, bevelBack: 7.5, rings: 30 }),
    (p) => { p.z -= swell(p.x, p.y) * Math.min(1, Math.max(0, (F - 3.4 - p.z) / (D - 3.4))); },
  ), shell, [0, 0, 0]);
  add(kit.slab(kit.rect(SCREEN[0], SCREEN[1], 3), 1.2, { bevel: 0.4 }), glass({ aspect: SCREEN[0] / SCREEN[1] }), [0, SCREEN_Y, F - 0.25]);

  // ── sticks ───────────────────────────────────────────────────────────────
  const cap = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]]
    .map(([r, y]) => [r * 1.03, y + 1.5]);
  const stick = (x, y) => parts.push(kit.group([
    kit.mesh(kit.ring(11.8, 9.2, 1, { bevel: 0.35, axis: 'z' }), key),
    kit.mesh(kit.puck(9.3, 0.3, { bevel: 0, axis: 'z' }), dark),
    kit.mesh(kit.puck(4.7, 5.2, { bevel: 0.3, axis: 'z' }), rubber),
    kit.mesh(kit.lathe(cap, { axis: 'z' }), rubber),
  ], { at: [x, y, F] }));
  stick(-STICK[0], STICK[1]);
  stick(STICK[0], STICK[1]);

  // ── d-pad, face buttons, trackpads, small buttons ────────────────────────
  add(kit.slab(kit.plus(21.5, 7.6, 1.5), 2.4, { bevel: 0.9, dome: 0.4 }), key, [-PADS[0], PADS[1], F + 0.4]);
  const round = kit.puck(4, 1.6, { bevel: 0.75, top: 0.3, axis: 'z' });
  for (const [dx, dy] of [[0, 8.3], [8.3, 0], [0, -8.3], [-8.3, 0]]) add(round, key, [PADS[0] + dx, PADS[1] + dy, F - 0.25]);
  const track = kit.slab(kit.rect(32.5, 32.5, 5), 1.4, { bevel: 0.5 });
  add(track, pad, [-TRACK[0], TRACK[1], F - 0.3]);
  add(track, pad, [TRACK[0], TRACK[1], F - 0.3]);
  const small = kit.slab(kit.pill(6.6, 3.4), 1.4, { bevel: 0.45 });
  add(small, key, [-114.5, 45, F + 0.2]); // view
  add(small, key, [114.5, 45, F + 0.2]); // menu
  const wide = kit.slab(kit.rect(9.6, 5, 1.8), 1.4, { bevel: 0.45 });
  add(wide, key, [-92, -43.5, F + 0.2]); // system button
  add(wide, key, [92, -43.5, F + 0.2]); // quick access

  // ── bumpers and triggers: two stepped bars round each top corner ─────────
  const CX = W / 2 - CORNER, CY = TOP - CORNER;
  const cornerBar = (inner, outer, from, toAngle) => {
    const bar = [];
    const arc = (radius, a0, a1) => { for (let a = a0; a0 < a1 ? a <= a1 : a >= a1; a += a0 < a1 ? 5 : -5) bar.push([CX + radius * Math.cos((a * Math.PI) / 180), CY + radius * Math.sin((a * Math.PI) / 180)]); };
    bar.push([from, CY + inner]);
    arc(inner, 90, toAngle);
    const turn = bar.length;
    arc(outer, toAngle, 90);
    bar.push([from, CY + outer]);
    return kit.polygon(bar, bar.map((_, i) => (i === 0 || i === bar.length - 1 || i === turn - 1 || i === turn ? 1.4 : 0)), { segments: 4 });
  };
  const bumper = cornerBar(CORNER - 4, CORNER + 0.9, 88, 25);
  const trigger = cornerBar(CORNER - 5, CORNER + 2.8, 98, 35);
  for (const side of [bumper, bumper.mirror()]) add(kit.extrude(side, 8.4, { bevel: 1.2 }), key, [0, 0, 2.4]);
  for (const side of [trigger, trigger.mirror()]) add(kit.extrude(side, 13, { bevel: 1.8 }), key, [0, 0, -9.6]);

  // ── top edge: volume, headphones, vent, port, orange power button ────────
  add(kit.slab(kit.pill(9, 3.2), 1.4, { bevel: 0.45, axis: 'y' }), key, [-62, TOP - 0.2, 0]);
  add(kit.slab(kit.pill(9, 3.2), 1.4, { bevel: 0.45, axis: 'y' }), key, [-50, TOP - 0.2, 0]);
  parts.push(kit.vents([[0, 0]], { radius: 2, material: dark, at: [-32, TOP, 0], rot: [-90, 0, 0] })); // headphones
  parts.push(kit.vents(kit.grid(14, 1, 3.5), { size: [1.8, 8], material: dark, at: [0, TOP, 0], rot: [-90, 0, 0] }));
  parts.push(kit.vents([[0, 0]], { size: [9.6, 3.6], material: dark, at: [36, TOP, 0], rot: [-90, 0, 0] })); // USB-C
  add(kit.slab(kit.pill(13, 4.8), 2, { bevel: 0.7, axis: 'y' }), clay(colors.orange, { finish: 'satin' }), [58, TOP + 0.1, 0]);

  // ── back: intake slots between the grips ─────────────────────────────────
  parts.push(kit.vents(kit.grid(12, 5, 5.2, 4.2), { size: [3.6, 1.8], material: dark, at: [0, 8, -F], rot: [0, 180, 0] }));

  return kit.group(parts);
}
