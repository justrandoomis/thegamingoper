/**
 * screen-protector — 190 × 110 × 0.4 mm.
 * A sheet of tempered glass for a handheld's screen, standing on its long edge and tilted back:
 * see-through blue-tinted glass, a pale polished rim that catches the light (the bright edge),
 * the two slanted streaks of a reflection, and the pull tab of its backing film at one corner.
 * The sheet is drawn 1 mm thick so that its edge exists at all — at 0.4 mm it would be thinner
 * than a pixel.
 */
export const views = { hero: { azimuth: 26, elevation: 16 } };

export function build(kit) {
  const { clay, clear, colors } = kit;
  const W = 190, H = 110, T = 1;
  const CORNER = 7;
  const parts = [];

  // ── the glass: see-through. It does cast its shadow: the sheet leans, so the shadow lies
  //    behind it and is seen through the glass, which is what makes it sit on the floor. ──
  parts.push(kit.mesh(kit.slab(kit.rect(W - 0.6, H - 0.6, CORNER - 0.3), T * 0.8, { bevel: 0.2 }), clear('#4f9fc0', { opacity: 0.36 })));

  // ── the polished edge: an opaque pale rim all round ──────────────────────
  const rim = kit.extrude(kit.rect(W, H, CORNER, { segments: 12 }), T, { bevel: 0.34, holes: [kit.rect(W - 2.3, H - 2.3, CORNER - 1.15, { segments: 12 })] });
  parts.push(kit.mesh(rim, clay('#e4f6f4', { finish: 'satin' })));

  // ── reflection: two slanted streaks lying on the glass ───────────────────
  const lean = 34; // how far the top of a streak is to the right of its foot
  const streak = (x, width, opacity) => {
    const y = H / 2 - 1.6;
    const band = kit.polygon([[x, -y], [x + width, -y], [x + width + lean, y], [x + lean, y]], 0.4, { segments: 3 });
    parts.push(kit.mesh(kit.slab(band, 0.12, { bevel: 0 }), clear('#ffffff', { opacity }), { at: [0, 0, T / 2 + 0.02], cast: false }));
  };
  streak(-52, 30, 0.34);
  streak(-12, 9, 0.24);

  // ── pull tab of the backing film, top right ──────────────────────────────
  parts.push(kit.mesh(kit.slab(kit.rect(17, 13, [1, 5.5, 5.5, 1]), 0.7, { bevel: 0.25 }), clay(colors.lightBlue, { finish: 'satin' }), { at: [W / 2 + 0.9, H / 2 - 17, -T / 2 - 0.2] }));

  // stand it on its long edge, tilted back
  return kit.group([kit.group(parts, { at: [0, H / 2, 0] })], { rot: [-17, 0, 0] });
}
