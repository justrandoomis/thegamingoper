/**
 * gift-card-nintendo — 86 × 54 × 1 mm wallet top-up card, red.
 * The shared card model is `_gift-card.mjs`; this key only chooses the colour.
 */
import { buildGiftCard, views } from './_gift-card.mjs';

export { views };

export function build(kit, options) {
  return buildGiftCard(kit, { color: options.platformColors.nintendo ?? kit.colors.nintendo });
}
