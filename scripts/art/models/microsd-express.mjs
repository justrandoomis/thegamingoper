/**
 * microsd-express — 11 × 15 × 1 mm.
 * microSD card, dark grey with a red label band, shown large: label side towards the camera,
 * the narrow contact end up, leaning back. The stepped right-hand edge with its chamfer and the
 * small notch under it is what makes the outline a microSD. Contacts (two rows, as on an Express
 * card) and the fingernail ridge are on the back. No logos, no capacity print: plain marks only.
 */
export const views = { hero: { azimuth: 28, elevation: 18 } };

export function build(kit) {
  const { clay, metal, colors } = kit;
  const T = 0.8, F = T / 2; // body thickness; the ridge on the back brings it to 1 mm
  const parts = [];
  const add = (geometry, material, at) => parts.push(kit.mesh(geometry, material, { at }));

  // ── body: 11 wide at the foot, 9.7 at the head, chamfered step and notch on the right ──
  const outline = kit.polygon(
    [[-5.5, -7.5], [5.5, -7.5], [5.5, -2.3], [4.65, -2.3], [4.65, -1.3], [5.5, -0.45], [5.5, 0.55], [4.2, 1.85], [4.2, 7.5], [-5.5, 7.5]],
    [0.8, 0.8, 0.2, 0.2, 0.15, 0.25, 0.3, 0.5, 0.7, 0.7],
    { segments: 8 },
  );
  // (deform with no change, only to cut the two faces into small triangles: an extruded face is a
  // few long ones, and the soft edge shading would streak across them)
  const body = kit.deform(kit.extrude(outline, T, { bevel: 0.24, bevelSegments: 5 }), () => {}, { maxEdge: 0.7 });
  add(body, clay(colors.graphite, { finish: 'satin' }), [0, 0, 0]);

  // ── label side ───────────────────────────────────────────────────────────
  add(kit.slab(kit.rect(9.7, 4.3, 0.55), 0.3, { bevel: 0.09 }), clay(colors.red, { finish: 'satin' }), [0, -4.55, F - 0.06]); // the red band
  const mark = clay(colors.grey);
  add(kit.slab(kit.pill(3.4, 0.62), 0.24, { bevel: 0.08 }), mark, [-2.75, 5.45, F - 0.05]);
  add(kit.slab(kit.pill(2.1, 0.62), 0.24, { bevel: 0.08 }), mark, [-3.4, 4.3, F - 0.05]);
  add(kit.slab(kit.circle(0.62, { segments: 32 }), 0.24, { bevel: 0.08 }), mark, [2.55, 4.9, F - 0.05]);
  add(kit.slab(kit.pill(4.4, 0.5), 0.22, { bevel: 0.07 }), clay(colors.white), [-1.95, -5.35, F + 0.08]); // one plain line on the band

  // ── back: contact pads at the head (a second row on Express cards), ridge at the foot ──
  const gold = metal('#e2b24f');
  const pad = kit.slab(kit.rect(0.74, 2.7, 0.2), 0.2, { bevel: 0.06, axis: '-z' });
  const short = kit.slab(kit.rect(0.74, 1.5, 0.2), 0.2, { bevel: 0.06, axis: '-z' });
  for (let i = 0; i < 8; i++) {
    add(pad, gold, [3.2 - i * 1.1, 5.75, -F - 0.03]);
    add(short, gold, [3.2 - i * 1.1, 3.1, -F - 0.03]);
  }
  add(kit.slab(kit.rect(8.6, 0.95, 0.4), 0.45, { bevel: 0.18, axis: '-z' }), clay(colors.graphite, { finish: 'satin' }), [0, -6.45, -F - 0.02]);

  // stand it on its foot, leaning back
  return kit.group([kit.group(parts, { at: [0, 7.5, 0] })], { rot: [-12, 0, 0] });
}
