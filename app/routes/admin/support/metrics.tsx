import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/metrics";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { parseMetricDays, supportMetrics, type DurationStat, type GroupRow } from "~/server/services/admin/support/metrics.server";
import { METRIC_DAYS } from "~/server/services/admin/support/types";
import { Key } from "~/ui/Key";
import { supportMeta } from "./meta";
import { openSupport } from "./support.server";
import { Boundary, Duration, Num, Section, useSupportT, When } from "./ui";

/**
 * /admin/support/metrics — service metrics (14.05): first-response and resolution times computed from the tickets'
 * events (the first public staff reply, the resolution) against their SLA due times, the backlog now, per agent,
 * category, priority and channel, repairs — and customer satisfaction only when it is really collected. A period
 * with nothing to measure shows "—" and why, never 0. Demo records only when asked for (`?demo=1`). Needs
 * support.metrics.read.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openSupport(context, "support.metrics.read");
  const params = new URL(request.url).searchParams;
  const days = parseMetricDays(params.get("days"));
  const demo = params.get("demo") === "1";
  try {
    return { metrics: await supportMetrics(db, actor, { days, demo }, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, "metrics.title");

const search = (days: number, demo: boolean) => {
  const params = new URLSearchParams();
  if (days !== 30) params.set("days", String(days));
  if (demo) params.set("demo", "1");
  const text = params.toString();
  return text ? `?${text}` : "";
};

export default function MetricsPage({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const f = useFormat();
  const { metrics } = loaderData;
  const { days } = metrics.period;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("metrics.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("metrics.lead")}</p>
      </header>
      <nav aria-label={t("metrics.period")} className="flex flex-wrap items-center gap-2">
        {METRIC_DAYS.map((option) => (
          <Key key={option} as={Link} to={`/admin/support/metrics${search(option, metrics.includeDemo)}`} size="sm" held={days === option} aria-current={days === option ? "true" : undefined}>
            {t("metrics.days", { count: option, n: f.number(option) })}
          </Key>
        ))}
        <Key as={Link} to={`/admin/support/metrics${search(days, !metrics.includeDemo)}`} size="sm" held={metrics.includeDemo} aria-pressed={metrics.includeDemo}>
          {t("metrics.includeDemo")}
        </Key>
      </nav>
      <p className="type-caption text-ink-2">
        {t("metrics.range")} <When at={metrics.period.from} style="date" /> — <When at={metrics.period.to} style="date" /> · {t(metrics.includeDemo ? "metrics.withDemo" : "metrics.withoutDemo")}
        {metrics.truncated ? ` · ${t("metrics.truncated")}` : ""}
      </p>
      <Boundary icon="clock">{t("metrics.how")}</Boundary>

      <Section id="metrics-kpis" title={t("metrics.overview")}>
        <div className="sup-kpis">
          <Kpi label={t("metrics.created")} value={<Num value={metrics.tickets.created} />} note={t("metrics.createdNote")} />
          <StatKpi label={t("metrics.firstResponse")} stat={metrics.tickets.firstResponse} />
          <StatKpi label={t("metrics.resolution")} stat={metrics.tickets.resolution} />
          <Kpi label={t("metrics.notAnswered")} value={<Num value={metrics.tickets.notAnswered} />} note={t("metrics.notAnsweredNote", { count: metrics.tickets.notAnsweredLate })} />
          <Kpi label={t("metrics.backlog")} value={<Num value={metrics.backlog.open} />} note={t("metrics.backlogNote", { late: metrics.backlog.late, unassigned: metrics.backlog.unassigned, escalated: metrics.backlog.escalated })} />
          <Satisfaction metrics={metrics} />
        </div>
      </Section>

      <Section id="metrics-agents" title={t("metrics.byAgent")}>
        {metrics.byAgent.length === 0 ? (
          <p className="type-body text-ink-2">{t("metrics.noAgents")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table" data-density="admin">
              <caption className="sr-only">{t("metrics.byAgent")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("routing.agent")}</th>
                  <th scope="col" className="is-num">
                    {t("metrics.col.answered")}
                  </th>
                  <th scope="col" className="is-num">
                    {t("metrics.col.firstMedian")}
                  </th>
                  <th scope="col" className="is-num">
                    {t("metrics.col.resolved")}
                  </th>
                  <th scope="col" className="is-num">
                    {t("metrics.col.resolveMedian")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {metrics.byAgent.map((agent) => (
                  <tr key={agent.id}>
                    <td>{agent.name}</td>
                    <td className="is-num">
                      <Num value={agent.answered} />
                    </td>
                    <td className="is-num">
                      <Duration minutes={agent.firstResponse.median} />
                    </td>
                    <td className="is-num">
                      <Num value={agent.resolved} />
                    </td>
                    <td className="is-num">
                      <Duration minutes={agent.resolution.median} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <GroupTable id="metrics-category" title={t("metrics.byCategory")} rows={metrics.byCategory} label={(key) => t(`category.${key}`)} />
      <GroupTable id="metrics-priority" title={t("metrics.byPriority")} rows={metrics.byPriority} label={(key) => t(`priority.${key}`)} />
      <GroupTable id="metrics-channel" title={t("metrics.byChannel")} rows={metrics.byChannel} label={(key) => t(`channel.${key}`)} />

      <Section id="metrics-repairs" title={t("metrics.repairs")}>
        <div className="sup-kpis">
          <Kpi label={t("metrics.repairsCreated")} value={<Num value={metrics.repairs.created} />} note={t("metrics.repairsCreatedNote")} />
          <StatKpi label={t("metrics.repairsFirstAction")} stat={metrics.repairs.firstAction} hideSla />
          <StatKpi label={t("metrics.repairsCompletion")} stat={metrics.repairs.completion} />
          <Kpi label={t("metrics.repairsLate")} value={<Num value={metrics.repairs.lateNow} />} note={t("metrics.repairsLateNote")} />
        </div>
      </Section>
    </>
  );
}

function Kpi({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <article className="sup-kpi">
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi">{value}</p>
      {note ? <p className="type-caption text-ink-2">{note}</p> : null}
    </article>
  );
}

function StatKpi({ label, stat, hideSla = false }: { label: string; stat: DurationStat; hideSla?: boolean }) {
  const t = useSupportT();
  const f = useFormat();
  return (
    <article className="sup-kpi">
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi">
        <Duration minutes={stat.median} />
      </p>
      <p className="type-caption text-ink-2">
        {stat.count === 0 ? (
          t("metrics.nothingMeasured")
        ) : (
          <>
            {t("metrics.median", { count: stat.count })} · {t("metrics.p90")} <Duration minutes={stat.p90} />
          </>
        )}
      </p>
      {!hideSla ? <p className="type-caption text-ink-2">{stat.withinSla === null ? t("metrics.slaNone") : t("metrics.withinSla", { share: f.percent(stat.withinSla), count: stat.withDue })}</p> : null}
    </article>
  );
}

function Satisfaction({ metrics }: { metrics: Route.ComponentProps["loaderData"]["metrics"] }) {
  const t = useSupportT();
  const f = useFormat();
  const csat = metrics.satisfaction;
  return (
    <article className="sup-kpi">
      <p className="type-caption text-ink-2">{t("metrics.satisfaction")}</p>
      {csat.collected ? (
        <>
          <p className="type-kpi nums">
            <bdi>{f.number(csat.average)}</bdi> / 5
          </p>
          <p className="type-caption text-ink-2">{t("metrics.satisfactionCount", { answered: csat.answered, resolved: csat.resolved })}</p>
          <p className="type-caption text-ink-2 nums">{csat.distribution.map((n, index) => `${index + 1}★ ${f.number(n)}`).join(" · ")}</p>
        </>
      ) : (
        <>
          <p className="type-kpi">—</p>
          <p className="type-caption text-ink-2">{t("metrics.notCollected")}</p>
        </>
      )}
    </article>
  );
}

function GroupTable<K extends string>({ id, title, rows, label }: { id: string; title: string; rows: GroupRow<K>[]; label: (key: K) => string }) {
  const t = useSupportT();
  const f = useFormat();
  return (
    <Section id={id} title={title}>
      {rows.length === 0 ? (
        <p className="type-body text-ink-2">{t("metrics.noTickets")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table" data-density="admin">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{title}</th>
                <th scope="col" className="is-num">
                  {t("metrics.col.created")}
                </th>
                <th scope="col" className="is-num">
                  {t("metrics.col.firstMedian")}
                </th>
                <th scope="col" className="is-num">
                  {t("metrics.col.firstSla")}
                </th>
                <th scope="col" className="is-num">
                  {t("metrics.col.resolveMedian")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>{label(row.key)}</td>
                  <td className="is-num">
                    <Num value={row.created} />
                  </td>
                  <td className="is-num">
                    <Duration minutes={row.firstResponse.median} />
                  </td>
                  <td className="is-num">{row.firstResponse.withinSla === null ? "—" : <bdi className="nums">{f.percent(row.firstResponse.withinSla)}</bdi>}</td>
                  <td className="is-num">
                    <Duration minutes={row.resolution.median} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
