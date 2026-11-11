import { Link } from "react-router";

import type { Route } from "./+types/preorders";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listPreorders } from "~/server/services/admin/orders/preorders.server";
import { EmptyState } from "~/ui/EmptyState";
import { Status } from "~/ui/Tag";
import { ordersMeta } from "./meta";
import { DemoNote, Facts, Money, OrderStatusBadge, Ref, useOrdersT, When } from "./ui";

/**
 * /admin/orders/preorders — 05.07: orders marked as pre-orders (expected date; a later date is a delay update with a
 * held message to the customer — set on the order page) and open orders holding a product that is not released yet.
 * Deposits are shown as the catalogue sets them; taking a deposit needs a split payment in the core (requested).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.read");
  return { ...(await listPreorders(db, actor, ctx.locale, ctx.now)), now: ctx.now };
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "preorders.title");

export default function PreordersPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const f = useFormat();
  const { rows, canManage } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("preorders.title")}</h1>
        <p className="max-w-[65ch] type-body text-ink-2">{t("preorders.lead")}</p>
      </header>
      <p className="adm-notice adm-notice--warn mb-4" role="note">
        <Icon name="info" size={18} />
        <span>{t("preorder.depositBoundary")}</span>
      </p>
      {rows.length === 0 ? (
        <EmptyState title={t("preorders.empty")} text={t("preorders.emptyHint")} icon="calendar-blank" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <li key={row.id}>
              <article className="adm-card">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/admin/orders/${row.ref}`} className="adm-link">
                    <Ref value={row.ref} />
                  </Link>
                  <OrderStatusBadge status={row.status as never} />
                </div>
                <ul className="type-body">
                  {row.items.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
                <Facts
                  rows={[
                    { label: t("preorder.isPreorder"), value: row.isPreorder ? t("yes") : t("preorders.notMarked") },
                    { label: t("preorder.expected"), value: <When at={row.expectedAt} style="date" />, hidden: !row.expectedAt },
                    { label: t("preorder.release"), value: <When at={row.releaseAt} style="date" />, hidden: !row.releaseAt },
                    { label: t("preorder.deposit"), value: row.depositIqd !== null ? f.iqd(row.depositIqd) : "—", hidden: row.depositIqd === null },
                    { label: t("detail.total"), value: <Money iqd={row.totalIqd} /> },
                    { label: t("detail.paid"), value: <Money iqd={row.paidIqd} /> },
                  ]}
                />
                <div className="flex flex-wrap gap-2">
                  {row.overdue ? <Status tone="bad">{t("risk.preorder_overdue.title")}</Status> : null}
                  <DemoNote show={row.isDemo} />
                </div>
                {canManage ? (
                  <Link to={`/admin/orders/${row.ref}#order-preorder`} className="adm-link">
                    {t("preorders.manage")}
                  </Link>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
