import { useLayoutEffect, useRef } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useLocale, useT } from "~/i18n/react";
import { localePath, type Locale } from "~/lib/locales";
import { cx } from "./cx";

/**
 * Breadcrumbs — where this page sits ("الرئيسية › أجهزة › PlayStation 5 Pro"). The separators are carets that point
 * the way the trail reads, so they flip in Arabic and Sorani by themselves; the last item is the current page
 * (`aria-current="page"`, not a link). One line: on a narrow screen it scrolls sideways and starts scrolled to the
 * current page. Links take the locale-less path (LocaleLink adds /en or /ckb).
 *
 *   <Breadcrumbs items={[{ label: t("home"), href: "/" }, { label: category.name, href: `/c/${category.slug}` }, { label: product.name }]}
 *                jsonLd={{ origin: PUBLIC_ORIGIN }} />
 *
 * `jsonLd` adds a schema.org BreadcrumbList with absolute URLs for search engines (`origin` = the site's public
 * origin, e.g. from the root loader). It is serialised data — every "<", ">" and "&" is escaped — not markup.
 */
export type Crumb = {
  /** Plain text: it is also what search engines see. */
  label: string;
  /** Locale-less path. The last crumb (the current page) needs none. */
  href?: string;
};

export type BreadcrumbsProps = {
  items: readonly Crumb[];
  /** Emit schema.org BreadcrumbList JSON-LD with absolute URLs on this origin ("https://tamtamgames.com"). */
  jsonLd?: { origin: string };
  className?: string;
};

export function Breadcrumbs({ items, jsonLd, className }: BreadcrumbsProps) {
  const t = useT("ui-overlays");
  const locale = useLocale();
  const list = useRef<HTMLOListElement | null>(null);

  // Narrow screens: start scrolled to the current page (the inline end), whatever the direction.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || element.scrollWidth <= element.clientWidth) return;
    const rtl = getComputedStyle(element).direction === "rtl";
    element.scrollLeft = rtl ? -element.scrollWidth : element.scrollWidth;
  }, [items]);

  if (items.length === 0) return null;
  const last = items.length - 1;
  return (
    <nav aria-label={t("breadcrumbs.label")} className={cx("min-w-0", className)}>
      <ol ref={list} className="flex min-w-0 items-center overflow-x-auto whitespace-nowrap type-caption [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item, index) => (
          <li key={`${index}:${item.label}`} className="flex shrink-0 items-center">
            {index > 0 ? <Icon name="caret-right" size={14} className="mx-1 text-ink-3" /> : null}
            {index === last || !item.href ? (
              <span aria-current={index === last ? "page" : undefined} className={cx("inline-flex min-h-11 items-center", index === last ? "font-semibold text-ink" : "text-ink-2")}>
                <bdi>{item.label}</bdi>
              </span>
            ) : (
              <LocaleLink
                to={item.href}
                className="inline-flex min-h-11 items-center rounded-xs text-ink-2 decoration-[1.5px] underline-offset-[6px] hover:text-ink hover:underline"
              >
                <bdi>{item.label}</bdi>
              </LocaleLink>
            )}
          </li>
        ))}
      </ol>
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: breadcrumbJsonLd(items, jsonLd.origin, locale) }} /> : null}
    </nav>
  );
}

/** U+2028 and U+2029 are line terminators to older JavaScript parsers: written as JSON escapes instead. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * schema.org BreadcrumbList for `items`, serialised safely for a <script type="application/ld+json"> (exported for
 * tests). Crumbs with an href get an absolute URL in the page's language; the current page may have none.
 */
export function breadcrumbJsonLd(items: readonly Crumb[], origin: string, locale: Locale): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.label,
      ...(item.href ? { item: new URL(localePath(item.href, locale), origin).href } : {}),
    })),
  };
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}
