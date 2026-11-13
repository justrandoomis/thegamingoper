import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { MotionLink, type NavKind } from "~/motion";
import { cx } from "~/ui/cx";

export type LinkRow = {
  /** Locale-less path (a query and a #fragment are kept). */
  to: string;
  icon: IconName;
  title: string;
  hint?: ReactNode;
  /** Words at the end in secondary ink (a status such as «نسخة أولى»). */
  aside?: ReactNode;
  /** DESIGN.md §7.2 navigation grammar: "push" (with `order`) between sibling policies, "fade" otherwise. */
  nav?: NavKind;
  order?: number;
};

/**
 * Rows of links (Design System v2 §4.20 fact-row anatomy, as links; v2.1: the before's rows, client notes 4 and 9 —
 * the icon at the before's weight on a raised clay disc, the title in Kufam, a 16px hint): the disc, the title over an
 * optional hint, optional words at the end and a caret that points along the reading direction and nudges toward it
 * under the pointer. The whole row is the link — at least 64px tall, the engine's soft press, the title underlined
 * under the pointer. Between hairlines on the page, or `card`: inside one soft raised card (dark: faux glass).
 */
export function LinkRows({ rows, card = false, className }: { rows: readonly LinkRow[]; card?: boolean; className?: string }) {
  return (
    <ul className={cx("crows", card && "crows--card", className)}>
      {rows.map((row) => (
        <li key={row.to}>
          <MotionLink to={row.to} nav={row.nav ?? "fade"} order={row.order} data-press="soft" className="crow">
            <span className="clay-disc crow__disc" aria-hidden="true">
              <Icon name={row.icon} size={20} />
            </span>
            <span className="crow__copy">
              <span className="crow__title">{row.title}</span>
              {row.hint ? <span className="crow__hint">{row.hint}</span> : null}
            </span>
            <span className="crow__end">
              {row.aside ? <span>{row.aside}</span> : null}
              <Icon name="caret-right" size={18} className="crow__go" />
            </span>
          </MotionLink>
        </li>
      ))}
    </ul>
  );
}
