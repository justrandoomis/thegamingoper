/**
 * Page titles of module 19 from its own strings (sent by the module's layout), through the shell's adminMeta (noindex,
 * the admin suffix): "<page> · <module> · <admin suffix>".
 *
 *   export const meta: Route.MetaFunction = (args) => automationMeta(args, "rules.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { AUTOMATION_NS } from "~/server/services/admin/automation/catalog";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

const LAYOUT_ID = "routes/admin/automation/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function automationMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars) {
  const layout = args.matches.find((match) => match?.id === LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.[AUTOMATION_NS];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = key && tree ? translate(tree, locale, key, vars) : undefined;
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.automation")}` : t("modules.automation")));
}
