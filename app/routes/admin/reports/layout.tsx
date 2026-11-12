import { Outlet } from "react-router";

import type { Route } from "./+types/layout";
import { reportsAccess } from "~/server/services/admin/reports/shared.server";
import { openReports, reportsI18n } from "./reports.server";
import { ReportsNav, useRepT } from "./ui";

import "./reports.css";

/**
 * /admin/reports/* — admin module 18 "Reports & Business Intelligence" (docs/areas/admin-reports.md). The shell's gate
 * already let through only employees who hold some reports.* permission; every page below checks its own permission
 * again in its loader and action, and the services check it once more (assertCan). This layout sends the module's
 * strings and what this employee may open — nothing heavy: no report is computed here.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale, ctx } = await openReports(context);
  return { i18n: reportsI18n(locale), access: reportsAccess(actor), storeMode: ctx.storeMode };
}

export default function ReportsLayout({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const { access } = loaderData;
  return (
    <>
      <ReportsNav
        items={[
          { to: "/admin/reports", label: t("nav.overview"), icon: "squares-four", show: true, exact: true },
          { to: "/admin/reports/sales", label: t("nav.sales"), icon: "chart-line", show: access.reports.sales },
          { to: "/admin/reports/margin", label: t("nav.margin"), icon: "coins", show: access.reports.margin },
          { to: "/admin/reports/inventory", label: t("nav.inventory"), icon: "package", show: access.reports.inventory },
          { to: "/admin/reports/customers", label: t("nav.customers"), icon: "users", show: access.reports.customers },
          { to: "/admin/reports/performance", label: t("nav.performance"), icon: "pulse", show: access.reports.performance },
          { to: "/admin/reports/saved", label: t("nav.saved"), icon: "floppy-disk", show: true },
          { to: "/admin/reports/dictionary", label: t("nav.dictionary"), icon: "book-open", show: true },
        ]}
      />
      <Outlet />
    </>
  );
}
