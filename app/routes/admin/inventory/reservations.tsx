import { useState } from "react";
import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/reservations";
import { useFormat } from "~/i18n/react";
import { RESERVATION_STATUS_FILTERS, listReservations, parseReservationFilters, releaseReservationsOfOrder } from "~/server/services/admin/inventory/reservations.server";
import { inventoryAccess } from "~/server/services/admin/inventory/shared.server";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Kpi, LinkChips, Num, PageHead, Pair, ResponsiveList, RowLink, StateTag, When, useInvT, withSearch } from "./components/kit";
import { failed, inventoryT, ok, openInventory, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/reservations — stock held per order (04.08): what each order holds, where, and until when (unpaid
 * transfer orders) or "until shipped or cancelled". Expiry is automatic (the scheduled job); a manual release, with
 * a reason and the units shown first, is for employees with inventory.reservation.release and only for orders not
 * yet being packed.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.stock.read");
  const filters = parseReservationFilters(new URL(request.url).searchParams);
  // page.orderUnits: what each order on the page holds in total, all lines and locations (the release dialog's impact).
  const page = await listReservations(db, actor, filters, locale, now);
  return { page, filters, statuses: [...RESERVATION_STATUS_FILTERS], access: inventoryAccess(actor), now };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.reservation.release");
  const form = await request.formData();
  try {
    const result = await releaseReservationsOfOrder(db, actor, { orderId: text(form, "orderId"), reason: text(form, "reason") }, now);
    // Nothing was held any more (released or expired meanwhile, or a second click): say so instead of "N released".
    return ok({ intent: "release", released: result.released, ...(result.released === 0 ? { message: inventoryT(locale)("errors.nothing_to_release") } : {}) });
  } catch (error) {
    return failed(error, locale, "release");
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "reservations.title");

type Row = Route.ComponentProps["loaderData"]["page"]["rows"][number];

export default function Reservations({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { search } = useLocation();
  const { page, filters, statuses, access, now } = loaderData;
  const held = page.orderUnits;
  const [releasing, setReleasing] = useState<Row | null>(null);

  const expires = (row: Row) => (row.status !== "active" ? <When at={row.releasedAt} /> : row.expiresAt === null ? t("reservations.heldUntil") : <span title={f.dateTime(row.expiresAt)} className={row.expiresAt < now ? "text-red-ink" : undefined}>{row.expiresAt < now ? t("reservations.overdue", { time: f.relative(row.expiresAt, now) }) : f.relative(row.expiresAt, now)}</span>);
  const releaseCell = (row: Row) =>
    access.release && row.status === "active" ? (
      row.releasable ? (
        <Key size="sm" onClick={() => setReleasing(row)} className="[--on:var(--red-ink)]">
          {t("reservations.release")}
        </Key>
      ) : (
        <span className="type-caption text-ink-2">{t("reservations.notReleasable")}</span>
      )
    ) : null;

  return (
    <>
      <PageHead title={t("reservations.title")} lead={t("reservations.lead")} />
      <div className="inv-kpis mb-4">
        <Kpi label={t("reservations.active")} value={f.number(page.summary.active)} />
        <Kpi label={t("reservations.units")} value={f.number(page.summary.units)} />
        <Kpi label={t("reservations.expiring")} value={f.number(page.summary.expiring)} />
        <Kpi label={t("reservations.held")} value={f.number(page.summary.held)} />
      </div>
      {page.lastExpiryRun !== undefined ? (
        <p className="mb-4 type-caption text-ink-2">
          {page.lastExpiryRun ? t("reservations.lastRun", { time: f.dateTime(page.lastExpiryRun.startedAt), status: page.lastExpiryRun.status }) : t("reservations.neverRun")}
        </p>
      ) : null}

      <div className="mb-4 grid gap-3">
        <LinkChips label={t("common.status")} items={statuses.map((status) => ({ value: status, label: t(`reservations.filters.${status}`), href: withSearch(search, { status }), selected: filters.status === status }))} />
        <Form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="status" value={filters.status} />
          <TextField name="q" type="search" label={t("reservations.searchLabel")} defaultValue={filters.q} className="min-w-[16rem] flex-1" ltr={false} />
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.search")}
          </Key>
          {filters.q ? (
            <Link to={withSearch(search, { q: null })} className="adm-link type-label">
              {t("common.clear")}
            </Link>
          ) : null}
        </Form>
      </div>

      <ResponsiveList
        caption={t("reservations.caption")}
        rows={page.rows}
        rowKey={(row) => row.id}
        columns={[
          { key: "order", header: t("reservations.order"), cell: (row) => (access.orders ? <RowLink to={`/admin/orders/${row.orderRef}`}><Code>{row.orderRef}</Code></RowLink> : <Code>{row.orderRef}</Code>) },
          { key: "orderStatus", header: t("reservations.orderStatus"), cell: (row) => t(`orderStatus.${row.orderStatus}`) },
          { key: "sku", header: t("common.sku"), cell: (row) => <RowLink to={`/admin/inventory/stock/${row.variantId}`}><Code>{row.variant?.sku ?? row.variantId}</Code></RowLink> },
          { key: "product", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant?.name ?? "—"}</span> },
          { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
          { key: "qty", header: t("common.qty"), numeric: true, cell: (row) => <Num value={row.qty} /> },
          { key: "status", header: t("common.status"), cell: (row) => <StateTag group="reservation" value={row.status} label={t(`reservationStatus.${row.status}`)} /> },
          { key: "created", header: t("reservations.created"), cell: (row) => <When at={row.createdAt} /> },
          { key: "expires", header: t("reservations.expires"), cell: expires },
          { key: "action", header: t("common.actions"), cell: releaseCell },
        ]}
        card={(row) => (
          <>
            <div className="flex items-start justify-between gap-2">
              <p className="type-strong">
                <Code>{row.orderRef}</Code> · {t(`orderStatus.${row.orderStatus}`)}
              </p>
              <StateTag group="reservation" value={row.status} label={t(`reservationStatus.${row.status}`)} />
            </div>
            <p className="type-body">{row.variant?.name ?? "—"}</p>
            <Pair label={t("common.qty")}>
              <Num value={row.qty} /> · <Code>{row.locationCode}</Code>
            </Pair>
            <Pair label={t("reservations.expires")}>{expires(row)}</Pair>
            {releaseCell(row)}
          </>
        )}
        empty={<EmptyState icon="clock" title={t("reservations.empty")} />}
        footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
      />

      <ActionDialog
        open={releasing !== null}
        onClose={() => setReleasing(null)}
        title={t("reservations.releaseConfirm", { ref: releasing?.orderRef ?? "" })}
        consequence={t("reservations.releaseConsequence")}
        confirmLabel={t("reservations.releaseShort")}
        tone="destructive"
        reason
        impact={releasing ? [{ label: t("reservations.releaseImpact"), value: `+${f.number(held[releasing.orderId] ?? releasing.qty)}` }] : undefined}
        fields={{ orderId: releasing?.orderId ?? "" }}
        successMessage={t("reservations.released", { count: t("common.units", { count: releasing ? (held[releasing.orderId] ?? releasing.qty) : 0 }) })}
      />
    </>
  );
}
