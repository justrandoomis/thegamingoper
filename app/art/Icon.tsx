import { useId, type SVGProps } from "react";

import { ICON_SPRITE_HREF, ICONS_MIRRORED_IN_RTL, ICONS_WITH_FILL, type IconName } from "./icons/names";

export { ICON_GROUPS, ICON_NAMES, ICONS_MIRRORED_IN_RTL, ICONS_WITH_FILL } from "./icons/names";
export type { IconName } from "./icons/names";

/**
 * One icon from the sprite (`public/icons.svg`, built by `npm run icons` from Phosphor).
 *
 *   <Icon name="shopping-cart-simple" />                    decorative, 20 px, current text colour
 *   <Icon name="heart" filled={isFavourite} size={24} />     filled weight while active
 *   <Icon name="warning" title={t("stockLow")} />            meaningful on its own → named image
 *   <button aria-label={t("back")}><Icon name="arrow-left" /></button>
 *
 * Colour — the icon is drawn in `currentColor`; set it with text-colour classes or `style`.
 *
 * Size — `size` sets width and height (a number of CSS pixels, or any CSS length such as "1em").
 * Icons never shrink inside a flex row.
 *
 * Accessibility — by default an icon is decoration: `aria-hidden`, not focusable. The control
 * around it must carry the name (visible text or `aria-label`). Pass `title` only when the icon
 * alone conveys information; it then becomes `role="img"` with that accessible name.
 *
 * Right-to-left — NAME ICONS AS YOU WOULD IN A LEFT-TO-RIGHT LAYOUT and let them flip:
 * "back" is `arrow-left`, "next / open" is `caret-right`. Icons that show a direction of travel or
 * of reading (the list is `ICONS_MIRRORED_IN_RTL`: left/right arrows and carets, arrow-u-up-left,
 * arrow-square-out, sign-in, sign-out, paper-plane-tilt, sort-ascending, truck, question) are
 * mirrored automatically wherever the text direction is rtl, so the same JSX is right in Arabic,
 * Kurdish and English. Objects, clockwise motion and charts are never mirrored.
 *   mirror={true}    treat any other icon as directional too (flip it in rtl)
 *   mirror={false}   keep the drawn direction everywhere — e.g. an arrow that points at something
 *                    physical, or an icon inside a `dir="ltr"` island on an Arabic page
 *                    (the flip follows the page direction there)
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "name" | "title" | "width" | "height"> {
  name: IconName;
  /** Width and height. Default 20 (CSS pixels). */
  size?: number | string;
  /** Use the filled weight when the sprite has one for this icon (`ICONS_WITH_FILL`); otherwise no effect. */
  filled?: boolean;
  /** Accessible name. Omit for decorative icons. */
  title?: string;
  /** Flip horizontally in right-to-left layouts. Default "auto": only the icons in `ICONS_MIRRORED_IN_RTL`. */
  mirror?: boolean | "auto";
}

export function Icon({ name, size = 20, filled = false, title, mirror = "auto", className, ...rest }: IconProps) {
  const titleId = useId();
  const symbol: IconName = filled && ICONS_WITH_FILL.has(name) ? (`${name}-fill` as IconName) : name;
  // The filled weight of a directional icon is directional too.
  const base = (name.endsWith("-fill") ? name.slice(0, -5) : name) as IconName;
  const mirrored = mirror === "auto" ? ICONS_MIRRORED_IN_RTL.has(base) : mirror;
  const labelled = Boolean(title || rest["aria-label"] || rest["aria-labelledby"]);
  const naming = title
    ? ({ role: "img", "aria-labelledby": titleId } as const)
    : labelled
      ? ({ role: "img" } as const)
      : ({ "aria-hidden": true } as const);
  const classes = ["shrink-0", mirrored ? "rtl:-scale-x-100" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" focusable="false" data-icon={symbol} className={classes} {...naming} {...rest}>
      {title ? <title id={titleId}>{title}</title> : null}
      <use href={`${ICON_SPRITE_HREF}#${symbol}`} />
    </svg>
  );
}
