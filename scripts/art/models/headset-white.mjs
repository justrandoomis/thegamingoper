/** headset-white — white shell, black ear cushions, retractable microphone. The model is in _headset.mjs. */
import { buildHeadset, VIEWS } from './_headset.mjs';

export const views = VIEWS;
export const build = (kit) => buildHeadset(kit, 'white');
