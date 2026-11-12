import type { CSSProperties } from "react";
import { Link, type LinkProps } from "react-router";

import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { Key } from "./Key";

/**
 * Pagination — numbered pages and the cursor "show more" (list state lives in the URL, so both are links by
 * default; pass `onPage` / `onMore` to drive a fetcher instead).
 *
 *   <Pagination page={page} pageCount={pages} href={(n) => `?page=${n}`} />            numbered (admin, search)
 *   <ShowMore shown={items.length} total={total} href={next ? `?cursor=${next}` : null} />   cursor lists (storefront)
 *   <ShowMore shown={items.length} total={total} onMore={() => fetcher.load(nextUrl)} loading={fetcher.state !== "idle"} />
 *
 * Numbered: previous / next round keys (arrows follow the reading direction), the page numbers as small keys with
 * the current one held down (`aria-current="page"`), gaps as "…", a constant number of slots so the row never jumps.
 * Phones show "الصفحة 3 من 12" between the arrows instead of the numbers. Nothing renders for a single page.
 * Show more: how many are shown (announced politely when it changes), a flat progress line, one key; when everything
 * is shown the key goes and the line says so.
 */

/**
 * A link to a locale-less path ("/c/consoles", through <LocaleLink>) or to this page with another query or hash
 * ("?page=2", "#reviews", through react-router's <Link> so the path is kept). Query links keep the scroll position.
 */
export type HrefLinkProps = Omit<LinkProps, "to"> & { to: string };

export function HrefLink({ to, preventScrollReset, ...rest }: HrefLinkProps) {
  if (/^[?#]/.test(to)) return <Link {...rest} to={to} preventScrollReset={preventScrollReset ?? true} />;
  return <LocaleLink {...rest} to={to} preventScrollReset={preventScrollReset} />;
}

/** One page number or a gap ("…"). */
export type PageSlot = number | "gap";

/**
 * The numbers to show for `page` of `count`: the first and last `boundary` pages, `siblings` on each side of the
 * current one, and gaps. The number of slots stays the same wherever the current page is (when count allows), and a
 * gap never hides a single page (that page is shown instead).
 */
export function pageWindow(page: number, count: number, siblings = 1, boundary = 1): PageSlot[] {
  if (!Number.isFinite(count) || count < 1) return [];
  const total = Math.floor(count);
  const current = Math.min(Math.max(Math.floor(page) || 1, 1), total);
  const range = (from: number, to: number) => (to < from ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i));
  const start = range(1, Math.min(boundary, total));
  const end = range(Math.max(total - boundary + 1, boundary + 1), total);
  const middleStart = Math.max(Math.min(current - siblings, total - boundary - siblings * 2 - 1), boundary + 2);
  const middleEnd = Math.min(Math.max(current + siblings, boundary + siblings * 2 + 2), end.length > 0 ? end[0] - 2 : total - 1);
  return [
    ...start,
    ...(middleStart > boundary + 2 ? (["gap"] as const) : boundary + 1 < total - boundary ? [boundary + 1] : []),
    ...range(middleStart, middleEnd),
    ...(middleEnd < total - boundary - 1 ? (["gap"] as const) : total - boundary > boundary ? [total - boundary] : []),
    ...end,
  ];
}

export type PaginationProps = {
  /** 1-based. */
  page: number;
  pageCount: number;
  /** Link to a page (URL state, the default way): `(n) => \`?page=${n}\``. */
  href?: (page: number) => string;
  /** Or a callback (buttons). */
  onPage?: (page: number) => void;
  /** Pages shown on each side of the current one (default 1). */
  siblings?: number;
  "aria-label"?: string;
  className?: string;
};

export function Pagination({ page, pageCount, href, onPage, siblings = 1, className, ...rest }: PaginationProps) {
  const t = useT("ui-overlays");
  const f = useFormat();
  if (!Number.isFinite(pageCount) || pageCount <= 1) return null;
  const current = Math.min(Math.max(Math.floor(page) || 1, 1), pageCount);
  const slots = pageWindow(current, pageCount, siblings);

  const step = (target: number, icon: "arrow-left" | "arrow-right", label: string, disabled: boolean) =>
    href ? (
      <IconKey as={HrefLink} to={href(target)} icon={icon} label={label} disabled={disabled} size="sm" rel={icon === "arrow-left" ? "prev" : "next"} />
    ) : (
      <IconKey icon={icon} label={label} disabled={disabled} size="sm" onClick={() => onPage?.(target)} />
    );

  return (
    <nav aria-label={rest["aria-label"] ?? t("pagination.label")} className={cx("flex items-center justify-between gap-3 sm:justify-center", className)}>
      {step(current - 1, "arrow-left", t("pagination.previous"), current <= 1)}
      <p className="type-sm-strong text-ink sm:hidden">
        <bdi className="nums">{t("pagination.status", { page: f.number(current), count: f.number(pageCount) })}</bdi>
      </p>
      <ul role="list" className="hidden items-center gap-1.5 sm:flex">
        {slots.map((slot, index) =>
          slot === "gap" ? (
            <li key={`gap-${index}`} aria-hidden="true" className="grid w-6 place-items-center type-sm text-ink-2">
              …
            </li>
          ) : (
            <li key={slot}>
              {slot === current ? (
                <Key as="span" size="sm" held aria-current="page" className="min-w-11">
                  <span className="nums">{f.number(slot)}</span>
                </Key>
              ) : href ? (
                <Key as={HrefLink} to={href(slot)} size="sm" className="min-w-11" aria-label={t("pagination.page", { page: f.number(slot) })}>
                  <span className="nums">{f.number(slot)}</span>
                </Key>
              ) : (
                <Key size="sm" className="min-w-11" aria-label={t("pagination.page", { page: f.number(slot) })} onClick={() => onPage?.(slot)}>
                  <span className="nums">{f.number(slot)}</span>
                </Key>
              )}
            </li>
          ),
        )}
      </ul>
      {step(current + 1, "arrow-right", t("pagination.next"), current >= pageCount)}
    </nav>
  );
}

export type ShowMoreProps = {
  /** How many are on screen now. */
  shown: number;
  /** How many there are in all, when the list knows (a cursor list may not). */
  total?: number | null;
  /** The next page of the list: a link (`?cursor=…`); null when there is none. */
  href?: string | null;
  /** Or a callback (a fetcher appends the next page). */
  onMore?: () => void;
  /** The next page is loading: the key spins and stays where it is. */
  loading?: boolean;
  /** Default «اعرض المزيد»; with `step` and `products`: «اعرض 12 منتجاً آخر». */
  label?: string;
  /** Products: the line says «عرضنا 12 من 42 منتجاً», the key «اعرض 12 منتجاً آخر», the end «لا يوجد المزيد لعرضه». */
  products?: boolean;
  /** How many the next page adds (for the key's words). */
  step?: number;
  className?: string;
};

/**
 * Show more — Design System v2 §4.22: «عرضنا 12 من 42 منتجاً» (14 ink-2, announced when it changes), a 200×4 progress
 * bar (ink on --niche-2) and the secondary «اعرض 12 منتجاً آخر»; at the end «لا يوجد المزيد لعرضه».
 */
/**
 * Whether a show-more row has anything to say. An empty list, or one that fits on its first page (`step` is the page
 * size), has nothing to count or to load — no «عرضنا 1 من منتج واحد» with a full bar under a single card (QA
 * 2026-11-12). A list that paged to its end keeps the row («لا يوجد المزيد لعرضه»). Pure.
 */
export function showMoreVisible({ shown, total, step, canLoad }: { shown: number; total?: number | null; step?: number; canLoad: boolean }): boolean {
  const known = typeof total === "number" && Number.isFinite(total);
  if (!known) return canLoad;
  if (shown < total && canLoad) return true;
  if (total <= 0) return false;
  return !(step !== undefined && total <= step);
}

export function ShowMore({ shown, total, href, onMore, loading = false, label, products = false, step, className }: ShowMoreProps) {
  const t = useT("ui-overlays");
  const f = useFormat();
  const known = typeof total === "number" && Number.isFinite(total);
  const more = (known ? shown < (total as number) : true) && Boolean(href || onMore);
  if (!showMoreVisible({ shown, total, step, canLoad: Boolean(href || onMore) })) return null;
  const share = known && (total as number) > 0 ? Math.min(100, Math.round((shown / (total as number)) * 100)) : null;
  const next = known && step ? Math.min(step, (total as number) - shown) : null;
  const words =
    label ?? (products && next !== null && next > 0 ? t("pagination.moreProducts", { count: next, n: f.number(next) }) : t("pagination.more"));
  return (
    <div className={cx("showmore", className)}>
      {known ? (
        <>
          <p className="showmore__count" role="status">
            {products
              ? t("pagination.shownProducts", { count: total as number, shown: f.number(shown), total: f.number(total as number) })
              : more
                ? t("pagination.shown", { shown: f.number(shown), total: f.number(total as number) })
                : t("pagination.all", { total: f.number(total as number) })}
          </p>
          {share !== null ? (
            <span className="showmore__bar" aria-hidden="true">
              <span className="showmore__fill" style={{ "--progress": `${share}%` } as CSSProperties} />
            </span>
          ) : null}
        </>
      ) : null}
      {more ? (
        href ? (
          <Key as={HrefLink} to={href} loading={loading}>
            {words}
          </Key>
        ) : (
          <Key onClick={onMore} loading={loading}>
            {words}
          </Key>
        )
      ) : products && known ? (
        <p className="showmore__end">{t("pagination.end")}</p>
      ) : null}
    </div>
  );
}
