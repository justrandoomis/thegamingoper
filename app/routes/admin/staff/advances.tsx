import { useMemo, useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/advances";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { decideAdvance, listAdvances, requestAdvance, withdrawAdvance } from "~/server/services/admin/staff/payroll.server";
import { branchLimit, employeeOptions } from "~/server/services/admin/staff/shared.server";
import { ADVANCE_STATUS_LIST, PAID_FROM_LIST, parseAdvanceFilters, searchOf, type AdvanceFilters, type AdvanceRow } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { staffMeta } from "./meta";
import { amount, failed, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { ActionDialog, ByName, DemoTag, FormDialog, Kpi, LinkChips, Money, Note, PageHead, Pair, PeriodName, ResponsiveTable, Section, StateTag, When, newKey, useStaffLayout, useStaffT } from "./ui";

/**
 * /admin/staff/payroll/advances — 15.04 salary advances: staff.payroll.run asks for one (who, how much, from the drawer or
 * the bank, why); staff.payroll.approve decides — never the requester nor the employee it is for; approving hands it
 * out and books it (Dr payroll / Cr cash or bank) in one batch; the next payroll run deducts it. The requester may
 * withdraw a pending request. Status and employee in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await openStaff(context);
  const filters = parseAdvanceFilters(new URL(request.url).searchParams);
  const [page, people] = await Promise.all([orRespond(() => listAdvances(db, actor, filters)), employeeOptions(db, { branchId: branchLimit(actor) })]);
  return { page, filters, people };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "request":
        await requestAdvance(req.db, req.actor, { employeeId: text(form, "employeeId"), amountIqd: amount(form, "amountIqd") ?? Number.NaN, paidFrom: text(form, "paidFrom") as never, reason: text(form, "reason"), idempotencyKey: text(form, "idempotencyKey") }, req.now);
        return ok(intent, { message: t("advances.requested") });
      case "decide": {
        // the service's zod refuses anything but "approve" or "reject": a missing or unknown decision never hands money out
        const result = await decideAdvance(req.db, req.actor, { approvalId: text(form, "approvalId"), decision: text(form, "decision") as never, note: optional(form, "note") }, req.now);
        return ok(intent, { message: result.status === "approved" ? t("advances.approved") : t("advances.rejected") });
      }
      case "withdraw":
        await withdrawAdvance(req.db, req.actor, { approvalId: text(form, "approvalId"), reason: optional(form, "reason") }, req.now);
        return ok(intent, { message: t("advances.withdrawn") });
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "advances.title");

type Deciding = { row: AdvanceRow; decision: "approve" | "reject" } | null;

export default function AdvancesPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const { page, filters, people } = loaderData;
  const layout = useStaffLayout();
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState<Deciding>(null);
  const [withdrawing, setWithdrawing] = useState<AdvanceRow | null>(null);
  const key = useMemo(() => newKey(), [asking]);
  const href = (patch: Partial<AdvanceFilters>) => `/admin/staff/payroll/advances${searchOf({ ...filters, ...patch, page: null })}` || "/admin/staff/payroll/advances";
  const actions = (row: AdvanceRow) => (
    <span className="inline-flex flex-wrap gap-1 stf-noprint">
      {row.canDecide ? (
        <>
          <Key size="sm" icon="check" onClick={() => setDeciding({ row, decision: "approve" })}>
            {t("advances.approve")}
          </Key>
          <Key size="sm" variant="ghost" icon="x" onClick={() => setDeciding({ row, decision: "reject" })}>
            {t("advances.reject")}
          </Key>
        </>
      ) : null}
      {row.canWithdraw ? (
        <Key size="sm" variant="ghost" onClick={() => setWithdrawing(row)}>
          {t("advances.withdraw")}
        </Key>
      ) : null}
    </span>
  );
  const columns: DataColumn<AdvanceRow>[] = [
    {
      key: "employee",
      header: t("advances.col.employee"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Link to={`/admin/staff/employees/${row.employee.id}`} className="adm-link">
            {row.employee.name}
          </Link>
          <DemoTag show={row.employee.isDemo} />
        </span>
      ),
    },
    { key: "amount", header: t("advances.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} className="type-strong" /> },
    { key: "from", header: t("advances.col.from"), cell: (row) => (row.paidFrom ? t(`paidFrom.${row.paidFrom}`) : "—") },
    { key: "reason", header: t("advances.col.reason"), cell: (row) => row.reason ?? "—" },
    { key: "status", header: t("advances.col.status"), cell: (row) => <StateTag group="advance" value={row.status} label={t(`advanceStatus.${row.status}`)} /> },
    { key: "asked", header: t("advances.col.requestedBy"), cell: (row) => <ByName by={row.requestedBy} /> },
    { key: "decided", header: t("advances.col.decidedBy"), cell: (row) => <ByName by={row.decidedBy} /> },
    { key: "at", header: t("advances.col.at"), cell: (row) => <When at={row.createdAt} /> },
    {
      key: "run",
      header: t("advances.col.deducted"),
      cell: (row) =>
        row.settledRun ? (
          layout?.access.payrollView === false ? (
            <PeriodName period={row.settledRun.period} />
          ) : (
            <Link to={`/admin/staff/payroll/${row.settledRun.id}`} className="adm-link">
              <PeriodName period={row.settledRun.period} />
            </Link>
          )
        ) : (
          "—"
        ),
    },
    { key: "act", header: <span className="sr-only">{t("common.actions")}</span>, cell: actions },
  ];
  return (
    <>
      <PageHead
        eyebrow={
          // the runs are store-wide: an employee limited to a branch reaches advances but not the payroll page
          layout?.access.payrollView === false ? (
            t("payroll.title")
          ) : (
            <Link to="/admin/staff/payroll" className="adm-link">
              {t("payroll.title")}
            </Link>
          )
        }
        title={t("advances.title")}
        lead={t("advances.lead")}
        actions={
          page.can.request ? (
            <Key size="sm" icon="plus" onClick={() => setAsking(true)}>
              {t("advances.ask")}
            </Key>
          ) : null
        }
      />
      <div className="stf-kpis mb-5">
        <Kpi label={t("advanceStatus.pending")} value={f.number(page.counts.pending)} to={href({ status: "pending" })} />
        <Kpi label={t("advances.openTotal")} value={<Money iqd={page.counts.openIqd} />} to={href({ status: "open" })} />
      </div>
      <Section id="list" title={t("advances.list")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: page.total })}</span>}>
        <div className="grid gap-3">
          <LinkChips
            label={t("advances.statusFilter")}
            items={[
              { value: "all", label: t("common.all"), href: href({ status: null }), selected: filters.status === null },
              ...ADVANCE_STATUS_LIST.map((status) => ({ value: status, label: t(`advanceStatus.${status}`), href: href({ status }), selected: filters.status === status })),
            ]}
          />
          <Form method="get" action="/admin/staff/payroll/advances" className="stf-filters stf-noprint">
            {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
            <Select name="employee" label={t("advances.col.employee")} defaultValue={filters.employee ?? ""} options={[{ value: "", label: t("common.any") }, ...people.map((person) => ({ value: person.id, label: person.name }))]} />
            <div className="flex items-end gap-2">
              <Key type="submit" size="sm" icon="funnel">
                {t("common.apply")}
              </Key>
            </div>
          </Form>
          <ResponsiveTable
            caption={t("advances.list")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("advances.empty")} text={page.can.request ? t("advances.emptyAsk") : t("advances.emptyHint")} icon="hand-coins" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/staff/payroll/advances${searchOf({ ...filters, page: n })}` || "?"} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <span className="type-strong">{row.employee.name}</span>
                  <Money iqd={row.amountIqd} className="type-strong" />
                </div>
                <StateTag group="advance" value={row.status} label={t(`advanceStatus.${row.status}`)} />
                {row.reason ? <p className="type-caption text-ink-2">{row.reason}</p> : null}
                <Pair label={t("advances.col.requestedBy")}>
                  <ByName by={row.requestedBy} />
                </Pair>
                <Pair label={t("advances.col.at")}>
                  <When at={row.createdAt} />
                </Pair>
                {actions(row)}
              </>
            )}
          />
        </div>
      </Section>
      <Note>
        <p>{t("advances.rules")}</p>
      </Note>

      {asking ? (
        <FormDialog title={t("advances.askTitle")} description={t("advances.askWhat")} submitLabel={t("advances.askKey")} onClose={() => setAsking(false)} successMessage={t("advances.requested")} hidden={{ intent: "request", idempotencyKey: key }}>
          {(fields) => (
            <>
              <Select name="employeeId" label={t("advances.col.employee")} required error={fields.employeeId} options={[{ value: "", label: t("common.choose") }, ...people.map((person) => ({ value: person.id, label: person.name }))]} />
              <TextField name="amountIqd" label={t("advances.amountField")} required inputMode="numeric" ltr error={fields.amountIqd} />
              <Select name="paidFrom" label={t("advances.col.from")} required defaultValue="cash" error={fields.paidFrom} options={PAID_FROM_LIST.map((value) => ({ value, label: t(`paidFrom.${value}`) }))} />
              <TextField name="reason" label={t("common.reason")} required minLength={3} maxLength={500} error={fields.reason} />
            </>
          )}
        </FormDialog>
      ) : null}
      {deciding ? (
        <ActionDialog
          open
          onClose={() => setDeciding(null)}
          tone={deciding.decision === "approve" ? "commit" : "destructive"}
          title={deciding.decision === "approve" ? t("advances.approveQ", { name: deciding.row.employee.name }) : t("advances.rejectQ", { name: deciding.row.employee.name })}
          consequence={deciding.decision === "approve" ? t("advances.approveWhat") : t("advances.rejectWhat")}
          impact={[
            { label: t("advances.col.amount"), value: <Money iqd={deciding.row.amountIqd} />, negative: deciding.decision === "approve" },
            { label: t("advances.col.from"), value: deciding.row.paidFrom ? t(`paidFrom.${deciding.row.paidFrom}`) : "—" },
          ]}
          confirmLabel={deciding.decision === "approve" ? t("advances.approve") : t("advances.reject")}
          reason={deciding.decision === "reject" ? true : { label: t("advances.approveNote"), noteRequired: false, minLength: 0 }}
          reasonName="note"
          fields={{ intent: "decide", approvalId: deciding.row.id, decision: deciding.decision }}
          successMessage={t("advances.decided")}
        />
      ) : null}
      {withdrawing ? <ActionDialog open onClose={() => setWithdrawing(null)} tone="destructive" title={t("advances.withdrawQ")} consequence={t("advances.withdrawWhat")} confirmLabel={t("advances.withdraw")} fields={{ intent: "withdraw", approvalId: withdrawing.id }} successMessage={t("advances.withdrawn")} /> : null}
    </>
  );
}
