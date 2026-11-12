/**
 * The command centre's tool row: the global search box (01.06 — a GET form, so it works without JavaScript), the
 * role views (01.05, link tabs: only the views this employee has), the period and its comparison (01.04, links that
 * keep the rest of the URL), the demo switch and the branch filter (only when the store has branches; an employee
 * limited to a branch sees their branch named instead). Everything is URL state: shareable and kept on Back.
 *
 * The tabs and the period keys answer a click at once (usePendingFilters: the choice moves while the loader runs) —
 * the tabs' ink marker slides from the old view to the new one, the period's held key moves in its clay tray. Under
 * reduced motion and the lite tier the marker simply moves.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
import { Form, Link } from "react-router";

import { getMotionTier, springTiming } from "~/motion";
import { DASHBOARD_PERIODS, DASHBOARD_VIEWS, dashboardSearch, type DashboardFilters, type DashboardView, type ViewAccess } from "~/server/services/admin/dashboard/types";
import { cx } from "~/ui/cx";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useDashT, usePendingFilters } from "./kit";

/**
 * The global search. `compact`: one line for the command centre's tool row — the label stays for screen readers, the
 * hint is the field's placeholder and its description.
 */
export function SearchBox({ defaultValue = "", autoFocus = false, compact = false }: { defaultValue?: string; autoFocus?: boolean; compact?: boolean }) {
  const t = useDashT();
  return (
    <Form method="get" action="/admin/dashboard/search" role="search" className={cx("dash-search dash-noprint", compact && "dash-search--compact")}>
      <TextField
        name="q"
        type="search"
        label={t("search.label")}
        hideLabel={compact}
        hint={compact ? undefined : t("search.hint")}
        placeholder={compact ? t("search.hint") : undefined}
        title={compact ? t("search.hint") : undefined}
        defaultValue={defaultValue}
        maxLength={60}
        autoComplete="off"
        enterKeyHint="search"
        autoFocus={autoFocus}
      />
      <Key type="submit" icon="magnifying-glass" size={compact ? "sm" : undefined}>
        {t("search.submit")}
      </Key>
    </Form>
  );
}

/**
 * Slide the ink marker of the newly chosen tab from where the previous one was (a FLIP of the marker alone, transform
 * only, on the settle spring); the chosen tab carries `[data-selected]`. Full motion tier only.
 */
function useSlidingMarker(row: RefObject<HTMLElement | null>, value: string) {
  const last = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const marker = row.current?.querySelector<HTMLElement>("[data-selected] .dash-views__marker");
    if (!marker) return;
    const now = marker.getBoundingClientRect();
    const before = last.current;
    last.current = now;
    if (!before || now.width === 0 || (before.left === now.left && before.width === now.width) || getMotionTier() !== "full") return;
    const dx = before.left + before.width / 2 - (now.left + now.width / 2);
    const scale = before.width / now.width;
    marker.animate([{ transform: `translateX(${dx}px) scaleX(${scale})` }, { transform: "none" }], springTiming("settle"));
  }, [row, value]);
}

export function ViewTabs({ filters, views }: { filters: DashboardFilters; views: ViewAccess }) {
  const t = useDashT();
  const pending = usePendingFilters();
  const list = useRef<HTMLUListElement | null>(null);
  const available = DASHBOARD_VIEWS.filter((view) => views[view]);
  const current: DashboardView = pending && views[pending.view] ? pending.view : filters.view;
  useSlidingMarker(list, current);
  if (available.length < 2) return null;
  return (
    <nav aria-label={t("views.label")} className="dash-views dash-noprint">
      <ul ref={list} role="list" className="dash-views__list">
        {available.map((view) => {
          const label = t(`views.${view}`);
          return (
            <li key={view}>
              <Link
                to={`/admin${dashboardSearch({ ...filters, view, branch: filters.branch })}`}
                prefetch="intent"
                preventScrollReset
                className="dash-views__tab"
                aria-current={view === filters.view ? "page" : undefined}
                data-selected={view === current ? "" : undefined}
              >
                {/* the bold copy reserves the width, so turning bold moves nothing */}
                <span className="dash-views__label">
                  <span aria-hidden="true">{label}</span>
                  <span>{label}</span>
                </span>
                <span className="dash-views__marker" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export type BranchChoice = { options: { id: string; code: string; name: string }[]; locked: boolean; name: string | null };

export function PeriodBar({ filters, branch, notes = true }: { filters: DashboardFilters; branch: BranchChoice; notes?: boolean }) {
  const t = useDashT();
  const pending = usePendingFilters();
  const chosen = pending?.period ?? filters.period;
  return (
    <div className="dash-period-bar">
      <div className="dash-period-row">
        {/* the 1.0 key bank: the periods in a clay tray, the chosen one held down */}
        <nav aria-label={t("period.label")} className="dash-period well dash-noprint">
          {DASHBOARD_PERIODS.map((period) => {
            const held = chosen === period;
            return (
              <Key
                key={period}
                as={Link}
                to={`/admin${dashboardSearch({ ...filters, period })}`}
                preventScrollReset
                size="sm"
                held={held}
                aria-current={filters.period === period ? "true" : undefined}
              >
                {t(`period.${period}`)}
              </Key>
            );
          })}
        </nav>
        <Key as={Link} to={`/admin${dashboardSearch({ ...filters, demo: !filters.demo })}`} preventScrollReset size="sm" variant="ghost" icon={filters.demo ? "eye-slash" : "eye"} className="dash-noprint">
          {filters.demo ? t("period.demoHide") : t("period.demoShow")}
        </Key>
      </div>
      {notes ? <PeriodNotes filters={filters} branch={branch} /> : null}
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

/** What the period's figures are compared with, the demo notice and the branch an employee is limited to. */
export function PeriodNotes({ filters, branch }: { filters: DashboardFilters; branch: BranchChoice }) {
  const t = useDashT();
  return (
    <>
      <p className="dash-period__note">{t(`period.compare.${filters.period}`)}</p>
      {filters.demo ? (
        <p className="adm-notice adm-notice--warn dash-demo-note" role="note">
          {t("period.demoNote")}
        </p>
      ) : null}
      {branch.locked && branch.name ? <p className="dash-period__note">{t("period.branchLocked", { branch: `⁨${branch.name}⁩` })}</p> : null}
    </>
  );
}
