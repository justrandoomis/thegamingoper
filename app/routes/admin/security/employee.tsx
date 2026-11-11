import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/employee";
import { useFormat } from "~/i18n/react";
import { getAdminSession } from "../shell/gate.server";
import { endAllStaffSessions, endStaffSession, getStaffSecurity, resetStaffTwoStep } from "~/server/services/admin/security/staff.server";
import { setEmployeeBranch, setEmployeeRoles } from "~/server/services/admin/security/roles.server";
import { FIELD_KEYS, type SessionView } from "~/server/services/admin/security/types";
import { invalid } from "~/server/errors";
import { Checkbox, Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, Code, Fact, Note, PageHead, Pair, Section, When, tOr, useListSep, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { ok, text } from "./route-kit.server";
import { sec } from "./security.server";

/**
 * /admin/security/staff/:employeeId — 20.01 and 20.02 for one employee: their sessions (end one or all, with a
 * reason), resetting their two-step verification (lost phone: they are signed out everywhere and enrol again), their
 * roles and the branch they are limited to (staff.manage; never one's own), what their roles grant (the protected-data
 * permissions named), and their latest sign-in events. One's own account is /admin/me.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await sec.open(context, "security.session.read");
  const session = getAdminSession(context);
  return { detail: await sec.orRespond(() => getStaffSecurity(db, actor, params.employeeId, locale, now, session.session.id)), now };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await sec.open(context, "security.session.read");
  const form = await request.formData();
  const intent = text(form, "intent");
  const employeeId = params.employeeId;
  try {
    switch (intent) {
      case "end-session":
        return ok(intent, await endStaffSession(req.db, req.actor, { employeeId, sessionId: text(form, "sessionId"), reason: text(form, "reason") }, req.now));
      case "end-all":
        return ok(intent, await endAllStaffSessions(req.db, req.actor, { employeeId, reason: text(form, "reason") }, req.now));
      case "reset-two-step":
        return ok(intent, await resetStaffTwoStep(req.db, req.actor, { employeeId, reason: text(form, "reason") }, req.now));
      case "roles":
        return ok(intent, await setEmployeeRoles(req.db, req.actor, { employeeId, roleIds: text(form, "roleIds").split(",").filter(Boolean), expected: text(form, "expected"), reason: text(form, "reason") }, req.now));
      case "branch":
        return ok(intent, await setEmployeeBranch(req.db, req.actor, { employeeId, branchId: text(form, "branchId") || null, reason: text(form, "reason") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return sec.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "employee.title", { name: args.loaderData?.detail.employee.name ?? "" });

type Detail = Route.ComponentProps["loaderData"]["detail"];

export default function EmployeePage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const { detail, now } = loaderData;
  const { employee } = detail;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/security/staff" className="adm-link">
            {t("staff.title")}
          </Link>
        }
        title={employee.name}
        lead={
          <>
            <bdi dir="ltr">{employee.email}</bdi>
            {employee.jobTitle ? ` · ${employee.jobTitle}` : ""}
          </>
        }
        actions={
          <>
            <Key as={Link} to={`/admin/security/audit?actor=${encodeURIComponent(employee.id)}`} size="sm" icon="clipboard-text">
              {t("employee.theirChanges")}
            </Key>
          </>
        }
      />
      {detail.isSelf ? (
        <Note>
          <p>
            {t("employee.self")}{" "}
            <Link to="/admin/me" className="adm-link">
              {t("employee.mySecurity")}
            </Link>
          </p>
        </Note>
      ) : null}

      <div className="sec-split mt-5">
        <div className="grid min-w-0 gap-5">
          <Sessions detail={detail} now={now} />
          <Roles detail={detail} />
          {detail.events.length ? <Events detail={detail} /> : null}
        </div>
        <aside className="grid min-w-0 gap-5">
          <Account detail={detail} />
          <Branch detail={detail} />
        </aside>
      </div>
    </>
  );
}

function Account({ detail }: { detail: Detail }) {
  const t = useModuleT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const { employee } = detail;
  return (
    <Section id="account" title={t("employee.account")}>
      <div className="adm-card gap-2">
        <Pair label={t("staff.col.status")}>
          <Status tone={employee.status === "active" ? "ok" : "bad"}>{t(`staff.status.${employee.status}`)}</Status>
        </Pair>
        <Pair label={t("staff.col.twoStep")}>
          <Status tone={employee.twoStep ? "ok" : "warn"}>{employee.twoStep ? t("staff.twoStepOn") : t("staff.twoStepOff")}</Status>
        </Pair>
        <Pair label={t("staff.col.lastLogin")}>
          <When at={employee.lastLoginAt} />
        </Pair>
        <Pair label={t("employee.passwordChanged")}>
          <When at={employee.passwordChangedAt} />
        </Pair>
        <Pair label={t("employee.permissions")}>{detail.permissions.all ? t("employee.allPermissions") : f.number(detail.permissions.count)}</Pair>
        <div className="grid gap-1">
          <span className="type-caption text-ink-2">{t("employee.protected")}</span>
          {detail.permissions.field.length ? (
            <ul role="list" className="flex flex-wrap gap-1">
              {detail.permissions.field.map((permission) => (
                <li key={permission}>
                  <Status tone="info">{t(`field.${permission.replace(/\./g, "_")}`)}</Status>
                </li>
              ))}
            </ul>
          ) : (
            <span className="type-caption">{t("employee.noProtected")}</span>
          )}
        </div>
        {detail.can.resetTwoStep ? (
          <div>
            <Key size="sm" icon="key" onClick={() => setOpen(true)}>
              {t("employee.resetTwoStep")}
            </Key>
          </div>
        ) : null}
        {!employee.twoStep && !detail.isSelf ? <p className="type-caption text-ink-2">{t("employee.noTwoStepHint")}</p> : null}
        {detail.outranked ? <p className="type-caption text-ink-2">{t("employee.outranked")}</p> : null}
      </div>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("employee.resetTitle", { name: employee.name })}
        consequence={t("employee.resetConsequence")}
        confirmLabel={t("employee.resetTwoStep")}
        impact={[
          { label: t("employee.impactSessions"), value: f.number(detail.sessions.length), negative: true },
          { label: t("employee.impactNext"), value: t("employee.impactPasswordOnly") },
        ]}
        reason={{ label: t("common.reason"), hint: t("employee.resetHint") }}
        fields={{ intent: "reset-two-step" }}
        successMessage={t("employee.resetDone")}
      />
    </Section>
  );
}

function deviceName(session: SessionView, unknown: string) {
  return [session.browser, session.system].filter(Boolean).join(" · ") || unknown;
}

function Sessions({ detail, now }: { detail: Detail; now: number }) {
  const t = useModuleT();
  const f = useFormat();
  const [target, setTarget] = useState<SessionView | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const { sessions } = detail;
  return (
    <Section
      id="sessions"
      title={t("employee.sessions", { count: sessions.length })}
      aside={
        detail.can.revoke && sessions.length > 0 ? (
          <Key size="sm" icon="sign-out" onClick={() => setAllOpen(true)}>
            {t("employee.endAll")}
          </Key>
        ) : undefined
      }
    >
      {sessions.length === 0 ? (
        <p className="type-body text-ink-2">{t("employee.noSessions")}</p>
      ) : (
        <ul role="list" className="grid gap-2">
          {sessions.map((session) => (
            <li key={session.id} className="adm-card gap-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="type-strong">{deviceName(session, t("employee.unknownDevice"))}</span>
                <span className="flex flex-wrap gap-1">
                  {session.current ? <Status tone="ok">{t("employee.thisDevice")}</Status> : null}
                  {/* the code is asked only of an employee with two-step on; without it a session never passes that step */}
                  {detail.employee.twoStep && !session.mfaOk ? <Status tone="warn">{t("employee.halfOpen")}</Status> : null}
                </span>
              </div>
              <Pair label={t("employee.address")}>{session.ip ? <Code>{session.ip}</Code> : "—"}</Pair>
              <Pair label={t("employee.started")}>
                <When at={session.createdAt} />
              </Pair>
              <Pair label={t("employee.lastSeen")}>
                <span className="nums">{f.relative(session.lastSeenAt, now)}</span>
              </Pair>
              {detail.can.revoke && !session.current ? (
                <div>
                  <Key size="sm" onClick={() => setTarget(session)} aria-label={t("employee.endNamed", { device: deviceName(session, t("employee.unknownDevice")) })}>
                    {t("employee.end")}
                  </Key>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="type-caption text-ink-2">{t("employee.sessionsNote")}</p>
      <ActionDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        tone="destructive"
        title={t("employee.endTitle")}
        consequence={t("employee.endConsequence", { name: detail.employee.name })}
        confirmLabel={t("employee.end")}
        impact={target ? [{ label: t("employee.device"), value: deviceName(target, t("employee.unknownDevice")) }, { label: t("employee.address"), value: target.ip ?? "—" }] : undefined}
        reason={{ label: t("common.reason"), hint: t("employee.endHint") }}
        fields={{ intent: "end-session", sessionId: target?.id ?? "" }}
        successMessage={(data) => (data.ended ? t("employee.ended") : t("employee.alreadyEnded"))}
      />
      <ActionDialog
        open={allOpen}
        onClose={() => setAllOpen(false)}
        tone="destructive"
        title={t("employee.endAllTitle", { name: detail.employee.name })}
        consequence={t("employee.endAllConsequence")}
        confirmLabel={t("employee.endAll")}
        impact={[{ label: t("employee.impactSessions"), value: f.number(sessions.length), negative: true }]}
        reason={{ label: t("common.reason"), hint: t("employee.endHint") }}
        fields={{ intent: "end-all" }}
        successMessage={t("employee.endedAll")}
      />
    </Section>
  );
}

const expand = (stored: readonly string[]) => new Set(stored);

function Roles({ detail }: { detail: Detail }) {
  const t = useModuleT();
  const sep = useListSep();
  const f = useFormat();
  const current = useMemo(() => detail.roles.map((role) => role.id).sort(), [detail.roles]);
  const [chosen, setChosen] = useState<string[]>(current);
  const [open, setOpen] = useState(false);
  const allRoles = detail.allRoles;
  const impact = useMemo(() => {
    if (!allRoles) return null;
    const grantsOf = (ids: readonly string[]) => expand(allRoles.filter((role) => ids.includes(role.id)).flatMap((role) => role.permissions));
    const before = grantsOf(current);
    const after = grantsOf(chosen);
    const wildcard = before.has("*") || after.has("*");
    return {
      added: allRoles.filter((role) => chosen.includes(role.id) && !current.includes(role.id)).map((role) => role.name),
      removed: allRoles.filter((role) => current.includes(role.id) && !chosen.includes(role.id)).map((role) => role.name),
      gained: wildcard ? null : [...after].filter((p) => !before.has(p)).length,
      lost: wildcard ? null : [...before].filter((p) => !after.has(p)).length,
      field: FIELD_KEYS.filter((p) => after.has(p) !== before.has(p) || (wildcard && before.has("*") !== after.has("*"))),
      wildcard,
    };
  }, [allRoles, chosen, current]);
  const changed = chosen.slice().sort().join(",") !== current.join(",");
  return (
    <Section id="roles" title={t("employee.roles")}>
      {detail.roles.length ? (
        <ul role="list" className="flex flex-wrap gap-1">
          {detail.roles.map((role) => (
            <li key={role.id}>
              <Link to={`/admin/security/roles/${role.id}`} className="adm-link">
                {role.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t("staff.noRole")}</p>
      )}
      {detail.can.assignRoles && allRoles ? (
        <form
          className="adm-card gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed) setOpen(true);
          }}
        >
          <fieldset className="grid gap-1">
            <legend className="type-label">{t("employee.chooseRoles")}</legend>
            {allRoles.map((role) =>
              // a role is given or taken only by someone who holds all it grants (the server refuses the rest): the
              // others are shown as facts, so who holds what stays readable
              role.assignable ? (
                <Checkbox
                  key={role.id}
                  name="roleId"
                  value={role.id}
                  label={role.name}
                  checked={chosen.includes(role.id)}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    setChosen((list) => (on ? [...list, role.id] : list.filter((id) => id !== role.id)));
                  }}
                />
              ) : (
                <Fact key={role.id} held={chosen.includes(role.id)} label={role.name} />
              ),
            )}
          </fieldset>
          {allRoles.some((role) => !role.assignable) ? <p className="type-caption text-ink-2">{t("employee.notAssignable")}</p> : null}
          <div>
            <Key type="submit" size="sm" disabled={!changed}>
              {t("employee.saveRoles")}
            </Key>
          </div>
        </form>
      ) : detail.allRoles === null ? null : (
        <p className="type-caption text-ink-2">{t("employee.ownRoles")}</p>
      )}
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("employee.rolesTitle", { name: detail.employee.name })}
        consequence={t("employee.rolesConsequence")}
        confirmLabel={t("employee.saveRoles")}
        impact={
          impact
            ? [
                { label: t("employee.rolesAdded"), value: impact.added.join(sep) || "—" },
                { label: t("employee.rolesRemoved"), value: impact.removed.join(sep) || "—", negative: impact.removed.length > 0 },
                { label: t("employee.permsGained"), value: impact.gained === null ? t("employee.allPermissions") : f.number(impact.gained) },
                { label: t("employee.permsLost"), value: impact.lost === null ? t("employee.allPermissions") : f.number(impact.lost), negative: (impact.lost ?? 0) > 0 },
                { label: t("employee.fieldChanged"), value: impact.field.length ? impact.field.map((p) => t(`field.${p.replace(/\./g, "_")}`)).join(sep) : "—" },
              ]
            : undefined
        }
        reason={{ label: t("common.reason"), hint: t("employee.rolesHint") }}
        fields={{ intent: "roles", expected: current.join(","), roleIds: [...chosen].sort().join(",") }}
        successMessage={t("employee.rolesDone")}
      />
    </Section>
  );
}

function Branch({ detail }: { detail: Detail }) {
  const t = useModuleT();
  const [value, setValue] = useState(detail.employee.branch?.id ?? "");
  const [open, setOpen] = useState(false);
  if (!detail.can.setBranch) {
    return (
      <Section id="branch" title={t("employee.branch")}>
        <p className="type-body">{detail.employee.branch?.name ?? t("employee.allBranches")}</p>
      </Section>
    );
  }
  const branches = detail.branches ?? [];
  return (
    <Section id="branch" title={t("employee.branch")}>
      <div className="adm-card gap-2">
        <p className="type-body">{detail.employee.branch?.name ?? t("employee.allBranches")}</p>
        {branches.length === 0 ? (
          <p className="type-caption text-ink-2">{t("employee.noBranches")}</p>
        ) : (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (value !== (detail.employee.branch?.id ?? "")) setOpen(true);
            }}
          >
            <Select label={t("employee.branchLimit")} value={value} onChange={(event) => setValue(event.currentTarget.value)} options={[{ value: "", label: t("employee.allBranches") }, ...branches.map((branch) => ({ value: branch.id, label: branch.name }))]} />
            <div>
              <Key type="submit" size="sm" disabled={value === (detail.employee.branch?.id ?? "")}>
                {t("employee.saveBranch")}
              </Key>
            </div>
          </form>
        )}
      </div>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("employee.branchTitle")}
        consequence={t("employee.branchConsequence")}
        confirmLabel={t("employee.saveBranch")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "branch", branchId: value }}
        successMessage={t("employee.branchDone")}
      />
    </Section>
  );
}

function Events({ detail }: { detail: Detail }) {
  const t = useModuleT();
  return (
    <Section
      id="events"
      title={t("employee.events")}
      aside={
        <Link to={`/admin/security/sign-ins?window=30d&q=${encodeURIComponent(detail.employee.email)}`} className="adm-link type-label">
          {t("employee.allEvents")}
        </Link>
      }
    >
      <ul role="list" className="grid gap-1">
        {detail.events.map((event) => (
          <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1">
            <span>
              <Status tone={event.success ? "ok" : "warn"}>{tOr(t, `kind.${event.kind}`, event.kind)}</Status> {event.reason ? <span className="type-caption text-ink-2">{tOr(t, `reason.${event.reason}`, event.reason)}</span> : null}
            </span>
            <span className="type-caption text-ink-2">
              {event.ip ? <Code>{event.ip}</Code> : null} · <When at={event.at} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
