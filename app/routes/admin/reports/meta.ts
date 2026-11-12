/**
 * Page titles of module 18 from its own strings ("admin-reports", sent by the reports layout's loader), through the
 * shell's adminMeta (noindex, the admin suffix): "<page> · التقارير · <suffix>".
 *
 *   export const meta: Route.MetaFunction = (args) => reportsMeta(args, "sales.title");
 */
import { translate, type MessageTree } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { REPORTS_NS } from "~/server/services/admin/reports/types";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const REPORTS_LAYOUT_ID = "routes/admin/reports/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function reportsMeta(args: { matches: readonly MatchLike[] }, key: string | null) {
  const layout = args.matches.find((match) => match?.id === REPORTS_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.[REPORTS_NS];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = tree && key ? translate(tree, locale, key) : undefined;
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.reports")}` : t("modules.reports")));
}
