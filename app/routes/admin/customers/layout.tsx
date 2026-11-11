import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { customersAccess } from "~/server/services/admin/customers/shared.server";
import { privacyCounts } from "~/server/services/admin/customers/privacy.server";
import { Tabs } from "~/ui/Tabs";
import { customersI18n, openCustomers } from "./customers.server";
import { useCustomersT } from "./ui";

import "./customers.css";

/**
 * /admin/customers/* — admin module 07 "Customers & CRM" (docs/areas/admin-customers.md). The shell's gate already let
 * through only employees who hold some customers.* permission; every page below checks its own permission again in its
 * loader and action (requireEmployee) and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, the sections this employee may open, and the privacy requests waiting.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCustomers(context);
  return { i18n: customersI18n(locale), access: customersAccess(actor), privacy: await privacyCounts(db, actor, now) };
}

export default function CustomersLayout({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { pathname } = useLocation();
  const { access, privacy } = loaderData;
  const segment = pathname.replace(/^\/admin\/customers\/?/, "").split("/")[0] ?? "";
  const known = ["segments", "privacy", "consents", "duplicates"];
  const current = known.includes(segment) ? segment : "list";
  const items = [
    { value: "list", label: t("nav.list"), href: "/admin/customers", show: access.read },
    { value: "segments", label: t("nav.segments"), href: "/admin/customers/segments", show: access.read },
    { value: "privacy", label: t("nav.privacy"), href: "/admin/customers/privacy", count: privacy?.open || undefined, show: access.privacy },
    { value: "consents", label: t("nav.consents"), href: "/admin/customers/consents", show: access.consents },
    { value: "duplicates", label: t("nav.duplicates"), href: "/admin/customers/duplicates", show: access.merge },
  ]
    .filter((item) => item.show)
    .map(({ show: _show, ...item }) => item);
  return (
    <div className="grid min-w-0 gap-5">
      {items.length > 1 ? (
        <div className="cus-noprint min-w-0">
          <Tabs aria-label={t("nav.label")} value={current} items={items} />
        </div>
      ) : null}
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
