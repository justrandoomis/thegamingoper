import type { CSSProperties, ReactNode } from "react";

import { useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import { cx } from "./cx";
import { useControllable, useRovingRadio } from "./roving";

/**
 * Colour swatches for variants — Design System v2 §4.9: a 36px colour dot (or a 56px thumbnail on the product ground)
 * with a 44px hit area, one row that scrolls on phones. Chosen: a 2px ink ring with a 2px gap. Unavailable: a diagonal
 * stroke AND the reason in its name. The chosen value is printed above the row («اللون: أحمر · Cosmic Red»). A
 * radiogroup: one tab stop, arrows follow the reading direction.
 *
 *   <Swatches label={t("colour")} value={colour} onChange={setColour}
 *             options={[{ value: "red", name: "أحمر · Cosmic Red", color: "var(--swatch-red)" },
 *                       { value: "white", name: "أبيض", thumb: <Render name="dualsense--2" alt="" />, unavailable: true }]} />
 *
 * Swatch colours are product data: pass them as CSS values from the catalogue (a token or the product's own colour);
 * the kit holds no colour literals.
 */
export type SwatchOption = {
  value: string;
  /** The colour's name, as the shopper reads it. */
  name: string;
  /** The dot's colour (a CSS value from the catalogue). */
  color?: string;
  /** A 56px picture instead of a dot. */
  thumb?: ReactNode;
  /**
   * Not available now: a diagonal stroke and the reason in its name, still focusable. `"soldOut"` «نفد حالياً»,
   * `"soon"` «قريباً» (a colour that is not out yet — never «غير متوفر», §9), `true` «غير متوفر» (not made in this
   * version).
   */
  unavailable?: boolean | "soldOut" | "soon";
  /** The reason in your own words, in place of the kit's («يصدر 19 تشرين الثاني»). */
  reason?: string;
};

/** The swatch's accessible name: the colour, then why it cannot be chosen now. Pure but for `t`. */
function swatchName(option: SwatchOption, t: TFunction): string {
  if (!option.unavailable) return option.name;
  if (option.reason) return `${option.name} — ${option.reason}`;
  return t(option.unavailable === "soldOut" ? "swatch.soldOut" : option.unavailable === "soon" ? "swatch.soon" : "swatch.unavailable", { name: option.name });
}

export type SwatchesProps = {
  label: string;
  options: readonly SwatchOption[];
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  name?: string;
  className?: string;
};

export function Swatches({ label, options, value, defaultValue = null, onChange, name, className }: SwatchesProps) {
  const t = useT("ui-shop");
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const { itemProps } = useRovingRadio({ values: options.map((o) => o.value), value: current, onChange: setCurrent });
  const chosen = options.find((o) => o.value === current);
  return (
    <div className={cx("grid gap-2", className)}>
      <p className="type-sm text-ink-2">
        {label}
        {chosen ? (
          <>
            {": "}
            <b className="font-semibold text-ink">{chosen.unavailable ? swatchName(chosen, t) : chosen.name}</b>
          </>
        ) : null}
      </p>
      <div role="radiogroup" aria-label={label} className="swatches">
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            // the chosen swatch already wears a 2px ring: focus moves it out to 4px so the two never look the same
            className={cx("swatch focus-visible:outline-offset-4", option.thumb ? "swatch--thumb" : undefined)}
            style={option.color ? ({ "--swatch": option.color } as CSSProperties) : undefined}
            data-unavailable={option.unavailable ? "" : undefined}
            aria-label={swatchName(option, t)}
            data-press="soft"
            {...itemProps(index)}
          >
            {option.thumb ? <span className="render-slot absolute inset-[8%]">{option.thumb}</span> : null}
          </button>
        ))}
      </div>
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
    </div>
  );
}
