/** xbox-elite-2 — black, dark metal sticks and d-pad, rubberised grips. The model is in _xbox-pad.mjs. */
import { buildXboxPad, VIEWS } from './_xbox-pad.mjs';

export const views = VIEWS;
export const build = (kit) => buildXboxPad(kit, 'elite');
