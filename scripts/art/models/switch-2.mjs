/**
 * switch-2 — 272 × 116 × 13.9 mm, Joy-Con 2 attached.
 * Black tablet with a 7.9-inch screen; left stick ring light blue, right stick ring coral;
 * thin coloured rails where the controllers meet the body. No logos: plain shapes on the buttons.
 */
export const views = {
  hero: { azimuth: 28, elevation: 17 },
  back: { azimuth: 208, elevation: 17 },
};

export function build(kit) {
  const { clay, glass, hollow, colors } = kit;
  const W = 272, H = 116, D = 13.9, F = D / 2; // F: the front surface
  const CORNER = 20, EDGE = 3.2;
  const SCREEN = [175, 98.4]; // 7.9" at 16:9
  const SEAM = 98.25; // where a controller meets the tablet
  const PAD = 117.5; // middle of a controller

  const shell = clay(colors.black);
  const key = clay(colors.graphite); // a shade lighter than the shell so the buttons read
  const rubber = clay(colors.jet, { finish: 'soft' });
  const blue = clay(colors.lightBlue, { finish: 'satin' });
  const coral = clay(colors.coral, { finish: 'satin' });
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── shell: tablet and both controllers share one silhouette ──────────────
  add(kit.slab(kit.rect(W, H, CORNER), D, { bevel: EDGE }), shell, [0, 0, 0]);
  add(kit.slab(kit.rect(SCREEN[0], SCREEN[1], 3.2), 1.2, { bevel: 0.4 }), glass({ aspect: SCREEN[0] / SCREEN[1] }), [0, 0, F - 0.25]);

  // coloured rails: a thin band wrapped around the body at each seam
  const rail = kit.slab(kit.rect(D + 0.2, H + 0.2, EDGE + 0.1), 1.9, { bevel: 0.25, axis: 'x' });
  add(rail, blue, [-SEAM, 0, 0]);
  add(rail, coral, [SEAM, 0, 0]);

  // ── sticks ───────────────────────────────────────────────────────────────
  const capProfile = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]];
  const stick = (x, y, accent) => parts.push(kit.group([
    kit.mesh(kit.ring(10.7, 7.7, 0.75, { bevel: 0.28, axis: 'z' }), accent),
    kit.mesh(kit.puck(7.7, 0.3, { bevel: 0, axis: 'z' }), dark),
    kit.mesh(kit.puck(4.4, 3.6, { bevel: 0.3, axis: 'z' }), rubber),
    kit.mesh(kit.lathe(capProfile, { axis: 'z' }), rubber),
  ], { at: [x, y, F] }));
  stick(-PAD, 21.5, blue);
  stick(PAD, -13, coral);

  // ── face buttons ─────────────────────────────────────────────────────────
  const round = kit.puck(4.05, 1.5, { bevel: 0.75, top: 0.3, axis: 'z' });
  const diamond = (x, y) => { for (const [dx, dy] of [[0, 8.7], [8.7, 0], [0, -8.7], [-8.7, 0]]) add(round, key, [x + dx, y + dy, F - 0.25]); };
  diamond(-PAD, -13); // directions
  diamond(PAD, 21.5); // A B X Y
  add(kit.slab(kit.pill(5.6, 1.8), 1.4, { bevel: 0.4 }), key, [-104.5, 46, F + 0.25]); // minus
  add(kit.slab(kit.plus(5.6, 1.8, 0.4), 1.4, { bevel: 0.4 }), key, [104.5, 46, F + 0.25]); // plus
  add(kit.slab(kit.rect(6.4, 6.4, 1.5), 1.4, { bevel: 0.45 }), key, [-109.5, -38, F + 0.2]); // capture
  add(kit.puck(3.5, 1.3, { bevel: 0.6, top: 0.2, axis: 'z' }), key, [109.5, -35.5, F - 0.2]); // home
  add(kit.ring(4.6, 3.9, 0.5, { bevel: 0.15, axis: 'z' }), key, [109.5, -35.5, F - 0.1]);
  add(kit.slab(kit.rect(6.2, 6.2, 1.6), 1.4, { bevel: 0.45 }), key, [109.5, -47, F + 0.2]); // C

  // ── shoulders ────────────────────────────────────────────────────────────
  // L / R: a slim bar that follows the top corner
  const bar = [];
  const arc = (radius, from, to) => { for (let a = from; from < to ? a <= to : a >= to; a += from < to ? 5 : -5) bar.push([116 + radius * Math.cos((a * Math.PI) / 180), 38 + radius * Math.sin((a * Math.PI) / 180)]); };
  bar.push([100, 55.3]);
  arc(17.3, 90, 20);
  arc(20.7, 20, 90);
  bar.push([100, 58.7]);
  const barRadii = bar.map((_, i) => (i === 0 || i === bar.length - 1 || i === 15 || i === 16 ? 1.2 : 0));
  const shoulder = kit.polygon(bar, barRadii, { segments: 4 });
  add(kit.extrude(shoulder, 7.4, { bevel: 1.1 }), key, [0, 0, -1.9]);
  add(kit.extrude(shoulder.mirror(), 7.4, { bevel: 1.1 }), key, [0, 0, -1.9]);
  // ZL / ZR: the triggers stand proud of the back
  const trigger = kit.slab(kit.rect(25, 20, [8.5, 8.5, 4, 4]), 7, { bevel: 2.4, dome: 1.3, axis: '-z' });
  add(trigger, key, [-113.5, 47.4, -F - 0.9]);
  add(trigger, key, [113.5, 47.4, -F - 0.9]);

  // ── top edge: power, volume, vent, card flap, ports ──────────────────────
  const TOP = H / 2;
  add(kit.slab(kit.pill(9, 2.8), 1.4, { bevel: 0.45, axis: 'y' }), key, [-80, TOP - 0.2, -0.4]);
  add(kit.slab(kit.pill(20, 2.8), 1.4, { bevel: 0.45, axis: 'y' }), key, [-60, TOP - 0.2, -0.4]);
  parts.push(kit.vents(kit.grid(13, 1, 3.3), { size: [1.7, 5.4], at: [-8, TOP, -0.3], rot: [-90, 0, 0] }));
  parts.push(kit.vents([[0, 0]], { size: [9.4, 3.4], at: [36, TOP, -0.3], rot: [-90, 0, 0] })); // USB-C
  parts.push(kit.vents([[0, 0]], { radius: 1.9, at: [56, TOP, -0.3], rot: [-90, 0, 0] })); // headphones
  add(kit.slab(kit.rect(27, 5.2, 1.4), 0.9, { bevel: 0.3, axis: 'y' }), key, [78, TOP - 0.15, -0.3]); // game card flap

  // ── back: kickstand, vents, releases ─────────────────────────────────────
  const stand = kit.polygon(
    [[-91, 18], [-91, -24], [91, -24], [91, 18], [84.5, 18], [84.5, -17.5], [-84.5, -17.5], [-84.5, 18]],
    [2.4, 7, 7, 2.4, 2.4, 3, 3, 2.4],
  );
  add(kit.extrude(stand, 1.1, { bevel: 0.4, axis: '-z' }), clay(colors.graphite, { finish: 'satin' }), [0, -27, -F - 0.1]);
  parts.push(kit.vents(kit.grid(9, 2, 3.4, 3.4), { size: [2.2, 1.5], at: [-46, 42, -F], rot: [0, 180, 0] }));
  parts.push(kit.vents(kit.grid(9, 2, 3.4, 3.4), { size: [2.2, 1.5], at: [46, 42, -F], rot: [0, 180, 0] }));
  const release = kit.slab(kit.pill(4.4, 9), 1.6, { bevel: 0.6, axis: '-z' });
  add(release, key, [-105.5, 20, -F - 0.2]);
  add(release, key, [105.5, 20, -F - 0.2]);

  return kit.group(parts);
}
