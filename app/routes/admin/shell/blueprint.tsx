import { data, Form, Link } from "react-router";

import type { Route } from "./+types/blueprint";
import { useLocale } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { BLUEPRINT_STATUSES, statusCounts, statusOf, type BlueprintStatus } from "../blueprint-status";
import { visibleModules } from "./access.server";
import { BLUEPRINT_FUNCTION_IDS, BLUEPRINT_MODULES, BLUEPRINT_PRIORITIES, BLUEPRINT_SOURCE } from "./blueprint-catalog";
import { parseBlueprintFilters } from "./blueprint-filters";
import { functionAnchor, STATUS_TONE } from "./FunctionList";
import { useAdminT } from "./i18n";
import { adminMeta } from "./meta";
import { moduleById } from "./modules";
import { matchesTokens, normalizeSearch, queryTokens } from "./search";

/**
 * /admin/blueprint — the client's admin blueprint (23 modules, 176 functions) against what exists in the admin today
 * (app/routes/admin/blueprint-status.ts). Every employee who may open at least one section may read it (403 for an
 * account without any admin permission — a new or emptied account sees only its own security page); module names link
 * only where the employee's role may open the module. Filters live in the URL (status, priority, module, q) — a plain
 * GET form, so they work without JavaScript and survive Back. The catalogue itself ships in this page's JavaScript, so
 * it must never hold anything secret.
 */
export async function loader({ context, url }: Route.LoaderArgs) {
  const { actor } = await requireEmployee(getCtx(context), getDb());
  const openable = visibleModules(actor) as string[];
  if (openable.length === 0) throw data({ error: "forbidden" }, { status: 403 });
  return { filters: parseBlueprintFilters(url.searchParams), openable };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("blueprint.title"));

export default function BlueprintPage({ loaderData }: Route.ComponentProps) {
  const t = useAdminT();
  const locale = useLocale();
  const lang = locale === "en" ? "en" : "ar";
  const { filters, openable } = loaderData;
  const canOpen = new Set(openable);
  const all = statusCounts();
  const tokens = queryTokens(filters.q);
  const filtered = Boolean(filters.status || filters.priority || filters.module || tokens.length);

  const matrix = BLUEPRINT_MODULES.filter((module) => !filters.priority || module.priority === filters.priority);
  const groups = BLUEPRINT_MODULES.filter((module) => (!filters.priority || module.priority === filters.priority) && (!filters.module || module.id === filters.module))
    .map((module) => ({
      module,
      functions: module.functions.filter((fn) => (!filters.status || statusOf(fn.id).status === filters.status) && matchesTokens(normalizeSearch(`${fn.ar} ${fn.en} ${fn.id}`), tokens)),
    }))
    .filter((group) => group.functions.length > 0);
  const shown = groups.reduce((sum, group) => sum + group.functions.length, 0);

  const moduleName = (id: string) => {
    const module = moduleById(id);
    const blueprint = BLUEPRINT_MODULES.find((entry) => entry.id === id);
    const name = module ? t(`modules.${module.slug}`) : (blueprint?.[lang] ?? id);
    if (!module) return <span>{name}</span>;
    return canOpen.has(module.slug) || module.slug === "dashboard" ? (
      <Link to={module.href} className="adm-link">
        {name}
      </Link>
    ) : (
      <span title={t("blueprint.notYours")}>{name}</span>
    );
  };
  const cellLink = (moduleId: string, status: BlueprintStatus, count: number) =>
    count === 0 ? (
      <span className="text-ink-3">0</span>
    ) : (
      <Link to={`?module=${moduleId}&status=${status}#functions`} className="adm-link nums" preventScrollReset={false}>
        {count}
      </Link>
    );

  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("blueprint.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink">{t("blueprint.lead", { functions: BLUEPRINT_FUNCTION_IDS.length, modules: BLUEPRINT_MODULES.length })}</p>
        <p className="type-caption text-ink-2">{t("blueprint.source", { source: BLUEPRINT_SOURCE })}</p>
      </header>

      <section className="adm-section" aria-labelledby="bp-legend">
        <h2 id="bp-legend" className="adm-h2">
          {t("blueprint.legendTitle")}
        </h2>
        <dl className="adm-grid">
          {BLUEPRINT_STATUSES.map((status) => (
            <div key={status} className="adm-card">
              <dt className="flex items-center justify-between gap-2">
                <Status tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Status>
                <span className="type-kpi nums">
                  <bdi>{all[status]}</bdi>
                </span>
              </dt>
              <dd className="type-caption text-ink-2">{t(`status.help.${status}`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="adm-section" aria-labelledby="bp-matrix">
        <h2 id="bp-matrix" className="adm-h2">
          {t("blueprint.matrixTitle")}
        </h2>
        <div className="overflow-x-auto rounded-xs border border-line">
          <table className="table">
            <caption className="sr-only">{t("blueprint.matrixCaption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("blueprint.colModule")}</th>
                <th scope="col">{t("blueprint.colPriority")}</th>
                {BLUEPRINT_STATUSES.map((status) => (
                  <th key={status} scope="col" className="is-num">
                    {t(`status.${status}`)}
                  </th>
                ))}
                <th scope="col" className="min-w-[8rem]">
                  {t("blueprint.colProgress")}
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((module) => {
                const counts = statusCounts(module.id);
                return (
                  <tr key={module.id}>
                    <td>
                      <span className="flex items-center gap-2">
                        <bdi dir="ltr" className="nums text-ink-2">
                          {module.id}
                        </bdi>
                        {moduleName(module.id)}
                      </span>
                    </td>
                    <td>
                      <span title={t(`priority.${module.priority}`)}>
                        <bdi dir="ltr">{module.priority}</bdi>
                      </span>
                    </td>
                    {BLUEPRINT_STATUSES.map((status) => (
                      <td key={status} className="is-num">
                        {cellLink(module.id, status, counts[status])}
                      </td>
                    ))}
                    <td>
                      <div className="adm-progress" role="img" aria-label={`${counts.implemented + counts.partial} / ${counts.total}`}>
                        {counts.implemented > 0 ? <span className="adm-progress__done" style={{ inlineSize: `${(counts.implemented / counts.total) * 100}%` }} /> : null}
                        {counts.partial > 0 ? <span className="adm-progress__partial" style={{ inlineSize: `${(counts.partial / counts.total) * 100}%` }} /> : null}
                        {counts.boundary > 0 ? <span className="adm-progress__boundary" style={{ inlineSize: `${(counts.boundary / counts.total) * 100}%` }} /> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="font-semibold">
                  {t("blueprint.total")}
                </td>
                {BLUEPRINT_STATUSES.map((status) => (
                  <td key={status} className="is-num font-semibold">
                    <bdi>{all[status]}</bdi>
                  </td>
                ))}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="adm-section" aria-labelledby="bp-filters">
        <h2 id="bp-filters" className="adm-h2">
          {t("blueprint.filtersTitle")}
        </h2>
        <Form method="get" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]" preventScrollReset>
          <Select
            label={t("blueprint.filterStatus")}
            name="status"
            defaultValue={filters.status ?? ""}
            options={[{ value: "", label: t("blueprint.all") }, ...BLUEPRINT_STATUSES.map((status) => ({ value: status, label: t(`status.${status}`) }))]}
          />
          <Select
            label={t("blueprint.filterPriority")}
            name="priority"
            defaultValue={filters.priority ?? ""}
            options={[{ value: "", label: t("blueprint.all") }, ...BLUEPRINT_PRIORITIES.map((priority) => ({ value: priority, label: `${priority} · ${t(`priority.${priority}`)}` }))]}
          />
          <Select
            label={t("blueprint.filterModule")}
            name="module"
            defaultValue={filters.module ?? ""}
            options={[{ value: "", label: t("blueprint.all") }, ...BLUEPRINT_MODULES.map((module) => ({ value: module.id, label: `${module.id} · ${module[lang]}` }))]}
          />
          <TextField label={t("blueprint.filterQuery")} hint={t("blueprint.filterQueryHint")} name="q" type="search" defaultValue={filters.q} />
          <div className="flex gap-2 self-center">
            <Key type="submit" variant="ink">
              {t("blueprint.apply")}
            </Key>
            {filtered ? (
              <Key as={Link} to="/admin/blueprint" preventScrollReset>
                {t("blueprint.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
      </section>

      <section className="adm-section" aria-labelledby="bp-functions" id="functions">
        <div className="adm-section__head">
          <h2 id="bp-functions" className="adm-h2">
            {t("blueprint.functionsTitle")}
          </h2>
          <p className="type-caption text-ink-2" aria-live="polite">
            {t("blueprint.shown", { count: shown })}
          </p>
        </div>
        {groups.length === 0 ? (
          <div className="adm-card">
            <p className="type-strong text-ink">{t("blueprint.none")}</p>
            <p className="type-caption text-ink-2">{t("blueprint.noneHint")}</p>
          </div>
        ) : (
          groups.map(({ module, functions }) => (
            <div key={module.id} className="grid gap-2">
              <h3 className="adm-h3 flex flex-wrap items-baseline gap-2">
                <bdi dir="ltr" className="nums text-ink-2">
                  {module.id}
                </bdi>
                {moduleName(module.id)}
              </h3>
              <ol className="adm-fn-list">
                {functions.map((fn) => {
                  const entry = statusOf(fn.id);
                  return (
                    <li key={fn.id} id={`bp-${functionAnchor(fn.id)}`} className="adm-fn">
                      <span className="adm-fn__id">
                        <bdi dir="ltr">{fn.id}</bdi>
                      </span>
                      <p className="type-body text-ink">{fn[lang]}</p>
                      <div className="adm-fn__state">
                        <Status tone={STATUS_TONE[entry.status]}>{t(`status.${entry.status}`)}</Status>
                        {entry.note ? <p className="type-caption text-ink-2">{entry.note[lang]}</p> : null}
                        {entry.route ? (
                          <TextLink as={Link} to={entry.route}>
                            {t("fn.open")}
                          </TextLink>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))
        )}
      </section>
    </>
  );
}
