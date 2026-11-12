/**
 * Page titles of module 08 from its own strings ("admin-promotions", sent by the promotions layout's loader), through
 * the shell's adminMeta (noindex, the admin suffix). Falls back to the module's name.
 *
 *   export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "coupons.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const PROMOTIONS_LAYOUT_ID = "routes/admin/promotions/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function promotionsMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars, title?: string | L10n | null) {
  const layout = args.matches.find((match) => match?.id === PROMOTIONS_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-promotions"];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const named = typeof title === "string" ? title : title ? pick(title, locale) : null;
  const page = named || (key && tree ? translate(tree, locale, key, vars) : undefined);
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.promotions")}` : t("modules.promotions")));
}
