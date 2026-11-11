/**
 * The motion tier before first paint. DESIGN.md §6.5 asks for the low-end class (`fx-low`, solid glass instead of
 * live blur) to be on <html> before the first frame, which only a blocking script in the document head can do.
 * The root layout puts it next to its theme script:
 *
 *   import { MOTION_TIER_SCRIPT } from "~/motion/tier-script";
 *   <script nonce={nonce} dangerouslySetInnerHTML={{ __html: MOTION_TIER_SCRIPT }} suppressHydrationWarning />
 *
 * It sets <html data-motion="full|lite|reduced"> and toggles class `fx-low` by exactly the rule of `resolveTier()`
 * in ./env (tests/motion.test.ts runs both over every combination of signals). Without it, the same attributes
 * arrive when <MotionRoot> mounts after hydration. Never throws.
 */
export const MOTION_TIER_SCRIPT =
  '(function(){try{var d=document.documentElement,n=navigator,c=n.connection||{},m=n.deviceMemory,h=n.hardwareConcurrency,o=null,j=false;' +
  'try{o=localStorage.getItem("tt:motion")}catch(e){}' +
  'try{j=sessionStorage.getItem("tt:motion-low")==="1"}catch(e){}' +
  'var t=o==="full"||o==="lite"||o==="reduced"?o' +
  ':matchMedia("(prefers-reduced-motion: reduce)").matches?"reduced"' +
  ':c.saveData===true||j||typeof m==="number"&&(m<=2||Math.min(screen.width,screen.height)<768&&typeof h==="number"&&h<=4)?"lite":"full";' +
  'd.setAttribute("data-motion",t);d.classList.toggle("fx-low",t==="lite")}catch(e){}})()';
