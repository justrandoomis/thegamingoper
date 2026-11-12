import { Form, Link } from "react-router";

import type { Route } from "./+types/incidents";
import { listIncidents } from "~/server/services/admin/ops/incidents.server";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import { INCIDENT_SEVERITIES, INCIDENT_SEVERITY_TONE, INCIDENT_SORTS, INCIDENT_STATUS_TONE, INCIDENT_VIEWS, incidentSearch, parseIncidentFilters, type IncidentRow } from "~/server/services/admin/ops/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, Duration, LinkChips, PageHead, Pair, ResponsiveList, Section, StatusText, When, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ops } from "./ops.server";

/**
 * /admin/ops/incidents — 23.05, the incident centre: open incidents first, most severe first; views (open, mine, past
 * their target date, resolved, all) with counts, severity, text and sort in the URL. Each row: its owner, its target
 * date (late in red-ink words), when it started and when it was resolved.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.incident.read");
  const filters = parseIncidentFilters(new URL(args.request.url).searchParams);
  const page = await ops.orRespond(req, () => listIncidents(req.db, req.actor, filters, req.now));
  return { page, filters, access: opsAccess(req.actor), now: req.now };
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "incidents.title");

export default function IncidentsPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const { page, filters, access } = loaderData;
  const href = (next: Partial<typeof filters>) => `/admin/ops/incidents${incidentSearch({ ...filters, page: 1, ...next })}`;
  const target = (row: IncidentRow) =>
    row.status === "resolved" ? (
      <span className="grid">
        <When at={row.resolvedAt} />
        {row.resolvedAt ? (
          <span className="type-caption text-ink-2">
            {t("incidents.took")} <Duration ms={row.resolvedAt - row.startedAt} />
          </span>
        ) : null}
      </span>
    ) : row.targetAt ? (
      <span className={row.overdue ? "grid text-red-ink" : "grid"}>
        <When at={row.targetAt} kind="date" />
        {row.overdue ? <span className="type-caption">{t("incidents.late")}</span> : null}
      </span>
    ) : (
      <span className="text-ink-2">—</span>
    );
  const columns: DataColumn<IncidentRow>[] = [
    {
      key: "incident",
      header: t("incidents.col.incident"),
      cell: (row) => (
        <span className="grid">
          <Link to={`/admin/ops/incidents/${row.ref}`} className="adm-link">
            <Code>{row.ref}</Code>
          </Link>
          <span className="type-data">{row.title}</span>
        </span>
      ),
    },
    { key: "severity", header: t("incidents.col.severity"), cell: (row) => <StatusText tone={INCIDENT_SEVERITY_TONE[row.severity]}>{t(`incident.severity.${row.severity}`)}</StatusText> },
    { key: "status", header: t("incidents.col.status"), cell: (row) => <StatusText tone={INCIDENT_STATUS_TONE[row.status]}>{t(`incident.status.${row.status}`)}</StatusText> },
    { key: "owner", header: t("incidents.col.owner"), cell: (row) => row.owner?.name ?? "—" },
    { key: "started", header: t("incidents.col.started"), cell: (row) => <When at={row.startedAt} /> },
    { key: "target", header: t("incidents.col.target"), cell: target },
  ];
  return (
    <>
      <PageHead
        title={t("incidents.title")}
        lead={t("incidents.lead")}
        actions={
          access.manageIncidents ? (
            <Key as={Link} to="/admin/ops/incidents/new" variant="ink" icon="plus">
              {t("incidents.new")}
            </Key>
          ) : null
        }
      />
      <Section id="ops-incidents" title={t(`incidents.view.${filters.view}`)} aside={<span className="type-caption text-ink-2">{t("incidents.count", { count: page.total })}</span>}>
        <LinkChips label={t("incidents.views")} items={INCIDENT_VIEWS.map((view) => ({ value: view, label: t(`incidents.view.${view}`), href: href({ view }), selected: filters.view === view, count: page.counts[view] }))} />
        <Form method="get" className="ops-filters" preventScrollReset>
          {filters.view !== "active" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <Select name="severity" label={t("incidents.filter.severity")} defaultValue={filters.severity ?? ""} options={[{ value: "", label: t("common.all") }, ...INCIDENT_SEVERITIES.map((severity) => ({ value: severity, label: t(`incident.severity.${severity}`) }))]} />
          <TextField name="q" label={t("incidents.filter.q")} defaultValue={filters.q} maxLength={100} />
          <Select name="sort" label={t("common.sort")} defaultValue={filters.sort} options={INCIDENT_SORTS.map((sort) => ({ value: sort, label: t(`incidents.sort.${sort}`) }))} />
          <div className="flex gap-2">
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.severity || filters.q ? (
              <Key as={Link} to={href({ severity: null, q: "" })} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t(`incidents.view.${filters.view}`)}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("incidents.empty")} text={filters.view === "active" ? t("incidents.emptyActive") : t("incidents.emptyHint")} icon="first-aid-kit" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/ops/incidents${incidentSearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/ops/incidents/${row.ref}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code> · {row.title}
                </Link>
              </div>
              <div className="flex flex-wrap gap-3">
                <StatusText tone={INCIDENT_SEVERITY_TONE[row.severity]}>{t(`incident.severity.${row.severity}`)}</StatusText>
                <StatusText tone={INCIDENT_STATUS_TONE[row.status]}>{t(`incident.status.${row.status}`)}</StatusText>
              </div>
              <Pair label={t("incidents.col.owner")}>{row.owner?.name ?? "—"}</Pair>
              <Pair label={t("incidents.col.target")}>{target(row)}</Pair>
            </>
          )}
        />
      </Section>
    </>
  );
}
