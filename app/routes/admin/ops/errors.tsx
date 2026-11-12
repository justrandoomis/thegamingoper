import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/errors";
import { useFormat } from "~/i18n/react";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import { listErrors, setErrorStatus } from "~/server/services/admin/ops/telemetry.server";
import { ERROR_LEVELS, ERROR_LEVEL_TONE, ERROR_SORTS, ERROR_SOURCES, ERROR_STATUS_TONE, ERROR_VIEWS, ERROR_WINDOWS, errorSearch, parseErrorFilters, type ErrorRow } from "~/server/services/admin/ops/types";
import { invalid } from "~/server/errors";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { CloudflareSteps } from "./components/Cloudflare";
import { ActionDialog, Ago, Code, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, StatusText, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { all, ok, ops, text } from "./ops.server";

/**
 * /admin/ops/errors — 23.01: the errors the app records itself (one row per kind of error, its count, first and last
 * time), with views, filters and sort in the URL, resolve / ignore / reopen with a reason (ops.error.resolve, at most
 * 25 at a time) and "open an incident" with the selected ones. Where the full picture is — Cloudflare's Workers Logs —
 * step by step.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.error.read");
  const filters = parseErrorFilters(new URL(args.request.url).searchParams);
  const page = await ops.orRespond(req, () => listErrors(req.db, req.actor, filters, req.now));
  return { page, filters, access: opsAccess(req.actor), now: req.now };
}

export async function action(args: Route.ActionArgs) {
  const req = await ops.open(args, "ops.error.resolve");
  let intent: string | null = null;
  try {
    const form = await ops.form(args.request);
    intent = text(form, "intent");
    if (intent !== "status") throw invalid({ intent: "invalid" });
    return ok(intent, await setErrorStatus(req.db, req.actor, { ids: all(form, "ids"), status: text(form, "status"), reason: text(form, "reason") }, req.now));
  } catch (error) {
    return ops.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "errorList.title");

export default function ErrorsPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { page, filters, access, now } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState<"resolved" | "ignored" | "open" | null>(null);
  const href = (next: Partial<typeof filters>) => `/admin/ops/errors${errorSearch({ ...filters, page: 1, ...next })}`;
  const message = (row: ErrorRow) => (
    <span className="grid">
      <Link to={`/admin/ops/errors/${row.id}`} className="adm-link line-clamp-2">
        <bdi dir="ltr">{row.message}</bdi>
      </Link>
      {row.route ? (
        <span className="type-caption text-ink-2">
          <Code>{row.route}</Code>
        </span>
      ) : null}
    </span>
  );
  const columns: DataColumn<ErrorRow>[] = [
    { key: "level", header: t("errorList.col.level"), cell: (row) => <StatusText tone={ERROR_LEVEL_TONE[row.level]}>{t(`errorReport.level.${row.level}`)}</StatusText> },
    { key: "source", header: t("errorList.col.source"), cell: (row) => t(`errorReport.source.${row.source}`) },
    { key: "message", header: t("errorList.col.message"), cell: message },
    { key: "count", header: t("errorList.col.count"), numeric: true, cell: (row) => f.number(row.count) },
    { key: "last", header: t("errorList.col.last"), cell: (row) => <Ago at={row.lastSeenAt} now={now} /> },
    { key: "status", header: t("errorList.col.status"), cell: (row) => <StatusText tone={ERROR_STATUS_TONE[row.status]}>{t(`errorReport.status.${row.status}`)}</StatusText> },
    {
      key: "incident",
      header: t("errorList.col.incident"),
      cell: (row) =>
        row.incident ? (
          row.incident.href ? (
            <Link to={row.incident.href} className="adm-link">
              <Code>{row.incident.ref}</Code>
            </Link>
          ) : (
            <Code>{row.incident.ref}</Code>
          )
        ) : (
          <span className="text-ink-2">—</span>
        ),
    },
  ];
  const selectable = access.resolveErrors;
  const bulkKeys = (ids: readonly string[]) => (
    <>
      {filters.view === "open" || filters.view === "all" ? (
        <>
          <Key size="sm" onClick={() => setTarget("resolved")} disabled={ids.length > 25}>
            {t("errorList.bulk.resolve")}
          </Key>
          <Key size="sm" variant="ghost" onClick={() => setTarget("ignored")} disabled={ids.length > 25}>
            {t("errorList.bulk.ignore")}
          </Key>
        </>
      ) : (
        <Key size="sm" onClick={() => setTarget("open")} disabled={ids.length > 25}>
          {t("errorList.bulk.reopen")}
        </Key>
      )}
      {access.manageIncidents ? (
        <Key size="sm" variant="ghost" as={Link} to={`/admin/ops/incidents/new?${ids.slice(0, 20).map((id) => `error=${encodeURIComponent(id)}`).join("&")}`}>
          {t("errorList.bulk.incident")}
        </Key>
      ) : null}
    </>
  );

  return (
    <>
      <PageHead title={t("errorList.title")} lead={t("errorList.lead")} />
      <Note icon="info">
        <p>{t("errorList.recorded")}</p>
        <p className="type-caption text-ink-2">{t("errorList.recordedHint", { count: page.occurrences24h })}</p>
      </Note>

      <Section id="ops-errors" title={t(`errorList.view.${filters.view}`)} aside={<span className="type-caption text-ink-2">{t("errorList.count", { count: page.total })}</span>}>
        <LinkChips label={t("errorList.views")} items={ERROR_VIEWS.map((view) => ({ value: view, label: t(`errorList.view.${view}`), href: href({ view }), selected: filters.view === view, count: page.counts[view] }))} />
        <Form method="get" className="ops-filters" preventScrollReset>
          {filters.view !== "open" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <Select name="source" label={t("errorList.filter.source")} defaultValue={filters.source ?? ""} options={[{ value: "", label: t("common.all") }, ...ERROR_SOURCES.map((source) => ({ value: source, label: t(`errorReport.source.${source}`) }))]} />
          <Select name="level" label={t("errorList.filter.level")} defaultValue={filters.level ?? ""} options={[{ value: "", label: t("common.all") }, ...ERROR_LEVELS.map((level) => ({ value: level, label: t(`errorReport.level.${level}`) }))]} />
          <Select name="window" label={t("errorList.filter.window")} defaultValue={filters.window} options={ERROR_WINDOWS.map((window) => ({ value: window, label: t(`errorList.window.${window}`) }))} />
          <TextField name="q" label={t("errorList.filter.q")} defaultValue={filters.q} maxLength={100} />
          <Select name="sort" label={t("common.sort")} defaultValue={filters.sort} options={ERROR_SORTS.map((sort) => ({ value: sort, label: t(`errorList.sort.${sort}`) }))} />
          <div className="flex gap-2">
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.source || filters.level || filters.q || filters.window !== "all" ? (
              <Key as={Link} to={href({ source: null, level: null, q: "", window: "all" })} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t(`errorList.view.${filters.view}`)}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.message.slice(0, 60)}
          selected={selectable ? selected : undefined}
          onSelectedChange={selectable ? setSelected : undefined}
          bulkActions={selectable ? bulkKeys : undefined}
          empty={<EmptyState title={t("errorList.empty")} text={t("errorList.emptyHint")} icon="bug" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/ops/errors${errorSearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <StatusText tone={ERROR_LEVEL_TONE[row.level]}>{t(`errorReport.level.${row.level}`)}</StatusText>
                <StatusText tone={ERROR_STATUS_TONE[row.status]}>{t(`errorReport.status.${row.status}`)}</StatusText>
              </div>
              {message(row)}
              <Pair label={t("errorList.col.source")}>{t(`errorReport.source.${row.source}`)}</Pair>
              <Pair label={t("errorList.col.count")}>{f.number(row.count)}</Pair>
              <Pair label={t("errorList.col.last")}>
                <Ago at={row.lastSeenAt} now={now} />
              </Pair>
            </>
          )}
        />
      </Section>

      <CloudflareSteps kind="errors" />

      <ActionDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={t(`errorList.statusTitle.${target ?? "resolved"}`, { count: selected.length })}
        consequence={t(`errorList.statusConsequence.${target ?? "resolved"}`)}
        confirmLabel={t(target === "ignored" ? "errorList.bulk.ignore" : target === "open" ? "errorList.bulk.reopen" : "errorList.bulk.resolve")}
        impact={[{ label: t("consistency.selected"), value: f.number(selected.length) }]}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "status", ids: selected, status: target ?? "resolved" }}
        successMessage={(result) => t("errorList.changed", { count: Number(result.changed ?? 0) })}
        onDone={() => setSelected([])}
      />
    </>
  );
}
