/**
 * part-fan — 70 × 70 × 15 mm.
 * Blower-style cooling fan in a black frame: a flat snail-shell housing with one square corner,
 * the round intake on the face showing the hub and the ring of curved blades, the outlet mouth
 * on the top edge at the square corner, a mounting ear at each foot, and a short three-wire lead
 * with its plug. It stands on its ears, leaning back a little. No labels.
 */
export const views = { hero: { azimuth: 28, elevation: 19 } };

export function build(kit) {
  const { clay, metal, hollow, colors } = kit;
  const S = 70, D = 15, HALF = S / 2, F = D / 2;
  const EYE = [-1, -1.5], INTAKE = 21.5; // middle and radius of the intake
  const LEAN = 8, a = (LEAN * Math.PI) / 180;
  const fan = []; // everything that leans
  const add = (geometry, material, at, rot) => fan.push(kit.mesh(geometry, material, { at, rot }));
  const black = clay(colors.black, { finish: 'satin' });
  const key = clay(colors.graphite, { finish: 'satin' });

  // ── housing: three round corners, one square one where the air leaves ────
  const outline = kit.rect(S, S, [33, 2.6, 30, 30], { segments: 20 });
  const frame = kit.deform(
    kit.extrude(outline, D, { bevel: 1.7, bevelSegments: 5, holes: [kit.circle(INTAKE, { segments: 96 }).move(EYE[0], EYE[1])] }),
    () => {}, // no bending: this only cuts the face into small triangles so it shades evenly
    { maxEdge: 2.6 },
  );
  add(frame, black, [0, 0, 0]);
  add(kit.slab(kit.rect(S - 4, S - 4, [31, 1.2, 28, 28], { segments: 20 }), 1.4, { bevel: 0 }), hollow('#0b0b0d'), [0, 0, -F + 2]); // the floor behind the wheel
  // a raised lip round the intake
  add(kit.ring(INTAKE + 3.3, INTAKE + 1.5, 0.9, { bevel: 0.35, segments: 96, axis: 'z' }), key, [EYE[0], EYE[1], F - 0.25]);

  // ── wheel: hub, blank label, a ring of forward-curved blades ─────────────
  add(kit.puck(10.6, 10.4, { bevel: 2.4, axis: 'z' }), key, [EYE[0], EYE[1], -F + 2.6]);
  add(kit.puck(6.6, 0.45, { bevel: 0.14, axis: 'z' }), clay(colors.silver), [EYE[0], EYE[1], -F + 12.9]);
  const blade = kit.deform(
    kit.slab(kit.rect(9.4, 1.15, 0.5, { edge: 8 }), 9.6, { bevel: 0.35, rings: 2 }),
    (p) => { p.y += 0.04 * p.x * p.x; }, // camber
  ).rotateZ((42 * Math.PI) / 180);
  fan.push(kit.stamp(blade, clay(colors.slate, { finish: 'satin' }), kit.radial(29, 16.4), { at: [EYE[0], EYE[1], -F + 7.6] }));

  // ── outlet mouth on the top edge ─────────────────────────────────────────
  add(kit.slab(kit.rect(33, 12.2, 1.6), 0.9, { bevel: 0.3, axis: 'y' }), key, [17.2, HALF - 0.25, 0]);
  fan.push(kit.vents([[0, 0]], { size: [29.6, 9], at: [17.2, HALF + 0.2, 0], rot: [-90, 0, 0] }));

  // ── mounting ears at the two feet, screws in the cover ───────────────────
  const ear = kit.extrude(kit.rect(13.5, 13.5, 3.6), 4.2, { bevel: 0.7, holes: [kit.circle(2.2, { segments: 32 })] });
  add(ear, black, [-HALF + 6.75, -HALF + 6.75, -F + 2.1]);
  add(ear, black, [HALF - 6.75, -HALF + 6.75, -F + 2.1]);
  const screw = kit.puck(1.55, 0.55, { bevel: 0.25, axis: 'z' });
  for (const [x, y] of [[-24, 23.5], [30, 30], [25.5, -24.5]]) {
    add(screw, metal('#8d9097'), [x, y, F - 0.2]);
    fan.push(kit.vents([[0, 0]], { size: [1.9, 0.5], depth: 0.3, at: [x, y, F + 0.34], rot: [0, 0, 35] }));
  }

  const leaning = kit.group([kit.group(fan, { at: [0, HALF, 0] })], { rot: [-LEAN, 0, 0] });
  const parts = [leaning];
  /** Where a point of the upright fan ([x, height above its foot, z]) ends up once it leans. */
  const leaned = ([x, y, z]) => [x, y * Math.cos(a) + z * Math.sin(a), -y * Math.sin(a) + z * Math.cos(a)];

  // ── lead: three wires from the lower right of the housing to a plug on the floor ──
  const PLUG = [29.5, 1.8, 27];
  const exit = leaned([HALF - 0.6, 15, -2]);
  const spine = [exit, [exit[0] + 2.2, exit[1] - 0.6, exit[2] + 1.2], [exit[0] + 2.4, 9.5, 5.5], [exit[0] + 0.6, 4.6, 12], [PLUG[0] + 1, 2.2, 18.5], [PLUG[0], 1.9, PLUG[2] - 2.5]];
  for (const [i, color] of [colors.jet, '#d9342b', colors.yellow].entries()) {
    const k = i - 1;
    const wire = spine.map(([x, y, z], n) => {
      const t = n / (spine.length - 1), spread = 1.7 * k;
      return [x + spread * t, y, z + spread * (1 - t)]; // side by side along the housing's depth at the start, across the plug at the end
    });
    parts.push(kit.mesh(kit.tube(wire, 0.75, { segments: 10 }), clay(color, { finish: 'soft' })));
  }
  parts.push(kit.mesh(kit.box(7.8, 3.6, 6, 0.85), clay(colors.white, { finish: 'satin' }), { at: PLUG }));
  parts.push(kit.vents(kit.grid(3, 1, 1.9), { size: [1.15, 1.6], at: [PLUG[0], PLUG[1] + 0.1, PLUG[2] + 3] }));

  return kit.group(parts);
}
