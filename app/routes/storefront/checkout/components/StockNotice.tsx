import type { ReactNode, Ref } from "react";

import { useFormat, useT } from "~/i18n/react";
import { isolate } from "~/ui/BidiText";
import { Note } from "~/ui/Note";
import { fillNodes } from "~/ui/PriceTag";
import type { StockChange } from "../checkout-form";

/**
 * What the stock did to the shopper's cart (client round 1, QA: after a lost stock race the checkout showed a total of
 * 0 and a key that could not work, and said nothing of what had changed). By name: the lines that sold out or went off
 * sale, the lines whose quantity came down to what is left (from what the shopper chose, when that is known); then the
 * total now and the one thing to do (`action`, on its own line). The kit's Note in its warning tone — a calm card, only
 * the circle tinted (Design v2.1 G5).
 *
 *   removed  the sold-out lines were taken out of the cart (after a refusal at «أكّد الطلب»): «…فأزلناه من سلتك.»
 *   alert    it answers the shopper's own action (a refusal): announced at once and focusable (`noticeRef`), so the
 *            page can bring it into view
 */
export function StockNotice({
  title,
  changes,
  removed = false,
  totalIqd = null,
  after,
  action,
  alert = false,
  noticeRef,
}: {
  title: ReactNode;
  changes: readonly StockChange[];
  removed?: boolean;
  /** The total of what can be bought now (null: not said — nothing is left to buy). */
  totalIqd?: number | null;
  /** One more sentence after the total («راجع الإجمالي ثم اضغط «أكّد الطلب» مرة أخرى.»). */
  after?: ReactNode;
  action?: ReactNode;
  alert?: boolean;
  noticeRef?: Ref<HTMLDivElement>;
}) {
  const t = useT("checkout");
  const f = useFormat();
  const sentence = (change: StockChange) => {
    // the name first and in ink (what the line is about); a Latin name inside an Arabic or Kurdish sentence keeps its
    // own direction (isolated)
    const name = <b>{isolate(change.name)}</b>;
    const keep = { name: "{name}" };
    const text =
      change.change === "reduced"
        ? change.from !== null
          ? t("stock.reducedFrom", { ...keep, from: f.number(change.from), to: f.number(change.to) })
          : t("stock.reduced", { ...keep, to: f.number(change.to) })
        : t(`stock.${change.change === "unavailable" ? "unavailable" : "soldOut"}${removed ? "Removed" : ""}`, keep);
    return fillNodes(text, { name });
  };
  const total = totalIqd !== null ? fillNodes(t("stock.totalNow"), { total: <bdi className="nums font-semibold text-ink">{f.iqd(totalIqd)}</bdi> }) : null;
  const note = (
    <Note tone="warning" icon="warning" title={title} action={action}>
      {changes.length > 0 ? (
        <ul className="co-changes">
          {changes.map((change) => (
            <li key={change.id}>{sentence(change)}</li>
          ))}
        </ul>
      ) : null}
      {total || after ? (
        <p>
          {total}
          {total && after ? " " : null}
          {after}
        </p>
      ) : null}
    </Note>
  );
  if (!alert) return note;
  return (
    <div role="alert" ref={noticeRef} tabIndex={-1} className="co-alert">
      {note}
    </div>
  );
}
