import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { CartView } from "~/lib/dto";
import { cx } from "~/ui/cx";
import { Price } from "~/ui/Price";
import { isIqd } from "~/ui/PriceTag";

/**
 * The checkout's summary bar below 1024px (Design System v2 §5.8, G8): a 48px bar on --niche right under the checkout
 * bar that scrolls with the page — «ملخص الطلب · قطعتان», the total and a chevron — and opens the item list and the
 * totals in place (a native <details>: it works before and without script, and says expanded / collapsed by itself).
 * From 1024 the sticky summary column takes its place (the page hides this one).
 */
export function SummaryBar({ cart, children, className }: { cart: Pick<CartView, "count" | "totalIqd">; children: ReactNode; className?: string }) {
  const t = useT("checkout");
  const f = useFormat();
  return (
    <details className={cx("co-sumbar", className)}>
      <summary className="co-sumbar__head">
        <span className="page co-sumbar__row">
          <Icon name="receipt" size={20} className="shrink-0 text-ink-2" />
          <span className="co-sumbar__label">
            {t("checkout.summaryBar")} · {t("checkout.items", { count: cart.count, n: f.number(cart.count) })}
          </span>
          {isIqd(cart.totalIqd) ? <Price amountIqd={cart.totalIqd} size="sm" approx="off" as="span" /> : null}
          <Icon name="caret-down" size={20} className="co-sumbar__chev" />
        </span>
      </summary>
      <div className="page co-sumbar__body">{children}</div>
    </details>
  );
}
