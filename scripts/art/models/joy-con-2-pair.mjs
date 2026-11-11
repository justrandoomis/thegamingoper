/**
 * joy-con-2-pair — 116 × 116 × 30 mm: two detached Joy-Con 2 controllers standing side by side.
 * Black shells; the left one has a light blue stick ring and inner rail, the right one coral.
 * Same sizes and parts as the controllers on the switch-2 model, so the two pictures match.
 * No logos: plain shapes on the buttons.
 */
export const views = { hero: { azimuth: 26, elevation: 17 } };

export function build(kit) {
  const { clay, hollow, colors } = kit;
  const W = 37.75, H = 116, D = 13.9, F = D / 2; // one controller; F: its front surface
  const CORNER = 20, EDGE = 3.2;
  const GAP = 31; // between the two inner rails
  const IN = W / 2; // local x of the inner side of a right-hand controller is −IN

  const shell = clay(colors.black);
  const key = clay(colors.graphite); // a shade lighter than the shell so the buttons read
  const rubber = clay(colors.jet, { finish: 'soft' });
  const dark = hollow();

  const round = kit.puck(4.05, 1.5, { bevel: 0.75, top: 0.3, axis: 'z' });
  const capProfile = [[0, 3.1], [6.3, 3.1], [7.7, 3.5], [8.4, 4.2], [8.6, 4.9], [8.4, 5.6], [7.8, 6.1], [7, 6.25], [6.2, 6.05], [4.6, 5.65], [2.6, 5.4], [0, 5.3]];

  /**
   * The right-hand controller, modelled round its own middle; the left-hand one is its mirror
   * image with the other button set. `side` is +1 for right, −1 for left.
   */
  const controller = (side, accentColour) => {
    const accent = clay(accentColour, { finish: 'satin' });
    const parts = [];
    const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at: [side * at[0], at[1], at[2]], rot }));

    // body: square inner corners where it meets the console, big round outer corners
    const outline = kit.rect(W, H, side > 0 ? [2.4, CORNER, CORNER, 2.4] : [CORNER, 2.4, 2.4, CORNER]);
    add(kit.slab(outline, D, { bevel: EDGE }), shell, [0, 0, 0]);

    // inner side: the coloured rail, SL / SR keys and the connector
    add(kit.slab(kit.rect(D + 0.2, H + 0.2, EDGE + 0.1), 1.9, { bevel: 0.25, axis: 'x' }), accent, [-IN - 0.6, 0, 0]);
    const sideKey = kit.slab(kit.pill(4.4, 19), 1.7, { bevel: 0.55, axis: side > 0 ? '-x' : 'x' });
    add(sideKey, accent, [-IN - 1.75, 29, 0]);
    add(sideKey, accent, [-IN - 1.75, -29, 0]);
    add(kit.slab(kit.rect(5.4, 13, 1.4), 1, { bevel: 0.3, axis: side > 0 ? '-x' : 'x' }), key, [-IN - 1.7, 0, 0]);
    parts.push(kit.vents([[0, 0]], { size: [2.6, 9.4], at: [side * (-IN - 2.2), 0, 0], rot: [0, -side * 90, 0] }));

    // stick
    const stickAt = side > 0 ? -13 : 21.5;
    parts.push(kit.group([
      kit.mesh(kit.ring(10.7, 7.7, 0.75, { bevel: 0.28, axis: 'z' }), accent),
      kit.mesh(kit.puck(7.7, 0.3, { bevel: 0, axis: 'z' }), dark),
      kit.mesh(kit.puck(4.4, 3.6, { bevel: 0.3, axis: 'z' }), rubber),
      kit.mesh(kit.lathe(capProfile, { axis: 'z' }), rubber),
    ], { at: [side * 0.4, stickAt, F] }));

    // four round keys in a diamond: A B X Y on the right, directions on the left
    const diamondAt = side > 0 ? 21.5 : -13;
    for (const [dx, dy] of [[0, 8.7], [8.7, 0], [0, -8.7], [-8.7, 0]]) add(round, key, [0.4 + dx, diamondAt + dy, F - 0.25]);

    if (side > 0) {
      add(kit.slab(kit.plus(5.6, 1.8, 0.4), 1.4, { bevel: 0.4 }), key, [-12.6, 46, F + 0.25]); // plus
      add(kit.puck(3.5, 1.3, { bevel: 0.6, top: 0.2, axis: 'z' }), key, [-7.6, -35.5, F - 0.2]); // home
      add(kit.ring(4.6, 3.9, 0.5, { bevel: 0.15, axis: 'z' }), key, [-7.6, -35.5, F - 0.1]);
      add(kit.slab(kit.rect(6.2, 6.2, 1.6), 1.4, { bevel: 0.45 }), key, [-7.6, -47, F + 0.2]); // C
    } else {
      add(kit.slab(kit.pill(5.6, 1.8), 1.4, { bevel: 0.4 }), key, [-12.6, 46, F + 0.25]); // minus
      add(kit.slab(kit.rect(6.4, 6.4, 1.5), 1.4, { bevel: 0.45 }), key, [-7.6, -38, F + 0.2]); // capture
    }

    // shoulder key: a slim bar that follows the top outer corner; the trigger stands proud of the back
    const bar = [];
    const arc = (radius, from, to) => { for (let a = from; from < to ? a <= to : a >= to; a += from < to ? 5 : -5) bar.push([-1.1 + radius * Math.cos((a * Math.PI) / 180), 38 + radius * Math.sin((a * Math.PI) / 180)]); };
    bar.push([-17.1, 55.3]);
    arc(17.3, 90, 20);
    arc(20.7, 20, 90);
    bar.push([-17.1, 58.7]);
    const barRadii = bar.map((_, i) => (i === 0 || i === bar.length - 1 || i === 15 || i === 16 ? 1.2 : 0));
    const shoulder = kit.polygon(bar, barRadii, { segments: 4 });
    parts.push(kit.mesh(kit.extrude(side > 0 ? shoulder : shoulder.mirror(), 7.4, { bevel: 1.1 }), key, { at: [0, 0, -1.9] }));
    add(kit.slab(kit.rect(25, 20, [8.5, 8.5, 4, 4]), 7, { bevel: 2.4, dome: 1.3, axis: '-z' }), key, [-3.6, 47.4, -F - 0.9]);
    add(kit.slab(kit.pill(4.4, 9), 1.6, { bevel: 0.6, axis: '-z' }), key, [-12.4, 20, -F - 0.2]); // release

    return kit.group(parts, { at: [side * (GAP / 2 + IN + 2.6), 0, 0] });
  };

  return kit.group([controller(-1, colors.lightBlue), controller(1, colors.coral)]);
}
