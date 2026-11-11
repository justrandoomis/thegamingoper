/** headset-black — black, with a green ring on each cup. The model is in _headset.mjs. */
import { buildHeadset, VIEWS } from './_headset.mjs';

export const views = VIEWS;
export const build = (kit) => buildHeadset(kit, 'black');
