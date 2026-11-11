/**
 * Page meta for every storefront page (client-safe): title template, description, Open Graph, canonical URL,
 * hreflang alternates for ar / en / ckb on PUBLIC_ORIGIN, and robots noindex while the store is in demo mode.
 *
 * The storefront layout uses it for its own `meta` export (so pages without one get the store's defaults). React
 * Router replaces — never merges — a parent's meta when a child exports `meta`, so a page passes its own title
 * through the same helper:
 *
 *   import { shellMeta } from "~/routes/storefront/shell/meta";
 *   export const meta: Route.MetaFunction = (args) =>
 *     shellMeta(args, { title: args.loaderData?.product.name, description: args.loaderData?.product.short, image, type: "product" });
 *
 *   → <title>PlayStation 5 Pro — طمطم</title>, description, og:*, twitter:card, canonical, 4 × hreflang, robots
 *
 * Errors (the layout's ErrorBoundary) get "الصفحة غير موجودة — طمطم" / "حدث خطأ — طمطم", noindex and no canonical.
 * Everything is read from the matches (root and layout loader data), so the helper works in any storefront route.
 */
import { isRouteErrorResponse, type MetaDescriptor } from "react-router";

import { makeT, type MessageTree } from "~/i18n/translate";
import { DEFAULT_LOCALE, LOCALE_CODES, LOCALES, isLocale, localePath, splitLocale, type Locale } from "~/lib/locales";
import { formatMoney } from "~/lib/money";
import type { ShellData } from "./types";

/** Route id of the storefront layout (file path without the extension). */
export const LAYOUT_ROUTE_ID = "routes/storefront/_layout";

type MetaMatchLike = { id: string; loaderData?: unknown } | undefined;

/** The part of any route's `Route.MetaArgs` the helper reads. */
export type ShellMetaArgs = {
  location: { pathname: string };
  matches: readonly MetaMatchLike[];
  error?: unknown;
};

export type PageMetaInput = {
  /** The page's own title; the template adds the store's name ("{title} — طمطم"). Omit for the store's title. */
  title?: string | null;
  /** One or two plain sentences. Default: the store's description (with the delivery fee). */
  description?: string | null;
  /** Absolute URL or a path on this site ("/products/x.png"). Default: the store icon. */
  image?: string | null;
  /** og:type. Default "website". */
  type?: "website" | "product" | "article";
  /** Keep this page out of search results (always on in demo mode and on error pages). */
  noindex?: boolean;
  /** A query string the canonical URL keeps, e.g. "?page=2". Default: none. */
  canonicalSearch?: string;
};

type RootMetaData = { locale?: Locale; storeMode?: "demo" | "live"; origin?: string };
type LayoutMetaData = { shell?: Pick<ShellData, "publicOrigin" | "deliveryFeeIqd">; i18n?: { shell?: MessageTree } };

const OG_LOCALE: Record<Locale, string> = { ar: "ar_IQ", en: "en_IQ", ckb: "ckb_IQ" };

function dataOf<T>(args: ShellMetaArgs, id: string): T | undefined {
  return args.matches.find((match) => match?.id === id)?.loaderData as T | undefined;
}

/** The strings: from the layout's data, or — when the layout's own loader failed — from its thrown data. */
function messagesOf(args: ShellMetaArgs, layout: LayoutMetaData | undefined): MessageTree | undefined {
  if (layout?.i18n?.shell) return layout.i18n.shell;
  if (isRouteErrorResponse(args.error)) return (args.error.data as LayoutMetaData | null)?.i18n?.shell;
  return undefined;
}

function absolute(origin: string, url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** "/en/p/x/" → "/en/p/x"; "/" stays "/". */
function cleanPath(pathname: string): string {
  const path = pathname.replace(/\/{2,}/g, "/");
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

export function shellMeta(args: ShellMetaArgs, page: PageMetaInput = {}): MetaDescriptor[] {
  const root = dataOf<RootMetaData>(args, "root");
  const layout = dataOf<LayoutMetaData>(args, LAYOUT_ROUTE_ID);
  const locale: Locale = root?.locale && isLocale(root.locale) ? root.locale : DEFAULT_LOCALE;
  const t = makeT(messagesOf(args, layout), locale, "shell");
  const origin = layout?.shell?.publicOrigin ?? root?.origin ?? "";
  const fee = layout?.shell?.deliveryFeeIqd;
  const siteName = t("meta.siteName");

  const failed = args.error !== undefined && args.error !== null;
  const notFound = failed && isRouteErrorResponse(args.error) && args.error.status === 404;
  const title = failed ? t("meta.titleTemplate", { title: t(notFound ? "meta.notFound" : "meta.error") }) : page.title ? t("meta.titleTemplate", { title: page.title }) : t("meta.defaultTitle");
  const description = page.description || (fee !== undefined ? t("meta.description", { fee: formatMoney(fee, "IQD", locale, "latn") }) : "");
  const noindex = failed || page.noindex === true || root?.storeMode !== "live";

  const meta: MetaDescriptor[] = [{ title }];
  if (description) meta.push({ name: "description", content: description });
  if (noindex) meta.push({ name: "robots", content: "noindex, nofollow" });
  if (failed || !origin) return meta;

  // canonical + one alternate per language (x-default = Arabic, the source language)
  const { path } = splitLocale(cleanPath(args.location.pathname));
  const urlFor = (code: Locale) => `${origin}${localePath(path, code)}`;
  const canonical = `${urlFor(locale)}${page.canonicalSearch ?? ""}`;
  meta.push({ tagName: "link", rel: "canonical", href: canonical });
  for (const code of LOCALE_CODES) meta.push({ tagName: "link", rel: "alternate", hrefLang: LOCALES[code].bcp47, href: urlFor(code) });
  meta.push({ tagName: "link", rel: "alternate", hrefLang: "x-default", href: urlFor(DEFAULT_LOCALE) });

  // Open Graph and the card shown when a link is shared
  const image = absolute(origin, page.image || "/icon-512.png");
  meta.push(
    { property: "og:site_name", content: siteName },
    { property: "og:type", content: page.type ?? "website" },
    { property: "og:title", content: page.title || t("meta.defaultTitle") },
    { property: "og:url", content: canonical },
    { property: "og:locale", content: OG_LOCALE[locale] },
    ...LOCALE_CODES.filter((code) => code !== locale).map((code) => ({ property: "og:locale:alternate", content: OG_LOCALE[code] })),
    { property: "og:image", content: image },
    { name: "twitter:card", content: page.image ? "summary_large_image" : "summary" },
  );
  if (description) meta.push({ property: "og:description", content: description });
  return meta;
}
