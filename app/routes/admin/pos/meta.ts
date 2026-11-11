/**
 * Page titles of module 06 from its own strings ("admin-pos", sent by the POS layout's loader), through the shell's
 * adminMeta (noindex, the admin suffix). Falls back to the module's name.
 *
 *   export const meta: Route.MetaFunction = (args) => posMeta(args, "shifts.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const POS_LAYOUT_ID = "routes/admin/pos/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function posMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars) {
  const layout = args.matches.find((match) => match?.id === POS_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-pos"];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = key && tree ? translate(tree, locale, key, vars) : undefined;
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.pos")}` : t("modules.pos")));
}
