import { Form, Link } from "react-router";

import type { Route } from "./+types/runs";
import { RUN_STATUSES, RUN_STATUS_TONE } from "~/server/services/admin/automation/catalog";
import { listRuns } from "~/server/services/admin/automation/log.server";
import { RUN_DAYS, RUN_KINDS, parseRunFilters, runSearch, type RunView } from "~/server/services/admin/automation/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { automation } from "./automation.server";
import { Ago, Code, DemoTag, LinkChips, PageHead, Pair, ResponsiveList, Section, StatusText, When, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/runs — 19.01's execution log: every run of every rule, newest first — when, which rule and
 * version, the record it was about, what each action did (or, for dry-run samples, would have done) and the status.
 * Rule, status, kind (runs, dry-run samples, both) and the last 1 / 7 / 30 days in the URL — the front page's
 * "failed in 24 hours" opens ?status=failed&days=1, the very runs it counted.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.workflow.read");
  const filters = parseRunFilters(new URL(args.request.url).searchParams);
  const page = await automation.orRespond(() => listRuns(req.db, req.actor, filters, req.now));
  return { page, filters, now: req.now };
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "runs.title");

export default function RunsPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const { page, filters, now } = loaderData;
  const href = (next: Partial<typeof filters>) => `/admin/automation/runs${runSearch({ ...filters, page: 1, ...next })}`;
  const record = (run: RunView) => (
    <span className="grid">
      {run.event.label ? (
        run.event.href ? (
          <Link to={run.event.href} className="adm-link">
            <Code>{run.event.label}</Code>
          </Link>
        ) : (
          <Code>{run.event.label}</Code>
        )
      ) : (
        <span>—</span>
      )}
      <span className="type-caption text-ink-2">
        {run.event.type ? t(`event.${run.event.type}.title`) : "—"} {run.event.isDemo ? <DemoTag /> : null}
      </span>
    </span>
  );
  const rule = (run: RunView) => (
    <span className="grid">
      <Link to={`/admin/automation/rules/${run.ruleId}`} className="adm-link">
        <bdi>{run.ruleName}</bdi>
      </Link>
      <span className="type-caption text-ink-2">
        {run.event.version ? t("rule.versionLine", { version: run.event.version }) : null}
        {run.isDryRun ? ` · ${t("runs.dry")}` : ""}
      </span>
    </span>
  );
  const actions = (run: RunView) => (
    <ul role="list" className="grid gap-0.5">
      {run.actions.map((entry, index) => (
        <li key={index} className="type-caption">
          <span className="text-ink">{t(`action.${entry.type}.short`)}</span> · <span className="text-ink-2">{t(`outcome.${entry.outcome}`)}</span>
          {entry.reason ? <span className="text-ink-2"> · {t(`skip.${entry.reason}`)}</span> : null}
        </li>
      ))}
    </ul>
  );
  const columns: DataColumn<RunView>[] = [
    {
      key: "at",
      header: t("runs.col.at"),
      cell: (run) => (
        <span className="grid">
          <When at={run.at} />
          <span className="type-caption text-ink-2">
            <Ago at={run.at} now={now} />
          </span>
        </span>
      ),
    },
    { key: "rule", header: t("runs.col.rule"), cell: rule },
    { key: "record", header: t("runs.col.record"), cell: record },
    { key: "actions", header: t("runs.col.actions"), cell: actions },
    { key: "status", header: t("runs.col.status"), cell: (run) => <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`status.run.${run.status}`)}</StatusText> },
    {
      key: "open",
      header: t("runs.col.open"),
      cell: (run) => (
        <Link to={`/admin/automation/runs/${run.id}`} className="adm-link">
          {t("runs.open")}
        </Link>
      ),
    },
  ];
  const filtered = filters.rule || filters.status || filters.days;

  return (
    <>
      <PageHead title={t("runs.title")} lead={t("runs.lead")} />
      <Section id="auto-runs" title={t(`runs.kind.${filters.kind}`)} aside={<span className="type-caption text-ink-2">{t("runs.count", { count: page.total })}</span>}>
        <LinkChips label={t("runs.kinds")} items={RUN_KINDS.map((kind) => ({ value: kind, label: t(`runs.kind.${kind}`), href: href({ kind }), selected: filters.kind === kind }))} />
        <Form method="get" className="auto-filters" preventScrollReset>
          {filters.kind !== "real" ? <input type="hidden" name="kind" value={filters.kind} /> : null}
          <Select name="rule" label={t("runs.filter.rule")} defaultValue={filters.rule ?? ""} options={[{ value: "", label: t("common.all") }, ...page.rules]} />
          <Select name="status" label={t("runs.filter.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("common.all") }, ...RUN_STATUSES.map((status) => ({ value: status, label: t(`status.run.${status}`) }))]} />
          <Select name="days" label={t("runs.filter.days")} defaultValue={filters.days ? String(filters.days) : ""} options={[{ value: "", label: t("runs.days.all") }, ...RUN_DAYS.map((days) => ({ value: String(days), label: t(`runs.days.d${days}`) }))]} />
          <div>
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filtered ? (
              <Key as={Link} to={href({ rule: null, status: null, days: null })} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t("runs.title")}
          columns={columns}
          rows={page.rows}
          rowKey={(run) => run.id}
          empty={<EmptyState title={filtered ? t("runs.emptyFiltered") : t("runs.empty")} text={filtered ? t("runs.emptyFilteredText") : t("runs.emptyText")} icon="clock" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/automation/runs${runSearch({ ...filters, page: n })}`} />}
          card={(run) => (
            <>
              <div className="flex items-start justify-between gap-2">
                {record(run)}
                <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`status.run.${run.status}`)}</StatusText>
              </div>
              <Pair label={t("runs.col.rule")}>{rule(run)}</Pair>
              <Pair label={t("runs.col.at")}>
                <Ago at={run.at} now={now} />
              </Pair>
              {actions(run)}
              <Link to={`/admin/automation/runs/${run.id}`} className="adm-link type-label">
                {t("runs.open")}
              </Link>
            </>
          )}
        />
      </Section>
    </>
  );
}
