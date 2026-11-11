/** xbox-controller-white — white shell, black sticks, d-pad and buttons. The model is in _xbox-pad.mjs. */
import { buildXboxPad, VIEWS } from './_xbox-pad.mjs';

export const views = VIEWS;
export const build = (kit) => buildXboxPad(kit, 'white');
