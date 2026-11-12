import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { cx } from "./cx";
import { Render } from "./Stage";

/**
 * EmptyState — nothing here yet. Design System v2 §4.23:
 *
 *   layout="stack"  (a page or a sheet that is empty) centred, max 560: a picture — a 112px --red-tint disc
 *                   holding the mascot (the supplied logo artwork), or a real product cut-out in a 132px well (`art`)
 *                   — a type-h2 title (Kufam) that says what is empty, one 16px sentence that says what to do, ONE key
 *                   and, on its own line under it, one recovery link (v2.1: the before's arrangement, client note 7),
 *                   then an optional shelf of in-stock products. `panel` sets the words and the key on the soft
 *                   raised card (the before's empty cart).
 *   layout="row"    (default — a part of a page, the admin) a compact line: a hairline disc with the icon, the title,
 *                   one sentence and the action at the end.
 *
 *   <EmptyState layout="stack" title={t("cartEmpty")} text={t("cartEmptyHint")}
 *               action={<Key variant="primary" as={LocaleLink} to="/">{t("shopDevices")}</Key>}
 *               recovery={<TextLink as={LocaleLink} to="/track">{t("track")}</TextLink>} />
 *   <EmptyState icon="magnifying-glass" title={t("noResults", { q })} text={t("tryFewer")} />
 *
 * Copy (v2 §9): say what is empty and what to do — no «دورك.», never an empty socket. It is not a loading state:
 * render it only once you know there is nothing.
 */
export type EmptyStateProps = {
  /** What is empty, plainly («سلتك فارغة»). */
  title: ReactNode;
  /** One sentence: what to do about it. */
  text?: ReactNode;
  /** The one action (a <Key>, usually a link; the primary in a stack). */
  action?: ReactNode;
  /** stack: one recovery link beside the action (a <TextLink>). */
  recovery?: ReactNode;
  /** row: an icon in the disc. stack: shown in the red-tint disc instead of the mascot. */
  icon?: IconName;
  /** stack: a product photo key (a cut-out in a 132px well) or your own picture. Default: the mascot. */
  art?: string | ReactNode;
  /** stack: under the actions — a shelf of 4 in-stock products. */
  shelf?: ReactNode;
  layout?: "row" | "stack";
  /** stack: set the picture, the words and the key on the soft raised card (the shelf stays outside it). */
  panel?: boolean;
  /** Render the title as a heading of this level (default: a paragraph in a row, an h2 in a stack). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
};

export function EmptyState({ title, text, action, recovery, icon, art, shelf, layout = "row", panel = false, headingLevel, className }: EmptyStateProps) {
  if (layout === "stack") {
    const Title = `h${headingLevel ?? 2}` as const;
    const well = typeof art === "string";
    const column = (
      <div className={cx("empty", panel && "empty--panel", !shelf && className)}>
        <span className={cx("empty__art", well && "empty__art--well")} aria-hidden="true">
          {well ? (
            <span className="render-slot relative size-full p-[12%]">
              <Render name={art} alt="" sizes="132px" />
            </span>
          ) : art ? (
            art
          ) : icon ? (
            <Icon name={icon} size={24} className="text-red-ink" />
          ) : (
            <span className="text-logo">
              <Logo variant="mark" height={60} />
            </span>
          )}
        </span>
        <Title className="empty__title">{title}</Title>
        {text ? <p className="empty__text">{text}</p> : null}
        {action || recovery ? (
          <div className="empty__actions">
            {action}
            {recovery}
          </div>
        ) : null}
      </div>
    );
    if (!shelf) return column;
    // The shelf is the page's width, not the 560px column's: inside the column it was squeezed to the width of the
    // sentence (four ~65px wells at 1440, names broken mid-word; QA 2026-11-12). It lays out like any shelf.
    return (
      <div className={cx("empty-page", className)}>
        {column}
        <div className="empty__shelf">{shelf}</div>
      </div>
    );
  }

  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div className={cx("panel flex flex-wrap items-center gap-3 p-4", className)}>
      <span className="grid size-[52px] shrink-0 place-items-center rounded-full border border-line text-ink-2" aria-hidden="true">
        {icon ? <Icon name={icon} size={24} /> : <Logo variant="mark" height={26} className="text-ink-3" />}
      </span>
      <div className="grid min-w-[min(100%,12rem)] flex-1 gap-0.5">
        <Title className="type-sub text-ink">{title}</Title>
        {text ? <p className="type-caption text-ink-2">{text}</p> : null}
      </div>
      {action || recovery ? (
        // A full row under the words on a narrow card, beside them when there is room; never wider than the card — a
        // long link («اسأل المساعد عن هذه المشكلة») wraps inside it instead of pushing the page sideways (QA 2026-11-12).
        <div className="flex min-w-0 max-w-full basis-full flex-wrap items-center gap-x-4 sm:basis-auto [&_.link]:max-w-full [&_.link__text]:min-w-0">
          {action}
          {recovery}
        </div>
      ) : null}
    </div>
  );
}
