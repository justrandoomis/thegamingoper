import { Form, Link } from "react-router";

import type { Route } from "./+types/performance";
import { useFormat } from "~/i18n/react";
import { performance, type PerformanceRow } from "~/server/services/admin/staff/performance.server";
import { parsePeriod, searchOf, shiftPeriod } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { staffMeta } from "./meta";
import { openStaff, orRespond } from "./staff.server";
import { DemoTag, Duration, Kpi, Money, Note, PageHead, Pair, PeriodName, ResponsiveTable, Section, usePeriodLabel, useListSep, useStaffT } from "./ui";

/**
 * /admin/staff/performance — 15.05 each employee's month, without protected supplier costs (no cost, margin or profit
 * is read): counter sales they rang up (net of refunds), units, average basket, refunds on their sales, commission
 * (only for who sees pay), attendance (planned, attended, late, missed, hours), tasks and packed orders.
 * staff.performance.read. Month in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openStaff(context);
  const period = parsePeriod(new URL(request.url).searchParams, now);
  const view = await orRespond(() => performance(db, actor, { period }, locale, now));
  return { view };
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "performance.title");

export default function PerformancePage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const sep = useListSep();
  const label = usePeriodLabel();
  const { view } = loaderData;
  const href = (period: string) => `/admin/staff/performance${searchOf({ period })}`;
  const columns: DataColumn<PerformanceRow>[] = [
    {
      key: "employee",
      header: t("performance.col.employee"),
      cell: (row) => (
        <span className="grid py-1">
          <span className="inline-flex flex-wrap items-center gap-1">
            <Link to={`/admin/staff/employees/${row.employee.id}`} className="adm-link">
              {row.employee.name}
            </Link>
            <DemoTag show={row.employee.isDemo} />
          </span>
          {row.roles.length ? <span className="type-caption text-ink-2">{row.roles.map((role) => role.name).join(sep)}</span> : null}
        </span>
      ),
    },
    { key: "orders", header: t("performance.col.orders"), numeric: true, cell: (row) => f.number(row.sales.orders) },
    { key: "units", header: t("performance.col.units"), numeric: true, cell: (row) => f.number(row.sales.units) },
    { key: "net", header: t("performance.col.net"), numeric: true, cell: (row) => <Money iqd={row.sales.netIqd} /> },
    { key: "basket", header: t("performance.col.basket"), numeric: true, cell: (row) => <Money iqd={row.sales.basketIqd} unknown={t("performance.noSales")} /> },
    { key: "refunds", header: t("performance.col.refunds"), numeric: true, cell: (row) => (row.sales.refundsIqd ? <Money iqd={-row.sales.refundsIqd} /> : <Money iqd={0} />) },
    ...(view.can.pay ? [{ key: "commission", header: t("performance.col.commission"), numeric: true, cell: (row: PerformanceRow) => <Money iqd={row.commissionIqd} /> }] : []),
    {
      key: "attendance",
      header: t("performance.col.attendance"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1 nums">
          {t("performance.attendedOf", { attended: row.attendance.attended, planned: row.attendance.planned })}
          {row.attendance.late ? <Status tone="warn">{t("performance.late", { count: row.attendance.late })}</Status> : null}
          {row.attendance.missed ? <Status tone="bad">{t("performance.missed", { count: row.attendance.missed })}</Status> : null}
        </span>
      ),
    },
    { key: "hours", header: t("performance.col.hours"), numeric: true, cell: (row) => <Duration minutes={row.attendance.minutes} /> },
    {
      key: "tasks",
      header: t("performance.col.tasks"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          {t("performance.tasksDone", { count: row.tasks.done })}
          {row.tasks.overdue ? <Status tone="bad">{t("performance.overdue", { count: row.tasks.overdue })}</Status> : null}
        </span>
      ),
    },
    { key: "packed", header: t("performance.col.packed"), numeric: true, cell: (row) => f.number(row.packed) },
  ];
  return (
    <>
      <PageHead
        title={
          <>
            {t("performance.title")} · <PeriodName period={view.period} />
          </>
        }
        lead={t("performance.lead")}
      />
      <div className="stf-noprint mb-4 flex flex-wrap items-end gap-2">
        <Key as={Link} to={href(shiftPeriod(view.period, -1))} size="sm" icon="caret-left">
          {label(shiftPeriod(view.period, -1))}
        </Key>
        <Key as={Link} to={href(shiftPeriod(view.period, 1))} size="sm" iconEnd="caret-right">
          {label(shiftPeriod(view.period, 1))}
        </Key>
        <Form method="get" action="/admin/staff/performance" className="flex flex-wrap items-end gap-2">
          <TextField name="period" type="month" label={t("common.month")} defaultValue={view.period} ltr className="w-44" />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
      </div>
      <div className="stf-kpis mb-5">
        <Kpi label={t("performance.col.net")} value={<Money iqd={view.totals.netIqd} />} />
        <Kpi label={t("performance.col.orders")} value={f.number(view.totals.orders)} />
        <Kpi label={t("performance.col.units")} value={f.number(view.totals.units)} />
        <Kpi label={t("performance.people")} value={f.number(view.rows.length)} />
      </div>
      <Section id="list" title={t("performance.list")}>
        <ResponsiveTable
          caption={t("performance.list")}
          columns={columns}
          rows={view.rows}
          rowKey={(row) => row.employee.id}
          empty={<EmptyState title={t("performance.empty")} text={t("performance.emptyHint")} icon="chart-bar" />}
          card={(row) => (
            <>
              <span className="type-strong">{row.employee.name}</span>
              <Pair label={t("performance.col.net")}>
                <Money iqd={row.sales.netIqd} />
              </Pair>
              <Pair label={t("performance.col.orders")}>{f.number(row.sales.orders)}</Pair>
              {view.can.pay ? (
                <Pair label={t("performance.col.commission")}>
                  <Money iqd={row.commissionIqd} />
                </Pair>
              ) : null}
              <Pair label={t("performance.col.attendance")}>{t("performance.attendedOf", { attended: row.attendance.attended, planned: row.attendance.planned })}</Pair>
              <Pair label={t("performance.col.hours")}>
                <Duration minutes={row.attendance.minutes} />
              </Pair>
              <Pair label={t("performance.col.tasks")}>{t("performance.tasksDone", { count: row.tasks.done })}</Pair>
            </>
          )}
        />
      </Section>
      <Note icon="lock">
        <p>{t("performance.noCost")}</p>
      </Note>
    </>
  );
}
