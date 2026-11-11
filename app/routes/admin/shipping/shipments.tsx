import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useFetcher, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/shipments";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { invalid } from "~/server/errors";
import { carrierChoices } from "~/server/services/admin/shipping/carriers.server";
import {
  SERVICE_LEVELS,
  SHIPMENT_FLAGS,
  SHIPMENT_SORTS,
  SHIPMENT_STATUS_LIST,
  SHIPMENT_VIEWS,
  STATUS_GROUPS,
  parseShipmentFilters,
  shipmentSearch,
  type ShipmentListRow,
} from "~/server/services/admin/shipping/rules";
import { shippingAccess } from "~/server/services/admin/shipping/shared.server";
import { assignByRule, listShipments, lookupParcel, moveParcels, pickupParcels } from "~/server/services/admin/shipping/shipments.server";
import { listZones } from "~/server/services/admin/shipping/zones.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { CodText, Code, FormError, LinkChips, PageHead, Pair, ParcelStatus, ResponsiveList, RowLink, Section, When, failureText, useActionToast, useShipT, withSearch } from "./components/kit";
import { shippingMeta } from "./meta";
import { all, failed, ok, openShipping, text } from "./shipping.server";

/**
 * /admin/shipping/shipments — 11.03: the parcels the orders module packed, with their carrier, tracking number, cash to
 * collect and progress. Filters and saved views in the URL (work without JavaScript), a dense table on desktop and
 * cards on phones, a scan field (a scanner types the waybill code and presses Enter), and bulk actions on the selected
 * parcels: choose carriers by the rule (11.02), hand over to the courier, courier statuses, print waybills and the
 * pickup manifest.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openShipping(context, "shipping.shipment.read");
  const url = new URL(request.url);
  const filters = parseShipmentFilters(url.searchParams);
  const [page, carriers, zones] = await Promise.all([listShipments(db, actor, filters, locale, now), carrierChoices(db), listZones(db, actor, locale)]);
  return {
    page,
    search: url.search,
    carriers,
    governorates: zones.rows.map((row) => ({ id: row.id, name: row.name })),
    access: shippingAccess(actor),
    orders: can(actor, "orders.order.read"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openShipping(context, "shipping.shipment.read");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "lookup": {
        const id = await lookupParcel(req.db, req.actor, text(form, "code"));
        if (id) throw redirect(`/admin/shipping/shipments/${encodeURIComponent(id)}`);
        return ok(intent, { found: false });
      }
      case "assign": {
        const result = await assignByRule(req.db, req.actor, { shipmentIds: all(form, "id"), serviceLevel: text(form, "serviceLevel") as never }, req.now);
        return ok(intent, result);
      }
      case "pickup": {
        const result = await pickupParcels(req.db, req.actor, { shipmentIds: all(form, "id") }, req.now);
        return ok(intent, result);
      }
      case "move": {
        const result = await moveParcels(req.db, req.actor, { shipmentIds: all(form, "id"), to: text(form, "to") as never }, req.now);
        return ok(intent, result);
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "shipments.title");

/** A sensitive device: before pickup it needs its packing photo (red until it has one); on the road it is a fact. */
function SensitiveFlag({ row }: { row: ShipmentListRow }) {
  const t = useShipT();
  const atStore = row.status === "pending" || row.status === "packed";
  if (atStore && !row.documented) return <span className="text-red-ink">{t("shipments.sensitiveUndocumented")}</span>;
  return <span className="text-ink-2">{row.documented ? t("shipments.sensitiveDocumented") : t("shipments.sensitive")}</span>;
}

export default function Shipments({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const { search } = useLocation();
  const navigation = useNavigation();
  const lookup = useActionData<typeof action>();
  const { page, carriers, governorates, access, orders } = loaderData;
  const filters = page.filters;
  const [selected, setSelected] = useState<string[]>([]);
  const [level, setLevel] = useState<string>("standard");
  /** The parcels a bulk handover is about to ship (confirmed in a dialog that shows the stock and cash impact first). */
  const [pickupIds, setPickupIds] = useState<readonly string[] | null>(null);
  const bulk = useFetcher<typeof action>();
  const bulkFailure = useActionToast(bulk, t("shipments.bulkDone"));
  /** The bulk result already on screen when the handover dialog opened: the dialog reacts only to its own request. */
  const staleResult = useRef<unknown>(undefined);
  const openPickup = (ids: readonly string[]) => {
    staleResult.current = bulk.data;
    setPickupIds(ids);
  };
  useEffect(() => {
    if (pickupIds === null || bulk.state !== "idle" || !bulk.data || bulk.data === staleResult.current) return;
    if (bulk.data.ok) {
      staleResult.current = bulk.data;
      setPickupIds(null);
    }
  }, [bulk.data, bulk.state, pickupIds]);
  const pickupError = pickupIds !== null && bulk.state === "idle" && bulk.data && bulk.data !== staleResult.current && !bulk.data.ok ? failureText(t, bulk.data) : null;
  const result = bulk.state === "idle" && bulk.data && bulk.data.ok ? (bulk.data as Record<string, unknown>) : null;
  const canBulk = access.waybill || access.update;
  const notFound = lookup && lookup.ok && (lookup as { found?: boolean }).found === false;
  const printHref = (kind: string, ids: readonly string[]) => `/admin/shipping/print?kind=${kind}&${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`;
  const submitBulk = (fields: Record<string, string>, ids: readonly string[]) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    for (const id of ids) form.append("id", id);
    bulk.submit(form, { method: "post" });
  };

  return (
    <>
      <PageHead title={t("shipments.title")} lead={t("shipments.lead")} />

      <Section id="scan" title={t("shipments.scanTitle")}>
        <Form method="post" className="flex flex-wrap items-end gap-3" aria-describedby="scan-hint">
          <input type="hidden" name="intent" value="lookup" />
          <TextField name="code" label={t("shipments.scanLabel")} ltr autoComplete="off" spellCheck={false} className="min-w-0 flex-1" error={notFound ? t("shipments.scanNotFound") : undefined} />
          <Key type="submit" icon="barcode" loading={navigation.state === "submitting" && navigation.formData?.get("intent") === "lookup"}>
            {t("shipments.scanOpen")}
          </Key>
        </Form>
        <p id="scan-hint" className="type-caption text-ink-2">
          {t("shipments.scanHint")}
        </p>
      </Section>

      <Section id="list" title={t("shipments.listTitle", { count: page.total })}>
        <LinkChips
          label={t("shipments.views")}
          items={SHIPMENT_VIEWS.map((view) => ({
            value: view.id,
            label: t(`shipments.view.${view.id}`),
            href: `/admin/shipping/shipments${shipmentSearch(view.filters)}`,
            selected: shipmentSearch(view.filters) === shipmentSearch({ ...filters, q: "", carrier: null, governorate: null, sort: "created_desc", page: 1 }),
            count: view.id === "failed" ? page.counts.failed : view.id === "returning" ? page.counts.returning : view.id === "on_road" ? page.counts.on_road : view.id === "open" ? page.counts.open : view.id === "ready" ? page.counts.packed : undefined,
          }))}
        />

        <Disclosure summary={t("shipments.filters")} icon="funnel" variant="panel" defaultOpen={Boolean(filters.q || filters.carrier || filters.governorate || filters.flag || filters.sort !== "created_desc")}>
        <Form method="get" className="shp-grid-form" aria-label={t("shipments.filters")}>
          <TextField name="q" label={t("shipments.q")} defaultValue={filters.q} hint={t("shipments.qHint")} ltr spellCheck={false} />
          <Select
            name="status"
            label={t("common.status")}
            defaultValue={filters.status}
            options={[...STATUS_GROUPS.map((group) => ({ value: group, label: t(`shipments.group.${group}`) })), ...SHIPMENT_STATUS_LIST.map((status) => ({ value: status, label: t(`status.${status}`) }))]}
          />
          <Select
            name="carrier"
            label={t("common.carrier")}
            defaultValue={filters.carrier ?? ""}
            options={[{ value: "", label: t("common.all") }, { value: "none", label: t("shipments.noCarrier") }, ...carriers.map((carrier) => ({ value: carrier.id, label: carrier.name }))]}
          />
          <Select name="governorate" label={t("common.governorate")} defaultValue={filters.governorate ?? ""} options={[{ value: "", label: t("common.all") }, ...governorates.map((gov) => ({ value: gov.id, label: gov.name }))]} />
          <Select name="flag" label={t("shipments.flag")} defaultValue={filters.flag ?? ""} options={[{ value: "", label: t("common.none") }, ...SHIPMENT_FLAGS.map((flag) => ({ value: flag, label: t(`shipments.flags.${flag}`) }))]} />
          <Select name="sort" label={t("shipments.sort")} defaultValue={filters.sort} options={SHIPMENT_SORTS.map((sort) => ({ value: sort, label: t(`shipments.sorts.${sort}`) }))} />
          <div className="shp-wide flex flex-wrap gap-2">
            <Key type="submit" variant="ink" icon="funnel">
              {t("common.apply")}
            </Key>
            <Key as={Link} to="/admin/shipping/shipments" variant="quiet">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        </Disclosure>

        {result && "skipped" in result && Array.isArray(result.skipped) && result.skipped.length ? (
          <p role="status" className="type-caption text-ink-2">
            {t("shipments.skipped", { codes: (result.skipped as ({ code: string } | string)[]).map((entry) => (typeof entry === "string" ? entry : entry.code)).join("، ") })}
          </p>
        ) : null}
        {result && "failed" in result && Array.isArray(result.failed) && result.failed.length ? (
          <ul role="status" className="grid gap-1 type-caption text-red-ink">
            {(result.failed as { ref: string; code: string; detail?: string }[]).map((entry) => (
              <li key={entry.ref}>
                <Code>{entry.ref}</Code>: {t(`errors.${entry.code}`, { detail: entry.detail ?? "" })}
              </li>
            ))}
          </ul>
        ) : null}
        <FormError message={bulkFailure ?? (bulk.state === "idle" && bulk.data && !bulk.data.ok ? failureText(t, bulk.data) : null)} />

        <ResponsiveList<ShipmentListRow>
          caption={t("shipments.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.code}
          selected={canBulk ? selected : undefined}
          onSelectedChange={canBulk ? setSelected : undefined}
          bulkActions={(ids) => (
            <>
              {access.waybill ? (
                <span className="flex items-center gap-2">
                  <label className="sr-only" htmlFor="bulk-level">
                    {t("waybill.level")}
                  </label>
                  <select id="bulk-level" className="field__input" value={level} onChange={(event) => setLevel(event.currentTarget.value)}>
                    {SERVICE_LEVELS.map((value) => (
                      <option key={value} value={value}>
                        {t(`level.${value}`)}
                      </option>
                    ))}
                  </select>
                  <Key size="sm" icon="truck" loading={bulk.state !== "idle" && bulk.formData?.get("intent") === "assign"} onClick={() => submitBulk({ intent: "assign", serviceLevel: level }, ids)}>
                    {t("shipments.bulk.assign")}
                  </Key>
                </span>
              ) : null}
              {access.update && access.ship ? (
                <Key size="sm" icon="package" loading={bulk.state !== "idle" && bulk.formData?.get("intent") === "pickup"} onClick={() => openPickup(ids)}>
                  {t("shipments.bulk.pickup")}
                </Key>
              ) : null}
              {access.update ? (
                <>
                  <Key size="sm" onClick={() => submitBulk({ intent: "move", to: "in_transit" }, ids)}>
                    {t("move.in_transit")}
                  </Key>
                  <Key size="sm" onClick={() => submitBulk({ intent: "move", to: "out_for_delivery" }, ids)}>
                    {t("move.out_for_delivery")}
                  </Key>
                </>
              ) : null}
              <Key size="sm" as={Link} to={printHref("waybill", ids)} icon="printer">
                {t("shipments.bulk.waybills")}
              </Key>
              <Key size="sm" as={Link} to={printHref("manifest", ids)} icon="clipboard-text">
                {t("shipments.bulk.manifest")}
              </Key>
            </>
          )}
          columns={[
            { key: "code", header: t("common.parcel"), cell: (row) => <RowLink to={`/admin/shipping/shipments/${encodeURIComponent(row.id)}`}><Code>{row.code}</Code></RowLink> },
            { key: "status", header: t("common.status"), cell: (row) => <ParcelStatus status={row.status} /> },
            { key: "carrier", header: t("common.carrier"), cell: (row) => (row.carrier ? row.carrier.name : <span className="text-ink-2">{t("shipments.noCarrier")}</span>) },
            { key: "tracking", header: t("common.tracking"), cell: (row) => (row.trackingNo ? <Code>{row.trackingNo}</Code> : "—") },
            { key: "gov", header: t("common.governorate"), cell: (row) => row.governorate ?? "—" },
            { key: "cod", header: t("shipments.money"), cell: (row) => <span className="whitespace-nowrap"><CodText cod={row.cod} status={row.status} /></span> },
            {
              key: "flags",
              header: t("shipments.flagsHead"),
              cell: (row) => (
                <span className="flex flex-wrap gap-x-2 gap-y-1 type-caption">
                  {row.sensitive ? <SensitiveFlag row={row} /> : null}
                  {row.attempts > 0 ? <span className="text-ink-2">{t("shipments.attemptsCount", { count: row.attempts })}</span> : null}
                  {row.settled ? <span className="text-ink-2">{t("shipments.settled")}</span> : null}
                  {row.isDemo ? <span className="text-ink-2">{t("common.demo")}</span> : null}
                </span>
              ),
            },
            { key: "created", header: t("shipments.created"), cell: (row) => <When at={row.createdAt} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/shipping/shipments/${encodeURIComponent(row.id)}`} className="adm-link type-strong">
                  <Code>{row.code}</Code>
                </Link>
                <ParcelStatus status={row.status} />
              </div>
              <Pair label={t("common.carrier")}>{row.carrier ? row.carrier.name : t("shipments.noCarrier")}</Pair>
              {row.trackingNo ? (
                <Pair label={t("common.tracking")}>
                  <Code>{row.trackingNo}</Code>
                </Pair>
              ) : null}
              <Pair label={t("common.governorate")}>{row.governorate ?? "—"}</Pair>
              <Pair label={t("shipments.money")}>
                <CodText cod={row.cod} status={row.status} />
              </Pair>
              {row.sensitive ? (
                <p className="type-caption">
                  <SensitiveFlag row={row} />
                </p>
              ) : null}
              {row.attempts > 0 ? <p className="type-caption text-ink-2">{t("shipments.attemptsCount", { count: row.attempts })}</p> : null}
            </>
          )}
          empty={
            <EmptyState
              icon="package"
              title={t("shipments.empty")}
              text={filters.q || filters.flag || filters.carrier || filters.governorate ? t("shipments.emptyFiltered") : t("shipments.emptyHint")}
              action={
                orders ? (
                  <Key as={Link} to="/admin/orders/fulfillment" iconEnd="arrow-right">
                    {t("shipments.toPacking")}
                  </Key>
                ) : undefined
              }
            />
          }
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
        <p className="type-caption text-ink-2">
          <Icon name="info" size={14} className="me-1 inline align-[-2px]" />
          {t("shipments.together")}
        </p>
        <p className="sr-only" aria-live="polite">
          {f.number(page.total)}
        </p>
      </Section>

      <BulkPickupDialog
        rows={pickupIds ? page.rows.filter((row) => pickupIds.includes(row.id)) : []}
        open={pickupIds !== null}
        pending={bulk.state !== "idle" && bulk.formData?.get("intent") === "pickup"}
        error={pickupError}
        onClose={() => setPickupIds(null)}
        onConfirm={() => pickupIds && submitBulk({ intent: "pickup" }, pickupIds)}
      />
    </>
  );
}

/**
 * The bulk handover, confirmed with its impact first (blueprint uxRules — it ships orders: their stock leaves the shelf
 * and the couriers take the cash to collect): how many parcels and orders, and the cash the couriers will collect.
 */
function BulkPickupDialog({ rows, open, pending, error, onClose, onConfirm }: { rows: ShipmentListRow[]; open: boolean; pending: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const t = useShipT();
  const f = useFormat();
  // only parcels still at the store are handed over (the service skips the others): the impact counts those
  const atStore = rows.filter((row) => row.status === "pending" || row.status === "packed");
  const orders = new Set(atStore.map((row) => row.orderId)).size;
  const cash = atStore.reduce((sum, row) => sum + (row.cod.kind === "collect" ? row.cod.amountIqd : 0), 0);
  const skipped = rows.length - atStore.length;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      tone="commit"
      title={t("shipments.pickupConfirm.title")}
      consequence={t("shipments.pickupConfirm.consequence")}
      confirmLabel={t("shipments.bulk.pickup")}
      cancelLabel={t("common.back")}
      pending={pending}
      error={error}
      impact={[
        { label: t("shipments.pickupConfirm.parcels"), value: f.number(rows.length) },
        ...(skipped > 0 ? [{ label: t("shipments.pickupConfirm.skipped"), value: f.number(skipped) }] : []),
        { label: t("shipments.pickupConfirm.orders"), value: f.number(orders) },
        ...(orders > 0 ? [{ label: t("pickupDialog.stock"), value: t("pickupDialog.stockValue"), negative: true }] : []),
        { label: t("shipments.pickupConfirm.cash"), value: f.iqd(cash) },
      ]}
      onConfirm={onConfirm}
    />
  );
}
