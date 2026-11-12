import type { Route } from "./+types/performance";
import { useFormat } from "~/i18n/react";
import { performanceView } from "~/server/services/admin/ops/telemetry.server";
import { PERF_AREAS, PERF_THRESHOLDS, PERF_WINDOWS, parsePerfFilters, perfSearch, type PerfRow } from "~/server/services/admin/ops/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { CloudflareSteps } from "./components/Cloudflare";
import { Code, Duration, Kpi, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ops } from "./ops.server";

/**
 * /admin/ops/performance — 23.02: what the app records about its speed — never every request: each SLOW request
 * (server time ≥ 1 s), FAILED request (status ≥ 500), slow full page load (≥ 3 s) and slow client navigation (≥ 2 s) of
 * the admin, per page (route pattern), day and device class. So these are counts of problems, not rates: the request
 * totals and percentiles are Cloudflare's (step by step below). Window and area in the URL.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.performance.read");
  const filters = parsePerfFilters(new URL(args.request.url).searchParams);
  const view = await ops.orRespond(req, () => performanceView(req.db, req.actor, filters, req.now));
  return { view, filters };
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "performance.title");

export default function PerformancePage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { view, filters } = loaderData;
  const slot = (value: { count: number; avgMs: number | null; maxMs: number | null; poor: number }) =>
    value.count ? (
      <span className="grid justify-items-end">
        <span>{f.number(value.count)}</span>
        <span className="type-caption text-ink-2">
          {t("performance.avg")} <Duration ms={value.avgMs} /> · {t("performance.max")} <Duration ms={value.maxMs} />
        </span>
        {value.poor ? <span className="type-caption text-red-ink">{t("performance.poor", { count: value.poor })}</span> : null}
      </span>
    ) : (
      <span className="text-ink-2">—</span>
    );
  const devices = (row: PerfRow) =>
    Object.entries(row.devices)
      .filter(([, count]) => count > 0)
      .map(([device, count]) => `${t(`device.${device}`)} ${f.number(count)}`)
      .join(t("common.listSep")) || "—";
  const columns: DataColumn<PerfRow>[] = [
    { key: "route", header: t("performance.col.route"), cell: (row) => <Code>{row.route}</Code> },
    { key: "server", header: t("performance.col.server"), numeric: true, cell: (row) => slot(row.serverSlow) },
    { key: "failed", header: t("performance.col.failed"), numeric: true, cell: (row) => (row.serverFailed.count ? <span className="text-red-ink">{f.number(row.serverFailed.count)}</span> : <span className="text-ink-2">—</span>) },
    { key: "load", header: t("performance.col.load"), numeric: true, cell: (row) => slot(row.loadSlow) },
    { key: "nav", header: t("performance.col.nav"), numeric: true, cell: (row) => slot(row.navSlow) },
    { key: "devices", header: t("performance.col.devices"), cell: devices },
  ];
  const peak = Math.max(1, ...view.days.map((day) => day.serverSlow + day.loadSlow + day.navSlow + day.serverFailed));
  const windowHref = (window: string) => `/admin/ops/performance${perfSearch({ ...filters, window: window as never })}`;
  const areaHref = (area: string) => `/admin/ops/performance${perfSearch({ ...filters, area: area as never })}`;

  return (
    <>
      <PageHead title={t("performance.title")} lead={t("performance.lead", { server: f.number(PERF_THRESHOLDS.server.slowMs / 1000), load: f.number(PERF_THRESHOLDS.load.slowMs / 1000), nav: f.number(PERF_THRESHOLDS.nav.slowMs / 1000) })} />
      <div className="grid gap-3 md:flex md:flex-wrap md:items-center md:justify-between">
        <LinkChips label={t("performance.windows")} items={PERF_WINDOWS.map((window) => ({ value: window, label: t(`performance.window.${window}`), href: windowHref(window), selected: filters.window === window }))} />
        <LinkChips label={t("performance.areas")} items={PERF_AREAS.map((area) => ({ value: area, label: t(`performance.area.${area}`), href: areaHref(area), selected: filters.area === area }))} />
      </div>

      <Section id="ops-perf-totals" title={t("performance.totals")}>
        <div className="ops-kpis">
          <Kpi label={t("performance.col.server")} value={f.number(view.totals.serverSlow)} />
          <Kpi label={t("performance.col.failed")} value={f.number(view.totals.serverFailed)} />
          <Kpi label={t("performance.col.load")} value={f.number(view.totals.loadSlow)} />
          <Kpi label={t("performance.col.nav")} value={f.number(view.totals.navSlow)} />
        </div>
        <ol className="ops-bars" aria-label={t("performance.byDay")}>
          {view.days.map((day) => {
            const total = day.serverSlow + day.loadSlow + day.navSlow + day.serverFailed;
            return (
              <li key={day.day}>
                <span className="type-caption nums text-ink-2">
                  <bdi dir="ltr">{day.day}</bdi>
                </span>
                <span className="ops-bar" aria-hidden="true">
                  <span data-tone={day.serverFailed ? "bad" : undefined} style={{ inlineSize: `${Math.round((total / peak) * 100)}%` }} />
                </span>
                <span className="type-caption nums text-ink">{f.number(total)}</span>
              </li>
            );
          })}
        </ol>
        {filters.area === "storefront" ? (
          <Note icon="info">
            <p>{t("performance.storefrontNote")}</p>
          </Note>
        ) : null}
      </Section>

      <Section id="ops-perf-routes" title={t("performance.routes")}>
        <ResponsiveList
          caption={t("performance.routes")}
          columns={columns}
          rows={view.rows}
          rowKey={(row) => row.route}
          empty={<EmptyState title={t("performance.empty")} text={t("performance.emptyHint")} icon="chart-line" />}
          card={(row) => (
            <>
              <p className="type-strong">
                <Code>{row.route}</Code>
              </p>
              <Pair label={t("performance.col.server")}>{slot(row.serverSlow)}</Pair>
              <Pair label={t("performance.col.failed")}>{f.number(row.serverFailed.count)}</Pair>
              <Pair label={t("performance.col.load")}>{slot(row.loadSlow)}</Pair>
              <Pair label={t("performance.col.nav")}>{slot(row.navSlow)}</Pair>
              <Pair label={t("performance.col.devices")}>{devices(row)}</Pair>
            </>
          )}
        />
        <Note icon="info">
          <p>{t("performance.notRates")}</p>
          <p>{t("performance.coverage")}</p>
        </Note>
      </Section>

      <CloudflareSteps kind="speed" />
    </>
  );
}
