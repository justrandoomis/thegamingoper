/**
 * The version choice — design v2 spec §6.7 item 9, §4.9 (OptionCard, Swatch), §4.6 (chips).
 *
 * One group named after what changes between the variants ("اللون", "السعة", "الإصدار", "المنصة"… or "النسخة" when
 * several things change), whose label repeats the choice («النسخة: النسخة الدولية»):
 *   · versions → OPTION CARDS, each with its own price at the end and, when it cannot be ordered now, the reason as its
 *     hint («نفد حالياً», «يصدر 4 شباط 2027»);
 *   · colours whose every version has its own photo → SWATCHES: 56px thumbnails on the product ground (a sold-out
 *     colour is struck through and says so in its name);
 *   · colours without a photo each → CHIPS (a swatch needs a real colour or a real picture — none is invented).
 * Option cards and chips are native radios: one tab stop, arrow keys, and without script they sit in a GET form with
 * a submit key, so `?v=` still works. Swatches are the kit's radiogroup (script); without script the page's form shows
 * the same colours as native radio chips instead (a <noscript> group; the swatches hide under `noscript:`).
 *
 * Labels are the variants' localized titles without the words they all share ("DualSense – أبيض" → "أبيض"); mixed
 * scripts are isolated run by run (MixedText). No research note is shown per version (no UPC notes, §6.7); a
 * buyer-relevant line per version arrives only from the owner (§13 row 8).
 *
 * The choice itself lives with the caller: the page keeps it in the URL (`?v=<sku>`), the quick look in state.
 */
import { useId, type ReactNode } from "react";

import { useFormat } from "~/i18n/react";
import type { SelectorDimension, VariantDetail } from "~/server/services/catalog/product-types";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { FieldGroup, OptionCard } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Price } from "~/ui/Price";
import { fillNodes } from "~/ui/PriceTag";
import { ProductImage } from "~/ui/ProductCard";
import { Swatches } from "~/ui/Swatch";
import { useProductT } from "../i18n";
import { MixedText } from "./MixedText";

export type VariantPickerProps = {
  variants: readonly VariantDetail[];
  selector: SelectorDimension | null;
  value: string;
  onChange: (variantId: string) => void;
  /** Render the no-script GET form (the page). The quick look is script-only and passes false. */
  form?: boolean;
  className?: string;
};

/** How the choice is drawn (pure; exported for tests). */
export function pickerLook(variants: readonly Pick<VariantDetail, "images">[], selector: SelectorDimension | null): "cards" | "swatches" | "chips" {
  if (selector !== "color") return "cards";
  return variants.every((variant) => variant.images.length > 0) ? "swatches" : "chips";
}

export function VariantPicker({ variants, selector, value, onChange, form = true, className }: VariantPickerProps) {
  const t = useProductT();
  const f = useFormat();
  const id = useId();
  if (!selector || variants.length < 2) return null;
  const look = pickerLook(variants, selector);
  const dimension = t(`picker.dimensions.${selector}`);
  const current = variants.find((variant) => variant.id === value) ?? variants[0];
  const name = form ? "v" : `${id}-v`;

  /** Why a version cannot be ordered now, in words (never colour alone). */
  const hint = (variant: VariantDetail): string | undefined => {
    if (variant.orderable) return undefined;
    if (variant.releaseAt !== null) return t("picker.soon", { date: f.date(variant.releaseAt, "long") });
    return t("picker.out");
  };

  const legend: ReactNode = fillNodes(t("picker.chosen"), {
    dimension,
    value: (
      <b className="font-semibold">
        <MixedText text={current.label} />
      </b>
    ),
  });

  /** A colour as a native radio chip (`checked`: script keeps it in step; `defaultChecked`: the no-script form). */
  const chip = (variant: VariantDetail, mode: "controlled" | "native") => (
    <Chip
      key={variant.id}
      input="radio"
      name={name}
      value={variant.sku}
      {...(mode === "controlled" ? { checked: variant.id === current.id, onChange: () => onChange(variant.id) } : { defaultChecked: variant.id === current.id })}
    >
      <MixedText text={variant.label} />
      {/* a colour that cannot be ordered now says so on the chip itself */}
      {variant.orderable ? null : <> · {variant.releaseAt !== null ? t("picker.soonShort") : t("picker.out")}</>}
    </Chip>
  );

  /* Script turns every choice into an instant change of `?v=`; without it, this key sends the form. */
  const submit = (
    <Key type="submit" size="sm" className="justify-self-start">
      {t("picker.show")}
    </Key>
  );

  if (look === "swatches") {
    const swatches = (
      <Swatches
        // without script the swatches cannot be pressed: hidden there (`noscript:` is `@media (scripting: none)`)
        className={form ? "noscript:hidden" : className}
        label={dimension}
        value={current.sku}
        onChange={(sku) => {
          const next = variants.find((variant) => variant.sku === sku);
          if (next) onChange(next.id);
        }}
        options={variants.map((variant) => ({
          value: variant.sku,
          name: variant.label,
          // the kit strikes a colour that cannot be ordered now and says why in its name: a sold-out one «نفد حالياً»,
          // a coming one its release day («يصدر 19 تشرين الثاني 2026» — never «غير متوفر», v2 §9)
          unavailable: variant.orderable ? undefined : variant.releaseAt !== null ? ("soon" as const) : ("soldOut" as const),
          reason: hint(variant),
          thumb: variant.images[0] ? <ProductImage image={variant.images[0]} alt="" sizes="56px" /> : undefined,
        }))}
      />
    );
    if (!form) return swatches;
    // Swatches are the kit's script radiogroup: without script (hidden then) the same colours are native radio chips
    // in the GET form, as before the swatches — a colour can always be chosen.
    return (
      <form method="get" className={cx("grid gap-2", className)}>
        {swatches}
        <noscript>
          <FieldGroup legend={legend} layout="row">
            {variants.map((variant) => chip(variant, "native"))}
          </FieldGroup>
          {submit}
        </noscript>
      </form>
    );
  }

  const group = (
    <FieldGroup legend={legend} layout={look === "chips" ? "row" : "column"}>
      {variants.map((variant) =>
        look === "cards" ? (
          <OptionCard
            key={variant.id}
            name={name}
            value={variant.sku}
            checked={variant.id === current.id}
            onChange={() => onChange(variant.id)}
            label={<MixedText text={variant.label} />}
            hint={hint(variant)}
            // the price never breaks between the figure and «د.ع»: the version's name wraps instead
            end={<Price amountIqd={variant.priceIqd} size="sm" as="span" approx="off" tone={variant.orderable ? undefined : "muted"} className="flex-nowrap" />}
          />
        ) : (
          chip(variant, "controlled")
        ),
      )}
    </FieldGroup>
  );

  if (!form) return <div className={className}>{group}</div>;
  return (
    <form method="get" className={cx("grid gap-2", className)}>
      {group}
      <noscript>{submit}</noscript>
    </form>
  );
}
