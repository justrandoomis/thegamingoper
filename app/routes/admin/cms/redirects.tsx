import { useState } from "react";
import { Form, Link, useFetcher, useLocation } from "react-router";

import type { Route } from "./+types/redirects";
import { listRedirects, parseRedirectFilters, redirectVersion, saveRedirect, setRedirectsActive, type RedirectRow } from "~/server/services/admin/cms/redirects.server";
import { ACTIVE_STATES, REDIRECT_CODES, queryString } from "~/server/services/admin/cms/rules";
import { invalid } from "~/server/errors";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { all, checked, failed, json, ok, openCms, orRespond, text } from "./cms.server";
import { ActionDialog, Code, FormError, LinkChips, LinkState, Note, PageHead, Pager, ResponsiveList, Section, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/redirects — 17.04: 301 (permanent) and 302 (temporary) redirects from an old storefront path to a page
 * that exists — never from or to the admin or the API, never the home page as a source, never a loop or a chain —
 * switched on and off one by one or many at once (with a reason), with how often each was used.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openCms(context, "cms.redirect.manage");
  const url = new URL(request.url);
  const filters = parseRedirectFilters(url.searchParams);
  const list = await orRespond(() => listRedirects(db, actor, filters, now));
  const editId = url.searchParams.get("edit");
  const editing = editId ? (list.rows.find((row) => row.id === editId) ?? null) : null;
  return { list, filters, editing: editing ? { ...editing, version: redirectVersion(editing) } : null };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCms(context, "cms.redirect.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "save":
        return ok(
          intent,
          await saveRedirect(
            req.db,
            req.actor,
            { id: text(form, "id") || undefined, version: text(form, "version") || undefined, fromPath: text(form, "fromPath"), toPath: text(form, "toPath"), code: text(form, "code") || undefined, reason: text(form, "reason") },
            req.now,
            // a full address of this very host is a store path, like tamtamgames.com's
            { origins: [req.ctx.origin] },
          ),
        );
      case "active":
        return ok(intent, await setRedirectsActive(req.db, req.actor, { ids: Array.isArray(json(form, "ids")) ? json(form, "ids") : all(form, "ids"), active: checked(form, "active"), reason: text(form, "reason") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "redirects.title");

export default function RedirectsPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { list, filters, editing } = loaderData;
  const { search } = useLocation();
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<{ ids: string[]; active: boolean } | null>(null);
  const save = useFetcher<Record<string, unknown>>();
  const saved = useResult(save, "save", t("redirects.saved"));
  const href = (state: string) => queryString({ state, q: filters.q }, { state: "all" }) || "?";

  return (
    <>
      <PageHead title={t("redirects.title")} lead={t("redirects.lead")} />

      <Section id="form" title={editing ? t("redirects.editTitle") : t("redirects.newTitle")}>
        <save.Form method="post" className="cms-filters" key={editing?.id ?? "new"}>
          <input type="hidden" name="intent" value="save" />
          {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
          {editing ? <input type="hidden" name="version" value={editing.version} /> : null}
          <TextField name="fromPath" label={t("redirects.from")} hint={t("redirects.fromHint")} defaultValue={editing?.fromPath ?? ""} readOnly={Boolean(editing)} error={saved.fields.fromPath} ltr required />
          <TextField name="toPath" label={t("redirects.to")} hint={t("redirects.toHint")} defaultValue={editing?.toPath ?? ""} error={saved.fields.toPath} ltr required />
          <Select name="code" label={t("redirects.code")} defaultValue={String(editing?.code ?? 301)} options={REDIRECT_CODES.map((code) => ({ value: String(code), label: t(`redirects.codes.${code}`) }))} />
          <TextField name="reason" label={t("common.reason")} hint={t("common.optional")} error={saved.fields.reason} />
          <Key type="submit" variant="ink" size="sm" icon="floppy-disk" loading={saved.pending}>
            {editing ? t("redirects.saveChange") : t("redirects.create")}
          </Key>
          {editing ? (
            <Key as={Link} to={href(filters.state)} size="sm" variant="ghost">
              {t("common.close")}
            </Key>
          ) : null}
          <FormError message={saved.message && Object.keys(saved.fields).length === 0 ? saved.message : null} />
        </save.Form>
        <Note>
          <p>{t("redirects.rules")}</p>
        </Note>
      </Section>

      <Section id="list" title={t("redirects.list")}>
        <LinkChips label={t("common.state")} items={ACTIVE_STATES.map((state) => ({ value: state, label: t(`redirects.state.${state}`), href: href(state), selected: filters.state === state, count: list.counts[state] }))} />
        <Form method="get" className="cms-filters" preventScrollReset>
          {filters.state !== "all" ? <input type="hidden" name="state" value={filters.state} /> : null}
          <TextField name="q" label={t("common.search")} defaultValue={filters.q} ltr />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList<RedirectRow>
          caption={t("redirects.list")}
          rows={list.rows}
          rowKey={(row) => row.id}
          selected={selected}
          onSelectedChange={setSelected}
          bulkActions={(ids) => (
            <>
              <Key size="sm" onClick={() => setBulk({ ids: [...ids], active: true })}>
                {t("redirects.activate")}
              </Key>
              <Key size="sm" variant="ghost" onClick={() => setBulk({ ids: [...ids], active: false })}>
                {t("redirects.deactivate")}
              </Key>
            </>
          )}
          empty={<EmptyState icon="link" title={list.stored === 0 ? t("redirects.empty") : t("common.noMatch")} text={list.stored === 0 ? t("redirects.emptyText") : t("common.noMatchText")} />}
          columns={[
            { key: "from", header: t("redirects.from"), cell: (row) => <Code>{row.fromPath}</Code> },
            {
              key: "to",
              header: t("redirects.to"),
              cell: (row) => (
                <span className="grid gap-0.5">
                  <Code>{row.toPath}</Code>
                  <LinkState state={row.target.state} />
                </span>
              ),
            },
            { key: "code", header: t("redirects.code"), cell: (row) => <bdi className="nums">{row.code}</bdi> },
            { key: "state", header: t("common.state"), cell: (row) => <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("redirects.on") : t("redirects.off")}</Status> },
            { key: "hits", header: t("redirects.hits"), numeric: true, cell: (row) => <bdi className="nums">{row.hits}</bdi> },
            { key: "created", header: t("common.created"), cell: (row) => <When at={row.createdAt} /> },
            {
              key: "edit",
              header: t("common.actions"),
              cell: (row) => (
                <Link to={`${queryString({ state: filters.state, q: filters.q, edit: row.id }, { state: "all" })}#form`} className="adm-link">
                  {t("common.edit")}
                </Link>
              ),
            },
          ]}
          card={(row) => (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Code className="type-strong">{row.fromPath}</Code>
                <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("redirects.on") : t("redirects.off")}</Status>
              </div>
              <p className="type-caption">
                → <Code>{row.toPath}</Code> · <bdi className="nums">{row.code}</bdi>
              </p>
              <LinkState state={row.target.state} />
              <p className="type-caption text-ink-2">{t("redirects.hitsCount", { count: row.hits })}</p>
              <span className="flex flex-wrap gap-3">
                <Link to={`${queryString({ state: filters.state, q: filters.q, edit: row.id }, { state: "all" })}#form`} className="adm-link">
                  {t("common.edit")}
                </Link>
                <button type="button" className="adm-link" onClick={() => setBulk({ ids: [row.id], active: !row.isActive })}>
                  {row.isActive ? t("redirects.deactivate") : t("redirects.activate")}
                </button>
              </span>
            </>
          )}
          footer={<Pager page={list.page} pageCount={list.pageCount} search={search} />}
        />
      </Section>

      <ActionDialog
        open={bulk !== null}
        onClose={() => {
          setBulk(null);
        }}
        tone={bulk?.active ? "neutral" : "destructive"}
        title={bulk?.active ? t("redirects.activateTitle", { count: bulk?.ids.length ?? 0 }) : t("redirects.deactivateTitle", { count: bulk?.ids.length ?? 0 })}
        consequence={bulk?.active ? t("redirects.activateConsequence") : t("redirects.deactivateConsequence")}
        confirmLabel={bulk?.active ? t("redirects.activate") : t("redirects.deactivate")}
        fields={{ intent: "active", active: bulk?.active ? "true" : "false" }}
        extra={() => ({ ids: JSON.stringify(bulk?.ids ?? []) })}
        successMessage={(data) => {
          setSelected([]);
          const skipped = Array.isArray((data as { skipped?: unknown[] }).skipped) ? ((data as { skipped: unknown[] }).skipped.length ?? 0) : 0;
          return skipped > 0 ? t("redirects.changedSkipped", { count: skipped }) : t("redirects.changed");
        }}
      />
    </>
  );
}
