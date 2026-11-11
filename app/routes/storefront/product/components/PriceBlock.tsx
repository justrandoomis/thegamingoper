/**
 * The price on the floor (DESIGN.md §8.4, §9.11): ink price of the chosen variant with a genuine old price struck
 * beside it, the delivery fee right next to it (from settings — never assumed), and the stock state in words.
 * When the chosen variant cannot be ordered, one sentence under it says why (`reasonId` — the buy keys point at it
 * with aria-describedby): not out yet (with its date), this version sold out, or the whole product sold out.
 * Stock is a state, never a number; a release date is a date, never a promise.
 */
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import type { ProductLifecycle, VariantDetail } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { PriceTag } from "~/ui/PriceTag";
import { StockNote } from "~/ui/StockNote";
import { Status } from "~/ui/Tag";
import { useProductT } from "../i18n";

export type PriceBlockProps = {
  variant: VariantDetail;
  /** Every variant of the product, to tell "this version is sold out" from "the product is sold out". */
  variants: readonly VariantDetail[];
  delivery: { flatFeeIqd: number; overridesEnabled: boolean };
  lifecycle: ProductLifecycle | null;
  isDemo: boolean;
  reasonId: string;
  className?: string;
};

export function PriceBlock({ variant, variants, delivery, lifecycle, isDemo, reasonId, className }: PriceBlockProps) {
  const t = useProductT();
  const f = useFormat();
  const store = useRouteLoaderData("root") as { storeMode?: string } | undefined;
  const release = variant.releaseAt !== null ? f.date(variant.releaseAt, "long") : null;

  const aside = variant.orderable ? (
    <StockNote stock={variant.stock} />
  ) : release ? (
    <Status tone="info">{t("status.releaseOn", { date: release })}</Status>
  ) : (
    <StockNote stock="out_of_stock" />
  );

  const reason = variant.orderable
    ? null
    : release
      ? t("status.notYet", { date: release })
      : variants.some((entry) => entry.orderable)
        ? t("status.outVariant")
        : t("status.outAll");
  const life = lifecycle === "discontinued" || lifecycle === "limited" || lifecycle === "upcoming" ? t(`status.${lifecycle}`) : null;

  return (
    <div className={cx("grid gap-2", className)}>
      <PriceTag
        size="page"
        priceIqd={variant.priceIqd}
        compareAtIqd={variant.compareAtIqd}
        deliveryIqd={delivery.overridesEnabled ? null : delivery.flatFeeIqd}
        aside={aside}
      />
      {delivery.overridesEnabled ? <p className="type-caption text-ink-2">{t("facts.deliveryVaries")}</p> : null}
      {reason ? (
        <p id={reasonId} className="flex items-start gap-2 type-caption font-medium text-ink">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-info" />
          <span>{reason}</span>
        </p>
      ) : null}
      {life ? (
        <p className="flex items-start gap-2 type-caption text-ink-2">
          <Icon name="info" size={16} className="mt-0.5 shrink-0" />
          <span>{life}</span>
        </p>
      ) : null}
      {/* In demo mode the store-wide ribbon already says it; a live store marks leftover demo rows here. */}
      {isDemo && store?.storeMode === "live" ? <DemoNote compact className="justify-self-start" /> : null}
    </div>
  );
}
