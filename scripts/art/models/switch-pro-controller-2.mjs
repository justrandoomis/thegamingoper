/**
 * switch-pro-controller-2 — 148 × 105 × 60 mm, standing on its grips with the face towards you,
 * as the catalogue gives it (105 high) and like the Switch 2 and the Joy-Con pair next to it.
 * (The PlayStation and Xbox pads lie flat: their catalogue heights are 66 and 61 mm.)
 * Black, symmetrical grips, offset sticks on light grey collars, a light grey band along the top
 * edge, plus-shaped d-pad, four round face buttons, small − / + / capture / home / C keys.
 * No logos or letters: plain shapes only. Stylised from memory of the hardware, not traced.
 * The shell is a soft solid (see _soft-solid.mjs); the small parts are ordinary kit helpers.
 */
import * as soft from './_soft-solid.mjs';
import { mirrored, padShell } from './_gamepad.mjs';

export const views = { hero: { azimuth: 30, elevation: 18 } };

export function build(kit) {
  const { clay, hollow, colors } = kit;
  const shellClay = clay(colors.black);
  const key = clay(colors.graphite, { finish: 'satin' }); // a shade lighter than the shell so the buttons read
  const pale = clay('#bcbec3', { finish: 'satin' }); // the light grey accents
  const rubber = clay(colors.jet, { finish: 'soft' });
  const dark = hollow();

  /* ── the shell, in the pad's own frame: X right, Y towards the triggers, Z out of the face ── */

  const { body, above, patch, faceZ, onFace } = padShell({
    // arch between the grips, round the slim grip, up the flank, over the broad shoulder
    outline: soft.region(kit.polygon(...mirrored([
      [0, -18.6, 70], [27, -21.5, 15], [44.5, -55, 13], [63, -55, 13], [74.8, -21, 32], [72, 12, 60], [66.5, 44, 20], [25, 48, 90],
    ]), { segments: 16 })),
    faceEdge: 9,
    backEdge: 14,
    bend: (y) => { const t = Math.max(0, 2 - y); return t < 30 ? 0.0082 * t * t : 7.38 + 0.492 * (t - 30); }, // the grips sweep back
    crown: (x, y) => 4 * (x / 75) ** 2 + 1.2 * soft.smooth(20, 48, y),
    thick: (x, y) => 29 + 6.5 * soft.smooth(-8, -36, y) * soft.smooth(26, 42, Math.abs(x)) + 4 * soft.smooth(16, 36, y),
  });

  const SEAM = 12.5; // the front shell is this deep; the back shell takes the rest
  const STICKS = [[-38, 20], [20, -5.5]], WELL = { radius: 12, depth: 2 };
  const wellSphere = (WELL.radius ** 2 + WELL.depth ** 2) / (2 * WELL.depth);
  const wells = STICKS.map(([x, y]) => {
    const z = faceZ(x, y);
    return { x, y, z, dish: soft.sphere([x, y, z - WELL.depth + wellSphere], wellSphere), hole: soft.capsule([x, y, z - 14], [x, y, z + 6], 7.6) };
  });
  // the light grey band: the top edge of the shell, from one shoulder to the other
  const bandPatch = patch((x, y) => 30 - y, 0.5, 15, 1.2);
  const band = (x, y, z) => soft.intersect(soft.intersect(bandPatch(x, y, z), -above(x, y, z, 1.3), 1.2), -(body(x, y, z) + 4.5), 1);

  const front = (x, y, z) => {
    let d = soft.intersect(body(x, y, z), above(x, y, z, SEAM), 1.1);
    for (const well of wells) d = soft.subtract(soft.subtract(d, well.dish(x, y, z), 1.4), well.hole(x, y, z), 0.8);
    return d;
  };
  const back = (x, y, z) => soft.intersect(body(x, y, z), -above(x, y, z, SEAM + 0.55), 1.1);
  const core = (x, y, z) => { // what shows in the seam and down the stick openings
    let d = body(x, y, z) + 1.5;
    for (const well of wells) d = soft.subtract(d, well.dish(x, y, z) - 1.2, 1);
    return d;
  };
  // triggers hang behind the top edge; from the front only their tops show
  const trigger = soft.place(soft.roundBox([0, 0, 0], [13, 6.2, 11.5], 6), { at: [45, 34.5, -31.5], rot: [22, 0, -8] });

  const BOX = { min: [-80, -62, -64], max: [80, 53, 6] };
  const parts = [];
  const addSolid = (field, material, box = BOX, cell = 1) => {
    const mesh = kit.mesh(soft.solid(kit, field, { ...box, cell }), material);
    parts.push(mesh);
    return mesh;
  };
  addSolid(core, dark, BOX, 1.25);
  addSolid(front, shellClay, { ...BOX, min: [-80, -62, -52] }, 0.75);
  addSolid(back, shellClay, { ...BOX, max: [80, 53, -7] }, 0.75);
  addSolid(band, pale, { min: [-80, 22, -26], max: [80, 53, 2] }, 0.8);
  parts.push(kit.mirrorX(addSolid(trigger, clay(colors.jet, { finish: 'satin' }), { min: [26, 16, -56], max: [68, 52, -8] }, 0.8)));

  /* ── small parts ──────────────────────────────────────────────────────────── */

  // sticks on light grey collars
  const capBase = 6.6, cap = [[0, 0], [6.3, 0], [7.7, 0.4], [8.4, 1.1], [8.6, 1.8], [8.4, 2.5], [7.8, 3], [7, 3.15], [6.2, 2.95], [4.6, 2.55], [2.6, 2.3], [0, 2.2]];
  for (const well of wells) {
    parts.push(kit.group([
      kit.mesh(kit.puck(4.8, capBase + 1.6, { bevel: 0.4, axis: 'z' }), rubber, { at: [0, 0, -1.2] }),
      kit.mesh(kit.lathe(cap.map(([r, h]) => [r, h + capBase]), { axis: 'z' }), rubber),
    ], { at: [well.x, well.y, well.z - WELL.depth] }));
    parts.push(onFace(kit, well.x, well.y, [kit.mesh(kit.ring(13.6, 11.2, 1.1, { bevel: 0.35, axis: 'z' }), pale, { at: [0, 0, -0.55] })]));
  }

  // d-pad: one plus-shaped key in a dark seat
  parts.push(onFace(kit, -20, -5.5, [
    kit.mesh(kit.slab(kit.plus(24.4, 8.6, 2.2), 0.9, { bevel: 0.2 }), dark, { at: [0, 0, -0.3] }),
    kit.mesh(kit.slab(kit.plus(23, 7.4, 1.6), 2.8, { bevel: 0.9, dome: -0.35 }), key, { at: [0, 0, 0.6] }),
  ]));

  // face buttons: four plain rounds in a diamond
  const diamond = kit.radial(4, 10.8, { start: 90 }).map(([x, y]) => [x, y]);
  parts.push(onFace(kit, 38, 20, [
    kit.stamp(kit.slab(kit.circle(6.3), 0.9, { bevel: 0.2 }), dark, diamond, { at: [0, 0, -0.3] }),
    kit.stamp(kit.puck(5.6, 2.7, { bevel: 1, top: 0.35, axis: 'z' }), key, diamond, { at: [0, 0, -0.8] }),
  ]));

  // − and +, capture (square) and home (round, ringed), C (rounded square)
  parts.push(onFace(kit, -14.5, 33, [kit.mesh(kit.slab(kit.pill(5.8, 1.9), 1.5, { bevel: 0.45 }), key, { at: [0, 0, 0.3] })]));
  parts.push(onFace(kit, 14.5, 33, [kit.mesh(kit.slab(kit.plus(5.8, 1.9, 0.4), 1.5, { bevel: 0.45 }), key, { at: [0, 0, 0.3] })]));
  parts.push(onFace(kit, -9.5, 20, [kit.mesh(kit.slab(kit.rect(6, 6, 1.5), 1.5, { bevel: 0.5 }), key, { at: [0, 0, 0.25] })]));
  parts.push(onFace(kit, 9.5, 20, [
    kit.mesh(kit.ring(4.5, 3.7, 0.6, { bevel: 0.18, axis: 'z' }), key, { at: [0, 0, -0.1] }),
    kit.mesh(kit.puck(3.4, 1.4, { bevel: 0.6, top: 0.2, axis: 'z' }), key, { at: [0, 0, -0.25] }),
  ]));
  parts.push(onFace(kit, 0, 6, [kit.mesh(kit.slab(kit.rect(6.4, 6.4, 1.8), 1.5, { bevel: 0.5 }), key, { at: [0, 0, 0.25] })]));

  return kit.group(parts);
}
