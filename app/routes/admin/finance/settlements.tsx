import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/settlements";
import { useFormat } from "~/i18n/react";
import { listStatementLines, matchExactLines, settlementOverview, unreconciledPayments, type MoneyCount, type StatementFilters, type StatementLineRow } from "~/server/services/admin/finance/settlements.server";
import { pageOf, parseRange, queryText, rangeSearch, STATEMENT_SOURCES, STATEMENT_STATUSES, type StatementSource } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { failed, financeT, ok, openFinance, orRespond } from "./finance.server";
import { financeMeta } from "./meta";
import { ActionDialog, Code, DemoTag, Ledger, Money, Note, PageHead, Pair, RangeBar, ResponsiveTable, Section, StateTag, useFinT, When } from "./ui";

/**
 * /admin/finance/settlements — 10.02: what each payment method owes and has settled (cash on delivery, card and Zain
 * Cash transfers, the wallet; no online card gateway is configured), the imported statement lines with what each one
 * is matched to, and the paid payments no statement proves yet. finance.settlement.reconcile.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openFinance(context, "finance.settlement.reconcile");
  const params = new URL(request.url).searchParams;
  const range = parseRange(params, now);
  const source = params.get("source");
  const status = params.get("status");
  const filters: StatementFilters = {
    ...range,
    source: (STATEMENT_SOURCES as readonly string[]).includes(source ?? "") ? (source as StatementSource) : null,
    status: (STATEMENT_STATUSES as readonly string[]).includes(status ?? "") ? (status as StatementFilters["status"]) : null,
    q: queryText(params),
    page: pageOf(params),
  };
  const [overview, lines, unreconciled] = await orRespond(() => Promise.all([settlementOverview(db, actor, range), listStatementLines(db, actor, filters), unreconciledPayments(db, actor, range)]));
  return { overview, lines, unreconciled, filters, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.settlement.reconcile");
  const form = await request.formData();
  try {
    const range = parseRange(new URLSearchParams([...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string")), req.now);
    const { matched, skipped } = await matchExactLines(req.db, req.actor, range, req.now);
    return ok({ intent: "match-exact", message: financeT(req.locale)("settlements.matchedExact", { matched, skipped }) });
  } catch (error) {
    return failed(error, req.locale, "match-exact");
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "settlements.title");

function Count({ value }: { value: MoneyCount }) {
  const t = useFinT();
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
      <Money iqd={value.iqd} />
      <span className="type-caption text-ink-2">{t("common.countOf", { count: value.count })}</span>
    </span>
  );
}

export default function SettlementsPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const { overview, lines, unreconciled, filters, now } = loaderData;
  const [matching, setMatching] = useState(false);
  const keep = { source: filters.source, status: filters.status, q: filters.q || null };

  const columns: DataColumn<StatementLineRow>[] = [
    {
      key: "at",
      header: t("settlements.col.date"),
      cell: (row) => (
        <Link to={`/admin/finance/settlements/${row.id}`} className="adm-link">
          <When at={row.occurredAt} />
        </Link>
      ),
    },
    { key: "source", header: t("settlements.col.source"), cell: (row) => t(`source.${row.source}`) },
    { key: "amount", header: t("settlements.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} plain /> },
    { key: "reference", header: t("settlements.col.reference"), cell: (row) => (row.reference ? <Code>{row.reference}</Code> : "—") },
    { key: "who", header: t("settlements.col.counterparty"), cell: (row) => <span className="line-clamp-2">{row.counterparty ?? row.description ?? "—"}</span> },
    {
      key: "status",
      header: t("settlements.col.status"),
      cell: (row) => (
        <span className="grid gap-0.5 py-1">
          <StateTag group="statement" value={row.status} label={t(`lineStatus.${row.status}`)} />
          {row.payment ? (
            <Link to={`/admin/orders/${row.payment.orderRef}`} className="adm-link type-caption">
              <Code>{row.payment.orderRef}</Code>
            </Link>
          ) : null}
          {row.differs ? <span className="type-caption text-warn">{t("settlements.differs")}</span> : null}
        </span>
      ),
    },
  ];

  const methods = [
    {
      id: "cod",
      rows: [
        { label: t("settlements.cod.outstanding"), value: <Count value={overview.cod.outstanding} /> },
        { label: t("settlements.cod.deliveredUncollected"), value: <Count value={overview.cod.deliveredUncollected} />, indent: true },
        { label: t("settlements.cod.collected"), value: <Count value={overview.cod.collected} /> },
        { label: t("settlements.cod.awaitingCarrier"), value: <Count value={overview.cod.awaitingCarrier} /> },
      ],
      note: t("settlements.cod.note"),
    },
    ...overview.transfers.map((transfer) => ({
      id: transfer.method,
      rows: [
        { label: t("settlements.transfer.waiting"), value: <Count value={transfer.waiting} /> },
        { label: t("settlements.transfer.verified"), value: <Count value={transfer.verified} /> },
        { label: t("settlements.transfer.matched"), value: <Count value={transfer.matched} />, indent: true },
        { label: t("settlements.transfer.unmatched"), value: <Count value={transfer.unmatched} />, indent: true },
      ],
      note: t("settlements.transfer.note"),
    })),
    {
      id: "wallet",
      rows: [
        { label: t("settlements.wallet.payments"), value: <Count value={overview.wallet.payments} /> },
        { label: t("settlements.wallet.topups"), value: <Count value={overview.wallet.topups} /> },
        { label: t("settlements.wallet.refunds"), value: <Count value={overview.wallet.refunds} /> },
      ],
      note: t("settlements.wallet.note"),
    },
  ];

  return (
    <>
      <PageHead
        title={t("settlements.title")}
        lead={t("settlements.lead")}
        actions={
          <Key as={Link} to="/admin/finance/settlements/import" size="sm" variant="ink" icon="upload-simple">
            {t("settlements.import")}
          </Key>
        }
      />
      <RangeBar range={filters} action="/admin/finance/settlements" keep={keep} now={now} />

      <Section id="settle-methods" title={t("settlements.byMethod")} className="mt-5">
        <div className="adm-grid">
          {methods.map((method) => (
            <article key={method.id} className="adm-card content-start">
              <h3 className="adm-h3">{t(`method.${method.id}`)}</h3>
              <Ledger rows={method.rows} />
              <p className="type-caption text-ink-2">{method.note}</p>
            </article>
          ))}
          <article className="adm-card content-start">
            <h3 className="adm-h3">{t("method.card")}</h3>
            <Status tone="neutral">{t("status.boundary")}</Status>
            <p className="type-caption text-ink-2">{t("settlements.card.note")}</p>
            {overview.card.count ? <Ledger rows={[{ label: t("settlements.card.pos"), value: <Count value={overview.card} /> }]} /> : null}
          </article>
        </div>
        {overview.cod.settlements.length ? (
          <div className="adm-card content-start">
            <h3 className="adm-h3">{t("settlements.carrierSettlements")}</h3>
            <Ledger rows={overview.cod.settlements.map((row) => ({ label: `${t(`codSettlement.${row.status}`)} (${row.count})`, value: <Money iqd={row.receivedIqd} />, hint: row.varianceIqd ? t("settlements.variance", { amount: f.iqd(row.varianceIqd) }) : undefined }))} />
          </div>
        ) : null}
      </Section>

      <Section
        id="settle-lines"
        title={t("settlements.lines")}
        aside={
          <Key size="sm" icon="check-circle" onClick={() => setMatching(true)}>
            {t("settlements.matchExact")}
          </Key>
        }
      >
        <Disclosure summary={t("common.filters")} variant="row" defaultOpen={Boolean(filters.source || filters.status || filters.q)}>
        <Form method="get" action="/admin/finance/settlements" className="fin-noprint grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-4">
          {filters.period ? <input type="hidden" name="period" value={filters.period} /> : <><input type="hidden" name="from" value={filters.from} /><input type="hidden" name="to" value={filters.to} /></>}
          {filters.demo ? <input type="hidden" name="demo" value="1" /> : null}
          <Select name="source" label={t("settlements.col.source")} defaultValue={filters.source ?? ""} options={[{ value: "", label: t("common.any") }, ...STATEMENT_SOURCES.map((source) => ({ value: source, label: t(`source.${source}`) }))]} />
          <Select name="status" label={t("settlements.col.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("common.any") }, ...STATEMENT_STATUSES.map((status) => ({ value: status, label: t(`lineStatus.${status}`) }))]} />
          <TextField name="q" type="search" label={t("settlements.search")} defaultValue={filters.q} />
          <div className="flex items-end gap-2">
            <Key type="submit" variant="ink" icon="funnel" size="sm">
              {t("range.apply")}
            </Key>
            <Key as={Link} to="/admin/finance/settlements" size="sm">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        </Disclosure>
        <p className="type-caption text-ink-2">{t("settlements.linesTotals", { count: lines.total, in: f.iqd(lines.totals.inIqd), out: f.iqd(lines.totals.outIqd) })}</p>
        <ResponsiveTable
          caption={t("settlements.lines")}
          columns={columns}
          rows={lines.rows}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              title={t("settlements.noLines")}
              text={t("settlements.noLinesHint")}
              icon="bank"
              action={
                <Key as={Link} to="/admin/finance/settlements/import" size="sm" icon="upload-simple">
                  {t("settlements.import")}
                </Key>
              }
            />
          }
          footer={<Pagination page={lines.page} pageCount={lines.pageCount} href={(n) => rangeSearch(filters, { ...keep, page: n > 1 ? n : null }) || "?"} />}
          card={(row) => (
            <Link to={`/admin/finance/settlements/${row.id}`} className="grid gap-1 no-underline">
              <span className="flex items-baseline justify-between gap-2">
                <span className="type-strong">
                  <Money iqd={row.amountIqd} />
                </span>
                <StateTag group="statement" value={row.status} label={t(`lineStatus.${row.status}`)} />
              </span>
              <Pair label={t("settlements.col.source")}>{t(`source.${row.source}`)}</Pair>
              <Pair label={t("settlements.col.date")}>
                <When at={row.occurredAt} />
              </Pair>
              {row.reference ? (
                <Pair label={t("settlements.col.reference")}>
                  <Code>{row.reference}</Code>
                </Pair>
              ) : null}
              {row.payment ? (
                <Pair label={t("settlements.matchedTo")}>
                  <Code>{row.payment.orderRef}</Code>
                </Pair>
              ) : null}
            </Link>
          )}
        />
      </Section>

      <Section id="settle-unreconciled" title={t("settlements.unreconciled")} aside={<Count value={unreconciled.total} />}>
        <p className="max-w-[72ch] type-body text-ink-2">{t("settlements.unreconciledLead")}</p>
        {unreconciled.rows.length === 0 ? (
          <EmptyState title={t("settlements.allProven")} icon="check-circle" />
        ) : (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {unreconciled.rows.map((row) => (
              <li key={row.id} className="adm-card gap-1">
                <span className="flex items-baseline justify-between gap-2">
                  <Link to={`/admin/orders/${row.orderRef}`} className="adm-link">
                    <Code>{row.orderRef}</Code>
                  </Link>
                  <Money iqd={row.amountIqd} className="type-strong" />
                </span>
                <Pair label={t("settlements.col.method")}>{t(`method.${row.method}`)}</Pair>
                <Pair label={t("settlements.paidAt")}>
                  <When at={row.paidAt} />
                </Pair>
                {row.reference ? (
                  <Pair label={t("settlements.col.reference")}>
                    <Code>{row.reference}</Code>
                  </Pair>
                ) : null}
                <DemoTag show={row.isDemo} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Note>
        <p>{t("settlements.howItWorks")}</p>
      </Note>

      <ActionDialog
        open={matching}
        onClose={() => setMatching(false)}
        title={t("settlements.matchExactQ")}
        consequence={t("settlements.matchExactWhat")}
        confirmLabel={t("settlements.matchExact")}
        fields={{ intent: "match-exact", ...(filters.period ? { period: filters.period } : { from: filters.from, to: filters.to }) }}
      />
    </>
  );
}
