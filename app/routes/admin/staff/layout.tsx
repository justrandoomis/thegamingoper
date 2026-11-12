import { Outlet, useLocation } from "react-router";

import type { Route } from "./+types/layout";
import { staffAccess, type StaffAccess } from "~/server/services/admin/staff/shared.server";
import { Tabs } from "~/ui/Tabs";
import { AdminErrorPage } from "../shell/ErrorPage";
import { openStaff, staffI18n } from "./staff.server";
import { useStaffT } from "./ui";

import "./staff.css";

/**
 * /admin/staff/* — admin module 15 "Employees & HR" (docs/areas/admin-staff.md): the module's strings (one load for
 * every page below), what this employee may open and the section links. The shell's gate already let through only
 * employees who hold some staff.* permission; every page checks its own permission again in its loader and action,
 * and the services check it once more (assertCan).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale, session } = await openStaff(context);
  return { i18n: staffI18n(locale), access: staffAccess(actor), me: { id: session.employee.id, name: session.employee.name } };
}

const SECTIONS: { value: string; path: string; label?: string; allowed: (a: StaffAccess) => boolean }[] = [
  { value: "overview", path: "", allowed: () => true },
  { value: "me", path: "/me", allowed: () => true },
  { value: "approvals", path: "/approvals", allowed: () => true },
  { value: "employees", path: "/employees", allowed: (a) => a.directory },
  { value: "schedule", path: "/schedule", allowed: (a) => a.roster },
  { value: "attendance", path: "/attendance", allowed: (a) => a.attendanceView },
  { value: "leave", path: "/leave", allowed: (a) => a.leaveView },
  { value: "tasks", path: "/tasks", allowed: () => true },
  { value: "commissions", path: "/commissions", allowed: (a) => a.commissionView },
  { value: "payroll", path: "/payroll", allowed: (a) => a.payrollView },
  // a branch-limited employee: their branch's advances, never the store-wide payroll (StaffAccess.advancesView)
  { value: "payroll", path: "/payroll/advances", label: "nav.advances", allowed: (a) => a.advancesView },
  { value: "performance", path: "/performance", allowed: (a) => a.performance },
];

export default function StaffLayout({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const { pathname } = useLocation();
  const segment = pathname.replace(/^\/admin\/staff\/?/, "").split("/")[0] ?? "";
  const current = segment === "" ? "overview" : segment;
  const items = SECTIONS.filter((section) => section.allowed(loaderData.access)).map((section) => ({ value: section.value, label: t(section.label ?? `nav.${section.value}`), href: `/admin/staff${section.path}` }));
  return (
    <div className="grid min-w-0 gap-5">
      <Tabs aria-label={t("nav.label")} value={current} items={items} className="stf-noprint" />
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

/** A page of the module that fails (a 403 for a section this role may not open, an unknown id) renders inside the shell. */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <AdminErrorPage error={error} />;
}
