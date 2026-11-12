import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/me";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { clockIn, clockOut, myClock } from "~/server/services/admin/staff/attendance.server";
import { myCommissions } from "~/server/services/admin/staff/commissions.server";
import { cancelLeave, myLeave, requestLeave } from "~/server/services/admin/staff/leave.server";
import { myPay } from "~/server/services/admin/staff/payroll.server";
import { shiftsOf } from "~/server/services/admin/staff/schedule.server";
import { listTasks } from "~/server/services/admin/staff/tasks.server";
import { baghdadDay, dayStart, DAY_MS, parseTaskFilters, periodOf, weekStartOf } from "~/server/services/admin/staff/types";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { LeaveFields } from "./forms";
import { staffMeta } from "./meta";
import { failed, ok, openStaff, optional, staffT, text } from "./staff.server";
import { ActionDialog, Clock, Day, Duration, FormDialog, Money, Note, PageHead, Pair, PeriodName, Section, StateTag, When, useStaffT, type ActionData } from "./ui";

/**
 * /admin/staff/me — the signed-in employee's own day: clock in and out (onto the shift under way), this week's shifts,
 * recent attendance, their leave requests (ask, withdraw), their open tasks, this month's commissions (their own
 * amounts; the base and rate of a profit plan only with profit.read) and their own payslips. Nothing here needs a
 * staff permission beyond reaching the module (the shell is asked to open this page to every signed-in employee).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openStaff(context);
  const week = weekStartOf(baghdadDay(now));
  const from = dayStart(week);
  const [clock, shifts, leave, commissions, pay, tasks] = await Promise.all([
    myClock(db, actor, now),
    shiftsOf(db, actor.id, from, from + 7 * DAY_MS),
    myLeave(db, actor, now),
    myCommissions(db, actor, periodOf(now)),
    myPay(db, actor),
    listTasks(db, actor, { ...parseTaskFilters(new URLSearchParams()), mine: true }, now),
  ]);
  return { clock, shifts, leave, commissions, pay, tasks: { rows: tasks.rows.slice(0, 5), total: tasks.total }, now, period: periodOf(now) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "clock-in": {
        const result = await clockIn(req.db, req.actor, { note: optional(form, "note") }, req.now);
        return ok(intent, { message: result.late ? t("me.clockedInLate") : t("me.clockedIn") });
      }
      case "clock-out": {
        const result = await clockOut(req.db, req.actor, { note: optional(form, "note") }, req.now);
        return ok(intent, { message: t("me.clockedOut", { minutes: result.minutes }) });
      }
      case "leave":
        await requestLeave(req.db, req.actor, { kind: text(form, "kind") as never, startsOn: text(form, "startsOn"), endsOn: text(form, "endsOn"), reason: optional(form, "reason") }, req.now);
        return ok(intent, { message: t("leave.requested") });
      case "withdraw":
        await cancelLeave(req.db, req.actor, { leaveId: text(form, "leaveId") }, req.now);
        return ok(intent, { message: t("leave.cancelled") });
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "me.title");

type Data = Route.ComponentProps["loaderData"];

export default function MyDayPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const { clock, shifts, leave, commissions, pay, tasks, now, period } = loaderData;
  const [asking, setAsking] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  return (
    <>
      <PageHead title={t("me.title")} lead={t("me.lead")} />
      <ClockCard clock={clock} now={now} />

      <div className="stf-split mt-5">
        <div className="grid min-w-0 gap-5">
          <Section id="week" title={t("me.week")}>
            {shifts.length ? (
              <ul role="list" className="grid gap-2">
                {shifts.map((shift) => (
                  <li key={shift.id} className="adm-card gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Day day={baghdadDay(shift.startsAt)} withWeekday />
                      <span className="nums">
                        <Clock at={shift.startsAt} />–<Clock at={shift.endsAt} />
                      </span>
                    </div>
                    {shift.status !== "scheduled" ? <StateTag group="shift" value={shift.status} label={t(`shiftStatus.${shift.status}`)} /> : null}
                    {shift.note ? <p className="type-caption text-ink-2">{shift.note}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t("me.noShifts")} text={t("me.noShiftsHint")} icon="calendar" />
            )}
          </Section>

          <Section
            id="leave"
            title={t("me.leave")}
            aside={
              <Key size="sm" icon="plus" onClick={() => setAsking(true)}>
                {t("me.askLeave")}
              </Key>
            }
          >
            {leave.length ? (
              <ul role="list" className="grid gap-2">
                {leave.map((row) => (
                  <li key={row.id} className="adm-card gap-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="type-label">{t(`leaveKind.${row.kind}`)}</span>
                      <StateTag group="leave" value={row.status} label={t(`leaveStatus.${row.status}`)} />
                    </div>
                    <Pair label={t("leave.col.dates")}>
                      <Day day={row.startsOn} /> – <Day day={row.endsOn} />
                    </Pair>
                    {row.decidedBy ? <Pair label={t("leave.col.decidedBy")}>{row.decidedBy}</Pair> : null}
                    {row.status === "pending" ? (
                      <div className="stf-noprint">
                        <Key size="sm" variant="ghost" onClick={() => setWithdrawing(row.id)}>
                          {t("leave.withdraw")}
                        </Key>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-body text-ink-2">{t("me.noLeave")}</p>
            )}
          </Section>

          <Section id="recent" title={t("me.recent")}>
            {clock.recent.length ? (
              <div className="adm-card">
                <ul role="list" className="grid gap-2">
                  {clock.recent.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2">
                      <Day day={baghdadDay(row.clockInAt)} />
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="nums">
                          <Clock at={row.clockInAt} />–{row.clockOutAt ? <Clock at={row.clockOutAt} /> : "…"}
                        </span>
                        <Duration minutes={row.minutes} />
                        {row.late ? <Status tone="warn">{t("attendance.lateBy", { minutes: row.lateMinutes })}</Status> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="type-body text-ink-2">{t("me.noRecords")}</p>
            )}
          </Section>
        </div>
        <aside className="grid min-w-0 gap-5">
          <Section id="tasks" title={t("me.tasks")} aside={<Link to="/admin/staff/tasks?mine=1" className="adm-link type-label">{t("me.allTasks", { count: tasks.total })}</Link>}>
            {tasks.rows.length ? (
              <ul role="list" className="grid gap-2">
                {tasks.rows.map((row) => (
                  <li key={row.id} className="adm-card gap-1">
                    <span className="type-label">{row.title}</span>
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <StateTag group="task" value={row.status} label={t(`taskStatus.${row.status}`)} />
                      {row.overdue ? <Status tone="bad">{t("tasks.overdue")}</Status> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-body text-ink-2">{t("me.noTasks")}</p>
            )}
          </Section>
          <MyCommissions commissions={commissions} period={period} />
          <MyPay pay={pay} />
        </aside>
      </div>

      {asking ? (
        <FormDialog title={t("me.askLeaveTitle")} description={t("me.askLeaveWhat")} submitLabel={t("me.askLeaveKey")} onClose={() => setAsking(false)} successMessage={t("leave.requested")} hidden={{ intent: "leave" }}>
          {(fields) => <LeaveFields fields={fields} today={baghdadDay(now)} />}
        </FormDialog>
      ) : null}
      <ActionDialog open={withdrawing !== null} onClose={() => setWithdrawing(null)} tone="destructive" title={t("leave.withdrawQ")} consequence={t("leave.withdrawWhat")} confirmLabel={t("leave.withdraw")} fields={{ intent: "withdraw", leaveId: withdrawing ?? "" }} successMessage={t("leave.cancelled")} />
    </>
  );
}

function ClockCard({ clock, now }: { clock: Data["clock"]; now: number }) {
  const t = useStaffT();
  const fetcher = useFetcher<ActionData>();
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) toast.success(fetcher.data.message ?? "");
  }, [fetcher.data, fetcher.state]);
  const failure = fetcher.data && !fetcher.data.ok && fetcher.state === "idle" ? fetcher.data.message : null;
  const open = clock.open;
  return (
    <section aria-labelledby="clock" className="adm-card adm-card--act stf-clock">
      <h2 id="clock" className="adm-h2">
        {open ? t("me.inSince") : t("me.notIn")}
      </h2>
      {open ? (
        <p className="type-body">
          <Clock at={open.clockInAt} /> · <Duration minutes={Math.round((now - open.clockInAt) / 60_000)} />
          {open.late ? (
            <>
              {" "}
              <Status tone="warn">{t("attendance.lateBy", { minutes: open.lateMinutes })}</Status>
            </>
          ) : null}
        </p>
      ) : clock.shift ? (
        <p className="type-body">
          {t("me.shiftNow")}{" "}
          <span className="nums">
            <Clock at={clock.shift.startsAt} />–<Clock at={clock.shift.endsAt} />
          </span>
        </p>
      ) : (
        <p className="type-body text-ink-2">{t("me.noShiftNow")}</p>
      )}
      <fetcher.Form method="post" className="flex flex-wrap items-end gap-3 stf-noprint">
        <input type="hidden" name="intent" value={open ? "clock-out" : "clock-in"} />
        <TextField name="note" label={t("me.clockNote")} optional maxLength={200} className="min-w-[12rem] flex-1" />
        <Key type="submit" variant="primary" icon={open ? "sign-out" : "sign-in"} loading={fetcher.state !== "idle"}>
          {open ? t("me.clockOut") : t("me.clockIn")}
        </Key>
      </fetcher.Form>
      {failure ? (
        <p role="alert" className="type-label text-red-ink">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

function MyCommissions({ commissions, period }: { commissions: Data["commissions"]; period: string }) {
  const t = useStaffT();
  return (
    <Section
      id="commissions"
      title={
        <>
          {t("me.commissions")} · <PeriodName period={period} />
        </>
      }
    >
      <div className="adm-card gap-2">
        <Pair label={t("me.commissionNet")}>
          <Money iqd={commissions.netIqd} />
        </Pair>
        {commissions.lines.slice(0, 6).map((line) => (
          <Pair key={line.id} label={<bdi dir="ltr">{line.orderRef}</bdi>}>
            <Money iqd={line.amountIqd} signed />
          </Pair>
        ))}
        {commissions.lines.length === 0 ? <p className="type-caption text-ink-2">{t("me.noCommissions")}</p> : null}
      </div>
    </Section>
  );
}

function MyPay({ pay }: { pay: Data["pay"] }) {
  const t = useStaffT();
  return (
    <Section id="pay" title={t("me.pay")}>
      {pay.lines.length ? (
        <ul role="list" className="grid gap-2">
          {pay.lines.map((line) => (
            <li key={line.runId} className="adm-card gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <PeriodName period={line.period} />
                <StateTag group="run" value={line.status} label={t(`runStatus.${line.status}`)} />
              </div>
              <Pair label={t("payroll.col.base")}>
                <Money iqd={line.baseIqd} />
              </Pair>
              {line.commissionIqd ? (
                <Pair label={t("payroll.col.commission")}>
                  <Money iqd={line.commissionIqd} />
                </Pair>
              ) : null}
              {line.bonusIqd ? (
                <Pair label={t("payroll.col.bonus")}>
                  <Money iqd={line.bonusIqd} />
                </Pair>
              ) : null}
              {line.advanceDeductionIqd ? (
                <Pair label={t("payroll.col.advances")}>
                  <Money iqd={-line.advanceDeductionIqd} />
                </Pair>
              ) : null}
              {line.otherDeductionIqd ? (
                <Pair label={t("payroll.col.other")}>
                  <Money iqd={-line.otherDeductionIqd} />
                </Pair>
              ) : null}
              <Pair label={t("payroll.col.net")}>
                <Money iqd={line.netIqd} className="type-strong" />
              </Pair>
              {line.paidAt ? (
                <Pair label={t("payroll.paidAt")}>
                  <When at={line.paidAt} kind="date" />
                </Pair>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t("me.noPay")}</p>
      )}
      {pay.openAdvancesIqd ? (
        <Note>
          <p>
            {t("me.openAdvances")} <Money iqd={pay.openAdvancesIqd} />
          </p>
        </Note>
      ) : null}
    </Section>
  );
}
