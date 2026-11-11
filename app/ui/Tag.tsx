import type { ReactNode } from "react";

import { useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";

/**
 * Badges (docs/DESIGN.md §9.12). A tag states ONE fact about an object; tags differ by SHAPE, not colour, and are
 * never a price, a discount or a colour shout. Status is a dot AND words. Nothing here is red except a "bad"
 * status, which is red-ink text with its word.
 *
 *   <Tag kind="new" />                                   solid ink      "جديد"
 *   <Tag kind="used" detail={t("gradeExcellent")} />     outlined       "مستعمل · ممتاز"
 *   <Tag kind="preorder" /> · <Tag kind="refurbished" /> outlined
 *   <Status tone="warn">{t("pendingReview")}</Status>    dot + words
 *   <StockStatus quantity={2} lowAt={3} />               "متوفر" · "بقي 2" · "نفد"
 */
export type TagKind = "new" | "used" | "preorder" | "refurbished";

export type TagProps = {
  kind: TagKind;
  /** Replaces the default word for the kind. */
  children?: ReactNode;
  /** Appended after " · " — the grade of a used unit, for example. */
  detail?: ReactNode;
  className?: string;
};

export function Tag({ kind, children, detail, className }: TagProps) {
  const t = useT("ui");
  return (
    <span className={cx("tag", kind === "new" ? "tag--solid" : "tag--outline", className)} data-kind={kind}>
      {children ?? t(`tag.${kind}`)}
      {detail ? <> · {detail}</> : null}
    </span>
  );
}

export type StatusTone = "ok" | "warn" | "info" | "bad" | "neutral";

/** A 7px dot and words, AA in both themes. Never colour alone. */
export function Status({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return <span className={cx("status", `status--${tone}`, className)}>{children}</span>;
}

export type StockStatusProps = {
  /** Units that can be sold now. `null` = not tracked (shows nothing). */
  quantity: number | null;
  /** At or below this, say how many are left. Default 3. */
  lowAt?: number;
  /** Appended after " · " (e.g. the warranty), like the product page's "متوفر · ضمان سنة". */
  detail?: ReactNode;
  className?: string;
};

export function StockStatus({ quantity, lowAt = 3, detail, className }: StockStatusProps) {
  const t = useT("ui");
  const f = useFormat();
  if (quantity === null) return null;
  const tone: StatusTone = quantity <= 0 ? "bad" : quantity <= lowAt ? "warn" : "ok";
  const words = quantity <= 0 ? t("stock.out") : quantity <= lowAt ? t("stock.low", { count: f.number(quantity) }) : t("stock.in");
  return (
    <Status tone={tone} className={className}>
      {words}
      {detail ? <> · {detail}</> : null}
    </Status>
  );
}
