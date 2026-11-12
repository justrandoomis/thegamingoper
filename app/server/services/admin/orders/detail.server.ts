/**
 * 05.02 — the unified order page: customer, items (with serials), payments with their proofs, refunds, address,
 * stock and reservations, parcels, assignment and tasks, review flags, pre-order, invoice, the full history with actor
 * and reason, and the notification log — plus which actions this employee may take, with their stock and money
 * impact (the confirm dialog shows it before anything happens).
 *
 *   const detail = await getOrderDetail(db, actor, ref, ctx.locale, ctx.now, urls);       // orders.order.read
 *
 * FIELD PERMISSIONS: cost and margin are SELECTED only for cost.read (and profit.read for the margin) — for anyone
 * else the properties do not exist in the result. A cancelled or returned order has no margin at all (nothing sold). Proof images get a URL only with payment_proof.read. Phones are
 * masked without customer.phone.read_full. The audit trail's entries (before/after, reasons) only with audit.read;
 * the order's own events (status changes with their reasons, payments, notes) for every reader of the order.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import {
  approvals,
  auditEvents,
  couponRedemptions,
  customers,
  districts,
  governorates,
  inventoryLocations,
  invoices,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  outbox,
  paymentProofs,
  payments,
  products,
  refunds,
  serials,
  staffTasks,
  stockMovements,
  stockReservations,
  usedUnits,
  variants,
} from "~/server/db/schema";
import { getRefundableAmount, refundDestination } from "~/server/services/refunds.server";
import { orderEditBlockers } from "~/server/services/orders/edit.server";
import { transitionPermission } from "~/server/services/orders/manage.server";
import { manualTransitions } from "~/server/services/orders/state";
import { packProgress, parcelsOf } from "./fulfillment.server";
import { riskFlagsOf, unresolvedFlags } from "./risk.server";
import { employeeNames, orderByRef, packers, phoneFor, safeData } from "./shared.server";
import type { HistoryEntry, OrderDetail, OrderLineView, PaymentView, ProofView, RefundView, RiskRuleId, TransitionOption } from "./types";

export type DetailUrls = { proofImage: (proofId: string) => string; deliveryProof: (fileId: string) => string };

const FORWARD = new Set(["confirmed", "preparing", "shipped", "delivered"]);
const UNSOLD = new Set(["cancelled", "returned"]);

export async function getOrderDetail(db: Db, actor: Actor, ref: string, locale: Locale, now: number, urls: DetailUrls): Promise<OrderDetail> {
  assertCan(actor, "orders.order.read");
  const order = await orderByRef(db, ref);
  const seeCost = can(actor, "cost.read");
  // A cancelled or returned order sold nothing (the goods never left, or came back): it has no margin — neither a
  // profit nor a loss of its whole cost. Before shipping the margin is the expected one, from the cost snapshot.
  const seeMargin = seeCost && can(actor, "profit.read") && !UNSOLD.has(order.status);
  const seeAudit = can(actor, "audit.read");
  const seeProofs = can(actor, "payment_proof.read");

  const [items, paymentRows, refundRows, reservationRows, eventRows, notificationRows, taskRows, invoiceRow, geo, customer, previousOrders, redemption, flagsMap] = await Promise.all([
    db
      .select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        usedUnitId: orderItems.usedUnitId,
        sku: orderItems.sku,
        name: orderItems.nameSnapshot,
        options: orderItems.optionsSnapshot,
        unitPriceIqd: orderItems.unitPriceIqd,
        qty: orderItems.qty,
        totalIqd: orderItems.totalIqd,
        refundedQty: orderItems.refundedQty,
        warrantyMonths: orderItems.warrantyMonths,
        warrantyDays: orderItems.warrantyDays,
        barcode: variants.barcode,
        trackSerials: variants.trackSerials,
        releaseAt: products.preorderReleaseAt,
        depositIqd: products.preorderDepositIqd,
        // [P] — selected only for cost.read
        ...(seeCost ? { cost: orderItems.costSnapshotIqd } : {}),
      })
      .from(orderItems)
      .innerJoin(variants, eq(variants.id, orderItems.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id)),
    db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(asc(payments.createdAt), asc(payments.id)),
    db.select().from(refunds).where(eq(refunds.orderId, order.id)).orderBy(asc(refunds.createdAt), asc(refunds.id)),
    db
      .select({ id: stockReservations.id, sku: variants.sku, location: inventoryLocations.code, qty: stockReservations.qty, status: stockReservations.status, expiresAt: stockReservations.expiresAt })
      .from(stockReservations)
      .innerJoin(variants, eq(variants.id, stockReservations.variantId))
      .innerJoin(inventoryLocations, eq(inventoryLocations.id, stockReservations.locationId))
      .where(eq(stockReservations.orderId, order.id))
      .orderBy(asc(stockReservations.createdAt), asc(stockReservations.id)),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id)).orderBy(asc(orderEvents.at), asc(orderEvents.id)),
    db
      .select({ id: outbox.id, channel: outbox.channel, template: outbox.template, status: outbox.status, createdAt: outbox.createdAt, sentAt: outbox.sentAt, lastError: outbox.lastError })
      .from(outbox)
      .where(and(eq(outbox.refType, "order"), eq(outbox.refId, order.id)))
      .orderBy(desc(outbox.createdAt))
      .limit(50),
    db
      .select({ id: staffTasks.id, title: staffTasks.title, status: staffTasks.status, assignedTo: staffTasks.assignedTo, createdAt: staffTasks.createdAt, completedAt: staffTasks.completedAt })
      .from(staffTasks)
      .where(and(eq(staffTasks.refType, "order"), eq(staffTasks.refId, order.id)))
      .orderBy(desc(staffTasks.createdAt)),
    db
      .select({ number: invoices.number, issuedAt: invoices.issuedAt })
      .from(invoices)
      .where(and(eq(invoices.orderId, order.id), eq(invoices.kind, "invoice")))
      .get(),
    Promise.all([
      order.governorateId ? db.select({ name: governorates.name }).from(governorates).where(eq(governorates.id, order.governorateId)).get() : Promise.resolve(undefined),
      order.districtId ? db.select({ name: districts.name }).from(districts).where(eq(districts.id, order.districtId)).get() : Promise.resolve(undefined),
    ]),
    order.customerId ? db.select({ status: customers.status, fraudFlag: customers.fraudFlag, vipTier: customers.vipTier, name: customers.name }).from(customers).where(eq(customers.id, order.customerId)).get() : Promise.resolve(undefined),
    db
      .select({ n: sql<number>`count(*)` })
      .from(orders)
      .where(
        and(
          sql`${orders.id} <> ${order.id}`,
          order.customerId ? or(eq(orders.customerId, order.customerId), order.contactPhoneE164 ? eq(orders.contactPhoneE164, order.contactPhoneE164) : undefined) : order.contactPhoneE164 ? eq(orders.contactPhoneE164, order.contactPhoneE164) : sql`0`,
        ),
      )
      .get(),
    order.couponId
      ? db
          .select({ voidedAt: couponRedemptions.voidedAt })
          .from(couponRedemptions)
          .where(and(eq(couponRedemptions.orderId, order.id), isNull(couponRedemptions.voidedAt)))
          .get()
      : Promise.resolve(undefined),
    riskFlagsOf(db, [order.id], now),
  ]);

  const itemIds = items.map((item) => item.id);
  const paymentIds = paymentRows.map((row) => row.id);
  const refundIds = refundRows.map((row) => row.id);
  const usedIds = items.flatMap((item) => (item.usedUnitId ? [item.usedUnitId] : []));
  const [serialRows, proofRows, usedRows, cogs, auditRows, parcels, progress, approvalsRows] = await Promise.all([
    itemIds.length
      ? db
          .select({ orderItemId: orderItemSerials.orderItemId, id: serials.id, serial: serials.serial, releasedAt: orderItemSerials.releasedAt })
          .from(orderItemSerials)
          .innerJoin(serials, eq(serials.id, orderItemSerials.serialId))
          .where(inArray(orderItemSerials.orderItemId, itemIds))
      : Promise.resolve([]),
    paymentIds.length ? db.select().from(paymentProofs).where(inArray(paymentProofs.paymentId, paymentIds)).orderBy(desc(paymentProofs.createdAt), desc(paymentProofs.id)) : Promise.resolve([]),
    usedIds.length ? db.select({ id: usedUnits.id, status: usedUnits.status, grade: usedUnits.grade }).from(usedUnits).where(inArray(usedUnits.id, usedIds)) : Promise.resolve([]),
    seeCost
      ? db
          .select({
            cost: sql<number>`coalesce(sum(-${stockMovements.qtyDelta} * ${stockMovements.unitCostIqd}), 0)`,
            uncosted: sql<number>`coalesce(sum(CASE WHEN ${stockMovements.unitCostIqd} IS NULL THEN 1 ELSE 0 END), 0)`,
            moves: sql<number>`count(*)`,
          })
          .from(stockMovements)
          .where(and(eq(stockMovements.refType, "order"), eq(stockMovements.refId, order.id), eq(stockMovements.kind, "sale")))
          .get()
      : Promise.resolve(undefined),
    seeAudit
      ? db
          .select({ id: auditEvents.id, at: auditEvents.at, action: auditEvents.action, actorKind: auditEvents.actorKind, actorLabel: auditEvents.actorLabel, reason: auditEvents.reason, summary: auditEvents.summary, entityType: auditEvents.entityType })
          .from(auditEvents)
          .where(
            or(
              and(eq(auditEvents.entityType, "order"), eq(auditEvents.entityId, order.id)),
              paymentIds.length ? and(eq(auditEvents.entityType, "payment"), inArray(auditEvents.entityId, paymentIds)) : undefined,
              refundIds.length ? and(eq(auditEvents.entityType, "refund"), inArray(auditEvents.entityId, refundIds)) : undefined,
              itemIds.length ? and(eq(auditEvents.entityType, "order_item"), inArray(auditEvents.entityId, itemIds)) : undefined,
            ),
          )
          .orderBy(asc(auditEvents.seq))
          .limit(300)
      : Promise.resolve([]),
    parcelsOf(db, order.id, locale, urls.deliveryProof),
    packProgress(db, order.id, locale),
    refundIds.length
      ? db
          .select({ entityId: approvals.entityId, source: sql<string | null>`json_extract(${approvals.payload}, '$.source')` })
          .from(approvals)
          .where(and(eq(approvals.entityType, "refund"), inArray(approvals.entityId, refundIds)))
      : Promise.resolve([] as { entityId: string | null; source: string | null }[]),
  ]);

  // Names of everyone who appears on the page.
  const names = await employeeNames(db, [
    order.assignedTo,
    order.reviewedBy,
    ...paymentRows.map((row) => row.verifiedBy),
    ...proofRows.map((row) => row.reviewedBy),
    ...refundRows.flatMap((row) => [row.createdBy, row.approvedBy]),
    ...eventRows.map((row) => (row.actorKind === "employee" ? row.actorId : null)),
    ...taskRows.map((row) => row.assignedTo),
  ]);
  const nameOf = (id: string | null | undefined) => (id ? (names.get(id) ?? (id.startsWith("system:") ? id : id)) : null);

  // Lines
  const lines: OrderLineView[] = items.map((item) => {
    const progressLine = progress.lines.find((line) => line.orderItemId === item.id);
    const options = item.options ? Object.values(item.options).filter(Boolean).join(" · ") : null;
    const line: OrderLineView = {
      id: item.id,
      variantId: item.variantId,
      usedUnitId: item.usedUnitId,
      sku: item.sku,
      barcode: item.barcode,
      name: pick(item.name, locale),
      options: options || null,
      unitPriceIqd: item.unitPriceIqd,
      qty: item.qty,
      totalIqd: item.totalIqd,
      refundedQty: item.refundedQty,
      trackSerials: Boolean(progressLine && progressLine.serialUnits > 0) || item.trackSerials,
      serials: serialRows.filter((row) => row.orderItemId === item.id).map((row) => ({ id: row.id, serial: row.serial, releasedAt: row.releasedAt })),
      warranty: item.warrantyMonths ? `m:${item.warrantyMonths}` : item.warrantyDays ? `d:${item.warrantyDays}` : null,
    };
    if (seeCost) {
      const unit = (item as { cost?: number | null }).cost ?? null;
      line.unitCostIqd = unit;
      if (seeMargin) line.marginIqd = unit === null ? null : item.totalIqd - unit * item.qty;
    }
    return line;
  });

  // Payments with their proofs
  const duplicateIds = proofRows.flatMap((row) => (row.duplicateOf ? [row.duplicateOf] : []));
  const duplicateRefs = duplicateIds.length
    ? await db
        .select({ proofId: paymentProofs.id, orderRef: orders.ref })
        .from(paymentProofs)
        .innerJoin(payments, eq(payments.id, paymentProofs.paymentId))
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(inArray(paymentProofs.id, duplicateIds))
    : [];
  const proofView = (row: (typeof proofRows)[number]): ProofView => ({
    id: row.id,
    status: row.status,
    declaredAmountIqd: row.declaredAmountIqd,
    reference: row.reference,
    note: row.note,
    createdAt: row.createdAt,
    reviewedBy: nameOf(row.reviewedBy),
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    duplicateOf: row.duplicateOf ? { proofId: row.duplicateOf, orderRef: duplicateRefs.find((entry) => entry.proofId === row.duplicateOf)?.orderRef ?? null } : null,
    ...(seeProofs ? { imageUrl: urls.proofImage(row.id) } : {}),
  });
  const paymentViews: PaymentView[] = [];
  for (const row of paymentRows) {
    paymentViews.push({
      id: row.id,
      method: row.method,
      status: row.status,
      amountIqd: row.amountIqd,
      declaredAmountIqd: row.declaredAmountIqd,
      reference: row.reference,
      verifiedBy: nameOf(row.verifiedBy),
      verifiedAt: row.verifiedAt,
      paidAt: row.paidAt,
      rejectReason: row.rejectReason,
      createdAt: row.createdAt,
      refundableIqd: row.status === "paid" ? await getRefundableAmount(db, row.id) : 0,
      proofs: proofRows.filter((proof) => proof.paymentId === row.id).map(proofView),
    });
  }

  const me = actor.kind === "employee" ? actor.id : null;
  const methodOf = new Map(paymentRows.map((row) => [row.id, row.method]));
  const refundViews: RefundView[] = refundRows.map((row) => ({
    id: row.id,
    paymentId: row.paymentId,
    amountIqd: row.amountIqd,
    method: row.method,
    status: row.status,
    reason: row.reason,
    createdBy: nameOf(row.createdBy),
    createdAt: row.createdAt,
    approvedBy: nameOf(row.approvedBy),
    approvedAt: row.approvedAt,
    reference: row.reference,
    rejectReason: row.rejectReason,
    mine: row.createdBy !== null && row.createdBy === me,
    needsReference: refundDestination(row.method, methodOf.get(row.paymentId) ?? "cod").needsReference,
    source: approvalsRows.find((entry) => entry.entityId === row.id)?.source ?? null,
  }));

  // History: the order's own events, plus the audit trail for audit.read
  const history: HistoryEntry[] = eventRows.map((row) => {
    const data = safeData(row.data);
    const reason = typeof row.data?.reason === "string" ? row.data.reason : null;
    if (typeof row.data?.text === "string") data.text = row.data.text.slice(0, 1000);
    return {
      id: row.id,
      source: "order" as const,
      kind: row.kind === "status_changed" ? `status_${String(row.data?.to ?? "")}` : row.kind,
      at: row.at,
      actor: { kind: row.actorKind, name: row.actorKind === "employee" ? nameOf(row.actorId) : null },
      reason,
      data,
    };
  });
  for (const row of auditRows) {
    history.push({ id: row.id, source: "audit", kind: row.action, at: row.at, actor: { kind: row.actorKind, name: row.actorLabel }, reason: row.reason, data: { summary: row.summary ?? null, entity: row.entityType ?? null } });
  }
  history.sort((a, b) => a.at - b.at || (a.source === b.source ? 0 : a.source === "order" ? -1 : 1));

  // What happens on each move this employee may make
  const activeUnits = reservationRows.filter((row) => row.status === "active").reduce((sum, row) => sum + row.qty, 0);
  const usedHeld = usedRows.filter((row) => row.status === "reserved").length;
  const attachedSerials = serialRows.filter((row) => row.releasedAt === null).length;
  const refundableTotal = paymentViews.filter((row) => row.status === "paid").reduce((sum, row) => sum + row.refundableIqd, 0);
  const unpaidRows = paymentRows.some((row) => row.status === "pending" || row.status === "pending_verification" || row.status === "rejected");
  const onHold = order.reviewStatus === "blocked";
  const transitions: TransitionOption[] = manualTransitions(order.status)
    .filter((to) => can(actor, transitionPermission(order.status, to)))
    .map((to) => {
      let blocker: string | null = null;
      if (onHold && FORWARD.has(to)) blocker = "order_on_hold";
      else if (to === "shipped" && !progress.complete) blocker = progress.lines.some((line) => line.serialsScanned.length < line.serialUnits) ? "serials_required" : "packing_incomplete";
      const cancels = to === "cancelled";
      const backFromShipped = to === "returned" && order.status === "shipped";
      return {
        to,
        reasonRequired: to === "cancelled" || to === "returned",
        blocker,
        impact: {
          units: to === "shipped" || cancels ? activeUnits : backFromShipped ? items.reduce((sum, item) => sum + item.qty, 0) : 0,
          usedUnits: to === "shipped" || cancels ? usedHeld : 0,
          serialsReleased: cancels ? attachedSerials : 0,
          pendingRefundIqd: cancels || backFromShipped ? refundableTotal : 0,
          couponFreed: (cancels || backFromShipped) && redemption !== undefined,
          unpaidCancelled: (cancels || backFromShipped) && unpaidRows,
        },
      };
    });

  const flags = flagsMap.get(order.id) ?? [];
  const blockers = await orderEditBlockers(db, order);
  const canAssign = can(actor, "orders.order.assign");
  const preorderRelease = Math.max(0, ...items.map((item) => item.releaseAt ?? 0)) || null;
  const deposits = items.filter((item) => item.depositIqd !== null && (item.releaseAt ?? 0) > now);
  const detail: OrderDetail = {
    id: order.id,
    ref: order.ref,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    channel: order.channel,
    isDemo: order.isDemo,
    placedAt: order.placedAt,
    confirmedAt: order.confirmedAt,
    shippedAt: order.shippedAt,
    deliveredAt: order.deliveredAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    paymentDueAt: order.paymentDueAt,
    totals: {
      subtotalIqd: order.subtotalIqd,
      discountIqd: order.discountIqd,
      shippingIqd: order.shippingIqd,
      taxIqd: order.taxIqd,
      totalIqd: order.totalIqd,
      paidIqd: order.paidIqd,
      refundedIqd: order.refundedIqd,
      dueIqd: order.status === "cancelled" ? 0 : Math.max(0, order.totalIqd - order.paidIqd),
    },
    coupon: order.couponCode,
    customer: {
      kind: order.customerId ? "customer" : "guest",
      name: order.contactName ?? customer?.name ?? null,
      profileId: customerProfileId(actor, order.customerId),
      phone: phoneFor(actor, order.contactPhoneE164),
      accountStatus: customer?.status ?? null,
      fraudFlag: customer?.fraudFlag ?? false,
      vipTier: customer?.vipTier ?? null,
      previousOrders: Number(previousOrders?.n ?? 0),
    },
    address: {
      governorate: geo[0] ? pick(geo[0].name, locale) : null,
      district: geo[1] ? pick(geo[1].name, locale) : null,
      area: order.areaText,
      address: order.addressText,
      notes: order.notes,
      preferredDay: order.preferredDay,
      preferredWindow: order.preferredWindow,
    },
    lines,
    units: items.reduce((sum, item) => sum + item.qty, 0),
    payments: paymentViews,
    refunds: refundViews,
    reservations: reservationRows,
    usedUnits: usedRows,
    parcels,
    assignedTo: order.assignedTo ? { id: order.assignedTo, name: nameOf(order.assignedTo) ?? order.assignedTo } : null,
    tasks: taskRows.map((row) => ({ ...row, assignedTo: nameOf(row.assignedTo) })),
    review: {
      status: order.reviewStatus,
      reviewedBy: nameOf(order.reviewedBy),
      reviewedAt: order.reviewedAt,
      flags,
      clearedFlags: order.reviewStatus === "cleared" ? flags.filter((flag) => !unresolvedFlags([flag], "cleared", order.riskFlags).length) : [],
    },
    preorder: {
      isPreorder: order.isPreorder,
      expectedAt: order.expectedAt,
      releaseAt: preorderRelease,
      depositIqd: deposits.length ? deposits.reduce((sum, item) => sum + (item.depositIqd ?? 0) * item.qty, 0) : null,
    },
    invoice: invoiceRow ?? null,
    history,
    notifications: notificationRows,
    transitions,
    can: {
      verify: can(actor, "orders.payment.verify"),
      override: can(actor, "orders.payment.override"),
      seeProofs,
      recordCod: can(actor, "orders.payment.record"),
      refund: can(actor, "orders.refund.create"),
      approveRefund: can(actor, "orders.refund.approve"),
      assign: canAssign,
      note: can(actor, "orders.order.note"),
      review: can(actor, "orders.risk.review"),
      edit: can(actor, "orders.order.update"),
      pack: can(actor, "orders.fulfillment.pack"),
      ship: can(actor, "orders.fulfillment.ship"),
      deliver: can(actor, "orders.fulfillment.deliver"),
      deliveryProof: can(actor, "orders.fulfillment.deliver") || can(actor, "shipping.proof.manage"),
      print: can(actor, "orders.document.print"),
      preorder: can(actor, "orders.preorder.manage"),
      seeAudit,
    },
    editBlockers: blockers,
    assignable: canAssign ? await packers(db) : [],
  };
  if (seeCost) {
    // What left the warehouse at FIFO landed cost (sale movements) — or, before shipping, the cost snapshot of the lines.
    const shippedCost = cogs && Number(cogs.moves) > 0 ? (Number(cogs.uncosted) > 0 ? null : Number(cogs.cost)) : undefined;
    const snapshot = lines.some((line) => line.unitCostIqd === null) ? null : lines.reduce((sum, line) => sum + (line.unitCostIqd ?? 0) * line.qty, 0);
    detail.costIqd = shippedCost !== undefined ? shippedCost : snapshot;
    if (seeMargin) detail.marginIqd = detail.costIqd === null ? null : order.subtotalIqd - order.discountIqd - order.refundedIqd - detail.costIqd;
  }
  return detail;
}

/** The rules that flag an order, for the explanation list (re-exported for the screens). */
export type { RiskRuleId };
