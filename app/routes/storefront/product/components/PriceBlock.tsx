/**
 * The price block of the product page and the quick look — design v2.1 (client note 5: the before's arrangement,
 * "the information is easy to read"), on the v2 rules of spec §6.7 items 6–7:
 *
 *   667,750 د.ع                          التوصيل 5,000 د.ع لكل المحافظات      the price big in Kufam at the start,
 *   [سعر ومخزون تجريبيان]                ● متوفر                              the demo mark with it (demo data); the
 *                                                                              delivery fee note and the stock state
 *                                                                              at the end, in reading size
 *   (one sentence under both when the chosen version cannot be ordered, or the fee depends on the governorate)
 *
 * The two sides wrap under each other when the row is too narrow for both (a long price with a struck previous one in
 * a narrow quick look). Coming soon: the end says «● يصدر 19 تشرين الثاني 2026» alone (no fee beside it) and the
 * sentence under the block «الطلب يفتح عند وصوله.».
 *
 * Honest by construction: the previous price is struck only when it is real — or a demo value while the whole store is
 * marked demo — and a demo previous price is never worded as a saving (no «توفّر …» from demo data, §11.8); a sold-out
 * version's price is muted (§4.8), never the red sale figure, and offers no saving; stock is a state, never a number
 * (demo stock is never «الكمية محدودة»); a release date is a date («يصدر … · الطلب يفتح عند وصوله»), never a pre-order;
 * digital codes show no delivery fee until the owner decides one (§13 row 11).
 *
 * `reasonId` names the sentence that says why the chosen version cannot be added — the add keys point at it with
 * aria-describedby. `offlineId` names the offline sentence (the add keys go flat while there is no connection).
 */
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { ProductLifecycle, VariantDetail } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { fillNodes, iqdText, SafePrice, SavingNote } from "~/ui/PriceTag";
import { stockLook, useDemoMode, useStockWords } from "~/ui/StockNote";
import { Status } from "~/ui/Tag";
import { useProductT } from "../i18n";

// The block's own layout travels with it: the quick look draws it over listings, the home and search, where the
// page's product.css is not loaded (review 2026-11-13).
import "./PriceBlock.css";

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

/**
 * What the end side of the block says (pure; exported for tests): the delivery fee — not for a code, not for a version
 * that is not out yet (its line is the release day), not when the fee depends on the governorate (a sentence under
 * the block says that) — and the stock state or the release day.
 */
export function priceSide(
  variant: Pick<VariantDetail, "orderable" | "releaseAt">,
  delivery: { overridesEnabled: boolean },
  digital: boolean,
): { fee: boolean; state: "stock" | "release" } {
  const soon = !variant.orderable && variant.releaseAt !== null;
  return { fee: !digital && !soon && !delivery.overridesEnabled, state: soon ? "release" : "stock" };
}

export function PriceBlock({ variant, variants, delivery, lifecycle, isDemo, digital = false, reasonId, offline = false, offlineId, className }: PriceBlockProps) {
  const t = useProductT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const demoStore = useDemoStore();
  const demoMode = useDemoMode();
  const words = useStockWords();
  const soon = !variant.orderable && variant.releaseAt !== null;
  const struck = struckPrice(variant, demoStore);
  const look = priceLook(variant);
  const side = priceSide(variant, delivery, digital);
  const stock = variant.orderable ? variant.stock : soon ? "preorder" : "out_of_stock";

  // why the chosen version cannot be added (coming soon: what the release day means for ordering)
  const reason = variant.orderable ? null : soon ? t("status.soonNote") : variants.some((entry) => entry.orderable) ? t("status.outVariant") : t("status.outAll");
  const life = lifecycle === "discontinued" || lifecycle === "limited" || lifecycle === "upcoming" ? t(`status.${lifecycle}`) : null;
  const varies = !digital && delivery.overridesEnabled;

  return (
    <div className={cx("pp-price", className)} data-price-block="">
      <div className="pp-price__row">
        {/* the start: the price big in Kufam, the demo mark with it, a real saving under it */}
        <div className="pp-price__main">
          <SafePrice amountIqd={variant.priceIqd} compareAtIqd={struck} size="xl" tone={look.tone} />
          {isDemo || demoStore ? <DemoNote variant="tag" what="priceStock" /> : null}
          {look.showSaving ? <SavingNote priceIqd={variant.priceIqd} compareAtIqd={struck} /> : null}
        </div>
        {/* the end: the delivery fee note and the stock state (or the release day) */}
        <div className="pp-price__side">
          {side.fee ? (
            <p className="pp-price__fee">{fillNodes(shop("price.delivery"), { price: <bdi className="nums">{iqdText(f, delivery.flatFeeIqd)}</bdi> })}</p>
          ) : null}
          <Status tone={stockLook(stock, demoMode)} size="lg">
            {side.state === "release" ? t("picker.soon", { date: f.date(variant.releaseAt as number, "long") }) : words(stock)}
          </Status>
        </div>
      </div>
      {varies || reason || offline || life ? (
        <div className="pp-price__notes">
          {varies ? <p>{t("facts.deliveryVaries")}</p> : null}
          {reason ? (
            <p id={reasonId} className={soon ? "text-ink" : undefined}>
              {reason}
            </p>
          ) : null}
          {offline ? (
            // data-offline-line: the product page hides it from 1024, where the kit says the same under the add key
            <p id={offlineId} className="flex items-start gap-1.5 font-semibold text-warn" data-offline-line="">
              <Icon name="wifi-slash" size={18} className="mt-1 shrink-0" />
              <span>{t("status.offline")}</span>
            </p>
          ) : null}
          {life ? <p>{life}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
