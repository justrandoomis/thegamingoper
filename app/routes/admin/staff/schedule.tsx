import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/schedule";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { cancelShift, copyWeek, createShift, listRoster, markShift } from "~/server/services/admin/staff/schedule.server";
import { addDays, baghdadDay, parseRosterFilters, rosterSearch, type ShiftCell } from "~/server/services/admin/staff/types";
import { Dialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { staffMeta } from "./meta";
import { failed, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { ActionDialog, Clock, Day, DemoTag, Duration, FormDialog, Kpi, Note, PageHead, Section, StateTag, useStaffLayout, useStaffT } from "./ui";

/**
 * /admin/staff/schedule — 15.02 the work schedule: a week (Saturday to Friday) of planned shifts per employee, with
 * attendance (on time, late, absent) and approved leave beside them. staff.schedule.manage plans, cancels and copies
 * a week; staff.attendance.manage may also mark a shift as worked or missed. Week and employee in the URL. These are
 * work shifts — the point of sale's shifts are cash drawers (module 06), linked from the page.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openStaff(context);
  const filters = parseRosterFilters(new URL(request.url).searchParams, now);
  const roster = await orRespond(() => listRoster(db, actor, filters, locale, now));
  return { roster, filters, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "create":
        await createShift(req.db, req.actor, { employeeId: text(form, "employeeId"), day: text(form, "day"), start: text(form, "start"), end: text(form, "end"), note: optional(form, "note") }, req.now);
        return ok(intent, { message: t("schedule.created") });
      case "cancel":
        await cancelShift(req.db, req.actor, { shiftId: text(form, "shiftId"), reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("schedule.cancelled") });
      case "mark": {
        // the service's zod refuses anything but "completed" or "missed" (an unknown mark is never "worked")
        const result = await markShift(req.db, req.actor, { shiftId: text(form, "shiftId"), status: text(form, "status") as never, reason: optional(form, "reason") }, req.now);
        return ok(intent, { message: t(`schedule.marked.${result.status}`) });
      }
      case "copy": {
        const result = await copyWeek(req.db, req.actor, { fromWeek: text(form, "fromWeek"), toWeek: text(form, "toWeek") }, req.now);
        return ok(intent, { message: t("schedule.copied", { copied: result.copied, skipped: result.skipped }) });
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "schedule.title");

type Roster = Route.ComponentProps["loaderData"]["roster"];
/** `own`: the signed-in employee's own shift — markShift refuses it (nobody records their own attendance). */
type Picked = { cell: ShiftCell; name: string; own: boolean } | null;

export default function SchedulePage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const me = useStaffLayout()?.me.id ?? null;
  const { roster, filters, now } = loaderData;
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState(false);
  const [picked, setPicked] = useState<Picked>(null);
  const weekHref = (week: string) => `/admin/staff/schedule${rosterSearch({ ...filters, week }, now)}` || "/admin/staff/schedule";
  const nextWeek = addDays(roster.week, 7);
  return (
    <>
      <PageHead
        title={t("schedule.title")}
        lead={
          <>
            {t("schedule.lead")}{" "}
            <Link to="/admin/pos/shifts" className="adm-link">
              {t("schedule.posShifts")}
            </Link>
          </>
        }
        actions={
          roster.can.manage ? (
            <>
              <Key size="sm" icon="copy" onClick={() => setCopying(true)}>
                {t("schedule.copyWeek")}
              </Key>
              <Key size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
                {t("schedule.add")}
              </Key>
            </>
          ) : null
        }
      />

      <div className="stf-noprint mb-4 flex flex-wrap items-end justify-between gap-3">
        <nav aria-label={t("schedule.weeks")} className="flex flex-wrap items-center gap-2">
          <Key as={Link} to={weekHref(addDays(roster.week, -7))} size="sm" icon="caret-left">
            {t("schedule.prevWeek")}
          </Key>
          <Key as={Link} to={weekHref(baghdadDay(now))} size="sm" held={roster.days.includes(roster.today)}>
            {t("schedule.thisWeek")}
          </Key>
          <Key as={Link} to={weekHref(nextWeek)} size="sm" iconEnd="caret-right">
            {t("schedule.nextWeek")}
          </Key>
        </nav>
        <Form method="get" action="/admin/staff/schedule" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="week" value={roster.week} />
          <Select name="employee" label={t("schedule.employee")} defaultValue={filters.employee ?? ""} options={[{ value: "", label: t("schedule.everyone") }, ...roster.employees.map((person) => ({ value: person.id, label: person.name }))]} />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
      </div>

      <div className="stf-kpis mb-5">
        <Kpi label={t("schedule.week")} value={<Day day={roster.week} />} hint={<Day day={roster.days[6]} />} />
        <Kpi label={t("schedule.shifts")} value={f.number(roster.totals.shifts)} />
        <Kpi label={t("schedule.planned")} value={<Duration minutes={roster.totals.plannedMinutes} />} />
        <Kpi label={t("schedule.people")} value={f.number(roster.totals.employees)} />
      </div>

      <Section id="roster" title={t("schedule.roster")}>
        {roster.rows.length === 0 ? (
          <EmptyState title={t("schedule.empty")} text={roster.can.manage ? t("schedule.emptyHint") : t("schedule.emptyRead")} icon="calendar" />
        ) : (
          <>
            <div className="stf-roster-wrap hidden md:block">
              <table className="stf-roster">
                <caption className="sr-only">{t("schedule.roster")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("schedule.employee")}</th>
                    {roster.days.map((day) => (
                      <th key={day} scope="col" data-today={day === roster.today ? "true" : undefined}>
                        <Day day={day} withWeekday />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roster.rows.map((row) => (
                    <tr key={row.employee.id}>
                      <th scope="row">
                        <Link to={`/admin/staff/employees/${row.employee.id}`} className="adm-link">
                          {row.employee.name}
                        </Link>
                        <span className="block type-caption text-ink-2">
                          <Duration minutes={row.plannedMinutes} />
                        </span>
                        <DemoTag show={row.employee.isDemo} />
                      </th>
                      {row.days.map((cells, index) => (
                        <td key={roster.days[index]} data-leave={row.leaveDays.includes(roster.days[index]) ? "true" : undefined}>
                          {row.leaveDays.includes(roster.days[index]) ? <span className="block type-caption text-ink-2">{t("schedule.onLeave")}</span> : null}
                          {cells.map((cell) => (
                            <ShiftChip key={cell.id} cell={cell} onPick={roster.can.mark || roster.can.manage ? () => setPicked({ cell, name: row.employee.name, own: row.employee.id === me }) : undefined} />
                          ))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ol role="list" className="grid gap-3 md:hidden">
              {roster.days.map((day, index) => {
                const entries = roster.rows.flatMap((row) => row.days[index].map((cell) => ({ cell, row })));
                const leave = roster.rows.filter((row) => row.leaveDays.includes(day));
                return (
                  <li key={day} className="adm-card gap-2">
                    <h3 className="adm-h3">
                      <Day day={day} withWeekday />
                    </h3>
                    {entries.length === 0 && leave.length === 0 ? <p className="type-caption text-ink-2">{t("schedule.noShiftsDay")}</p> : null}
                    {entries.map(({ cell, row }) => (
                      <div key={cell.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="type-label">{row.employee.name}</span>
                        <ShiftChip cell={cell} onPick={roster.can.mark || roster.can.manage ? () => setPicked({ cell, name: row.employee.name, own: row.employee.id === me }) : undefined} />
                      </div>
                    ))}
                    {leave.map((row) => (
                      <p key={row.employee.id} className="type-caption text-ink-2">
                        {row.employee.name} · {t("schedule.onLeave")}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </Section>
      <Note>
        <p>{t("schedule.rules")}</p>
      </Note>

      {adding ? <AddShift roster={roster} onClose={() => setAdding(false)} /> : null}
      <ActionDialog
        open={copying}
        onClose={() => setCopying(false)}
        title={t("schedule.copyQ")}
        consequence={t("schedule.copyWhat")}
        impact={[
          { label: t("schedule.copyFrom"), value: <Day day={roster.week} /> },
          { label: t("schedule.copyTo"), value: <Day day={nextWeek} /> },
          { label: t("schedule.shifts"), value: f.number(roster.totals.shifts) },
        ]}
        confirmLabel={t("schedule.copyWeek")}
        fields={{ intent: "copy", fromWeek: roster.week, toWeek: nextWeek }}
        successMessage={t("schedule.copiedShort")}
      />
      <ShiftActions picked={picked} canManage={roster.can.manage} canMark={roster.can.mark} now={now} onClose={() => setPicked(null)} />
    </>
  );
}

function ShiftChip({ cell, onPick }: { cell: ShiftCell; onPick?: () => void }) {
  const t = useStaffT();
  const body = (
    <>
      <span className="nums">
        <Clock at={cell.startsAt} />–<Clock at={cell.endsAt} />
        {cell.overnight ? <span className="type-caption text-ink-2"> {t("schedule.overnight")}</span> : null}
      </span>
      <span className="inline-flex flex-wrap items-center gap-1">
        {cell.status !== "scheduled" ? <StateTag group="shift" value={cell.status} label={t(`shiftStatus.${cell.status}`)} /> : null}
        {cell.attended ? <Status tone={cell.attended === "on_time" ? "ok" : cell.attended === "open" ? "info" : "bad"}>{t(`schedule.attended.${cell.attended}`)}</Status> : null}
      </span>
      {cell.note ? <span className="type-caption text-ink-2">{cell.note}</span> : null}
    </>
  );
  if (!onPick || cell.status === "cancelled") {
    return (
      <span className="stf-shift" data-status={cell.status}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" className="stf-shift w-full cursor-pointer text-start" data-status={cell.status} onClick={onPick} aria-haspopup="dialog">
      {body}
    </button>
  );
}

function AddShift({ roster, onClose }: { roster: Roster; onClose: () => void }) {
  const t = useStaffT();
  const firstDay = roster.days.find((day) => day >= roster.today) ?? roster.days[0];
  return (
    <FormDialog title={t("schedule.addTitle")} description={t("schedule.addWhat")} submitLabel={t("schedule.addKey")} onClose={onClose} successMessage={t("schedule.created")} hidden={{ intent: "create" }}>
      {(fields) => (
        <>
          <Select name="employeeId" label={t("schedule.employee")} required error={fields.employeeId} options={[{ value: "", label: t("common.choose") }, ...roster.employees.filter((person) => person.status === "active").map((person) => ({ value: person.id, label: person.name }))]} />
          <TextField name="day" type="date" label={t("schedule.day")} required defaultValue={firstDay} ltr error={fields.day} />
          <div className="grid grid-cols-2 gap-3">
            <TextField name="start" type="time" label={t("schedule.start")} required defaultValue="09:00" ltr error={fields.start} />
            <TextField name="end" type="time" label={t("schedule.end")} required defaultValue="17:00" ltr hint={t("schedule.endHint")} error={fields.end} />
          </div>
          <TextArea name="note" label={t("schedule.note")} optional maxLength={500} rows={2} error={fields.note} />
        </>
      )}
    </FormDialog>
  );
}

function ShiftActions({ picked, canManage, canMark, now, onClose }: { picked: Picked; canManage: boolean; canMark: boolean; now: number; onClose: () => void }) {
  const t = useStaffT();
  const [mode, setMode] = useState<"cancel" | "completed" | "missed" | null>(null);
  if (!picked) return null;
  const { cell, name, own } = picked;
  const started = cell.startsAt <= now;
  const markable = canMark && !own && cell.status === "scheduled" && started;
  const ownNote = canMark && own && cell.status === "scheduled" && started;
  const cancellable = canManage && cell.status === "scheduled";
  const close = () => {
    setMode(null);
    onClose();
  };
  if (mode) {
    return (
      <ActionDialog
        open
        onClose={close}
        tone={mode === "completed" ? "neutral" : "destructive"}
        title={t(`schedule.${mode}Q`, { name })}
        consequence={t(`schedule.${mode}What`)}
        confirmLabel={t(`schedule.${mode}Key`)}
        reason={mode === "completed" ? false : true}
        fields={mode === "cancel" ? { intent: "cancel", shiftId: cell.id } : { intent: "mark", shiftId: cell.id, status: mode }}
        successMessage={t("schedule.updated")}
      />
    );
  }
  return (
    <Dialog
      open
      onClose={close}
      title={t("schedule.shiftOf", { name })}
      description={
        <span className="nums">
          <Clock at={cell.startsAt} />–<Clock at={cell.endsAt} />
        </span>
      }
      footer={<Key onClick={close}>{t("common.back")}</Key>}
    >
      <div className="flex flex-wrap gap-2">
        {cancellable ? (
          <Key size="sm" variant="danger" icon="x-circle" onClick={() => setMode("cancel")}>
            {t("schedule.cancelKey")}
          </Key>
        ) : null}
        {markable ? (
          <>
            <Key size="sm" icon="check" onClick={() => setMode("completed")}>
              {t("schedule.completedKey")}
            </Key>
            <Key size="sm" icon="warning" onClick={() => setMode("missed")}>
              {t("schedule.missedKey")}
            </Key>
          </>
        ) : null}
        {ownNote ? <p className="type-caption text-ink-2">{t("errors.attendance_self_approval")}</p> : null}
        {!cancellable && !markable && !ownNote ? <p className="type-caption text-ink-2">{t("schedule.nothingToDo")}</p> : null}
      </div>
    </Dialog>
  );
}
