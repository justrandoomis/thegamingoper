import { Link } from "react-router";

import type { Route } from "./+types/anomalies";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { financeAnomalies, type AnomalyFinding, type CheckResult } from "~/server/services/admin/finance/anomalies.server";
import { Status } from "~/ui/Tag";
import { openFinance, orRespond } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, Note, PageHead, Section, StateTag, useFinT, When } from "./ui";

const GROUPS = ["nan", "negative", "totals"] as const;

/**
 * /admin/finance/anomalies — 10.10: anomalous values. Deterministic checks run when the page opens — money that is not
 * a whole number of dinars ("NaN"), balances on a side they should never be on (unexplained negatives), totals that do
 * not match (the trial balance, the wallet against its account, orders against their lines and payments, money
 * without its posting, statement matches with a difference, approved top-ups or adjustments not credited, expenses
 * without their entry) — next to what the daily consistency job recorded. finance.anomaly.read; checks that read the
 * books need cost.read and say so instead of showing nothing.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openFinance(context, "finance.anomaly.read");
  const report = await orRespond(() => financeAnomalies(db, actor, now));
  return { report };
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "anomalies.title");

export default function AnomaliesPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const { report } = loaderData;
  const found = report.checks.reduce((total, check) => total + check.findings.length, 0);
  const critical = report.checks.reduce((total, check) => total + check.findings.filter((finding) => finding.severity === "critical").length, 0);
  return (
    <>
      <PageHead title={t("anomalies.title")} lead={t("anomalies.lead")} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {found === 0 ? <Status tone="ok">{t("anomalies.allClear")}</Status> : <Status tone={critical ? "bad" : "warn"}>{t("anomalies.found", { count: found })}</Status>}
        <span className="type-caption text-ink-2">
          {t("anomalies.ranAt")} <When at={report.ranAt} />
        </span>
      </div>
      {GROUPS.map((group) => (
        <Section key={group} id={`anom-${group}`} title={t(`anomalies.group.${group}`)}>
          <p className="max-w-[72ch] type-body text-ink-2">{t(`anomalies.groupWhy.${group}`)}</p>
          <ul className="grid gap-2">
            {report.checks
              .filter((check) => check.group === group)
              .map((check) => (
                <CheckRow key={check.check} check={check} />
              ))}
          </ul>
        </Section>
      ))}

      <Section id="anom-stored" title={t("anomalies.stored")}>
        <p className="type-body text-ink-2">
          {report.lastRun ? (
            <>
              {t("anomalies.lastRun")} <When at={report.lastRun.at} /> · {t(`jobStatus.${report.lastRun.status}`)}
            </>
          ) : (
            t("anomalies.neverRan")
          )}
        </p>
        {report.stored.length === 0 ? (
          <p className="type-body">{t("anomalies.noneStored")}</p>
        ) : (
          <ul className="grid gap-2">
            {report.stored.map((finding) => (
              <li key={finding.id} className="adm-card gap-1">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="type-strong">{t(`anomalies.check.${finding.checkKey}.title`)}</span>
                  <span className="flex flex-wrap gap-1">
                    <StateTag group="severity" value={finding.severity} label={t(`severity.${finding.severity}`)} />
                    <StateTag group="finding" value={finding.status} label={t(`findingStatus.${finding.status}`)} />
                  </span>
                </span>
                <p className="type-caption text-ink-2" dir="ltr">
                  {finding.message}
                </p>
                <p className="type-caption text-ink-2">
                  {t("anomalies.seen", { count: finding.occurrences })} · <When at={finding.lastSeenAt} />
                  {finding.entityId ? (
                    <>
                      {" · "}
                      <Code>{finding.entityId}</Code>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
        {report.storedHidden > 0 ? <p className="type-caption text-ink-2">{t("anomalies.storedHidden", { count: report.storedHidden })}</p> : null}
        <Note>
          <p>{t("anomalies.resolveNote")}</p>
        </Note>
      </Section>
    </>
  );
}

function CheckRow({ check }: { check: CheckResult }) {
  const t = useFinT();
  const icon = check.status === "ok" ? "check-circle" : check.status === "needs_cost" ? "lock" : "warning";
  return (
    <li className="adm-card gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex items-start gap-2">
          <Icon name={icon} size={20} className={check.status === "ok" ? "text-ok" : check.status === "needs_cost" ? "text-ink-2" : "text-warn"} />
          <span className="grid gap-0.5">
            <span className="type-strong">{t(`anomalies.check.${check.check}.title`)}</span>
            <span className="type-caption text-ink-2">{t(`anomalies.check.${check.check}.rule`)}</span>
          </span>
        </span>
        {check.status === "ok" ? <Status tone="ok">{t("anomalies.ok")}</Status> : check.status === "needs_cost" ? <Status tone="neutral">{t("anomalies.needsCost")}</Status> : <Status tone={check.findings.some((finding) => finding.severity === "critical") ? "bad" : "warn"}>{t("anomalies.foundShort", { count: check.findings.length })}</Status>}
      </div>
      {check.findings.length ? (
        <ul className="grid gap-1 ps-7">
          {check.findings.slice(0, 20).map((finding, index) => (
            <FindingLine key={`${finding.entityId ?? "x"}-${index}`} finding={finding} />
          ))}
          {check.findings.length > 20 ? <li className="type-caption text-ink-2">{t("anomalies.more", { count: check.findings.length - 20 })}</li> : null}
        </ul>
      ) : null}
    </li>
  );
}

function FindingLine({ finding }: { finding: AnomalyFinding }) {
  const t = useFinT();
  const f = useFormat();
  const vars: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(finding.values)) {
    if (value === null) vars[key] = "—";
    else if (typeof value === "number" && /iqd$/i.test(key)) vars[key] = f.iqd(value);
    else vars[key] = value;
  }
  const text = t(`anomalies.check.${finding.check}.finding`, vars);
  return (
    <li className="flex flex-wrap items-baseline gap-2 type-body">
      <StateTag group="severity" value={finding.severity} label={t(`severity.${finding.severity}`)} />
      <span>{text}</span>
      {finding.href ? (
        <Link to={finding.href} className="adm-link">
          {t("anomalies.open")}
        </Link>
      ) : finding.entityId ? (
        <Code className="type-caption">{finding.entityId}</Code>
      ) : null}
    </li>
  );
}
