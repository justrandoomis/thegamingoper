/** dualsense-red — deep red shell with a black centre. The model is in _dualsense.mjs. */
import { buildDualSense, VIEWS } from './_dualsense.mjs';

export const views = VIEWS;
export const build = (kit) => buildDualSense(kit, 'red');
