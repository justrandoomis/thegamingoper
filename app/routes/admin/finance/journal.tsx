import { Form, Link } from "react-router";

import type { Route } from "./+types/journal";
import { listJournal, type JournalFilters, type JournalRow } from "~/server/services/admin/finance/ledger.server";
import { idParam, pageOf, parseRange, queryText, rangeSearch, REF_TYPES } from "~/server/services/admin/finance/types";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import type { DataColumn } from "~/ui/DataTable";
import { openFinance, orRespond } from "./finance.server";
import { financeMeta } from "./meta";
import { ByLabel, Code, DemoHidden, DemoTag, Flag, Money, PageHead, Pair, RangeBar, RefView, ResponsiveTable, Section, useFinanceLayout, useFinT, When } from "./ui";

/**
 * /admin/finance/journal — 10.01: the journal, the single source of truth of the money (finance.journal.read +
 * cost.read: the books carry purchase cost). Every entry is balanced and sealed by the database; nothing here edits
 * one. Filters in the URL (range, account, reference type, text), 25 a page, CSV of the same filters.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.journal.read");
  const params = new URL(request.url).searchParams;
  const range = parseRange(params, now);
  const refType = params.get("ref");
  const filters: JournalFilters = { ...range, account: idParam(params, "account"), refType: refType && ([...REF_TYPES, "other"] as string[]).includes(refType) ? refType : null, q: queryText(params), page: pageOf(params) };
  const page = await orRespond(() => listJournal(db, actor, filters, locale));
  return { page, filters, now, search: rangeSearch(filters, { account: filters.account, ref: filters.refType, q: filters.q }) };
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "journal.title");

export default function JournalPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const layout = useFinanceLayout();
  const { page, filters, now, search } = loaderData;
  const keep = { account: filters.account, ref: filters.refType, q: filters.q || null };
  const pageHref = (n: number) => rangeSearch(filters, { ...keep, page: n > 1 ? n : null }) || "?";

  const columns: DataColumn<JournalRow>[] = [
    {
      key: "at",
      header: t("journal.col.date"),
      cell: (row) => (
        <Link to={`/admin/finance/journal/${row.id}`} className="adm-link">
          <When at={row.at} kind="date" />
        </Link>
      ),
    },
    { key: "memo", header: t("journal.col.memo"), cell: (row) => <span className="line-clamp-2 min-w-[14rem]">{row.memo ?? "—"}</span> },
    { key: "ref", header: t("journal.col.ref"), cell: (row) => <RefView link={row.link} refType={row.refType} /> },
    {
      key: "accounts",
      header: t("journal.col.accounts"),
      cell: (row) => (
        <span className="grid py-1 type-caption">
          <span>
            <span className="text-ink-2">{t("journal.dr")} </span>
            {row.debits.join("، ")}
          </span>
          <span>
            <span className="text-ink-2">{t("journal.cr")} </span>
            {row.credits.join("، ")}
          </span>
        </span>
      ),
    },
    { key: "total", header: t("journal.col.total"), numeric: true, cell: (row) => <Money iqd={row.totalIqd} plain /> },
    { key: "by", header: t("journal.col.by"), cell: (row) => <ByLabel by={row.by} /> },
    {
      key: "flags",
      header: t("journal.col.flags"),
      cell: (row) => (
        <span className="inline-flex flex-wrap gap-1">
          {row.reversesId ? <Flag icon="arrow-counter-clockwise">{t("journal.isReversal")}</Flag> : null}
          {row.reversedBy ? <Flag icon="arrow-counter-clockwise">{t("journal.reversed")}</Flag> : null}
          <DemoTag show={row.isDemo} />
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t("journal.title")}
        lead={t("journal.lead")}
        actions={
          <>
            <Key as="a" href={`/admin/finance/journal/export${search}`} size="sm" icon="download-simple" download>
              {t("common.exportCsv")}
            </Key>
            {layout?.access.post ? (
              <Key as={Link} to="/admin/finance/journal/new" size="sm" variant="ink" icon="plus">
                {t("journal.new")}
              </Key>
            ) : null}
          </>
        }
      />

      <div className="mb-5 grid gap-3">
        <RangeBar range={filters} action="/admin/finance/journal" keep={keep} now={now} />
        <Disclosure summary={t("common.filters")} variant="row" defaultOpen={Boolean(filters.account || filters.refType || filters.q)}>
        <Form method="get" action="/admin/finance/journal" className="fin-noprint grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-4">
          {filters.period ? <input type="hidden" name="period" value={filters.period} /> : null}
          {!filters.period ? <input type="hidden" name="from" value={filters.from} /> : null}
          {!filters.period ? <input type="hidden" name="to" value={filters.to} /> : null}
          {filters.demo ? <input type="hidden" name="demo" value="1" /> : null}
          <Select
            name="account"
            label={t("journal.account")}
            defaultValue={filters.account ?? ""}
            options={[{ value: "", label: t("common.any") }, ...page.accounts.map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }))]}
          />
          <Select name="ref" label={t("journal.refType")} defaultValue={filters.refType ?? ""} options={[{ value: "", label: t("common.any") }, ...[...REF_TYPES, "other"].map((ref) => ({ value: ref, label: t(`refType.${ref}`) }))]} />
          <TextField name="q" type="search" label={t("journal.search")} hint={t("journal.searchHint")} defaultValue={filters.q} />
          <div className="flex items-end gap-2">
            <Key type="submit" variant="ink" icon="funnel" size="sm">
              {t("range.apply")}
            </Key>
            <Key as={Link} to="/admin/finance/journal" size="sm">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        </Disclosure>
      </div>

      <Section id="journal-list" title={t("journal.entries")} aside={<span className="type-caption text-ink-2">{t("journal.count", { count: page.total })}</span>}>
        <DemoHidden count={page.demoHidden} href={`/admin/finance/journal${rangeSearch({ ...filters, demo: true }, keep)}`} />
        <ResponsiveTable
          caption={t("journal.entries")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("journal.empty")} text={t("journal.emptyHint")} icon="book-open" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={pageHref} />}
          card={(row) => (
            <Link to={`/admin/finance/journal/${row.id}`} className="grid gap-1 no-underline">
              <span className="flex items-baseline justify-between gap-2">
                <span className="type-strong">
                  <When at={row.at} kind="date" />
                </span>
                <Money iqd={row.totalIqd} className="type-strong" />
              </span>
              <span className="type-body">{row.memo ?? "—"}</span>
              <Pair label={t("journal.dr")}>{row.debits.join("، ")}</Pair>
              <Pair label={t("journal.cr")}>{row.credits.join("، ")}</Pair>
              <span className="flex flex-wrap items-center gap-1 type-caption text-ink-2">
                <Code>{row.id}</Code>
                {row.reversesId ? <Flag>{t("journal.isReversal")}</Flag> : null}
                {row.reversedBy ? <Flag>{t("journal.reversed")}</Flag> : null}
                <DemoTag show={row.isDemo} />
              </span>
            </Link>
          )}
        />
      </Section>
    </>
  );
}
