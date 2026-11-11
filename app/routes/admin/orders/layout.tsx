import { Outlet } from "react-router";

import type { Route } from "./+types/layout";
import { can } from "~/server/actor";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { orderCounts } from "~/server/services/admin/orders/list.server";
import { ordersI18n } from "./common.server";
import { OrdersNav, useOrdersT } from "./ui";

import "./orders.css";

/**
 * /admin/orders/* — admin module 05 "Orders & Fulfillment" (docs/areas/admin-orders.md). The shell's gate already let
 * through only employees who hold some orders.* permission; every page below checks its own permission again in its
 * loader and action (requireEmployee) and the services check it once more (assertCan).
 *
 * This layout sends the module's strings and the sections this employee may open, with the number waiting in each
 * queue (the beads), to every page of the module.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db);
  const read = can(actor, "orders.order.read");
  const counts = read ? await orderCounts(db, actor, ctx.now) : null;
  return {
    i18n: ordersI18n(ctx.locale),
    nav: {
      list: read,
      proofs: can(actor, "orders.payment.verify"),
      refunds: can(actor, "orders.refund.approve") || can(actor, "orders.refund.create"),
      fulfillment: can(actor, "orders.fulfillment.pack") || can(actor, "orders.order.assign"),
      review: can(actor, "orders.risk.review"),
      preorders: read,
    },
    counts,
  };
}

export default function OrdersLayout({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const { nav, counts } = loaderData;
  return (
    <>
      <div className="ord-noprint">
        <OrdersNav
          items={[
            { to: "/admin/orders", label: t("nav.list"), icon: "list", show: nav.list },
            { to: "/admin/orders/proofs", label: t("nav.proofs"), icon: "receipt", count: counts?.proofs, show: nav.proofs },
            { to: "/admin/orders/refunds", label: t("nav.refunds"), icon: "hand-coins", count: counts?.refunds, show: nav.refunds },
            { to: "/admin/orders/fulfillment", label: t("nav.fulfillment"), icon: "package", count: counts?.mine, show: nav.fulfillment },
            { to: "/admin/orders/review", label: t("nav.review"), icon: "flag", count: counts?.review, show: nav.review },
            { to: "/admin/orders/preorders", label: t("nav.preorders"), icon: "calendar-blank", show: nav.preorders },
          ]}
        />
      </div>
      <Outlet />
    </>
  );
}
