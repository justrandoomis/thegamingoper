import { Link } from "react-router";

import type { Route } from "./+types/job-run";
import { getRun } from "~/server/services/admin/ops/job-monitor.server";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import { INCIDENT_STATUS_TONE, RUN_STATUS_TONE, type IncidentStatus } from "~/server/services/admin/ops/types";
import { Key } from "~/ui/Key";
import { jobName } from "./components/labels";
import { Code, Duration, Note, PageHead, Pair, Section, StatusText, When, useOpsT } from "./components/ui";
import { Facts } from "./components/Facts";
import { opsMeta } from "./meta";
import { ops } from "./ops.server";

/**
 * /admin/ops/jobs/runs/:runId — one run of a job: when, how long, how it ended, who started it (a manual run), the
 * counters it reported (cost keys cut without cost.read), its error, and the incidents it is linked to — with "open an
 * incident" for a failed run (ops.incident.manage).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.job.read");
  const detail = await ops.orRespond(req, () => getRun(req.db, req.actor, args.params.runId));
  return { ...detail, access: opsAccess(req.actor) };
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "run.title");

export default function JobRunPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const { run, incidents, access } = loaderData;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to={`/admin/ops/jobs/${encodeURIComponent(run.job)}`} className="adm-link">
            {jobName(t, run.job)}
          </Link>
        }
        title={t("run.heading", { job: jobName(t, run.job) })}
        actions={
          access.manageIncidents && (run.status === "failed" || run.status === "running") ? (
            <Key as={Link} to={`/admin/ops/incidents/new?run=${encodeURIComponent(run.id)}`} icon="first-aid-kit">
              {t("run.openIncident")}
            </Key>
          ) : null
        }
      />
      <div className="ops-split">
        <div className="grid min-w-0 gap-5">
          <Section id="ops-run-facts" title={t("run.facts")}>
            <div className="adm-card gap-2">
              <Pair label={t("runs.col.status")}>
                <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`run.status.${run.status}`)}</StatusText>
              </Pair>
              <Pair label={t("runs.col.started")}>
                <When at={run.startedAt} />
              </Pair>
              <Pair label={t("run.finished")}>
                <When at={run.finishedAt} />
              </Pair>
              <Pair label={t("runs.col.duration")}>
                <Duration ms={run.durationMs} />
              </Pair>
              <Pair label={t("runs.col.origin")}>{run.triggeredBy ? t("runs.manualBy", { name: run.triggeredBy }) : t(`run.origin.${run.origin}`)}</Pair>
              <Pair label={t("run.id")}>
                <Code>{run.id}</Code>
              </Pair>
            </div>
          </Section>
          <Section id="ops-run-stats" title={t("run.stats")}>
            {run.stats && Object.keys(run.stats).length ? <Facts value={run.stats} /> : <p className="type-body text-ink-2">{t("run.noStats")}</p>}
            {run.statsWithheld ? (
              <Note icon="lock">
                <p>{t("run.statsWithheld")}</p>
              </Note>
            ) : null}
          </Section>
          {run.error ? (
            <Section id="ops-run-error" title={t("run.error")}>
              <pre dir="ltr" className="ops-pre type-data-sm">
                {run.error}
              </pre>
            </Section>
          ) : null}
        </div>
        {access.incidents ? (
          <aside className="grid min-w-0 gap-5" aria-label={t("run.incidents")}>
            <Section id="ops-run-incidents" title={t("run.incidents")}>
              {incidents.length ? (
                <ul role="list" className="grid gap-2">
                  {incidents.map((incident) => (
                    <li key={incident.id} className="adm-card gap-1">
                      <Link to={`/admin/ops/incidents/${incident.ref}`} className="adm-link type-strong">
                        <Code>{incident.ref}</Code> · {incident.title}
                      </Link>
                      <StatusText tone={INCIDENT_STATUS_TONE[incident.status as IncidentStatus] ?? "neutral"}>{t(`incident.status.${incident.status}`)}</StatusText>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="type-body text-ink-2">{t("run.noIncidents")}</p>
              )}
            </Section>
          </aside>
        ) : null}
      </div>
    </>
  );
}
