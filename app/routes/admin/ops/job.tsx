import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/job";
import { useFormat } from "~/i18n/react";
import { getJob, runJobNow } from "~/server/services/admin/ops/job-monitor.server";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import { JOB_HEALTH_TONE, RUN_STATUS_TONE, type ImpactLine, type JobRunView } from "~/server/services/admin/ops/types";
import { invalid } from "~/server/errors";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { cronLabel, jobAbout, jobName } from "./components/labels";
import { ActionDialog, Ago, Code, Duration, Note, PageHead, Pair, ResponsiveList, Section, StatusText, When, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { jobsEnv, newKey, ok, ops, text } from "./ops.server";

/**
 * /admin/ops/jobs/:job — one scheduled job: its cron and the next run, health, last success, failures in a row, what a
 * run now would touch (counted with the job's own conditions), its latest runs, and "run now" (ops.job.run): the same
 * code the cron runs, with a reason, once per form, refused while a run is in progress, audited.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.job.read");
  const job = await ops.orRespond(req, () => getJob(req.db, req.actor, args.params.job, req.now));
  return { ...job, access: opsAccess(req.actor), key: newKey(), now: req.now };
}

export async function action(args: Route.ActionArgs) {
  const req = await ops.open(args, "ops.job.run");
  let intent: string | null = null;
  try {
    const form = await ops.form(args.request);
    intent = text(form, "intent");
    if (intent !== "run") throw invalid({ intent: "invalid" });
    const result = await runJobNow(req.db, req.actor, { job: args.params.job, reason: text(form, "reason"), idempotencyKey: text(form, "key") }, req.now, jobsEnv());
    return ok(intent, result);
  } catch (error) {
    return ops.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "job.title", { job: args.params.job ?? "" });

export default function JobPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { view, preview, runs, access, key, now } = loaderData;
  const [confirm, setConfirm] = useState(false);
  const lineText = (line: ImpactLine) => t(`preview.${line.key}`, { ...(line.vars ?? {}), count: line.count ?? 0, n: line.count === null ? "—" : f.number(line.count) });
  const columns: DataColumn<JobRunView>[] = [
    { key: "started", header: t("runs.col.started"), cell: (run) => <Link to={`/admin/ops/jobs/runs/${run.id}`} className="adm-link"><When at={run.startedAt} /></Link> },
    { key: "status", header: t("runs.col.status"), cell: (run) => <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`run.status.${run.status}`)}</StatusText> },
    { key: "origin", header: t("runs.col.origin"), cell: (run) => (run.triggeredBy ? t("runs.manualBy", { name: run.triggeredBy }) : t(`run.origin.${run.origin}`)) },
    { key: "duration", header: t("runs.col.duration"), numeric: true, cell: (run) => <Duration ms={run.durationMs} /> },
    { key: "error", header: t("runs.col.error"), cell: (run) => (run.error ? <span className="line-clamp-2 type-caption text-red-ink">{run.error}</span> : <span className="text-ink-2">—</span>) },
  ];

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/ops/jobs" className="adm-link">
            {t("job.back")}
          </Link>
        }
        title={jobName(t, view.job)}
        lead={jobAbout(t, view.job)}
        actions={
          access.runJobs && view.known ? (
            <Key variant="ink" icon="arrows-clockwise" onClick={() => setConfirm(true)}>
              {t("job.runNow")}
            </Key>
          ) : null
        }
      />

      <div className="ops-split">
        <div className="grid min-w-0 gap-5">
          <Section id="ops-job-state" title={t("job.state")}>
            <div className="adm-card gap-2">
              <Pair label={t("job.key")}>
                <Code>{view.job}</Code>
              </Pair>
              <Pair label={t("jobs.col.health")}>
                <StatusText tone={JOB_HEALTH_TONE[view.health]}>{t(`health.${view.health}`)}</StatusText>
              </Pair>
              <Pair label={t("jobs.col.schedule")}>
                {cronLabel(t, view.cron)}
                {view.cron ? (
                  <>
                    {" "}
                    · <Code>{view.cron}</Code>
                  </>
                ) : null}
              </Pair>
              <Pair label={t("jobs.next")}>
                <When at={view.nextDueAt} />
              </Pair>
              <Pair label={t("jobs.col.last")}>{view.last ? <Ago at={view.last.startedAt} now={now} /> : t("jobs.neverRan")}</Pair>
              <Pair label={t("jobs.col.success")}>{view.lastSuccessAt ? <Ago at={view.lastSuccessAt} now={now} /> : "—"}</Pair>
              <Pair label={t("jobs.col.failures")}>{f.number(view.failures7d)}</Pair>
              <Pair label={t("job.streakLabel")}>{f.number(view.streak)}</Pair>
            </div>
            <p className="type-caption text-ink-2">{t(`healthHint.${view.health}`)}</p>
          </Section>

          <Section id="ops-job-runs" title={t("job.runs")}>
            <ResponsiveList
              caption={t("job.runs")}
              columns={columns}
              rows={runs}
              rowKey={(run) => run.id}
              empty={<EmptyState title={t("runs.empty")} text={t("job.runsEmptyHint")} icon="clock" />}
              footer={
                <Link to={`/admin/ops/jobs?job=${encodeURIComponent(view.job)}#ops-runs`} className="adm-link type-label">
                  {t("job.allRuns")}
                </Link>
              }
              card={(run) => (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/admin/ops/jobs/runs/${run.id}`} className="adm-link type-strong">
                      <When at={run.startedAt} />
                    </Link>
                    <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`run.status.${run.status}`)}</StatusText>
                  </div>
                  <Pair label={t("runs.col.duration")}>
                    <Duration ms={run.durationMs} />
                  </Pair>
                  {run.error ? <p className="line-clamp-3 type-caption text-red-ink">{run.error}</p> : null}
                </>
              )}
            />
          </Section>
        </div>

        <aside className="grid min-w-0 gap-5" aria-label={t("job.preview")}>
          <Section id="ops-job-preview" title={t("job.preview")}>
            <ul role="list" className="adm-card gap-2">
              {preview.lines.map((line) => (
                <li key={line.key} className="type-body text-ink">
                  {lineText(line)}
                </li>
              ))}
            </ul>
            <Note tone={preview.changesData ? "warn" : "info"} icon={preview.changesData ? "warning" : "info"}>
              <p>{preview.changesData ? t("job.changesData") : t("job.readsOnly")}</p>
            </Note>
          </Section>
        </aside>
      </div>

      <ActionDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("job.runTitle", { job: jobName(t, view.job) })}
        consequence={preview.changesData ? t("job.runConsequence") : t("job.runConsequenceSafe")}
        confirmLabel={t("confirm.run")}
        tone={preview.changesData ? "destructive" : "neutral"}
        impact={preview.lines.map((line) => ({ label: t("job.impact"), value: lineText(line) }))}
        reason={{ label: t("common.reason"), hint: t("job.reasonHint") }}
        fields={{ intent: "run", key }}
        successMessage={(result) => t(result.replayed ? "job.ranBefore" : "job.ran", { status: t(`run.status.${String(result.status ?? "skipped")}`) })}
      />
    </>
  );
}
