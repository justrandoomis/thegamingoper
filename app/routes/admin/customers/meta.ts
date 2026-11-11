/**
 * Page titles of module 07 from its own strings ("admin-customers", sent by the customers layout's loader), through the
 * shell's adminMeta (noindex, the admin suffix). Falls back to the module's name.
 *
 *   export const meta: Route.MetaFunction = (args) => customersMeta(args, "segments.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const CUSTOMERS_LAYOUT_ID = "routes/admin/customers/layout";
export const CUSTOMER_LAYOUT_ID = "routes/admin/customers/customer-layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function customersMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars, title?: string | null) {
  const layout = args.matches.find((match) => match?.id === CUSTOMERS_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-customers"];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const page = title || (key && tree ? translate(tree, locale, key, vars) : undefined);
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.customers")}` : t("modules.customers")));
}
