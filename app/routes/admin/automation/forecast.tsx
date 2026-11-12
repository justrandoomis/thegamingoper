import { Form, Link } from "react-router";

import type { Route } from "./+types/forecast";
import { useFormat } from "~/i18n/react";
import { demandForecast, type ForecastRow } from "~/server/services/admin/automation/forecast.server";
import { FORECAST } from "~/server/services/admin/automation/forecast";
import { FORECAST_VIEWS, forecastSearch, parseForecastFilters } from "~/server/services/admin/automation/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { automation } from "./automation.server";
import { Code, DemoTag, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, When, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/forecast — 19.05: next month's demand per SKU by one explained method (a three-month moving
 * average of units sold, times last year's index for that month once 12 months exist), the twelve months behind it,
 * stock now, and launches from the catalogue's release dates with units already pre-ordered. Too little history says
 * so: no number is made up.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.suggestion.read");
  const filters = parseForecastFilters(new URL(args.request.url).searchParams);
  const page = await automation.orRespond(() => demandForecast(req.db, req.actor, filters, req.locale, req.now));
  return { page, filters, now: req.now };
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "forecast.title");

function Months({ row }: { row: ForecastRow }) {
  const t = useAutoT();
  const f = useFormat();
  const max = Math.max(1, ...row.monthly);
  return (
    <span className="grid gap-1">
      <span className="auto-months" role="img" aria-label={t("forecast.monthsLabel", { values: row.monthly.map((units) => f.number(units)).join(t("common.listSep")) })}>
        {row.monthly.map((units, index) => (
          <span key={index} data-zero={units === 0 ? "" : undefined} style={{ blockSize: `${Math.max(4, Math.round((units / max) * 100))}%` }} />
        ))}
      </span>
      <span className="type-caption text-ink-2">{t("forecast.thisMonth", { units: f.number(row.thisMonth) })}</span>
    </span>
  );
}

export default function ForecastPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { page, filters } = loaderData;
  const href = (next: Partial<typeof filters>) => `/admin/automation/forecast${forecastSearch({ ...filters, page: 1, ...next })}`;
  const sku = (row: ForecastRow) => (
    <span className="grid">
      {row.variant.href ? (
        <Link to={row.variant.href} className="adm-link">
          <bdi>{row.variant.name}</bdi>
        </Link>
      ) : (
        <bdi>{row.variant.name}</bdi>
      )}
      <span className="type-caption text-ink-2">
        <Code>{row.variant.sku}</Code> {row.demo ? <DemoTag /> : null}
      </span>
    </span>
  );
  const result = (row: ForecastRow) =>
    row.result.status === "forecast" ? (
      <span className="grid">
        <span className="type-strong">
          <bdi className="nums">{t("forecast.units", { count: row.result.forecast ?? 0 })}</bdi>
        </span>
        <span className="type-caption text-ink-2">
          {t("forecast.base", { average: f.number(row.result.movingAverage ?? 0) })}
          {row.result.seasonalIndex !== null ? ` × ${t("forecast.index", { index: f.number((row.result.seasonalIndex ?? 100) / 100) })}` : ` · ${t("forecast.noSeason")}`}
        </span>
      </span>
    ) : (
      <span className="grid">
        <span>{t(`forecast.status.${row.result.status}`)}</span>
        <span className="type-caption text-ink-2">{row.result.status === "short_history" ? t("forecast.history", { count: row.historyMonths, need: FORECAST.minHistoryMonths }) : t("forecast.noRecent", { months: FORECAST.maMonths })}</span>
      </span>
    );
  const launch = (row: ForecastRow) =>
    row.result.launch ? (
      <span className="grid">
        <span>{t(`forecast.launch.${row.result.launch}`)}</span>
        <span className="type-caption text-ink-2">
          <When at={row.releaseAt} kind="date" /> · {t("forecast.preorders", { count: row.preorderUnits })}
        </span>
      </span>
    ) : (
      <span className="text-ink-2">—</span>
    );
  const columns: DataColumn<ForecastRow>[] = [
    { key: "sku", header: t("forecast.col.sku"), cell: sku },
    { key: "months", header: t("forecast.col.months"), cell: (row) => <Months row={row} /> },
    { key: "forecast", header: t("forecast.col.forecast", { month: page.nextMonth }), cell: result },
    { key: "stock", header: t("forecast.col.stock"), numeric: true, cell: (row) => f.number(row.available) },
    { key: "launch", header: t("forecast.col.launch"), cell: launch },
  ];
  return (
    <>
      <PageHead title={t("forecast.title")} lead={t("forecast.lead")} />
      <Note icon="info">
        <p>{t("forecast.method1", { months: FORECAST.maMonths })}</p>
        <p>{t("forecast.method2", { min: FORECAST.indexMin, max: FORECAST.indexMax })}</p>
        <p>{t("forecast.method3", { need: FORECAST.minHistoryMonths, days: FORECAST.launchDays })}</p>
      </Note>
      <Section id="auto-forecast" title={t(`forecast.view.${filters.view}`)} aside={<span className="type-caption text-ink-2">{t("forecast.count", { count: page.total })}</span>}>
        <LinkChips label={t("forecast.views")} items={FORECAST_VIEWS.map((view) => ({ value: view, label: t(`forecast.view.${view}`), href: href({ view }), selected: filters.view === view, count: page.counts[view] }))} />
        <Form method="get" className="auto-filters" preventScrollReset>
          {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <TextField name="q" label={t("forecast.filter.q")} defaultValue={filters.q} maxLength={80} />
          <div>
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.q ? (
              <Key as={Link} to={href({ q: "" })} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t("forecast.title")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.variant.id}
          empty={<EmptyState title={t("forecast.empty")} text={t("forecast.emptyText")} icon="chart-line" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/automation/forecast${forecastSearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              {sku(row)}
              <Pair label={t("forecast.col.forecast", { month: page.nextMonth })}>{result(row)}</Pair>
              <Pair label={t("forecast.col.stock")}>
                <bdi className="nums">{f.number(row.available)}</bdi>
              </Pair>
              <Months row={row} />
              {row.result.launch ? <Pair label={t("forecast.col.launch")}>{launch(row)}</Pair> : null}
            </>
          )}
        />
      </Section>
    </>
  );
}
