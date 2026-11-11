import { Link } from "react-router";

import type { Route } from "./+types/refunds";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { listRefundQueue } from "~/server/services/admin/orders/queues.server";
import { EmptyState } from "~/ui/EmptyState";
import { Status } from "~/ui/Tag";
import { ordersMeta } from "./meta";
import { RefundDecision } from "./order-parts";
import { DemoNote, Facts, Money, Ref, useOrdersT, When } from "./ui";

/**
 * /admin/orders/refunds — refunds waiting for a second person (four eyes on money leaving). The shell counts the same
 * rows for orders.refund.approve, never the employee's own requests. The decision posts to the order page's action
 * (intent refund-decision → approveRefund, which refuses the requester: approver_is_requester). An employee who may
 * only request refunds sees their own requests and their state.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.read");
  try {
    return await listRefundQueue(db, actor);
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "refunds.title");

export default function RefundQueue({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const f = useFormat();
  const { rows, canApprove } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("refunds.title")}</h1>
        <p className="max-w-[65ch] type-body text-ink-2">{canApprove ? t("refunds.lead") : t("refunds.leadMine")}</p>
      </header>
      {rows.length === 0 ? (
        <EmptyState title={t("refunds.empty")} text={t("refunds.emptyHint")} icon="hand-coins" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={t("refunds.title")}>
          {rows.map((row) => (
            <li key={row.refundId}>
              <article className={row.mine || !canApprove ? "adm-card" : "adm-card adm-card--act"}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/admin/orders/${row.orderRef}`} className="adm-link">
                    <Ref value={row.orderRef} />
                  </Link>
                  <DemoNote show={row.isDemo} />
                  <Status tone="warn">{t("refundStatus.pending")}</Status>
                </div>
                <p className="type-kpi nums">
                  <Money iqd={row.amountIqd} />
                </p>
                <Facts
                  rows={[
                    { label: t("refund.method"), value: t(`refund.methods.${row.method === "original" ? `original_${row.paymentMethod}` : row.method}`) },
                    { label: t("refund.leftAfter"), value: f.iqd(row.refundableIqd) },
                    { label: t("refund.reason"), value: row.reason ?? "—" },
                    { label: t("refund.source"), value: row.source ? t(`refund.sources.${row.source}`) : t("refund.sources.manual") },
                    { label: t("refund.requestedBy"), value: row.requestedBy ?? "—" },
                    { label: t("refund.requestedAt"), value: <When at={row.createdAt} /> },
                  ]}
                />
                {row.mine ? (
                  <p className="flex items-center gap-1 type-body text-ink-2">
                    <Icon name="users" size={16} />
                    {t("refund.mine")}
                  </p>
                ) : canApprove ? (
                  <RefundDecision
                    orderRef={row.orderRef}
                    action={`/admin/orders/${row.orderRef}`}
                    refund={{
                      id: row.refundId,
                      paymentId: row.paymentId,
                      amountIqd: row.amountIqd,
                      method: row.method,
                      status: "pending",
                      reason: row.reason,
                      createdBy: row.requestedBy,
                      createdAt: row.createdAt,
                      approvedBy: null,
                      approvedAt: null,
                      reference: null,
                      rejectReason: null,
                      mine: row.mine,
                      needsReference: row.needsReference,
                      source: row.source,
                    }}
                  />
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
