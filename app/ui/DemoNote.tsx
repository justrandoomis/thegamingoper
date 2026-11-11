import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";

/**
 * "بيانات تجريبية" — the honest label for anything seeded or sample (docs/ARCHITECTURE.md §11: every stored fact that
 * is not real is marked `is_demo`, and the UI says so). Flat, never red, never a tag shape: it is a note, not a fact
 * about the product.
 *
 *   <DemoNote />                         block: info icon, "بيانات تجريبية" and the one-line explanation
 *   <DemoNote compact />                 inline: icon + "تجريبي" (product cards when the store is not in demo mode)
 *   <DemoNote>{t("samplePrices")}</DemoNote>   your own sentence
 */
export type DemoNoteProps = {
  /** Inline and short ("تجريبي"), for cards and rows. */
  compact?: boolean;
  /** Replaces the default explanation (block) or word (compact). */
  children?: ReactNode;
  className?: string;
};

export function DemoNote({ compact = false, children, className }: DemoNoteProps) {
  const t = useT("ui-shop");
  if (compact) {
    return (
      <span className={cx("inline-flex items-center gap-1 type-caption text-ink-2", className)} title={t("demo.hint")}>
        <Icon name="info" size={14} />
        {children ?? t("demo.short")}
      </span>
    );
  }
  return (
    <p className={cx("flex items-start gap-2 rounded-md bg-niche px-3 py-2 type-caption text-ink-2", className)}>
      <Icon name="info" size={16} className="mt-0.5" />
      <span>
        <b className="font-semibold text-ink">{t("demo.label")}</b> · {children ?? t("demo.hint")}
      </span>
    </p>
  );
}
