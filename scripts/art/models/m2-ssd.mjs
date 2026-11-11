/**
 * m2-ssd — 22 × 80 × 8 mm.
 * M.2 2280 SSD with a black finned heatsink. It stands on its screw end, leaning back, with the
 * gold edge connector (and its key notch) up, because that is the part everyone knows it by.
 * Dark blue board, six fins with slanted ends, a plain back plate. No labels, no logos.
 */
export const views = { hero: { azimuth: 32, elevation: 18 } };

export function build(kit) {
  const { clay, metal, colors } = kit;
  const W = 22, L = 80; // the board
  const BOARD = 0.9, F = BOARD / 2; // board thickness, and its front surface
  const SINK = [7, 73]; // the heatsink covers the board between these heights
  const parts = [];
  const add = (geometry, material, at) => parts.push(kit.mesh(geometry, material, { at }));

  // ── board: key notch in the connector (top), half-round screw notch at the foot ──
  const points = [[-11, 0]];
  for (let a = 180; a >= 0; a -= 22.5) points.push([1.9 * Math.cos((a * Math.PI) / 180), 1.9 * Math.sin((a * Math.PI) / 180)]);
  points.push([11, 0], [11, L], [-5.7, L], [-5.7, L - 3.7], [-7.1, L - 3.7], [-7.1, L], [-11, L]);
  const radii = points.map(([x, y]) => (Math.abs(x) === 11 ? 0.5 : y > L - 5 ? 0.25 : 0));
  // (deform with no change, only to cut the faces into small triangles so they shade evenly)
  const board = kit.deform(kit.extrude(kit.polygon(points, radii, { segments: 4 }), BOARD, { bevel: 0.2 }), () => {}, { maxEdge: 1.5 });
  add(board, clay('#1d3a78', { finish: 'satin' }), [0, 0, 0]);

  // ── gold: connector fingers on both faces, the pad round the screw notch ──
  const gold = metal('#e2b24f');
  const fingers = [];
  for (let x = -4.95; x < 10.6; x += 1.02) fingers.push([x, L - 1.55]);
  for (let x = -10.25; x < -7.4; x += 1.02) fingers.push([x, L - 1.55]);
  const finger = kit.slab(kit.rect(0.62, 2.6, 0.2), 0.2, { bevel: 0.06 });
  parts.push(kit.stamp(finger, gold, fingers, { at: [0, 0, F + 0.04] }));
  parts.push(kit.stamp(finger, gold, fingers.map(([x, y]) => [-x, y]), { at: [0, 0, -F - 0.04], rot: [0, 180, 0] }));
  const arc = (radius, from, to) => {
    const out = [];
    for (let i = 0; i <= 12; i++) { const a = ((from + ((to - from) * i) / 12) * Math.PI) / 180; out.push([radius * Math.cos(a), radius * Math.sin(a)]); }
    return out;
  };
  const pad = kit.polygon([...arc(3.3, 0, 180), ...arc(1.95, 180, 0)], 0, { segments: 2 });
  add(kit.extrude(pad, 0.2, { bevel: 0.05 }), gold, [0, 0.05, F + 0.04]);
  add(kit.extrude(pad, 0.2, { bevel: 0.05 }), gold, [0, 0.05, -F - 0.04]);

  // ── what shows of the board below the heatsink ───────────────────────────
  add(kit.slab(kit.rect(5.2, 3.2, 0.3), 0.9, { bevel: 0.2 }), clay(colors.jet, { finish: 'satin' }), [-5.6, 4.1, F + 0.35]);
  const part = kit.slab(kit.rect(1.9, 1.05, 0.2), 0.7, { bevel: 0.2 });
  add(part, clay('#c9a877'), [5.2, 4.9, F + 0.25]);
  add(part, clay('#c9a877'), [8.1, 4.9, F + 0.25]);
  add(part, clay(colors.graphite), [6.6, 2.9, F + 0.25]);

  // ── heatsink: a base plate and six fins with slanted ends; a thin plate on the back ──
  const black = clay(colors.black, { finish: 'satin' });
  const mid = (SINK[0] + SINK[1]) / 2, length = SINK[1] - SINK[0];
  add(kit.slab(kit.rect(W, length, 1.4), 3.1, { bevel: 0.8, bevelBack: 0.3 }), black, [0, mid, F + 0.5 + 1.55]);
  const half = length / 2 - 1.2, FIN = 2.9; // fin height: board, plates and fins come to 8 mm
  const fin = kit.slab(kit.polygon([[0, -half], [0, half], [-FIN, half - 3.4], [-FIN, -half + 3.4]], [0, 0, 0.9, 0.9]), 1.75, { bevel: 0.55, axis: 'x' });
  for (let i = 0; i < 6; i++) add(fin, black, [-8.6 + i * 3.44, mid, F + 3.25]);
  add(kit.slab(kit.rect(W, length, 1.4), 1, { bevel: 0.35, axis: '-z' }), clay(colors.jet, { finish: 'satin' }), [0, mid, -F - 0.45]);
  // the clips that hold the two halves together
  const clip = kit.slab(kit.rect(4.4, 9, 0.8), 0.6, { bevel: 0.2, axis: 'x' });
  for (const y of [mid - 20, mid + 20]) {
    add(clip, clay(colors.graphite, { finish: 'satin' }), [W / 2 + 0.1, y, 1.1]);
    add(clip, clay(colors.graphite, { finish: 'satin' }), [-W / 2 - 0.1, y, 1.1]);
  }

  // stand it on the screw end, leaning back
  return kit.group([kit.group(parts)], { rot: [-10, 0, 0] });
}
