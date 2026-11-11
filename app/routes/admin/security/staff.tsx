import { Form, Link } from "react-router";

import type { Route } from "./+types/staff";
import { useFormat } from "~/i18n/react";
import { listStaffSecurity } from "~/server/services/admin/security/staff.server";
import { parseStaffFilters, staffSearch, type StaffRow } from "~/server/services/admin/security/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { LinkChips, Pair, PageHead, ResponsiveList, RowLink, Section, When, useListSep, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { sec } from "./security.server";

/**
 * /admin/security/staff — 20.01: every employee with their two-step state, roles, live sessions and last sign-in,
 * the people without two-step verification first; two-step coverage per role. Filters in the URL (GET form, works
 * without script). One employee's sessions and the actions on them are on their own page.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await sec.open(context, "security.session.read");
  const filters = parseStaffFilters(new URL(request.url).searchParams);
  return { page: await sec.orRespond(() => listStaffSecurity(db, actor, filters, locale, now)), filters };
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "staff.title");

export default function StaffPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const sep = useListSep();
  const f = useFormat();
  const { page, filters } = loaderData;
  const href = (patch: Partial<typeof filters>) => `/admin/security/staff${staffSearch({ ...filters, ...patch, page: 1 })}` || "/admin/security/staff";
  const columns: DataColumn<StaffRow>[] = [
    { key: "name", header: t("staff.col.name"), cell: (row) => <RowLink to={`/admin/security/staff/${row.id}`}>{row.name}</RowLink> },
    { key: "email", header: t("staff.col.email"), cell: (row) => <bdi dir="ltr">{row.email}</bdi> },
    { key: "roles", header: t("staff.col.roles"), cell: (row) => (row.roles.length ? row.roles.map((role) => role.name).join(sep) : <span className="text-ink-2">{t("staff.noRole")}</span>) },
    { key: "twoStep", header: t("staff.col.twoStep"), cell: (row) => <Status tone={row.twoStep ? "ok" : "warn"}>{row.twoStep ? t("staff.twoStepOn") : t("staff.twoStepOff")}</Status> },
    { key: "status", header: t("staff.col.status"), cell: (row) => <Status tone={row.status === "active" ? "neutral" : "bad"}>{t(`staff.status.${row.status}`)}</Status> },
    { key: "sessions", header: t("staff.col.sessions"), numeric: true, cell: (row) => f.number(row.liveSessions) },
    { key: "last", header: t("staff.col.lastLogin"), cell: (row) => <When at={row.lastLoginAt} /> },
  ];
  const coveragePct = page.coverage.active ? Math.floor((page.coverage.withTwoStep * 100) / page.coverage.active) : 0;
  return (
    <>
      <PageHead title={t("staff.title")} lead={t("staff.lead")} />

      <Section id="coverage" title={t("staff.coverage")} aside={<span className="type-caption text-ink-2">{t("staff.coverageLine", { count: page.coverage.withTwoStep, total: page.coverage.active, pct: coveragePct })}</span>}>
        <ul role="list" className="sec-kpis">
          {page.coverage.byRole.map((role) => (
            <li key={role.id} className="adm-card gap-1">
              <Link to={href({ role: role.id })} className="adm-link type-strong">
                {role.name}
              </Link>
              <Pair label={t("staff.members")}>{f.number(role.members)}</Pair>
              <Pair label={t("staff.withTwoStep")}>
                <Status tone={role.withTwoStep === role.members ? "ok" : "warn"}>
                  <bdi className="nums">
                    {f.number(role.withTwoStep)} / {f.number(role.members)}
                  </bdi>
                </Status>
              </Pair>
            </li>
          ))}
        </ul>
        <p className="type-caption text-ink-2">{t("staff.requireNote")}</p>
      </Section>

      <Section id="list" title={t("staff.list")} aside={<span className="type-caption text-ink-2">{t("staff.count", { count: page.total })}</span>}>
        <div className="grid gap-3">
          <LinkChips
            label={t("staff.twoStepFilter")}
            items={[
              { value: "all", label: t("common.all"), href: href({ twoStep: null }), selected: filters.twoStep === null },
              { value: "off", label: t("staff.twoStepOff"), href: href({ twoStep: "off" }), selected: filters.twoStep === "off" },
              { value: "on", label: t("staff.twoStepOn"), href: href({ twoStep: "on" }), selected: filters.twoStep === "on" },
            ]}
          />
          <Form method="get" action="/admin/security/staff" className="sec-filters">
            {filters.twoStep ? <input type="hidden" name="twostep" value={filters.twoStep} /> : null}
            <TextField name="q" type="search" label={t("staff.search")} defaultValue={filters.q} />
            <Select name="role" label={t("staff.col.roles")} defaultValue={filters.role ?? ""} options={[{ value: "", label: t("common.any") }, ...page.roles.map((role) => ({ value: role.id, label: role.name }))]} />
            <Select
              name="status"
              label={t("staff.col.status")}
              defaultValue={filters.status ?? ""}
              options={[
                { value: "", label: t("common.any") },
                { value: "active", label: t("staff.status.active") },
                { value: "disabled", label: t("staff.status.disabled") },
              ]}
            />
            <div className="flex items-end gap-2">
              <Key type="submit" size="sm" variant="ink" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to="/admin/security/staff" size="sm">
                {t("common.clear")}
              </Key>
            </div>
          </Form>
          <ResponsiveList
            caption={t("staff.list")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("staff.empty")} text={t("staff.emptyHint")} icon="users" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/security/staff${staffSearch(filters, n)}`} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/admin/security/staff/${row.id}`} className="adm-link type-strong">
                    {row.name}
                  </Link>
                  <Status tone={row.twoStep ? "ok" : "warn"}>{row.twoStep ? t("staff.twoStepOn") : t("staff.twoStepOff")}</Status>
                </div>
                <Pair label={t("staff.col.roles")}>{row.roles.length ? row.roles.map((role) => role.name).join(sep) : t("staff.noRole")}</Pair>
                <Pair label={t("staff.col.sessions")}>{f.number(row.liveSessions)}</Pair>
                <Pair label={t("staff.col.lastLogin")}>
                  <When at={row.lastLoginAt} />
                </Pair>
                {row.status === "disabled" ? <Status tone="bad">{t("staff.status.disabled")}</Status> : null}
              </>
            )}
          />
        </div>
      </Section>
    </>
  );
}
