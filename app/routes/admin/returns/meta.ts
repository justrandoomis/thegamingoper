/**
 * Page titles of module 12 from its own strings ("admin-returns", sent by the returns layout's loader), through the
 * shell's adminMeta (noindex, the admin suffix). Falls back to the module's name.
 *
 *   export const meta: Route.MetaFunction = (args) => returnsMeta(args, "repairs.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const RETURNS_LAYOUT_ID = "routes/admin/returns/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function returnsMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars, title?: string | null) {
  const layout = args.matches.find((match) => match?.id === RETURNS_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-returns"];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = title || (key && tree ? translate(tree, locale, key, vars) : undefined);
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.returns")}` : t("modules.returns")));
}
