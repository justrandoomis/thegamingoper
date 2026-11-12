import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/employee";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { endEmployeeSession, endEmployeeSessions, getEmployeeProfile, setBaseSalary, terminateEmployee, terminationPlan, updateEmployeeProfile } from "~/server/services/admin/staff/employees.server";
import { Disclosure } from "~/ui/Disclosure";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { staffMeta } from "./meta";
import { amount, failed, int, intOrNull, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { ActionDialog, Code, DemoTag, Flag, FormDialog, Ledger, Money, Note, PageHead, Pair, PeriodName, Section, StateTag, When, tOr, useListSep, useStaffT } from "./ui";

/**
 * /admin/staff/employees/:employeeId — one employee's file: HR facts (staff.manage edits them), the pay
 * (staff.payroll.read sees it, staff.payroll.run sets the base salary — never one's own), what their roles grant
 * (15.01, read-only: the role editor is module 20's), this month at a glance, their live sessions and sign-in log, and
 * ending their access on termination (15.07: staff.manage, a reason, the impact shown first).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now, session } = await openStaff(context);
  const profile = await orRespond(() => getEmployeeProfile(db, actor, params.employeeId, locale, now, session.session.id));
  const plan = profile.can.terminate ? await terminationPlan(db, actor, profile.employee.id, now) : null;
  return { profile, plan, now };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const employeeId = params.employeeId;
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "profile":
        await updateEmployeeProfile(req.db, req.actor, { employeeId, jobTitle: optional(form, "jobTitle"), phone: optional(form, "phone"), reason: text(form, "reason"), expectedUpdatedAt: int(form, "expectedUpdatedAt") }, req.now);
        return ok(intent, { message: t("employee.profileSaved") });
      case "salary":
        await setBaseSalary(req.db, req.actor, { employeeId, baseSalaryIqd: amount(form, "baseSalaryIqd"), expectedIqd: intOrNull(form, "expectedIqd"), reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("employee.salarySaved") });
      case "end-session": {
        const result = await endEmployeeSession(req.db, req.actor, { employeeId, sessionId: text(form, "sessionId"), reason: text(form, "reason") }, req.now);
        return ok(intent, { message: result.ended ? t("employee.sessionEnded") : t("employee.sessionGone") });
      }
      case "end-all": {
        const result = await endEmployeeSessions(req.db, req.actor, { employeeId, reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("employee.sessionsEnded", { count: result.ended }) });
      }
      case "terminate": {
        const result = await terminateEmployee(req.db, req.actor, { employeeId, reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("employee.terminated", { sessions: result.sessionsEnded, shifts: result.shiftsCancelled }) });
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "employee.title", { name: args.loaderData?.profile.employee.name ?? "" });

type Profile = Route.ComponentProps["loaderData"]["profile"];
type Plan = Route.ComponentProps["loaderData"]["plan"];

export default function EmployeePage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const { profile, plan, now } = loaderData;
  const { employee } = profile;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/staff/employees" className="adm-link">
            {t("employees.title")}
          </Link>
        }
        title={employee.name}
        lead={
          <span className="inline-flex flex-wrap items-center gap-2">
            <bdi dir="ltr">{employee.email}</bdi>
            {employee.jobTitle ? <span>· {employee.jobTitle}</span> : null}
            <StateTag group="employee" value={employee.status} label={t(`employeeStatus.${employee.status}`)} />
            <DemoTag show={employee.isDemo} />
          </span>
        }
      />
      {profile.isSelf ? (
        <Note>
          <p>
            {t("employee.self")}{" "}
            <Link to="/admin/me" className="adm-link">
              {t("employee.mySecurity")}
            </Link>
          </p>
        </Note>
      ) : null}
      {employee.status === "disabled" ? (
        <Note tone="warn" icon="lock">
          <p>
            {t("employee.disabledNote")} <When at={employee.disabledAt} />
          </p>
        </Note>
      ) : null}

      <div className="stf-split mt-5">
        <div className="grid min-w-0 gap-5">
          <Permissions profile={profile} />
          <Month profile={profile} />
          {profile.sessions ? <Sessions profile={profile} now={now} /> : null}
          {profile.signIns ? <SignIns profile={profile} /> : null}
        </div>
        <aside className="grid min-w-0 gap-5">
          <HrFacts profile={profile} />
          {profile.salary ? <Pay profile={profile} /> : null}
          {employee.status === "active" && !profile.isSelf ? <EndAccess profile={profile} plan={plan} /> : null}
        </aside>
      </div>
    </>
  );
}

function Permissions({ profile }: { profile: Profile }) {
  const t = useStaffT();
  const f = useFormat();
  const sep = useListSep();
  const { permissions } = profile;
  return (
    <Section
      id="permissions"
      title={t("employee.permissions")}
      aside={
        profile.links.roleEditor ? (
          <>
            <Key as={Link} to="/admin/security/roles" size="sm" icon="shield-check">
              {t("employee.roleEditor")}
            </Key>
            {profile.links.securityPage ? (
              <Key as={Link} to={`/admin/security/staff/${profile.employee.id}`} size="sm" icon="user-gear">
                {t("employee.changeRoles")}
              </Key>
            ) : null}
          </>
        ) : null
      }
    >
      <div className="adm-card gap-3">
        <Pair label={t("employee.roles")}>{profile.employee.roles.length ? profile.employee.roles.map((role) => role.name).join(sep) : t("employees.noRole")}</Pair>
        <Pair label={t("employee.permissionCount")}>{permissions.all ? t("employee.allPermissions") : f.number(permissions.count)}</Pair>
        <Pair label={t("employee.protectedData")}>
          {permissions.field.length ? (
            <span className="inline-flex flex-wrap justify-end gap-1">
              {permissions.field.map((key) => (
                <Flag key={key} icon="lock">
                  {t(`fields.${key.replace(/\./g, "_")}`)}
                </Flag>
              ))}
            </span>
          ) : (
            t("employee.noProtected")
          )}
        </Pair>
        <p className="type-caption text-ink-2">{t("employee.readOnly")}</p>
      </div>
      {permissions.groups.length ? (
        <div className="grid gap-1">
          {permissions.groups.map((group) => (
            <Disclosure key={group.key} variant="row" summary={`${group.module ? `${group.module} · ` : ""}${group.label} (${f.number(group.permissions.length)})`}>
              <ul role="list" className="grid gap-1 py-2">
                {group.permissions.map((permission) => (
                  <li key={permission.key} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="inline-flex items-center gap-1">
                      {permission.label}
                      {permission.field ? <Flag icon="lock">{t("employee.protected")}</Flag> : null}
                    </span>
                    <span className="type-caption text-ink-2">
                      <Code>{permission.key}</Code> · {permission.roles.join(sep)}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ))}
        </div>
      ) : (
        <p className="type-body text-ink-2">{t("employee.noPermissions")}</p>
      )}
    </Section>
  );
}

function Month({ profile }: { profile: Profile }) {
  const t = useStaffT();
  const f = useFormat();
  const { month, employee } = profile;
  return (
    <Section
      id="month"
      title={
        <>
          {t("employee.month")} · <PeriodName period={month.period} />
        </>
      }
    >
      <div className="adm-card">
        <Ledger
          rows={[
            { label: t("employee.shifts"), value: f.number(month.shifts) },
            { label: t("employee.attended"), value: f.number(month.attended) },
            { label: t("employee.late"), value: f.number(month.late) },
            { label: t("employee.leaveDays"), value: f.number(month.leaveDays) },
            { label: t("employee.openTasks"), value: f.number(month.openTasks) },
          ]}
        />
        <div className="flex flex-wrap gap-2 pt-2 stf-noprint">
          <Link to={`/admin/staff/schedule?employee=${employee.id}`} className="adm-link type-label">
            {t("employee.seeSchedule")}
          </Link>
          <Link to={`/admin/staff/attendance?employee=${employee.id}`} className="adm-link type-label">
            {t("employee.seeAttendance")}
          </Link>
          <Link to={`/admin/staff/tasks?assignee=${employee.id}`} className="adm-link type-label">
            {t("employee.seeTasks")}
          </Link>
        </div>
      </div>
    </Section>
  );
}

function Sessions({ profile, now }: { profile: Profile; now: number }) {
  const t = useStaffT();
  const f = useFormat();
  const [ending, setEnding] = useState<string | "all" | null>(null);
  const sessions = profile.sessions ?? [];
  const target = sessions.find((session) => session.id === ending);
  return (
    <Section
      id="sessions"
      title={t("employee.sessions")}
      aside={
        profile.can.revoke && sessions.length ? (
          <Key size="sm" icon="sign-out" onClick={() => setEnding("all")}>
            {t("employee.endAll")}
          </Key>
        ) : null
      }
    >
      {sessions.length ? (
        <ul role="list" className="grid gap-2">
          {sessions.map((session) => (
            <li key={session.id} className="adm-card gap-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="type-strong">
                  {[session.browser, session.system].filter(Boolean).join(" · ") || t("employee.unknownDevice")}
                  {session.current ? <span className="type-caption text-ink-2"> · {t("employee.thisDevice")}</span> : null}
                </span>
                <Status tone={session.mfaOk ? "ok" : "warn"}>{session.mfaOk ? t("employee.fullySignedIn") : t("employee.halfOpen")}</Status>
              </div>
              <Pair label={t("employee.lastSeen")}>{f.relative(session.lastSeenAt, now)}</Pair>
              <Pair label={t("employee.started")}>
                <When at={session.createdAt} />
              </Pair>
              <Pair label={t("employee.ip")}>{session.ip ? <Code>{session.ip}</Code> : "—"}</Pair>
              {profile.can.revoke && !session.current ? (
                <div className="stf-noprint">
                  <Key size="sm" variant="ghost" icon="x" onClick={() => setEnding(session.id)}>
                    {t("employee.endSession")}
                  </Key>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t("employee.noSessions")}</p>
      )}
      {!profile.can.revoke && sessions.length ? <p className="type-caption text-ink-2">{t("employee.revokeNeeds")}</p> : null}
      <ActionDialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        tone="destructive"
        title={ending === "all" ? t("employee.endAllQ", { name: profile.employee.name }) : t("employee.endSessionQ")}
        consequence={ending === "all" ? t("employee.endAllWhat", { count: sessions.length }) : t("employee.endSessionWhat", { device: [target?.browser, target?.system].filter(Boolean).join(" · ") || t("employee.unknownDevice") })}
        confirmLabel={ending === "all" ? t("employee.endAll") : t("employee.endSession")}
        reason
        fields={ending === "all" ? { intent: "end-all" } : { intent: "end-session", sessionId: ending ?? "" }}
        successMessage={t("employee.sessionEnded")}
      />
    </Section>
  );
}

function SignIns({ profile }: { profile: Profile }) {
  const t = useStaffT();
  const events = profile.signIns ?? [];
  return (
    <Section id="signins" title={t("employee.signIns")}>
      {events.length ? (
        <div className="adm-card">
          <ul role="list" className="grid gap-2">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-b-0 last:pb-0">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Status tone={event.success ? "ok" : "bad"}>{tOr(t, `signin.kind.${event.kind}`, event.kind)}</Status>
                  {event.reason ? <span className="type-caption text-ink-2">{tOr(t, `signin.reason.${event.reason}`, event.reason)}</span> : null}
                </span>
                <span className="type-caption text-ink-2">
                  <When at={event.at} />
                  {event.ip ? (
                    <>
                      {" "}
                      · <Code>{event.ip}</Code>
                    </>
                  ) : null}
                  {event.browser ? ` · ${event.browser}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="type-body text-ink-2">{t("employee.noSignIns")}</p>
      )}
    </Section>
  );
}

function HrFacts({ profile }: { profile: Profile }) {
  const t = useStaffT();
  const [editing, setEditing] = useState(false);
  const { employee } = profile;
  return (
    <Section
      id="facts"
      title={t("employee.facts")}
      aside={
        profile.can.editProfile ? (
          <Key size="sm" icon="pencil-simple" onClick={() => setEditing(true)}>
            {t("common.edit")}
          </Key>
        ) : null
      }
    >
      <div className="adm-card gap-2">
        <Pair label={t("employees.col.jobTitle")}>{employee.jobTitle ?? "—"}</Pair>
        <Pair label={t("employee.phone")}>{employee.phone ? <bdi dir="ltr">{employee.phone}</bdi> : "—"}</Pair>
        <Pair label={t("employees.col.branch")}>{employee.branch ?? t("employees.allBranches")}</Pair>
        <Pair label={t("employee.since")}>
          <When at={employee.createdAt} kind="date" />
        </Pair>
        <Pair label={t("employees.col.lastLogin")}>
          <When at={employee.lastLoginAt} />
        </Pair>
        <Pair label={t("employee.twoStep")}>
          <Status tone={employee.twoStep ? "ok" : "warn"}>{employee.twoStep ? t("employee.twoStepOn") : t("employee.twoStepOff")}</Status>
        </Pair>
      </div>
      {editing ? (
        <FormDialog title={t("employee.editFacts")} submitLabel={t("employee.saveFacts")} onClose={() => setEditing(false)} successMessage={t("employee.profileSaved")} hidden={{ intent: "profile", expectedUpdatedAt: String(employee.updatedAt) }}>
          {(fields) => (
            <>
              <TextField name="jobTitle" label={t("employees.col.jobTitle")} defaultValue={employee.jobTitle ?? ""} maxLength={80} error={fields.jobTitle} />
              <TextField name="phone" type="tel" label={t("employee.phone")} defaultValue={employee.phone ?? ""} maxLength={30} ltr error={fields.phone} />
              <TextField name="reason" label={t("common.reason")} required minLength={3} maxLength={500} error={fields.reason} />
            </>
          )}
        </FormDialog>
      ) : null}
    </Section>
  );
}

function Pay({ profile }: { profile: Profile }) {
  const t = useStaffT();
  const [editing, setEditing] = useState(false);
  const salary = profile.salary!;
  return (
    <Section
      id="pay"
      title={t("employee.pay")}
      aside={
        profile.can.setSalary ? (
          <Key size="sm" icon="pencil-simple" onClick={() => setEditing(true)}>
            {t("employee.setSalary")}
          </Key>
        ) : null
      }
    >
      <div className="adm-card gap-2">
        <Pair label={t("employee.baseSalary")}>{salary.baseSalaryIqd === null ? t("employee.noSalary") : <Money iqd={salary.baseSalaryIqd} />}</Pair>
        <Pair label={t("employee.salaryChanged")}>{salary.changedAt ? <span>{salary.changedBy ? `${salary.changedBy} · ` : ""}<When at={salary.changedAt} kind="date" /></span> : "—"}</Pair>
        <Pair label={t("employee.openAdvances")}>
          <Money iqd={salary.openAdvancesIqd} />
        </Pair>
        {salary.pendingAdvancesIqd ? (
          <Pair label={t("employee.pendingAdvances")}>
            <Money iqd={salary.pendingAdvancesIqd} />
          </Pair>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1 stf-noprint">
          <Link to={`/admin/staff/payroll/advances?employee=${profile.employee.id}`} className="adm-link type-label">
            {t("employee.seeAdvances")}
          </Link>
          <Link to={`/admin/staff/commissions?employee=${profile.employee.id}`} className="adm-link type-label">
            {t("employee.seeCommissions")}
          </Link>
        </div>
        {profile.isSelf ? <p className="type-caption text-ink-2">{t("employee.ownSalary")}</p> : null}
      </div>
      {editing ? (
        <FormDialog title={t("employee.setSalaryQ", { name: profile.employee.name })} description={t("employee.setSalaryWhat")} submitLabel={t("employee.saveSalary")} onClose={() => setEditing(false)} successMessage={t("employee.salarySaved")} hidden={{ intent: "salary", expectedIqd: salary.baseSalaryIqd === null ? "null" : String(salary.baseSalaryIqd) }}>
          {(fields) => (
            <>
              <TextField name="baseSalaryIqd" label={t("employee.baseSalaryField")} hint={t("employee.baseSalaryHint")} inputMode="numeric" defaultValue={salary.baseSalaryIqd === null ? "" : String(salary.baseSalaryIqd)} ltr error={fields.baseSalaryIqd} />
              <TextField name="reason" label={t("common.reason")} required minLength={3} maxLength={500} error={fields.reason} />
            </>
          )}
        </FormDialog>
      ) : null}
    </Section>
  );
}

function EndAccess({ profile, plan }: { profile: Profile; plan: Plan }) {
  const t = useStaffT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  if (!profile.can.terminate || !plan) {
    if (!profile.outranked) return null;
    return (
      <Section id="end" title={t("employee.endAccess")}>
        <Note>
          <p>{t("employee.outranked")}</p>
        </Note>
      </Section>
    );
  }
  return (
    <Section id="end" title={t("employee.endAccess")}>
      <div className="adm-card gap-2">
        <p className="type-body text-ink-2">{t("employee.endAccessLead")}</p>
        <div className="stf-noprint">
          <Key variant="danger" icon="lock" onClick={() => setOpen(true)}>
            {t("employee.endAccessKey")}
          </Key>
        </div>
      </div>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("employee.endAccessQ", { name: profile.employee.name })}
        consequence={t("employee.endAccessWhat")}
        confirmLabel={t("employee.endAccessKey")}
        impact={[
          { label: t("employee.impactSessions"), value: f.number(plan.liveSessions), negative: plan.liveSessions > 0 },
          { label: t("employee.impactShifts"), value: f.number(plan.futureShifts), negative: plan.futureShifts > 0 },
          { label: t("employee.impactLeave"), value: f.number(plan.pendingLeave) },
          { label: t("employee.impactTasks"), value: f.number(plan.openTasks) },
          { label: t("employee.impactRequests"), value: f.number(plan.pendingRequests) },
          ...(plan.openAdvancesIqd !== null ? [{ label: t("employee.impactAdvances"), value: <Money iqd={plan.openAdvancesIqd} /> }] : []),
        ]}
        reason={{ minLength: 3, hint: t("employee.endAccessReasonHint") }}
        fields={{ intent: "terminate" }}
        successMessage={t("employee.terminatedShort")}
      />
    </Section>
  );
}
