/** dualsense-white — white shell, black centre and sticks. The model is in _dualsense.mjs. */
import { buildDualSense, VIEWS } from './_dualsense.mjs';

export const views = VIEWS;
export const build = (kit) => buildDualSense(kit, 'white');
