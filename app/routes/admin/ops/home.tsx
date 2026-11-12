import type { Route } from "./+types/home";
import { useFormat } from "~/i18n/react";
import { opsOverview } from "~/server/services/admin/ops/overview.server";
import { ModuleFunctions } from "../blueprint-status";
import { Ago, DecisionCard, Kpi, Note, PageHead, Section, When, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ops } from "./ops.server";

/**
 * /admin/ops — the module's front page: what waits for a person (raised cards only for decisions: jobs that fail, are
 * late or stuck; critical findings nobody has; my incidents past their target date; open errors; a restore test that is
 * due), the figures of each part this employee may see, the honest limits, and the status of the six blueprint
 * functions.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args);
  return { overview: await ops.orRespond(req, () => opsOverview(req.db, req.actor, req.now)), now: req.now };
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, null);

export default function OpsHome({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { overview, now } = loaderData;
  const { access, jobs, outbox, findings, incidents, errors, performance, backups } = overview;
  const decisions = [
    { key: "jobs", icon: "warning" as const, count: jobs?.attention.length ?? 0, to: "/admin/ops/jobs?view=attention#ops-jobs", show: access.jobs },
    { key: "findings", icon: "scales" as const, count: findings?.unassignedCritical ?? 0, to: "/admin/ops/consistency?severity=critical&assignee=none", show: access.resolveFindings },
    // the count is what its link lists: every open incident past its date (a manager may act on any of them)
    { key: "incidents", icon: "first-aid-kit" as const, count: incidents?.overdue ?? 0, to: "/admin/ops/incidents?view=overdue", show: access.manageIncidents },
    { key: "errors", icon: "bug" as const, count: errors?.open ?? 0, to: "/admin/ops/errors", show: access.resolveErrors },
    { key: "restore", icon: "database" as const, count: backups?.restore.due ? 1 : 0, to: backups?.canRecord ? "/admin/security/backups" : "/admin/ops/backups", show: access.backups },
  ].filter((entry) => entry.show && entry.count > 0);

  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />

      <Section id="ops-waiting" title={t("home.waiting")}>
        {decisions.length ? (
          <ul role="list" className="ops-decisions">
            {decisions.map((entry) => (
              <DecisionCard key={entry.key} icon={entry.icon} title={t(`home.decision.${entry.key}.title`)} count={entry.key === "restore" ? null : entry.count} text={t(`home.decision.${entry.key}.text`)} to={entry.to} action={t(`home.decision.${entry.key}.action`)} />
            ))}
          </ul>
        ) : (
          <p className="type-body text-ink-2">{t("home.nothingWaiting")}</p>
        )}
      </Section>

      <Section id="ops-figures" title={t("home.figures")}>
        <div className="ops-kpis">
          {jobs ? <Kpi label={t("home.kpi.jobs")} value={t("home.kpi.jobsValue", { ok: f.number(jobs.healthy), total: f.number(jobs.total) })} hint={jobs.nextDaily ? t("home.kpi.nextDaily", { at: f.dateTime(jobs.nextDaily) }) : undefined} to="/admin/ops/jobs" /> : null}
          {outbox ? <Kpi label={t("home.kpi.held")} value={f.number(outbox.held)} hint={outbox.oldestHeldAt ? t("home.kpi.heldHint", { at: f.relative(outbox.oldestHeldAt, now) }) : t("home.kpi.heldNone")} to="/admin/ops/outbox?status=held" /> : null}
          {findings ? (
            <Kpi
              label={t("home.kpi.findings")}
              value={f.number(findings.active)}
              hint={findings.lastRun ? t("home.kpi.findingsHint", { critical: f.number(findings.critical), at: f.relative(findings.lastRun.at, now) }) : t("home.kpi.checksNever")}
              to="/admin/ops/consistency"
            />
          ) : null}
          {incidents ? <Kpi label={t("home.kpi.incidents")} value={f.number(incidents.active)} hint={t("home.kpi.incidentsHint", { mine: f.number(incidents.mine), overdue: f.number(incidents.overdue) })} to="/admin/ops/incidents" /> : null}
          {errors ? <Kpi label={t("home.kpi.errors")} value={f.number(errors.open)} hint={t("home.kpi.errorsHint", { count: errors.seen24h })} to="/admin/ops/errors" /> : null}
          {performance ? <Kpi label={t("home.kpi.slow")} value={f.number(performance.slow)} hint={t("home.kpi.slowHint", { failed: f.number(performance.failed) })} to="/admin/ops/performance" /> : null}
          {backups ? (
            <Kpi
              label={t("home.kpi.restore")}
              value={backups.restore.ageDays === null ? "—" : t("common.days", { count: backups.restore.ageDays })}
              hint={backups.restore.ageDays === null ? t("home.kpi.restoreNever") : t("home.kpi.restoreHint", { days: backups.restore.intervalDays })}
              to="/admin/ops/backups"
            />
          ) : null}
        </div>
        {jobs && jobs.nextFrequent ? (
          <p className="type-caption text-ink-2">
            {t("home.nextFrequent")} <When at={jobs.nextFrequent} /> · <Ago at={jobs.nextFrequent} now={now} />
          </p>
        ) : null}
      </Section>

      <Section id="ops-limits" title={t("home.limits")}>
        <Note tone="warn" icon="warning">
          <p>{t("home.limit.observability")}</p>
          <p>{t("home.limit.messages")}</p>
          <p>{t("home.limit.backups")}</p>
          <p>{t("home.limit.crons")}</p>
        </Note>
      </Section>

      <ModuleFunctions moduleId="23" />
    </>
  );
}
