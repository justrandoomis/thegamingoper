import { useState } from "react";
import { Form, Link, useFetcher, useLocation } from "react-router";

import type { Route } from "./+types/search";
import { getSynonym, listSynonyms, parseSynonymFilters, saveSynonym, setSynonymActive, trySearch, type SynonymRow } from "~/server/services/admin/cms/search.server";
import { ACTIVE_STATES, SEARCH_LOCALES, SYNONYM_LIMITS, queryString } from "~/server/services/admin/cms/rules";
import { invalid, isAppError } from "~/server/errors";
import { isLocale } from "~/lib/locales";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { checked, failed, ok, openCms, orRespond, raw, text } from "./cms.server";
import { ActionDialog, Code, FormError, LinkChips, Note, PageHead, Pager, ResponsiveList, Section, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/search — 17.03 / 17.05: the synonym sets the storefront search expands queries with (ar/en/ckb; sets that
 * share a spelling become one concept), stored normalised as the index is; switch a set off or on; and try a query
 * against the live search. The searches that found nothing are on /admin/cms/search/zero.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context, "cms.search.manage");
  const url = new URL(request.url);
  const filters = parseSynonymFilters(url.searchParams);
  const editId = url.searchParams.get("edit");
  const tryQ = (url.searchParams.get("try") ?? "").slice(0, 120);
  const tryLocaleParam = url.searchParams.get("tryLocale");
  const tryLocale = isLocale(tryLocaleParam) ? tryLocaleParam : locale;
  // a stale edit link (an unknown set) leaves the editor closed instead of answering 404 for the whole page
  const editingSet = () => (editId && editId !== "new" ? getSynonym(db, actor, editId).catch((error: unknown) => (isAppError(error, "not_found") ? null : Promise.reject(error))) : Promise.resolve(null));
  const [list, editing, tried] = await orRespond(() => Promise.all([listSynonyms(db, actor, filters), editingSet(), tryQ ? trySearch(db, actor, { q: tryQ, locale: tryLocale }, now) : Promise.resolve(null)]));
  return { list, filters, editing, editNew: editId === "new", tryQ, tryLocale, tried };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCms(context, "cms.search.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "save":
        return ok(intent, await saveSynonym(req.db, req.actor, { id: text(form, "id") || undefined, version: text(form, "version") || undefined, locale: text(form, "locale"), term: text(form, "term"), synonyms: raw(form, "synonyms") }, req.now));
      case "active":
        return ok(intent, await setSynonymActive(req.db, req.actor, { id: text(form, "id"), version: text(form, "version"), active: checked(form, "active"), reason: text(form, "reason") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "search.title");

export default function SearchPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { list, filters, editing, editNew, tryQ, tryLocale, tried } = loaderData;
  const { search } = useLocation();
  const [toggle, setToggle] = useState<SynonymRow | null>(null);
  const save = useFetcher<Record<string, unknown>>();
  const saved = useResult(save, "save", t("search.saved"));
  const result = save.data && (save.data as { ok?: boolean }).ok ? (save.data as { term: string; synonyms: string[]; joins: { id: string; locale: string; term: string }[] }) : null;
  const href = (changes: Record<string, string | null>) => queryString({ locale: filters.locale, state: filters.state, q: filters.q, ...changes }, { state: "all" }) || "?";
  const showEditor = editNew || editing !== null;
  const editHref = (id: string) => `${href({ edit: id })}#editor`;

  return (
    <>
      <PageHead
        title={t("search.title")}
        lead={t("search.lead")}
        actions={
          <>
            <Key as={Link} to="/admin/cms/search/zero" size="sm" icon="magnifying-glass">
              {t("search.zeroLink")}
            </Key>
            <Key as={Link} to={editHref("new")} size="sm" icon="plus">
              {t("search.new")}
            </Key>
          </>
        }
      />

      <Section id="try" title={t("search.try")}>
        <Form method="get" className="cms-filters" preventScrollReset>
          <TextField name="try" label={t("search.tryQuery")} defaultValue={tryQ} />
          <Select name="tryLocale" label={t("search.tryLocale")} defaultValue={tryLocale} options={SEARCH_LOCALES.map((code) => ({ value: code, label: t(`lang.${code}`) }))} />
          <Key type="submit" size="sm" icon="magnifying-glass">
            {t("search.tryGo")}
          </Key>
        </Form>
        {tried ? (
          <div className="adm-card gap-1.5" role="status">
            <p className="type-strong">{tried.total > 0 ? t("search.tryFound", { count: tried.total }) : t("search.tryNone")}</p>
            {tried.correctedQuery ? <p className="type-caption text-ink-2">{t("search.tryCorrected", { q: tried.correctedQuery })}</p> : null}
            <ul role="list" className="grid gap-1">
              {tried.top.map((item) => (
                <li key={item.id} className="type-body">
                  {item.name} · <Code>{`/p/${item.slug}`}</Code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="sets" title={t("search.sets")}>
        <LinkChips
          label={t("search.byLocale")}
          items={[
            { value: "all", label: t("common.all"), href: href({ locale: null }), selected: filters.locale === null, count: list.counts.all },
            ...SEARCH_LOCALES.map((code) => ({ value: code, label: t(`lang.${code}`), href: href({ locale: code }), selected: filters.locale === code, count: list.counts[code] })),
          ]}
        />
        <Form method="get" className="cms-filters" preventScrollReset>
          {filters.locale ? <input type="hidden" name="locale" value={filters.locale} /> : null}
          <TextField name="q" label={t("common.search")} defaultValue={filters.q} />
          <Select name="state" label={t("common.state")} defaultValue={filters.state} options={ACTIVE_STATES.map((value) => ({ value, label: t(`search.state.${value}`) }))} />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList<SynonymRow>
          caption={t("search.sets")}
          rows={list.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState icon="magnifying-glass" title={list.stored === 0 ? t("search.empty") : t("common.noMatch")} text={t("common.noMatchText")} />}
          columns={[
            { key: "term", header: t("search.term"), cell: (row) => <Code ltr={row.locale === "en"}>{row.term}</Code> },
            {
              key: "synonyms",
              header: t("search.synonyms"),
              cell: (row) => (
                <span className="flex flex-wrap gap-1">
                  {row.synonyms.map((form) => (
                    <span key={form} className="cms-tag">
                      <bdi>{form}</bdi>
                    </span>
                  ))}
                </span>
              ),
            },
            { key: "locale", header: t("search.locale"), cell: (row) => t(`lang.${row.locale}`) },
            { key: "state", header: t("common.state"), cell: (row) => <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("search.active") : t("search.inactive")}</Status> },
            { key: "updated", header: t("common.updated"), cell: (row) => <When at={row.updatedAt} /> },
            {
              key: "actions",
              header: t("common.actions"),
              cell: (row) => (
                <span className="flex flex-wrap gap-2">
                  <Link to={editHref(row.id)} className="adm-link">
                    {t("common.edit")}
                  </Link>
                  <button type="button" className="adm-link" onClick={() => setToggle(row)}>
                    {row.isActive ? t("search.deactivate") : t("search.activate")}
                  </button>
                </span>
              ),
            },
          ]}
          card={(row) => (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Code ltr={row.locale === "en"} className="type-strong">
                  {row.term}
                </Code>
                <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("search.active") : t("search.inactive")}</Status>
              </div>
              <p className="type-caption text-ink-2">{t(`lang.${row.locale}`)}</p>
              <span className="flex flex-wrap gap-1">
                {row.synonyms.map((form) => (
                  <span key={form} className="cms-tag">
                    <bdi>{form}</bdi>
                  </span>
                ))}
              </span>
              <span className="flex flex-wrap gap-3">
                <Link to={editHref(row.id)} className="adm-link">
                  {t("common.edit")}
                </Link>
                <button type="button" className="adm-link" onClick={() => setToggle(row)}>
                  {row.isActive ? t("search.deactivate") : t("search.activate")}
                </button>
              </span>
            </>
          )}
          footer={<Pager page={list.page} pageCount={list.pageCount} search={search} />}
        />
      </Section>

      {showEditor ? (
        <Section id="editor" title={editing ? t("search.editTitle") : t("search.newTitle")}>
          <save.Form method="post" className="adm-card grid gap-3" key={editing?.id ?? "new"}>
            <input type="hidden" name="intent" value="save" />
            {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
            {editing ? <input type="hidden" name="version" value={String(editing.updatedAt)} /> : null}
            <Select name="locale" label={t("search.locale")} defaultValue={editing?.locale ?? filters.locale ?? "ar"} options={SEARCH_LOCALES.map((code) => ({ value: code, label: t(`lang.${code}`) }))} error={saved.fields.locale} required />
            <TextField name="term" label={t("search.term")} hint={t("search.termHint")} defaultValue={editing?.term ?? ""} maxLength={SYNONYM_LIMITS.form} error={saved.fields.term} required />
            <TextArea name="synonyms" label={t("search.synonyms")} hint={t("search.synonymsHint", { count: SYNONYM_LIMITS.forms })} defaultValue={editing?.synonyms.join("\n") ?? ""} rows={5} error={saved.fields.synonyms} required />
            <FormError message={saved.message && Object.keys(saved.fields).length === 0 ? saved.message : null} />
            {result ? (
              <Note tone={result.joins.length > 0 ? "warn" : "ok"} icon={result.joins.length > 0 ? "warning-circle" : "check-circle"}>
                <p>{t("search.savedAs", { term: result.term, forms: result.synonyms.join("، ") })}</p>
                {result.joins.length > 0 ? <p>{t("search.joins", { list: result.joins.map((row) => row.term).join("، ") })}</p> : null}
              </Note>
            ) : null}
            <div className="cms-actions">
              <Key type="submit" variant="ink" icon="floppy-disk" loading={saved.pending}>
                {t("search.save")}
              </Key>
              <Key as={Link} to={href({})} variant="ghost" size="sm">
                {t("common.close")}
              </Key>
            </div>
            <p className="type-caption text-ink-2">{t("search.liveNote")}</p>
          </save.Form>
        </Section>
      ) : null}

      <ActionDialog
        open={toggle !== null}
        onClose={() => setToggle(null)}
        tone={toggle?.isActive ? "destructive" : "neutral"}
        title={toggle?.isActive ? t("search.deactivateTitle", { term: toggle?.term ?? "" }) : t("search.activateTitle", { term: toggle?.term ?? "" })}
        consequence={toggle?.isActive ? t("search.deactivateConsequence") : t("search.activateConsequence")}
        confirmLabel={toggle?.isActive ? t("search.deactivate") : t("search.activate")}
        fields={{ intent: "active", id: toggle?.id ?? "", version: String(toggle?.updatedAt ?? ""), active: toggle?.isActive ? "false" : "true" }}
        successMessage={t("search.saved")}
      />
    </>
  );
}
