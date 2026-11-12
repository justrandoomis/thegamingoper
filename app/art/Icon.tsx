import { useId, type SVGProps } from "react";

import { GLYPHS, isGlyph, type GlyphName } from "./icons/glyphs";
import {
  ICON_SPRITE_HREF,
  ICONS_MIRRORED_IN_RTL as SPRITE_MIRRORED,
  ICONS_WITH_FILL as SPRITE_FILLED,
  type IconName as SpriteIconName,
} from "./icons/names";

export { ICON_GROUPS, ICON_NAMES } from "./icons/names";
export { GLYPH_GROUPS, GLYPH_NAMES, isGlyph } from "./icons/glyphs";
export type { GlyphName } from "./icons/glyphs";
export type { SpriteIconName };

/** Every icon <Icon> can draw: a sprite symbol (public/icons.svg) or a hand-drawn glyph (./icons/glyphs). */
export type IconName = SpriteIconName | GlyphName;

/** Icons that have a filled weight in the sprite ("<name>-fill"); see the `filled` prop of <Icon>. */
export const ICONS_WITH_FILL: ReadonlySet<IconName> = SPRITE_FILLED;
/** Icons that <Icon> flips horizontally in right-to-left layouts (direction of travel or reading). */
export const ICONS_MIRRORED_IN_RTL: ReadonlySet<IconName> = SPRITE_MIRRORED;

/**
 * One icon — from the sprite (`public/icons.svg`, built by `npm run icons` from Phosphor), or one of the hand-drawn
 * glyphs (device silhouettes, catalogue kinds, play / pause: ./icons/glyphs).
 *
 *   <Icon name="shopping-cart-simple" />                    decorative, 20 px, current text colour
 *   <Icon name="heart" filled={isFavourite} size={24} />     filled weight while active
 *   <Icon name="warning" title={t("stockLow")} />            meaningful on its own → named image
 *   <Icon name="device-playstation" />                       a platform's device silhouette (never a logo)
 *   <Icon name="kind-controller" />                          a catalogue kind (category tiles, filters)
 *   <button aria-label={t("back")}><Icon name="arrow-left" /></button>
 *
 * Weight (Design v2.1 G4) — every icon draws at the before's weight: about 2px at 24px. The glyphs are drawn with
 * 2-unit strokes on a 24 grid; the sprite's Phosphor outlines (16 units on a 256 grid) get a 6-unit round-joined
 * stroke on top (base.css, `svg[data-icon]`), which makes them ~22 units — between Phosphor's regular and bold.
 * `data-weight="regular"` on an icon (or an ancestor) keeps the drawn weight.
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
  const glyph = isGlyph(name);
  const symbol: IconName = !glyph && filled && ICONS_WITH_FILL.has(name) ? (`${name}-fill` as IconName) : name;
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

  if (glyph) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
        data-glyph={name}
        className={classes}
        {...naming}
        {...rest}
      >
        {title ? <title id={titleId}>{title}</title> : null}
        {GLYPHS[name as GlyphName]}
      </svg>
    );
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" focusable="false" data-icon={symbol} className={classes} {...naming} {...rest}>
      {title ? <title id={titleId}>{title}</title> : null}
      <use href={`${ICON_SPRITE_HREF}#${symbol}`} />
    </svg>
  );
}
