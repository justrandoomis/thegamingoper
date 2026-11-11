/**
 * ps5-slim — 96 × 358 × 216 mm, standing vertically.
 * Two white curved side plates, each split by a horizontal seam into an upper and a lower panel;
 * a glossy black core between them; a blue accent light along the inner edge near the top;
 * a slim disc slot on the front. No logos.
 */
export const views = {
  hero: { azimuth: -32, elevation: 15 }, // from the left, so the key light falls on the big plate
  back: { azimuth: 148, elevation: 15 },
};

export function build(kit) {
  const { clay, gloss, glow, hollow, colors } = kit;
  const H = 358, HALF_DEPTH = 108; // plates: z from −108 (back) to +108 (front)
  const T = 5.5; // plate thickness
  const SEAM = 224, GAP = 2.4; // height of the seam between upper and lower panel
  const NOSE = 102; // front of the glossy spine
  const SPINE = 19; // its half width

  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const rise = (y) => smooth(40, H, y); // 0 at the foot … 1 at the collar
  const curl = (y) => smooth(290, H, y) ** 2; // the collar curling outwards at the very top
  const tuck = (y) => 1 - smooth(0, 120, y); // the foot tucking in
  /**
   * Outer surface of the right-hand plate. Seen from above it is a shell: it wraps round the
   * front of the console like a lip, is widest amidships and eases in towards the back.
   */
  const plateX = (y, z) => {
    const zn = z / HALF_DEPTH;
    const flare = 0.4 + 0.6 * smooth(-0.9, 0.5, zn); // the collar opens more towards the front
    return 44 + 1.5 * rise(y) + 2.5 * curl(y) * flare - 2.2 * tuck(y) - (zn > 0 ? 20 * zn ** 4 : 8 * zn ** 2);
  };
  /** Front edge of a plate: a shallow bow, furthest forward at mid height. */
  const frontEdge = (y) => 103.5 + 4.5 * Math.sin(Math.PI * (0.08 + (0.84 * y) / H));
  const TOP_FRONT = H, TOP_BACK = 345; // the top edge falls towards the back
  const topLine = (z) => TOP_BACK + ((TOP_FRONT - TOP_BACK) * (z + HALF_DEPTH)) / (2 * HALF_DEPTH);

  // Side profiles are drawn as [z, y] and face +X; the left-hand copy is a mirror.
  const profile = (zy, radii, edge = 1) => kit.polygon(zy.map(([z, y]) => [-z, y]), radii, { segments: 10, edge });
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));
  const both = (geometry, material) => { const right = kit.mesh(geometry, material); parts.push(right, kit.mirrorX(right)); };

  const white = clay(colors.white);
  const whiteSatin = clay(colors.white, { finish: 'satin' });
  const piano = gloss(colors.jet, { roughness: 0.14 });
  const matte = clay('#141518', { finish: 'soft' });
  const trim = clay(colors.graphite, { finish: 'satin' });
  const light = glow('#2f7bff', 3.2);

  // ── plates ───────────────────────────────────────────────────────────────
  const panel = (yFrom, yTo, corners) => {
    const zy = [[-HALF_DEPTH, yFrom], [frontEdge(yFrom), yFrom]], radii = [corners[0], corners[1]];
    for (let y = Math.ceil((yFrom + 12) / 16) * 16; y < yTo - 12; y += 16) { zy.push([frontEdge(y), y]); radii.push(0); }
    zy.push([frontEdge(yTo), yTo], [-HALF_DEPTH, corners[4] ?? yTo]);
    radii.push(corners[2], corners[3]);
    return kit.deform(
      kit.slab(profile(zy, radii, 10), T, { bevel: 2.3, rings: 26, axis: 'x' }),
      (p) => { p.x += plateX(p.y, p.z) - T / 2; },
    );
  };
  both(panel(0, SEAM - GAP / 2, [16, 14, 1.6, 1.6]), white);
  both(panel(SEAM + GAP / 2, TOP_FRONT, [1.6, 1.6, 24, 38, TOP_BACK]), whiteSatin);

  // ── core ─────────────────────────────────────────────────────────────────
  // matte body filling the shell (it shows in the seams, in the gaps beside the spine and at the back)
  add(kit.deform(
    kit.slab(profile([[-101, 3], [94, 3], [94, 330], [-101, 330]], 6, 12), 60, { bevel: 3, rings: 18, axis: 'x' }),
    (p) => { p.x *= (plateX(p.y, p.z) - T - 1) / 30; },
  ), matte);
  // glossy spine: the strip you see from the front and from above
  add(kit.deform(
    kit.slab(profile([[-96, 2], [NOSE, 2], [NOSE, 338], [-96, 338]], [6, 6, 13, 10], 6), 2 * SPINE, { bevel: 6.5, rings: 12, axis: 'x' }),
    (p) => { p.x *= 1 + 0.06 * rise(p.y); },
  ), piano);

  // ── front: disc slot, buttons, ports ─────────────────────────────────────
  add(kit.slab(kit.pill(5.4, 130), 0.9, { bevel: 0.3 }), trim, [5, 128, NOSE + 0.2]);
  parts.push(kit.vents([[0, 0]], { size: [2.1, 123], at: [5, 128, NOSE + 0.65] }));
  add(kit.slab(kit.pill(2.6, 9), 1, { bevel: 0.35 }), trim, [-7, 70, NOSE + 0.2]); // eject
  add(kit.slab(kit.pill(2.6, 9), 1, { bevel: 0.35 }), trim, [-7, 54, NOSE + 0.2]); // power
  parts.push(kit.vents([[0, 0], [0, 17]], { size: [3.4, 8.6], material: hollow('#2b2d33'), at: [-7, 236, NOSE] })); // USB-C
  const fins = kit.grid(1, 50, 1, 5.6);
  parts.push(kit.vents(fins, { size: [4.4, 1.9], at: [-23.6, 176, 94] }));
  parts.push(kit.vents(fins, { size: [4.4, 1.9], at: [23.6, 176, 94] }));

  // ── blue accent light: inside each collar and down the gap beside the spine ──
  const strip = (zy) => kit.deform(
    kit.slab(profile(zy, 1, 6), 1.2, { bevel: 0.4, rings: 4, axis: 'x' }),
    (p) => { p.x += plateX(p.y, p.z) - T - 0.5; },
  );
  both(strip([[-40, topLine(-40) - 15], [84, topLine(84) - 15], [84, topLine(84) - 12], [-40, topLine(-40) - 12]]), light);
  const bar = kit.box(2, 84, 2.4, 0.9);
  add(bar, light, [21.6, 292, 99.6]);
  add(bar, light, [-21.6, 292, 99.6]);
  for (const z of [80, 24, -30]) parts.push(kit.accentLight('#2f7bff', 1.1, 80).translateY(340).translateZ(z));

  // ── back: vent field and ports ───────────────────────────────────────────
  const BACK = -101;
  parts.push(kit.vents(kit.grid(7, 22, 6.4, 9, { stagger: true }), { size: [4.4, 2.6], at: [-1.6, 208, BACK], rot: [0, 180, 0] }));
  const port = (x, y, w, h) => {
    add(kit.slab(kit.rect(w + 3.4, h + 3.4, 2.4), 0.9, { bevel: 0.3, axis: '-z' }), trim, [x, y, BACK - 0.25]);
    parts.push(kit.vents([[0, 0]], { size: [w, h], at: [x, y, BACK - 0.7], rot: [0, 180, 0] }));
  };
  port(11, 30, 15, 10); // power
  port(-10, 30, 13, 11); // network
  port(11, 50, 15, 6); // display
  port(-10, 48, 13, 5.6); // USB
  port(-10, 60, 13, 5.6); // USB

  return kit.group(parts);
}
