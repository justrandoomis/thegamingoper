import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { cx } from "./cx";
import { TextLink } from "./TextLink";

/**
 * Fact rows — Design System v2 §4.20: a 20px icon, a title (14/600), a line (14 ink-2) and an optional 44px link,
 * separated by hairlines. The PDP facts card, the quick look, the cart and the used unit. Only true facts: every row is
 * data the caller has (the fee from settings, the returns policy, the warranty when known).
 *
 *   <FactList facts={[
 *     { icon: "truck", title: t("deliveryFee", { price }), text: t("deliveryWhen") },
 *     { icon: "arrow-counter-clockwise", title: t("returns7"), link: { label: t("returnsPolicy"), to: "/policies/returns" } },
 *   ]} />
 *   <FactList plain facts={…} />                 no card: rows between hairlines inside another surface
 */
export type Fact = {
  icon: IconName;
  title: ReactNode;
  text?: ReactNode;
  /** A link at the end of the row (44px). */
  link?: { label: string; to: string } | ReactNode;
  /** A stable key when titles repeat. */
  id?: string;
};

export function FactList({ facts, plain = false, className }: { facts: readonly Fact[]; plain?: boolean; className?: string }) {
  if (facts.length === 0) return null;
  return (
    <ul className={cx("facts", plain && "facts--plain", className)}>
      {facts.map((fact, index) => (
        <li key={fact.id ?? index} className="fact">
          <Icon name={fact.icon} size={20} className="fact__icon" />
          <span className="fact__title">{fact.title}</span>
          {fact.text ? <span className="fact__text">{fact.text}</span> : null}
          {fact.link ? <span className="fact__link">{isLink(fact.link) ? <TextLink as={LocaleLink} to={fact.link.to}>{fact.link.label}</TextLink> : fact.link}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function isLink(value: unknown): value is { label: string; to: string } {
  return typeof value === "object" && value !== null && "to" in value && "label" in value;
}
