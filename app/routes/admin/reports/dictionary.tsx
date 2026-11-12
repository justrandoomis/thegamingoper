import { Form, Link } from "react-router";

import type { Route } from "./+types/dictionary";
import { groupOf, METRIC_GROUPS, METRICS, type MetricEntry } from "~/server/services/admin/reports/dictionary";
import { reportsAccess } from "~/server/services/admin/reports/shared.server";
import { latinDigits, REPORT_PATH } from "~/server/services/admin/reports/types";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { reportsMeta } from "./meta";
import { openReports, reportsT } from "./reports.server";
import { Code, Note, PageHead, Section, useRepT } from "./ui";

/**
 * /admin/reports/dictionary — 18.07: the one metrics dictionary. Every metric of docs/metrics.md §3–§6 under its own
 * name (tests keep the two in step), then the reports' own figures, each written as a composition of those or as the
 * owning module's rule — with the permissions a figure needs, the reports that show it and the code that computes
 * it (accounting/reports.server.ts for revenue, cost and profit). Read-only for everyone with a reports permission:
 * a definition changes only with docs/metrics.md and its implementation, never through a form. Search in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { actor, locale } = await openReports(context);
  const q = (new URL(request.url).searchParams.get("q") ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60);
  const t = reportsT(locale);
  const needle = latinDigits(q).toLowerCase();
  const matches = (entry: MetricEntry) => {
    if (!needle) return true;
    const words = [t(`dict.metric.${entry.id}.name`), t(`dict.metric.${entry.id}.def`), entry.origin.kind === "metrics" ? entry.origin.docName : "", entry.code].join(" ").toLowerCase();
    return words.includes(needle);
  };
  return { q, ids: METRICS.filter(matches).map((entry) => entry.id), access: reportsAccess(actor) };
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, "dictionary.title");

export default function DictionaryPage({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const { q, ids, access } = loaderData;
  const shown = new Set(ids);
  const entries = METRICS.filter((entry) => shown.has(entry.id));
  return (
    <>
      <PageHead eyebrow={t("dictionary.eyebrow")} title={t("dictionary.title")} lead={t("dictionary.lead")} />
      <Note icon="seal-check">
        <p>{t("dictionary.oneSource")}</p>
        <p className="type-caption text-ink-2">{t("dictionary.readOnly")}</p>
      </Note>
      <Form method="get" action="/admin/reports/dictionary" className="rep-noprint mt-4 flex flex-wrap items-end gap-2">
        <TextField name="q" type="search" label={t("dictionary.search")} defaultValue={q} className="w-72" />
        <Key type="submit" size="sm" icon="magnifying-glass">
          {t("common.search")}
        </Key>
        {q ? (
          <Key as={Link} to="/admin/reports/dictionary" size="sm" variant="ghost" icon="x">
            {t("common.clear")}
          </Key>
        ) : null}
      </Form>
      {entries.length === 0 ? <EmptyState icon="magnifying-glass" title={t("dictionary.noMatch", { q })} /> : null}
      {METRIC_GROUPS.map((group) => {
        const list = entries.filter((entry) => groupOf(entry) === group);
        if (list.length === 0) return null;
        return (
          <Section key={group} id={`dict-${group}`} title={t(`dictionary.group.${group}`)}>
            <dl className="grid gap-2">
              {list.map((entry) => (
                <div key={entry.id} id={`metric-${entry.id}`} className="adm-card gap-1.5">
                  <dt className="flex flex-wrap items-center gap-2 type-label">
                    <span>{t(`dict.metric.${entry.id}.name`)}</span>
                    {entry.origin.kind === "metrics" ? (
                      <span className="type-caption text-ink-2" lang="en" dir="ltr">
                        {entry.origin.docName}
                      </span>
                    ) : null}
                    {entry.needs.map((permission) => (
                      <span key={permission} className="rep-flag">
                        <Code>{permission}</Code>
                      </span>
                    ))}
                    {!entry.available ? <Status tone="neutral">{t("dictionary.notMeasured")}</Status> : null}
                  </dt>
                  <dd className="grid gap-1">
                    <p className="type-body text-ink">{t(`dict.metric.${entry.id}.def`)}</p>
                    <p className="type-caption text-ink-2">
                      {entry.origin.kind === "metrics" ? t("dictionary.fromDoc", { section: entry.origin.section }) : t("dictionary.fromModule", { module: entry.origin.module })}
                      {entry.code !== "—" ? (
                        <>
                          {" · "}
                          {t("dictionary.code")}{" "}
                          {/* a file path: left-to-right and free to break anywhere, so a phone never scrolls sideways */}
                          <bdi dir="ltr" className="break-all">
                            {entry.code}
                          </bdi>
                        </>
                      ) : null}
                    </p>
                    {entry.usedIn.length > 0 ? (
                      <p className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
                        {t("dictionary.usedIn")}
                        {entry.usedIn.map((key) =>
                          access.reports[key] ? (
                            <Link key={key} to={REPORT_PATH(key)} className="adm-link">
                              {t(`${key}.title`)}
                            </Link>
                          ) : (
                            <span key={key}>{t(`${key}.title`)}</span>
                          ),
                        )}
                      </p>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
        );
      })}
    </>
  );
}
