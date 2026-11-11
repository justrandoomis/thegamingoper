/**
 * switch-oled — 242 × 102 × 13.9 mm, Joy-Con attached.
 * Black tablet with a 7-inch screen between two white controllers; sticks, buttons and shoulder
 * buttons are dark. No logos: plain shapes on the buttons.
 */
export const views = {
  hero: { azimuth: 28, elevation: 17 },
};

export function build(kit) {
  const { clay, glass, hollow, colors } = kit;
  const W = 242, H = 102, D = 13.9, F = D / 2; // F: the front surface
  const TABLET = 176; // the console between the controllers
  const SEAM = TABLET / 2; // where a controller meets the tablet
  const GAP = 0.6; // the slit between them, over a dark rail
  const CON = (W - TABLET) / 2 - GAP; // width of a controller shell
  const PAD = SEAM + GAP + CON / 2; // middle of a controller
  const CORNER = 17;
  const SCREEN = [155, 87.2]; // 7" at 16:9

  const shell = clay(colors.black);
  const white = clay(colors.white);
  const key = clay(colors.black, { finish: 'satin' }); // buttons on the white controllers
  const trim = clay(colors.graphite); // buttons on the black tablet: a shade lighter so they read
  const rubber = clay(colors.jet, { finish: 'soft' });
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── tablet ───────────────────────────────────────────────────────────────
  add(kit.slab(kit.rect(TABLET, H, 3), D, { bevel: 2.2 }), shell, [0, 0, 0]);
  add(kit.slab(kit.rect(SCREEN[0], SCREEN[1], 2.6), 1.2, { bevel: 0.4 }), glass({ aspect: SCREEN[0] / SCREEN[1] }), [0, 0, F - 0.25]);

  // ── controllers: white shells, each on a dark rail ───────────────────────
  const joyCon = kit.mesh(kit.slab(kit.rect(CON, H, [1.6, CORNER, CORNER, 1.6]), D, { bevel: 3.2 }), white, { at: [PAD, 0, 0] });
  parts.push(joyCon, kit.mirrorX(joyCon));
  const rail = kit.slab(kit.rect(D - 2.6, H - 2.6, 2), 2.6, { bevel: 0.3, axis: 'x' });
  add(rail, rubber, [SEAM + GAP / 2, 0, 0]);
  add(rail, rubber, [-SEAM - GAP / 2, 0, 0]);

  // ── sticks ───────────────────────────────────────────────────────────────
  const cap = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]]
    .map(([r, y]) => [r * 0.92, y]);
  const stick = (x, y) => parts.push(kit.group([
    kit.mesh(kit.ring(9.6, 7.3, 0.7, { bevel: 0.3, axis: 'z' }), white),
    kit.mesh(kit.puck(7.4, 0.3, { bevel: 0, axis: 'z' }), dark),
    kit.mesh(kit.puck(4.2, 3.6, { bevel: 0.3, axis: 'z' }), rubber),
    kit.mesh(kit.lathe(cap, { axis: 'z' }), rubber),
  ], { at: [x, y, F] }));
  stick(-PAD, 21);
  stick(PAD, -11);

  // ── face buttons ─────────────────────────────────────────────────────────
  const round = kit.puck(3.7, 1.5, { bevel: 0.7, top: 0.3, axis: 'z' });
  const diamond = (x, y) => { for (const [dx, dy] of [[0, 7.9], [7.9, 0], [0, -7.9], [-7.9, 0]]) add(round, key, [x + dx, y + dy, F - 0.25]); };
  diamond(-PAD, -11); // directions
  diamond(PAD, 21); // A B X Y
  add(kit.slab(kit.pill(5.4, 1.8), 1.4, { bevel: 0.4 }), key, [-(SEAM + 8.6), 41.5, F + 0.25]); // minus
  add(kit.slab(kit.plus(5.4, 1.8, 0.4), 1.4, { bevel: 0.4 }), key, [SEAM + 8.6, 41.5, F + 0.25]); // plus
  add(kit.slab(kit.rect(6, 6, 1.4), 1.4, { bevel: 0.45 }), key, [-(PAD - 3.6), -33.5, F + 0.2]); // capture
  add(kit.puck(3, 1.3, { bevel: 0.6, top: 0.2, axis: 'z' }), key, [PAD - 3.6, -33.5, F - 0.2]); // home
  add(kit.ring(4.1, 3.3, 0.5, { bevel: 0.15, axis: 'z' }), clay(colors.slate), [PAD - 3.6, -33.5, F - 0.1]);

  // ── shoulders ────────────────────────────────────────────────────────────
  // L / R: a slim bar that follows the top corner
  const CX = W / 2 - CORNER, CY = H / 2 - CORNER, INNER = CORNER - 2.8, OUTER = CORNER + 0.6;
  const bar = [];
  const arc = (radius, from, to) => { for (let a = from; from < to ? a <= to : a >= to; a += from < to ? 5 : -5) bar.push([CX + radius * Math.cos((a * Math.PI) / 180), CY + radius * Math.sin((a * Math.PI) / 180)]); };
  bar.push([SEAM + 4, CY + INNER]);
  arc(INNER, 90, 20);
  arc(OUTER, 20, 90);
  bar.push([SEAM + 4, CY + OUTER]);
  const barRadii = bar.map((_, i) => (i === 0 || i === bar.length - 1 || i === 15 || i === 16 ? 1.2 : 0));
  const shoulder = kit.polygon(bar, barRadii, { segments: 4 });
  add(kit.extrude(shoulder, 7.2, { bevel: 1.1 }), key, [0, 0, -1.8]);
  add(kit.extrude(shoulder.mirror(), 7.2, { bevel: 1.1 }), key, [0, 0, -1.8]);
  // ZL / ZR: the triggers stand proud of the back
  const trigger = kit.slab(kit.rect(22, 18, [7.5, 7.5, 3.5, 3.5]), 6.6, { bevel: 2.2, dome: 1.2, axis: '-z' });
  add(trigger, key, [-(PAD - 1.5), 41, -F - 0.8]);
  add(trigger, key, [PAD - 1.5, 41, -F - 0.8]);

  // ── top edge: power, volume, vent, headphones, card flap ─────────────────
  const TOP = H / 2;
  add(kit.slab(kit.pill(8, 2.8), 1.4, { bevel: 0.45, axis: 'y' }), trim, [-70, TOP - 0.2, -0.4]);
  add(kit.slab(kit.pill(19, 2.8), 1.4, { bevel: 0.45, axis: 'y' }), trim, [-50, TOP - 0.2, -0.4]);
  parts.push(kit.vents(kit.grid(12, 1, 3.3), { size: [1.7, 5.4], at: [-4, TOP, -0.3], rot: [-90, 0, 0] }));
  parts.push(kit.vents([[0, 0]], { radius: 1.9, at: [34, TOP, -0.3], rot: [-90, 0, 0] })); // headphones
  add(kit.slab(kit.rect(26, 5, 1.4), 0.9, { bevel: 0.3, axis: 'y' }), trim, [60, TOP - 0.15, -0.3]); // game card flap

  // ── back: the wide stand and the controller releases ─────────────────────
  add(kit.slab(kit.rect(TABLET - 10, 46, [2, 2, 5, 5]), 1.1, { bevel: 0.4, axis: '-z' }), clay(colors.graphite, { finish: 'satin' }), [0, -24, -F - 0.1]);
  const release = kit.slab(kit.pill(4.2, 8.4), 1.6, { bevel: 0.6, axis: '-z' });
  add(release, key, [-(SEAM + 7), 20, -F - 0.2]);
  add(release, key, [SEAM + 7, 20, -F - 0.2]);

  return kit.group(parts);
}
