/**
 * Over-ear wireless headset — 190 × 200 × 90 mm, standing on its ear cups.
 *
 * One parametric model for headset-white / headset-black (thin per-key files import it).
 * A broad headband with a soft pad under its crown, short arms into two round cups, thick ear
 * cushions, a ring on each cup (silver on white, the green accent on black) and a short
 * retractable microphone on the wearer's left cup. A generic design: no brand, no logo.
 * The band and the microphone are soft solids (see _soft-solid.mjs); the rest is kit helpers.
 */
import * as soft from './_soft-solid.mjs';

export const VIEWS = { hero: { azimuth: 34, elevation: 16 } };

const GREEN = '#1fb53c';

const LOOKS = {
  white: (kit) => ({
    shell: kit.clay(kit.colors.white),
    plate: kit.clay(kit.colors.white, { finish: 'satin' }),
    ring: kit.clay(kit.colors.silver, { finish: 'satin' }),
    seam: kit.clay(kit.colors.silver, { finish: 'satin' }),
    collar: kit.clay(kit.colors.silver, { finish: 'satin' }),
    cushion: kit.clay(kit.colors.jet, { finish: 'soft' }),
    cloth: kit.clay(kit.colors.graphite, { finish: 'soft' }),
    mic: kit.clay(kit.colors.black, { finish: 'satin' }),
    light: '#f4f6f8',
  }),
  black: (kit) => ({
    shell: kit.clay(kit.colors.black),
    plate: kit.clay(kit.colors.black, { finish: 'satin' }),
    ring: kit.clay(GREEN, { finish: 'satin' }),
    seam: kit.clay(GREEN, { finish: 'satin' }),
    collar: kit.clay(kit.colors.graphite, { finish: 'satin' }),
    cushion: kit.clay(kit.colors.jet, { finish: 'soft' }),
    cloth: kit.clay(kit.colors.graphite, { finish: 'soft' }),
    mic: kit.clay(kit.colors.graphite, { finish: 'satin' }),
    light: GREEN,
  }),
};

export function buildHeadset(kit, look = 'white') {
  if (!LOOKS[look]) throw new Error(`headset: unknown colourway "${look}" (expected ${Object.keys(LOOKS).join(', ')})`);
  const m = LOOKS[look](kit);
  const parts = [];

  // The headset faces the viewer (+Z) as if worn: cups at ±X, the band over the top.
  const CUP = { x: 67.5, y: 50, radius: 45, depth: 25, tall: 1.1 }; // shell: from x = 67.5 outwards, a little taller than deep
  const BAND = { radius: 80, centre: 115.8, armEnd: 94 }; // a half circle over the head, then short arms down into the cups

  /* ── ear cups (right one built, left one mirrored) ─────────────────────────── */
  const cup = [];
  const lathed = (profile, material, x) => cup.push(kit.mesh(kit.lathe(profile, { axis: 'x', segments: 96 }), material, { at: [x, CUP.y, 0], scale: [1, CUP.tall, 1] }));
  // shell: round edge towards the head, soft shoulder towards the outer face
  lathed([[0, 0], [37, 0], [41.5, 1.6], [44.2, 5.5], [45, 11], [44.4, 16.5], [42, 21], [37.5, 24], [31, 25], [0, 25]], m.shell, CUP.x);
  // outer face: a ring and a shallow plate inside it
  lathed([[27.2, 0], [31.8, 0], [31.8, 1.3], [31.2, 1.9], [27.8, 1.9], [27.2, 1.3], [27.2, 0]], m.ring, CUP.x + 24.4);
  lathed([[0, 0], [27.4, 0], [27.4, 0.9], [26.4, 1.7], [0, 2.3]], m.plate, CUP.x + 24.6);
  // where shell and cushion meet: a slim band (the green accent again on the black one)
  lathed([[0, 0], [41.6, 0], [42.6, 0.8], [42.6, 2.2], [41.6, 3], [0, 3]], m.seam, CUP.x - 2.4);
  // cushion: a fat ring, and the cloth over the driver inside it
  cup.push(kit.mesh(kit.torus(30.5, 12.6, { axis: 'x' }), m.cushion, { at: [CUP.x - 9.2, CUP.y, 0], scale: [0.66, CUP.tall, 1] }));
  cup.push(kit.mesh(kit.puck(24, 4, { bevel: 1.2, axis: '-x' }), m.cloth, { at: [CUP.x - 4.6, CUP.y, 0], scale: [1, CUP.tall, 1] }));
  // collar where the arm slides into the cup
  cup.push(kit.mesh(kit.box(12, 15, 28, 4.5), m.collar, { at: [BAND.radius, CUP.y + CUP.radius * CUP.tall + 1.5, 0] }));
  const right = kit.group(cup);
  parts.push(right, kit.mirrorX(right));

  /* ── headband: one strip from cup to cup, wide over the crown, slimmer down the arms ── */
  const band = (x, y, z) => {
    // t: 0 at the crown … 1 where the arms start … more down the arms
    const t = y >= BAND.centre ? Math.atan2(Math.abs(x), y - BAND.centre) / (Math.PI / 2) : 1 + (BAND.centre - y) / 60;
    const line = y >= BAND.centre ? Math.abs(Math.hypot(x, y - BAND.centre) - BAND.radius) : Math.hypot(Math.abs(x) - BAND.radius, Math.max(BAND.armEnd - y, 0));
    const halfThick = 4.2 - 1.2 * soft.smooth(0.35, 1.1, t), halfWide = 17 - 5.5 * soft.smooth(0.3, 1.15, t);
    return soft.roundEdge(line - halfThick, Math.abs(z) - halfWide, 2.4);
  };
  parts.push(kit.mesh(soft.solid(kit, band, { min: [-88, 86, -21], max: [88, 204, 21], cell: 1 }), m.shell));
  // the pad under the crown
  const pad = (x, y, z) => {
    const line = Math.abs(Math.hypot(x, y - BAND.centre) - (BAND.radius - 7.4));
    return soft.intersect(soft.roundEdge(line - 4.4, Math.abs(z) - 14.5, 4), BAND.centre + 44 - y, 5);
  };
  parts.push(kit.mesh(soft.solid(kit, pad, { min: [-66, 152, -19], max: [66, 198, 19], cell: 1 }), m.cushion));

  /* ── microphone: a short boom from the front of the wearer's left cup ──────── */
  const root = [CUP.x + 12, CUP.y - 18, 30], mouth = [CUP.x + 4, CUP.y - 34, 56]; // inside the cup … where the boom ends
  const on = (t) => root.map((v, i) => v + (mouth[i] - v) * t);
  const boom = soft.capsule(root, mouth, 3.3);
  const socket = soft.capsule(on(0.2), on(0.46), 4.9); // the sleeve it slides into, where it leaves the cup
  const tip = soft.capsule(on(0.87), on(1.06), 5);
  const microphone = (x, y, z) => soft.union(soft.union(boom(x, y, z), socket(x, y, z), 1.2), tip(x, y, z), 2);
  parts.push(kit.mesh(soft.solid(kit, microphone, { min: [CUP.x - 6, CUP.y - 46, 22], max: [CUP.x + 22, CUP.y - 8, 68], cell: 0.6 }), m.mic));
  // a small status light beside it
  parts.push(kit.mesh(kit.puck(1.5, 0.8, { bevel: 0.3, axis: 'z' }), kit.glow(m.light, 1.2), { at: [CUP.x + 14, CUP.y + 4, 44.3] }));

  return kit.group(parts);
}
