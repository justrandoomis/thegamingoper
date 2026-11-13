/**
 * The phone and tablet buy bar — design v2.1 (client note 5: "button better" — the before's bar), inside the shell's
 * <TaskBar> (the glass, the named region, the persisted name and the measured height it publishes):
 *
 *   ready      the clay quantity tray at the start and the glossy red «أضف إلى السلة» at the end — the kit's
 *              <BuyControls>, as the before had it
 *   added      «✓ في السلة» over the price at the start, «عرض السلة (n)» at the end (v2's feature, kept); another version
 *              starts afresh (the page keys the bar by version)
 *   sold out   «نفد حالياً» + «شاهد بدائل»; coming soon «يصدر … · الطلب يفتح عند وصوله», no key — the kit's bar content
 *              (<BuyBar bare>), as v2
 *
 * A failed add says why on one short line above the controls (the kit's error toast carries «أعد المحاولة»); offline
 * the key goes flat and that line says «لا يوجد اتصال» (the full sentence is under the price, named by the key's
 * aria-describedby). The bar never shows a stock number.
 */
import { useState } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { BuyBar, BuyControls, type BuyControlsProps } from "~/ui/AddToCartKey";
import { useCartCount } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { SafePrice } from "~/ui/PriceTag";

export type BuyStripProps = Omit<BuyControlsProps, "onAdded" | "message" | "onMessage"> & {
  /** The chosen version's price (shown with «✓ في السلة» after an add). */
  priceIqd: number;
  /** Coming soon: the release day (epoch ms). */
  releaseAt: number | null;
  /** Sold out: where «شاهد بدائل» leads (a localized path). */
  alternativesHref: string;
};

/** What the bar shows (pure; exported for tests). */
export function stripState(stock: BuyControlsProps["stock"], added: boolean): "kit" | "added" | "ready" {
  if (stock === "out_of_stock" || stock === "preorder") return "kit";
  return added ? "added" : "ready";
}

export function BuyStrip({ priceIqd, releaseAt, alternativesHref, ...buy }: BuyStripProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const online = useOnline() && !buy.offline;
  const { count } = useCartCount();
  const [added, setAdded] = useState(false);
  const [said, setSaid] = useState<{ text: string; tone: "error" | "warn" } | null>(null);
  const state = stripState(buy.stock, added);

  if (state === "kit") return <BuyBar {...buy} bare priceIqd={priceIqd} releaseAt={releaseAt} alternativesHref={alternativesHref} />;

  if (state === "added") {
    return (
      <div className="buybar min-h-0 p-0" data-bar-state="added">
        <div className="buybar__info">
          <span className="buybar__added flex items-center gap-1">
            <Icon name="check" size={16} />
            {t("add.inCart")}
          </span>
          <SafePrice amountIqd={priceIqd} size="lg" approx="off" as="span" />
        </div>
        <Key as={LocaleLink} to="/cart" variant="primary" iconEnd="arrow-right" className="min-w-[168px]">
          {t("add.viewCartCount", { n: f.number(count) })}
        </Key>
      </div>
    );
  }

  const line = !online ? { text: t("add.offlineShort"), tone: "warn" as const } : said;
  return (
    <div className="grid gap-1.5" data-bar-state="ready">
      {line ? (
        // said aloud already (the add key announces a failure; the offline banner the connection)
        <p className={cx("pp-bar__line", line.tone === "error" ? "text-danger" : "text-warn")}>
          <Icon name={line.tone === "error" ? "warning-circle" : "wifi-slash"} size={16} className="shrink-0" />
          <span className="min-w-0">{line.text}</span>
        </p>
      ) : null}
      <BuyControls
        {...buy}
        message="none"
        onMessage={(text, tone) => setSaid(text ? { text, tone: tone ?? "error" } : null)}
        onAdded={() => setAdded(true)}
        className="pp-bar__controls"
      />
    </div>
  );
}
