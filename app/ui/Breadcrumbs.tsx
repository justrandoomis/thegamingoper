import { useState } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useLocale, useT } from "~/i18n/react";
import { localePath, type Locale } from "~/lib/locales";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";

/**
 * Breadcrumbs — Design System v2 §4.22: where this page sits («الرئيسية › أجهزة › PlayStation 5 Pro»), from 768 (phones use
 * the page title and the browser's back) — or at every width with `phone` (v2.1: the product page's bar, client note 5).
 * 14px ink-2, chevrons that point the way the trail reads (they
 * mirror in Arabic and Sorani by themselves), the current page in ink 600 with `aria-current="page"` (not a link), 44px
 * hit areas. A long trail collapses its middle to «…» (a button that shows the whole trail). Links take the
 * locale-less path (LocaleLink adds /en or /ckb).
 *
 *   <Breadcrumbs items={[{ label: t("home"), href: "/" }, { label: category.name, href: `/c/${category.slug}` }, { label: product.name }]}
 *                jsonLd={{ origin: PUBLIC_ORIGIN }} />
 *
 * `jsonLd` adds a schema.org BreadcrumbList with absolute URLs for search engines (`origin` = the site's public
 * origin, e.g. from the root loader) — also on phones, where the trail is not drawn. It is serialised data — every
 * "<", ">" and "&" is escaped — not markup.
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
  /**
   * v2.1: draw the trail on phones too (the before's bar above the product block — client note 5): one line that
   * scrolls sideways, the current page kept in view. Default: from 768 only.
   */
  phone?: boolean;
  className?: string;
};

/** More crumbs than this and the middle collapses to «…». */
const COLLAPSE_AFTER = 4;

export function Breadcrumbs({ items, jsonLd, phone = false, className }: BreadcrumbsProps) {
  const t = useT("ui-overlays");
  const locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const last = items.length - 1;
  const collapse = !expanded && items.length > COLLAPSE_AFTER;
  // first · … · the last two
  const shown = collapse ? [0, -1, last - 1, last] : items.map((_, index) => index);

  return (
    <>
      <nav aria-label={t("breadcrumbs.label")} className={cx("crumbs", phone && "crumbs--phone", className)}>
        <ol className="crumbs__list">
          {shown.map((index, position) => (
            <li key={index} className="flex items-center gap-1">
              {position > 0 ? <Icon name="caret-right" size={16} className="crumbs__sep" /> : null}
              {index === -1 ? (
                <button type="button" className="crumbs__link hit-44 relative px-1" aria-label={t("breadcrumbs.expand")} onClick={() => setExpanded(true)}>
                  …
                </button>
              ) : index === last || !items[index].href ? (
                <span aria-current={index === last ? "page" : undefined} className={cx("inline-flex min-h-11 items-center", index === last && "crumbs__current")}>
                  <BidiLabel>{items[index].label}</BidiLabel>
                </span>
              ) : (
                <LocaleLink to={items[index].href as string} className="crumbs__link min-w-11 justify-center">
                  <BidiLabel>{items[index].label}</BidiLabel>
                </LocaleLink>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: breadcrumbJsonLd(items, jsonLd.origin, locale) }} /> : null}
    </>
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
