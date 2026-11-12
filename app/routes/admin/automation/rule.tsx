import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/rule";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { ACTION_TYPES, DRY_RUN_WINDOWS, RULE_STATUS_TONE, RUN_STATUS_TONE, type ActionType } from "~/server/services/admin/automation/catalog";
import { activateRule, dryRunRule, getRule, pauseRule } from "~/server/services/admin/automation/rules.server";
import type { RuleDetail, RunView } from "~/server/services/admin/automation/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { automation, ok, text } from "./automation.server";
import { actionLine, conditionLines } from "./components/describe";
import { ActionDialog, Ago, Code, DemoTag, Note, PageHead, Pair, Person, ResponsiveList, Section, StatusText, When, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/rules/:ruleId — one rule: what it does in words, its dry run (19.07: the last 7 / 30 / 90 days,
 * what each action would have done, why other events did not count, sample rows), switching it on (another person,
 * a fresh dry run of this version, a reason) or pausing it (a reason), its versions with who saved them and why, and
 * its latest runs.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.workflow.read");
  const rule = await automation.orRespond(() => getRule(req.db, req.actor, args.params.ruleId, req.locale, req.now));
  return { rule, now: req.now };
}

export async function action(args: Route.ActionArgs) {
  const req = await automation.open(args);
  let intent: string | null = null;
  try {
    const form = await automation.form(args.request);
    intent = text(form, "intent");
    const common = { ruleId: args.params.ruleId, expectedUpdatedAt: text(form, "expectedUpdatedAt"), reason: text(form, "reason") };
    if (intent === "dry_run") return ok(intent, await dryRunRule(req.db, req.actor, { ...common, days: text(form, "days") }, req.now));
    if (intent === "activate") return ok(intent, await activateRule(req.db, req.actor, common, req.now));
    if (intent === "pause") return ok(intent, await pauseRule(req.db, req.actor, common, req.now));
    throw invalid({ intent: "invalid" });
  } catch (error) {
    return automation.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, null);

type Dialog = "dry" | "activate" | "pause" | null;

function RunRows({ runs, now, caption, empty }: { runs: RunView[]; now: number; caption: string; empty: string }) {
  const t = useAutoT();
  const record = (run: RunView) =>
    run.event.label ? (
      run.event.href ? (
        <Link to={run.event.href} className="adm-link">
          <Code>{run.event.label}</Code>
        </Link>
      ) : (
        <Code>{run.event.label}</Code>
      )
    ) : (
      <span>—</span>
    );
  const what = (run: RunView) => (
    <ul role="list" className="grid gap-0.5">
      {run.actions.map((entry, index) => (
        <li key={index} className="type-caption">
          <span className="text-ink">{t(`action.${entry.type}.short`)}</span> · <span className="text-ink-2">{t(`outcome.${entry.outcome}`)}</span>
          {entry.reason ? <span className="text-ink-2"> · {t(`skip.${entry.reason}`)}</span> : null}
          {entry.who ? <span className="text-ink-2"> · {entry.who}</span> : null}
        </li>
      ))}
    </ul>
  );
  const columns: DataColumn<RunView>[] = [
    { key: "at", header: t("runs.col.event"), cell: (run) => (run.event.at ? <When at={run.event.at} /> : <When at={run.at} />) },
    { key: "record", header: t("runs.col.record"), cell: (run) => <span className="grid">{record(run)}{run.event.isDemo ? <DemoTag /> : null}</span> },
    { key: "what", header: t("runs.col.actions"), cell: what },
    { key: "status", header: t("runs.col.status"), cell: (run) => <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`status.run.${run.status}`)}</StatusText> },
    {
      key: "open",
      header: t("runs.col.open"),
      cell: (run) => (
        <Link to={`/admin/automation/runs/${run.id}`} className="adm-link">
          {t("runs.open")}
        </Link>
      ),
    },
  ];
  return (
    <ResponsiveList
      caption={caption}
      columns={columns}
      rows={runs}
      rowKey={(run) => run.id}
      empty={<EmptyState title={empty} icon="clock" />}
      card={(run) => (
        <>
          <div className="flex items-start justify-between gap-2">
            {record(run)}
            <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`status.run.${run.status}`)}</StatusText>
          </div>
          <Pair label={t("runs.col.event")}>{run.event.at ? <Ago at={run.event.at} now={now} /> : <Ago at={run.at} now={now} />}</Pair>
          {what(run)}
          <Link to={`/admin/automation/runs/${run.id}`} className="adm-link type-label">
            {t("runs.open")}
          </Link>
        </>
      )}
    />
  );
}

function DryRunBlock({ rule }: { rule: RuleDetail }) {
  const t = useAutoT();
  const f = useFormat();
  const dry = rule.dryRun;
  if (!dry) return <p className="type-body text-ink-2">{t("rule.dry.never")}</p>;
  return (
    <div className="grid gap-3">
      <dl className="auto-facts type-data">
        <dt>{t("rule.dry.when")}</dt>
        <dd>
          <When at={dry.at} /> · <Person who={dry.byName} />
        </dd>
        <dt>{t("rule.dry.version")}</dt>
        <dd>
          <bdi className="nums">{f.number(dry.version)}</bdi> {dry.current ? null : <span className="text-red-ink">· {t("rule.dry.oldVersion")}</span>}
        </dd>
        <dt>{t("rule.dry.window")}</dt>
        <dd>{dry.stockNow ? t("rule.dry.stockNow") : t("common.days", { count: dry.days })}</dd>
        <dt>{t("rule.dry.events")}</dt>
        <dd>
          {t("rule.dry.matched", { matched: f.number(dry.matched), considered: f.number(dry.considered) })}
          {dry.truncated ? <span className="text-ink-2"> · {t("rule.dry.truncated")}</span> : null}
        </dd>
        {ACTION_TYPES.filter((type) => dry.actions[type]).map((type: ActionType) => (
          <div key={type} className="contents">
            <dt>{t(`action.${type}.short`)}</dt>
            <dd>{t("rule.dry.would", { would: f.number(dry.actions[type]?.would ?? 0), skip: f.number(dry.actions[type]?.skip ?? 0) })}</dd>
          </div>
        ))}
      </dl>
      {Object.keys(dry.failed).length ? (
        <div className="grid gap-1">
          <p className="type-label text-ink">{t("rule.dry.notCounted")}</p>
          <ul className="auto-lines type-caption text-ink-2">
            {Object.entries(dry.failed).map(([key, count]) => (
              <li key={key}>{t("rule.dry.failedLine", { why: t(`failed.${key}`), count: Number(count ?? 0) })}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!dry.fresh ? (
        <Note tone="warn" icon="clock">
          <p>{t("rule.dry.stale")}</p>
        </Note>
      ) : null}
    </div>
  );
}

export default function RulePage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { rule, now } = loaderData;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [days, setDays] = useState<string>("30");
  const close = () => setDialog(null);
  const names = { assignee: rule.names.assignee, governorate: rule.names.governorate, location: rule.names.location };
  const conditions = conditionLines(t, f, rule.event, rule.match, names);
  const dry = rule.dryRun;
  const wouldRows = dry
    ? ACTION_TYPES.filter((type) => dry.actions[type]).map((type) => ({ label: t(`action.${type}.short`), value: t("rule.dry.wouldShort", { count: dry.actions[type]?.would ?? 0 }) }))
    : [];

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/automation/rules" className="adm-link">
            {t("rules.title")}
          </Link>
        }
        title={<bdi>{rule.name}</bdi>}
        lead={rule.description ?? undefined}
        actions={
          <>
            {rule.can.manage ? (
              <Key as={Link} to={`/admin/automation/rules/${rule.id}/edit`} icon="pencil-simple">
                {t("rule.edit")}
              </Key>
            ) : null}
            {rule.can.dryRun ? (
              <Key onClick={() => setDialog("dry")} icon="arrows-clockwise">
                {t("rule.dryRun")}
              </Key>
            ) : null}
            {rule.can.pause ? (
              <Key onClick={() => setDialog("pause")} icon="clock">
                {t("rule.pause")}
              </Key>
            ) : null}
            {rule.can.activate ? (
              <Key variant="primary" onClick={() => setDialog("activate")} icon="check">
                {rule.status === "paused" ? t("rule.resume") : t("rule.activate")}
              </Key>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <StatusText tone={RULE_STATUS_TONE[rule.status]}>{t(`status.rule.${rule.status}`)}</StatusText>
        <span className="type-caption text-ink-2">
          {t("rule.versionLine", { version: f.number(rule.version) })} · {t("rule.savedBy")} <Person who={rule.author} />
        </span>
        {rule.demo ? <DemoTag /> : null}
      </div>

      {rule.can.activateBlocked ? (
        <Note tone="info" icon="info">
          <p>{t(`rule.blocked.${rule.can.activateBlocked}`)}</p>
        </Note>
      ) : null}
      {!rule.names.assigneeActive ? (
        <Note tone="bad" icon="warning">
          <p>{t("rule.assigneeInactive")}</p>
        </Note>
      ) : null}

      <div className="auto-split">
        <div className="grid min-w-0 gap-6">
          <Section id="auto-rule-what" title={t("rule.what")}>
            <div className="adm-card gap-3">
              <p className="type-strong">{t(`event.${rule.event}.title`)}</p>
              <p className="type-caption text-ink-2">{t(`event.${rule.event}.when`)}</p>
              <p className="type-label">{t("rule.conditions")}</p>
              <ul className="auto-lines type-body">
                {conditions.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
              <p className="type-label">{t("rule.actions")}</p>
              <ul className="auto-lines type-body">
                {rule.actions.map((entry, index) => (
                  <li key={index}>{actionLine(t, entry, names)}</li>
                ))}
              </ul>
            </div>
          </Section>

          <Section id="auto-rule-dry" title={t("rule.dry.title")} aside={<span className="type-caption text-ink-2">{t("rule.dry.hint")}</span>}>
            <DryRunBlock rule={rule} />
            {rule.samples.length ? <RunRows runs={rule.samples} now={now} caption={t("rule.dry.samples")} empty={t("rule.dry.noSamples")} /> : null}
          </Section>

          <Section id="auto-rule-runs" title={t("rule.recent")} aside={<Link to={`/admin/automation/runs?rule=${rule.id}`} className="adm-link type-label">{t("rule.allRuns")}</Link>}>
            <RunRows runs={rule.recent} now={now} caption={t("rule.recent")} empty={rule.status === "active" ? t("rule.noRunsYet") : t("rule.noRuns")} />
          </Section>
        </div>

        <aside className="grid min-w-0 gap-6">
          <Section id="auto-rule-state" title={t("rule.state")}>
            <dl className="auto-facts type-data">
              <dt>{t("rule.runCount")}</dt>
              <dd>
                <bdi className="nums">{f.number(rule.runCount)}</bdi>
                {rule.lastRunAt ? (
                  <span className="text-ink-2">
                    {" "}
                    · <Ago at={rule.lastRunAt} now={now} />
                  </span>
                ) : null}
              </dd>
              <dt>{t("rule.activation")}</dt>
              <dd>
                {rule.activation ? (
                  <>
                    {t("rule.activationLine", { version: f.number(rule.activation.version) })} · <When at={rule.activation.at} /> · <Person who={rule.activation.by} />
                  </>
                ) : (
                  t("rule.neverActive")
                )}
              </dd>
              {rule.pause && rule.status === "paused" ? (
                <>
                  <dt>{t("rule.pausedBy")}</dt>
                  <dd>
                    <Person who={rule.pause.by} /> · <When at={rule.pause.at} />
                    {rule.pause.reason ? <span className="block text-ink-2">{rule.pause.reason}</span> : null}
                  </dd>
                </>
              ) : null}
              <dt>{t("rule.created")}</dt>
              <dd>
                <When at={rule.createdAt} />
              </dd>
            </dl>
          </Section>

          <Section id="auto-rule-versions" title={t("rule.versions")}>
            {rule.versions.length ? (
              <ol role="list" className="grid gap-2">
                {rule.versions.map((version, index) => (
                  <li key={index} className="adm-card gap-1">
                    <p className="type-strong">
                      {t("rule.versionLine", { version: f.number(version.version) })} {version.version === rule.version ? <span className="type-caption text-ink-2">· {t("rule.current")}</span> : null}
                    </p>
                    <p className="type-caption text-ink-2">
                      <When at={version.at} /> · <Person who={version.by} />
                    </p>
                    {version.reason ? <p className="type-caption">{version.reason}</p> : null}
                    {version.definition ? (
                      <details>
                        <summary className="adm-link type-caption">{t("rule.versionShow")}</summary>
                        <ul className="auto-lines type-caption">
                          <li>{t(`event.${version.definition.event}.title`)}</li>
                          {conditionLines(t, f, version.definition.event, version.definition.match).map((line, lineIndex) => (
                            <li key={`c${lineIndex}`}>{line}</li>
                          ))}
                          {version.definition.actions.map((entry, actionIndex) => (
                            <li key={`a${actionIndex}`}>{actionLine(t, entry)}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="type-body text-ink-2">{t("rule.noVersions")}</p>
            )}
          </Section>
        </aside>
      </div>

      <ActionDialog
        open={dialog === "dry"}
        onClose={close}
        title={t("rule.dryTitle")}
        consequence={rule.event === "stock.below_reorder" ? t("rule.dryConsequenceStock") : t("rule.dryConsequence")}
        confirmLabel={t("confirm.dryRun")}
        impact={[
          { label: t("rule.dryImpactWrites"), value: t("rule.dryImpactNothing") },
          { label: t("rule.dryImpactVersion"), value: f.number(rule.version) },
        ]}
        fields={{ intent: "dry_run", days, expectedUpdatedAt: String(rule.updatedAt) }}
        successMessage={(result) => t("rule.dryDone", { matched: Number(result.matched ?? 0), considered: Number(result.considered ?? 0) })}
      >
        {rule.event === "stock.below_reorder" ? null : (
          <Select name="days" label={t("rule.dryWindow")} value={days} onChange={(change) => setDays(change.currentTarget.value)} options={DRY_RUN_WINDOWS.map((value) => ({ value: String(value), label: t("common.days", { count: value }) }))} />
        )}
      </ActionDialog>

      <ActionDialog
        open={dialog === "activate"}
        onClose={close}
        title={rule.status === "paused" ? t("rule.resumeTitle") : t("rule.activateTitle")}
        consequence={t("rule.activateConsequence")}
        confirmLabel={rule.status === "paused" ? t("confirm.resume") : t("confirm.activate")}
        tone="commit"
        impact={[
          { label: t("rule.dryImpactVersion"), value: f.number(rule.version) },
          ...(dry ? [{ label: t("rule.dry.events"), value: t("rule.dry.matched", { matched: f.number(dry.matched), considered: f.number(dry.considered) }) }] : []),
          ...wouldRows,
          { label: t("rule.runMoves"), value: t("rules.runMovesNothing") },
        ]}
        reason={{ label: t("common.reason"), hint: t("rule.activateReasonHint") }}
        fields={{ intent: "activate", expectedUpdatedAt: String(rule.updatedAt) }}
        successMessage={t("rule.activated")}
      />

      <ActionDialog
        open={dialog === "pause"}
        onClose={close}
        title={t("rule.pauseTitle")}
        consequence={t("rule.pauseConsequence")}
        confirmLabel={t("confirm.pause")}
        tone="destructive"
        impact={[{ label: t("rule.pauseImpact"), value: t("rule.pauseImpactValue") }]}
        reason={{ label: t("common.reason"), hint: t("rule.pauseReasonHint") }}
        fields={{ intent: "pause", expectedUpdatedAt: String(rule.updatedAt) }}
        successMessage={t("rule.paused")}
      />
    </>
  );
}
