import { useId, type CSSProperties, type SVGProps } from "react";

import { LOGO_LAYOUTS, LOGO_PARTS, type LogoPartId, type LogoVariant } from "./logo/parts";

export { LOGO_IS_PROVISIONAL, LOGO_LAYOUTS, LOGO_PARTS } from "./logo/parts";
export type { LogoPartId, LogoVariant } from "./logo/parts";

/**
 * The TamTam Games logo as inline SVG.
 *
 * ARTWORK STATUS — provisional. The paths are a trace of the ~200 px wide logo inside the reference
 * screenshot, the only artwork supplied (`scripts/logo/trace.mjs`). Replace `app/art/logo/parts.ts`
 * when the owner provides the original file; this component does not change.
 *
 * Variants
 *   "stacked"   the lockup exactly as supplied: mascot above طمطم above TAM TAM above GAMES.
 *               Use it wherever the logo is the subject (intro, sign-in, footer, receipts).
 *   "full"      the same four parts side by side (mascot left, text right) for wide, short spaces.
 *               Composed for this site — it is not in the supplied artwork. Below about 48 px of
 *               height the two Latin lines are too small to read: use "wordmark" or "mark" there.
 *   "wordmark"  طمطم alone — headers and app bars.
 *   "mark"      the mascot alone — avatars, compact navigation, loading states.
 *
 * Colour: everything is drawn in `currentColor`, so `className="text-…"` or `style={{ color }}`
 * sets it: brand red on light surfaces, near-white or red on dark ones.
 *
 * Size: by default the logo is 1em tall and as wide as its proportions need. Set a height
 * (`className="h-10"` or `height={40}`) and the width follows. To size by width instead, clear the
 * height as well: `className="w-40 h-auto"`. Proportions per variant are in `LOGO_LAYOUTS`.
 *
 * Accessibility: pass `title` when the logo is the only thing naming its link or region — it
 * becomes an image with that accessible name. Without `title` it is decorative and hidden from
 * assistive technology (use that when visible text or an `aria-label` on the link already names it).
 *
 * Motion: every part is its own `<g data-part="mascot|wordmark|latin|games">`. Animate those
 * groups with CSS or WAAPI transforms: they carry no transform of their own (the layout offset
 * sits on a parent group), and they scale and rotate around their own centre. A part can also be
 * coloured on its own, e.g. `.intro [data-part="games"] { fill: var(--…) }`.
 */
export interface LogoProps extends Omit<SVGProps<SVGSVGElement>, "children" | "viewBox" | "title"> {
  variant?: LogoVariant;
  /** Accessible name, e.g. "طمطم — TamTam Games". Omit when the logo is decorative. */
  title?: string;
}

const PART_STYLE: CSSProperties = { transformBox: "fill-box", transformOrigin: "center" };

export function Logo({ variant = "full", title, width, height, ...rest }: LogoProps) {
  const titleId = useId();
  const layout = LOGO_LAYOUTS[variant];
  const sized = width !== undefined || height !== undefined;
  const naming = title ? ({ role: "img", "aria-labelledby": titleId } as const) : ({ "aria-hidden": true } as const);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={width}
      height={sized ? height : "1em"}
      fill="currentColor"
      focusable="false"
      data-logo={variant}
      {...naming}
      {...rest}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {layout.parts.map(({ part, x, y }) => (
        <g key={part} transform={x !== 0 || y !== 0 ? `translate(${x} ${y})` : undefined}>
          <LogoPartGroup part={part} />
        </g>
      ))}
    </svg>
  );
}

function LogoPartGroup({ part }: { part: LogoPartId }) {
  return (
    <g data-part={part} style={PART_STYLE}>
      <path fillRule="evenodd" d={LOGO_PARTS[part].d} />
    </g>
  );
}

/** Width ÷ height of a variant — for reserving space before the logo renders. */
export function logoAspectRatio(variant: LogoVariant): number {
  const { width, height } = LOGO_LAYOUTS[variant];
  return width / height;
}
