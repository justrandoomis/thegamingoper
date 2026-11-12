import type { ReactNode } from "react";

import { LocaleLink, useT } from "~/i18n/react";
import { cx } from "./cx";
import { TextLink } from "./TextLink";

/**
 * The section head — Design System v2 §4.22: the h2 and an HONEST reason line at the start («أحدث ما أضفناه، والمتوفر
 * الآن» — never "customers also bought" without real data), «عرض الكل» at the end ON THE H2'S LINE (its words sit on the
 * heading's baseline, the reason line runs under both), and an optional chip row below (platform dot chips that filter
 * the shelf in place).
 *
 *   <SectionHead id="new-title" title={t("newTitle")} reason={t("newReason")} href="/c/new" />
 *   <SectionHead title={…} reason={…} chips={<ChipGroup rail bleed … />} />
 *   <SectionHead title={…} action={<Key size="sm" …>{t("clear")}</Key>} />      your own action in the «عرض الكل» place
 */
export type SectionHeadProps = {
  title: ReactNode;
  /** One honest line saying why these items are here. */
  reason?: ReactNode;
  /** «عرض الكل» → this locale-less path. */
  href?: string;
  /** Default «عرض الكل». */
  viewAllLabel?: ReactNode;
  /** Your own action at the end of the heading's line, in place of «عرض الكل» (a key, a link, a menu). */
  action?: ReactNode;
  /** The heading's id (point the section's aria-labelledby at it). */
  id?: string;
  headingLevel?: 2 | 3;
  chips?: ReactNode;
  className?: string;
};

export function SectionHead({ title, reason, href, viewAllLabel, action, id, headingLevel = 2, chips, className }: SectionHeadProps) {
  const t = useT("ui-shop");
  const Heading = `h${headingLevel}` as const;
  const end =
    action ??
    (href ? (
      <TextLink as={LocaleLink} to={href}>
        {viewAllLabel ?? t("shelf.viewAll")}
      </TextLink>
    ) : null);
  return (
    <div className={cx("sechead", className)}>
      {/* the heading and its action share one line (baseline-aligned); the reason line runs under both */}
      <div className="sechead__text basis-full">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <Heading id={id} className={cx("sechead__title min-w-0", headingLevel === 3 && "type-h3")}>
            {title}
          </Heading>
          {end ? <div className="flex shrink-0 items-center">{end}</div> : null}
        </div>
        {reason ? <p className="sechead__reason">{reason}</p> : null}
      </div>
      {/* min-width 0: a flex item would otherwise grow to the chip row's full length and the row would never scroll */}
      {chips ? <div className="sechead__chips min-w-0">{chips}</div> : null}
    </div>
  );
}
