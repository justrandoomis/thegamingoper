import { Link } from "react-router";

import type { Route } from "./+types/anomalies";
import { useFormat } from "~/i18n/react";
import { unusualTransactions } from "~/server/services/admin/automation/anomalies.server";
import { ANOMALY_RULES, parseAnomalyFilters, type OwnCheck, type OwnFinding } from "~/server/services/admin/automation/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { automation } from "./automation.server";
import { Code, DemoTag, LinkChips, Money, Note, PageHead, Pair, ResponsiveList, Section, StatusText, When, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/anomalies — 19.04: unusual transactions and cost variances by deterministic rules with their
 * thresholds written out (large refunds, large discounts, unusually large orders, cost jumps between receipts — the
 * last only with cost.read), next to finance 10.10's anomaly checks and purchasing 09.07's variance alerts for whoever
 * may read them. Run when the page opens; nothing is stored or changed. Demo records only with the switch.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.anomaly.read");
  const filters = parseAnomalyFilters(new URL(args.request.url).searchParams);
  const hub = await automation.orRespond(() => unusualTransactions(req.db, req.actor, filters, req.locale, req.now));
  return { hub, filters };
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "anomalies.title");

/** A finance check's name; a check finance adds later shows its key until it has words here. */
function financeLabel(t: (key: string) => string, check: string): string {
  const key = `anomalies.finance.check.${check.replace(/\./g, "_")}`;
  const text = t(key);
  return text === key ? check : text;
}

function CheckBlock({ check }: { check: OwnCheck }) {
  const t = useAutoT();
  const f = useFormat();
  const threshold = (() => {
    switch (check.check) {
      case "refund.large":
        return t("anomalies.rule.refund", { floor: f.iqd(ANOMALY_RULES.refundFloorIqd), factor: ANOMALY_RULES.refundFactor, median: check.threshold.medianIqd === null ? t("anomalies.noMedian", { min: ANOMALY_RULES.minHistory }) : f.iqd(Number(check.threshold.medianIqd)), threshold: f.iqd(Number(check.threshold.thresholdIqd ?? 0)) });
      case "order.discount_high":
        return t("anomalies.rule.discount", { share: f.number(ANOMALY_RULES.discountShareBps / 100), floor: f.iqd(ANOMALY_RULES.discountFloorIqd) });
      case "order.value_outlier":
        return check.status === "short_history"
          ? t("anomalies.rule.valueShort", { orders: f.number(Number(check.threshold.orders ?? 0)), min: ANOMALY_RULES.minOrders })
          : t("anomalies.rule.value", { factor: ANOMALY_RULES.orderFactor, median: f.iqd(Number(check.threshold.medianIqd ?? 0)), threshold: f.iqd(Number(check.threshold.thresholdIqd ?? 0)) });
      case "cost.jump":
        return t("anomalies.rule.cost", { share: f.number(ANOMALY_RULES.costJumpBps / 100), days: ANOMALY_RULES.costWindowDays });
    }
  })();
  const record = (row: OwnFinding) => (
    <span className="grid justify-items-start gap-1">
      {row.href ? (
        <Link to={row.href} className="adm-link">
          <Code>{row.label}</Code>
        </Link>
      ) : (
        <Code>{row.label}</Code>
      )}
      {row.demo ? <DemoTag /> : null}
    </span>
  );
  const figures = (row: OwnFinding) => {
    const v = row.values;
    switch (check.check) {
      case "refund.large":
        return (
          <span className="grid">
            <Money iqd={Number(v.amountIqd)} />
            <span className="type-caption text-ink-2">
              {t("anomalies.ofOrder")} <Money iqd={Number(v.orderTotalIqd)} />
            </span>
          </span>
        );
      case "order.discount_high":
        return (
          <span className="grid">
            <Money iqd={Number(v.discountIqd)} />
            <span className="type-caption text-ink-2">{t("anomalies.share", { share: f.number(Number(v.shareBps) / 100) })}</span>
          </span>
        );
      case "order.value_outlier":
        return <Money iqd={Number(v.totalIqd)} />;
      case "cost.jump":
        return (
          <span className="grid">
            <span>
              {t("anomalies.from")} <Money iqd={Number(v.previousIqd)} /> {t("anomalies.to")} <Money iqd={Number(v.unitCostIqd)} />
            </span>
            <span className="type-caption text-ink-2">{t("anomalies.change", { change: f.number(Number(v.changeBps) / 100) })}</span>
          </span>
        );
    }
  };
  const columns: DataColumn<OwnFinding>[] = [
    { key: "at", header: t("anomalies.col.at"), cell: (row) => <When at={row.at} /> },
    { key: "record", header: t("anomalies.col.record"), cell: record },
    { key: "figures", header: t("anomalies.col.figures"), cell: figures },
  ];
  const tone = check.status === "found" ? "warn" : check.status === "ok" ? "ok" : "neutral";
  return (
    <section className="grid gap-3" aria-labelledby={`auto-check-${check.check}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`auto-check-${check.check}`} className="adm-h3">
          {t(`anomalies.check.${check.check}`)}
        </h3>
        <StatusText tone={tone}>{t(`anomalies.status.${check.status}`, { count: check.total })}</StatusText>
      </div>
      <p className="type-caption text-ink-2">{threshold}</p>
      {check.total > check.findings.length ? <p className="type-caption text-ink-2">{t("anomalies.shown", { shown: f.number(check.findings.length), total: f.number(check.total) })}</p> : null}
      {check.status === "needs_cost" ? (
        <p className="type-body text-ink-2">{t("anomalies.needsCost")}</p>
      ) : check.findings.length ? (
        <ResponsiveList
          caption={t(`anomalies.check.${check.check}`)}
          columns={columns}
          rows={check.findings}
          rowKey={(row) => row.id}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                {record(row)}
                <When at={row.at} />
              </div>
              <Pair label={t("anomalies.col.figures")}>{figures(row)}</Pair>
            </>
          )}
        />
      ) : null}
    </section>
  );
}

export default function AnomaliesPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { hub, filters } = loaderData;
  const found = hub.checks.reduce((sum, check) => sum + check.total, 0);
  return (
    <>
      <PageHead title={t("anomalies.title")} lead={t("anomalies.lead")} />
      <LinkChips
        label={t("anomalies.demoSwitch")}
        items={[
          { value: "real", label: t("anomalies.realOnly"), href: "/admin/automation/anomalies", selected: !filters.demo },
          { value: "demo", label: t("anomalies.withDemo"), href: "/admin/automation/anomalies?demo=1", selected: filters.demo },
        ]}
      />
      <Note icon="info">
        <p>{t("anomalies.how")}</p>
        <p className="type-caption text-ink-2">
          {t("anomalies.ranAt")} <When at={hub.ranAt} />
        </p>
      </Note>

      <Section id="auto-own" title={t("anomalies.own")} aside={<span className="type-caption text-ink-2">{t("anomalies.found", { count: found })}</span>}>
        {found === 0 && hub.checks.every((check) => check.status !== "needs_cost") ? <EmptyState title={t("anomalies.nothing")} text={t("anomalies.nothingText")} icon="seal-check" /> : null}
        <div className="grid gap-6">
          {hub.checks.map((check) => (
            <CheckBlock key={check.check} check={check} />
          ))}
        </div>
      </Section>

      <Section id="auto-others" title={t("anomalies.others")}>
        <div className="grid gap-3">
          <div className="adm-card gap-2">
            <p className="type-strong">{t("anomalies.finance.title")}</p>
            {hub.finance ? (
              <>
                {/* only the checks that found something (or need cost.read) are listed; the quiet ones are counted */}
                {(() => {
                  const flagged = hub.finance.checks.filter((check) => check.status === "needs_cost" || check.critical + check.warning > 0);
                  const quiet = hub.finance.checks.length - flagged.length;
                  return (
                    <>
                      {flagged.length ? (
                        <ul className="auto-lines type-caption">
                          {flagged.map((check) => (
                            <li key={check.check}>
                              {financeLabel(t, check.check)} · {check.status === "needs_cost" ? t("anomalies.needsCostShort") : t("anomalies.finance.counts", { critical: f.number(check.critical), warning: f.number(check.warning) })}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {quiet > 0 ? <p className="type-caption">{t(flagged.length ? "anomalies.finance.quiet" : "anomalies.finance.allQuiet", { count: quiet })}</p> : null}
                    </>
                  );
                })()}
                <p className="type-caption text-ink-2">{t("anomalies.finance.stored", { count: hub.finance.stored })}</p>
                <Link to={hub.finance.href} className="adm-link type-label">
                  {t("anomalies.finance.open")}
                </Link>
              </>
            ) : (
              <p className="type-caption text-ink-2">{t("anomalies.finance.none")}</p>
            )}
          </div>
          <div className="adm-card gap-2">
            <p className="type-strong">{t("anomalies.purchasing.title")}</p>
            {hub.purchasing ? (
              <>
                <ul className="auto-lines type-caption">
                  {Object.entries(hub.purchasing.counts).map(([kind, count]) => (
                    <li key={kind}>
                      {t(`anomalies.purchasing.kind.${kind}`)} · <bdi className="nums">{f.number(Number(count ?? 0))}</bdi>
                    </li>
                  ))}
                </ul>
                {!hub.purchasing.withCost ? <p className="type-caption text-ink-2">{t("anomalies.purchasing.noCost")}</p> : null}
                <Link to={hub.purchasing.href} className="adm-link type-label">
                  {t("anomalies.purchasing.open")}
                </Link>
              </>
            ) : (
              <p className="type-caption text-ink-2">{t("anomalies.purchasing.none")}</p>
            )}
          </div>
        </div>
      </Section>
    </>
  );
}
