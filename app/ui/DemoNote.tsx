import { useId, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import { cx } from "./cx";

/**
 * Demo marking — Design System v2 §4.7. Honest and quiet, never inverted in dark (its own amber pair), never louder
 * than these four forms (§9.7):
 *
 *   <DemoNote variant="strip" to="/about#demo" />        28px amber strip above the phone header; the whole strip is one
 *                                                        link to the full note (the one documented 28px target)
 *   <DemoNote variant="chip" />                          28px amber pill in the desktop nav row: the full sentence from
 *                                                        1280, «متجر تجريبي» + its sentence in a popover below
 *   <DemoNote variant="tag" what="price" />              24px pill beside a price or an order number: «سعر تجريبي» ·
 *   <DemoNote variant="tag" what="priceStock" />         «سعر ومخزون تجريبيان» (PDP) · «طلب تجريبي» (checkout, order);
 *   <DemoNote variant="tag" what="order" onColor />      on crimson: transparent, a white line and white words
 *   <DemoNote variant="line">{t("footerStatement")}</DemoNote>   13px sentences (footer, the checkout demo-order line)
 *
 * 1.0 forms keep working: `compact` is the short tag «تجريبي»; no variant is the line «بيانات تجريبية · …».
 */
export type DemoNoteProps = {
  variant?: "strip" | "chip" | "tag" | "line";
  /** tag: price «سعر تجريبي» · priceStock «سعر ومخزون تجريبيان» · order «طلب تجريبي» · data «تجريبي». */
  what?: "price" | "priceStock" | "order" | "data";
  /** strip / chip: where the full note lives (a locale-less path). */
  to?: string;
  /** tag on crimson (light theme). */
  onColor?: boolean;
  /** 1.0: the short inline tag. */
  compact?: boolean;
  /** Replaces the default words. */
  children?: ReactNode;
  className?: string;
};

const TAG_WORD = { price: "demo.price", priceStock: "demo.priceStock", order: "demo.order", data: "demo.short" } as const;

export function DemoNote({ variant, what = "data", to, onColor = false, compact = false, children, className }: DemoNoteProps) {
  const t = useT("ui-shop");
  const popId = `demo-${useId().replace(/[^\w-]/g, "")}`;
  const kind = variant ?? (compact ? "tag" : "line");

  if (kind === "strip") {
    const body = (
      <>
        <Icon name="info" size={16} />
        <span>{children ?? t("demo.strip")}</span>
      </>
    );
    return to ? (
      <LocaleLink to={to} className={cx("demo-strip", className)} data-demo="strip">
        {body}
      </LocaleLink>
    ) : (
      <p className={cx("demo-strip", className)} data-demo="strip">
        {body}
      </p>
    );
  }

  if (kind === "chip") {
    const full = children ?? t("demo.strip");
    return (
      <span className={cx("inline-flex", className)} data-demo="chip">
        {/* from 1280: the whole sentence */}
        <span className="demo-chip max-2xl:hidden">
          <Icon name="info" size={16} />
          {full}
        </span>
        {/* below 1280: «متجر تجريبي» opens the sentence */}
        <button type="button" className="demo-chip hit-44 relative 2xl:hidden" popoverTarget={popId} aria-haspopup="dialog">
          <Icon name="info" size={16} />
          {t("demo.chip")}
        </button>
        <span id={popId} popover="auto" role="note" className="m-auto max-w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-paper p-4 type-sm text-ink shadow-overlay">
          {full}
        </span>
      </span>
    );
  }

  if (kind === "tag") {
    return (
      <span className={cx("tag", onColor ? "tag--on-color" : "tag--demo", className)} data-demo="tag">
        {children ?? t(TAG_WORD[what])}
      </span>
    );
  }

  // line
  return (
    <p className={cx("demo-line", className)} data-demo="line">
      {children ?? (
        <>
          <b className="font-semibold">{t("demo.label")}</b> · {t("demo.hint")}
        </>
      )}
    </p>
  );
}
