/**
 * Page titles of the inventory module: "<page> · المخزون والمستودعات · <admin suffix>", built on the shell's
 * adminMeta (noindex, the admin suffix) with the page name from the module's strings in the layout's data.
 *
 *   export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "stock.title");
 */
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { adminMeta } from "../shell/meta";

export const INVENTORY_LAYOUT_ID = "routes/admin/inventory/layout";

type MatchLike = { id: string; loaderData?: unknown; data?: unknown } | undefined;

export function inventoryMeta(args: { matches: readonly MatchLike[] }, key: string | null, vars?: Vars) {
  const layout = args.matches.find((match) => match?.id === INVENTORY_LAYOUT_ID);
  const root = args.matches.find((match) => match?.id === "root");
  const tree = ((layout?.loaderData ?? layout?.data) as { i18n?: Record<string, MessageTree> } | undefined)?.i18n?.["admin-inventory"];
  const locale = (((root?.loaderData ?? root?.data) as { locale?: Locale } | undefined)?.locale ?? "ar") as Locale;
  const page = key ? translate(tree, locale, key, vars) : undefined;
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.inventory")}` : t("modules.inventory")));
}
