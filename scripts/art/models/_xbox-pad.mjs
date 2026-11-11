/**
 * Xbox Wireless Controller family — 153 × 61 × 102 mm, lying on the table on its grips and triggers.
 *
 * One parametric model for xbox-controller-black / -white / -blue and xbox-elite-2 (thin per-key
 * files import it). Offset sticks, round dished d-pad with a raised cross, four face buttons
 * with coloured dots in place of the letters, a plain lit home button (no logo), bumpers that
 * wrap the top corners, a front and a back shell with the seam along the flank.
 * The shell is a soft solid (see _soft-solid.mjs); the small parts are ordinary kit helpers.
 * Stylised from memory of the hardware, not traced: positions are approximate.
 */
import * as soft from './_soft-solid.mjs';
import { VIEWS, layFlat, mirrored, padShell } from './_gamepad.mjs';

export { VIEWS };

const SHOCK_BLUE = '#1458d6';

/** What differs between the colourways. */
const LOOKS = {
  black: (kit) => ({
    front: kit.clay(kit.colors.black),
    back: kit.clay(kit.colors.black),
    shoulder: kit.clay(kit.colors.jet, { finish: 'satin' }),
    dpad: kit.gloss(kit.colors.jet, { roughness: 0.24 }),
    cross: kit.gloss(kit.colors.jet, { roughness: 0.24 }),
    keys: kit.gloss(kit.colors.jet, { roughness: 0.3 }),
    minor: kit.clay(kit.colors.graphite, { finish: 'satin' }),
    bezel: kit.clay(kit.colors.graphite, { finish: 'satin' }),
  }),
  white: (kit) => ({
    front: kit.clay(kit.colors.white),
    back: kit.clay(kit.colors.white),
    shoulder: kit.clay(kit.colors.white, { finish: 'satin' }),
    dpad: kit.gloss(kit.colors.jet, { roughness: 0.24 }),
    cross: kit.gloss(kit.colors.jet, { roughness: 0.24 }),
    keys: kit.gloss(kit.colors.jet, { roughness: 0.3 }),
    minor: kit.clay(kit.colors.black, { finish: 'satin' }),
    bezel: kit.clay(kit.colors.black, { finish: 'satin' }),
  }),
  blue: (kit) => ({
    front: kit.clay(SHOCK_BLUE),
    back: kit.clay(kit.colors.white),
    shoulder: kit.clay(SHOCK_BLUE, { finish: 'satin' }),
    dpad: kit.gloss(kit.colors.jet, { roughness: 0.24 }),
    cross: kit.gloss(kit.colors.jet, { roughness: 0.24 }),
    keys: kit.gloss(kit.colors.jet, { roughness: 0.3 }),
    minor: kit.clay(kit.colors.black, { finish: 'satin' }),
    bezel: kit.clay(kit.colors.black, { finish: 'satin' }),
  }),
  elite: (kit) => ({
    front: kit.clay(kit.colors.black),
    back: kit.clay(kit.colors.black),
    shoulder: kit.metal('#3b3d43', { roughness: 0.42 }),
    dpad: kit.metal('#6d7078', { roughness: 0.34 }),
    cross: kit.metal('#8a8d94', { roughness: 0.3 }),
    keys: kit.gloss(kit.colors.jet, { roughness: 0.3 }),
    minor: kit.clay(kit.colors.graphite, { finish: 'satin' }),
    bezel: kit.metal('#55585f', { roughness: 0.36 }),
    stickMetal: kit.metal('#7b7e86', { roughness: 0.32 }),
    grip: kit.clay(kit.colors.jet, { finish: 'soft' }),
    elite: true,
  }),
};

export function buildXboxPad(kit, look = 'black') {
  if (!LOOKS[look]) throw new Error(`xbox pad: unknown colourway "${look}" (expected ${Object.keys(LOOKS).join(', ')})`);
  const { clay, glow, hollow, colors } = kit;
  const m = LOOKS[look](kit);
  const rubber = clay(colors.jet, { finish: 'soft' });
  const dark = hollow();

  /* ── the shell, in the pad's own frame: X right, Y towards the triggers, Z out of the face ── */

  const { body, above, patch, faceZ, onFace } = padShell({
    // arch between the grips, round the plump grip, up the bulging flank, round the bumper corner
    outline: soft.region(kit.polygon(...mirrored([
      [0, -23.6, 70], [27, -26.4, 16], [45, -53.6, 15], [67, -53.6, 16], [78, -23.5, 28], [70, 8, 40], [54, 41.8, 14], [20, 47.4, 60],
    ]), { segments: 16 })),
    faceEdge: 10,
    backEdge: 15,
    bend: (y) => { const t = Math.max(0, -y); return t < 28 ? 0.0085 * t * t : 6.66 + 0.476 * (t - 28); }, // the grips hang down
    crown: (x, y) => 5 * (x / 78) ** 2 + 1.6 * soft.smooth(18, 48, y), // domed: falls to the flanks and to the top edge
    thick: (x, y) => 31 + 4.5 * soft.smooth(-10, -36, y) * soft.smooth(26, 44, Math.abs(x)) + 4 * soft.smooth(14, 34, y),
  });

  const SEAM = 13.5; // the front shell is this deep; the back shell takes the rest
  const STICKS = [[-38, 18.5], [19.5, -6.5]], WELL = { radius: 12.2, depth: 2.2 };
  const wellSphere = (WELL.radius ** 2 + WELL.depth ** 2) / (2 * WELL.depth);
  const wells = STICKS.map(([x, y]) => {
    const z = faceZ(x, y);
    return {
      x, y, z,
      dish: soft.sphere([x, y, z - WELL.depth + wellSphere], wellSphere),
      hole: soft.capsule([x, y, z - 14], [x, y, z + 6], 8),
    };
  });
  // Elite: rubber wraps the lower, outer part of each grip
  const gripZone = (x, y) => (y + 27 - 0.44 * (Math.abs(x) - 26)) * 0.915;

  const front = (x, y, z) => {
    let d = soft.intersect(body(x, y, z), above(x, y, z, SEAM), 1.1);
    for (const well of wells) d = soft.subtract(soft.subtract(d, well.dish(x, y, z), 1.4), well.hole(x, y, z), 0.8);
    if (m.elite) d = soft.subtract(d, soft.intersect(gripZone(x, y) - 0.45, -(body(x, y, z) + 2.2), 0.8), 0.9);
    return d;
  };
  const back = (x, y, z) => {
    let d = soft.intersect(body(x, y, z), -above(x, y, z, SEAM + 0.55), 1.1);
    if (m.elite) d = soft.subtract(d, soft.intersect(gripZone(x, y) - 0.45, -(body(x, y, z) + 2.2), 0.8), 0.9);
    return d;
  };
  const core = (x, y, z) => { // what shows in the seams and down the stick openings
    let d = body(x, y, z) + 1.5;
    for (const well of wells) d = soft.subtract(d, well.dish(x, y, z) - 1.2, 1);
    return d;
  };
  const grip = (x, y, z) => soft.intersect(soft.intersect(body(x, y, z) - 0.25, gripZone(x, y), 0.9), -(body(x, y, z) + 2), 0.8);
  // bumpers wrap the top corners; triggers hang behind them
  const bumperPatch = patch((x, y) => Math.max(16.5 - Math.abs(x), 28 - y), 0.6, 15.5, 1.2);
  const bumper = (x, y, z) => soft.intersect(soft.intersect(bumperPatch(x, y, z), -above(x, y, z, 3.4), 1.2), -(body(x, y, z) + 5), 1);
  const trigger = soft.place(soft.roundBox([0, 0, 0], [12.5, 8, 14.5], 7), { at: [39, 35, -34.5], rot: [16, 0, -10] });

  const BOX = { min: [-83, -61, -66], max: [83, 52, 6] };
  const parts = [];
  const resting = []; // geometries that can touch the table
  const addSolid = (field, material, box = BOX, cell = 1, rests = true) => {
    const geometry = soft.solid(kit, field, { ...box, cell });
    if (rests) resting.push(geometry);
    const mesh = kit.mesh(geometry, material);
    parts.push(mesh);
    return mesh;
  };
  addSolid(core, dark, BOX, 1.25, false);
  addSolid(front, m.front, { ...BOX, min: [-83, -61, -52] }, 0.75);
  addSolid(back, m.back, { ...BOX, max: [83, 52, -8] }, 0.75);
  if (m.elite) parts.push(kit.mirrorX(addSolid(grip, m.grip, { min: [22, -61, -66], max: [83, 12, -2] })));
  parts.push(kit.mirrorX(addSolid(bumper, m.shoulder, { min: [10, 20, -26], max: [83, 52, 2] }, 0.8)));
  parts.push(kit.mirrorX(addSolid(trigger, m.shoulder, { min: [18, 16, -60], max: [62, 52, -8] }, 0.8)));

  /* ── small parts ──────────────────────────────────────────────────────────── */

  // sticks: a dark opening, a shaft and a cap with a deep dish and a raised rim
  const capBase = 7.3, cap = [[0, 0], [6.4, 0], [8.1, 0.6], [8.7, 1.5], [8.7, 2.6], [8.3, 3.4], [7.5, 3.85], [6.6, 3.6], [4.6, 2.75], [2.3, 2.35], [0, 2.25]];
  for (const well of wells) {
    parts.push(kit.group([
      kit.mesh(kit.puck(m.elite ? 4.6 : 5.2, capBase + 2, { bevel: 0.4, axis: 'z' }), m.stickMetal ?? rubber, { at: [0, 0, -1.2] }),
      // Elite: the whole cap is metal and only the dish is rubber
      kit.mesh(kit.lathe(cap.map(([r, h]) => [r, h + capBase]), { axis: 'z' }), m.stickMetal ?? rubber),
      m.elite && kit.mesh(kit.puck(6.5, 1.3, { bevel: 0.3, top: -0.75, axis: 'z' }), rubber, { at: [0, 0, capBase + 2.45] }),
    ], { at: [well.x, well.y, well.z - WELL.depth] }));
  }

  // d-pad: a round dished plate with a raised cross (Elite: the dish is cut in eight flat facets)
  parts.push(onFace(kit, -19.5, -6.5, [
    kit.mesh(kit.slab(kit.circle(12.4), 0.9, { bevel: 0.2 }), dark, { at: [0, 0, -0.3] }),
    m.elite
      ? kit.group([
        kit.mesh(kit.ring(11.7, 9.9, 2.2, { bevel: 0.6, axis: 'z' }), m.dpad, { at: [0, 0, -0.5] }),
        kit.mesh(kit.lathe([[0, 0], [10.3, 0], [10.3, 2], [0, 0.7]], { axis: 'z', segments: 8 }), m.dpad, { at: [0, 0, -0.5], rot: [0, 0, 22.5] }),
      ])
      : kit.mesh(kit.puck(11.7, 2.2, { bevel: 0.7, top: -1, axis: 'z' }), m.dpad, { at: [0, 0, -0.5] }),
    kit.mesh(kit.slab(kit.plus(20.4, 6.8, 1.5), 2, { bevel: 0.75 }), m.cross, { at: [0, 0, 1.25] }),
  ]));

  // face buttons: black domes, a coloured dot where the letter would be
  const spot = kit.puck(1.9, 0.6, { bevel: 0.25, axis: 'z' });
  const diamond = [[0, 10.7, colors.yellow], [10.7, 0, colors.red], [0, -10.7, colors.green], [-10.7, 0, colors.blue]];
  parts.push(onFace(kit, 38, 18.5, [
    kit.stamp(kit.slab(kit.circle(6.1), 0.9, { bevel: 0.2 }), dark, diamond.map(([x, y]) => [x, y]), { at: [0, 0, -0.3] }),
    kit.stamp(kit.puck(5.3, 3, { bevel: 1.1, top: 0.5, axis: 'z' }), m.keys, diamond.map(([x, y]) => [x, y]), { at: [0, 0, -0.8] }),
    ...diamond.map(([x, y, colour]) => kit.mesh(spot, clay(colour, { finish: 'satin' }), { at: [x, y, 2.35] })),
  ]));

  // home: a plain lit round in a bezel (no logo); view / menu / share
  parts.push(onFace(kit, 0, 32, [
    kit.mesh(kit.ring(7.4, 5.5, 1, { bevel: 0.3, axis: 'z' }), m.bezel, { at: [0, 0, -0.2] }),
    kit.mesh(kit.puck(5.6, 1.3, { bevel: 0.5, top: 0.3, axis: 'z' }), glow('#f4f6f8', m.elite ? 0.55 : 0.85), { at: [0, 0, -0.2] }),
  ]));
  const dot = kit.puck(2.9, 1.5, { bevel: 0.6, top: 0.2, axis: 'z' });
  for (const side of [-1, 1]) parts.push(onFace(kit, side * 12.5, 18.5, [kit.mesh(dot, m.minor, { at: [0, 0, -0.4] })]));
  parts.push(onFace(kit, 0, 9.5, [kit.mesh(kit.slab(kit.pill(6.6, 3.8), 1.6, { bevel: 0.5 }), m.minor, { at: [0, 0, 0.2] })]));
  if (m.elite) {
    // Elite: three profile lights under the share key
    const lamp = kit.slab(kit.pill(2.6, 1.1), 0.6, { bevel: 0.2 });
    parts.push(onFace(kit, 0, 3.6, [kit.stamp(lamp, glow('#f4f6f8', 0.7), [[-3.6, 0], [0, 0], [3.6, 0]], { at: [0, 0, 0.1] })]));
  }

  return layFlat(kit, parts, resting);
}
