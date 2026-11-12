import { Link } from "react-router";

import type { Route } from "./+types/home";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { canAny } from "~/server/actor";
import { staffDecisions } from "~/server/services/admin/staff/approvals.server";
import { staffOverview } from "~/server/services/admin/staff/overview.server";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { staffMeta } from "./meta";
import { openStaff, orRespond } from "./staff.server";
import { Clock, DecisionCard, Kpi, Money, Note, PageHead, PeriodName, Section, useStaffLayout, useStaffT } from "./ui";

/**
 * /admin/staff — the module's front page: what waits for this employee's decision in the module (raised cards), the
 * team at a glance (each figure only for who may open the page behind it), the sections, honest limits and the status
 * of the module's seven blueprint functions.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openStaff(context);
  const [overview, decisions] = await Promise.all([orRespond(() => staffOverview(db, actor, now)), staffDecisions(db, actor)]);
  // module 06's shift list opens with these permissions only: a link nobody else can follow is plain text
  return { overview, decisions, now, links: { posShifts: canAny(actor, ["pos.shift.review", "pos.shift.open", "pos.shift.close"]) } };
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "home.title");

export default function StaffHome({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const locale = useLocale();
  const layout = useStaffLayout();
  const access = layout?.access;
  const { overview, decisions } = loaderData;
  const blueprint = blueprintModule("15");
  const leave = decisions.filter((item) => item.kind === "leave");
  const runs = decisions.filter((item) => item.kind === "payroll_run");
  const sections: { to: string; icon: IconName; label: string; show: boolean }[] = [
    { to: "/admin/staff/me", icon: "user", label: t("nav.me"), show: true },
    { to: "/admin/staff/approvals", icon: "bell-ringing", label: t("nav.approvals"), show: true },
    { to: "/admin/staff/employees", icon: "users", label: t("nav.employees"), show: Boolean(access?.directory) },
    { to: "/admin/staff/schedule", icon: "calendar", label: t("nav.schedule"), show: Boolean(access?.roster) },
    { to: "/admin/staff/attendance", icon: "clock", label: t("nav.attendance"), show: Boolean(access?.attendanceView) },
    { to: "/admin/staff/leave", icon: "calendar-blank", label: t("nav.leave"), show: Boolean(access?.leaveView) },
    { to: "/admin/staff/tasks", icon: "kanban", label: t("nav.tasks"), show: true },
    { to: "/admin/staff/commissions", icon: "hand-coins", label: t("nav.commissions"), show: Boolean(access?.commissionView) },
    { to: "/admin/staff/payroll", icon: "money", label: t("nav.payroll"), show: Boolean(access?.payrollView) },
    { to: "/admin/staff/performance", icon: "chart-bar", label: t("nav.performance"), show: Boolean(access?.performance) },
  ];
  return (
    <>
      <PageHead eyebrow={t("home.eyebrow", { id: blueprint?.id ?? "15" })} title={blueprint ? blueprint[locale === "en" ? "en" : "ar"] : t("home.title")} lead={t("home.lead")} />

      {leave.length || runs.length || (overview.payroll?.advancesPending ?? 0) > 0 ? (
        <Section id="decide" title={t("home.decide")}>
          <ul role="list" className="adm-grid">
            {leave.length ? <DecisionCard icon="calendar-blank" title={t("home.leaveWaiting", { count: leave.length })} text={t("home.leaveWaitingText")} to="/admin/staff/leave" action={t("home.openLeave")} /> : null}
            {runs.map((run) => (
              <DecisionCard key={run.id} icon="money" title={t("home.runWaiting", { ref: run.label })} text={t("home.runWaitingText")} to={run.href} action={t("home.openRun")} />
            ))}
            {(overview.payroll?.advancesPending ?? 0) > 0 && access?.payrollApprove ? (
              <DecisionCard icon="hand-coins" title={t("home.advancesWaiting", { count: overview.payroll?.advancesPending ?? 0 })} text={t("home.advancesWaitingText")} to="/admin/staff/payroll/advances?status=pending" action={t("home.openAdvances")} />
            ) : null}
          </ul>
        </Section>
      ) : null}

      <Section id="glance" title={t("home.glance")}>
        <div className="stf-kpis">
          <Kpi
            icon="clock"
            label={t("home.myClock")}
            value={overview.me.clockedInSince ? <Clock at={overview.me.clockedInSince} /> : "—"}
            hint={overview.me.clockedInSince ? t("home.clockedInSince") : t("home.notClockedIn")}
            to="/admin/staff/me"
          />
          {overview.staff ? <Kpi icon="users" label={t("home.active")} value={f.number(overview.staff.active)} hint={t("home.disabled", { count: overview.staff.disabled })} to="/admin/staff/employees" /> : null}
          {overview.today ? <Kpi icon="calendar" label={t("home.shiftsToday")} value={f.number(overview.today.shifts)} hint={t("home.clockedInNow", { count: overview.today.clockedIn })} to="/admin/staff/schedule" /> : null}
          {overview.today ? <Kpi icon="calendar-blank" label={t("home.onLeave")} value={f.number(overview.today.onLeave)} to="/admin/staff/leave?status=approved" /> : null}
          <Kpi icon="kanban" label={access?.tasksView ? t("home.tasksOpen") : t("home.tasksMine")} value={f.number(overview.tasks.open)} hint={overview.tasks.overdue ? t("home.tasksOverdue", { count: overview.tasks.overdue }) : undefined} to="/admin/staff/tasks" />
          {overview.commissions ? (
            <Kpi
              icon="hand-coins"
              label={
                <>
                  {t("home.commissions")} · <PeriodName period={overview.commissions.period} />
                </>
              }
              value={<Money iqd={overview.commissions.netIqd} />}
              hint={t("home.commissionsAccrued", { amount: f.iqd(overview.commissions.accruedIqd) })}
              to="/admin/staff/commissions"
            />
          ) : null}
          {overview.payroll && access?.payrollView ? <Kpi icon="money" label={t("home.runs")} value={f.number(overview.payroll.drafts + overview.payroll.approved)} hint={t("home.runsHint", { drafts: overview.payroll.drafts, approved: overview.payroll.approved })} to="/admin/staff/payroll" /> : null}
        </div>
      </Section>

      <Section id="sections" title={t("home.sections")}>
        <ul role="list" className="adm-grid">
          {sections
            .filter((item) => item.show)
            .map((item) => (
              <li key={item.to}>
                <Link to={item.to} prefetch="intent" className="adm-module-link">
                  <Icon name={item.icon} size={20} />
                  <span className="type-label">{item.label}</span>
                </Link>
              </li>
            ))}
        </ul>
      </Section>

      <Section id="limits" title={t("home.limits")}>
        <div className="grid gap-2">
          <Note>
            <p>{t("home.limitAccounts")}</p>
          </Note>
          <Note>
            <p>
              {t("home.limitPosShifts")}{" "}
              {loaderData.links.posShifts ? (
                <Link to="/admin/pos/shifts" className="adm-link">
                  {t("home.posShifts")}
                </Link>
              ) : (
                t("home.posShifts")
              )}
            </p>
          </Note>
          <Note>
            <p>{t("home.limitBooks")}</p>
          </Note>
        </div>
      </Section>

      <ModuleFunctions moduleId="15" />
    </>
  );
}
