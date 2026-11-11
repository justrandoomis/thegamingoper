import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/order";
import { useFormat } from "~/i18n/react";
import { AppError, throwAsResponse } from "~/server/errors";
import { cancelPurchaseOrder, closePurchaseOrder, decidePurchaseOrder, getPurchaseOrder, markOrderSent, submitPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { SPLIT_WINDOW_DAYS, needsApproval, rateToText } from "~/server/services/admin/purchasing/rules";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { Key } from "~/ui/Key";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Facts, History, Kpi, Minor, Money, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { failed, ok, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/orders/:poId — one purchase order (09.03): its lines (ordered, received, waiting in draft receipts,
 * invoiced), the approval (requester, total against the spending limit, the decision by a second person — on a phone
 * too), the next step (submit, approve / reject, mark as sent, receive, record the invoice, close, cancel — each with
 * its impact before it is confirmed), its receipts, invoices, claims and history. Amounts only for cost.read.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.read");
  try {
    return { detail: await getPurchaseOrder(db, actor, params.poId, locale, now), access: purchasingAccess(actor) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const { db, actor, locale, now } = await openPurchasing(context, intent === "approve" || intent === "reject" ? "purchasing.po.approve" : "purchasing.po.create");
  const poId = params.poId;
  try {
    switch (intent) {
      case "submit": {
        const result = await submitPurchaseOrder(db, actor, { poId, version: text(form, "version"), note: text(form, "reason") || undefined }, now);
        return ok({ intent, status: result.status });
      }
      case "approve":
      case "reject": {
        // The request the approver saw: a newer one (sent back, changed, asked again) is not decided by this page.
        const result = await decidePurchaseOrder(db, actor, { poId, decision: intent, note: text(form, "reason") || undefined, approvalId: text(form, "approvalId") || undefined }, now);
        return ok({ intent, status: result.status });
      }
      case "send":
        await markOrderSent(db, actor, { poId }, now);
        return ok({ intent });
      case "cancel":
        await cancelPurchaseOrder(db, actor, { poId, reason: text(form, "reason") }, now);
        return ok({ intent });
      case "close": {
        const result = await closePurchaseOrder(db, actor, { poId, reason: text(form, "reason") || undefined }, now);
        return ok({ intent, outstanding: result.outstanding });
      }
      default:
        return failed(new AppError("invalid", 400), locale, intent);
    }
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "order.title", { ref: args.loaderData?.detail.order.ref ?? "" });

type Detail = Route.ComponentProps["loaderData"]["detail"];
type Dialog = null | "submit" | "approve" | "reject" | "send" | "cancel" | "close";

export default function OrderPage({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const { detail, access } = loaderData;
  const { order, can, units } = detail;
  const [dialog, setDialog] = useState<Dialog>(null);
  const waiting = detail.approvals.find((approval) => approval.status === "pending");
  const withCost = order.totalMinor !== undefined;
  // A draft: the server weighs it as the submission will (the higher of its rate and the store's, plus what this
  // employee approved alone for the supplier this week); otherwise nothing to decide here.
  const check = detail.limitCheck;
  const windowIqd = check?.windowIqd ?? 0;
  const aboveLimit = check ? check.needsApproval : null;
  const aboveByWindow = check ? check.needsApproval && !needsApproval(check.orderIqd, detail.limitIqd) : false;
  const storeRateHigher = check && check.storeRateIqd !== null && order.totalIqd !== null && order.totalIqd !== undefined && check.storeRateIqd > order.totalIqd ? check.storeRateIqd : null;
  const totalRows = withCost
    ? [
        { label: t("order.total"), value: <Minor minor={order.totalMinor} currency={order.currency} /> },
        { label: t("order.totalIqd"), value: <Money iqd={order.totalIqd} unknownLabel={t("order.noRate")} /> },
      ]
    : [];

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/purchasing/orders" className="adm-link type-label">
          {t("order.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            {access.supplierRead ? <RowLink to={`/admin/purchasing/suppliers/${order.supplier.id}`}><bdi>{order.supplier.name}</bdi></RowLink> : <bdi>{order.supplier.name}</bdi>}
            {order.isDemo ? ` · ${t("common.demo")}` : ""}
          </>
        }
        title={t("order.title", { ref: order.ref })}
        actions={
          <>
            <StateTag group="po" value={order.status} label={t(`poStatus.${order.status}`)} />
            <Key as={Link} to={`/admin/purchasing/orders/${order.id}/print`} size="sm" icon="printer">
              {t("order.print")}
            </Key>
          </>
        }
      />

      {waiting ? (
        <Section id="approval" title={t("order.approvalTitle")}>
          <article className={can.decide ? "adm-card adm-card--act" : "adm-card"}>
            <p className="type-body">{t("order.approvalAsked", { name: waiting.requestedBy ?? "—" })}</p>
            <p className="type-caption text-ink-2">
              <When at={waiting.requestedAt} />
            </p>
            {waiting.totalIqd !== undefined && waiting.limitIqd !== undefined ? (
              <div className="grid gap-1">
                <Pair label={t("order.totalIqd")}>
                  <Money iqd={waiting.totalIqd} />
                </Pair>
                <Pair label={t("order.limit")}>
                  <Money iqd={waiting.limitIqd} />
                </Pair>
                {waiting.storeRateIqd ? (
                  <Pair label={t("order.atStoreRate")}>
                    <Money iqd={waiting.storeRateIqd} />
                  </Pair>
                ) : null}
                {waiting.windowIqd ? (
                  <Pair label={t("order.windowAsked", { days: SPLIT_WINDOW_DAYS })}>
                    <Money iqd={waiting.windowIqd} />
                  </Pair>
                ) : null}
              </div>
            ) : null}
            {waiting.reason ? <p className="type-body">{t("common.noteIs", { note: waiting.reason })}</p> : null}
            {can.decide ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <Key variant="commit" icon="check" onClick={() => setDialog("approve")}>
                  {t("order.approve")}
                </Key>
                <Key className="[--on:var(--red-ink)]" onClick={() => setDialog("reject")}>
                  {t("order.reject")}
                </Key>
              </div>
            ) : (
              <p className="type-caption text-ink-2">{can.ownRequest ? t("order.cannotDecideOwn") : t("order.waitsForApprover")}</p>
            )}
          </article>
        </Section>
      ) : null}

      <div className="pur-kpis mb-5">
        <Kpi label={t("order.unitsOrdered")} value={f.number(units.ordered)} />
        <Kpi label={t("order.unitsReceived")} value={f.number(units.received)} />
        <Kpi label={t("order.unitsOutstanding")} value={f.number(units.outstanding)} hint={units.pending > 0 ? t("order.pendingHint", { count: units.pending }) : undefined} />
        {withCost ? <Kpi wide label={t("order.totalIqd")} value={<Money iqd={order.totalIqd} unknownLabel={t("order.noRate")} />} hint={order.currency !== "IQD" ? <Minor minor={order.totalMinor} currency={order.currency} /> : undefined} /> : null}
      </div>

      {order.late ? (
        <Note tone="warn" icon="clock" className="mb-4">
          {t("order.lateNote", { count: units.outstanding })}
        </Note>
      ) : null}
      {order.status === "cancelled" ? (
        <Note icon="x-circle" className="mb-4">
          {t("order.cancelledNote", { reason: order.cancelReason ?? "—" })}
        </Note>
      ) : null}

      <Section id="next" title={t("order.next")}>
        <div className="flex flex-wrap gap-2">
          {can.submit ? (
            <Key variant="ink" icon="paper-plane-tilt" onClick={() => setDialog("submit")}>
              {t("order.submit")}
            </Key>
          ) : null}
          {can.edit ? (
            <Key as={Link} to={`/admin/purchasing/orders/${order.id}/edit`} icon="pencil-simple">
              {t("order.edit")}
            </Key>
          ) : null}
          {can.send ? (
            <Key icon="paper-plane-tilt" onClick={() => setDialog("send")}>
              {t("order.markSent")}
            </Key>
          ) : null}
          {can.receive ? (
            <Key as={Link} to={`/admin/purchasing/orders/${order.id}/receive`} icon="package" variant={can.submit ? undefined : "ink"}>
              {t("order.receive")}
            </Key>
          ) : null}
          {can.invoice ? (
            <Key as={Link} to={`/admin/purchasing/orders/${order.id}/invoice`} icon="file-text">
              {t("order.recordInvoice")}
            </Key>
          ) : null}
          {can.claim ? (
            <Key as={Link} to={`/admin/purchasing/claims?po=${order.id}#new`} icon="warning">
              {t("order.newClaim")}
            </Key>
          ) : null}
          {can.close ? (
            <Key icon="check-circle" onClick={() => setDialog("close")}>
              {t("order.close")}
            </Key>
          ) : null}
          {can.cancel ? (
            <Key icon="x-circle" className="[--on:var(--red-ink)]" onClick={() => setDialog("cancel")}>
              {t("order.cancel")}
            </Key>
          ) : null}
        </div>
        {order.status === "draft" && !can.submit && !access.cost ? <p className="type-caption text-ink-2">{t("order.noCostNoSubmit")}</p> : null}
        {can.cancelBlockedByInvoice ? <p className="type-caption text-ink-2">{t("errors.po_has_invoices")}</p> : null}
      </Section>

      <Section id="facts" title={t("order.details")}>
        <Facts
          items={[
            { label: t("order.deliverTo"), value: order.location ? `${order.location.code} · ${order.location.name}` : "—" },
            { label: t("order.expected"), value: <When at={order.expectedAt} kind="date" /> },
            { label: t("supplier.paymentTerms"), value: order.paymentTerms ?? "—" },
            { label: t("supplier.currency"), value: <Code>{order.currency}</Code> },
            ...(withCost && order.currency !== "IQD"
              ? [
                  {
                    label: t("order.fxRate"),
                    value: (
                      <span>
                        <Code>{order.fxRateMicros ? `1 ${order.currency} = ${rateToText(order.fxRateMicros)} IQD` : "—"}</Code>
                        {detail.storeRateMicros && detail.storeRateMicros !== order.fxRateMicros ? (
                          <span className="type-caption text-ink-2">
                            {" · "}
                            {t("order.storeRateToday")} <Code>{rateToText(detail.storeRateMicros)}</Code>
                          </span>
                        ) : null}
                      </span>
                    ),
                  },
                ]
              : []),
            { label: t("common.created"), value: <span>{order.createdBy ?? "—"} · <When at={order.createdAt} /></span> },
            { label: t("order.approvedBy"), value: order.approvedAt ? <span>{order.approvedBy ?? "—"} · <When at={order.approvedAt} /></span> : "—" },
            { label: t("order.sentAt"), value: <When at={order.sentAt} /> },
            ...(order.rfq ? [{ label: t("order.fromRfq"), value: <RowLink to={`/admin/purchasing/rfqs/${order.rfq.id}`}><Code>{order.rfq.ref}</Code></RowLink> }] : []),
            ...(order.notes ? [{ label: t("orderForm.notes"), value: order.notes, wide: true }] : []),
          ]}
        />
      </Section>

      <Section id="lines" title={t("order.lines", { count: detail.lines.length })}>
        <ResponsiveList
          caption={t("order.lines", { count: detail.lines.length })}
          rows={detail.lines}
          rowKey={(line) => line.id}
          columns={[
            { key: "sku", header: t("common.sku"), cell: (line) => (access.stock ? <RowLink to={`/admin/inventory/stock/${line.variant.id}`}><Code>{line.variant.sku}</Code></RowLink> : <Code>{line.variant.sku}</Code>) },
            { key: "name", header: t("common.product"), cell: (line) => <span className="line-clamp-2 min-w-[12rem]">{line.variant.name}</span> },
            { key: "ordered", header: t("order.ordered"), numeric: true, cell: (line) => <Num value={line.qtyOrdered} /> },
            { key: "received", header: t("order.received"), numeric: true, cell: (line) => <Num value={line.qtyReceived} /> },
            { key: "pending", header: t("order.pending"), numeric: true, cell: (line) => <Num value={line.qtyPending} /> },
            { key: "invoiced", header: t("order.invoiced"), numeric: true, cell: (line) => <Num value={line.qtyInvoiced} /> },
            { key: "outstanding", header: t("order.outstanding"), numeric: true, cell: (line) => <Num value={line.outstanding} /> },
            ...(withCost
              ? [
                  { key: "unit", header: t("order.unitCost", { currency: order.currency }), numeric: true, cell: (line: Detail["lines"][number]) => <Minor minor={line.unitCostMinor} currency={order.currency} /> },
                  { key: "lineTotal", header: t("order.lineTotal", { currency: order.currency }), numeric: true, cell: (line: Detail["lines"][number]) => <Minor minor={line.lineTotalMinor} currency={order.currency} /> },
                ]
              : []),
          ]}
          card={(line) => (
            <>
              <p className="type-strong">{line.variant.name}</p>
              <p className="type-caption text-ink-2">
                <Code>{line.variant.sku}</Code>
              </p>
              <Pair label={t("order.receivedOf")}>
                <Num value={line.qtyReceived} /> / <Num value={line.qtyOrdered} />
              </Pair>
              {line.qtyPending > 0 ? (
                <Pair label={t("order.pending")}>
                  <Num value={line.qtyPending} />
                </Pair>
              ) : null}
              {withCost ? (
                <Pair label={t("order.unitCost", { currency: order.currency })}>
                  <Minor minor={line.unitCostMinor} currency={order.currency} />
                </Pair>
              ) : null}
            </>
          )}
        />
        {withCost && (order.shippingMinor || order.otherMinor) ? (
          <div className="adm-card grid gap-1 sm:max-w-md">
            <Pair label={t("order.subtotal")}>
              <Minor minor={order.subtotalMinor} currency={order.currency} />
            </Pair>
            <Pair label={t("orderForm.shipping", { currency: order.currency })}>
              <Minor minor={order.shippingMinor} currency={order.currency} />
            </Pair>
            <Pair label={t("orderForm.other", { currency: order.currency })}>
              <Minor minor={order.otherMinor} currency={order.currency} />
            </Pair>
            <Pair label={t("order.total")}>
              <Minor minor={order.totalMinor} currency={order.currency} />
            </Pair>
          </div>
        ) : null}
      </Section>

      <Section id="receipts" title={t("order.receipts")}>
        {detail.receipts.length === 0 ? (
          <p className="type-body text-ink-2">{t("order.noReceipts")}</p>
        ) : (
          <ul role="list" className="grid gap-2 sm:grid-cols-2">
            {detail.receipts.map((receipt) => (
              <li key={receipt.id} className="adm-card gap-1">
                <div className="flex items-start justify-between gap-2">
                  <RowLink to={`/admin/purchasing/receipts/${receipt.id}`}>
                    <Code>{receipt.ref}</Code>
                  </RowLink>
                  <StateTag group="receipt" value={receipt.state} label={t(`receiptState.${receipt.state}`)} />
                </div>
                <Pair label={t("receipt.units")}>
                  <Num value={receipt.units} />
                  {receipt.rejected > 0 ? <span className="text-red-ink"> · {t("receipt.rejectedN", { count: receipt.rejected })}</span> : null}
                </Pair>
                <Pair label={t("receipt.receivedAt")}>
                  <When at={receipt.receivedAt} />
                </Pair>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {detail.invoices.length > 0 || can.invoice ? (
        <Section id="invoices" title={t("order.invoices")}>
          {detail.invoices.length === 0 ? (
            <p className="type-body text-ink-2">{t("order.noInvoices")}</p>
          ) : (
            <ul role="list" className="grid gap-2 sm:grid-cols-2">
              {detail.invoices.map((invoice) => (
                <li key={invoice.id} className="adm-card gap-1">
                  <div className="flex items-start justify-between gap-2">
                    <RowLink to={`/admin/purchasing/invoices/${invoice.id}`}>
                      <Code>{invoice.invoiceNo}</Code>
                    </RowLink>
                    <StateTag group="invoice" value={invoice.status} label={t(`invoiceStatus.${invoice.status}`)} />
                  </div>
                  {invoice.totalMinor !== undefined ? (
                    <Pair label={t("order.total")}>
                      <Minor minor={invoice.totalMinor} currency={order.currency} />
                    </Pair>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {detail.claims.length > 0 ? (
        <Section id="claims" title={t("order.claims")}>
          <ul role="list" className="grid gap-2 sm:grid-cols-2">
            {detail.claims.map((claim) => (
              <li key={claim.id} className="adm-card gap-1">
                <div className="flex items-start justify-between gap-2">
                  {access.claim ? (
                    <RowLink to={`/admin/purchasing/claims/${claim.id}`}>
                      <Code>{claim.ref}</Code>
                    </RowLink>
                  ) : (
                    <Code>{claim.ref}</Code>
                  )}
                  <StateTag group="claim" value={claim.status} label={t(`claimStatus.${claim.status}`)} />
                </div>
                <p className="type-caption text-ink-2">{t(`claimKind.${claim.kind}`)}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {detail.approvals.length > 0 ? (
        <Section id="approvals" title={t("order.approvals")}>
          <ol className="grid gap-2">
            {detail.approvals.map((approval) => (
              <li key={approval.id} className="adm-card gap-0.5">
                <p className="type-body">
                  <StateTag group="po" value={approval.status === "pending" ? "pending_approval" : approval.status === "approved" ? "received" : "cancelled"} label={t(`approvalStatus.${approval.status}`)} /> · {t("order.askedBy", { name: approval.requestedBy ?? "—" })}
                  {approval.decidedBy ? ` · ${t("order.decidedBy", { name: approval.decidedBy })}` : ""}
                </p>
                {approval.decisionNote ? <p className="type-caption text-ink-2">{t("common.noteIs", { note: approval.decisionNote })}</p> : null}
                <p className="type-caption text-ink-2">
                  <When at={approval.decidedAt ?? approval.requestedAt} />
                </p>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section id="history" title={t("common.history")}>
        <History entries={detail.history} />
      </Section>

      <ActionDialog
        open={dialog === "submit"}
        onClose={() => setDialog(null)}
        title={t("order.submitTitle")}
        consequence={aboveLimit === null ? t("order.submitConsequence") : aboveByWindow ? t("order.submitAboveWindow", { days: SPLIT_WINDOW_DAYS }) : aboveLimit ? t("order.submitAbove") : t("order.submitWithin")}
        confirmLabel={t("order.submit")}
        impact={[
          ...totalRows,
          ...(storeRateHigher !== null ? [{ label: t("order.atStoreRate"), value: <Money iqd={storeRateHigher} /> }] : []),
          ...(detail.limitIqd !== undefined ? [{ label: t("order.limit"), value: <Money iqd={detail.limitIqd} /> }] : []),
          ...(windowIqd > 0 ? [{ label: t("order.windowUsed", { days: SPLIT_WINDOW_DAYS }), value: <Money iqd={windowIqd} /> }] : []),
          { label: t("order.unitsOrdered"), value: f.number(units.ordered) },
        ]}
        fields={{ intent: "submit", version: String(order.updatedAt) }}
        successMessage={t("order.submitted")}
      />
      <ActionDialog
        open={dialog === "approve"}
        onClose={() => setDialog(null)}
        title={t("order.approveTitle")}
        consequence={t("order.approveConsequence", { supplier: order.supplier.name })}
        confirmLabel={t("order.approve")}
        tone="commit"
        impact={[...totalRows, { label: t("order.unitsIncoming"), value: `+${f.number(units.ordered)}` }]}
        fields={{ intent: "approve", approvalId: waiting?.id ?? "" }}
        successMessage={t("order.approved")}
      />
      <ActionDialog
        open={dialog === "reject"}
        onClose={() => setDialog(null)}
        title={t("order.rejectTitle")}
        consequence={t("order.rejectConsequence")}
        confirmLabel={t("order.reject")}
        tone="destructive"
        reason={{ hint: t("order.rejectHint") }}
        fields={{ intent: "reject", approvalId: waiting?.id ?? "" }}
        successMessage={t("order.rejected")}
      />
      <ActionDialog open={dialog === "send"} onClose={() => setDialog(null)} title={t("order.sendTitle")} consequence={t("order.sendConsequence")} confirmLabel={t("order.markSent")} fields={{ intent: "send" }} successMessage={t("order.sent")} />
      <ActionDialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        title={t("order.cancelTitle")}
        consequence={t("order.cancelConsequence")}
        confirmLabel={t("order.cancel")}
        tone="destructive"
        reason
        impact={[{ label: t("order.unitsIncoming"), value: `−${f.number(units.outstanding)}`, negative: true }, ...(withCost ? [{ label: t("order.commitmentIqd"), value: <Money iqd={order.totalIqd === null || order.totalIqd === undefined ? null : -order.totalIqd} unknownLabel={t("order.noRate")} />, negative: true }] : [])]}
        fields={{ intent: "cancel" }}
        successMessage={t("order.cancelled")}
      />
      <ActionDialog
        open={dialog === "close"}
        onClose={() => setDialog(null)}
        title={t("order.closeTitle")}
        consequence={units.outstanding > 0 ? t("order.closeShort", { count: units.outstanding }) : t("order.closeFull")}
        confirmLabel={t("order.close")}
        tone={units.outstanding > 0 ? "destructive" : "neutral"}
        reason={units.outstanding > 0 ? { hint: t("order.closeHint") } : undefined}
        impact={units.outstanding > 0 ? [{ label: t("order.unitsIncoming"), value: `−${f.number(units.outstanding)}`, negative: true }] : undefined}
        fields={{ intent: "close" }}
        successMessage={t("order.closed")}
      />
    </>
  );
}
