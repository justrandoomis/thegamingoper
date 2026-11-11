import type { ReactNode } from "react";

import { LocaleLink, useT } from "~/i18n/react";
import { cx } from "./cx";
import { TextLink } from "./TextLink";

/**
 * The section head — Design System v2 §4.22: the h2 and an HONEST reason line at the start («أحدث ما أضفناه، والمتوفر
 * الآن» — never "customers also bought" without real data), «عرض الكل» at the end aligned to the h2, and an optional
 * chip row below (platform dot chips that filter the shelf in place).
 *
 *   <SectionHead id="new-title" title={t("newTitle")} reason={t("newReason")} href="/c/new" />
 *   <SectionHead title={…} reason={…} chips={<ChipGroup rail bleed … />} />
 */
export type SectionHeadProps = {
  title: ReactNode;
  /** One honest line saying why these items are here. */
  reason?: ReactNode;
  /** «عرض الكل» → this locale-less path. */
  href?: string;
  /** Default «عرض الكل». */
  viewAllLabel?: ReactNode;
  /** The heading's id (point the section's aria-labelledby at it). */
  id?: string;
  headingLevel?: 2 | 3;
  chips?: ReactNode;
  className?: string;
};

export function SectionHead({ title, reason, href, viewAllLabel, id, headingLevel = 2, chips, className }: SectionHeadProps) {
  const t = useT("ui-shop");
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cx("sechead", className)}>
      <div className="sechead__text">
        <Heading id={id} className={cx("sechead__title", headingLevel === 3 && "type-h3")}>
          {title}
        </Heading>
        {reason ? <p className="sechead__reason">{reason}</p> : null}
      </div>
      {href ? (
        <TextLink as={LocaleLink} to={href}>
          {viewAllLabel ?? t("shelf.viewAll")}
        </TextLink>
      ) : null}
      {/* min-width 0: a flex item would otherwise grow to the chip row's full length and the row would never scroll */}
      {chips ? <div className="sechead__chips min-w-0">{chips}</div> : null}
    </div>
  );
}
