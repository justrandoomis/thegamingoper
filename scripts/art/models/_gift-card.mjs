/**
 * Wallet top-up card — 86 × 54 × 1 mm, the parametric model behind `gift-card-playstation`,
 * `gift-card-nintendo` and `gift-card-xbox`, which differ only in colour (a helper file: names
 * starting with "_" never match a catalogue key).
 *
 * A plastic card standing on its long edge and leaning back, so its face is towards the camera.
 * The face is generated print: the platform colour, plain rings in tones of it, and the words
 * "Wallet top-up" — nothing else. No logos, no brand names, no values.
 */
import { displayFace, drawText, fitText, paintSteady, printed, tones } from './_print.mjs';

export const views = { hero: { azimuth: 24, elevation: 16 } };

const W = 86, H = 54, T = 1; // the card
const PX_PER_MM = 20;

/** The printed face on a 2D canvas of `w` × `h` pixels (86 : 54). */
export function paintCardFace(ctx, w, h, { color }) {
  const t = tones(color);
  ctx.fillStyle = t.base;
  ctx.fillRect(0, 0, w, h);

  // plain rings, cut off by the right-hand edge: light at the heart, dark where the words cross them
  const cx = w * 0.8, cy = h * 0.4, step = w * 0.08;
  const ring = [t.pale, t.lift, t.base, t.shade, t.base, t.shade];
  for (let k = ring.length; k >= 1; k--) {
    ctx.fillStyle = ring[k - 1];
    ctx.beginPath();
    ctx.arc(cx, cy, k * step, 0, Math.PI * 2);
    ctx.fill();
  }

  // the words, large, at the lower left
  const face = displayFace(ctx);
  const side = w * 0.075;
  const fit = fitText(ctx, 'Wallet top-up', { face, maxWidth: w * 0.4, maxHeight: h * 0.46, upper: false, tracking: 0.02, gap: 0.26 });
  const top = h - side - fit.descent - fit.height;
  ctx.fillStyle = t.pale;
  ctx.fillRect(side, top - side * 0.62, w * 0.075, Math.max(2, w * 0.0085)); // a short rule above the words
  drawText(ctx, fit, face, side, top, '#ffffff');
}

/** @param options  { color } — the platform colour (#rrggbb) */
export function buildGiftCard(kit, { color }) {
  const { clay, colors } = kit;
  const t = tones(color);
  const parts = [];
  const add = (geometry, material, at) => parts.push(kit.mesh(geometry, material, { at }));

  // white plastic core: it shows as a fine light line all round the edge
  add(kit.slab(kit.rect(W, H, 3.4), T, { bevel: 0.38 }), clay(colors.white, { finish: 'satin' }), [0, 0, 0]);

  // printed face
  const face = paintSteady(kit, W * PX_PER_MM, H * PX_PER_MM, (ctx, w, h) => paintCardFace(ctx, w, h, { color }));
  add(kit.slab(kit.rect(W - 0.7, H - 0.7, 3.05), 0.3, { bevel: 0.1 }), printed(kit, face), [0, 0, T / 2 - 0.07]);

  // back: plain colour, a pale panel for the code and a silver scratch-off strip over part of it
  add(kit.slab(kit.rect(W - 0.7, H - 0.7, 3.05), 0.3, { bevel: 0.1, axis: '-z' }), clay(t.shade, { finish: 'satin' }), [0, 0, -T / 2 + 0.07]);
  add(kit.slab(kit.rect(58, 9, 1.2), 0.3, { bevel: 0.08, axis: '-z' }), clay(colors.white), [-7, -12, -T / 2 - 0.02]);
  add(kit.slab(kit.rect(34, 6.4, 0.9), 0.3, { bevel: 0.08, axis: '-z' }), kit.metal(colors.silver, { roughness: 0.5 }), [3, -12, -T / 2 - 0.1]);

  // stand it on its long edge, leaning back
  return kit.group([kit.group(parts, { at: [0, H / 2, 0] })], { rot: [-15, 0, 0] });
}
