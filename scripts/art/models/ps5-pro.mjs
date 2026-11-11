/**
 * ps5-pro — 89 × 388 × 216 mm, standing vertically.
 * Same family as ps5-slim (the construction follows that model): two white curved side plates
 * around a glossy black core, a blue accent light along the inner edge near the top. Taller and
 * slimmer, each plate is cut through the middle by three black fins, and there is no disc slot
 * on the front. No logos.
 */
export const views = {
  hero: { azimuth: -32, elevation: 15 }, // from the left, so the key light falls on the big plate
};

export function build(kit) {
  const { clay, gloss, glow, hollow, colors } = kit;
  const H = 388, HALF_DEPTH = 108; // plates: z from −108 (back) to +108 (front)
  const T = 5.5; // plate thickness
  const SIDE = 41; // half width amidships, to the outside of a plate
  const NOSE = 102; // front of the glossy spine
  const SPINE = 17.5; // its half width
  const BAND = 211, SLIT = 7.8, STRIP = 8.6; // three black fins with two white strips between them
  const BAND_TOP = BAND + 3 * SLIT + 2 * STRIP;

  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const rise = (y) => smooth(40, H, y); // 0 at the foot … 1 at the collar
  const curl = (y) => smooth(H - 68, H, y) ** 2; // the collar curling outwards at the very top
  const tuck = (y) => 1 - smooth(0, 120, y); // the foot tucking in
  /**
   * Outer surface of the right-hand plate. Seen from above it is a shell: it wraps round the
   * front of the console like a lip, is widest amidships and eases in towards the back.
   */
  const plateX = (y, z) => {
    const zn = z / HALF_DEPTH;
    const flare = 0.4 + 0.6 * smooth(-0.9, 0.5, zn); // the collar opens more towards the front
    return SIDE + 1.5 * rise(y) + 2.5 * curl(y) * flare - 2.2 * tuck(y) - (zn > 0 ? 18.5 * zn ** 4 : 8 * zn ** 2);
  };
  /** Front edge of a plate: a shallow bow, furthest forward at mid height. */
  const frontEdge = (y) => 103.5 + 4.5 * Math.sin(Math.PI * (0.08 + (0.84 * y) / H));
  const TOP_FRONT = H, TOP_BACK = H - 13; // the top edge falls towards the back
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
      kit.slab(profile(zy, radii, 16), T, { bevel: 2.3, rings: 26, axis: 'x' }),
      (p) => { p.x += plateX(p.y, p.z) - T / 2; },
    );
  };
  /**
   * A long narrow piece of plate (a white strip or a black fin). A slab's fan of triangles would
   * twist along such a ribbon, so it is extruded, cut into small triangles (`maxEdge`: shared
   * edges are cut alike, so it stays a closed solid) and then bent. `sink` sets it below the
   * outer surface of the plates.
   */
  const ribbon = (yFrom, yTo, { sink = 0, thick = T, bevel = 2.3, corner = 1.4 } = {}) => kit.deform(
    kit.extrude(profile([[-HALF_DEPTH, yFrom], [frontEdge(yFrom), yFrom], [frontEdge(yTo), yTo], [-HALF_DEPTH, yTo]], corner), thick, { bevel, bevelSegments: 6, axis: 'x' }),
    (p) => { p.x += plateX(p.y, p.z) - sink - thick / 2; },
    { maxEdge: 3.5 },
  );
  both(panel(0, BAND, [16, 14, 1.6, 1.6]), white);
  both(panel(BAND_TOP, TOP_FRONT, [1.6, 1.6, 24, 38, TOP_BACK]), whiteSatin);
  for (let i = 0; i < 3; i++) {
    const y = BAND + i * (SLIT + STRIP);
    // a black fin lying in each cut, and a white strip above the first two
    both(ribbon(y - 2, y + SLIT + 2, { sink: 2.6, thick: 3, bevel: 0.6, corner: 1 }), matte);
    if (i < 2) both(ribbon(y + SLIT, y + SLIT + STRIP), white);
  }

  // ── core ─────────────────────────────────────────────────────────────────
  // matte body filling the shell (it shows in the gaps beside the spine and at the back)
  add(kit.deform(
    kit.slab(profile([[-101, 3], [94, 3], [94, H - 28], [-101, H - 28]], 6, 12), 60, { bevel: 3, rings: 18, axis: 'x' }),
    (p) => { p.x *= (plateX(p.y, p.z) - T - 1) / 30; },
  ), matte);
  // glossy spine: the strip you see from the front and from above
  add(kit.deform(
    kit.slab(profile([[-96, 2], [NOSE, 2], [NOSE, H - 20], [-96, H - 20]], [6, 6, 13, 10], 6), 2 * SPINE, { bevel: 6.5, bevelSegments: 12, rings: 12, axis: 'x' }),
    (p) => { p.x *= 1 + 0.06 * rise(p.y); },
  ), piano);

  // ── front: power button, two ports, vent fins beside the spine ───────────
  add(kit.slab(kit.pill(2.6, 9), 1, { bevel: 0.35 }), trim, [0, 58, NOSE + 0.2]); // power
  parts.push(kit.vents([[0, 0], [0, 17]], { size: [3.4, 8.6], material: hollow('#2b2d33'), at: [0, 84, NOSE] })); // USB-C
  const fins = kit.grid(1, 54, 1, 5.6);
  parts.push(kit.vents(fins, { size: [4.4, 1.9], at: [-(SPINE + 4.6), 192, 94] }));
  parts.push(kit.vents(fins, { size: [4.4, 1.9], at: [SPINE + 4.6, 192, 94] }));

  // ── blue accent light: inside each collar and down the gap beside the spine ──
  const strip = (zy) => kit.deform(
    kit.slab(profile(zy, 1, 6), 1.2, { bevel: 0.4, rings: 4, axis: 'x' }),
    (p) => { p.x += plateX(p.y, p.z) - T - 0.5; },
  );
  both(strip([[-40, topLine(-40) - 15], [84, topLine(84) - 15], [84, topLine(84) - 12], [-40, topLine(-40) - 12]]), light);
  const bar = kit.box(2, 84, 2.4, 0.9);
  add(bar, light, [SPINE + 2.6, H - 66, 99.6]);
  add(bar, light, [-(SPINE + 2.6), H - 66, 99.6]);
  for (const z of [80, 24, -30]) parts.push(kit.accentLight('#2f7bff', 1.1, 80).translateY(H - 18).translateZ(z));

  // ── back: vent field and ports ───────────────────────────────────────────
  const BACK = -101;
  parts.push(kit.vents(kit.grid(6, 24, 6.4, 9, { stagger: true }), { size: [4.4, 2.6], at: [-1.6, 226, BACK], rot: [0, 180, 0] }));
  const port = (x, y, w, h) => {
    add(kit.slab(kit.rect(w + 3.4, h + 3.4, 2.4), 0.9, { bevel: 0.3, axis: '-z' }), trim, [x, y, BACK - 0.25]);
    parts.push(kit.vents([[0, 0]], { size: [w, h], at: [x, y, BACK - 0.7], rot: [0, 180, 0] }));
  };
  port(9, 30, 13, 10); // power
  port(-9, 30, 12, 11); // network
  port(9, 50, 13, 6); // display
  port(-9, 48, 12, 5.6); // USB
  port(-9, 60, 12, 5.6); // USB

  return kit.group(parts);
}
