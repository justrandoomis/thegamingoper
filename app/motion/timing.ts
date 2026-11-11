/**
 * Spring presets as Web Animations timing, read from the generated CSS tokens (--motion-spring-*), so script and
 * stylesheet can never disagree and the spring solver stays out of the always-loaded bundle.
 *
 *   element.animate([{ scale: 0.94 }, { scale: 1 }], springTiming("inflate"));
 *
 * Browser only. In a browser without `linear()` it answers with the DESIGN.md fallback curve and duration the
 * stylesheet itself uses; before motion.css has loaded, with the settle curve over 220 ms.
 */
import { durations, easings, type SpringName } from "./tokens";

export type SpringTiming = { easing: string; duration: number };

const cache = new Map<SpringName, SpringTiming>();

export function springTiming(name: SpringName): SpringTiming {
  const cached = cache.get(name);
  if (cached) return cached;
  const style = getComputedStyle(document.documentElement);
  const easing = style.getPropertyValue(`--motion-spring-${name}`).trim();
  const duration = parseFloat(style.getPropertyValue(`--motion-spring-${name}-duration`));
  const timing = { easing: easing || easings.settle, duration: duration > 0 ? duration : durations.base };
  if (easing) cache.set(name, timing); // only remember real token values
  return timing;
}
