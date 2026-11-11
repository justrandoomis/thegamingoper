/**
 * gift-card-playstation — 86 × 54 × 1 mm wallet top-up card, blue.
 * The shared card model is `_gift-card.mjs`; this key only chooses the colour.
 */
import { buildGiftCard, views } from './_gift-card.mjs';

export { views };

export function build(kit, options) {
  return buildGiftCard(kit, { color: options.platformColors.playstation ?? kit.colors.playstation });
}
