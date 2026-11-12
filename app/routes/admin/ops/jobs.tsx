import { Form, Link } from "react-router";

import type { Route } from "./+types/jobs";
import { jobsNeedingAttention, jobsOverview, listRuns, RUNS_KEPT_DAYS } from "~/server/services/admin/ops/job-monitor.server";
import { JOB_HEALTH_TONE, JOB_LIST_VIEWS, RUN_ORIGINS, RUN_STATUSES, RUN_STATUS_TONE, parseJobListView, parseRunFilters, runSearch, type JobListView, type JobRunView, type JobView } from "~/server/services/admin/ops/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { cronLabel, jobAbout, jobName } from "./components/labels";
import { Ago, Code, Duration, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, StatusText, When, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ops } from "./ops.server";

/**
 * /admin/ops/jobs — 23.03: every scheduled job (from the scheduler's own list) with its cron, when it is due next, its
 * health (late when its trigger stopped firing, stuck when a run never recorded its end, failing with the failures in
 * a row), its last run and last success; then the run history with filters in the URL (job, status, origin, page).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.job.read");
  const params = new URL(args.request.url).searchParams;
  const filters = parseRunFilters(params);
  const view = parseJobListView(params);
  const [overview, runs] = await ops.orRespond(req, () => Promise.all([jobsOverview(req.db, req.actor, req.now), listRuns(req.db, req.actor, filters)]));
  // "need attention" lists exactly what the bell and the front page count (jobsNeedingAttention)
  const attention = jobsNeedingAttention(overview.jobs);
  return { overview, jobs: view === "attention" ? attention : overview.jobs, view, jobCounts: { all: overview.jobs.length, attention: attention.length }, runs, filters, now: req.now, keptDays: RUNS_KEPT_DAYS };
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "jobs.title");

export default function JobsPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const { overview, jobs, view, jobCounts, runs, filters, now, keptDays } = loaderData;
  /** The page with this jobs view and these run filters (the two parts keep each other in the URL). */
  const pageHref = (next: { view?: JobListView; page?: number }, hash = "") => {
    const search = new URLSearchParams(runSearch({ ...filters, page: next.page ?? 1 }).slice(1));
    if ((next.view ?? view) === "attention") search.set("view", "attention");
    const query = search.toString();
    return `/admin/ops/jobs${query ? `?${query}` : ""}${hash}`;
  };

  const jobLink = (job: string) => (
    <Link to={`/admin/ops/jobs/${encodeURIComponent(job)}`} className="adm-link">
      {jobName(t, job)}
    </Link>
  );
  const lastRun = (job: JobView) =>
    job.last ? (
      <span className="grid">
        <span className="flex flex-wrap items-center gap-2">
          <StatusText tone={RUN_STATUS_TONE[job.last.status]}>{t(`run.status.${job.last.status}`)}</StatusText>
          <Ago at={job.last.startedAt} now={now} />
        </span>
        <span className="type-caption text-ink-2">
          <Duration ms={job.last.durationMs} /> · {t(`run.origin.${job.last.origin}`)}
        </span>
      </span>
    ) : (
      <span className="text-ink-2">{t("jobs.neverRan")}</span>
    );
  const jobColumns: DataColumn<JobView>[] = [
    { key: "job", header: t("jobs.col.job"), cell: (job) => <span className="grid">{jobLink(job.job)}<span className="type-caption text-ink-2"><Code>{job.job}</Code></span></span> },
    { key: "schedule", header: t("jobs.col.schedule"), cell: (job) => <span className="grid"><span>{cronLabel(t, job.cron)}</span>{job.nextDueAt ? <span className="type-caption text-ink-2">{t("jobs.next")} <When at={job.nextDueAt} /></span> : null}</span> },
    { key: "health", header: t("jobs.col.health"), cell: (job) => <StatusText tone={JOB_HEALTH_TONE[job.health]}>{t(`health.${job.health}`)}</StatusText> },
    { key: "last", header: t("jobs.col.last"), cell: lastRun },
    { key: "success", header: t("jobs.col.success"), cell: (job) => (job.lastSuccessAt ? <Ago at={job.lastSuccessAt} now={now} /> : <span className="text-ink-2">—</span>) },
    { key: "failures", header: t("jobs.col.failures"), numeric: true, cell: (job) => <span className="grid justify-items-end"><span>{job.failures7d}</span>{job.streak > 1 ? <span className="type-caption text-red-ink">{t("jobs.streak", { count: job.streak })}</span> : null}</span> },
  ];
  const runColumns: DataColumn<JobRunView>[] = [
    { key: "started", header: t("runs.col.started"), cell: (run) => <Link to={`/admin/ops/jobs/runs/${run.id}`} className="adm-link"><When at={run.startedAt} /></Link> },
    { key: "job", header: t("runs.col.job"), cell: (run) => jobName(t, run.job) },
    { key: "status", header: t("runs.col.status"), cell: (run) => <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`run.status.${run.status}`)}</StatusText> },
    { key: "origin", header: t("runs.col.origin"), cell: (run) => (run.triggeredBy ? t("runs.manualBy", { name: run.triggeredBy }) : t(`run.origin.${run.origin}`)) },
    { key: "duration", header: t("runs.col.duration"), numeric: true, cell: (run) => <Duration ms={run.durationMs} /> },
    { key: "error", header: t("runs.col.error"), cell: (run) => (run.error ? <span className="line-clamp-2 type-caption text-red-ink">{run.error}</span> : <span className="text-ink-2">—</span>) },
  ];

  return (
    <>
      <PageHead title={t("jobs.title")} lead={t("jobs.lead")} actions={<Key as={Link} to="/admin/ops/outbox" icon="envelope-simple">{t("jobs.toOutbox")}</Key>} />

      <Section id="ops-crons" title={t("jobs.crons")}>
        <ul role="list" className="grid gap-2 md:grid-cols-2">
          {overview.crons.map((cron) => (
            <li key={cron.cron} className="adm-card content-start gap-1">
              <p className="type-strong text-ink">{cronLabel(t, cron.cron)}</p>
              <p className="type-caption text-ink-2">
                <Code>{cron.cron}</Code> · {t("jobs.next")} <When at={cron.nextAt} />
              </p>
              <ol className="ops-steps type-caption text-ink-2">
                {cron.jobs.map((job) => (
                  <li key={job}>{jobName(t, job)}</li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
        <p className="type-caption text-ink-2">{t("jobs.cronsNote")}</p>
      </Section>

      <Section id="ops-jobs" title={t("jobs.list")}>
        <LinkChips label={t("jobs.views")} items={JOB_LIST_VIEWS.map((value) => ({ value, label: t(`jobs.view.${value}`), href: pageHref({ view: value }, "#ops-jobs"), selected: view === value, count: jobCounts[value] }))} />
        <ResponsiveList
          caption={t(`jobs.view.${view}`)}
          columns={jobColumns}
          rows={jobs}
          rowKey={(job) => job.job}
          empty={view === "attention" ? <EmptyState title={t("jobs.attentionEmpty")} text={t("jobs.attentionEmptyHint")} icon="seal-check" /> : undefined}
          card={(job) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{jobLink(job.job)}</span>
                <StatusText tone={JOB_HEALTH_TONE[job.health]}>{t(`health.${job.health}`)}</StatusText>
              </div>
              <p className="type-caption text-ink-2">{jobAbout(t, job.job)}</p>
              <Pair label={t("jobs.col.schedule")}>{cronLabel(t, job.cron)}</Pair>
              <Pair label={t("jobs.col.last")}>{lastRun(job)}</Pair>
              <Pair label={t("jobs.col.success")}>{job.lastSuccessAt ? <Ago at={job.lastSuccessAt} now={now} /> : "—"}</Pair>
              <Pair label={t("jobs.col.failures")}>{job.failures7d}</Pair>
            </>
          )}
        />
        <Note>
          <p>{t("jobs.healthNote")}</p>
        </Note>
      </Section>

      <Section id="ops-runs" title={t("runs.title")} aside={<span className="type-caption text-ink-2">{t("runs.count", { count: runs.total })}</span>}>
        <Form method="get" className="ops-filters" preventScrollReset>
          {view === "attention" ? <input type="hidden" name="view" value={view} /> : null}
          <Select name="job" label={t("runs.filter.job")} defaultValue={filters.job ?? ""} options={[{ value: "", label: t("common.all") }, ...runs.jobs.map((job) => ({ value: job, label: jobName(t, job) }))]} />
          <Select name="status" label={t("runs.filter.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("common.all") }, ...RUN_STATUSES.map((status) => ({ value: status, label: t(`run.status.${status}`) }))]} />
          <Select name="origin" label={t("runs.filter.origin")} defaultValue={filters.origin ?? ""} options={[{ value: "", label: t("common.all") }, ...RUN_ORIGINS.map((origin) => ({ value: origin, label: t(`run.origin.${origin}`) }))]} />
          <div className="flex gap-2">
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.job || filters.status || filters.origin ? (
              <Key as={Link} to={view === "attention" ? "/admin/ops/jobs?view=attention#ops-runs" : "/admin/ops/jobs#ops-runs"} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t("runs.title")}
          columns={runColumns}
          rows={runs.rows}
          rowKey={(run) => run.id}
          empty={<EmptyState title={t("runs.empty")} text={t("runs.emptyHint")} icon="clock" />}
          footer={<Pagination page={runs.page} pageCount={runs.pageCount} href={(n) => pageHref({ page: n }, "#ops-runs")} />}
          card={(run) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/ops/jobs/runs/${run.id}`} className="adm-link type-strong">
                  {jobName(t, run.job)}
                </Link>
                <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`run.status.${run.status}`)}</StatusText>
              </div>
              <Pair label={t("runs.col.started")}>
                <When at={run.startedAt} />
              </Pair>
              <Pair label={t("runs.col.duration")}>
                <Duration ms={run.durationMs} />
              </Pair>
              {run.error ? <p className="line-clamp-3 type-caption text-red-ink">{run.error}</p> : null}
            </>
          )}
        />
        <p className="type-caption text-ink-2">{t("runs.kept", { days: keptDays })}</p>
      </Section>
    </>
  );
}
