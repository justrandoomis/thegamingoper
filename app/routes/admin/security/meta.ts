/**
 * Page titles of modules 20 and 22 from their own strings (sent by each module's layout), through the shell's adminMeta
 * (noindex, the admin suffix): "<page> · <module> · <admin suffix>".
 *
 *   export const meta: Route.MetaFunction = (args) => securityMeta(args, "staff.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const SECURITY_LAYOUT_ID = "routes/admin/security/layout";
export const SECURITY_NS = "admin-security";
export const SETTINGS_NS = "admin-settings";
export const SETTINGS_LAYOUT_ID = "routes/admin/settings/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

function moduleMeta(args: { matches: readonly MatchLike[] }, layoutId: string, namespace: string, module: "security" | "settings", key: string | null, vars?: Vars) {
  const layout = args.matches.find((match) => match?.id === layoutId);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.[namespace];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = key && tree ? translate(tree, locale, key, vars) : undefined;
  return adminMeta(args, (t) => (page ? `${page} · ${t(`modules.${module}`)}` : t(`modules.${module}`)));
}

export const securityMeta = (args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars) => moduleMeta(args, SECURITY_LAYOUT_ID, "admin-security", "security", key, vars);
export const settingsMeta = (args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars) => moduleMeta(args, SETTINGS_LAYOUT_ID, "admin-settings", "settings", key, vars);
