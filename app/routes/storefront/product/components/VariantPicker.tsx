/**
 * The variant selector (DESIGN.md §8.4 "option chips: held-down ink key = chosen", §9.8 chips and option rows).
 *
 * One group named after what changes between the variants ("اللون", "السعة", "الإصدار", "المنصة"… or "النسخة" when
 * several things change), built on native radios so it is one tab stop with arrow keys and works without script:
 *   · short labels → chips (`<Chip input="radio">`), wrapping;
 *   · long labels (handheld PCs: "SteamOS Z1 Extreme 32GB / 1TB …") → option rows with the price and a stock word.
 * Labels are the variants' localized titles without the words they all share ("DualSense – أبيض" → "أبيض").
 *
 * The choice itself lives with the caller: the page keeps it in the URL (`?v=<sku>`), the quick preview in state.
 * Without script the radios sit in a GET form with a submit key, so `?v=` still works.
 */
import { useId } from "react";

import { useDir, useFormat } from "~/i18n/react";
import type { SelectorDimension, VariantDetail } from "~/server/services/catalog/product-types";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { FieldGroup, Radio } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Price } from "~/ui/Price";
import { useProductT } from "../i18n";

/** Chips only hold short labels (DESIGN.md §9.8); anything longer becomes an option row. */
const CHIP_MAX = 36;

export type VariantPickerProps = {
  variants: readonly VariantDetail[];
  selector: SelectorDimension | null;
  value: string;
  onChange: (variantId: string) => void;
  /** Render the no-script GET form (the page). The preview sheet is script-only and passes false. */
  form?: boolean;
  className?: string;
};

export function VariantPicker({ variants, selector, value, onChange, form = true, className }: VariantPickerProps) {
  const t = useProductT();
  const f = useFormat();
  const dir = useDir();
  const id = useId();
  if (!selector || variants.length < 2) return null;
  const rows = variants.some((variant) => variant.label.length > CHIP_MAX);
  const legend = t(`picker.dimensions.${selector}`);
  const name = `${id}-v`;

  const hint = (variant: VariantDetail) => {
    if (variant.orderable) return undefined;
    if (variant.releaseAt !== null) return t("picker.soon", { date: f.date(variant.releaseAt, "long") });
    return t("picker.out");
  };

  const group = (
    <FieldGroup legend={legend} layout={rows ? "column" : "row"}>
      {variants.map((variant) =>
        rows ? (
          <Radio
            key={variant.id}
            row
            name={form ? "v" : name}
            value={variant.sku}
            checked={variant.id === value}
            onChange={() => onChange(variant.id)}
            label={<Label text={variant.label} dir={dir} />}
            hint={hint(variant)}
            end={<Price amountIqd={variant.priceIqd} size="sm" as="span" approx="off" />}
          />
        ) : (
          <Chip
            key={variant.id}
            input="radio"
            name={form ? "v" : name}
            value={variant.sku}
            checked={variant.id === value}
            onChange={() => onChange(variant.id)}
          >
            <Label text={variant.label} dir={dir} />
          </Chip>
        ),
      )}
    </FieldGroup>
  );

  if (!form) return <div className={className}>{group}</div>;
  return (
    <form method="get" className={cx("grid gap-2", className)}>
      {group}
      {/* Script turns every choice into an instant change of `?v=`; without it, this key sends the form. */}
      <noscript>
        <Key type="submit" size="sm" className="justify-self-start">
          {t("picker.show")}
        </Key>
      </noscript>
    </form>
  );
}

/**
 * A label in the page's direction. Labels mix scripts ("Prism برتقالي شفاف Flare Orange", "Core أبيض"); an isolate
 * that guesses its direction from the first letter would read them backwards in Arabic, so the direction is given.
 */
function Label({ text, dir }: { text: string; dir: "rtl" | "ltr" }) {
  return <span dir={dir}>{text}</span>;
}
