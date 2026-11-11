import { Form, Link, redirect, useActionData, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/rfqs";
import { createRfq, listRfqs, parseRfqFilters } from "~/server/services/admin/purchasing/rfqs.server";
import { RFQ_FILTERS } from "~/server/services/admin/purchasing/rules";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { LineRows } from "./components/LineRows";
import { Code, FormError, LinkChips, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT, withSearch } from "./components/kit";
import { purchasingMeta } from "./meta";
import { failed, newKey, openPurchasing, rows, text } from "./purchasing.server";

/**
 * /admin/purchasing/rfqs — requests for quotation (09.02): what the store wants to buy and from whom it asked prices;
 * open requests, awarded and cancelled ones, filters in the URL; a new request (SKUs typed or scanned, quantities, the
 * day the goods are needed).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await openPurchasing(context, "purchasing.rfq.manage");
  const filters = parseRfqFilters(new URL(request.url).searchParams);
  return { page: await listRfqs(db, actor, filters), filters, key: newKey() };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.rfq.manage");
  const form = await request.formData();
  try {
    const { rfqId } = await createRfq(db, actor, { title: text(form, "title"), neededBy: text(form, "neededBy"), notes: text(form, "notes"), lines: rows(form, "lines", ["code", "qty"] as const), idempotencyKey: text(form, "key") }, now, locale);
    throw redirect(`/admin/purchasing/rfqs/${rfqId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "rfqs.title");

export default function Rfqs({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const { search } = useLocation();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { page, filters, key } = loaderData;
  const failure = result && !result.ok ? result : null;
  const fields = failure?.fields ?? {};

  return (
    <>
      <PageHead title={t("rfqs.title")} lead={t("rfqs.lead")} />
      <section id="new" aria-label={t("rfqs.newTitle")} className="mb-6">
        <Disclosure summary={t("rfqs.newTitle")} icon="plus" variant="panel" defaultOpen={Boolean(failure)}>
          <Form method="post" className="grid gap-4">
            <input type="hidden" name="key" value={key} />
            <div className="grid gap-4 lg:grid-cols-2">
              <TextField name="title" label={t("rfqs.titleField")} hint={t("rfqs.titleHint")} required maxLength={160} error={fields.title} />
              <TextField name="neededBy" type="date" label={t("rfqs.neededBy")} ltr optional error={fields.neededBy} />
              <TextArea name="notes" label={t("rfqs.notes")} optional maxLength={1000} rows={2} className="lg:col-span-2" error={fields.notes} />
            </div>
            <LineRows
              legend={t("rfqs.lines")}
              fields={[
                { name: "code", label: t("orderForm.code"), wide: true, ltr: true },
                { name: "qty", label: t("common.qty"), numeric: true },
              ]}
              initial={[]}
              errors={fields}
            />
            <FormError result={failure && (!failure.fields || failure.fields.lines) ? { ...failure, message: failure.message ?? failure.fields?.lines } : null} />
            <div>
              <Key type="submit" variant="ink" icon="scales" loading={navigation.state === "submitting"}>
                {t("rfqs.create")}
              </Key>
            </div>
          </Form>
        </Disclosure>
      </section>

      <Section id="rfqs-list" title={t("rfqs.caption")}>
        <LinkChips label={t("common.status")} items={RFQ_FILTERS.map((status) => ({ value: status, label: t(`rfqs.filters.${status}`), href: withSearch(search, { status }), selected: filters.status === status, count: page.counts[status] }))} />
        <Form method="get" className="flex flex-wrap items-end gap-3" role="search">
          <input type="hidden" name="status" value={filters.status} />
          <TextField name="q" type="search" label={t("common.search")} defaultValue={filters.q} placeholder={t("rfqs.searchHint")} className="min-w-[14rem] flex-1" />
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList
          caption={t("rfqs.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "ref", header: t("common.reference"), cell: (row) => <RowLink to={`/admin/purchasing/rfqs/${row.id}`}><Code>{row.ref}</Code></RowLink> },
            { key: "title", header: t("rfqs.titleField"), cell: (row) => <span className="line-clamp-2 min-w-[10rem]">{row.title}</span> },
            { key: "status", header: t("common.status"), cell: (row) => <StateTag group="rfq" value={row.status} label={t(`rfqStatus.${row.status}`)} /> },
            { key: "lines", header: t("rfqs.linesCount"), numeric: true, cell: (row) => <Num value={row.lines} /> },
            { key: "quotes", header: t("rfqs.quotesCount"), numeric: true, cell: (row) => <Num value={row.quotes} /> },
            { key: "needed", header: t("rfqs.neededBy"), cell: (row) => <When at={row.neededBy} kind="date" /> },
            { key: "awarded", header: t("rfqs.awardedTo"), cell: (row) => row.awardedTo ?? "—" },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/purchasing/rfqs/${row.id}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code>
                </Link>
                <StateTag group="rfq" value={row.status} label={t(`rfqStatus.${row.status}`)} />
              </div>
              <p className="type-body">{row.title}</p>
              <Pair label={t("rfqs.quotesCount")}>
                <Num value={row.quotes} />
              </Pair>
              <Pair label={t("rfqs.neededBy")}>
                <When at={row.neededBy} kind="date" />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="scales" title={filters.q ? t("rfqs.emptyFiltered") : t("rfqs.empty")} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
      </Section>
    </>
  );
}
