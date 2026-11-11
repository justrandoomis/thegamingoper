import { Form, Link, redirect, useActionData, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/claims";
import { claimPrefill, createClaim, listClaims, parseClaimFilters } from "~/server/services/admin/purchasing/claims.server";
import { CLAIM_FILTERS, CLAIM_KIND_LIST } from "~/server/services/admin/purchasing/rules";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { supplierOptions } from "~/server/services/admin/purchasing/suppliers.server";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { LineRows } from "./components/LineRows";
import { Code, FormError, LinkChips, Minor, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT, withSearch } from "./components/kit";
import { purchasingMeta } from "./meta";
import { failed, newKey, openPurchasing, rows, text } from "./purchasing.server";

/**
 * /admin/purchasing/claims — supplier claims (09.06): shortages, damaged or defective goods, wrong items, price
 * disputes and returns. A new claim can start from a receipt's refused units (`?receipt=`) or an order's missing units
 * (`?po=`); filters in the URL. Amounts only with cost.read.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPurchasing(context, "purchasing.claim.manage");
  const params = new URL(request.url).searchParams;
  const filters = parseClaimFilters(params);
  const access = purchasingAccess(actor);
  const [page, prefill, suppliers] = await Promise.all([
    listClaims(db, actor, filters),
    claimPrefill(db, actor, { receiptId: params.get("receipt"), poId: params.get("po") }, locale).catch(() => null),
    access.supplierRead ? supplierOptions(db, actor, { includeInactive: true }) : Promise.resolve([]),
  ]);
  return { page, filters, access, prefill, preselected: params.get("supplier"), suppliers: suppliers.map((option) => ({ value: option.value, label: option.label })), key: newKey() };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.claim.manage");
  const form = await request.formData();
  try {
    const { claimId } = await createClaim(
      db,
      actor,
      {
        supplierId: text(form, "supplierId") || undefined,
        poId: text(form, "poId") || undefined,
        receiptId: text(form, "receiptId") || undefined,
        kind: text(form, "kind"),
        description: text(form, "description"),
        amount: text(form, "amount") || undefined,
        lines: rows(form, "lines", ["code", "qty", "serial"] as const),
        idempotencyKey: text(form, "key"),
      },
      now,
      locale,
    );
    throw redirect(`/admin/purchasing/claims/${claimId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "claims.title");

export default function Claims({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const { search } = useLocation();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { page, filters, access, prefill, preselected, suppliers, key } = loaderData;
  const failure = result && !result.ok ? result : null;
  const fields = failure?.fields ?? {};
  const fixedSupplier = prefill?.supplierId ?? null;
  const open = Boolean(failure) || Boolean(prefill?.label) || Boolean(preselected);

  return (
    <>
      <PageHead title={t("claims.title")} lead={t("claims.lead")} />

      <section id="new" aria-label={t("claims.newTitle")} className="mb-6">
        <Disclosure summary={prefill?.label ? t("claims.newFrom", { ref: prefill.label }) : t("claims.newTitle")} icon="plus" variant="panel" defaultOpen={open}>
          <Form method="post" className="grid gap-4">
            <input type="hidden" name="key" value={key} />
            {prefill?.poId ? <input type="hidden" name="poId" value={prefill.poId} /> : null}
            {prefill?.receiptId ? <input type="hidden" name="receiptId" value={prefill.receiptId} /> : null}
            {fixedSupplier ? <input type="hidden" name="supplierId" value={fixedSupplier} /> : null}
            <div className="grid gap-4 lg:grid-cols-2">
              {!fixedSupplier ? <Select name="supplierId" label={t("common.supplier")} options={suppliers} defaultValue={preselected ?? ""} placeholder={t("orderForm.chooseSupplier")} required error={fields.supplierId} /> : <p className="type-body self-center">{t("claims.linkedTo", { ref: prefill?.label ?? "" })}</p>}
              <Select name="kind" label={t("claims.kind")} options={CLAIM_KIND_LIST.map((kind) => ({ value: kind, label: t(`claimKind.${kind}`) }))} defaultValue={prefill?.kind ?? "shortage"} error={fields.kind} />
              <TextArea name="description" label={t("claims.description")} hint={t("claims.descriptionHint")} optional maxLength={1000} rows={2} className="lg:col-span-2" error={fields.description} />
              {access.cost ? <TextField name="amount" label={t("claims.amount")} hint={t("claims.amountHint")} inputMode="decimal" ltr optional error={fields.amount} /> : null}
            </div>
            <LineRows
              legend={t("claims.lines")}
              fields={[
                { name: "code", label: t("orderForm.code"), wide: true, ltr: true },
                { name: "qty", label: t("common.qty"), numeric: true },
                { name: "serial", label: t("claims.serial"), ltr: true },
              ]}
              initial={(prefill?.lines ?? []).map((line) => ({ code: line.code, qty: String(line.qty), serial: "" }))}
              errors={fields}
            />
            <FormError result={failure && (!failure.fields || failure.fields.lines) ? { ...failure, message: failure.message ?? failure.fields?.lines } : null} />
            <div>
              <Key type="submit" variant="ink" icon="warning" loading={navigation.state === "submitting"}>
                {t("claims.create")}
              </Key>
            </div>
          </Form>
        </Disclosure>
      </section>

      <Section id="claims-list" title={t("claims.caption")}>
        <LinkChips label={t("common.status")} items={CLAIM_FILTERS.map((status) => ({ value: status, label: status === "all" ? t("common.all") : status === "active" ? t("claims.active") : t(`claimStatus.${status}`), href: withSearch(search, { status }), selected: filters.status === status, count: page.counts[status] }))} />
        <Form method="get" className="flex flex-wrap items-end gap-3" role="search">
          <input type="hidden" name="status" value={filters.status} />
          <TextField name="q" type="search" label={t("common.search")} defaultValue={filters.q} placeholder={t("claims.searchHint")} className="min-w-[14rem] flex-1" />
          <Select name="kind" label={t("claims.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("common.all") }, ...CLAIM_KIND_LIST.map((kind) => ({ value: kind, label: t(`claimKind.${kind}`) }))]} />
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList
          caption={t("claims.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "ref", header: t("common.reference"), cell: (row) => <RowLink to={`/admin/purchasing/claims/${row.id}`}><Code>{row.ref}</Code></RowLink> },
            { key: "kind", header: t("claims.kind"), cell: (row) => t(`claimKind.${row.kind}`) },
            { key: "supplier", header: t("common.supplier"), cell: (row) => row.supplier.name },
            { key: "po", header: t("common.order"), cell: (row) => (row.po ? <Code>{row.po.ref}</Code> : "—") },
            { key: "status", header: t("common.status"), cell: (row) => <StateTag group="claim" value={row.status} label={t(`claimStatus.${row.status}`)} /> },
            { key: "units", header: t("claims.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
            { key: "returned", header: t("claims.returned"), numeric: true, cell: (row) => <Num value={row.returned} /> },
            ...(access.cost ? [{ key: "amount", header: t("claims.amount"), numeric: true, cell: (row: (typeof page.rows)[number]) => <Minor minor={row.amountMinor ?? null} currency={row.currency ?? "IQD"} /> }] : []),
            { key: "at", header: t("common.created"), cell: (row) => <When at={row.createdAt} kind="date" /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/purchasing/claims/${row.id}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code>
                </Link>
                <StateTag group="claim" value={row.status} label={t(`claimStatus.${row.status}`)} />
              </div>
              <p className="type-body">
                {t(`claimKind.${row.kind}`)} · <bdi>{row.supplier.name}</bdi>
              </p>
              <Pair label={t("claims.units")}>
                <Num value={row.units} />
              </Pair>
              {access.cost ? (
                <Pair label={t("claims.amount")}>
                  <Minor minor={row.amountMinor ?? null} currency={row.currency ?? "IQD"} />
                </Pair>
              ) : null}
            </>
          )}
          empty={<EmptyState icon="warning" title={filters.q || filters.kind ? t("claims.emptyFiltered") : t("claims.empty")} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
      </Section>
    </>
  );
}
