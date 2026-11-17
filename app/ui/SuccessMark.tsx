import { useEffect, useRef } from "react";

import { cx } from "./cx";
import { sakuga } from "./sakuga/fx";

/**
 * SuccessMark — Design v2.1 G6: an --ok-tint disc that inflates and a check that draws itself, once (the order
 * success header, an accepted trade-in offer, a sent support request). 72px by default. Decorative unless you pass
 * `label` (then it is an image with that name); the page's heading says what happened. Reduced motion: the finished
 * mark (pieces.css).
 *
 * Progress completing is one of the drawn moments (./sakuga, DESIGN.md §7.4): as the check finishes drawing (280 ms),
 * a ring opens round the disc, chips fly and four puffs roll off it — once per mark, in the browser only, never under
 * reduced motion.
 *
 *   <SuccessMark />                         beside «تمّ استلام طلبك» (decorative)
 *   <SuccessMark size={56} label={t("sent")} />
 */
export function SuccessMark({ size = 72, label, className }: { size?: number; label?: string; className?: string }) {
  const mark = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    // often the page's first moment (an order landing): fetch the core now, 280 ms ahead, so it is not dropped as late
    sakuga.warm(mark.current);
    const timer = window.setTimeout(() => sakuga.complete(mark.current), 280);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <svg
      ref={mark}
      viewBox="0 0 72 72"
      width={size}
      height={size}
      className={cx("success-mark", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle className="success-mark__disc" cx="36" cy="36" r="36" />
      <path className="success-mark__check" d="M23.5 37.5 32 46l17-19" pathLength={1} />
    </svg>
  );
}
