import { useMemo, useState } from "react";
import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/payroll";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { invalid } from "~/server/errors";
import { listRuns, prepareRun, previewRun } from "~/server/services/admin/staff/payroll.server";
import { parsePayrollFilters, parsePeriod, RUN_STATUS_LIST, searchOf, type RunRow } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { staffMeta } from "./meta";
import { checked, failed, openStaff, optional, orRespond, text } from "./staff.server";
import { ByName, Code, DemoTag, FormDialog, Kpi, LinkChips, Money, Note, PageHead, Pair, PeriodName, ResponsiveTable, Section, StateTag, When, newKey, useStaffT } from "./ui";

/**
 * /admin/staff/payroll — 15.04: payroll runs by month (staff.payroll.read, .run or .approve), and — for who prepares
 * them (staff.payroll.run) — what a run of the month would pay right now and the key that prepares it as a draft.
 * Another person approves and pays it on the run's page; advances are /admin/staff/payroll/advances. Month and kind
 * (real or demo staff) of the preview, status and page of the list in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openStaff(context);
  const params = new URL(request.url).searchParams;
  const filters = parsePayrollFilters(params);
  const period = parsePeriod(params, now);
  const demo = params.get("demo") === "1";
  const [page, preview] = await Promise.all([orRespond(() => listRuns(db, actor, filters)), can(actor, "staff.payroll.run") ? previewRun(db, actor, { period, demo }, now) : Promise.resolve(null)]);
  return { page, preview, filters, period, demo, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "prepare") throw invalid({ intent: "invalid" });
    const result = await prepareRun(req.db, req.actor, { period: text(form, "period"), demo: checked(form, "demo"), notes: optional(form, "notes"), idempotencyKey: text(form, "idempotencyKey") }, req.now);
    return redirect(`/admin/staff/payroll/${result.runId}`);
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "payroll.title");

export default function PayrollPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const { page, preview, filters, period, demo } = loaderData;
  const [preparing, setPreparing] = useState(false);
  const key = useMemo(() => newKey(), [period, demo, preparing]);
  const statusHref = (status: string | null) => `/admin/staff/payroll${searchOf({ status, period: period, demo })}` || "/admin/staff/payroll";
  const columns: DataColumn<RunRow>[] = [
    {
      key: "ref",
      header: t("payroll.col.ref"),
      cell: (row) => (
        <Link to={`/admin/staff/payroll/${row.id}`} className="adm-link">
          <Code>{row.ref}</Code>
        </Link>
      ),
    },
    { key: "period", header: t("payroll.col.period"), cell: (row) => <PeriodName period={row.period} /> },
    {
      key: "status",
      header: t("payroll.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StateTag group="run" value={row.status} label={t(`runStatus.${row.status}`)} />
          <DemoTag show={row.isDemo} />
        </span>
      ),
    },
    { key: "employees", header: t("payroll.col.employees"), numeric: true, cell: (row) => f.number(row.employees) },
    { key: "gross", header: t("payroll.col.gross"), numeric: true, cell: (row) => <Money iqd={row.grossIqd} /> },
    { key: "net", header: t("payroll.col.net"), numeric: true, cell: (row) => <Money iqd={row.netIqd} className="type-strong" /> },
    { key: "by", header: t("payroll.col.preparedBy"), cell: (row) => <ByName by={row.createdBy} /> },
    { key: "approved", header: t("payroll.col.approvedBy"), cell: (row) => <ByName by={row.approvedBy} /> },
    { key: "paid", header: t("payroll.col.paidAt"), cell: (row) => <When at={row.paidAt} /> },
  ];
  return (
    <>
      <PageHead
        title={t("payroll.title")}
        lead={t("payroll.lead")}
        actions={
          <Key as={Link} to="/admin/staff/payroll/advances" size="sm" icon="hand-coins">
            {t("payroll.advances")}
          </Key>
        }
      />

      {preview ? (
        <Section
          id="preview"
          title={
            <>
              {t("payroll.preview")} · <PeriodName period={period} />
              {demo ? <> · {t("payroll.demoStaff")}</> : null}
            </>
          }
          aside={
            <Form method="get" action="/admin/staff/payroll" className="flex flex-wrap items-end gap-2">
              <TextField name="period" type="month" label={t("common.month")} defaultValue={period} ltr className="w-44" />
              {demo ? <input type="hidden" name="demo" value="1" /> : null}
              <Key type="submit" size="sm" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to={`/admin/staff/payroll${searchOf({ period, demo: !demo })}`} size="sm" held={demo}>
                {t("payroll.demoStaff")}
              </Key>
            </Form>
          }
        >
          <div className="stf-kpis">
            <Kpi label={t("payroll.col.employees")} value={f.number(preview.items.length)} hint={preview.excluded.length ? t("payroll.excluded", { count: preview.excluded.length }) : undefined} />
            <Kpi label={t("payroll.col.base")} value={<Money iqd={preview.totals.baseIqd} />} />
            <Kpi label={t("payroll.col.commission")} value={<Money iqd={preview.totals.commissionIqd} />} />
            <Kpi label={t("payroll.col.advances")} value={<Money iqd={preview.totals.advanceDeductionIqd ? -preview.totals.advanceDeductionIqd : 0} />} />
            <Kpi label={t("payroll.col.net")} value={<Money iqd={preview.totals.netIqd} />} />
          </div>
          {preview.openRun ? (
            <Note tone="warn">
              <p>
                {t("payroll.openExists")}{" "}
                <Link to={`/admin/staff/payroll/${preview.openRun}`} className="adm-link">
                  {t("payroll.openRun")}
                </Link>
              </p>
            </Note>
          ) : preview.items.length === 0 ? (
            <Note>
              <p>{t("payroll.nothingToPay")}</p>
            </Note>
          ) : (
            <div className="flex flex-wrap items-center gap-3 stf-noprint">
              <Key variant="primary" icon="money" onClick={() => setPreparing(true)}>
                {t("payroll.prepare")}
              </Key>
              <span className="type-caption text-ink-2">{t("payroll.prepareHint")}</span>
            </div>
          )}
          {preview.items.length ? (
            <ul role="list" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {preview.items.slice(0, 12).map((item) => (
                <li key={item.employee.id} className="adm-card gap-1">
                  <span className="inline-flex flex-wrap items-center gap-1 type-label">
                    {item.employee.name}
                    <DemoTag show={item.employee.isDemo} />
                  </span>
                  <Pair label={t("payroll.col.base")}>
                    <Money iqd={item.baseIqd} />
                  </Pair>
                  {item.commissionIqd ? (
                    <Pair label={t("payroll.col.commission")}>
                      <Money iqd={item.commissionIqd} />
                    </Pair>
                  ) : null}
                  {item.advanceDeductionIqd ? (
                    <Pair label={t("payroll.col.advances")}>
                      <Money iqd={-item.advanceDeductionIqd} />
                    </Pair>
                  ) : null}
                  <Pair label={t("payroll.col.net")}>
                    <Money iqd={item.netIqd} className="type-strong" />
                  </Pair>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      <Section id="runs" title={t("payroll.runs")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: page.total })}</span>}>
        <div className="grid gap-3">
          <LinkChips
            label={t("payroll.statusFilter")}
            items={[
              { value: "all", label: t("common.all"), href: statusHref(null), selected: filters.status === null },
              ...RUN_STATUS_LIST.map((status) => ({ value: status, label: t(`runStatus.${status}`), href: statusHref(status), selected: filters.status === status })),
            ]}
          />
          <ResponsiveTable
            caption={t("payroll.runs")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("payroll.noRuns")} text={page.can.prepare ? t("payroll.noRunsPrepare") : t("payroll.noRunsHint")} icon="money" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/staff/payroll${searchOf({ status: filters.status, page: n })}` || "?"} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/admin/staff/payroll/${row.id}`} className="adm-link type-strong">
                    <PeriodName period={row.period} />
                  </Link>
                  <StateTag group="run" value={row.status} label={t(`runStatus.${row.status}`)} />
                </div>
                <Pair label={t("payroll.col.ref")}>
                  <Code>{row.ref}</Code>
                </Pair>
                <Pair label={t("payroll.col.employees")}>{f.number(row.employees)}</Pair>
                <Pair label={t("payroll.col.net")}>
                  <Money iqd={row.netIqd} className="type-strong" />
                </Pair>
                <DemoTag show={row.isDemo} />
              </>
            )}
          />
        </div>
      </Section>
      <Note>
        <p>{t("payroll.rules")}</p>
      </Note>

      {preparing && preview ? (
        <FormDialog
          title={t("payroll.prepareQ", { count: preview.items.length })}
          description={t("payroll.prepareWhat")}
          submitLabel={t("payroll.prepare")}
          onClose={() => setPreparing(false)}
          successMessage={t("payroll.prepared")}
          hidden={{ intent: "prepare", period, idempotencyKey: key, ...(demo ? { demo: "1" } : {}) }}
        >
          {(fields) => (
            <>
              <Pair label={t("payroll.col.period")}>
                <PeriodName period={period} />
              </Pair>
              <Pair label={t("payroll.col.net")}>
                <Money iqd={preview.totals.netIqd} />
              </Pair>
              <TextArea name="notes" label={t("payroll.notes")} optional maxLength={500} rows={2} error={fields.notes} />
              {fields.period ? <p className="type-caption text-red-ink">{fields.period}</p> : null}
            </>
          )}
        </FormDialog>
      ) : null}
    </>
  );
}
