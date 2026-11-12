import { Link } from "react-router";

import type { Route } from "./+types/run";
import { useFormat } from "~/i18n/react";
import { RUN_STATUS_TONE } from "~/server/services/admin/automation/catalog";
import { getRun } from "~/server/services/admin/automation/log.server";
import { automation } from "./automation.server";
import { Code, DemoTag, Note, PageHead, Section, StatusText, When, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/runs/:runId — one run (or one dry-run sample): the rule and the version that ran, the event and
 * its facts, what each action did and where its result lives (the task in 15.02, the review queue of 05.09, the
 * reorder suggestions of 19.02), and the error of a failed run.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.workflow.read");
  const run = await automation.orRespond(() => getRun(req.db, req.actor, args.params.runId));
  return { run };
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "run.title");

const FACT_KEYS = ["ref", "channel", "paymentMethod", "totalIqd", "status", "sku", "locationCode", "available", "reorderPoint", "incoming", "productKind", "priority", "category", "waitingSince", "oldPriceIqd", "newPriceIqd", "source"] as const;

export default function RunPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { run } = loaderData;
  const facts = run.event.facts;
  const value = (key: string, raw: unknown) => {
    if (raw === null || raw === undefined || raw === "") return "—";
    if (typeof raw === "number" && key.endsWith("Iqd")) return f.iqd(raw);
    if (typeof raw === "number" && key === "waitingSince") return f.dateTime(raw);
    if (typeof raw === "number") return f.number(raw);
    // the catalogue's own words where it has them; anything else (an order status, a source) as stored
    const words: Record<string, string> = { productKind: "choice.kind", channel: "choice.channel", paymentMethod: "choice.payment", priority: "choice.priority", category: "choice.category" };
    if (words[key]) {
      const text = t(`${words[key]}.${String(raw)}`);
      if (text !== `${words[key]}.${String(raw)}`) return text;
    }
    return String(raw);
  };
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/automation/runs" className="adm-link">
            {t("runs.title")}
          </Link>
        }
        title={run.isDryRun ? t("run.titleDry") : t("run.title")}
        lead={t("run.lead", { rule: run.ruleName })}
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusText tone={RUN_STATUS_TONE[run.status]}>{t(`status.run.${run.status}`)}</StatusText>
        <span className="type-caption text-ink-2">
          <When at={run.at} />
        </span>
        {run.event.isDemo ? <DemoTag /> : null}
      </div>
      {run.isDryRun ? (
        <Note icon="info">
          <p>{t("run.dryNote")}</p>
        </Note>
      ) : null}
      {run.error ? (
        <Note tone="bad" icon="warning">
          <p>{run.error === "interrupted" ? t("run.interrupted") : t("run.failed", { error: t(`skip.${run.error}`) === `skip.${run.error}` ? run.error : t(`skip.${run.error}`) })}</p>
        </Note>
      ) : null}

      <Section id="auto-run-event" title={t("run.event")}>
        <dl className="auto-facts type-data">
          <dt>{t("run.rule")}</dt>
          <dd>
            <Link to={`/admin/automation/rules/${run.ruleId}`} className="adm-link">
              <bdi>{run.ruleName}</bdi>
            </Link>
            {run.event.version ? <span className="text-ink-2"> · {t("rule.versionLine", { version: run.event.version })}</span> : null}
          </dd>
          <dt>{t("run.eventType")}</dt>
          <dd>{run.event.type ? t(`event.${run.event.type}.title`) : "—"}</dd>
          <dt>{t("run.record")}</dt>
          <dd>
            {run.event.label ? (
              run.event.href ? (
                <Link to={run.event.href} className="adm-link">
                  <Code>{run.event.label}</Code>
                </Link>
              ) : (
                <Code>{run.event.label}</Code>
              )
            ) : (
              "—"
            )}
          </dd>
          <dt>{t("run.happened")}</dt>
          <dd>
            <When at={run.event.at} />
          </dd>
          {FACT_KEYS.filter((key) => key in facts && key !== "ref").map((key) => (
            <div key={key} className="contents">
              <dt>{t(`fact.${key}`)}</dt>
              <dd>
                <bdi className="nums">{value(key, facts[key])}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="auto-run-actions" title={t("run.actions")}>
        {run.actions.length ? (
          <ul role="list" className="grid gap-2">
            {run.actions.map((entry, index) => (
              <li key={index} className="adm-card gap-1">
                <p className="type-strong">{t(`action.${entry.type}.title`)}</p>
                <p className="type-caption text-ink-2">
                  {t(`outcome.${entry.outcome}`)}
                  {entry.reason ? ` · ${t(`skip.${entry.reason}`)}` : ""}
                  {entry.who ? ` · ${entry.who}` : ""}
                  {entry.type === "notify" && typeof entry.detail?.audience === "string" ? ` · ${t(`audience.${entry.detail.audience}`)}` : ""}
                  {entry.type === "suggest_purchase" && typeof entry.detail?.qty === "number" ? ` · ${t("run.qty", { qty: f.number(entry.detail.qty) })}` : ""}
                </p>
                {entry.href ? (
                  <Link to={entry.href} className="adm-link type-label">
                    {t(`run.where.${entry.type}`)}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-body text-ink-2">{t("run.noActions")}</p>
        )}
      </Section>
    </>
  );
}
