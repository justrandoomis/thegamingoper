import { Form, Link, useFetcher, useLocation } from "react-router";

import type { Route } from "./+types/zero";
import { addQueryAsSynonym, parseZeroFilters, zeroResultQueries, type Suggestion, type ZeroRow } from "~/server/services/admin/cms/search.server";
import { SEARCH_LOCALES, ZERO_RESULT_DAYS, queryString } from "~/server/services/admin/cms/rules";
import { invalid } from "~/server/errors";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { failed, ok, openCms, orRespond, text } from "./cms.server";
import { Code, Figure, FormError, LinkChips, Note, PageHead, Pager, Section, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/search/zero — 17.05: what shoppers searched for and found nothing, over the last 7, 30 or 90 Iraq days
 * (anonymous daily counts), whether each query finds something now, and suggested spellings of the store's own
 * vocabulary to add it to — with the concept's spellings in Arabic, English and Sorani. One click adds the query as a
 * synonym (live at once on this server, everywhere within minutes); a typed target works too.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openCms(context, "cms.search.manage");
  const filters = parseZeroFilters(new URL(request.url).searchParams);
  return { report: await orRespond(() => zeroResultQueries(db, actor, filters, now)), filters };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCms(context, "cms.search.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "add") throw invalid({ intent: "invalid" });
    return ok(intent, { ...(await addQueryAsSynonym(req.db, req.actor, { locale: text(form, "locale"), query: text(form, "query"), target: text(form, "target") }, req.now)), query: text(form, "query") });
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "zero.title");

function SuggestionRow({ row, suggestion }: { row: ZeroRow; suggestion: Suggestion }) {
  const t = useCmsT();
  const add = useFetcher<Record<string, unknown>>();
  const result = useResult(add, "add", t("zero.added", { q: row.query }));
  return (
    <li className="cms-suggestion">
      <span className="grid min-w-0 gap-0.5">
        <span className="type-strong">
          <bdi>{suggestion.label}</bdi>
        </span>
        <span className="type-caption text-ink-2">
          {suggestion.distance === 0 ? t("zero.sameSounds") : t("zero.letters", { count: suggestion.distance })} · {suggestion.source === "synonym" ? t("zero.fromSynonyms") : t("zero.fromNames")}
        </span>
        <span className="flex flex-wrap gap-1">
          {SEARCH_LOCALES.filter((code) => (suggestion.forms[code] ?? []).length > 0).map((code) => (
            <span key={code} className="cms-tag">
              {t(`lang.${code}`)}: <bdi>{(suggestion.forms[code] ?? []).slice(0, 3).join("، ")}</bdi>
            </span>
          ))}
        </span>
        <FormError message={result.message} />
      </span>
      <add.Form method="post">
        <input type="hidden" name="intent" value="add" />
        <input type="hidden" name="locale" value={row.locale} />
        <input type="hidden" name="query" value={row.query} />
        <input type="hidden" name="target" value={suggestion.target} />
        <Key type="submit" size="sm" icon="plus" loading={result.pending} disabled={add.data !== undefined && (add.data as { ok?: boolean }).ok === true}>
          {add.data && (add.data as { ok?: boolean }).ok ? t("zero.done") : t("zero.add")}
        </Key>
      </add.Form>
    </li>
  );
}

function OwnTarget({ row }: { row: ZeroRow }) {
  const t = useCmsT();
  const add = useFetcher<Record<string, unknown>>();
  const result = useResult(add, "add", t("zero.added", { q: row.query }));
  return (
    <add.Form method="post" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="intent" value="add" />
      <input type="hidden" name="locale" value={row.locale} />
      <input type="hidden" name="query" value={row.query} />
      <TextField name="target" label={t("zero.ownTarget")} hint={t("zero.ownTargetHint")} error={result.fields.target ?? result.message ?? undefined} />
      <Key type="submit" size="sm" loading={result.pending}>
        {t("zero.add")}
      </Key>
    </add.Form>
  );
}

export default function ZeroPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { report, filters } = loaderData;
  const { search } = useLocation();
  const href = (changes: Record<string, string | number | null>) => queryString({ days: filters.days, locale: filters.locale, ...changes }, { days: 30 }) || "?";
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/cms/search" className="adm-link">
            {t("search.title")}
          </Link>
        }
        title={t("zero.title")}
        lead={t("zero.lead")}
      />
      <div className="cms-figures mb-5">
        <Figure label={t("zero.searched")} value={String(report.searched)} hint={t("zero.range", { from: report.from, to: report.to })} />
        <Figure label={t("zero.zeroCount")} value={String(report.zero)} />
        <Figure label={t("zero.queries")} value={String(report.total)} />
      </div>
      <div className="grid gap-3">
        <LinkChips label={t("zero.period")} items={ZERO_RESULT_DAYS.map((days) => ({ value: String(days), label: t("zero.days", { count: days }), href: href({ days }), selected: filters.days === days }))} />
        <Form method="get" className="cms-filters" preventScrollReset>
          <input type="hidden" name="days" value={String(filters.days)} />
          <Select name="locale" label={t("search.locale")} defaultValue={filters.locale ?? ""} options={[{ value: "", label: t("common.all") }, ...SEARCH_LOCALES.map((code) => ({ value: code, label: t(`lang.${code}`) }))]} />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
      </div>
      <Section id="queries" title={t("zero.list")} className="mt-5">
        {report.rows.length === 0 ? (
          <EmptyState icon="magnifying-glass" title={t("zero.empty")} text={t("zero.emptyText")} />
        ) : (
          <ul role="list" className="grid gap-3">
            {report.rows.map((row) => (
              <li key={`${row.locale}:${row.query}`} className="adm-card gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="grid gap-0.5">
                    <Code ltr={row.locale === "en"} className="type-strong">
                      {row.query}
                    </Code>
                    <span className="type-caption text-ink-2">
                      {t(`lang.${row.locale}`)} · {t("zero.counts", { zero: row.zeroResults, searches: row.searches })} · {t("zero.daysSeen", { count: row.days })} · <When at={row.lastAt} />
                    </span>
                  </span>
                  {row.matchesNow > 0 ? <Status tone="ok">{t("zero.matchesNow", { count: row.matchesNow })}</Status> : <Status tone="warn">{t("zero.stillNone")}</Status>}
                </div>
                {row.matchesNow === 0 ? (
                  <>
                    {row.suggestions.length > 0 ? (
                      <ul role="list" className="cms-suggestions" aria-label={t("zero.suggestions")}>
                        {row.suggestions.map((suggestion) => (
                          <SuggestionRow key={suggestion.target} row={row} suggestion={suggestion} />
                        ))}
                      </ul>
                    ) : (
                      <p className="type-caption text-ink-2">{t("zero.noSuggestion")}</p>
                    )}
                    <OwnTarget row={row} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Pager page={report.page} pageCount={report.pageCount} search={search} />
      </Section>
      <Note>
        <p>{t("zero.note")}</p>
      </Note>
    </>
  );
}
