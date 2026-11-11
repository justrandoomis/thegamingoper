/** xbox-controller-blue — bright blue front shell on a white back. The model is in _xbox-pad.mjs. */
import { buildXboxPad, VIEWS } from './_xbox-pad.mjs';

export const views = VIEWS;
export const build = (kit) => buildXboxPad(kit, 'blue');
