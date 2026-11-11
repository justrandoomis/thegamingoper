/**
 * DualSense family — 160 × 66 × 106 mm, lying on the table the way the real pad rests: on its
 * grips and triggers, face up.
 *
 * One parametric model for dualsense-white / -black / -red / -edge (thin per-key files import it).
 * Two-tone shell with the dark centre that carries both sticks, touch pad with a light bar down
 * each side, four-piece d-pad, four plain round face buttons (no symbols), bumpers and triggers.
 * The shell is a soft solid (see _soft-solid.mjs); the small parts are ordinary kit helpers.
 * Stylised from memory of the hardware, not traced: positions are approximate.
 */
import * as soft from './_soft-solid.mjs';
import { VIEWS, layFlat, mirrored, padShell } from './_gamepad.mjs';

export { VIEWS };

const DEEP_RED = '#960f1f';

/** What differs between the colourways. */
const LOOKS = {
  white: (kit) => ({
    shell: kit.clay(kit.colors.white),
    centre: kit.clay(kit.colors.black, { finish: 'satin' }),
    pad: kit.clay(kit.colors.white, { finish: 'satin' }),
    keys: kit.clay('#dcdde1', { finish: 'satin' }),
    shoulder: kit.clay(kit.colors.black, { finish: 'satin' }),
    home: kit.gloss(kit.colors.jet),
  }),
  black: (kit) => ({
    shell: kit.clay(kit.colors.black),
    centre: kit.gloss(kit.colors.jet, { roughness: 0.26 }),
    pad: kit.clay(kit.colors.black, { finish: 'satin' }),
    keys: kit.clay(kit.colors.graphite, { finish: 'satin' }),
    shoulder: kit.clay(kit.colors.jet, { finish: 'satin' }),
    home: kit.clay(kit.colors.graphite, { finish: 'satin' }),
  }),
  red: (kit) => ({
    shell: kit.clay(DEEP_RED),
    centre: kit.clay(kit.colors.black, { finish: 'satin' }),
    pad: kit.clay(DEEP_RED, { finish: 'satin' }),
    keys: kit.clay('#3a1c21', { finish: 'satin' }),
    shoulder: kit.clay(kit.colors.black, { finish: 'satin' }),
    home: kit.gloss(kit.colors.jet),
  }),
  edge: (kit) => ({
    shell: kit.clay(kit.colors.white),
    centre: kit.gloss(kit.colors.jet, { roughness: 0.22 }),
    pad: kit.clay(kit.colors.black, { finish: 'satin' }),
    keys: kit.clay(kit.colors.black, { finish: 'satin' }),
    shoulder: kit.clay(kit.colors.black, { finish: 'satin' }),
    home: kit.clay(kit.colors.graphite, { finish: 'satin' }),
    functionKeys: true,
  }),
};

export function buildDualSense(kit, look = 'white') {
  if (!LOOKS[look]) throw new Error(`dualsense: unknown colourway "${look}" (expected ${Object.keys(LOOKS).join(', ')})`);
  const { clay, glow, hollow, colors } = kit;
  const m = LOOKS[look](kit);
  const rubber = clay(colors.jet, { finish: 'soft' });
  const minor = clay(colors.graphite, { finish: 'satin' });
  const dark = hollow();

  /* ── the shell, in the pad's own frame: X right, Y towards the triggers, Z out of the face ── */

  const { body, above, patch, faceZ, onFace } = padShell({
    // silhouette seen face-on: arch between the grips, round the grip tip, up the flank, over the shoulder
    outline: soft.region(kit.polygon(...mirrored([
      [33, -30.5, 12], [48.5, -61.5, 12.5], [66.5, -61.5, 12.5], [80.2, -6, 45], [77, 39, 27], [30, 39.8, 120],
    ]), { segments: 16 })),
    faceEdge: 9,
    backEdge: 15,
    // the grips sweep back: a curve that settles into a steady slope
    bend: (y) => { const t = Math.max(0, -2 - y); return t < 30 ? 0.0078 * t * t : 7.02 + 0.468 * (t - 30); },
    crown: (x) => 3.4 * (x / 80) ** 2, // the face falls away towards the flanks
    // 29 mm through the middle, fuller grips, a hump under the shoulders where the triggers live
    thick: (x, y) => 29 + 9.5 * soft.smooth(-8, -40, y) * soft.smooth(28, 46, Math.abs(x)) + 5 * soft.smooth(4, 26, y),
  });

  // The dark centre: under the touch pad, round both sticks and down the inside of the grips.
  const centreZone = soft.region(kit.polygon(...mirrored([
    [58, -80, 0], [53, -60, 6], [49.5, -45, 20], [46.5, -29, 20], [45.2, -12, 14], [39, 3, 9], [30, 9.5, 4],
  ]), { segments: 10 }));
  const PAD = { top: 34.3, bottom: 3.2, halfTop: 33, halfBottom: 27 };
  const padZone = soft.region(kit.polygon(
    [[-PAD.halfBottom, PAD.bottom], [PAD.halfBottom, PAD.bottom], [PAD.halfTop, PAD.top], [-PAD.halfTop, PAD.top]], [8, 8, 4.5, 4.5], { segments: 10 },
  ));
  // light bar: a slit down each slanted side of the touch pad
  const lightZone = (x, y) => Math.max(Math.abs(padZone(x, y) - 1.25) - 0.75, y - 30, 7.5 - y);
  const STICK = [26.5, -9.5], WELL = { radius: 13, depth: 2.6 };
  const wellSphere = (WELL.radius ** 2 + WELL.depth ** 2) / (2 * WELL.depth);
  const stickZ = faceZ(STICK[0], STICK[1]) - 0.4; // the centre sits 0.4 mm under the shell
  const wells = [-1, 1].map((side) => ({
    dish: soft.sphere([side * STICK[0], STICK[1], stickZ - WELL.depth + wellSphere], wellSphere),
    hole: soft.capsule([side * STICK[0], STICK[1], stickZ - 14], [side * STICK[0], STICK[1], stickZ + 6], 8.4),
  }));

  const shell = (x, y, z) => {
    let d = body(x, y, z);
    d = soft.subtract(d, soft.intersect(centreZone(x, y) - 0.55, above(x, y, z, 23.5), 1.4), 1.1);
    d = soft.subtract(d, soft.intersect(Math.min(padZone(x, y) - 0.65, lightZone(x, y) - 0.2), above(x, y, z, 2.6), 0.8), 0.9);
    return d;
  };
  const centrePatch = patch(centreZone, -0.4, 23, 1.4);
  const centre = (x, y, z) => {
    let d = centrePatch(x, y, z);
    for (const well of wells) d = soft.subtract(soft.subtract(d, well.dish(x, y, z), 1.4), well.hole(x, y, z), 0.8);
    return d;
  };
  const core = (x, y, z) => { // what shows in the seams and down the stick openings
    let d = body(x, y, z) + 1.5;
    for (const well of wells) d = soft.subtract(d, well.dish(x, y, z) - 1.2, 1);
    return d;
  };
  // bumpers hug the shoulders; triggers hang under them, behind the shell
  const bumperPatch = patch((x, y) => Math.max(37.5 - Math.abs(x), 23 - y), 0.9, 14.5, 1.2);
  const bumper = (x, y, z) => soft.intersect(soft.intersect(bumperPatch(x, y, z), -above(x, y, z, 3.6), 1.2), -(body(x, y, z) + 5), 1);
  const trigger = soft.place(soft.roundBox([0, 0, 0], [14, 8.5, 15.5], 7.5), { at: [53, 27.5, -40.5], rot: [16, 0, -12] });

  const BOX = { min: [-85, -67, -68], max: [85, 45, 5] };
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
  addSolid(shell, m.shell, BOX, 0.75);
  addSolid(centre, m.centre, { min: [-62, -67, -68], max: [62, 14, 3] }, 0.75);
  addSolid(patch(padZone, 0.55, 2.4, 0.9), m.pad, { min: [-38, 0, -8], max: [38, 39, 4] }, 0.8, false);
  parts.push(kit.mirrorX(addSolid(patch(lightZone, 0.15, 3, 0.5), glow('#3b82ff', 2.6), { min: [22, 3, -5], max: [38, 34, 4] }, 0.5, false)));
  for (const x of [-34, 34]) parts.push(kit.accentLight('#3b82ff', 0.7, 26).translateX(x).translateY(19).translateZ(5));
  parts.push(kit.mirrorX(addSolid(bumper, m.shoulder, { min: [30, 14, -24], max: [85, 45, 2] }, 0.8)));
  parts.push(kit.mirrorX(addSolid(trigger, m.shoulder, { min: [30, 8, -64], max: [80, 46, -14] }, 0.8)));

  /* ── small parts, each cluster standing square on the face ─────────────────── */

  const seat = (shape, points) => kit.stamp(kit.slab(shape, 0.9, { bevel: 0.2 }), dark, points, { at: [0, 0, -0.3] }); // the dark gap round a key

  // sticks: a dark opening, a thick shaft and a wide cap with a dished middle
  const capBase = 7.8, cap = [[0, 0], [7.2, 0], [8.9, 0.5], [9.6, 1.4], [9.8, 2.3], [9.6, 3.2], [9, 3.9], [8.1, 4.2], [7.1, 4.05], [5.4, 3.5], [3, 3.15], [0, 3.05]];
  for (const side of [-1, 1]) {
    parts.push(kit.group([
      kit.mesh(kit.puck(5.4, capBase + 2.4, { bevel: 0.4, axis: 'z' }), rubber, { at: [0, 0, -1.2] }),
      kit.mesh(kit.lathe(cap.map(([r, h]) => [r, h + capBase]), { axis: 'z' }), rubber),
    ], { at: [side * STICK[0], STICK[1], stickZ - WELL.depth] }));
  }

  // d-pad: four separate keys pointing at the middle, a hairline apart
  const wedge = kit.slab(kit.polygon([[-7.8, 0], [-2.9, -4.9], [5.3, -4.9], [5.3, 4.9], [-2.9, 4.9]], [1, 1.6, 2.2, 2.2, 1.6]), 2.5, { bevel: 0.8, dome: 0.25 });
  parts.push(onFace(kit, -51.5, 11, [
    seat(kit.plus(30.8, 11, 2.6), [[0, 0]]),
    kit.stamp(wedge, m.keys, kit.radial(4, 9.3), { at: [0, 0, 0.55] }),
  ]));

  // face buttons: four plain rounds in a diamond
  const diamond = kit.radial(4, 12.3, { start: 90 }).map(([x, y]) => [x, y]);
  parts.push(onFace(kit, 51.5, 11, [
    seat(kit.circle(6), diamond),
    kit.stamp(kit.puck(5.1, 2.5, { bevel: 0.9, top: 0.35, axis: 'z' }), m.keys, diamond, { at: [0, 0, -0.7] }),
  ]));

  // create / options: slim keys leaning along the touch pad's sides
  const slim = kit.slab(kit.pill(4.2, 8.8), 1.8, { bevel: 0.6 });
  for (const side of [-1, 1]) parts.push(onFace(kit, side * 40, 28, [kit.mesh(slim, m.keys, { at: [0, 0, 0.2], rot: [0, 0, -side * 11] })]));

  // home (a plain round — no logo) and mute, on the dark centre
  parts.push(onFace(kit, 0, -13, [kit.mesh(kit.puck(4.3, 1.5, { bevel: 0.6, top: 0.3, axis: 'z' }), m.home, { at: [0, 0, -0.3] })], 0.4));
  parts.push(onFace(kit, 0, -23.3, [kit.mesh(kit.slab(kit.pill(9.4, 3.4), 1.4, { bevel: 0.45 }), minor, { at: [0, 0, 0.2] })], 0.4));

  if (m.functionKeys) {
    // Edge: a function key under each stick
    const fn = kit.slab(kit.pill(10.5, 4.4), 3, { bevel: 1.1 });
    for (const side of [-1, 1]) parts.push(onFace(kit, side * 25.5, -26.4, [kit.mesh(fn, minor, { at: [0, 0, 0.1], rot: [0, 0, side * 16] })], 0.4));
  }

  return layFlat(kit, parts, resting);
}
