import { useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import type { Route } from "./+types/attendance";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { approveAttendance, correctAttendance, listAttendance, recordAttendance } from "~/server/services/admin/staff/attendance.server";
import { attendanceSearch, baghdadDay, clockOf, parseAttendanceFilters, type AttendanceFilters, type AttendanceRow } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { staffMeta } from "./meta";
import { all, failed, int, intOrNull, ok, openStaff, orRespond, staffT, text } from "./staff.server";
import { Clock, Day, DemoTag, Duration, FormDialog, Kpi, LinkChips, Note, PageHead, Pair, ResponsiveTable, Section, tOr, useStaffT, type ActionData } from "./ui";

/**
 * /admin/staff/attendance — 15.02 attendance: who clocked in and out, on which shift, late or not, how long; a
 * manager records a missed clock-in or corrects a record (a reason, audited before and after) and approves closed
 * records — one by one or in bulk; nobody records, corrects or approves their own. Days, employee and state in the
 * URL. Employees clock themselves in on /admin/staff/me.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openStaff(context);
  const filters = parseAttendanceFilters(new URL(request.url).searchParams, now);
  const page = await orRespond(() => listAttendance(db, actor, filters, locale));
  return { page, filters, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "record":
        await recordAttendance(req.db, req.actor, { employeeId: text(form, "employeeId"), day: text(form, "day"), start: text(form, "start"), end: text(form, "end"), reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("attendance.recorded") });
      case "correct":
        await correctAttendance(
          req.db,
          req.actor,
          { attendanceId: text(form, "attendanceId"), day: text(form, "day"), start: text(form, "start"), end: text(form, "end"), reason: text(form, "reason"), expectedClockInAt: int(form, "expectedClockInAt"), expectedClockOutAt: intOrNull(form, "expectedClockOutAt") },
          req.now,
        );
        return ok(intent, { message: t("attendance.corrected") });
      case "approve": {
        const result = await approveAttendance(req.db, req.actor, { ids: all(form, "id") }, req.now);
        return ok(intent, { message: t("attendance.approved", { approved: result.approved, skipped: result.skipped }) });
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "attendance.title");

type Page = Route.ComponentProps["loaderData"]["page"];

export default function AttendancePage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const { page, filters, now } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [correcting, setCorrecting] = useState<AttendanceRow | null>(null);
  const href = (patch: Partial<AttendanceFilters>) => `/admin/staff/attendance${attendanceSearch({ ...filters, ...patch, page: 1 }, now)}`;
  const columns: DataColumn<AttendanceRow>[] = [
    {
      key: "employee",
      header: t("attendance.col.employee"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Link to={`/admin/staff/employees/${row.employee.id}`} className="adm-link">
            {row.employee.name}
          </Link>
          <DemoTag show={row.employee.isDemo} />
        </span>
      ),
    },
    { key: "day", header: t("attendance.col.day"), cell: (row) => <Day day={baghdadDay(row.clockInAt)} /> },
    {
      key: "in",
      header: t("attendance.col.in"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Clock at={row.clockInAt} />
          {row.late ? <Status tone="warn">{t("attendance.lateBy", { minutes: row.lateMinutes })}</Status> : null}
        </span>
      ),
    },
    { key: "out", header: t("attendance.col.out"), cell: (row) => (row.clockOutAt ? <Clock at={row.clockOutAt} /> : <Status tone="info">{t("attendance.stillIn")}</Status>) },
    { key: "hours", header: t("attendance.col.hours"), numeric: true, cell: (row) => <Duration minutes={row.minutes} /> },
    {
      key: "shift",
      header: t("attendance.col.shift"),
      cell: (row) =>
        row.shift ? (
          <span className="nums">
            <Clock at={row.shift.startsAt} />–<Clock at={row.shift.endsAt} />
          </span>
        ) : (
          <span className="text-ink-2">{t("attendance.noShift")}</span>
        ),
    },
    { key: "method", header: t("attendance.col.method"), cell: (row) => tOr(t, `attendance.method.${row.method}`, row.method) },
    {
      key: "approved",
      header: t("attendance.col.approved"),
      cell: (row) =>
        row.approvedBy ? (
          <span>{row.approvedBy}</span>
        ) : row.clockOutAt ? (
          <Status tone="warn">{t("attendance.notApproved")}</Status>
        ) : (
          <span className="text-ink-2">—</span>
        ),
    },
    ...(page.can.manage
      ? [
          {
            key: "act",
            header: <span className="sr-only">{t("common.actions")}</span>,
            cell: (row: AttendanceRow) =>
              row.canCorrect ? (
                <Key size="sm" variant="ghost" icon="pencil-simple" onClick={() => setCorrecting(row)} aria-label={t("attendance.correctFor", { name: row.employee.name })}>
                  {t("attendance.correct")}
                </Key>
              ) : null,
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHead
        title={t("attendance.title")}
        lead={t("attendance.lead", { minutes: 10 })}
        actions={
          page.can.manage ? (
            <Key size="sm" variant="primary" icon="plus" onClick={() => setRecording(true)}>
              {t("attendance.record")}
            </Key>
          ) : null
        }
      />
      <div className="stf-kpis mb-5">
        <Kpi label={t("attendance.records")} value={f.number(page.summary.records)} />
        <Kpi label={t("attendance.hours")} value={<Duration minutes={page.summary.minutes} />} />
        <Kpi label={t("attendance.lateCount")} value={f.number(page.summary.late)} to={href({ state: "late" })} />
        <Kpi label={t("attendance.openCount")} value={f.number(page.summary.open)} to={href({ state: "open" })} />
        <Kpi label={t("attendance.unapprovedCount")} value={f.number(page.summary.unapproved)} to={href({ state: "unapproved" })} />
      </div>

      <Section id="list" title={t("attendance.list")}>
        <div className="grid gap-3">
          <LinkChips
            label={t("attendance.stateFilter")}
            items={(["all", "open", "unapproved", "late"] as const).map((state) => ({ value: state, label: t(`attendance.state.${state}`), href: href({ state }), selected: filters.state === state }))}
          />
          <Form method="get" action="/admin/staff/attendance" className="stf-filters stf-noprint">
            {filters.state !== "all" ? <input type="hidden" name="state" value={filters.state} /> : null}
            <TextField name="from" type="date" label={t("common.from")} defaultValue={filters.from} ltr />
            <TextField name="to" type="date" label={t("common.to")} defaultValue={filters.to} ltr />
            <Select name="employee" label={t("attendance.col.employee")} defaultValue={filters.employee ?? ""} options={[{ value: "", label: t("common.any") }, ...page.employees.map((person) => ({ value: person.id, label: person.name }))]} />
            <div className="flex items-end gap-2">
              <Key type="submit" size="sm" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to="/admin/staff/attendance" size="sm" variant="ghost">
                {t("common.clear")}
              </Key>
            </div>
          </Form>
          <ResponsiveTable
            caption={t("attendance.list")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            rowLabel={(row) => `${row.employee.name} ${clockOf(row.clockInAt)}`}
            selected={page.can.manage ? selected : undefined}
            onSelectedChange={page.can.manage ? setSelected : undefined}
            bulkActions={page.can.manage ? (ids) => <BulkApprove ids={ids} page={page} onDone={() => setSelected([])} /> : undefined}
            empty={<EmptyState title={t("attendance.empty")} text={t("attendance.emptyHint")} icon="clock" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/staff/attendance${attendanceSearch(filters, now, n)}` || "?"} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <span className="type-strong">{row.employee.name}</span>
                  {row.late ? <Status tone="warn">{t("attendance.lateBy", { minutes: row.lateMinutes })}</Status> : null}
                </div>
                <Pair label={t("attendance.col.day")}>
                  <Day day={baghdadDay(row.clockInAt)} />
                </Pair>
                <Pair label={t("attendance.col.in")}>
                  <Clock at={row.clockInAt} />
                </Pair>
                <Pair label={t("attendance.col.out")}>{row.clockOutAt ? <Clock at={row.clockOutAt} /> : t("attendance.stillIn")}</Pair>
                <Pair label={t("attendance.col.hours")}>
                  <Duration minutes={row.minutes} />
                </Pair>
                <Pair label={t("attendance.col.approved")}>{row.approvedBy ?? (row.clockOutAt ? t("attendance.notApproved") : "—")}</Pair>
                {row.canCorrect || row.canApprove ? (
                  <div className="flex flex-wrap gap-2 stf-noprint">
                    {row.canCorrect ? (
                      <Key size="sm" variant="ghost" icon="pencil-simple" onClick={() => setCorrecting(row)}>
                        {t("attendance.correct")}
                      </Key>
                    ) : null}
                    {row.canApprove ? <BulkApprove ids={[row.id]} page={page} onDone={() => undefined} single /> : null}
                  </div>
                ) : null}
              </>
            )}
          />
        </div>
      </Section>
      <Note>
        <p>{t("attendance.rules")}</p>
      </Note>

      {recording ? (
        <FormDialog title={t("attendance.recordTitle")} description={t("attendance.recordWhat")} submitLabel={t("attendance.recordKey")} onClose={() => setRecording(false)} successMessage={t("attendance.recorded")} hidden={{ intent: "record" }}>
          {(fields) => (
            <>
              <Select name="employeeId" label={t("attendance.col.employee")} required error={fields.employeeId} options={[{ value: "", label: t("common.choose") }, ...page.employees.filter((person) => person.status === "active").map((person) => ({ value: person.id, label: person.name }))]} />
              <TextField name="day" type="date" label={t("attendance.col.day")} required defaultValue={baghdadDay(now)} ltr error={fields.day} />
              <div className="grid grid-cols-2 gap-3">
                <TextField name="start" type="time" label={t("attendance.col.in")} required ltr error={fields.start} />
                <TextField name="end" type="time" label={t("attendance.col.out")} required ltr error={fields.end} />
              </div>
              <TextField name="reason" label={t("common.reason")} required minLength={3} maxLength={500} error={fields.reason} />
            </>
          )}
        </FormDialog>
      ) : null}
      {correcting ? (
        <FormDialog
          title={t("attendance.correctTitle", { name: correcting.employee.name })}
          description={t("attendance.correctWhat")}
          submitLabel={t("attendance.correctKey")}
          onClose={() => setCorrecting(null)}
          successMessage={t("attendance.corrected")}
          hidden={{ intent: "correct", attendanceId: correcting.id, expectedClockInAt: String(correcting.clockInAt), expectedClockOutAt: correcting.clockOutAt === null ? "null" : String(correcting.clockOutAt) }}
        >
          {(fields) => (
            <>
              <TextField name="day" type="date" label={t("attendance.col.day")} required defaultValue={baghdadDay(correcting.clockInAt)} ltr error={fields.day} />
              <div className="grid grid-cols-2 gap-3">
                <TextField name="start" type="time" label={t("attendance.col.in")} required defaultValue={clockOf(correcting.clockInAt)} ltr error={fields.start} />
                <TextField name="end" type="time" label={t("attendance.col.out")} required defaultValue={correcting.clockOutAt ? clockOf(correcting.clockOutAt) : ""} ltr error={fields.end} />
              </div>
              <TextField name="reason" label={t("common.reason")} required minLength={3} maxLength={500} error={fields.reason} />
            </>
          )}
        </FormDialog>
      ) : null}
    </>
  );
}

function BulkApprove({ ids, page, onDone, single = false }: { ids: readonly string[]; page: Page; onDone: () => void; single?: boolean }) {
  const t = useStaffT();
  const fetcher = useFetcher<ActionData>();
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) {
      toast.success(fetcher.data.message ?? "");
      onDone();
    } else toast.error(fetcher.data.message ?? t("common.failed"));
  }, [fetcher.data, fetcher.state, onDone, t]);
  const approvable = ids.filter((id) => page.rows.find((row) => row.id === id)?.canApprove);
  return (
    <Key
      size="sm"
      icon="check"
      loading={fetcher.state !== "idle"}
      disabled={approvable.length === 0}
      onClick={() => {
        const form = new FormData();
        form.set("intent", "approve");
        for (const id of approvable) form.append("id", id);
        fetcher.submit(form, { method: "post" });
      }}
    >
      {single ? t("attendance.approveOne") : t("attendance.approveSelected", { count: approvable.length })}
    </Key>
  );
}
