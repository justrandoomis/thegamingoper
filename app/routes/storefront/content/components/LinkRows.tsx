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
 * Rows of links (Design System v2 §4.20 fact-row anatomy, as links): a 20px icon in secondary ink, the title (14/600)
 * over an optional 13px hint, optional words at the end and a caret that points along the reading direction. The
 * whole row is the link — at least 56px tall, the engine's soft press, the title underlined under the pointer.
 * Between hairlines on the page, or `card`: inside one paper card (no shadow).
 */
export function LinkRows({ rows, card = false, className }: { rows: readonly LinkRow[]; card?: boolean; className?: string }) {
  return (
    <ul className={cx("crows", card && "crows--card", className)}>
      {rows.map((row) => (
        <li key={row.to}>
          <MotionLink to={row.to} nav={row.nav ?? "fade"} order={row.order} data-press="soft" className="crow">
            <Icon name={row.icon} size={20} className="crow__icon" />
            <span className="crow__copy">
              <span className="crow__title">{row.title}</span>
              {row.hint ? <span className="crow__hint">{row.hint}</span> : null}
            </span>
            <span className="crow__end">
              {row.aside ? <span>{row.aside}</span> : null}
              <Icon name="caret-right" size={18} />
            </span>
          </MotionLink>
        </li>
      ))}
    </ul>
  );
}
