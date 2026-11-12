import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink } from "~/i18n/react";
import { cx } from "./cx";
import { Render } from "./Stage";

/**
 * The entry card — Design System v2 §4.25: a door to a service (trade-in, used & inspected, support). Paper, --r-lg, a
 * hairline, padding 20 (24 from 1024); the words at the start (a type-h3 title, one 14px line, a text-link cue) and an
 * image well at the end (96px phones, 160 from 1024) holding a hardware cut-out or the mascot. The WHOLE card is one
 * link (so its cue is drawn as a link, not a second anchor); under the pointer the picture grows 1.03.
 *
 *   <EntryCard to="/used" title={t("used")} text={t("usedLine")} cta={t("browseUsed")} art="playstation-5-slim--1" />
 *   <EntryCard to="/support" title={t("support")} text={t("supportLine")} cta={t("openSupport")} art="mascot" />
 */
export type EntryCardProps<C extends ElementType = typeof LocaleLink> = {
  title: ReactNode;
  text?: ReactNode;
  /** The link words at the end of the copy («استبدل جهازك»). */
  cta?: ReactNode;
  /** A product photo key, "mascot", or your own node. */
  art?: string | ReactNode;
  /** A locale-less path (with the default LocaleLink). */
  to?: string;
  headingLevel?: 2 | 3 | 4;
  as?: C;
  className?: string;
} & Omit<ComponentPropsWithRef<C>, "as" | "className" | "children" | "title">;

export function EntryCard<C extends ElementType = typeof LocaleLink>({ title, text, cta, art, to, headingLevel = 3, as, className, ...rest }: EntryCardProps<C>) {
  const Tag: ElementType = as ?? LocaleLink;
  const Heading = `h${headingLevel}` as const;
  const mascot = art === "mascot";
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
