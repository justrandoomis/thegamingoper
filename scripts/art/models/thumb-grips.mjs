/**
 * thumb-grips — a set of four silicone thumb-stick caps, each about 20 mm across and 10 mm tall
 * (the catalogue size is one cap): red, blue and green lying dish up, the violet one tipped
 * against them so that its grip dots face the camera. Soft rubber, hollow underneath.
 * The camera looks from a little higher than the house view, into the dished tops.
 */
export const views = { hero: { azimuth: 22, elevation: 30 } };

export function build(kit) {
  const { clay, colors } = kit;
  // One cap, spun from its profile [radius, height]: hollow underneath, a waist, a wide dished top.
  const profile = [
    [0, 6.3], [6.4, 6.3], [7.3, 5.7], [7.5, 4.6], [7.5, 0.9], [7.9, 0.2], [8.6, 0], [9.5, 0], [9.95, 0.4], [10, 1.1],
    [10, 2.6], [9.5, 4.2], [9.1, 5.6], [9.2, 6.9], [9.75, 8.1], [10.3, 8.9], [10.4, 9.5], [10.05, 9.95], [9.4, 10],
    [8.2, 9.62], [6.2, 9.1], [3.4, 8.72], [0, 8.6],
  ];
  const body = kit.lathe(profile, { segments: 72 });
  const dish = (r) => 8.6 + 1.02 * (r / 8.2) ** 2; // height of the dished top at radius r
  const dot = kit.puck(0.82, 0.62, { bevel: 0.36, top: 0.12, segments: 20, axis: 'z' });
  const dots = [[0, 0, dish(0) - 0.12], ...kit.radial(6, 3.1).map(([x, y]) => [x, y, dish(3.1) - 0.12]), ...kit.radial(12, 6.1, { start: 15 }).map(([x, y]) => [x, y, dish(6.1) - 0.12])];

  const cap = (color, placement) => {
    const rubber = clay(color, { finish: 'soft' });
    return kit.group([kit.mesh(body, rubber), kit.stamp(dot, rubber, dots, { rot: [-90, 0, 0] })], placement);
  };

  // The violet cap stands on its rim, tipped back 62° against the green one behind it.
  const TIP = 62, a = (TIP * Math.PI) / 180;
  const lift = 10 * Math.cos(a); // a tipped cap rests on the low point of its foot
  return kit.group([
    cap(colors.red, { at: [-13.4, 0, 8.5], rot: [0, 20, 0] }),
    cap(colors.blue, { at: [9.4, 0, 14], rot: [0, -35, 0] }),
    cap(colors.green, { at: [-3.5, 0, -13.5], rot: [0, 80, 0] }),
    cap(colors.violet, { at: [20.5, lift, -8.4], rot: [TIP, -24, 0] }),
  ]);
}
