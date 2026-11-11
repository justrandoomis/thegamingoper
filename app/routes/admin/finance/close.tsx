import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/close";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { closeChecklist, closePeriod, listPeriods, type PeriodRow } from "~/server/services/admin/finance/close.server";
import { isPeriod, periodOf, shiftPeriod } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { Key } from "~/ui/Key";
import { failed, financeT, ok, openFinance, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { ActionDialog, Money, Note, PageHead, Pair, PeriodName, ResponsiveTable, Section, StateTag, useFinanceLayout, useFinT, usePeriodLabel, When } from "./ui";

/**
 * /admin/finance/close — 10.09: the monthly close. Every month with entries, its state and who closed it; for the
 * chosen month (default: the last one that is over and still open) the checklist — blocking items stop the close,
 * warnings are shown with their counts — and the close itself (finance.period.close, a reason, the impact shown
 * first). A closed month refuses every new entry in the database; it changes only through reversing or adjusting
 * entries dated in an open month. There is no reopen.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openFinance(context);
  const asked = new URL(request.url).searchParams.get("period");
  const periods = await orRespond(() => listPeriods(db, actor, now));
  const current = periodOf(now);
  const fallback = periods.find((row) => row.status === "open" && row.period < current && row.entries > 0)?.period ?? shiftPeriod(current, -1);
  const period = isPeriod(asked) ? asked : fallback;
  const checklist = await orRespond(() => closeChecklist(db, actor, period, now));
  return { periods, checklist, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.period.close");
  const form = await request.formData();
  try {
    const { replayed } = await closePeriod(req.db, req.actor, { period: text(form, "period"), reason: text(form, "reason") }, req.now);
    return ok({ intent: "close", message: financeT(req.locale)(replayed ? "close.alreadyClosed" : "close.closed") });
  } catch (error) {
    return failed(error, req.locale, "close");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "close.title");

export default function ClosePage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const label = usePeriodLabel();
  const layout = useFinanceLayout();
  const { periods, checklist } = loaderData;
  const [closing, setClosing] = useState(false);
  const warnings = checklist.items.filter((item) => item.state === "warn");

  const columns: DataColumn<PeriodRow>[] = [
    {
      key: "period",
      header: t("close.col.period"),
      cell: (row) => (
        <Link to={`/admin/finance/close?period=${row.period}`} className="adm-link" aria-current={row.period === checklist.period ? "true" : undefined}>
          <PeriodName period={row.period} />
        </Link>
      ),
    },
    { key: "status", header: t("close.col.status"), cell: (row) => <StateTag group="period" value={row.status} label={t(`period.${row.status}`)} /> },
    { key: "entries", header: t("close.col.entries"), numeric: true, cell: (row) => <bdi className="nums">{f.number(row.entries)}</bdi> },
    ...(periods.some((row) => row.totalIqd !== null) ? [{ key: "total", header: t("close.col.total"), numeric: true, cell: (row: PeriodRow) => <Money iqd={row.totalIqd} plain /> }] : []),
    { key: "closed", header: t("close.col.closed"), cell: (row) => (row.closedAt ? <span className="whitespace-nowrap">{row.closedBy ?? "—"} · <When at={row.closedAt} kind="date" /></span> : "—") },
  ];

  return (
    <>
      <PageHead title={t("close.title")} lead={t("close.lead")} />

      <Section id="close-check" title={t("close.checklistFor", { period: label(checklist.period) })}>
        <div className="flex flex-wrap items-center gap-2">
          <StateTag group="period" value={checklist.status} label={t(`period.${checklist.status}`)} />
          <span className="type-caption text-ink-2">{t("close.entries", { count: checklist.entries })}</span>
          {checklist.totalIqd !== null ? (
            <span className="type-caption text-ink-2">
              · <Money iqd={checklist.totalIqd} />
            </span>
          ) : null}
        </div>
        {checklist.status === "closed" ? (
          <Note icon="lock" tone="ok">
            <p>{t("close.isClosed")}</p>
          </Note>
        ) : (
          <ul className="fin-checks">
            {checklist.items.map((item) => (
              <li key={item.key} data-state={item.state}>
                <Icon name={item.state === "ok" ? "check-circle" : item.state === "warn" ? "warning" : "x-circle"} size={20} />
                <div className="grid gap-0.5">
                  <p className="type-strong">{t(`close.item.${item.key}.${item.state}`, { count: item.count, periods: (item.periods ?? []).map(label).join("، ") })}</p>
                  {item.state !== "ok" ? <p className="type-caption text-ink-2">{t(`close.item.${item.key}.why`)}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {checklist.status === "open" ? (
          checklist.canClose ? (
            <div>
              <Key variant="commit" icon="lock" onClick={() => setClosing(true)}>
                {t("close.closeKey", { period: label(checklist.period) })}
              </Key>
            </div>
          ) : checklist.blocked ? (
            <p className="type-body text-ink-2">{t("close.blockedNote")}</p>
          ) : !layout?.access.close ? (
            <Note icon="lock">
              <p>{t("close.noPermission")}</p>
            </Note>
          ) : null
        ) : null}
      </Section>

      <Section id="close-periods" title={t("close.periods")}>
        <ResponsiveTable
          caption={t("close.periods")}
          columns={columns}
          rows={periods}
          rowKey={(row) => row.period}
          card={(row) => (
            <Link to={`/admin/finance/close?period=${row.period}`} className="grid gap-1 no-underline">
              <span className="flex items-baseline justify-between gap-2">
                <span className="type-strong">
                  <PeriodName period={row.period} />
                </span>
                <StateTag group="period" value={row.status} label={t(`period.${row.status}`)} />
              </span>
              <Pair label={t("close.col.entries")}>{f.number(row.entries)}</Pair>
              {row.closedAt ? <Pair label={t("close.col.closed")}>{row.closedBy ?? "—"}</Pair> : null}
            </Link>
          )}
        />
      </Section>
      <Note>
        <p>{t("close.correctionsNote")}</p>
      </Note>

      <ActionDialog
        open={closing}
        onClose={() => setClosing(false)}
        tone="commit"
        title={t("close.closeQ", { period: label(checklist.period) })}
        consequence={t("close.closeWhat")}
        confirmLabel={t("close.closeKey", { period: label(checklist.period) })}
        impact={[
          { label: t("close.impactEntries"), value: f.number(checklist.entries) },
          ...(checklist.totalIqd !== null ? [{ label: t("close.impactTotal"), value: f.iqd(checklist.totalIqd) }] : []),
          ...warnings.map((item) => ({ label: t(`close.item.${item.key}.short`), value: f.number(item.count) })),
        ]}
        reason={{ label: t("common.reason"), hint: t("close.reasonHint"), minLength: 3 }}
        fields={{ intent: "close", period: checklist.period }}
      />
    </>
  );
}
