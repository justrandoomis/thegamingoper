import { Form, Link } from "react-router";

import type { Route } from "./+types/employees";
import { useFormat } from "~/i18n/react";
import { listEmployees } from "~/server/services/admin/staff/employees.server";
import { employeeSearch, parseEmployeeFilters, type EmployeeFilters, type EmployeeRow } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { staffMeta } from "./meta";
import { openStaff, orRespond } from "./staff.server";
import { DemoTag, LinkChips, Note, PageHead, Pair, ResponsiveTable, Section, StateTag, When, useListSep, useStaffLayout, useStaffT } from "./ui";

/**
 * /admin/staff/employees — 15.01: the directory (staff.employee.read or staff.manage). Filters, sort and page in the
 * URL (a GET form, works without script). Each employee's file — what their roles grant, read-only; roles are edited
 * in module 20 — is /admin/staff/employees/:id.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openStaff(context);
  const filters = parseEmployeeFilters(new URL(request.url).searchParams);
  const page = await orRespond(() => listEmployees(db, actor, filters, locale));
  return { page, filters };
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "employees.title");

export default function EmployeesPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const sep = useListSep();
  const layout = useStaffLayout();
  const { page, filters } = loaderData;
  const href = (patch: Partial<EmployeeFilters>) => `/admin/staff/employees${employeeSearch({ ...filters, ...patch, page: 1 })}`;
  const columns: DataColumn<EmployeeRow>[] = [
    {
      key: "name",
      header: t("employees.col.name"),
      cell: (row) => (
        <span className="grid py-1">
          <Link to={`/admin/staff/employees/${row.id}`} className="adm-link">
            {row.name}
          </Link>
          <bdi dir="ltr" className="type-caption text-ink-2">
            {row.email}
          </bdi>
        </span>
      ),
    },
    { key: "title", header: t("employees.col.jobTitle"), cell: (row) => row.jobTitle ?? <span className="text-ink-2">—</span> },
    { key: "roles", header: t("employees.col.roles"), cell: (row) => (row.roles.length ? row.roles.map((role) => role.name).join(sep) : <span className="text-ink-2">{t("employees.noRole")}</span>) },
    {
      key: "status",
      header: t("employees.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StateTag group="employee" value={row.status} label={t(`employeeStatus.${row.status}`)} />
          <DemoTag show={row.isDemo} />
        </span>
      ),
    },
    { key: "branch", header: t("employees.col.branch"), cell: (row) => row.branch ?? <span className="text-ink-2">{t("employees.allBranches")}</span> },
    { key: "login", header: t("employees.col.lastLogin"), cell: (row) => <When at={row.lastLoginAt} /> },
  ];
  return (
    <>
      <PageHead title={t("employees.title")} lead={t("employees.lead")} />
      <div className="stf-kpis mb-5">
        <Link to={href({ status: "active" })} className="adm-card content-start no-underline">
          <span className="type-caption text-ink-2">{t("employeeStatus.active")}</span>
          <span className="type-kpi nums">{f.number(page.counts.active)}</span>
        </Link>
        <Link to={href({ status: "disabled" })} className="adm-card content-start no-underline">
          <span className="type-caption text-ink-2">{t("employeeStatus.disabled")}</span>
          <span className="type-kpi nums">{f.number(page.counts.disabled)}</span>
        </Link>
        <Link to={href({ demo: "demo" })} className="adm-card content-start no-underline">
          <span className="type-caption text-ink-2">{t("employees.demoCount")}</span>
          <span className="type-kpi nums">{f.number(page.counts.demo)}</span>
        </Link>
      </div>

      <Section id="list" title={t("employees.list")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: page.total })}</span>}>
        <div className="grid gap-3">
          <LinkChips
            label={t("employees.statusFilter")}
            items={[
              { value: "all", label: t("common.all"), href: href({ status: null }), selected: filters.status === null },
              { value: "active", label: t("employeeStatus.active"), href: href({ status: "active" }), selected: filters.status === "active" },
              { value: "disabled", label: t("employeeStatus.disabled"), href: href({ status: "disabled" }), selected: filters.status === "disabled" },
            ]}
          />
          <Form method="get" action="/admin/staff/employees" className="stf-filters stf-noprint">
            {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
            <TextField name="q" type="search" label={t("employees.search")} defaultValue={filters.q} />
            <Select name="role" label={t("employees.col.roles")} defaultValue={filters.role ?? ""} options={[{ value: "", label: t("common.any") }, ...page.roles.map((role) => ({ value: role.id, label: role.name }))]} />
            <Select
              name="demo"
              label={t("employees.demoFilter")}
              defaultValue={filters.demo}
              options={[
                { value: "all", label: t("common.all") },
                { value: "real", label: t("employees.realOnly") },
                { value: "demo", label: t("employees.demoOnly") },
              ]}
            />
            <Select
              name="sort"
              label={t("common.sort")}
              defaultValue={filters.sort}
              options={[
                { value: "name", label: t("employees.sortName") },
                { value: "newest", label: t("employees.sortNewest") },
                { value: "last_login", label: t("employees.sortLogin") },
              ]}
            />
            <div className="flex items-end gap-2">
              <Key type="submit" size="sm" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to="/admin/staff/employees" size="sm" variant="ghost">
                {t("common.clear")}
              </Key>
            </div>
          </Form>
          <ResponsiveTable
            caption={t("employees.list")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("employees.empty")} text={t("employees.emptyHint")} icon="users" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/staff/employees${employeeSearch(filters, n)}` || "?"} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/admin/staff/employees/${row.id}`} className="adm-link type-strong">
                    {row.name}
                  </Link>
                  <StateTag group="employee" value={row.status} label={t(`employeeStatus.${row.status}`)} />
                </div>
                {row.jobTitle ? <Pair label={t("employees.col.jobTitle")}>{row.jobTitle}</Pair> : null}
                <Pair label={t("employees.col.roles")}>{row.roles.length ? row.roles.map((role) => role.name).join(sep) : t("employees.noRole")}</Pair>
                <Pair label={t("employees.col.lastLogin")}>
                  <When at={row.lastLoginAt} />
                </Pair>
                <DemoTag show={row.isDemo} />
              </>
            )}
          />
        </div>
      </Section>
      <Note>
        <p>
          {t("employees.addNote")}
          {layout?.access.manage ? (
            <>
              {" "}
              <Link to="/admin/security/roles" className="adm-link">
                {t("employees.roleEditor")}
              </Link>
            </>
          ) : null}
        </p>
      </Note>
    </>
  );
}
