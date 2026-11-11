/**
 * switch-lite — 208 × 91.1 × 13.9 mm.
 * One-piece handheld: turquoise body, light grey sticks and buttons, a real d-pad on the left,
 * 5.5-inch screen behind a black front panel. No logos: plain shapes on the buttons.
 */
export const views = {
  hero: { azimuth: 28, elevation: 17 },
};

export function build(kit) {
  const { clay, glass, hollow, colors } = kit;
  const W = 208, H = 91.1, D = 13.9, F = D / 2; // F: the front surface
  const CORNER = 15, EDGE = 3.6;
  const PANEL = [137, 79]; // the black front panel
  const SCREEN = [121.8, 68.5]; // 5.5" at 16:9
  const PAD = 86.5; // middle of each control column
  const LIGHT = '#dcdddb'; // light grey: between the kit's silver and white

  const shell = clay(colors.turquoise);
  const key = clay(LIGHT, { finish: 'satin' });
  const rubber = clay(LIGHT, { finish: 'soft' });
  const dark = hollow();
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  // ── body and screen ──────────────────────────────────────────────────────
  add(kit.slab(kit.rect(W, H, CORNER), D, { bevel: EDGE }), shell, [0, 0, 0]);
  add(kit.slab(kit.rect(PANEL[0], PANEL[1], 4), 1.2, { bevel: 0.45 }), clay(colors.black), [0, 0, F - 0.3]);
  add(kit.slab(kit.rect(SCREEN[0], SCREEN[1], 2), 1, { bevel: 0.3 }), glass({ aspect: SCREEN[0] / SCREEN[1] }), [0, 0, F + 0.05]);

  // ── sticks ───────────────────────────────────────────────────────────────
  const cap = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]]
    .map(([r, y]) => [r * 0.9, y]);
  const stick = (x, y) => parts.push(kit.group([
    kit.mesh(kit.ring(9.5, 7.2, 0.7, { bevel: 0.3, axis: 'z' }), shell),
    kit.mesh(kit.puck(7.3, 0.3, { bevel: 0, axis: 'z' }), dark),
    kit.mesh(kit.puck(4.1, 3.6, { bevel: 0.3, axis: 'z' }), rubber),
    kit.mesh(kit.lathe(cap, { axis: 'z' }), rubber),
  ], { at: [x, y, F] }));
  stick(-PAD, 18.5);
  stick(PAD, -10.5);

  // ── d-pad and face buttons ───────────────────────────────────────────────
  add(kit.slab(kit.plus(20, 6.6, 1.3), 2.2, { bevel: 0.8, dome: 0.35 }), key, [-PAD, -10.5, F + 0.35]);
  const round = kit.puck(3.6, 1.5, { bevel: 0.7, top: 0.3, axis: 'z' });
  for (const [dx, dy] of [[0, 7.6], [7.6, 0], [0, -7.6], [-7.6, 0]]) add(round, key, [PAD + dx, 18.5 + dy, F - 0.25]); // A B X Y
  add(kit.slab(kit.pill(5.2, 1.8), 1.4, { bevel: 0.4 }), key, [-75.5, 35.5, F + 0.25]); // minus
  add(kit.slab(kit.plus(5.2, 1.8, 0.4), 1.4, { bevel: 0.4 }), key, [75.5, 35.5, F + 0.25]); // plus
  add(kit.slab(kit.rect(5.8, 5.8, 1.4), 1.4, { bevel: 0.45 }), key, [-77.5, -32.5, F + 0.2]); // capture
  add(kit.puck(2.8, 1.3, { bevel: 0.6, top: 0.2, axis: 'z' }), key, [77.5, -32.5, F - 0.2]); // home
  add(kit.ring(3.9, 3.2, 0.45, { bevel: 0.15, axis: 'z' }), key, [77.5, -32.5, F - 0.1]);

  // ── shoulders ────────────────────────────────────────────────────────────
  // L / R: a slim bar that follows the top corner
  const CX = W / 2 - CORNER, CY = H / 2 - CORNER, INNER = CORNER - 2.8, OUTER = CORNER + 0.6;
  const bar = [];
  const arc = (radius, from, to) => { for (let a = from; from < to ? a <= to : a >= to; a += from < to ? 5 : -5) bar.push([CX + radius * Math.cos((a * Math.PI) / 180), CY + radius * Math.sin((a * Math.PI) / 180)]); };
  bar.push([CX - 16, CY + INNER]);
  arc(INNER, 90, 20);
  arc(OUTER, 20, 90);
  bar.push([CX - 16, CY + OUTER]);
  const barRadii = bar.map((_, i) => (i === 0 || i === bar.length - 1 || i === 15 || i === 16 ? 1.2 : 0));
  const shoulder = kit.polygon(bar, barRadii, { segments: 4 });
  add(kit.extrude(shoulder, 7.2, { bevel: 1.1 }), key, [0, 0, -1.8]);
  add(kit.extrude(shoulder.mirror(), 7.2, { bevel: 1.1 }), key, [0, 0, -1.8]);
  // ZL / ZR: the triggers stand proud of the back
  const trigger = kit.slab(kit.rect(22, 16, [7, 7, 3.5, 3.5]), 6.4, { bevel: 2.2, dome: 1.2, axis: '-z' });
  add(trigger, key, [-(PAD - 2), 36.5, -F - 0.8]);
  add(trigger, key, [PAD - 2, 36.5, -F - 0.8]);

  // ── top edge: power, volume, vent, headphones, card flap ─────────────────
  const TOP = H / 2;
  add(kit.slab(kit.pill(8, 2.8), 1.4, { bevel: 0.45, axis: 'y' }), key, [-58, TOP - 0.2, -0.4]);
  add(kit.slab(kit.pill(18, 2.8), 1.4, { bevel: 0.45, axis: 'y' }), key, [-39, TOP - 0.2, -0.4]);
  parts.push(kit.vents(kit.grid(11, 1, 3.3), { size: [1.7, 5.4], at: [-2, TOP, -0.3], rot: [-90, 0, 0] }));
  parts.push(kit.vents([[0, 0]], { radius: 1.9, at: [30, TOP, -0.3], rot: [-90, 0, 0] })); // headphones
  add(kit.slab(kit.rect(25, 5, 1.4), 0.9, { bevel: 0.3, axis: 'y' }), clay(colors.turquoise, { finish: 'satin' }), [53, TOP - 0.15, -0.3]); // game card flap

  // ── back: two rows of vent slots ─────────────────────────────────────────
  parts.push(kit.vents(kit.grid(9, 2, 3.4, 3.4), { size: [2.2, 1.5], at: [-34, 34, -F], rot: [0, 180, 0] }));
  parts.push(kit.vents(kit.grid(9, 2, 3.4, 3.4), { size: [2.2, 1.5], at: [34, 34, -F], rot: [0, 180, 0] }));

  return kit.group(parts);
}
