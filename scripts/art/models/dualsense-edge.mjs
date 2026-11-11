/** dualsense-edge — white shell, glossy black face plate and touch pad, function keys under the sticks. The model is in _dualsense.mjs. */
import { buildDualSense, VIEWS } from './_dualsense.mjs';

export const views = VIEWS;
export const build = (kit) => buildDualSense(kit, 'edge');
