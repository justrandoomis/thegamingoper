/**
 * Page titles of module 05 from its own strings ("admin-orders", sent by the orders layout's loader), through the
 * shell's adminMeta (noindex, the admin suffix). Falls back to the module's name.
 *
 *   export const meta: Route.MetaFunction = (args) => ordersMeta(args, "proofs.title");
 */
import { translate, type MessageTree } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { ADMIN_LAYOUT_ID, adminMeta } from "../shell/meta";

export const ORDERS_LAYOUT_ID = "routes/admin/orders/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function ordersMeta(args: { matches: readonly MatchLike[] }, key: string, vars?: Record<string, string | number>) {
  const layout = args.matches.find((match) => match?.id === ORDERS_LAYOUT_ID);
  const admin = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID);
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-orders"];
  const locale: Locale = ((admin?.loaderData ?? admin?.data) as { shell?: { locale?: Locale } } | undefined)?.shell?.locale ?? "ar";
  const title = tree ? translate(tree, locale, key, vars) : undefined;
  return adminMeta(args, title ?? ((t) => t("modules.orders")));
}
