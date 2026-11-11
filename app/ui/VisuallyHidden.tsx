import type { ComponentPropsWithRef, ElementType } from "react";

import { cx } from "./cx";

export type VisuallyHiddenProps<C extends ElementType = "span"> = {
  /** Element to render. Default `span`. */
  as?: C;
  /** Show the content while it has keyboard focus (skip links). */
  focusable?: boolean;
} & Omit<ComponentPropsWithRef<C>, "as">;

/**
 * Text for assistive technology only — still read, still copied into the accessibility tree.
 *
 *   <button><Icon name="x" /><VisuallyHidden>{t("close")}</VisuallyHidden></button>
 *   <VisuallyHidden as="a" href="#main" focusable>{t("skip")}</VisuallyHidden>
 *
 * Prefer a visible label; use this only where the visual already says it (an icon, a column position).
 */
export function VisuallyHidden<C extends ElementType = "span">({ as, focusable = false, className, ...rest }: VisuallyHiddenProps<C>) {
  const Tag: ElementType = as ?? "span";
  return <Tag className={cx("sr-only", focusable && "focus:not-sr-only", className)} {...rest} />;
}
