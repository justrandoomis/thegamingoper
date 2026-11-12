import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/leave";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { cancelLeave, decideLeave, listLeave, requestLeave } from "~/server/services/admin/staff/leave.server";
import { baghdadDay, LEAVE_STATUS_LIST, leaveSearch, parseLeaveFilters, type LeaveFilters, type LeaveRow } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { staffMeta } from "./meta";
import { failed, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { LeaveFields } from "./forms";
import { ActionDialog, Day, DemoTag, FormDialog, Kpi, LinkChips, Note, PageHead, Pair, ResponsiveTable, Section, StateTag, useStaffT } from "./ui";

/**
 * /admin/staff/leave — 15.02 leave requests: pending first; staff.leave.approve approves or rejects (never their own;
 * approving cancels the employee's planned shifts on those days — shown before confirming), records leave on someone's
 * behalf and cancels an approved leave that has not ended. Status and employee in the URL. Employees ask for their own
 * leave on /admin/staff/me.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openStaff(context);
  const filters = parseLeaveFilters(new URL(request.url).searchParams);
  const page = await orRespond(() => listLeave(db, actor, filters, now));
  return { page, filters, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "decide": {
        // the service's zod refuses anything but "approve" or "reject": a missing or unknown decision is never an approval
        const result = await decideLeave(req.db, req.actor, { leaveId: text(form, "leaveId"), decision: text(form, "decision") as never, note: optional(form, "note") }, req.now);
        return ok(intent, { message: result.status === "approved" ? t("leave.approved", { count: result.shiftsCancelled }) : t("leave.rejected") });
      }
      case "request":
        await requestLeave(req.db, req.actor, { employeeId: optional(form, "employeeId"), kind: text(form, "kind") as never, startsOn: text(form, "startsOn"), endsOn: text(form, "endsOn"), reason: optional(form, "reason") }, req.now);
        return ok(intent, { message: t("leave.requested") });
      case "cancel":
        await cancelLeave(req.db, req.actor, { leaveId: text(form, "leaveId"), reason: optional(form, "reason") }, req.now);
        return ok(intent, { message: t("leave.cancelled") });
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "leave.title");

type Deciding = { row: LeaveRow; decision: "approve" | "reject" } | null;

export default function LeavePage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const { page, filters, now } = loaderData;
  const [deciding, setDeciding] = useState<Deciding>(null);
  const [cancelling, setCancelling] = useState<LeaveRow | null>(null);
  const [recording, setRecording] = useState(false);
  const href = (patch: Partial<LeaveFilters>) => `/admin/staff/leave${leaveSearch({ ...filters, ...patch, page: 1 })}` || "/admin/staff/leave";
  const actions = (row: LeaveRow) => (
    <span className="inline-flex flex-wrap gap-1 stf-noprint">
      {row.canDecide ? (
        <>
          <Key size="sm" icon="check" onClick={() => setDeciding({ row, decision: "approve" })}>
            {t("leave.approve")}
          </Key>
          <Key size="sm" variant="ghost" icon="x" onClick={() => setDeciding({ row, decision: "reject" })}>
            {t("leave.reject")}
          </Key>
        </>
      ) : null}
      {row.canCancel ? (
        <Key size="sm" variant="ghost" onClick={() => setCancelling(row)}>
          {row.status === "pending" ? t("leave.withdraw") : t("leave.cancel")}
        </Key>
      ) : null}
    </span>
  );
  const columns: DataColumn<LeaveRow>[] = [
    {
      key: "employee",
      header: t("leave.col.employee"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Link to={`/admin/staff/employees/${row.employee.id}`} className="adm-link">
            {row.employee.name}
          </Link>
          <DemoTag show={row.employee.isDemo} />
        </span>
      ),
    },
    { key: "kind", header: t("leave.col.kind"), cell: (row) => t(`leaveKind.${row.kind}`) },
    {
      key: "dates",
      header: t("leave.col.dates"),
      cell: (row) => (
        <span className="inline-flex flex-wrap gap-1">
          <Day day={row.startsOn} /> – <Day day={row.endsOn} />
        </span>
      ),
    },
    { key: "days", header: t("leave.col.days"), numeric: true, cell: (row) => f.number(row.days) },
    { key: "reason", header: t("leave.col.reason"), cell: (row) => row.reason ?? <span className="text-ink-2">—</span> },
    { key: "status", header: t("leave.col.status"), cell: (row) => <StateTag group="leave" value={row.status} label={t(`leaveStatus.${row.status}`)} /> },
    { key: "by", header: t("leave.col.decidedBy"), cell: (row) => row.decidedBy ?? <span className="text-ink-2">—</span> },
    { key: "act", header: <span className="sr-only">{t("common.actions")}</span>, cell: actions },
  ];
  return (
    <>
      <PageHead
        title={t("leave.title")}
        lead={t("leave.lead")}
        actions={
          page.can.record ? (
            <Key size="sm" icon="plus" onClick={() => setRecording(true)}>
              {t("leave.recordFor")}
            </Key>
          ) : null
        }
      />
      <div className="stf-kpis mb-5">
        <Kpi label={t("leave.pending")} value={f.number(page.counts.pending)} to={href({ status: "pending" })} />
        <Kpi label={t("leave.upcoming")} value={f.number(page.counts.approvedUpcoming)} to={href({ status: "approved" })} />
        <Kpi label={t("leave.today")} value={f.number(page.counts.onLeaveToday)} />
      </div>
      <Section id="list" title={t("leave.list")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: page.total })}</span>}>
        <div className="grid gap-3">
          <LinkChips
            label={t("leave.statusFilter")}
            items={[
              ...LEAVE_STATUS_LIST.map((status) => ({ value: status, label: t(`leaveStatus.${status}`), href: href({ status }), selected: filters.status === status })),
              { value: "all", label: t("common.all"), href: href({ status: null }), selected: filters.status === null },
            ]}
          />
          <Form method="get" action="/admin/staff/leave" className="stf-filters stf-noprint">
            <input type="hidden" name="status" value={filters.status ?? "all"} />
            <Select name="employee" label={t("leave.col.employee")} defaultValue={filters.employee ?? ""} options={[{ value: "", label: t("common.any") }, ...page.employees.map((person) => ({ value: person.id, label: person.name }))]} />
            <div className="flex items-end gap-2">
              <Key type="submit" size="sm" icon="funnel">
                {t("common.apply")}
              </Key>
            </div>
          </Form>
          <ResponsiveTable
            caption={t("leave.list")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={filters.status === "pending" ? t("leave.emptyPending") : t("leave.empty")} text={t("leave.emptyHint")} icon="calendar-blank" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/staff/leave${leaveSearch(filters, n)}` || "?"} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <span className="type-strong">{row.employee.name}</span>
                  <StateTag group="leave" value={row.status} label={t(`leaveStatus.${row.status}`)} />
                </div>
                <Pair label={t("leave.col.kind")}>{t(`leaveKind.${row.kind}`)}</Pair>
                <Pair label={t("leave.col.dates")}>
                  <Day day={row.startsOn} /> – <Day day={row.endsOn} />
                </Pair>
                <Pair label={t("leave.col.days")}>{f.number(row.days)}</Pair>
                {row.reason ? <p className="type-caption text-ink-2">{row.reason}</p> : null}
                {actions(row)}
              </>
            )}
          />
        </div>
      </Section>
      <Note>
        <p>{t("leave.rules")}</p>
      </Note>

      {deciding ? (
        <ActionDialog
          open
          onClose={() => setDeciding(null)}
          tone={deciding.decision === "reject" ? "destructive" : "neutral"}
          title={deciding.decision === "approve" ? t("leave.approveQ", { name: deciding.row.employee.name }) : t("leave.rejectQ", { name: deciding.row.employee.name })}
          consequence={deciding.decision === "approve" ? t("leave.approveWhat") : t("leave.rejectWhat")}
          impact={[
            { label: t("leave.col.kind"), value: t(`leaveKind.${deciding.row.kind}`) },
            { label: t("leave.col.days"), value: f.number(deciding.row.days) },
            ...(deciding.decision === "approve" ? [{ label: t("leave.shiftsCancelled"), value: f.number(deciding.row.shiftsAffected), negative: deciding.row.shiftsAffected > 0 }] : []),
          ]}
          confirmLabel={deciding.decision === "approve" ? t("leave.approve") : t("leave.reject")}
          reason={deciding.decision === "reject" ? { label: t("leave.rejectNote") } : false}
          reasonName="note"
          fields={{ intent: "decide", leaveId: deciding.row.id, decision: deciding.decision }}
          successMessage={t("leave.decided")}
        />
      ) : null}
      {cancelling ? (
        <ActionDialog
          open
          onClose={() => setCancelling(null)}
          tone="destructive"
          title={cancelling.status === "pending" ? t("leave.withdrawQ") : t("leave.cancelQ", { name: cancelling.employee.name })}
          consequence={cancelling.status === "pending" ? t("leave.withdrawWhat") : t("leave.cancelWhat")}
          confirmLabel={cancelling.status === "pending" ? t("leave.withdraw") : t("leave.cancel")}
          reason={cancelling.status === "approved"}
          fields={{ intent: "cancel", leaveId: cancelling.id }}
          successMessage={t("leave.cancelled")}
        />
      ) : null}
      {recording ? (
        <FormDialog title={t("leave.recordTitle")} description={t("leave.recordWhat")} submitLabel={t("leave.recordKey")} onClose={() => setRecording(false)} successMessage={t("leave.requested")} hidden={{ intent: "request" }}>
          {(fields) => (
            <>
              <Select name="employeeId" label={t("leave.col.employee")} required error={fields.employeeId} options={[{ value: "", label: t("common.choose") }, ...page.employees.map((person) => ({ value: person.id, label: person.name }))]} />
              <LeaveFields fields={fields} today={baghdadDay(now)} />
            </>
          )}
        </FormDialog>
      ) : null}
    </>
  );
}
