import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { Band } from "~/ui/Band";
import { cx } from "~/ui/cx";

/**
 * The account's money card (Design v2.1, the client's reference card «محفظتي»): the kit's wallet band — crimson in the
 * light theme, deep crimson glass in the dark — made glossy (account.css `.acct-money`: the light sits behind the disc,
 * never behind the words), with the label, the figure that
 * matters (the points in Kufam, counted once; the balance as a price), a line under it, a frosted disc with the icon at
 * the inline end, and an optional foot under a hairline (the next expiry, a top-up under review).
 *
 *   <MoneyCard id="points-card" label={t("rewards.cardLabel")} icon="star" figure={<CountUp … />} line={worth} foot={expiry} />
 *   <MoneyCard id="wallet-card" label={tShop("wallet.label")} icon="wallet" figure={<Price … tone="onColor" />} />
 *
 * The label is the card's heading (h2 by default). Text on the band is the band's own ink (white in light), never a
 * status colour on crimson: a state on it is `.acct-money__chip` (white glass).
 */
export function MoneyCard({
  id,
  label,
  icon,
  figure,
  line,
  foot,
  headingLevel = 2,
  className,
}: {
  id: string;
  label: ReactNode;
  icon: IconName;
  figure: ReactNode;
  line?: ReactNode;
  foot?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <Band kind="wallet" as="section" aria-labelledby={id} className={cx("acct-money", className)} contentClassName="acct-money__body">
      <div className="acct-money__text">
        <Heading id={id} className="acct-money__label">
          {label}
        </Heading>
        <div className="acct-money__figure">{figure}</div>
        {line ? <div className="acct-money__line">{line}</div> : null}
      </div>
      <span className="acct-money__disc" aria-hidden="true">
        <Icon name={icon} size={32} />
      </span>
      {foot ? <div className="acct-money__foot">{foot}</div> : null}
    </Band>
  );
}
