import { Form, Link, redirect, useActionData, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/transfers";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { inventoryAccess, locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { TRANSFER_STATUS_FILTERS, listTransfers, parseTransferFilters, resolveTransferLines } from "~/server/services/admin/inventory/transfers.server";
import { createTransfer } from "~/server/services/inventory/transfers.server";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, LinkChips, Num, PageHead, Pair, ResponsiveList, FromTo, RowLink, Section, StateTag, When, useInvT, withSearch } from "./components/kit";
import { failed, newKey, openInventory, optionalText, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/transfers — transfers between warehouses, branches and storage positions (04.07): create a
 * draft from scanned or typed SKU lines, and the list by status. Shipping, receiving and closing a shortfall happen
 * on the transfer's page; every stock change goes through the core-level transfers service.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await openInventory(context, "inventory.stock.read");
  const filters = parseTransferFilters(new URL(request.url).searchParams);
  const [page, tree] = await Promise.all([listTransfers(db, actor, filters), locationTree(db)]);
  const locations = locationOptions(tree);
  // The main warehouse sends by default; the first other location receives.
  const from = locations.some((option) => option.value === DEFAULT_LOCATION_ID) ? DEFAULT_LOCATION_ID : (locations[0]?.value ?? "");
  const to = locations.find((option) => option.value !== from)?.value ?? "";
  return { page, filters, statuses: [...TRANSFER_STATUS_FILTERS], locations, defaults: { from, to }, access: inventoryAccess(actor), key: newKey() };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.transfer.create");
  const form = await request.formData();
  try {
    const lines = await resolveTransferLines(db, text(form, "lines"));
    const result = await createTransfer(db, actor, { fromLocationId: text(form, "fromLocationId"), toLocationId: text(form, "toLocationId"), lines, notes: optionalText(form, "notes"), idempotencyKey: text(form, "key") }, now);
    throw redirect(`/admin/inventory/transfers/${result.transferId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "transfers.title");

export default function Transfers({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { search } = useLocation();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { page, filters, statuses, locations, defaults, access } = loaderData;
  const failure = result && !result.ok ? result : null;

  return (
    <>
      <PageHead title={t("transfers.title")} lead={t("transfers.lead")} />

      {access.transferCreate ? (
        <Section id="new" title={t("transfers.newTitle")}>
          <p className="type-caption text-ink-2">{t("transfers.newLead")}</p>
          <Form method="post" className="adm-card grid gap-4 lg:grid-cols-2">
            <input type="hidden" name="key" value={loaderData.key} />
            <Select name="fromLocationId" label={t("transfers.from")} options={locations.map((option) => ({ value: option.value, label: option.label }))} defaultValue={defaults.from} required error={failure?.fields?.fromLocationId} />
            <Select name="toLocationId" label={t("transfers.to")} options={locations.map((option) => ({ value: option.value, label: option.label }))} defaultValue={defaults.to} required error={failure?.fields?.toLocationId} />
            <TextArea name="lines" label={t("transfers.lines")} hint={t("transfers.linesHint")} rows={5} dir="ltr" spellCheck={false} required error={failure?.fields?.lines} className="lg:col-span-2" />
            <TextField name="notes" label={t("transfers.notes")} optional maxLength={500} className="lg:col-span-2" />
            {failure?.message && !failure.fields ? (
              <p role="alert" className="type-label text-red-ink lg:col-span-2">
                {failure.message}
              </p>
            ) : null}
            <div className="lg:col-span-2">
              <Key type="submit" variant="ink" icon="swap" loading={navigation.state === "submitting"}>
                {t("transfers.submit")}
              </Key>
            </div>
          </Form>
        </Section>
      ) : null}

      <Section id="transfers-list" title={t("transfers.caption")}>
        <LinkChips label={t("common.status")} items={statuses.map((status) => ({ value: status, label: t(`transfers.filters.${status}`), href: withSearch(search, { status }), selected: filters.status === status }))} />
        <ResponsiveList
          caption={t("transfers.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "ref", header: t("common.reference"), cell: (row) => <RowLink to={`/admin/inventory/transfers/${row.id}`}><Code>{row.ref}</Code></RowLink> },
            { key: "route", header: t("transfers.route", { from: t("transfers.from"), to: t("transfers.to") }), cell: (row) => <FromTo from={row.from.code} to={row.to.code} /> },
            { key: "status", header: t("common.status"), cell: (row) => <StateTag group="transfer" value={row.status} label={t(`transferStatus.${row.status}`)} /> },
            { key: "units", header: t("transfers.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
            { key: "received", header: t("transfers.unitsReceived"), numeric: true, cell: (row) => <Num value={row.unitsReceived} /> },
            { key: "created", header: t("transfer.created"), cell: (row) => <span>{row.requestedBy ?? "—"} · <When at={row.createdAt} /></span> },
            { key: "shipped", header: t("transfer.shipped"), cell: (row) => <When at={row.shippedAt} /> },
            { key: "receivedAt", header: t("transfer.received"), cell: (row) => <When at={row.receivedAt} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/inventory/transfers/${row.id}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code>
                </Link>
                <StateTag group="transfer" value={row.status} label={t(`transferStatus.${row.status}`)} />
              </div>
              <p className="type-data">
                <FromTo from={row.from.code} to={row.to.code} />
              </p>
              <Pair label={t("transfers.units")}>
                <Num value={row.unitsReceived} /> / <Num value={row.units} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="swap" title={t("transfers.empty")} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
      </Section>
    </>
  );
}
