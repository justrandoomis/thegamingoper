/**
 * Page titles of module 10 from its own strings ("admin-finance", sent by the finance layout's loader), through the
 * shell's adminMeta (noindex, the admin suffix): "<page> · المالية والمحاسبة · <suffix>".
 *
 *   export const meta: Route.MetaFunction = (args) => financeMeta(args, "journal.title");
 */
import { translate, type MessageTree } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const FINANCE_LAYOUT_ID = "routes/admin/finance/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function financeMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Record<string, string | number>) {
  const layout = args.matches.find((match) => match?.id === FINANCE_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-finance"];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = tree && key ? translate(tree, locale, key, vars) : undefined;
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.finance")}` : t("modules.finance")));
}
