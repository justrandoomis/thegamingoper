import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/home";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { markNoticeSeen, markRuleNoticesSeen, type NoticeGroup } from "~/server/services/admin/automation/log.server";
import { automationOverview } from "~/server/services/admin/automation/overview.server";
import { AUTOMATION_LINKS } from "~/server/services/admin/automation/types";
import { Key } from "~/ui/Key";
import { ModuleFunctions } from "../blueprint-status";
import { automation, ok, text } from "./automation.server";
import { Ago, Code, DecisionCard, DemoTag, Kpi, Note, PageHead, Section, failureText, useAutoT, type ActionData } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation — the module's front page: what waits for this employee (raised cards only for decisions: reorder
 * suggestions to approve, rules whose dry run waits for someone to switch them on, runs that failed), the notices rules
 * sent to this employee's permissions (marked seen one by one), the figures each may see, what automation never does
 * (19.08), the honest limits, and the status of the eight blueprint functions.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args);
  return { overview: await automation.orRespond(() => automationOverview(req.db, req.actor, req.now)), now: req.now };
}

export async function action(args: Route.ActionArgs) {
  const req = await automation.open(args);
  let intent: string | null = null;
  try {
    const form = await automation.form(args.request);
    intent = text(form, "intent");
    if (intent === "seen") return ok(intent, await markNoticeSeen(req.db, req.actor, { runId: text(form, "runId") }, req.now));
    if (intent === "seen_rule") return ok(intent, await markRuleNoticesSeen(req.db, req.actor, { ruleId: text(form, "ruleId") }, req.now));
    throw invalid({ intent: "invalid" });
  } catch (error) {
    return automation.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, null);

/** One rule's notices for this employee: how many, the latest three records, open its runs, mark them all seen. */
function NoticeGroupCard({ group, now }: { group: NoticeGroup; now: number }) {
  const t = useAutoT();
  const fetcher = useFetcher<ActionData>();
  const failure = fetcher.state === "idle" ? failureText(t, fetcher.data) : null;
  if (fetcher.data?.ok) return null;
  const type = group.items[0]?.event.type ?? null;
  const more = group.count - group.items.length;
  return (
    <li className="adm-card gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <p className="type-strong text-ink">
            <bdi>{group.ruleName}</bdi> · <bdi className="nums">{t("home.notice.count", { count: group.count })}</bdi>
          </p>
          <p className="type-caption text-ink-2">
            {type ? t(`event.${type}.title`) : null} · <Ago at={group.latestAt} now={now} />
          </p>
          <ul role="list" className="flex flex-wrap gap-x-3 gap-y-1 type-body">
            {group.items.map((notice) => (
              <li key={notice.runId} className="flex items-center gap-1">
                {notice.event.href ? (
                  <Link to={notice.event.href} className="adm-link">
                    <Code>{notice.event.label ?? "—"}</Code>
                  </Link>
                ) : (
                  <Link to={`/admin/automation/runs/${notice.runId}`} className="adm-link">
                    <Code>{notice.event.label ?? "—"}</Code>
                  </Link>
                )}
                {notice.event.isDemo ? <DemoTag /> : null}
              </li>
            ))}
            {more > 0 ? <li className="type-caption text-ink-2">{t("home.notice.more", { count: more })}</li> : null}
          </ul>
          <p className="type-caption text-ink-2">{t("home.notice.for", { audience: t(`audience.${group.audience}`) })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Key as={Link} to={`/admin/automation/runs?rule=${encodeURIComponent(group.ruleId)}`} size="sm" variant="ghost">
            {t("home.notice.open")}
          </Key>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="seen_rule" />
            <input type="hidden" name="ruleId" value={group.ruleId} />
            <Key type="submit" size="sm" loading={fetcher.state !== "idle"}>
              {t("home.notice.seen")}
            </Key>
          </fetcher.Form>
        </div>
      </div>
      {failure ? (
        <p role="alert" className="type-label text-red-ink">
          {failure}
        </p>
      ) : null}
    </li>
  );
}

export default function AutomationHome({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { overview, now } = loaderData;
  const { access, waiting, figures, notices } = overview;
  // each card opens the list of exactly what it counted (AUTOMATION_LINKS)
  const decisions = [
    { key: "suggestions", icon: "package" as const, count: waiting.suggestions ?? 0, to: AUTOMATION_LINKS.suggestions, show: waiting.suggestions !== null },
    { key: "activate", icon: "flag" as const, count: waiting.activatable ?? 0, to: AUTOMATION_LINKS.rulesToActivate, show: waiting.activatable !== null },
    { key: "failed", icon: "warning" as const, count: waiting.failedRuns ?? 0, to: AUTOMATION_LINKS.failedRuns, show: waiting.failedRuns !== null },
  ].filter((entry) => entry.show && entry.count > 0);

  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />

      <Section id="auto-waiting" title={t("home.waiting")}>
        {decisions.length ? (
          <ul role="list" className="auto-decisions">
            {decisions.map((entry) => (
              <DecisionCard key={entry.key} icon={entry.icon} title={t(`home.decision.${entry.key}.title`)} count={entry.count} text={t(`home.decision.${entry.key}.text`)} to={entry.to} action={t(`home.decision.${entry.key}.action`)} />
            ))}
          </ul>
        ) : (
          <p className="type-body text-ink-2">{t("home.nothingWaiting")}</p>
        )}
      </Section>

      {notices !== null ? (
        <Section id="notices" title={t("home.notices")} aside={<span className="type-caption text-ink-2">{t("home.noticesHint")}</span>}>
          {notices.length ? (
            <ul role="list" className="grid gap-2">
              {notices.map((group) => (
                <NoticeGroupCard key={group.ruleId} group={group} now={now} />
              ))}
            </ul>
          ) : (
            <p className="type-body text-ink-2">{t("home.noNotices")}</p>
          )}
        </Section>
      ) : null}

      <Section id="auto-figures" title={t("home.figures")}>
        <div className="auto-kpis">
          {figures.rules ? <Kpi label={t("home.kpi.active")} value={f.number(figures.rules.active)} hint={t("home.kpi.activeHint", { dry: f.number(figures.rules.dry_run), draft: f.number(figures.rules.draft), paused: f.number(figures.rules.paused) })} to="/admin/automation/rules?status=active" /> : null}
          {figures.runs24h !== null ? <Kpi label={t("home.kpi.runs")} value={f.number(figures.runs24h)} hint={figures.lastRunAt ? t("home.kpi.lastRun", { at: f.relative(figures.lastRunAt, now) }) : t("home.kpi.noRuns")} to={AUTOMATION_LINKS.runs24h} /> : null}
          {figures.tasks7d !== null ? <Kpi label={t("home.kpi.tasks")} value={f.number(figures.tasks7d)} hint={t("home.kpi.tasksHint")} /> : null}
          {figures.openSuggestions !== null ? <Kpi label={t("home.kpi.suggestions")} value={f.number(figures.openSuggestions)} hint={t("home.kpi.suggestionsHint")} to="/admin/automation/suggestions" /> : null}
          {access.rules || access.suggestions ? <Kpi label={t("home.kpi.job")} value={figures.lastJobAt ? f.relative(figures.lastJobAt, now) : "—"} hint={figures.lastJobAt ? t("home.kpi.jobHint") : t("home.kpi.jobNever")} /> : null}
        </div>
      </Section>

      <Section id="auto-safeguards" title={t("safeguards.title")}>
        <Note tone="ok" icon="shield-check">
          <p>{t("safeguards.never")}</p>
          <ul className="auto-lines">
            <li>{t("safeguards.refunds")}</li>
            <li>{t("safeguards.prices")}</li>
            <li>{t("safeguards.stock")}</li>
            <li>{t("safeguards.messages")}</li>
          </ul>
          <p>{t("safeguards.only")}</p>
        </Note>
      </Section>

      <Section id="auto-limits" title={t("home.limits")}>
        <Note tone="warn" icon="warning">
          <p>{t("home.limit.ai")}</p>
          <p>{t("home.limit.messages")}</p>
          <p>{t("home.limit.schedule")}</p>
          <p>{t("home.limit.stock")}</p>
        </Note>
      </Section>

      <ModuleFunctions moduleId="19" />
    </>
  );
}
