/**
 * xbox-expansion-card — 32 × 53 × 8 mm.
 * Small black storage expansion card with a ribbed cap. It stands on the cap, the way it would
 * sit on a desk: slim satin shell above, the connector mouth with its row of contacts on top,
 * and the wider rubbery cap with its grip ribs at the foot. No logos, no capacity print.
 */
export const views = { hero: { azimuth: 30, elevation: 20 } };

export function build(kit) {
  const { clay, metal, colors } = kit;
  const W = 32, H = 53, D = 8; // overall, measured over the ribs of the cap
  const CAP = 16.5; // height of the cap
  const RIB = 0.6; // how far the ribs stand off the cap
  const BODY = [29.8, 6]; // the shell is a little slimmer than the cap
  const parts = [];
  const add = (geometry, material, at) => parts.push(kit.mesh(geometry, material, { at }));

  // ── shell ────────────────────────────────────────────────────────────────
  const shell = clay(colors.black, { finish: 'satin' });
  const bodyH = H - CAP + 2;
  add(kit.slab(kit.rect(BODY[0], bodyH, 1.3), BODY[1], { bevel: 1.2, rings: 12 }), shell, [0, H - bodyH / 2, 0]);
  // a shallow panel pressed into the front, as on the real shell (left blank)
  add(kit.slab(kit.rect(21, 22, 1.6), 0.5, { bevel: 0.2, rings: 10 }), clay(colors.graphite, { finish: 'satin' }), [0, 36.5, BODY[1] / 2 - 0.3]);
  add(kit.slab(kit.rect(19.6, 20.6, 1.1), 0.5, { bevel: 0.15, rings: 10 }), shell, [0, 36.5, BODY[1] / 2 - 0.22]);

  // ── connector mouth on top ───────────────────────────────────────────────
  add(kit.slab(kit.rect(26.2, 4.4, 1.2), 0.9, { bevel: 0.3, axis: 'y' }), clay(colors.graphite, { finish: 'satin' }), [0, H - 0.3, 0]);
  parts.push(kit.vents([[0, 0]], { size: [23.4, 2.3], at: [0, H + 0.15, 0], rot: [-90, 0, 0] }));
  const contact = kit.slab(kit.rect(0.9, 1.1, 0.15), 0.3, { bevel: 0.08, axis: 'y' });
  parts.push(kit.stamp(contact, metal('#e2b24f'), kit.grid(13, 1, 1.6), { at: [0, H + 0.12, 0] }));

  // ── cap: wider, rubbery, ribbed ──────────────────────────────────────────
  const rubber = clay(colors.jet, { finish: 'soft' });
  add(kit.slab(kit.rect(W - 2 * RIB, CAP, [1.6, 1.6, 4.2, 4.2]), D - 2 * RIB, { bevel: 1.8 }), rubber, [0, CAP / 2, 0]);
  const rib = clay(colors.graphite, { finish: 'soft' });
  const THICK = 1.3; // a rib is this thick; RIB of it shows
  const ribFront = kit.slab(kit.pill(23.6, 1.75), THICK, { bevel: 0.6 });
  const ribSide = kit.slab(kit.pill(3.2, 1.75), THICK, { bevel: 0.6, axis: 'x' });
  for (const y of [3.9, 7.2, 10.5, 13.8]) {
    add(ribFront, rib, [0, y, D / 2 - THICK / 2]);
    add(ribFront, rib, [0, y, -D / 2 + THICK / 2]);
    add(ribSide, rib, [W / 2 - THICK / 2, y, 0]);
    add(ribSide, rib, [-W / 2 + THICK / 2, y, 0]);
  }

  return kit.group(parts);
}
