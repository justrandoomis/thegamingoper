import { cx } from "./cx";

/**
 * SuccessMark — Design v2.1 G6: an --ok-tint disc that inflates and a check that draws itself, once (the order
 * success header, an accepted trade-in offer, a sent support request). 72px by default. Decorative unless you pass
 * `label` (then it is an image with that name); the page's heading says what happened. Reduced motion: the finished
 * mark (pieces.css).
 *
 *   <SuccessMark />                         beside «تمّ استلام طلبك» (decorative)
 *   <SuccessMark size={56} label={t("sent")} />
 */
export function SuccessMark({ size = 72, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <svg
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
