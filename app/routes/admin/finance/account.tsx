import { useRef } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/account";
import { accountLedger, type AccountLedgerRow } from "~/server/services/admin/finance/ledger.server";
import { pageOf, parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { openFinance, orRespond } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, DemoTag, Kpi, Money, PageHead, Pair, PrintKey, RangeBar, RefView, ResponsiveTable, Section, useFinT, usePrintInLight, When } from "./ui";

/**
 * /admin/finance/accounts/:accountId — one account's ledger (10.01): opening balance, every line of the range with
 * the running balance after it (newest first), closing balance. Balances are on the account's normal side; a negative
 * one is shown in red with its minus sign. Printable.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.journal.read");
  const search = new URL(request.url).searchParams;
  const range = parseRange(search, now);
  const ledger = await orRespond(() => accountLedger(db, actor, params.accountId, range, pageOf(search), locale));
  return { ledger, range, now };
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "ledger.title");

export default function AccountLedgerPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const { ledger, range, now } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const account = ledger.account;

  const columns: DataColumn<AccountLedgerRow>[] = [
    {
      key: "at",
      header: t("ledger.col.date"),
      cell: (row) => (
        <Link to={`/admin/finance/journal/${row.entryId}`} className="adm-link">
          <When at={row.at} kind="date" />
        </Link>
      ),
    },
    {
      key: "memo",
      header: t("ledger.col.memo"),
      cell: (row) => (
        <span className="grid py-1">
          <span>{row.memo ?? "—"}</span>
          {row.lineMemo ? <span className="type-caption text-ink-2">{row.lineMemo}</span> : null}
        </span>
      ),
    },
    { key: "ref", header: t("ledger.col.ref"), cell: (row) => <RefView link={row.link} refType={row.refType} /> },
    { key: "center", header: t("ledger.col.center"), cell: (row) => (row.costCenter ? <Code>{row.costCenter}</Code> : "") },
    { key: "debit", header: t("ledger.col.debit"), numeric: true, cell: (row) => (row.debitIqd ? <Money iqd={row.debitIqd} plain /> : "") },
    { key: "credit", header: t("ledger.col.credit"), numeric: true, cell: (row) => (row.creditIqd ? <Money iqd={row.creditIqd} plain /> : "") },
    { key: "balance", header: t("ledger.col.balance"), numeric: true, cell: (row) => <Money iqd={row.balanceIqd} plain /> },
    { key: "demo", header: <span className="sr-only">{t("common.demo")}</span>, cell: (row) => <DemoTag show={row.isDemo} /> },
  ];

  return (
    <div ref={sheet} className="fin-print">
      <PageHead
        eyebrow={
          <Link to={`/admin/finance/accounts${rangeSearch(range)}`} className="adm-link">
            {t("ledger.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <Code>{account.code}</Code> {account.name}
            {!account.isActive ? <Status tone="neutral">{t("accounts.inactive")}</Status> : null}
          </span>
        }
        lead={t(`ledger.normal.${account.type}${account.isContra ? "_contra" : ""}`)}
        actions={<PrintKey label={t("common.print")} />}
      />
      <RangeBar range={range} action={`/admin/finance/accounts/${account.id}`} now={now} />

      <div className="fin-kpis my-5">
        <Kpi label={t("ledger.opening")} value={<Money iqd={ledger.openingIqd} />} hint={t("ledger.openingHint", { date: range.from })} />
        <Kpi label={t("ledger.debits")} value={<Money iqd={ledger.debitIqd} />} />
        <Kpi label={t("ledger.credits")} value={<Money iqd={ledger.creditIqd} />} />
        <Kpi label={t("ledger.closing")} value={<Money iqd={ledger.closingIqd} />} hint={t("ledger.closingHint", { date: range.to })} />
      </div>

      {ledger.children.length ? (
        <p className="mb-4 type-body text-ink-2">
          {t("ledger.children")}{" "}
          {ledger.children.map((child, index) => (
            <span key={child.id}>
              {index ? "، " : ""}
              <Link to={`/admin/finance/accounts/${child.id}${rangeSearch(range)}`} className="adm-link">
                <Code>{child.code}</Code> {child.name}
              </Link>
            </span>
          ))}
        </p>
      ) : null}

      <Section id="ledger-lines" title={t("ledger.lines")} aside={<span className="type-caption text-ink-2">{t("ledger.count", { count: ledger.total })}</span>}>
        <ResponsiveTable
          caption={t("ledger.lines")}
          columns={columns}
          rows={ledger.rows}
          rowKey={(row) => row.lineId}
          empty={<EmptyState title={t("ledger.empty")} text={range.demo ? undefined : t("ledger.emptyHint")} icon="book-open" />}
          footer={<Pagination page={ledger.page} pageCount={ledger.pageCount} href={(n) => rangeSearch(range, { page: n > 1 ? n : null }) || "?"} />}
          card={(row) => (
            <>
              <span className="flex items-baseline justify-between gap-2">
                <Link to={`/admin/finance/journal/${row.entryId}`} className="adm-link">
                  <When at={row.at} kind="date" />
                </Link>
                <DemoTag show={row.isDemo} />
              </span>
              <span className="type-body">{row.memo ?? "—"}</span>
              {row.debitIqd ? <Pair label={t("ledger.col.debit")}><Money iqd={row.debitIqd} /></Pair> : null}
              {row.creditIqd ? <Pair label={t("ledger.col.credit")}><Money iqd={row.creditIqd} /></Pair> : null}
              <Pair label={t("ledger.col.balance")}>
                <Money iqd={row.balanceIqd} />
              </Pair>
            </>
          )}
        />
      </Section>
    </div>
  );
}
