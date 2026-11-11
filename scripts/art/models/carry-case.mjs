/**
 * carry-case — 300 × 140 × 60 mm.
 * Hard-shell carrying case for a handheld console, standing on its long edge: two pillowed shells
 * in dark grey fabric with a blister for each thumb-stick, a zipper running round between them,
 * a carrying strap on top and a red zipper pull hanging over the front. No logos, no badge.
 */
export const views = { hero: { azimuth: 30, elevation: 20 } };

export function build(kit) {
  const { clay, metal, colors } = kit;
  const W = 300, H = 140, D = 60;
  const CORNER = 44; // corner radius of the outline
  const SEAM = 3.4; // the zipper band between the shells
  const DOME = 2.6; // how far the middle of a shell bulges
  const SHELL = (D - SEAM) / 2 - DOME, EDGE = SHELL / 2; // depth of one shell at its rim, rounding of its outer edge
  const TOP = H / 2, FRONT = SEAM / 2 + SHELL; // FRONT: the face of the front shell before its bulge
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── shells ───────────────────────────────────────────────────────────────
  const fabric = clay('#4c4e56', { finish: 'soft' });
  const shell = kit.slab(kit.rect(W, H, CORNER, { segments: 16 }), SHELL, { bevel: EDGE, bevelBack: 0.9, bevelSegments: 10, dome: DOME, rings: 14 });
  add(shell, fabric, [0, 0, SEAM / 2 + SHELL / 2]);
  add(shell, fabric, [0, 0, -SEAM / 2 - SHELL / 2], [0, 180, 0]);
  // a blister over each thumb-stick of the console inside (left one high, right one low)
  const blister = kit.puck(16, 4.8, { bevel: 4.2, top: 1.2, axis: 'z' });
  add(blister, fabric, [-114, 21, FRONT - 0.6]);
  add(blister, fabric, [114, -13, FRONT - 0.6]);

  // ── zipper: dark tape between the shells, a row of teeth, the slider ─────
  add(kit.slab(kit.rect(W - 2.4, H - 2.4, CORNER - 1.2, { segments: 16 }), SEAM + 1.4, { bevel: 0 }), clay(colors.black, { finish: 'soft' }), [0, 0, 0]);
  /** Points [x, y, 0, spin] every `pitch` mm along a closed outline, each turned to follow it. */
  const along = (outline, pitch) => {
    const flat = outline.at(0), n = flat.length / 2, points = [];
    let carry = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = flat[2 * i], ay = flat[2 * i + 1], bx = flat[2 * j], by = flat[2 * j + 1];
      const length = Math.hypot(bx - ax, by - ay), spin = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
      let d = carry;
      for (; d < length; d += pitch) points.push([ax + ((bx - ax) * d) / length, ay + ((by - ay) * d) / length, 0, spin]);
      carry = d - length;
    }
    return points;
  };
  // no teeth along the foot: that is the hinge side
  const teeth = along(kit.rect(W - 1.3, H - 1.3, CORNER - 0.65, { segments: 16 }), 2.7).filter(([x, y]) => !(y < -TOP + 3 && Math.abs(x) < W / 2 - CORNER));
  parts.push(kit.stamp(kit.box(1.6, 1.5, 2.3, 0.45), clay(colors.jet, { finish: 'satin' }), teeth));
  const sliderX = 90;
  add(kit.box(9, 4.6, 6.4, 1.5), metal('#b9bcc2'), [sliderX, TOP + 0.9, 0]);
  add(kit.torus(2.5, 0.75, { axis: 'x' }), metal('#b9bcc2'), [sliderX, TOP + 3.4, 2.2]);

  // ── red pull: a cord over the rounded edge and a rubber tab on the front ─
  const red = clay(colors.red, { finish: 'soft' });
  const edgeY = TOP - EDGE, edgeZ = FRONT - EDGE, r = EDGE + 1.25; // the rounded front edge of the shell, and the cord riding on it
  const cord = [[sliderX, TOP + 3.3, 2.4], [sliderX, TOP + 1.6, 8], [sliderX, TOP + 1.3, edgeZ]];
  for (let a = 15; a <= 90; a += 15) cord.push([sliderX, edgeY + r * Math.cos((a * Math.PI) / 180), edgeZ + r * Math.sin((a * Math.PI) / 180)]);
  cord.push([sliderX, edgeY - 8, FRONT + 1.5], [sliderX - 0.6, edgeY - 13, FRONT + 1.9]);
  add(kit.tube(cord, 1.05), red);
  add(kit.slab(kit.rect(10, 26, [2.6, 2.6, 5, 5]), 3.2, { bevel: 1.3 }), red, [sliderX - 1.4, edgeY - 24.5, FRONT + 2.6], [0, 0, -5]);

  // ── carrying strap on top, on the back shell ─────────────────────────────
  const STRAP = 100, strapZ = -SEAM / 2 - 7.3;
  const strap = kit.deform(
    kit.slab(kit.rect(STRAP, 11.5, 2.6, { edge: 28 }), 2.6, { bevel: 0.9, rings: 4, axis: 'y' }),
    (p) => { p.y += 4.4 * Math.cos((Math.PI * p.x) / STRAP) ** 2; },
  );
  add(strap, clay(colors.black, { finish: 'soft' }), [0, TOP + 1.25, strapZ]);
  const anchor = kit.slab(kit.rect(15, 13.2, 2.8), 2.2, { bevel: 0.8, axis: 'y' });
  add(anchor, clay(colors.jet, { finish: 'soft' }), [-STRAP / 2 + 3, TOP + 1.2, strapZ]);
  add(anchor, clay(colors.jet, { finish: 'soft' }), [STRAP / 2 - 3, TOP + 1.2, strapZ]);

  return kit.group(parts);
}
