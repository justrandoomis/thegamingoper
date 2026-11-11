/**
 * switch-2-dock — 201 × 115 × 51 mm.
 * Black dock with rounded corners and an open slot on top: a thin front plate and a thicker back
 * block joined at the foot, with the slot open at both ends (the controllers of the docked
 * console overhang the dock). One moulded piece — the side profile drawn across the width, then
 * its corners rounded as seen from the front. A status light at the lower left of the front, two
 * ports on the left side, the cover and the cable notch at the back. No logos.
 */
export const views = { hero: { azimuth: 28, elevation: 19 } };

export function build(kit) {
  const { clay, hollow, metal, glow, colors } = kit;
  const W = 201, H = 115, D = 51, HALF = W / 2;
  const PLATE = 6.6; // thickness of the front plate
  const SLOT = 16.5; // the gap the console stands in
  const FLOOR = 23; // height of the slot floor
  const PLATE_TOP = 105; // the front plate is a little lower than the back block
  const FRONT = D / 2, BACK = -D / 2, INNER = FRONT - PLATE, BLOCK = INNER - SLOT; // z of the faces, front to back
  const CORNER = 19, FOOT = 8; // rounding of the top and bottom corners, seen from the front
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── body ─────────────────────────────────────────────────────────────────
  // Side profile as [z, y]; the outline faces +X, where its own x axis points to −Z.
  const profile = kit.polygon(
    [[BACK, 0], [FRONT, 0], [FRONT, PLATE_TOP], [INNER, PLATE_TOP], [INNER, FLOOR], [BLOCK, FLOOR], [BLOCK, H], [BACK, H]].map(([z, y]) => [-z, y]),
    [5, 5, 3.2, 3.2, 3.6, 3.6, 5, 9],
    { segments: 8 },
  );
  const quarter = (overhang, radius) => (overhang <= 0 ? 0 : radius - Math.sqrt(Math.max(radius * radius - overhang * overhang, 0)));
  const body = kit.deform(
    kit.extrude(profile, W, { bevel: 2.4, bevelSegments: 5, axis: 'x' }),
    (p) => {
      const UPPER = 42, LOWER = 16; // only what lies above / below these heights is moved
      if (p.y > UPPER) {
        const top = p.z > INNER - 1 ? PLATE_TOP : H;
        const drop = quarter(Math.abs(p.x) - (HALF - CORNER), CORNER);
        p.y = UPPER + ((p.y - UPPER) * (top - drop - UPPER)) / (top - UPPER);
      } else if (p.y < LOWER) {
        const rise = quarter(Math.abs(p.x) - (HALF - FOOT), FOOT);
        p.y = LOWER - ((LOWER - p.y) * (LOWER - rise)) / LOWER;
      }
    },
    { maxEdge: 3 },
  );
  add(body, clay(colors.black), [0, 0, 0]);

  // ── in the slot: the connector the console sits on ───────────────────────
  const slotZ = (INNER + BLOCK) / 2;
  add(kit.slab(kit.rect(15, 6.4, 1.6), 3.2, { bevel: 0.9, axis: 'y' }), clay(colors.graphite, { finish: 'satin' }), [0, FLOOR + 1.4, slotZ]);
  add(kit.slab(kit.rect(8.4, 2.5, 1.2), 5.2, { bevel: 0.6, axis: 'y' }), metal(colors.silver), [0, FLOOR + 3.6, slotZ]);

  // ── front: status light ──────────────────────────────────────────────────
  add(kit.puck(1.05, 0.6, { bevel: 0.25, axis: 'z' }), glow('#58e07a', 1.8), [-HALF + 17, 10.5, FRONT - 0.15]);

  // ── left side: two ports ─────────────────────────────────────────────────
  const key = clay(colors.graphite, { finish: 'satin' });
  for (const y of [40, 57]) {
    add(kit.slab(kit.rect(17, 9.4, 2.2), 0.9, { bevel: 0.3, axis: '-x' }), key, [-HALF + 0.2, y, -11]);
    parts.push(kit.vents([[0, 0]], { size: [13.2, 5.6], at: [-HALF - 0.25, y, -11], rot: [0, -90, 0] }));
  }

  // ── back: cover, vent slots, cable notch ─────────────────────────────────
  add(kit.slab(kit.rect(150, 70, 8), 1, { bevel: 0.4, axis: '-z' }), key, [0, 52, BACK + 0.25]);
  parts.push(kit.vents(kit.grid(12, 3, 5.2, 4.6), { size: [3.4, 1.7], at: [38, 66, BACK - 0.25], rot: [0, 180, 0] }));
  add(kit.slab(kit.rect(34, 13, [4, 4, 1, 1]), 1, { bevel: 0.3, axis: '-z' }), key, [0, 6.6, BACK + 0.25]);
  parts.push(kit.vents([[0, 0]], { size: [27, 7.4], material: hollow(), at: [0, 6, BACK - 0.25], rot: [0, 180, 0] }));

  return kit.group(parts);
}
