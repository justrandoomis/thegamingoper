import { data, Link } from "react-router";

import type { Route } from "./+types/order";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { Key } from "~/ui/Key";
import { getOrderDetail } from "~/server/services/admin/orders/detail.server";
import { ordersMeta } from "./meta";
import { urls } from "./common.server";
import { ordersBlobStore } from "./env.server";
import { orderAction } from "./order.server";
import {
  AddressSection,
  AssignmentSection,
  CustomerSection,
  HistorySection,
  InvoiceSection,
  ItemsSection,
  NotesSection,
  NotificationsSection,
  ParcelsSection,
  PaymentsSection,
  PreorderSection,
  RefundsSection,
  ReviewSection,
  StockSection,
  TransitionBar,
} from "./order-parts";
import { DemoNote, FlagTags, OrderStatusBadge, PaymentBadge, Ref, ReviewBadge, useOrdersT, When } from "./ui";

/**
 * /admin/orders/:ref — the unified order page (05.02): everything about one order in one place, and every action the
 * employee may take on it, each through the commerce core with the confirm-with-reason dialog showing its stock and
 * money impact first (blueprint uxRules). Cost and margin exist on the page only for cost.read / profit.read.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.read");
  try {
    return { order: await getOrderDetail(db, actor, params.ref, ctx.locale, ctx.now, urls), now: ctx.now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, "orders.order.read");
  const result = await orderAction(ctx, db, session, params.ref, await request.formData(), ordersBlobStore);
  return result.ok ? result : data(result, { status: result.status });
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "detail.pageTitle", { ref: args.loaderData?.order.ref ?? "" });

export default function OrderPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const { order } = loaderData;
  const packable = order.status === "confirmed" || order.status === "preparing";
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/orders" className="adm-link">
            {t("detail.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-3">
          <span>{t("detail.title")}</span>
          <Ref value={order.ref} />
          <DemoNote show={order.isDemo} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <OrderStatusBadge status={order.status} />
          <PaymentBadge status={order.paymentStatus} method={order.paymentMethod} />
          <ReviewBadge status={order.review.status} />
          <FlagTags flags={order.review.flags} />
          <span className="type-caption text-ink-2">
            {t("detail.placed")} <When at={order.placedAt} />
          </span>
        </div>
      </header>

      <TransitionBar order={order} />

      <div className="ord-actions mb-6">
        {order.can.edit && !(order.editBlockers.lines && order.editBlockers.address) ? (
          <Key as={Link} size="sm" icon="pencil-simple" to={`/admin/orders/${order.ref}/edit`}>
            {t("detail.edit")}
          </Key>
        ) : null}
        {order.can.pack && packable ? (
          <Key as={Link} size="sm" icon="barcode" to={`/admin/orders/${order.ref}/pack`}>
            {t("detail.pack")}
          </Key>
        ) : null}
        {order.can.print ? (
          <>
            <Key as={Link} size="sm" icon="receipt" to={`/admin/orders/print?kind=invoice&id=${order.id}`}>
              {t("detail.printInvoice")}
            </Key>
            <Key as={Link} size="sm" icon="clipboard-text" to={`/admin/orders/print?kind=packing&id=${order.id}`}>
              {t("detail.printPacking")}
            </Key>
            <Key as={Link} size="sm" icon="printer" to={`/admin/orders/print?kind=label&id=${order.id}`}>
              {t("detail.printLabel")}
            </Key>
          </>
        ) : null}
      </div>

      <div className="ord-layout">
        <div className="grid min-w-0 gap-2">
          <ItemsSection order={order} />
          <PaymentsSection order={order} />
          <RefundsSection order={order} />
          <ParcelsSection order={order} />
          <StockSection order={order} />
          <HistorySection order={order} />
          <NotificationsSection order={order} />
        </div>
        <aside className="ord-side" aria-label={t("detail.side")}>
          <CustomerSection order={order} />
          <AddressSection order={order} />
          <AssignmentSection order={order} />
          <ReviewSection order={order} />
          <PreorderSection order={order} />
          <InvoiceSection order={order} />
          <NotesSection order={order} />
        </aside>
      </div>
    </>
  );
}

