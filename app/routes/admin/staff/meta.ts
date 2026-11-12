/**
 * Page titles of module 15 from its own strings ("admin-staff", sent by the staff layout's loader), through the
 * shell's adminMeta (noindex, the admin suffix): "<page> · الموظفون · <suffix>".
 *
 *   export const meta: Route.MetaFunction = (args) => staffMeta(args, "schedule.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const STAFF_LAYOUT_ID = "routes/admin/staff/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function staffMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars) {
  const layout = args.matches.find((match) => match?.id === STAFF_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-staff"];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = tree && key ? translate(tree, locale, key, vars) : undefined;
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.staff")}` : t("modules.staff")));
}
