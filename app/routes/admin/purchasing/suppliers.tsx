import { Form, Link, redirect, useActionData, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/suppliers";
import { COST_CURRENCIES, SUPPLIER_SORTS, SUPPLIER_STATUS_LIST } from "~/server/services/admin/purchasing/rules";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { createSupplier, listSuppliers, parseSupplierFilters } from "~/server/services/admin/purchasing/suppliers.server";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, FormError, LinkChips, Num, PageHead, Pair, Percent, ResponsiveList, RowLink, Section, StateTag, usePurT, withSearch } from "./components/kit";
import { purchasingMeta } from "./meta";
import { failed, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/suppliers — every supplier (09.01) with its rating (09.08): search, status and sort in the URL
 * (works without JavaScript), cards on phones; a new supplier's profile for those who manage suppliers.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openPurchasing(context, "purchasing.supplier.read");
  const filters = parseSupplierFilters(new URL(request.url).searchParams);
  return { page: await listSuppliers(db, actor, filters, now), filters, access: purchasingAccess(actor) };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.supplier.manage");
  const form = await request.formData();
  try {
    const { supplierId } = await createSupplier(
      db,
      actor,
      {
        code: text(form, "code"),
        name: text(form, "name"),
        legalName: text(form, "legalName"),
        country: text(form, "country"),
        currency: text(form, "currency"),
        paymentTerms: text(form, "paymentTerms"),
        leadTimeDays: text(form, "leadTimeDays"),
        phone: text(form, "phone"),
        email: text(form, "email"),
        address: text(form, "address"),
        notes: text(form, "notes"),
      },
      now,
    );
    throw redirect(`/admin/purchasing/suppliers/${supplierId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "suppliers.title");

const CURRENCY_OPTIONS = Object.keys(COST_CURRENCIES).map((code) => ({ value: code, label: code }));

export default function Suppliers({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const { search } = useLocation();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { page, filters, access } = loaderData;
  const failure = result && !result.ok ? result : null;
  const fields = failure?.fields ?? {};

  return (
    <>
      <PageHead title={t("suppliers.title")} lead={t("suppliers.lead")} />

      {access.supplierManage ? (
        <section id="new" aria-label={t("suppliers.newTitle")} className="mb-6">
          <Disclosure summary={t("suppliers.newTitle")} icon="plus" variant="panel" defaultOpen={Boolean(failure)}>
            <Form method="post" className="grid gap-4 lg:grid-cols-2">
              <TextField name="code" label={t("supplier.code")} hint={t("supplier.codeHint")} required ltr maxLength={20} autoComplete="off" error={fields.code} />
              <TextField name="name" label={t("supplier.name")} required maxLength={120} error={fields.name} />
              <TextField name="legalName" label={t("supplier.legalName")} optional maxLength={160} error={fields.legalName} />
              <TextField name="country" label={t("supplier.country")} optional maxLength={60} error={fields.country} />
              <Select name="currency" label={t("supplier.currency")} options={CURRENCY_OPTIONS} defaultValue="USD" required error={fields.currency} />
              <TextField name="paymentTerms" label={t("supplier.paymentTerms")} hint={t("supplier.paymentTermsHint")} optional maxLength={120} error={fields.paymentTerms} />
              <TextField name="leadTimeDays" label={t("supplier.leadTime")} inputMode="numeric" optional error={fields.leadTimeDays} />
              <TextField name="phone" label={t("supplier.phone")} type="tel" optional maxLength={40} error={fields.phone} />
              <TextField name="email" label={t("supplier.email")} type="email" optional maxLength={200} error={fields.email} />
              <TextField name="address" label={t("supplier.address")} optional maxLength={300} error={fields.address} />
              <TextArea name="notes" label={t("supplier.notes")} optional maxLength={1000} rows={2} className="lg:col-span-2" error={fields.notes} />
              <div className="grid gap-2 lg:col-span-2">
                <FormError result={failure && !failure.fields ? failure : null} />
                <div>
                  <Key type="submit" variant="ink" icon="factory" loading={navigation.state === "submitting"}>
                    {t("suppliers.create")}
                  </Key>
                </div>
              </div>
            </Form>
          </Disclosure>
        </section>
      ) : null}

      <Section id="suppliers-list" title={t("suppliers.caption")}>
        <Form method="get" className="flex flex-wrap items-end gap-3" role="search">
          {filters.status !== "all" ? <input type="hidden" name="status" value={filters.status} /> : null}
          <TextField name="q" type="search" label={t("common.search")} defaultValue={filters.q} placeholder={t("suppliers.searchHint")} className="min-w-[14rem] flex-1" />
          <Select name="sort" label={t("common.sort")} defaultValue={filters.sort} options={SUPPLIER_SORTS.map((sort) => ({ value: sort, label: t(`suppliers.sorts.${sort}`) }))} />
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.apply")}
          </Key>
        </Form>
        <LinkChips
          label={t("common.status")}
          items={(["all", ...SUPPLIER_STATUS_LIST] as const).map((status) => ({ value: status, label: status === "all" ? t("common.all") : t(`supplierStatus.${status}`), href: withSearch(search, { status: status === "all" ? null : status }), selected: filters.status === status, count: page.counts[status] }))}
        />
        <ResponsiveList
          caption={t("suppliers.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "code", header: t("supplier.code"), cell: (row) => <RowLink to={`/admin/purchasing/suppliers/${row.id}`}><Code>{row.code}</Code></RowLink> },
            { key: "name", header: t("supplier.name"), cell: (row) => <bdi className="line-clamp-2 min-w-[10rem]">{row.name}</bdi> },
            { key: "country", header: t("supplier.country"), cell: (row) => row.country ?? "—" },
            { key: "currency", header: t("supplier.currency"), cell: (row) => <Code>{row.currency}</Code> },
            { key: "lead", header: t("supplier.leadTimeShort"), numeric: true, cell: (row) => <Num value={row.leadTimeDays} /> },
            { key: "rating", header: t("rating.grade"), cell: (row) => (row.rating.grade ? <StateTag group="grade" value={row.rating.grade} label={t("rating.gradeScore", { grade: row.rating.grade, score: row.rating.score ?? 0 })} /> : <span className="type-caption text-ink-2">{t("rating.notEnoughShort")}</span>) },
            { key: "onTime", header: t("rating.onTime"), numeric: true, cell: (row) => <Percent value={row.rating.onTimeRate} /> },
            { key: "defects", header: t("rating.defects"), numeric: true, cell: (row) => <Percent value={row.rating.defectRate} /> },
            { key: "open", header: t("suppliers.openOrders"), numeric: true, cell: (row) => <Num value={row.openOrders} /> },
            { key: "status", header: t("common.status"), cell: (row) => <StateTag group="supplier" value={row.status} label={t(`supplierStatus.${row.status}`)} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/purchasing/suppliers/${row.id}`} className="adm-link type-strong">
                  <bdi>{row.name}</bdi>
                </Link>
                <StateTag group="supplier" value={row.status} label={t(`supplierStatus.${row.status}`)} />
              </div>
              <p className="type-caption text-ink-2">
                <Code>{row.code}</Code> · {row.country ?? "—"} · <Code>{row.currency}</Code>
              </p>
              <Pair label={t("rating.grade")}>{row.rating.grade ? t("rating.gradeScore", { grade: row.rating.grade, score: row.rating.score ?? 0 }) : t("rating.notEnoughShort")}</Pair>
              <Pair label={t("rating.onTime")}>
                <Percent value={row.rating.onTimeRate} />
              </Pair>
              <Pair label={t("suppliers.openOrders")}>
                <Num value={row.openOrders} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="factory" title={filters.q || filters.status !== "all" ? t("suppliers.emptyFiltered") : t("suppliers.empty")} text={access.supplierManage ? t("suppliers.emptyHint") : undefined} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
      </Section>
    </>
  );
}
