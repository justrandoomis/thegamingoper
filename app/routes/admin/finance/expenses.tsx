import { Form, Link } from "react-router";

import type { Route } from "./+types/expenses";
import { useFormat } from "~/i18n/react";
import { listExpenses, type ExpenseFilters, type ExpenseRow } from "~/server/services/admin/finance/expense-views.server";
import { EXPENSE_STATUS_LIST, idParam, pageOf, parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import type { DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { openFinance, orRespond } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, Day, DemoHidden, DemoTag, Flag, Ledger, Money, Note, PageHead, Pair, RangeBar, ResponsiveTable, Section, StateTag, useFinT } from "./ui";

/**
 * /admin/finance/expenses — 10.05: operating, payroll, shipping and marketing expenses with cost centres. A recorded
 * expense is a draft (not in the books); approving posts it through the accounting core (one journal entry); above
 * the limit another person approves it. Totals by status, by account and by cost centre (posted only). Filters in the
 * URL. finance.expense.manage.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.expense.manage");
  const params = new URL(request.url).searchParams;
  const range = parseRange(params, now);
  const status = params.get("status");
  const filters: ExpenseFilters = {
    ...range,
    status: (EXPENSE_STATUS_LIST as readonly string[]).includes(status ?? "") ? (status as ExpenseFilters["status"]) : null,
    account: idParam(params, "account"),
    center: params.get("center") === "none" ? "none" : idParam(params, "center"),
    page: pageOf(params),
  };
  const page = await orRespond(() => listExpenses(db, actor, filters, locale, now));
  return { page, filters, now };
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "expenses.title");

export default function ExpensesPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const { page, filters, now } = loaderData;
  const keep = { status: filters.status, account: filters.account, center: filters.center };

  const columns: DataColumn<ExpenseRow>[] = [
    {
      key: "date",
      header: t("expenses.col.date"),
      cell: (row) => (
        <Link to={`/admin/finance/expenses/${row.id}`} className="adm-link">
          <Day day={row.incurredOn} />
        </Link>
      ),
    },
    {
      key: "what",
      header: t("expenses.col.what"),
      cell: (row) => (
        <span className="grid min-w-[12rem] py-1">
          <span>{row.description}</span>
          {row.vendor ? <span className="type-caption text-ink-2">{row.vendor}</span> : null}
        </span>
      ),
    },
    { key: "account", header: t("expenses.col.account"), cell: (row) => <span className="whitespace-nowrap">{row.account}</span> },
    { key: "center", header: t("expenses.col.center"), cell: (row) => (row.costCenter ? <Code>{row.costCenter}</Code> : "—") },
    { key: "amount", header: t("expenses.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} plain /> },
    {
      key: "status",
      header: t("expenses.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StateTag group="expense" value={row.status} label={t(`expenseStatus.${row.status}`)} />
          {row.needsOther ? <Flag icon="users">{t("expenses.needsOther")}</Flag> : null}
          {row.monthClosed ? <Flag icon="lock">{t("expenses.monthClosed")}</Flag> : null}
          {row.hasReceipt ? <Flag icon="paperclip">{t("expenses.receipt")}</Flag> : null}
          <DemoTag show={row.isDemo} />
        </span>
      ),
    },
    { key: "by", header: t("expenses.col.by"), cell: (row) => <span className="whitespace-nowrap">{row.createdBy ?? "—"}</span> },
  ];

  const total = (status: string) => page.totals.find((row) => row.status === status);

  return (
    <>
      <PageHead
        title={t("expenses.title")}
        lead={t("expenses.lead", { limit: f.iqd(page.threshold) })}
        actions={
          <>
            <Key as={Link} to="/admin/finance/cost-centers" size="sm" icon="stack">
              {t("expenses.costCenters")}
            </Key>
            <Key as={Link} to="/admin/finance/expenses/new" size="sm" variant="ink" icon="plus">
              {t("expenses.new")}
            </Key>
          </>
        }
      />
      <RangeBar range={filters} action="/admin/finance/expenses" keep={{ status: filters.status, account: filters.account, center: filters.center }} now={now} />

      <div className="fin-kpis my-5">
        {EXPENSE_STATUS_LIST.map((status) => (
          <Link key={status} to={`/admin/finance/expenses${rangeSearch(filters, { ...keep, status })}`} className="adm-card content-start no-underline">
            <span className="type-caption text-ink-2">{t(`expenseStatus.${status}`)}</span>
            <span className="type-kpi nums">
              <Money iqd={total(status)?.iqd ?? 0} />
            </span>
            <span className="type-caption text-ink-2">{t("common.countOf", { count: total(status)?.count ?? 0 })}</span>
          </Link>
        ))}
      </div>

      <Section id="exp-list" title={t("expenses.list")}>
        <Disclosure summary={t("common.filters")} variant="row" defaultOpen={Boolean(filters.status || filters.account || filters.center)}>
        <Form method="get" action="/admin/finance/expenses" className="fin-noprint grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-4">
          {filters.period ? <input type="hidden" name="period" value={filters.period} /> : <><input type="hidden" name="from" value={filters.from} /><input type="hidden" name="to" value={filters.to} /></>}
          {filters.demo ? <input type="hidden" name="demo" value="1" /> : null}
          <Select name="status" label={t("expenses.col.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("common.any") }, ...EXPENSE_STATUS_LIST.map((status) => ({ value: status, label: t(`expenseStatus.${status}`) }))]} />
          <Select name="account" label={t("expenses.col.account")} defaultValue={filters.account ?? ""} options={[{ value: "", label: t("common.any") }, ...page.byAccount.map((row) => ({ value: row.accountId, label: row.account }))]} />
          <TextField name="center" label={t("expenses.col.center")} hint={t("expenses.centerFilterHint")} defaultValue={filters.center ?? ""} ltr />
          <div className="flex items-end gap-2">
            <Key type="submit" variant="ink" icon="funnel" size="sm">
              {t("range.apply")}
            </Key>
            <Key as={Link} to="/admin/finance/expenses" size="sm">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        </Disclosure>
        <DemoHidden count={page.demoHidden} href={`/admin/finance/expenses${rangeSearch({ ...filters, demo: true }, keep)}`} />
        <ResponsiveTable
          caption={t("expenses.list")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              title={t("expenses.empty")}
              text={t("expenses.emptyHint")}
              icon="receipt"
              action={
                <Key as={Link} to="/admin/finance/expenses/new" size="sm" icon="plus">
                  {t("expenses.new")}
                </Key>
              }
            />
          }
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => rangeSearch(filters, { ...keep, page: n > 1 ? n : null }) || "?"} />}
          card={(row) => (
            <Link to={`/admin/finance/expenses/${row.id}`} className="grid gap-1 no-underline">
              <span className="flex items-baseline justify-between gap-2">
                <span className="type-strong">{row.description}</span>
                <Money iqd={row.amountIqd} className="type-strong" />
              </span>
              <Pair label={t("expenses.col.date")}>
                <Day day={row.incurredOn} />
              </Pair>
              <Pair label={t("expenses.col.account")}>{row.account}</Pair>
              <span className="flex flex-wrap items-center gap-1">
                <StateTag group="expense" value={row.status} label={t(`expenseStatus.${row.status}`)} />
                {row.needsOther ? <Flag icon="users">{t("expenses.needsOther")}</Flag> : null}
                {row.monthClosed ? <Flag icon="lock">{t("expenses.monthClosed")}</Flag> : null}
                <DemoTag show={row.isDemo} />
              </span>
            </Link>
          )}
        />
      </Section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Section id="exp-accounts" title={t("expenses.byAccount")}>
          {page.byAccount.length ? <Ledger className="adm-card content-start" rows={page.byAccount.map((row) => ({ label: row.account, value: <Money iqd={row.iqd} /> }))} /> : <p className="type-body text-ink-2">{t("expenses.nonePosted")}</p>}
        </Section>
        <Section id="exp-centers" title={t("expenses.byCenter")}>
          {page.byCenter.length ? (
            <Ledger className="adm-card content-start" rows={page.byCenter.map((row) => ({ label: row.code ? <span><Code>{row.code}</Code> {row.name ?? ""}</span> : t("expenses.noCenter"), value: <Money iqd={row.iqd} /> }))} />
          ) : (
            <p className="type-body text-ink-2">{t("expenses.nonePosted")}</p>
          )}
        </Section>
      </div>
      <Note>
        <p>{t("expenses.payrollNote")}</p>
      </Note>
    </>
  );
}
