import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { Render } from "./Stage";

/**
 * The category tile — Design System v2 §4.25: a 1:1 well on the product ground (--r-lg) with a cut-out at 72%, the
 * label (14/600) under it and an optional count (13 ink-2, «18 منتجاً» — from data, never invented). Three columns on
 * phones, six from 1024 (<CategoryTiles>).
 *
 *   <CategoryTiles>
 *     {categories.map((c) => <CategoryTile key={c.slug} to={`/c/${c.slug}`} label={c.name} count={c.count} art={c.art} />)}
 *   </CategoryTiles>
 */
export type CategoryTileProps<C extends ElementType = typeof LocaleLink> = {
  label: ReactNode;
  count?: number | null;
  /** A product photo key, or your own node. */
  art?: string | ReactNode;
  to?: string;
  as?: C;
  className?: string;
} & Omit<ComponentPropsWithRef<C>, "as" | "className" | "children">;

export function CategoryTile<C extends ElementType = typeof LocaleLink>({ label, count, art, to, as, className, ...rest }: CategoryTileProps<C>) {
  const t = useT("ui-shop");
  const f = useFormat();
  const Tag: ElementType = as ?? LocaleLink;
  const counted = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  return (
    <Tag {...rest} to={to} className={cx("cat group", className)} data-press="soft">
      <span className="cat__art" aria-hidden="true">
        {typeof art === "string" ? (
          <span className="render-slot absolute inset-[14%]">
            <Render name={art} alt="" sizes="(min-width: 1024px) 160px, 30vw" className="group-hover:scale-103" />
          </span>
        ) : (
          art
        )}
      </span>
      <span className="cat__name">{label}</span>
      {counted ? <span className="cat__count">{t("tile.count", { count, n: f.number(count) })}</span> : null}
    </Tag>
  );
}

export function CategoryTiles({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <nav className={cx("cats", className)} aria-label={label}>
      {children}
    </nav>
  );
}
