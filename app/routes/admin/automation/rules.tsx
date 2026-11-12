import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/rules";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { EVENT_TYPES, RULE_STATUSES, RULE_STATUS_TONE, type RuleStatus } from "~/server/services/admin/automation/catalog";
import { cleanLine } from "~/server/services/admin/automation/definition";
import { listRules } from "~/server/services/admin/automation/rules.server";
import { runAutomation } from "~/server/services/admin/automation/runner.server";
import { automationAccess, branchLimited } from "~/server/services/admin/automation/shared.server";
import { parseRuleFilters, ruleSearch, type RuleRow } from "~/server/services/admin/automation/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { automation, ok, text } from "./automation.server";
import { ActionDialog, Ago, DemoTag, LinkChips, Note, PageHead, Pair, Person, ResponsiveList, Section, StatusText, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/rules — 19.01: every rule with its event, status, version, actions and runs; status chips, event
 * and name in the URL. "New rule" opens the builder (automation.workflow.manage); "run the active rules now" does what
 * the scheduled job does (automation.workflow.activate, with a reason) — the job is the platform's to schedule.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.workflow.read");
  const filters = parseRuleFilters(new URL(args.request.url).searchParams);
  const page = await automation.orRespond(() => listRules(req.db, req.actor, filters, req.now));
  return { page, filters, access: automationAccess(req.actor), limited: branchLimited(req.actor), now: req.now };
}

export async function action(args: Route.ActionArgs) {
  const req = await automation.open(args, "automation.workflow.activate");
  let intent: string | null = null;
  try {
    const form = await automation.form(args.request);
    intent = text(form, "intent");
    if (intent !== "run_now") throw invalid({ intent: "invalid" });
    const reason = cleanLine(text(form, "reason"));
    if (reason.length < 3) throw invalid({ reason: "reason_required" });
    const result = await runAutomation(req.db, req.now, { triggeredBy: req.actor, reason });
    return ok(intent, { runs: Number(result.stats.runs ?? 0), suggestions: Number(result.stats.suggestionsCreated ?? 0), error: result.error });
  } catch (error) {
    return automation.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "rules.title");

export default function RulesPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { page, filters, access, limited, now } = loaderData;
  const [running, setRunning] = useState(false);
  const href = (next: Partial<typeof filters>) => `/admin/automation/rules${ruleSearch({ ...filters, page: 1, ...next })}`;
  const name = (row: RuleRow) => (
    <span className="grid">
      <Link to={`/admin/automation/rules/${row.id}`} className="adm-link">
        <bdi>{row.name}</bdi>
      </Link>
      <span className="type-caption text-ink-2">
        {t(`event.${row.event}.title`)} {row.demo ? <DemoTag /> : null}
      </span>
    </span>
  );
  const status = (row: RuleRow) => (
    <span className="grid">
      <StatusText tone={RULE_STATUS_TONE[row.status]}>{t(`status.rule.${row.status}`)}</StatusText>
      {row.status === "dry_run" && !row.dryRunReady ? <span className="type-caption text-ink-2">{t("rules.dryRunOld")}</span> : null}
    </span>
  );
  const actions = (row: RuleRow) => <span>{row.actions.map((type) => t(`action.${type}.short`)).join(t("common.listSep"))}</span>;
  const runs = (row: RuleRow) => (
    <span className="grid">
      <bdi className="nums">{f.number(row.runCount)}</bdi>
      {row.lastRunAt ? (
        <span className="type-caption text-ink-2">
          <Ago at={row.lastRunAt} now={now} />
        </span>
      ) : null}
    </span>
  );
  const columns: DataColumn<RuleRow>[] = [
    { key: "name", header: t("rules.col.name"), cell: name },
    { key: "status", header: t("rules.col.status"), cell: status },
    { key: "version", header: t("rules.col.version"), numeric: true, cell: (row) => f.number(row.version) },
    { key: "actions", header: t("rules.col.actions"), cell: actions },
    { key: "runs", header: t("rules.col.runs"), numeric: true, cell: runs },
    { key: "author", header: t("rules.col.author"), cell: (row) => <Person who={row.author} /> },
  ];
  const active = page.counts.active;

  return (
    <>
      <PageHead
        title={t("rules.title")}
        lead={t("rules.lead")}
        actions={
          <>
            {access.activate && !limited ? (
              <Key onClick={() => setRunning(true)} icon="arrows-clockwise">
                {t("rules.runNow")}
              </Key>
            ) : null}
            {access.manage && !limited ? (
              <Key as={Link} to="/admin/automation/rules/new" icon="plus">
                {t("rules.new")}
              </Key>
            ) : null}
          </>
        }
      />
      {limited ? (
        <Note icon="info">
          <p>{t("rules.branchLimited")}</p>
        </Note>
      ) : null}

      <Section id="auto-rules" title={filters.ready ? t("rules.ready") : filters.status ? t(`status.rule.${filters.status}`) : t("rules.all")} aside={<span className="type-caption text-ink-2">{t("rules.count", { count: page.total })}</span>}>
        <LinkChips
          label={t("rules.views")}
          items={[
            { value: "all", label: t("rules.all"), href: href({ status: null, ready: false }), selected: filters.status === null && !filters.ready, count: page.counts.all },
            ...RULE_STATUSES.map((value: RuleStatus) => ({ value, label: t(`status.rule.${value}`), href: href({ status: value, ready: false }), selected: filters.status === value && !filters.ready, count: page.counts[value] })),
            // the rules this person may switch on now: what the bell and the front page count
            ...(page.readyCount !== null ? [{ value: "ready", label: t("rules.ready"), href: href({ status: null, ready: true }), selected: filters.ready, count: page.readyCount }] : []),
          ]}
        />
        {filters.ready ? <p className="type-caption text-ink-2">{t("rules.readyHint")}</p> : null}
        <Form method="get" className="auto-filters" preventScrollReset>
          {filters.ready ? <input type="hidden" name="ready" value="1" /> : null}
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          <Select name="event" label={t("rules.filter.event")} defaultValue={filters.event ?? ""} options={[{ value: "", label: t("common.all") }, ...EVENT_TYPES.map((event) => ({ value: event, label: t(`event.${event}.title`) }))]} />
          <TextField name="q" label={t("rules.filter.q")} defaultValue={filters.q} maxLength={80} />
          <div>
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.event || filters.q ? (
              <Key as={Link} to={href({ event: null, q: "" })} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t("rules.title")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              title={page.counts.all === 0 ? t("rules.empty") : t("rules.emptyFiltered")}
              text={page.counts.all === 0 ? t("rules.emptyText") : t("rules.emptyFilteredText")}
              icon="robot"
              action={page.counts.all === 0 && access.manage && !limited ? <Key as={Link} to="/admin/automation/rules/new" icon="plus">{t("rules.new")}</Key> : undefined}
            />
          }
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/automation/rules${ruleSearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{name(row)}</span>
                {status(row)}
              </div>
              <Pair label={t("rules.col.version")}>
                <bdi className="nums">{f.number(row.version)}</bdi>
              </Pair>
              <Pair label={t("rules.col.actions")}>{actions(row)}</Pair>
              <Pair label={t("rules.col.runs")}>{runs(row)}</Pair>
            </>
          )}
        />
      </Section>

      <ActionDialog
        open={running}
        onClose={() => setRunning(false)}
        title={t("rules.runTitle")}
        consequence={t("rules.runConsequence")}
        confirmLabel={t("confirm.runNow")}
        impact={[
          { label: t("rules.runActive"), value: f.number(active) },
          { label: t("rules.runMoves"), value: t("rules.runMovesNothing") },
        ]}
        reason={{ label: t("common.reason"), hint: t("rules.runReasonHint") }}
        fields={{ intent: "run_now" }}
        successMessage={(result) => (result.error ? t("rules.ranWithErrors", { count: Number(result.runs ?? 0) }) : t("rules.ran", { count: Number(result.runs ?? 0), suggestions: Number(result.suggestions ?? 0) }))}
      />
    </>
  );
}
