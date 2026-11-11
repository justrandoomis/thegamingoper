/**
 * part-battery — 90 × 50 × 8 mm.
 * Flat lithium battery pack in a black wrap, standing on its long edge and leaning back. Amber
 * tape over the end where the protection board sits; a short three-wire lead (red, black, white)
 * comes out of that end, curls forward and ends in a small white plug lying on the floor.
 * A blank label with plain bars on the face — no brand, no rating print.
 */
export const views = { hero: { azimuth: 30, elevation: 18 } };

export function build(kit) {
  const { clay, colors } = kit;
  const W = 90, H = 50, D = 7.6, F = D / 2;
  const LEAN = 15, a = (LEAN * Math.PI) / 180;
  const parts = [];
  const pack = []; // everything that leans with the pack
  const add = (geometry, material, at, rot) => pack.push(kit.mesh(geometry, material, { at, rot }));

  // ── the pack ─────────────────────────────────────────────────────────────
  add(kit.slab(kit.rect(W, H, 3.4), D, { bevel: 2.5, dome: 0.5, domeBack: 0.5, rings: 12 }), clay(colors.black, { finish: 'satin' }), [0, 0, 0]);
  // amber tape wrapped round the wire end
  add(kit.slab(kit.rect(15, H + 0.5, 3.6), D + 0.7, { bevel: 2.7, rings: 6 }), clay('#dba23a', { finish: 'satin' }), [W / 2 - 7.3, 0, 0]);
  // a blank label
  add(kit.slab(kit.rect(48, 22, 1.6), 0.4, { bevel: 0.12 }), clay('#d8d7d2'), [-11, -3, F + 0.36]);
  const bar = clay(colors.slate);
  for (const [x, y, length] of [[-24.5, 3.2, 17], [-20.5, -0.4, 25], [-22, -4, 22], [-25.5, -8.8, 15]]) {
    add(kit.slab(kit.pill(length, 1.5), 0.3, { bevel: 0.1 }), bar, [x, y - 0.1, F + 0.52]);
  }
  add(kit.slab(kit.rect(9, 9, 1.4), 0.3, { bevel: 0.1 }), bar, [5.5, -5.9, F + 0.52]);

  // the pack stands on its long edge and leans back
  const leaning = kit.group([kit.group(pack, { at: [0, H / 2, 0] })], { rot: [-LEAN, 0, 0] });
  parts.push(leaning);
  /** Where a point of the upright pack ([x, height above its foot, z]) ends up once it leans. */
  const leaned = ([x, y, z]) => [x, y * Math.cos(a) + z * Math.sin(a), -y * Math.sin(a) + z * Math.cos(a)];

  // ── lead: three wires from the taped end to a plug on the floor ──────────
  const PLUG = [42.5, 1.9, 27.5]; // middle of the plug
  const exit = leaned([W / 2 - 0.4, H / 2 + 7, 0]);
  const spine = [
    exit, [exit[0] + 2.5, exit[1] - 0.2, exit[2] + 0.5], [exit[0] + 3.3, exit[1] - 2.6, exit[2] + 3.8], [exit[0] + 2.8, 21, 2.5],
    [exit[0] + 1.4, 12, 10], [PLUG[0] + 0.8, 5.2, 16], [PLUG[0] + 0.2, 2.5, 20.5], [PLUG[0], 2, PLUG[2] - 2.5],
  ];
  const across = leaned([0, 0, 1]); // across the thickness of the leaning pack
  for (const [i, color] of ['#d9342b', colors.jet, colors.white].entries()) {
    const k = i - 1; // −1, 0, 1: side by side across the end face at the start, across the plug at the end
    const wire = spine.map(([x, y, z], n) => {
      const t = n / (spine.length - 1), spread = 1.9 * k;
      return [x + spread * t, y - spread * across[1] * (1 - t), z - spread * across[2] * (1 - t)];
    });
    parts.push(kit.mesh(kit.tube(wire, 0.82, { segments: 10 }), clay(color, { finish: 'soft' })));
  }
  parts.push(kit.mesh(kit.box(8.4, 3.8, 6.4, 0.9), clay(colors.white, { finish: 'satin' }), { at: PLUG }));
  parts.push(kit.vents(kit.grid(3, 1, 2.1), { size: [1.25, 1.7], at: [PLUG[0], PLUG[1] + 0.1, PLUG[2] + 3.2] }));

  return kit.group(parts);
}
