import { data, Link, useFetcher } from "react-router";

import type { Route } from "./+types/fulfillment";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { assignOrder, listFulfillment, type FulfillmentRow } from "~/server/services/admin/orders/fulfillment.server";
import type { EmployeeRef } from "~/server/services/admin/orders/types";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ordersMeta } from "./meta";
import { failure, text } from "./common.server";
import { DemoNote, Failure, OrderStatusBadge, Ref, useOrdersT } from "./ui";

/**
 * /admin/orders/fulfillment — 05.03: who packs what. Orders to pick and pack (confirmed or being prepared), oldest
 * first, as "my tasks", "nobody's" and "someone else's"; a supervisor (orders.order.assign) gives an order to a packer,
 * which puts a task in that person's list. Packing itself (scan, verify serials, parcels, hand over) is on
 * /admin/orders/:ref/pack (04.11).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.read");
  try {
    // a supervisor who only assigns (orders.order.assign) is not sent to a packing station that would refuse them
    return { ...(await listFulfillment(db, actor, ctx.locale)), now: ctx.now, canPack: can(actor, "orders.fulfillment.pack") };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.assign");
  const form = await request.formData();
  try {
    const result = await assignOrder(db, actor, text(form, "orderId"), { employeeId: text(form, "employeeId") }, ctx.now);
    return { ok: true as const, intent: "assign", replayed: result.replayed };
  } catch (error) {
    const result = failure(error, ctx.locale, "assign");
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "fulfillment.title");

export default function FulfillmentPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const { mine, unassigned, others, packers, now, canPack } = loaderData;
  const total = mine.length + unassigned.length + others.length;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("fulfillment.title")}</h1>
        <p className="max-w-[65ch] type-body text-ink-2">{t("fulfillment.lead")}</p>
      </header>
      {total === 0 ? (
        <EmptyState title={t("fulfillment.empty")} text={t("fulfillment.emptyHint")} icon="package" />
      ) : (
        <>
          <Group id="mine" title={t("fulfillment.mine", { count: mine.length })} rows={mine} packers={packers} now={now} canPack={canPack} />
          <Group id="unassigned" title={t("fulfillment.unassigned", { count: unassigned.length })} rows={unassigned} packers={packers} now={now} canPack={canPack} />
          <Group id="others" title={t("fulfillment.others", { count: others.length })} rows={others} packers={packers} now={now} canPack={canPack} />
        </>
      )}
    </>
  );
}

function Group({ id, title, rows, packers, now, canPack }: { id: string; title: string; rows: FulfillmentRow[]; packers: EmployeeRef[] | null; now: number; canPack: boolean }) {
  const t = useOrdersT();
  if (rows.length === 0) return null;
  return (
    <section className="adm-section" aria-labelledby={`ful-${id}`}>
      <h2 id={`ful-${id}`} className="adm-h2">
        {title}
      </h2>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <li key={row.id}>
            <FulfillmentCard row={row} packers={packers} now={now} canPack={canPack} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FulfillmentCard({ row, packers, now, canPack }: { row: FulfillmentRow; packers: EmployeeRef[] | null; now: number; canPack: boolean }) {
  const t = useOrdersT();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const error = fetcher.data && !fetcher.data.ok ? (fetcher.data.message ?? t(`errors.${fetcher.data.code}`)) : null;
  return (
    <article className="adm-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/admin/orders/${row.ref}`} className="adm-link">
          <Ref value={row.ref} />
        </Link>
        <OrderStatusBadge status={row.status as never} />
      </div>
      <p className="type-body">
        {t("fulfillment.units", { count: row.units })}
        {row.serialUnits > 0 ? ` · ${t("fulfillment.serialUnits", { count: row.serialUnits })}` : ""}
      </p>
      <p className="type-caption text-ink-2">
        {row.governorate ?? "—"} · {t("fulfillment.waiting", { time: f.relative(row.confirmedAt ?? row.placedAt, now) })}
      </p>
      <div className="flex flex-wrap gap-2">
        {row.onHold ? <Status tone="bad">{t("reviewStatus.blocked")}</Status> : null}
        {row.packed ? <Status tone="ok">{t("fulfillment.packed")}</Status> : null}
        <DemoNote show={row.isDemo} />
      </div>
      <p className="type-caption text-ink-2">{row.assignedTo ? t("assign.current", { name: row.assignedTo.name }) : t("assign.nobody")}</p>
      {packers ? (
        <fetcher.Form method="post" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="orderId" value={row.id} />
          <Select
            name="employeeId"
            label={t("assign.to")}
            className="min-w-[12rem] flex-1"
            defaultValue={row.assignedTo?.id ?? ""}
            options={[{ value: "", label: t("assign.none") }, ...packers.map((packer) => ({ value: packer.id, label: packer.name }))]}
          />
          <Key type="submit" size="sm" loading={fetcher.state !== "idle"}>
            {t("assign.save")}
          </Key>
        </fetcher.Form>
      ) : null}
      <Failure message={error} />
      {canPack ? (
        <div>
          <Key as={Link} to={`/admin/orders/${row.ref}/pack`} size="sm" variant="ink" icon="barcode" disabled={row.onHold}>
            {t("fulfillment.pack")}
          </Key>
        </div>
      ) : null}
    </article>
  );
}
