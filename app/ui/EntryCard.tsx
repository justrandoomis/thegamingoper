import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink } from "~/i18n/react";
import { cx } from "./cx";
import { Render } from "./Stage";

/**
 * The entry card — Design System v2 §4.25; v2.1: a door to a service (trade-in, used & inspected, support) on the soft
 * raised card (dark: faux glass), padding 20 (24 from 1024), lifting 2px under a fine pointer. Two forms:
 *
 *   art   the words at the start (a Kufam type-h3 title, one 16px line, a text-link cue) and an image well at the end
 *         (96px phones, 160 from 1024) holding a hardware cut-out or the mascot; the picture grows 1.03 on hover
 *   icon  the before's row (client note 9): a 48px clay disc with the icon at the start, the title and its line, an
 *         arrow at the end that nudges toward the reading end on hover
 *
 *   <EntryCard to="/used" title={t("used")} text={t("usedLine")} cta={t("browseUsed")} art="playstation-5-slim--1" />
 *   <EntryCard to="/support" title={t("support")} text={t("supportLine")} cta={t("openSupport")} art="mascot" />
 *   <EntryCard to="/support/assistant" icon="lifebuoy" title={t("diagnose")} text={t("diagnoseLine")} />
 *
 * The WHOLE card is one link (so its cue is drawn as a link, not a second anchor).
 */
export type EntryCardProps<C extends ElementType = typeof LocaleLink> = {
  title: ReactNode;
  text?: ReactNode;
  /** The link words at the end of the copy («استبدل جهازك»). */
  cta?: ReactNode;
  /** A product photo key, "mascot", or your own node. */
  art?: string | ReactNode;
  /** v2.1: the row form — this icon in a clay disc at the start and an arrow at the end (no art well). */
  icon?: IconName;
  /** A locale-less path (with the default LocaleLink). */
  to?: string;
  headingLevel?: 2 | 3 | 4;
  as?: C;
  className?: string;
} & Omit<ComponentPropsWithRef<C>, "as" | "className" | "children" | "title">;

export function EntryCard<C extends ElementType = typeof LocaleLink>({ title, text, cta, art, icon, to, headingLevel = 3, as, className, ...rest }: EntryCardProps<C>) {
  const Tag: ElementType = as ?? LocaleLink;
  const Heading = `h${headingLevel}` as const;
  const mascot = art === "mascot";
  if (icon && !art) {
    return (
      <Tag {...rest} to={to} className={cx("entry entry--row group", className)} data-press="soft">
        <span className="clay-disc entry__disc" aria-hidden="true">
          <Icon name={icon} size={24} />
        </span>
        <span className="grid min-w-0 content-center gap-0.5">
          <Heading className="entry__title">{title}</Heading>
          {text ? <span className="entry__text">{text}</span> : null}
          {cta ? <span className="link__text type-sm-strong text-ink">{cta}</span> : null}
        </span>
        <Icon name="arrow-right" size={22} className="entry__go" />
      </Tag>
    );
  }
  return (
    // without a picture the words take the whole card (no empty 96 / 160px column at the end)
    <Tag {...rest} to={to} className={cx("entry group", !art && "grid-cols-1", className)} data-press="soft">
      <span className="grid min-w-0 content-center gap-1">
        <Heading className="entry__title">{title}</Heading>
        {text ? <span className="entry__text">{text}</span> : null}
        {cta ? (
          <span className="link mt-1 justify-self-start">
            <span className="link__text">{cta}</span>
            <Icon name="arrow-right" size={16} />
          </span>
        ) : null}
      </span>
      {art ? (
        <span className={cx("entry__art", mascot && "entry__art--mark")} aria-hidden="true">
          {mascot ? (
            <span className="absolute inset-0 grid place-items-center text-logo">
              <Logo variant="mark" height="56%" />
            </span>
          ) : typeof art === "string" ? (
            <span className="render-slot absolute inset-[8%]">
              <Render name={art} alt="" sizes="(min-width: 1024px) 160px, 96px" className="group-hover:scale-103" />
            </span>
          ) : (
            art
          )}
        </span>
      ) : null}
    </Tag>
  );
}
