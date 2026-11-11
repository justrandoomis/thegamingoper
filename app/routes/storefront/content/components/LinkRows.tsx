import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { MotionLink, type NavKind } from "~/motion";
import { cx } from "~/ui/cx";

export type LinkRow = {
  /** Locale-less path. */
  to: string;
  icon: IconName;
  title: string;
  hint?: ReactNode;
  /** Trailing words in secondary ink (a status such as "مسودة"). */
  aside?: ReactNode;
  /** DESIGN.md §7.2 navigation grammar: "push" (with `order`) between sibling policies, "fade" otherwise. */
  nav?: NavKind;
  order?: number;
};

/**
 * Rows of links between hairlines: an icon in a small niche, the title, an optional hint and a caret that points
 * along the reading direction. The whole row is the link (at least 56px tall), with the engine's soft press.
 */
export function LinkRows({ rows, className }: { rows: readonly LinkRow[]; className?: string }) {
  return (
    <ul className={cx("grid", className)}>
      {rows.map((row) => (
        <li key={row.to} className="border-b border-line last:border-b-0">
          <MotionLink to={row.to} nav={row.nav ?? "fade"} order={row.order} data-press="soft" className="group flex min-h-14 items-center gap-3 py-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-niche text-ink">
              <Icon name={row.icon} size={20} />
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="type-strong text-ink decoration-[1.5px] underline-offset-[6px] group-hover:underline">{row.title}</span>
              {row.hint ? <span className="type-caption text-ink-2">{row.hint}</span> : null}
            </span>
            {row.aside ? <span className="shrink-0 type-caption text-ink-2">{row.aside}</span> : null}
            <Icon name="caret-right" size={18} className="shrink-0 text-ink-2" />
          </MotionLink>
        </li>
      ))}
    </ul>
  );
}
