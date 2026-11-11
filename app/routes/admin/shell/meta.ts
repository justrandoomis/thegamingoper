/**
 * <title> and robots for admin pages. React Router replaces the layout's meta with the page's (it does not merge),
 * so every admin page builds its meta with this helper — it keeps `noindex, nofollow` (the X-Robots-Tag header says
 * the same) and adds the admin suffix in the admin's language.
 *
 *   export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("me.title"));
 *   export const meta: Route.MetaFunction = (args) => adminMeta(args, args.loaderData?.title);
 */
import { translate, type MessageTree } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";

export const ADMIN_LAYOUT_ID = "routes/admin/_layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;
type MetaArgsLike = { matches: readonly MatchLike[] };
type LayoutData = { i18n?: { admin?: MessageTree }; shell?: { locale?: Locale } };

/** A `t()` over the admin strings found in the layout's loader data (null when the layout has no data). */
export function adminMetaT(args: MetaArgsLike): ((key: string, vars?: Record<string, string | number>) => string) | null {
  const layout = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const data = (layout?.loaderData ?? layout?.data) as LayoutData | undefined;
  const tree = data?.i18n?.admin;
  if (!tree) return null;
  const locale: Locale = data?.shell?.locale ?? "ar";
  return (key, vars) => translate(tree, locale, key, vars) ?? key;
}

export function adminMeta(args: MetaArgsLike, title?: string | null | ((t: (key: string, vars?: Record<string, string | number>) => string) => string)) {
  const t = adminMetaT(args);
  // without the layout's data (its loader failed) only the brand name, which is the same in every language
  const suffix = t ? t("brand.suffix") : "TamTam";
  const page = typeof title === "function" ? (t ? title(t) : null) : title;
  return [{ title: page ? `${page} · ${suffix}` : suffix }, { name: "robots", content: "noindex, nofollow" }];
}
