import type { ReactNode } from "react";

import { LocaleLink, useT } from "~/i18n/react";
import type { StockState } from "~/lib/dto";
import { cx } from "./cx";
import { Status, type StatusTone } from "./Tag";
import { TextLink } from "./TextLink";

/**
 * Stock as words (docs/DESIGN.md §9.5, §9.12): a dot and a word in ok / warn / info / red-ink — never colour alone,
 * and never an exact number (dto: "never expose exact stock numbers to shoppers"; the services send a state).
 *
 *   <StockNote stock="in_stock" detail={t("warranty")} />         "● متوفر · ضمان سنة"
 *   <StockNote stock="low_stock" />                               "● الكمية محدودة"
 *   <StockNote stock="out_of_stock" notifyTo={`/p/${slug}#notify`} />   "● نفد" + "أعلمني عند التوفّر"
 *   <StockNote stock="preorder" />                                "● طلب مسبق"
 *
 * `notifyTo` is only rendered when a back-in-stock destination exists — there is no back-in-stock service yet
 * (docs/ui/commerce.md), so nothing shows the link by default.
 */
export type StockNoteProps = {
  stock: StockState;
  /** Appended after " · " (the warranty, a delivery fact). */
  detail?: ReactNode;
  /** Out of stock: where "أعلمني عند التوفّر" leads (a locale-less path). Omit when nothing can notify. */
  notifyTo?: string;
  className?: string;
};

const TONE: Record<StockState, StatusTone> = { in_stock: "ok", low_stock: "warn", out_of_stock: "bad", preorder: "info" };
const WORD: Record<StockState, string> = { in_stock: "stock.in", low_stock: "stock.low", out_of_stock: "stock.out", preorder: "stock.preorder" };

export function StockNote({ stock, detail, notifyTo, className }: StockNoteProps) {
  const t = useT("ui-shop");
  const tone = TONE[stock] ?? "neutral";
  const status = (
    <Status tone={tone}>
      {t(WORD[stock] ?? "stock.in")}
      {detail ? <> · {detail}</> : null}
    </Status>
  );
  if (stock !== "out_of_stock" || !notifyTo) return <span className={cx("inline-flex", className)}>{status}</span>;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-x-3", className)}>
      {status}
      <TextLink as={LocaleLink} to={notifyTo} arrow={false} className="relative">
        {t("stock.notify")}
      </TextLink>
    </span>
  );
}
