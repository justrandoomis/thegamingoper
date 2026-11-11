import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { cx } from "./cx";
import { Socket } from "./Socket";

/**
 * EmptyState — nothing here yet (DESIGN.md §9.16): a flat niche panel with an empty socket (the well where a thing
 * would sit), one sentence in the brand voice and ONE key that says where to go. The game-turn voice ("دورك.") is
 * for empty states, onboarding and the home key bank only — never checkout, errors or money (§11).
 *
 *   <EmptyState title={t("cartEmpty")}                       // "سلتك فارغة. دورك."
 *               text={t("cartEmptyHint")}                    // "اختر منصّتك ونرتّب لك الرف."
 *               action={<Key as={LocaleLink} to="/">{t("browse")}</Key>} />   // "تصفّح الأجهزة"
 *   <EmptyState icon="magnifying-glass" title={t("noResults", { q })} text={t("tryFewer")} layout="stack" />
 *
 * `layout="row"` (default) for a panel inside a page; `"stack"` (centred) when it is the whole content of a page or a
 * sheet. It is not a loading state: render it only once you know there is nothing.
 */
export type EmptyStateProps = {
  /** One sentence: what is empty, plainly ("لا توجد طلبات بعد."). */
  title: ReactNode;
  /** One more line: what to do about it. */
  text?: ReactNode;
  /** The one key (a <Key>, usually a link). Never the commit key. */
  action?: ReactNode;
  /** An icon in the socket (a search glass for zero results). Default: the socket stays empty. */
  icon?: IconName;
  layout?: "row" | "stack";
  /** Render the title as a heading of this level (default: a paragraph). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
};

export function EmptyState({ title, text, action, icon, layout = "row", headingLevel, className }: EmptyStateProps) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  const stack = layout === "stack";
  return (
    <div className={cx("panel flex gap-3", stack ? "flex-col items-center px-6 py-8 text-center" : "flex-wrap items-center p-4", className)}>
      <Socket state="empty" inset>
        {icon ? <Icon name={icon} size={22} className="text-ink-2" /> : undefined}
      </Socket>
      <div className={cx("grid min-w-0 gap-0.5", stack ? "max-w-[34ch] justify-items-center" : "min-w-[min(100%,12rem)] flex-1")}>
        <Title className="type-sub text-ink">{title}</Title>
        {text ? <p className="type-caption text-ink-2">{text}</p> : null}
      </div>
      {action ? <div className={cx("shrink-0", stack && "pt-1")}>{action}</div> : null}
    </div>
  );
}
