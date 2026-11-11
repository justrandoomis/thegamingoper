/**
 * Fraud monitoring of returns (blueprint 12.05): deterministic rules, each with the sentence that explains it — a
 * reviewer sees WHY, never a score. Signals do not block anything by themselves: the hard limits are the database's
 * (never more refunded than paid, never more units than sold, a serial attached once) and the core's (two people on
 * money leaving). Rules (thresholds in types.ts FRAUD_THRESHOLDS):
 *
 *   repeat_returner        the same phone or customer opened ≥ 3 returns within 90 days (this one included)
 *   high_value             the returned units are worth ≥ 1,000,000 IQD
 *   quick_return           a change-of-mind return asked for within 24 hours of delivery
 *   customer_flagged       the customer's account carries the fraud flag
 *   earlier_refunds        the order already had money refunded outside this return
 *   no_photos              a defect or delivery damage claimed without a photo
 *   policy_override        opened despite the eligibility rules (by a manager, with a reason)
 *   serial_mismatch        an inspector scanned a different unit than the one sold (recorded, refused)
 *   refund_method_differs  cash refunded for a payment that did not arrive as cash
 */
import { and, eq, gte, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, customers, files, orders, payments, refunds, returnItems, returns, type ReturnRequest } from "~/server/db/schema";
import { DAY_MS, HOUR_MS, VOID_REFUND, VOID_RETURN, unitValuesFor } from "./shared.server";
import { FRAUD_THRESHOLDS, type FraudSignal } from "./types";

const T = FRAUD_THRESHOLDS;

export async function fraudSignals(db: Db, rows: readonly ReturnRequest[]): Promise<Map<string, FraudSignal[]>> {
  const out = new Map<string, FraudSignal[]>();
  if (rows.length === 0) return out;
  const ids = rows.map((row) => row.id);
  const orderIds = [...new Set(rows.map((row) => row.orderId))];
  const phones = [...new Set(rows.map((row) => row.phoneE164).filter((value): value is string => typeof value === "string"))];
  const customerIds = [...new Set(rows.map((row) => row.customerId).filter((value): value is string => typeof value === "string"))];
  const earliest = Math.min(...rows.map((row) => row.createdAt)) - T.repeatDays * DAY_MS;

  const [orderRows, items, photos, audits, related, flagged, orderRefunds] = await Promise.all([
    db.select().from(orders).where(inArray(orders.id, orderIds)),
    db.select({ returnId: returnItems.returnId, orderItemId: returnItems.orderItemId, qty: returnItems.qty }).from(returnItems).where(inArray(returnItems.returnId, ids)),
    db
      .select({ ownerId: files.ownerId, n: sql<number>`count(*)` })
      .from(files)
      .where(and(eq(files.ownerType, "return"), inArray(files.ownerId, ids), sql`${files.deletedAt} IS NULL`))
      .groupBy(files.ownerId),
    db
      .select({ entityId: auditEvents.entityId, action: auditEvents.action, after: auditEvents.after })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "return"), inArray(auditEvents.entityId, ids), inArray(auditEvents.action, ["returns.rma.create", "returns.rma.serial_mismatch"]))),
    phones.length || customerIds.length
      ? db
          .select({ id: returns.id, phone: returns.phoneE164, customerId: returns.customerId, createdAt: returns.createdAt })
          .from(returns)
          .where(
            and(
              notInArray(returns.status, [...VOID_RETURN]),
              gte(returns.createdAt, earliest),
              or(phones.length ? inArray(returns.phoneE164, phones) : sql`0`, customerIds.length ? inArray(returns.customerId, customerIds) : sql`0`),
            ),
          )
      : Promise.resolve([]),
    customerIds.length ? db.select({ id: customers.id }).from(customers).where(and(inArray(customers.id, customerIds), eq(customers.fraudFlag, true))) : Promise.resolve([]),
    db
      .select({ orderId: refunds.orderId, returnId: refunds.returnId, key: refunds.idempotencyKey, amountIqd: refunds.amountIqd, method: refunds.method, paymentMethod: payments.method })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(and(inArray(refunds.orderId, orderIds), notInArray(refunds.status, [...VOID_REFUND]))),
  ]);
  const orderById = new Map(orderRows.map((order) => [order.id, order]));
  const values = await unitValuesFor(db, orderRows);
  const flaggedCustomers = new Set(flagged.map((row) => row.id));
  const photoCount = new Map(photos.map((row) => [row.ownerId, Number(row.n)]));

  for (const row of rows) {
    const signals: FraudSignal[] = [];
    const order = orderById.get(row.orderId);
    const mine = items.filter((item) => item.returnId === row.id);
    const value = mine.reduce((sum, item) => sum + (values.get(item.orderItemId) ?? 0) * item.qty, 0);

    const window = row.createdAt - T.repeatDays * DAY_MS;
    const repeat = related.filter((other) => other.createdAt >= window && other.createdAt <= row.createdAt && ((row.phoneE164 && other.phone === row.phoneE164) || (row.customerId && other.customerId === row.customerId))).length;
    if (repeat >= T.repeatCount) signals.push({ id: "repeat_returner", vars: { count: repeat, days: T.repeatDays } });
    if (value >= T.highValueIqd) signals.push({ id: "high_value", vars: { amount: value, threshold: T.highValueIqd } });
    if (row.reasonCode === "changed_mind" && order?.deliveredAt && row.createdAt - order.deliveredAt <= T.quickHours * HOUR_MS) signals.push({ id: "quick_return", vars: { hours: T.quickHours } });
    if (row.customerId && flaggedCustomers.has(row.customerId)) signals.push({ id: "customer_flagged", vars: {} });
    const prefix = `rma:${row.id}:`;
    const others = orderRefunds.filter((refund) => refund.orderId === row.orderId && refund.returnId !== row.id && !(refund.key ?? "").startsWith(prefix));
    const othersIqd = others.reduce((sum, refund) => sum + refund.amountIqd, 0);
    if (othersIqd > 0) signals.push({ id: "earlier_refunds", vars: { amount: othersIqd } });
    if ((row.reasonCode === "defective" || row.reasonCode === "damaged_in_delivery") && !photoCount.get(row.id)) signals.push({ id: "no_photos", vars: {} });
    const created = audits.find((event) => event.entityId === row.id && event.action === "returns.rma.create");
    if ((created?.after as { override?: unknown } | null)?.override === true) signals.push({ id: "policy_override", vars: {} });
    const mismatches = audits.filter((event) => event.entityId === row.id && event.action === "returns.rma.serial_mismatch").length;
    if (mismatches > 0) signals.push({ id: "serial_mismatch", vars: { count: mismatches } });
    const mineRefunds = orderRefunds.filter((refund) => refund.orderId === row.orderId && (refund.returnId === row.id || (refund.key ?? "").startsWith(prefix)));
    if (mineRefunds.some((refund) => refund.method === "cash" && refund.paymentMethod !== "cod" && refund.paymentMethod !== "pos_cash")) signals.push({ id: "refund_method_differs", vars: {} });
    out.set(row.id, signals);
  }
  return out;
}
