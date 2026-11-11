/**
 * Rig and material swatch — not a product. Files that start with "_" are never picked up by a
 * normal build; render this one on purpose to check the shared look after touching kit.mjs:
 *
 *   node scripts/art/build.mjs --only=_swatch --draft
 *
 * Front row: white clay, black clay, colour clay (satin), soft clay. Back row: gloss, metal,
 * glass, a glowing accent. On the right: a perforated plate, a domed slab, a ring and vents.
 */
export function build(kit) {
  const { clay, gloss, metal, glass, glow, hollow, colors } = kit;
  const parts = [];
  const ball = (material, x, z) => parts.push(kit.mesh(new kit.THREE.SphereGeometry(18, 64, 32), material, { at: [x, 18, z] }));

  ball(clay(colors.white), -66, 30);
  ball(clay(colors.black), -22, 30);
  ball(clay(colors.coral, { finish: 'satin' }), 22, 30);
  ball(clay(colors.lightBlue, { finish: 'soft' }), 66, 30);
  ball(gloss(colors.jet), -66, -22);
  ball(metal(colors.silver), -22, -22);
  parts.push(kit.mesh(kit.slab(kit.rect(40, 30, 3), 3, { bevel: 0.8 }), glass({ aspect: 40 / 30 }), { at: [22, 17, -22], rot: [-12, 0, 0] }));
  parts.push(kit.mesh(kit.puck(10, 8, { bevel: 3, top: 1.5 }), glow(colors.playstation, 2.4), { at: [66, 0, -22] }));
  parts.push(kit.accentLight(colors.playstation, 1.2, 70).translateX(66).translateY(14).translateZ(-22));

  // geometry helpers
  const holes = kit.grid(5, 5, 9).map(([x, y]) => kit.circle(3.2, { segments: 28 }).move(x, y));
  parts.push(kit.mesh(kit.extrude(kit.rect(52, 52, 8), 2, { bevel: 0.6, holes, axis: 'y' }), clay(colors.graphite), { at: [124, 11, 30] }));
  parts.push(kit.mesh(kit.slab(kit.rect(50, 50, 6), 10, { bevel: 2, axis: 'y' }), glow(colors.xbox, 0.5), { at: [124, 5, 30] }));
  parts.push(kit.mesh(kit.slab(kit.rect(46, 30, 9), 12, { bevel: 4, dome: 3, axis: 'y' }), clay(colors.yellow), { at: [124, 6, -22] }));
  parts.push(kit.mesh(kit.ring(12, 8, 3), clay(colors.red), { at: [124, 15, -22] }));
  parts.push(kit.mesh(kit.box(44, 20, 14, 3), clay(colors.graphite), { at: [-112, 10, 30] }));
  parts.push(kit.vents(kit.grid(7, 3, 5, 4), { size: [3.4, 1.4], material: hollow(), at: [-112, 10, 37.1] }));
  parts.push(kit.mesh(kit.capsule(5, 40, { axis: 'x' }), clay(colors.violet), { at: [-112, 5, -22] }));
  // see-through sheet standing in front of the capsule, and a ring of stamped studs
  parts.push(kit.mesh(kit.slab(kit.rect(46, 30, 4), 1.4, { bevel: 0.5 }), kit.clear(), { at: [-112, 15, -8], rot: [-8, 0, 0], cast: false }));
  parts.push(kit.stamp(kit.slab(kit.pill(5, 1.8), 1.2, { bevel: 0.4 }), clay(colors.white), kit.radial(10, 13), { at: [-66, 4.2, 4], rot: [-90, 0, 0] }));
  // a cable, a doughnut, a mirrored pair and a painted face
  parts.push(kit.mesh(kit.tube([[70, 3, 46], [90, 3, 50], [104, 9, 44], [118, 3, 50], [140, 3, 46]], 1.6), clay(colors.jet, { finish: 'soft' })));
  parts.push(kit.mesh(kit.torus(7, 2.2, { axis: 'y' }), clay(colors.turquoise), { at: [-140, 2.2, 36] }));
  const fin = kit.mesh(kit.slab(kit.rect(4, 14, [3, 3, 0.5, 0.5]), 12, { bevel: 0.8 }), clay(colors.orange), { at: [150, 7, 6], rot: [0, 20, 0] });
  parts.push(fin, kit.mirrorX(fin));
  if (typeof document !== 'undefined') {
    const face = kit.paint(256, 160, (ctx, w, h) => {
      ctx.fillStyle = '#1d5fe0'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff'; ctx.font = '600 44px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Aa 123', w / 2, h / 2);
    });
    parts.push(kit.mesh(kit.slab(kit.rect(32, 20, 2.5), 1.2, { bevel: 0.4 }), clay(colors.white, { map: face }), { at: [-140, 12, -22], rot: [-14, 0, 0] }));
  }
  parts.push(kit.mesh(kit.box(320, 4, 100, 2), clay(colors.silver), { at: [0, -2, 4] }));
  return kit.group(parts);
}
