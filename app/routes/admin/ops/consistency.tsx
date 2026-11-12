import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/consistency";
import { useFormat } from "~/i18n/react";
import { assignFindings, closeFindings, listFindings } from "~/server/services/admin/ops/consistency.server";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import {
  BULK_MAX,
  FINDING_SEVERITIES,
  FINDING_SEVERITY_TONE,
  FINDING_SORTS,
  FINDING_STATUS_TONE,
  FINDING_VIEWS,
  baghdadDay,
  findingSearch,
  parseFindingFilters,
  type FindingRow,
} from "~/server/services/admin/ops/types";
import { invalid } from "~/server/errors";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { checkTitle } from "./components/labels";
import { ActionDialog, Ago, Code, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, StatusText, When, useOpsT } from "./components/ui";
import { AssignFields } from "./components/AssignFields";
import { opsMeta } from "./meta";
import { all, ok, ops, optional, text } from "./ops.server";

/**
 * /admin/ops/consistency — 23.06: what the daily consistency checks found (stock against movements and reservations,
 * the wallet against its account, journal entries, orders against their lines, payments and refunds, money without its
 * postings). Views and filters in the URL; with ops.consistency.resolve, rows can be selected and given to a person or
 * closed with a reason (at most 25 at a time). Nothing here changes the data a check compared: each finding links to
 * the module that owns the record.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.consistency.read");
  const filters = parseFindingFilters(new URL(args.request.url).searchParams);
  const page = await ops.orRespond(req, () => listFindings(req.db, req.actor, filters));
  return { page, filters, access: opsAccess(req.actor), now: req.now, today: baghdadDay(req.now) };
}

export async function action(args: Route.ActionArgs) {
  const req = await ops.open(args, "ops.consistency.resolve");
  let intent: string | null = null;
  try {
    const form = await ops.form(args.request);
    intent = text(form, "intent");
    if (intent === "assign") return ok(intent, await assignFindings(req.db, req.actor, { ids: all(form, "ids"), assigneeId: text(form, "assigneeId"), dueDay: optional(form, "dueDay"), note: optional(form, "reason") }, req.now));
    if (intent === "close") return ok(intent, await closeFindings(req.db, req.actor, { ids: all(form, "ids"), outcome: text(form, "outcome"), reason: text(form, "reason") }, req.now));
    throw invalid({ intent: "invalid" });
  } catch (error) {
    return ops.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "consistency.title");

type Bulk = { kind: "assign" } | { kind: "close"; outcome: "resolved" | "false_positive" };

export default function ConsistencyPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { page, filters, access, now, today } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [assignee, setAssignee] = useState("");
  const [dueDay, setDueDay] = useState("");
  const href = (next: Partial<typeof filters>) => `/admin/ops/consistency${findingSearch({ ...filters, page: 1, ...next })}`;

  const what = (row: FindingRow) => (
    <span className="grid">
      <Link to={`/admin/ops/consistency/${row.id}`} className="adm-link">
        {checkTitle(t, row.checkKey)}
      </Link>
      <span className="type-caption text-ink-2">{t(`area.${row.area}`)}</span>
    </span>
  );
  const record = (row: FindingRow) =>
    row.entity.href ? (
      <Link to={row.entity.href} className="adm-link">
        <Code>{row.entity.label ?? row.entity.id ?? "—"}</Code>
      </Link>
    ) : (
      <Code>{row.entity.label ?? row.entity.id ?? "—"}</Code>
    );
  const who = (row: FindingRow) =>
    row.assignee ? (
      <span className="grid">
        <span>{row.assignee.name}</span>
        {row.assignee.dueAt ? (
          <span className={row.assignee.dueAt < now ? "type-caption text-red-ink" : "type-caption text-ink-2"}>
            {t("consistency.due")} <When at={row.assignee.dueAt} kind="date" />
          </span>
        ) : null}
      </span>
    ) : (
      <span className="text-ink-2">{t("consistency.nobody")}</span>
    );
  const columns: DataColumn<FindingRow>[] = [
    { key: "severity", header: t("consistency.col.severity"), cell: (row) => <StatusText tone={FINDING_SEVERITY_TONE[row.severity]}>{t(`severity.${row.severity}`)}</StatusText> },
    { key: "check", header: t("consistency.col.check"), cell: what },
    { key: "record", header: t("consistency.col.record"), cell: record },
    {
      key: "seen",
      header: t("consistency.col.seen"),
      cell: (row) => (
        <span className="grid">
          <Ago at={row.lastSeenAt} now={now} />
          <span className="type-caption text-ink-2">{t("consistency.times", { count: row.occurrences })}</span>
        </span>
      ),
    },
    { key: "status", header: t("consistency.col.status"), cell: (row) => <StatusText tone={FINDING_STATUS_TONE[row.status]}>{t(`finding.status.${row.status}`)}</StatusText> },
    { key: "who", header: t("consistency.col.who"), cell: who },
  ];
  const selectable = access.resolveFindings && filters.view !== "resolved" && filters.view !== "false_positive";
  const bulkKeys = (ids: readonly string[]) => (
    <>
      <Key size="sm" onClick={() => setBulk({ kind: "assign" })} disabled={ids.length > BULK_MAX}>
        {t("consistency.bulk.assign")}
      </Key>
      <Key size="sm" onClick={() => setBulk({ kind: "close", outcome: "resolved" })} disabled={ids.length > BULK_MAX}>
        {t("consistency.bulk.resolve")}
      </Key>
      <Key size="sm" variant="ghost" onClick={() => setBulk({ kind: "close", outcome: "false_positive" })} disabled={ids.length > BULK_MAX}>
        {t("consistency.bulk.dismiss")}
      </Key>
      {access.manageIncidents ? (
        <Key size="sm" variant="ghost" as={Link} to={`/admin/ops/incidents/new?${ids.slice(0, 20).map((id) => `finding=${encodeURIComponent(id)}`).join("&")}`}>
          {t("consistency.bulk.incident")}
        </Key>
      ) : null}
    </>
  );
  const last = page.lastRun;

  return (
    <>
      <PageHead
        title={t("consistency.title")}
        lead={t("consistency.lead")}
        actions={
          access.runJobs ? (
            <Key as={Link} to="/admin/ops/jobs/consistency.daily" icon="arrows-clockwise">
              {t("consistency.runChecks")}
            </Key>
          ) : null
        }
      />

      <Note tone={last && last.status === "failed" ? "bad" : "info"} icon={last && last.status === "failed" ? "warning" : "clock"}>
        {last ? (
          <p>
            {t("consistency.lastRun", { status: t(`run.status.${last.status}`) })} <When at={last.at} /> · <Ago at={last.at} now={now} />
            {last.failedChecks ? ` · ${t("consistency.failedChecks", { count: last.failedChecks })}` : ""}
          </p>
        ) : (
          <p>{t("consistency.neverRan")}</p>
        )}
        <p className="type-caption text-ink-2">{t("consistency.schedule")}</p>
      </Note>

      <Section id="ops-findings" title={t(`consistency.view.${filters.view}`)} aside={<span className="type-caption text-ink-2">{t("consistency.count", { count: page.total })}</span>}>
        <LinkChips label={t("consistency.views")} items={FINDING_VIEWS.map((view) => ({ value: view, label: t(`consistency.view.${view}`), href: href({ view }), selected: filters.view === view, count: page.counts[view] }))} />
        <Form method="get" className="ops-filters" preventScrollReset>
          {filters.view !== "active" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <Select name="severity" label={t("consistency.filter.severity")} defaultValue={filters.severity ?? ""} options={[{ value: "", label: t("common.all") }, ...FINDING_SEVERITIES.map((severity) => ({ value: severity, label: t(`severity.${severity}`) }))]} />
          <Select name="check" label={t("consistency.filter.check")} defaultValue={filters.check ?? ""} options={[{ value: "", label: t("common.all") }, ...page.checks.map((check) => ({ value: check, label: checkTitle(t, check) }))]} />
          <Select
            name="assignee"
            label={t("consistency.filter.assignee")}
            defaultValue={filters.assignee ?? ""}
            options={[{ value: "", label: t("common.anyone") }, { value: "me", label: t("consistency.filter.mine") }, { value: "none", label: t("consistency.filter.nobody") }]}
          />
          <TextField name="q" label={t("consistency.filter.qHint")} defaultValue={filters.q} maxLength={100} />
          <Select name="sort" label={t("common.sort")} defaultValue={filters.sort} options={FINDING_SORTS.map((sort) => ({ value: sort, label: t(`consistency.sort.${sort}`) }))} />
          <div className="flex gap-2">
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.severity || filters.check || filters.assignee || filters.q ? (
              <Key as={Link} to={href({ severity: null, check: null, assignee: null, q: "", sort: "severity" })} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t(`consistency.view.${filters.view}`)}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => `${checkTitle(t, row.checkKey)} ${row.entity.label ?? ""}`}
          selected={selectable ? selected : undefined}
          onSelectedChange={selectable ? setSelected : undefined}
          bulkActions={selectable ? bulkKeys : undefined}
          empty={<EmptyState title={t("consistency.empty")} text={filters.view === "active" ? t("consistency.emptyActive") : t("consistency.emptyHint")} icon="seal-check" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/ops/consistency${findingSearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{what(row)}</span>
                <StatusText tone={FINDING_SEVERITY_TONE[row.severity]}>{t(`severity.${row.severity}`)}</StatusText>
              </div>
              <Pair label={t("consistency.col.record")}>{record(row)}</Pair>
              <Pair label={t("consistency.col.status")}>
                <StatusText tone={FINDING_STATUS_TONE[row.status]}>{t(`finding.status.${row.status}`)}</StatusText>
              </Pair>
              <Pair label={t("consistency.col.seen")}>
                <Ago at={row.lastSeenAt} now={now} />
              </Pair>
              <Pair label={t("consistency.col.who")}>{who(row)}</Pair>
            </>
          )}
        />
        <Note icon="info">
          <p>{t("consistency.neverEdits")}</p>
        </Note>
      </Section>

      <ActionDialog
        open={bulk?.kind === "assign"}
        onClose={() => setBulk(null)}
        title={t("consistency.assignTitle", { count: selected.length })}
        consequence={t("consistency.assignConsequence")}
        confirmLabel={t("confirm.give")}
        impact={[{ label: t("consistency.selected"), value: f.number(selected.length) }]}
        reason={{ label: t("consistency.note"), noteRequired: false, minLength: 0, hint: t("consistency.noteHint") }}
        fields={{ intent: "assign", ids: selected, assigneeId: assignee, dueDay }}
        successMessage={(result) => t("consistency.assigned", { count: Number(result.assigned ?? 0) })}
        onDone={() => setSelected([])}
      >
        <AssignFields people={page.assignees} assignee={assignee} onAssignee={setAssignee} dueDay={dueDay} onDueDay={setDueDay} today={today} />
      </ActionDialog>
      <ActionDialog
        open={bulk?.kind === "close"}
        onClose={() => setBulk(null)}
        title={t(bulk?.kind === "close" && bulk.outcome === "false_positive" ? "consistency.dismissTitle" : "consistency.resolveTitle", { count: selected.length })}
        consequence={t(bulk?.kind === "close" && bulk.outcome === "false_positive" ? "consistency.dismissConsequence" : "consistency.resolveConsequence")}
        confirmLabel={t(bulk?.kind === "close" && bulk.outcome === "false_positive" ? "confirm.dismiss" : "confirm.resolve")}
        impact={[
          { label: t("consistency.selected"), value: f.number(selected.length) },
          { label: t("consistency.dataChanged"), value: t("consistency.nothing") },
        ]}
        reason={{ label: t("common.reason"), hint: t("consistency.reasonHint") }}
        fields={{ intent: "close", ids: selected, outcome: bulk?.kind === "close" ? bulk.outcome : "resolved" }}
        successMessage={(result) => t("consistency.closed", { count: Number(result.closed ?? 0) })}
        onDone={() => setSelected([])}
      />
    </>
  );
}
