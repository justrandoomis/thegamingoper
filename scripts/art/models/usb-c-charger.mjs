/**
 * usb-c-charger — 50 × 50 × 28 mm.
 * White GaN wall charger with a coiled USB-C cable. The charger lies on its back with its two
 * round plug pins up — the pins are what makes it a wall charger — and its two ports towards
 * the camera; the cable runs from one port to a neat coil in front, held by a tie, and ends in
 * the second plug. No logos, no rating print.
 */
export const views = { hero: { azimuth: 30, elevation: 22 } };

export function build(kit) {
  const { clay, metal, colors } = kit;
  const W = 50, T = 28; // the body seen from above is 50 × 50; lying down it is 28 high
  const FRONT = W / 2;
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));
  const white = clay(colors.white), whiteSatin = clay(colors.white, { finish: 'satin' });
  const steel = metal(colors.silver);

  // ── body ─────────────────────────────────────────────────────────────────
  add(kit.slab(kit.rect(W, W, 10, { segments: 14 }), T, { bevel: 6.5, bevelSegments: 8, rings: 10, axis: 'y' }), white, [0, T / 2, 0]);

  // ── plug: two round pins on a low boss ───────────────────────────────────
  add(kit.slab(kit.pill(37, 15), 1.8, { bevel: 0.8, axis: 'y' }), whiteSatin, [0, T + 0.5, 0]);
  for (const x of [-9.4, 9.4]) {
    add(kit.puck(2.5, 9.6, { bevel: 0.3 }), clay(colors.silver, { finish: 'satin' }), [x, T + 1.2, 0]); // insulated root of the pin
    add(kit.capsule(2.05, 12.6), steel, [x, T + 15, 0]);
  }

  // ── ports on the front edge ──────────────────────────────────────────────
  const PORT_Y = T / 2, CABLE_X = -10;
  for (const x of [CABLE_X, -CABLE_X]) {
    add(kit.slab(kit.rect(12.2, 5.8, 2.8), 0.9, { bevel: 0.3 }), clay(colors.silver, { finish: 'satin' }), [x, PORT_Y, FRONT - 0.25]);
    parts.push(kit.vents([[0, 0]], { size: [8.6, 2.7], at: [x, PORT_Y, FRONT + 0.2] }));
  }

  // ── cable ────────────────────────────────────────────────────────────────
  // A plug, pointing along its own +Z: metal tip, moulded grip, strain relief.
  const plug = (placement) => kit.group([
    kit.mesh(kit.slab(kit.rect(8.2, 2.5, 1.15), 6.4, { bevel: 0.5 }), steel, { at: [0, 0, -1.4] }),
    kit.mesh(kit.slab(kit.rect(11.6, 6.2, 2.7), 13.5, { bevel: 2 }), whiteSatin, { at: [0, 0, 8.4] }),
    kit.mesh(kit.capsule(2.35, 9, { axis: 'z' }), white, { at: [0, 0, 17.6] }),
  ], placement);
  parts.push(plug({ at: [CABLE_X, PORT_Y, FRONT + 1.2] }));

  const R = 1.6; // cable radius
  const COIL = { x: 3.5, z: 82, radius: 18.6, rise: 3.35, sweep: 757 }; // two turns and a bit, each lying on the last
  const path = [[CABLE_X, PORT_Y, FRONT + 21], [CABLE_X - 0.1, PORT_Y - 0.9, FRONT + 27], [CABLE_X - 0.9, 9.3, FRONT + 33], [CABLE_X - 2.4, 4.6, FRONT + 39], [CABLE_X - 4, 2, FRONT + 45], [COIL.x - COIL.radius - 0.1, R, FRONT + 51]];
  const smooth = (t) => t * t * (3 - 2 * t);
  const coilPoint = (sweep) => {
    const a = ((180 - sweep) * Math.PI) / 180, turn = sweep / 360;
    const climb = Math.floor(turn) + smooth(Math.min(1, Math.max(0, (turn % 1) - 0.82) / 0.18)); // flat, then up onto the loop below
    return [COIL.x + COIL.radius * Math.cos(a), R + COIL.rise * climb, COIL.z + COIL.radius * Math.sin(a)];
  };
  for (let sweep = 0; sweep <= COIL.sweep; sweep += 15) path.push(coilPoint(sweep));
  // the free end leaves the coil along its tangent
  const end = coilPoint(COIL.sweep), endAngle = ((180 - COIL.sweep) * Math.PI) / 180;
  const heading = [Math.sin(endAngle), -Math.cos(endAngle)]; // [x, z] direction of travel
  path.push([end[0] + heading[0] * 5, end[1] - 0.1, end[2] + heading[1] * 5]);
  add(kit.tube(path, R, { segments: 14, steps: 900 }), clay(colors.white, { finish: 'soft' }));
  const yaw = (Math.atan2(heading[0], heading[1]) * 180) / Math.PI;
  parts.push(plug({ at: [end[0] + heading[0] * 27, end[1] - 0.1, end[2] + heading[1] * 27], rot: [0, yaw + 180, 0] }));

  // a tie round the coil where two turns lie on each other
  const tieAt = coilPoint(540);
  add(kit.extrude(kit.rect(6.6, 10.4, 2.2), 5.4, { bevel: 0.7, holes: [kit.rect(3.4, 7, 1.4)] }), clay(colors.grey, { finish: 'soft' }), [tieAt[0], R + COIL.rise / 2, tieAt[2]]);

  return kit.group(parts);
}
