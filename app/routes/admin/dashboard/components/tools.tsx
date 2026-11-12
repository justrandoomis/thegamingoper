/**
 * The command centre's tool row: the global search box (01.06 — a GET form, so it works without JavaScript), the
 * role views (01.05, link tabs: only the views this employee has), the period and its comparison (01.04, links that
 * keep the rest of the URL), the demo switch and the branch filter (only when the store has branches; an employee
 * limited to a branch sees their branch named instead). Everything is URL state: shareable and kept on Back.
 */
import { Form, Link } from "react-router";

import { DASHBOARD_PERIODS, DASHBOARD_VIEWS, dashboardSearch, type DashboardFilters, type ViewAccess } from "~/server/services/admin/dashboard/types";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Tabs } from "~/ui/Tabs";
import { useDashT } from "./kit";

export function SearchBox({ defaultValue = "", autoFocus = false }: { defaultValue?: string; autoFocus?: boolean }) {
  const t = useDashT();
  return (
    <Form method="get" action="/admin/dashboard/search" role="search" className="dash-search dash-noprint">
      <TextField name="q" type="search" label={t("search.label")} hint={t("search.hint")} defaultValue={defaultValue} maxLength={60} autoComplete="off" enterKeyHint="search" autoFocus={autoFocus} />
      <Key type="submit" icon="magnifying-glass">
        {t("search.submit")}
      </Key>
    </Form>
  );
}

export function ViewTabs({ filters, views }: { filters: DashboardFilters; views: ViewAccess }) {
  const t = useDashT();
  const available = DASHBOARD_VIEWS.filter((view) => views[view]);
  if (available.length < 2) return null;
  return (
    <Tabs
      aria-label={t("views.label")}
      value={filters.view}
      className="dash-noprint"
      items={available.map((view) => ({ value: view, label: t(`views.${view}`), href: `/admin${dashboardSearch({ ...filters, view, branch: filters.branch })}` }))}
    />
  );
}

export type BranchChoice = { options: { id: string; code: string; name: string }[]; locked: boolean; name: string | null };

export function PeriodBar({ filters, branch }: { filters: DashboardFilters; branch: BranchChoice }) {
  const t = useDashT();
  return (
    <div className="grid gap-2">
      <nav aria-label={t("period.label")} className="dash-period dash-noprint">
        {DASHBOARD_PERIODS.map((period) => {
          const held = filters.period === period;
          return (
            <Key key={period} as={Link} to={`/admin${dashboardSearch({ ...filters, period })}`} size="sm" held={held} aria-current={held ? "true" : undefined}>
              {t(`period.${period}`)}
            </Key>
          );
        })}
        <Key as={Link} to={`/admin${dashboardSearch({ ...filters, demo: !filters.demo })}`} size="sm" variant="ghost" icon={filters.demo ? "eye-slash" : "eye"}>
          {filters.demo ? t("period.demoHide") : t("period.demoShow")}
        </Key>
      </nav>
      <p className="dash-period__note">{t(`period.compare.${filters.period}`)}</p>
      {filters.demo ? (
        <p className="adm-notice adm-notice--warn" role="note">
          {t("period.demoNote")}
        </p>
      ) : null}
      {branch.locked && branch.name ? <p className="dash-period__note">{t("period.branchLocked", { branch: `⁨${branch.name}⁩` })}</p> : null}
      {!branch.locked && branch.options.length > 0 ? (
        <Form method="get" action="/admin" className="dash-branch dash-noprint">
          <input type="hidden" name="period" value={filters.period} />
          {filters.view !== "overview" ? <input type="hidden" name="view" value={filters.view} /> : null}
          {filters.demo ? <input type="hidden" name="demo" value="1" /> : null}
          <Select
            name="branch"
            label={t("period.branch")}
            defaultValue={filters.branch ?? ""}
            options={[{ value: "", label: t("period.branchAll") }, ...branch.options.map((option) => ({ value: option.id, label: `${option.name} (${option.code})` }))]}
          />
          <Key type="submit" size="sm">
            {t("period.branchApply")}
          </Key>
        </Form>
      ) : null}
    </div>
  );
}
