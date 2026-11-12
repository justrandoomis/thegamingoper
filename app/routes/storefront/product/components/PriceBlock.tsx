/**
 * The price block of the product page and the quick look — design v2 spec §6.7 items 6–7, §4.8 `PriceTag size="page"`:
 *
 *   667,750 د.ع  [سعر ومخزون تجريبيان]            price xl + the demo tag (demo data)
 *   ● متوفر · التوصيل 5,000 د.ع لكل المحافظات      stock words + the fee from settings (14/600); coming soon:
 *                                                  «● يصدر 19 تشرين الثاني 2026» (PriceTag `status`)
 *   (one sentence when the chosen version cannot be ordered, or the fee depends on the governorate)
 *
 * Honest by construction: the previous price is struck only when it is real — or a demo value while the whole store is
 * marked demo — and a demo previous price is never worded as a saving (no «توفّر …» from demo data, §11.8); a sold-out
 * version's price is muted (§4.8), never the red sale figure, and offers no saving; stock is a
 * state, never a number (demo stock is never «الكمية محدودة»); a release date is a date («يصدر … · الطلب يفتح عند
 * وصوله»), never a pre-order; digital codes show no delivery fee until the owner decides one (§13 row 11).
 *
 * `reasonId` names the sentence that says why the chosen version cannot be added — the add keys point at it with
 * aria-describedby. `offlineId` names the offline sentence (the add keys go flat while there is no connection).
 */
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import type { ProductLifecycle, VariantDetail } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { PriceTag } from "~/ui/PriceTag";
import { useProductT } from "../i18n";

export type PriceBlockProps = {
  variant: VariantDetail;
  /** Every variant of the product, to tell "this version is sold out" from "the product is sold out". */
  variants: readonly VariantDetail[];
  delivery: { flatFeeIqd: number; overridesEnabled: boolean };
  lifecycle: ProductLifecycle | null;
  isDemo: boolean;
  /** A digital code: no delivery fee is stated (the owner has not decided one for codes). */
  digital?: boolean;
  /** The id of the "why it cannot be added" sentence. */
  reasonId: string;
  /** The browser is offline: say why the add key is flat (`offlineId` names that sentence). */
  offline?: boolean;
  offlineId?: string;
  className?: string;
};

type RootStore = { storeMode?: string };

/** Whether the store is in demo mode (root loader). */
export function useDemoStore(): boolean {
  const root = useRouteLoaderData("root") as RootStore | undefined;
  return root?.storeMode === "demo";
}

/**
 * The previous price to strike, or null: a real one (an applied price change set it), or a demo value while the store
 * is marked demo — the same rule as the cards (~/ui/ProductCard). Pure.
 */
export function struckPrice(variant: Pick<VariantDetail, "priceIqd" | "compareAtIqd" | "compareAtDemo">, demoStore: boolean): number | null {
  const was = variant.compareAtIqd;
  if (was === null || was <= variant.priceIqd) return null;
  return !variant.compareAtDemo || demoStore ? was : null;
}

/**
 * How the page price reads for a version. Sold out: muted like the card's (§4.8 tones) — never the red sale figure on
 * something that cannot be bought — and no saving offered; a coming version keeps the ink price it will sell at. A demo
 * previous price is struck under the demo marking but never worded as a saving. Pure.
 */
export function priceLook(variant: Pick<VariantDetail, "orderable" | "releaseAt" | "compareAtDemo">): { tone: "muted" | undefined; showSaving: boolean } {
  const soldOut = !variant.orderable && variant.releaseAt === null;
  return { tone: soldOut ? "muted" : undefined, showSaving: variant.orderable && !variant.compareAtDemo };
}

export function PriceBlock({ variant, variants, delivery, lifecycle, isDemo, digital = false, reasonId, offline = false, offlineId, className }: PriceBlockProps) {
  const t = useProductT();
  const f = useFormat();
  const demoStore = useDemoStore();
  const soon = !variant.orderable && variant.releaseAt !== null;
  const struck = struckPrice(variant, demoStore);
  const look = priceLook(variant);

  // coming soon: the price line says when («● يصدر 19 تشرين الثاني 2026», the kit's `status` in the soon tone — the
  // «قريباً» tag already leads the kind line), the sentence under it what that means for ordering
  const soonStatus = soon ? t("picker.soon", { date: f.date(variant.releaseAt as number, "long") }) : undefined;
  const reason = variant.orderable ? null : soon ? t("status.soonNote") : variants.some((entry) => entry.orderable) ? t("status.outVariant") : t("status.outAll");
  const life = lifecycle === "discontinued" || lifecycle === "limited" || lifecycle === "upcoming" ? t(`status.${lifecycle}`) : null;

  return (
    <PriceTag
      size="page"
      className={className}
      priceIqd={variant.priceIqd}
      compareAtIqd={struck}
      tone={look.tone}
      showSaving={look.showSaving}
      demo={isDemo || demoStore}
      stock={variant.orderable ? variant.stock : soon ? "preorder" : "out_of_stock"}
      status={soonStatus}
      deliveryIqd={digital || delivery.overridesEnabled ? null : delivery.flatFeeIqd}
      aside={
        reason || life || offline || (!digital && delivery.overridesEnabled) ? (
          <div className="grid gap-1">
            {!digital && delivery.overridesEnabled ? <p className="type-sm text-ink-2">{t("facts.deliveryVaries")}</p> : null}
            {reason ? (
              <p id={reasonId} className={cx("type-sm", soon ? "text-ink" : "text-ink-2")}>
                {reason}
              </p>
            ) : null}
            {offline ? (
              <p id={offlineId} className="flex items-start gap-1.5 type-sm-strong text-warn">
                <Icon name="wifi-slash" size={16} className="mt-0.5 shrink-0" />
                <span>{t("status.offline")}</span>
              </p>
            ) : null}
            {life ? <p className="type-sm text-ink-2">{life}</p> : null}
          </div>
        ) : null
      }
    />
  );
}
