/**
 * game-<slug> — the physical case of every game in catalog.json → games.items.
 * One file for the whole family: `options.params.slug` is the game, `options.item` its catalogue
 * entry ({ title, platform, mm }). The case itself is one parametric model per platform
 * (`_game-case.mjs`): a red case for Nintendo, a clear blue-topped one for PlayStation, a green
 * one for Xbox. The cover is generated type on an abstract pattern (`_game-cover.mjs`) — no real
 * cover art, characters, rating marks or logos.
 */
import { buildGameCase } from './_game-case.mjs';

// A little more frontal than the house hero view, so the title on the cover stays easy to read.
export const views = { hero: { azimuth: 24, elevation: 15 } };

export async function build(kit, options) {
  const slug = options.params.slug ?? options.key.replace(/^game-/, '');
  let { item, platformColors } = options;
  if (!item?.title || !item?.platform || !platformColors?.[item.platform]) {
    // the live preview page passes no catalogue entry: look the game up ourselves
    const catalog = await (await fetch(new URL('../catalog.json', import.meta.url))).json();
    const game = catalog.games.items.find((entry) => entry.slug === slug);
    if (!game) throw new Error(`game-${slug} is not in catalog.json → games.items`);
    item = game;
    platformColors = catalog.platformColors;
  }
  return buildGameCase(kit, { platform: item.platform, title: item.title, slug, color: platformColors[item.platform] });
}
