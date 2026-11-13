import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { cx } from "~/ui/cx";

export type QuickTile = {
  key: string;
  icon: IconName;
  label: ReactNode;
  /** A short fact under the label. */
  hint?: ReactNode;
  /** A locale-less path. With `order`, an account section reached by the sideways push. */
  to?: string;
  order?: number;
  /** An anchor on this page ("#referral"). */
  href?: string;
};

/**
 * Quick tiles (Design v2.1, the reference card's «إيداع · سحب · سجل العمليات»): clay squares with a red line icon and
 * the words under it, three in a row under the money card; from 1024, beside the card, the same links are rows with a
 * chevron. Each tile is one link (a page, an account section, or an anchor on this page).
 */
export function QuickTiles({ label, tiles, className }: { label: string; tiles: readonly QuickTile[]; className?: string }) {
  return (
    <nav aria-label={label} className={cx("acct-qa", className)}>
      <ul className="acct-qa__list">
        {tiles.map((tile) => (
          <li key={tile.key} className="grid">
            <TileLink tile={tile} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TileLink({ tile }: { tile: QuickTile }) {
  const inner = (
    <>
      <span className="acct-qa__icon" aria-hidden="true">
        <Icon name={tile.icon} size={26} />
      </span>
      <span className="acct-qa__text">
        <span className="acct-qa__label">{tile.label}</span>
        {tile.hint ? <span className="acct-qa__hint">{tile.hint}</span> : null}
      </span>
      <Icon name="caret-right" size={18} className="acct-qa__go" />
    </>
  );
  // real frosted glass (three tiles: within the screen's glass budget) over the money card's ambient light
  const className = "surface surface--glass lift acct-qa__tile";
  if (tile.href) {
    return (
      <a href={tile.href} className={className} data-press="soft">
        {inner}
      </a>
    );
  }
  if (tile.order !== undefined) {
    return (
      <MotionLink to={tile.to ?? "/account"} nav="push" order={tile.order} className={className} data-press="soft">
        {inner}
      </MotionLink>
    );
  }
  return (
    <LocaleLink to={tile.to ?? "/"} className={className} data-press="soft">
      {inner}
    </LocaleLink>
  );
}
