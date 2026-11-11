import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/entry";
import { useFormat } from "~/i18n/react";
import { getEntry, reverseEntry, type EntryLine } from "~/server/services/admin/finance/ledger.server";
import type { DataColumn } from "~/ui/DataTable";
import { Key } from "~/ui/Key";
import { failed, ok, openFinance, orRespond, text, financeT } from "./finance.server";
import { financeMeta } from "./meta";
import { ActionDialog, ByLabel, Code, DemoTag, Flag, Ledger, Money, Note, PageHead, Pair, PeriodName, RefView, ResponsiveTable, Section, StateTag, useFinT, When } from "./ui";

/**
 * /admin/finance/journal/:entryId — one journal entry (10.01): its lines, who posted it and why it exists, what it
 * reverses or was reversed by. A MANUAL entry can be reversed here (finance.journal.post): a mirror entry dated now
 * in an open month (10.09: a closed month changes only this way); automatic postings are corrected by their own flows.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await openFinance(context, "finance.journal.read");
  const entry = await orRespond(() => getEntry(db, actor, params.entryId, locale));
  return { entry };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.journal.post");
  const form = await request.formData();
  try {
    const { reversalId, replayed } = await reverseEntry(req.db, req.actor, { entryId: params.entryId, reason: text(form, "reason") }, req.now);
    return ok({ intent: "reverse", reversalId, message: financeT(req.locale)(replayed ? "entry.reverseReplayed" : "entry.reversed") });
  } catch (error) {
    return failed(error, req.locale, "reverse");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "entry.title");

export default function EntryPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const [params] = useSearchParams();
  const { entry } = loaderData;
  const [reversing, setReversing] = useState(false);

  const columns: DataColumn<EntryLine>[] = [
    {
      key: "account",
      header: t("entry.col.account"),
      cell: (line) => (
        <Link to={`/admin/finance/accounts/${line.accountId}`} className="adm-link">
          <Code>{line.code}</Code> · {line.name}
        </Link>
      ),
    },
    { key: "debit", header: t("entry.col.debit"), numeric: true, cell: (line) => (line.debitIqd ? <Money iqd={line.debitIqd} plain /> : "") },
    { key: "credit", header: t("entry.col.credit"), numeric: true, cell: (line) => (line.creditIqd ? <Money iqd={line.creditIqd} plain /> : "") },
    { key: "center", header: t("entry.col.center"), cell: (line) => (line.costCenter ? <Code>{line.costCenter}</Code> : "—") },
    { key: "memo", header: t("entry.col.memo"), cell: (line) => line.memo ?? "" },
  ];

  return (
    <div className="max-w-5xl">
      <PageHead
        eyebrow={
          <Link to="/admin/finance/journal" className="adm-link">
            {t("entry.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t("entry.title")} <Code className="type-sub">{entry.id}</Code>
            <DemoTag show={entry.isDemo} />
          </span>
        }
        lead={entry.memo ?? undefined}
        actions={
          entry.canReverse ? (
            <Key size="sm" icon="arrow-counter-clockwise" onClick={() => setReversing(true)}>
              {t("entry.reverse")}
            </Key>
          ) : null
        }
      />

      {params.get("posted") ? (
        <Note icon="check-circle" tone="ok">
          <p>{t("entry.postedNow")}</p>
        </Note>
      ) : null}

      <div className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Section id="entry-lines" title={t("entry.lines")}>
          <ResponsiveTable
            caption={t("entry.lines")}
            columns={columns}
            rows={entry.lines}
            rowKey={(line) => line.id}
            card={(line) => (
              <>
                <Link to={`/admin/finance/accounts/${line.accountId}`} className="adm-link">
                  <Code>{line.code}</Code> · {line.name}
                </Link>
                {line.debitIqd ? <Pair label={t("entry.col.debit")}><Money iqd={line.debitIqd} /></Pair> : null}
                {line.creditIqd ? <Pair label={t("entry.col.credit")}><Money iqd={line.creditIqd} /></Pair> : null}
                {line.costCenter ? <Pair label={t("entry.col.center")}><Code>{line.costCenter}</Code></Pair> : null}
                {line.memo ? <p className="type-caption text-ink-2">{line.memo}</p> : null}
              </>
            )}
          />
          <Ledger
            className="adm-card max-w-sm"
            rows={[
              { label: t("entry.totalDebit"), value: <Money iqd={entry.totalIqd} /> },
              { label: t("entry.totalCredit"), value: <Money iqd={entry.lines.reduce((total, line) => total + line.creditIqd, 0)} /> },
            ]}
          />
        </Section>

        <aside className="grid content-start gap-4">
          <Section id="entry-facts" title={t("entry.facts")}>
            <Ledger
              rows={[
                { label: t("entry.date"), value: <When at={entry.at} /> },
                {
                  label: t("entry.period"),
                  value: (
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      <PeriodName period={entry.period} />
                      <StateTag group="period" value={entry.periodClosed ? "closed" : "open"} label={t(entry.periodClosed ? "period.closed" : "period.open")} />
                    </span>
                  ),
                },
                { label: t("entry.reference"), value: <RefView link={entry.link} refType={entry.refType} /> },
                { label: t("entry.by"), value: <ByLabel by={entry.by} /> },
                { label: t("entry.key"), value: entry.idempotencyKey ? <Code className="type-caption">{entry.idempotencyKey}</Code> : "—" },
              ]}
            />
          </Section>
          {entry.reverses ? (
            <Note icon="arrow-counter-clockwise">
              <p>
                {t("entry.reversesThis")}{" "}
                <Link to={`/admin/finance/journal/${entry.reverses.id}`} className="adm-link">
                  <Code>{entry.reverses.id}</Code>
                </Link>
              </p>
            </Note>
          ) : null}
          {entry.reversedBy ? (
            <Note icon="arrow-counter-clockwise" tone="warn">
              <p>
                {t("entry.reversedOn", { date: f.dateTime(entry.reversedBy.at) })}{" "}
                <Link to={`/admin/finance/journal/${entry.reversedBy.id}`} className="adm-link">
                  <Code>{entry.reversedBy.id}</Code>
                </Link>
              </p>
            </Note>
          ) : null}
          {entry.reverseBlocked === "not_manual" ? (
            <Note>
              <p>{t("entry.automatic")}</p>
            </Note>
          ) : null}
          {entry.periodClosed ? (
            <Note icon="lock">
              <p>{t("entry.closedPeriod")}</p>
            </Note>
          ) : null}
          <Flag icon="lock">{t("entry.sealed")}</Flag>
        </aside>
      </div>

      <ActionDialog
        open={reversing}
        onClose={() => setReversing(false)}
        tone="destructive"
        title={t("entry.reverseQ")}
        consequence={t("entry.reverseWhat")}
        confirmLabel={t("entry.reverse")}
        impact={[
          { label: t("entry.reverseAmount"), value: f.iqd(entry.totalIqd), negative: true },
          { label: t("entry.reverseDated"), value: t("entry.reverseToday") },
        ]}
        reason={{ label: t("common.reason"), hint: t("entry.reverseHint"), minLength: 3 }}
        fields={{ intent: "reverse" }}
      />
    </div>
  );
}
