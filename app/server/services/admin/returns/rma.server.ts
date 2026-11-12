/**
 * RMAs (blueprint 12.01, the "game or device return" workflow): open one on a customer's behalf, linked to the order
 * line, the serial, a reason and private photos; approve or reject it (a second person: the employee who opened it
 * never decides it); follow it through receipt, inspection (inspect.server), refund (refund.server) and closing.
 *
 *   const order = await findOrderForReturn(db, actor, "TT-7K4M2Q9X", locale, now);           // lines + eligibility (12.02)
 *   const { rma } = await openReturn(db, actor, { orderRef, items, reasonCode, reason, requestedResolution, idempotencyKey }, now, locale);
 *   await decideReturn(db, otherActor, returnId, { approve: true }, now);
 *   const page = await listReturns(db, actor, parseRmaFilters(url.searchParams), locale, now);
 *   const detail = await getReturnDetail(db, actor, rma, locale, now, urls);
 *
 * WHO: reading needs returns.rma.read (an employee who may only open RMAs — returns.rma.create — sees the ones they
 * opened, and works on those only: in transit, notes and photos of anyone else's RMA are the same not_found its page
 * answers); opening returns.rma.create; deciding, cancelling and closing returns.rma.approve; receiving and inspection
 * returns.rma.inspect. Phones are masked without customer.phone.read_full. Nothing here returns cost data.
 *
 * Every change is one guarded batch (the RMA's status in the WHERE clause, so two employees cannot both act on the
 * same state) with its audit event (actor, reason, before/after). Opening is idempotent on the form's key (the
 * return id derives from it) and guarded in the batch against a unit being returned twice by two RMAs at once.
 *
 * Errors (AppError): forbidden (403), approver_is_requester (403), not_found (404), invalid (400; fields items =
 * invalid | serials_required | serial_not_on_line, reason, rejectReason, overrideReason = override_reason_required,
 * phone = phone_invalid), return_not_delivered · return_qty_exceeds · not_eligible · rma_changed ·
 * photo_limit (409).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef, sha256Hex } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Permission } from "~/server/permissions";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  auditEvents,
  customers,
  files,
  orderItems,
  orders,
  payments,
  refundItems,
  refunds,
  repairTickets,
  returnItems,
  returns,
  serials,
  stockMovements,
  warranties,
  type NewReturnItem,
  type ReturnRequest,
} from "~/server/db/schema";
import { chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { getRefundableAmount, refundDestination } from "~/server/services/refunds.server";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import { fraudSignals } from "./fraud.server";
import { evaluateOrder } from "./policy.server";
import { restockingFee } from "./refund.server";
import { DAY_MS, HOUR_MS, VOID_REFUND, VOID_RETURN, branchLimited, employeeNames, failedRepairs, lineName, normalizeRma, openerOf, phoneView, refundableLine, returnById, returnByRma, returnLocations, returnRefundFilter, slaTargets, unitValuesFor, type SlaTargets } from "./shared.server";
import {
  CONDITION_LIST,
  DECISION_LIST,
  FRAUD_RULE_IDS,
  REASON_LIST,
  REQUESTABLE_RESOLUTIONS,
  RESOLUTION_LIST,
  RMA_OPEN_STATUSES,
  SLA,
  VIEW_STATUSES,
  isFaultReason,
  type Condition,
  type Decision,
  type Eligibility,
  type FraudRuleId,
  type FraudSignal,
  type OrderForReturn,
  type QueueCounts,
  type RmaDetail,
  type RmaFilters,
  type RmaItemView,
  type RmaListPage,
  type RmaListRow,
  type RmaRefundView,
  type RmaStatus,
  type WarrantyState,
} from "./types";

export const RMA_ERROR_KEYS = ["approver_is_requester", "return_not_delivered", "return_qty_exceeds", "not_eligible", "rma_changed", "photo_limit"] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID, "invalid");
const PAGE_SIZE = 25;
/** Photos per RMA (the customer's evidence and the inspector's). */
export const MAX_RETURN_PHOTOS = 8;
/** This module's refund events that repeat the core's orders.refund.* events of the same refund (kept in the audit log). */
const MIRRORED_REFUND_EVENTS = new Set(["returns.rma.refund", "returns.rma.refund_approved", "returns.rma.refund_rejected"]);
/** Refund reasons carry "RMA-…: " for the orders module and the books; on the RMA's own page the prefix is noise. */
const ownReason = (rma: string, reason: string | null) => (reason?.startsWith(`${rma}: `) ? reason.slice(rma.length + 2) : reason);

/** What this employee may do in the module (navigation, buttons — the services check again). */
export function returnsAccess(actor: Actor) {
  return {
    read: can(actor, "returns.rma.read"),
    create: can(actor, "returns.rma.create"),
    approve: can(actor, "returns.rma.approve"),
    inspect: can(actor, "returns.rma.inspect"),
    policy: can(actor, "returns.policy.manage"),
    policyRead: canAny(actor, ["returns.rma.read", "returns.rma.create", "returns.policy.manage"]),
    warranty: can(actor, "returns.warranty.read"),
    warrantyManage: can(actor, "returns.warranty.manage"),
    repair: can(actor, "returns.repair.manage"),
    supplier: can(actor, "returns.supplier_return.manage"),
    refund: can(actor, "orders.refund.create"),
    approveRefund: can(actor, "orders.refund.approve"),
    quarantine: canAny(actor, ["returns.rma.inspect", "returns.supplier_return.manage"]),
  };
}
export type ReturnsAccess = ReturnType<typeof returnsAccess>;

/** Reading RMAs: everything with returns.rma.read; only one's own with returns.rma.create alone. */
function readScope(actor: Actor): "all" | "own" {
  if (can(actor, "returns.rma.read")) return "all";
  if (can(actor, "returns.rma.create")) return "own";
  throw forbidden("returns.rma.read");
}

/**
 * A change that returns.rma.create allows (in transit, a note, a photo) is limited to the RMAs that employee opened,
 * unless they also read every RMA (returns.rma.read) or hold another permission that allows the change on any RMA
 * (`others`): anyone else's RMA is the same not_found the RMA's page answers them — not even its existence leaks.
 */
async function assertMayChange(db: Db, actor: Actor, ret: ReturnRequest, others: readonly Permission[]): Promise<void> {
  if (can(actor, "returns.rma.read") || canAny(actor, others)) return;
  if (actor.kind === "employee" && (await openerOf(db, ret.id)) === actor.id) return;
  throw notFound("return");
}

const openedBy = (employeeId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_type = 'return' AND a.entity_id = "returns"."id" AND a.action = 'returns.rma.create' AND a.actor_kind = 'employee' AND a.actor_id = ${employeeId})`;

const BAGHDAD_MS = 3 * HOUR_MS;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - BAGHDAD_MS;

/** When the current step of an RMA is due (a decision, an inspection), or null. */
export function dueOf(row: Pick<ReturnRequest, "status" | "createdAt" | "receivedAt">, sla: Pick<SlaTargets, "decisionHours" | "inspectionHours"> = SLA): number | null {
  if (row.status === "requested") return row.createdAt + sla.decisionHours * HOUR_MS;
  if (row.status === "received" && row.receivedAt) return row.receivedAt + sla.inspectionHours * HOUR_MS;
  return null;
}

// ───────────────────────────────────────────────────────────────── list and queues

function searchCondition(actor: Actor, q: string): SQL | undefined {
  const text = q.trim();
  if (!text) return undefined;
  const rma = normalizeRma(text);
  if (rma) return eq(returns.rma, rma);
  const ref = normalizeOrderRef(text);
  if (ref) return sql`${returns.orderId} IN (SELECT id FROM orders WHERE ref = ${ref})`;
  const phone = normalizeIraqPhone(text);
  if (phone) return eq(returns.phoneE164, phone);
  const digits = toLatinDigits(text).replace(/\D/g, "");
  // Partial phone digits would reveal masked numbers one query at a time: only with the full-phone permission.
  if (digits.length >= 4 && digits.length === text.replace(/[\s-]/g, "").length) {
    return can(actor, "customer.phone.read_full") ? sql`${returns.phoneE164} LIKE ${`%${digits.slice(0, 15)}%`}` : sql`0`;
  }
  const like = `%${text.slice(0, 30).replace(/[%_]/g, "")}%`;
  return sql`${returns.orderId} IN (SELECT id FROM orders WHERE contact_name LIKE ${like})`;
}

export async function listReturns(db: Db, actor: Actor, filters: RmaFilters, locale: Locale, now: number): Promise<RmaListPage> {
  const scope = readScope(actor);
  const conditions: (SQL | undefined)[] = [];
  if (scope === "own" && actor.kind === "employee") conditions.push(openedBy(actor.id));
  if (filters.view !== "all" && filters.view !== "flagged") conditions.push(inArray(returns.status, [...VIEW_STATUSES[filters.view]]));
  if (filters.view === "flagged") conditions.push(notInArray(returns.status, [...VOID_RETURN]));
  if (filters.status) conditions.push(eq(returns.status, filters.status));
  if (filters.reason) conditions.push(eq(returns.reasonCode, filters.reason));
  if (filters.from) conditions.push(gte(returns.createdAt, dayStart(filters.from)));
  if (filters.to) conditions.push(lt(returns.createdAt, dayStart(filters.to) + DAY_MS));
  conditions.push(searchCondition(actor, filters.q));
  const where = and(...conditions);

  let rows: ReturnRequest[];
  let total: number;
  let precomputed: Map<string, FraudSignal[]> | null = null;
  if (filters.view === "flagged") {
    // Signals are computed, not stored: the newest 500 candidates, flagged ones paged in memory.
    const candidates = await db.select().from(returns).where(where).orderBy(desc(returns.createdAt), desc(returns.id)).limit(500);
    const signals = await fraudSignals(db, candidates);
    const flagged = candidates.filter((row) => (signals.get(row.id) ?? []).length > 0);
    total = flagged.length;
    rows = flagged.slice((filters.page - 1) * PAGE_SIZE, filters.page * PAGE_SIZE);
    precomputed = signals;
  } else {
    const [page, count] = await Promise.all([
      db
        .select()
        .from(returns)
        .where(where)
        .orderBy(desc(returns.createdAt), desc(returns.id))
        .limit(PAGE_SIZE)
        .offset((filters.page - 1) * PAGE_SIZE),
      db.select({ n: sql<number>`count(*)` }).from(returns).where(where).get(),
    ]);
    rows = page;
    total = Number(count?.n ?? 0);
  }
  const ids = rows.map((row) => row.id);
  const orderIds = [...new Set(rows.map((row) => row.orderId))];
  const [orderRows, items, refundRows, signals] = await Promise.all([
    orderIds.length ? db.select().from(orders).where(inArray(orders.id, orderIds)) : Promise.resolve([]),
    ids.length ? db.select({ returnId: returnItems.returnId, orderItemId: returnItems.orderItemId, qty: returnItems.qty }).from(returnItems).where(inArray(returnItems.returnId, ids)) : Promise.resolve([]),
    ids.length
      ? db
          .select({ returnId: refunds.returnId, key: refunds.idempotencyKey, status: refunds.status })
          .from(refunds)
          .where(and(notInArray(refunds.status, [...VOID_REFUND]), or(inArray(refunds.returnId, ids), sql`substr(${refunds.idempotencyKey}, 1, 4) = 'rma:'`)))
      : Promise.resolve([]),
    precomputed ? Promise.resolve(precomputed) : fraudSignals(db, rows),
  ]);
  const orderById = new Map(orderRows.map((order) => [order.id, order]));
  const values = await unitValuesFor(db, orderRows);
  const sla = await slaTargets(db);
  const out: RmaListRow[] = rows.map((row) => {
    const order = orderById.get(row.orderId);
    const mine = items.filter((item) => item.returnId === row.id);
    const mineRefunds = refundRows.filter((refund) => refund.returnId === row.id || (refund.key ?? "").startsWith(`rma:${row.id}:`));
    const dueAt = dueOf(row, sla);
    return {
      id: row.id,
      rma: row.rma,
      orderRef: order?.ref ?? "—",
      status: row.status,
      reasonCode: row.reasonCode,
      requestedResolution: row.requestedResolution,
      resolution: row.resolution,
      customerName: order?.contactName ?? null,
      customerProfileId: customerProfileId(actor, row.customerId ?? order?.customerId),
      phone: phoneView(actor, row.phoneE164 ?? order?.contactPhoneE164),
      units: mine.reduce((sum, item) => sum + item.qty, 0),
      valueIqd: mine.reduce((sum, item) => sum + (values.get(item.orderItemId) ?? 0) * item.qty, 0),
      createdAt: row.createdAt,
      dueAt,
      late: dueAt !== null && now > dueAt,
      refund: mineRefunds.some((refund) => refund.status === "paid") ? "paid" : mineRefunds.some((refund) => refund.status === "pending" || refund.status === "approved") ? "pending" : "none",
      flags: (signals.get(row.id) ?? []).map((signal) => signal.id),
      isDemo: order?.isDemo ?? false,
    };
  });
  void locale;
  return { rows: out, total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), filters };
}

/**
 * What waits for this employee in the module (null where they cannot act). Never their own RMA to decide. The RMAs to
 * decide, receive and inspect are listed on /admin/returns, which shows every RMA only with returns.rma.read (without
 * it, one's own at most): without it those three are null — no card counts rows its list cannot show (the bell's rule).
 *
 * `only` (follow-up 2026-11-12, additive): the counts a caller needs — the others are null and never queried. The bell
 * reads `decide` and `inspect` on every admin page; without it the eight counts (and the SLA setting, needed by the
 * warranties-ending count only) were all read for two numbers.
 */
export async function queueCounts(db: Db, actor: Actor, now: number, options: { only?: readonly (keyof QueueCounts)[] } = {}): Promise<QueueCounts> {
  const me = actor.kind === "employee" ? actor.id : null;
  const count = async (query: Promise<{ n: number } | undefined>) => Number((await query)?.n ?? 0);
  const n = sql<number>`count(*)`;
  const wants = (key: keyof QueueCounts) => !options.only || options.only.includes(key);
  const reads = can(actor, "returns.rma.read");
  const [decide, receive, inspect, refund, refundApproval, quarantine, repairsLate, warrantiesEnding] = await Promise.all([
    wants("decide") && can(actor, "returns.rma.approve") && reads ? count(db.select({ n }).from(returns).where(and(eq(returns.status, "requested"), me ? sql`NOT ${openedBy(me)}` : undefined)).get()) : null,
    wants("receive") && can(actor, "returns.rma.inspect") && reads ? count(db.select({ n }).from(returns).where(inArray(returns.status, ["approved", "in_transit"])).get()) : null,
    wants("inspect") && can(actor, "returns.rma.inspect") && reads ? count(db.select({ n }).from(returns).where(eq(returns.status, "received")).get()) : null,
    wants("refund") && can(actor, "orders.refund.create") && can(actor, "returns.rma.read") ? count(db.select({ n }).from(returns).where(eq(returns.status, "inspected")).get()) : null,
    wants("refundApproval") && can(actor, "orders.refund.approve") && can(actor, "returns.rma.read")
      ? count(
          db
            .select({ n })
            .from(refunds)
            .where(and(eq(refunds.status, "pending"), or(sql`${refunds.returnId} IS NOT NULL`, sql`substr(${refunds.idempotencyKey}, 1, 4) = 'rma:'`), me ? sql`coalesce(${refunds.createdBy}, '') <> ${me}` : undefined))
            .get(),
        )
      : null,
    wants("quarantine") && canAny(actor, ["returns.rma.inspect", "returns.supplier_return.manage"])
      ? count(
          db
            .select({ n })
            .from(returnItems)
            .where(
              and(
                inArray(returnItems.restockAction, ["refurbish", "return_to_supplier"]),
                sql`${returnItems.restockedAt} IS NOT NULL`,
                sql`NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.ref_type = 'return_item' AND m.ref_id = "return_items"."id" AND m.qty_delta < 0)`,
              ),
            )
            .get(),
        )
      : null,
    wants("repairsLate") && can(actor, "returns.repair.manage")
      ? count(
          db
            .select({ n })
            .from(repairTickets)
            .where(and(inArray(repairTickets.status, ["submitted", "received", "diagnosing", "awaiting_approval", "awaiting_parts", "repairing"]), lt(repairTickets.slaDueAt, now)))
            .get(),
        )
      : null,
    wants("warrantiesEnding") && can(actor, "returns.warranty.read")
      ? slaTargets(db).then((sla) =>
          count(
            db
              .select({ n })
              .from(warranties)
              .where(and(eq(warranties.status, "active"), gte(warranties.endsAt, now), lte(warranties.endsAt, now + sla.warrantyEndingDays * DAY_MS)))
              .get(),
          ),
        )
      : null,
  ]);
  return { decide, receive, inspect, refund, refundApproval, quarantine, repairsLate, warrantiesEnding };
}

// ───────────────────────────────────────────────────────────────── opening an RMA (12.01)

/** An order looked up for a new RMA: its lines with what can still be returned and the rules' verdict (12.02). */
export async function findOrderForReturn(db: Db, actor: Actor, ref: string, locale: Locale, now: number): Promise<OrderForReturn> {
  assertCan(actor, "returns.rma.create");
  const normalized = normalizeOrderRef(ref);
  const order = normalized ? await db.select().from(orders).where(eq(orders.ref, normalized)).get() : undefined;
  if (!order) throw notFound("order");
  const [lines, earlier, customer] = await Promise.all([
    evaluateOrder(db, order, now, locale),
    db.select({ rma: returns.rma, status: returns.status, createdAt: returns.createdAt }).from(returns).where(eq(returns.orderId, order.id)).orderBy(desc(returns.createdAt)),
    order.customerId ? db.select({ name: customers.name }).from(customers).where(eq(customers.id, order.customerId)).get() : Promise.resolve(undefined),
  ]);
  return {
    orderId: order.id,
    ref: order.ref,
    status: order.status,
    deliveredAt: order.deliveredAt,
    customer: { kind: order.customerId ? "customer" : "guest", name: order.contactName ?? customer?.name ?? null, phone: phoneView(actor, order.contactPhoneE164) },
    lines,
    returns: earlier,
    isDemo: order.isDemo,
  };
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "too_long")
    .optional()
    .transform((value) => value || undefined);

export const OpenReturnInput = z.object({
  orderRef: z.string().trim().min(1, "required").max(40, "invalid"),
  items: z
    .array(
      z.object({
        orderItemId: idSchema,
        qty: z.number().int("invalid").min(1, "too_small").max(100, "too_big"),
        /** One serial per unit for serial-tracked lines (taken from the line's own units). */
        serialIds: z.array(idSchema).max(100).optional(),
        /** Is the item still sealed (unopened)? Decides the seal rule of the policy. */
        sealed: z.boolean().optional(),
      }),
    )
    .min(1, "items_required")
    .max(50, "too_big"),
  reasonCode: z.enum(REASON_LIST, "required"),
  /** The customer's explanation in their own words. */
  reason: z.string().trim().min(5, "too_short").max(2000, "too_long"),
  requestedResolution: z.enum(REQUESTABLE_RESOLUTIONS, "required"),
  /** Contact for this return; default: the order's phone. */
  phone: optionalText(40),
  /** Open it although the rules say no (returns.rma.approve and a reason). */
  override: z.boolean().optional(),
  overrideReason: optionalText(500),
  idempotencyKey: z.string().trim().min(8, "invalid").max(200, "invalid"),
});
export type OpenReturnInput = z.input<typeof OpenReturnInput>;

/** Opens an RMA (status "requested"). Idempotent on `idempotencyKey`. */
export async function openReturn(db: Db, actor: Actor, raw: OpenReturnInput, now: number, locale: Locale = "ar"): Promise<{ returnId: string; rma: string; replayed: boolean }> {
  assertCan(actor, "returns.rma.create");
  const input = OpenReturnInput.parse(raw);
  const returnId = `ret_${(await sha256Hex(`rma:${input.idempotencyKey}`)).slice(0, 26)}`;
  const existing = await db.select({ id: returns.id, rma: returns.rma }).from(returns).where(eq(returns.id, returnId)).get();
  if (existing) return { returnId: existing.id, rma: existing.rma, replayed: true };

  const ref = normalizeOrderRef(input.orderRef);
  const order = ref ? await db.select().from(orders).where(eq(orders.ref, ref)).get() : undefined;
  if (!order) throw notFound("order");
  if (order.status !== "delivered") throw new AppError("return_not_delivered", 409, { detail: order.status, fields: { orderRef: "return_not_delivered" } });
  const ids = input.items.map((item) => item.orderItemId);
  if (new Set(ids).size !== ids.length) throw invalid({ items: "invalid" });

  const sealed = new Map(input.items.filter((item) => item.sealed !== undefined).map((item) => [item.orderItemId, item.sealed as boolean]));
  const lines = await evaluateOrder(db, order, now, locale, { sealed, reasonCode: input.reasonCode });
  let phone = order.contactPhoneE164;
  if (input.phone) {
    phone = normalizeIraqPhone(input.phone);
    if (!phone) throw invalid({ phone: "phone_invalid" });
  }

  const rows: NewReturnItem[] = [];
  const problems: Record<string, string[]> = {};
  for (const item of input.items) {
    const line = lines.find((entry) => entry.orderItemId === item.orderItemId);
    if (!line) throw invalid({ items: "invalid" }, `${item.orderItemId} is not on ${order.ref}`);
    if (item.qty > line.returnableQty) throw new AppError("return_qty_exceeds", 409, { detail: line.orderItemId, fields: { items: "return_qty_exceeds" } });
    const blocking = line.eligibility.problems.filter((problem) => problem !== "nothing_left");
    if (blocking.length) problems[line.orderItemId] = blocking;
    if (line.serials.length > 0) {
      // Serial-tracked (or a used device): one RMA line per unit, each one of the units this line sold.
      const wanted = [...new Set(item.serialIds ?? [])];
      if (wanted.length !== item.qty) throw invalid({ items: "serials_required" }, line.orderItemId);
      for (const serialId of wanted) {
        if (!line.serials.some((entry) => entry.id === serialId)) throw invalid({ items: "serial_not_on_line" }, serialId);
        rows.push({ id: newId("rti"), returnId, orderItemId: line.orderItemId, qty: 1, serialId });
      }
    } else {
      if ((item.serialIds ?? []).length > 0) throw invalid({ items: "serial_not_on_line" }, line.orderItemId);
      rows.push({ id: newId("rti"), returnId, orderItemId: line.orderItemId, qty: item.qty, serialId: null });
    }
  }
  const override = Object.keys(problems).length > 0;
  if (override) {
    if (!input.override) throw new AppError("not_eligible", 409, { detail: JSON.stringify(problems), fields: { items: "not_eligible" } });
    assertCan(actor, "returns.rma.approve");
    if (!input.overrideReason || input.overrideReason.length < 5) throw invalid({ overrideReason: "override_reason_required" });
  }

  const rma = publicRef("RMA");
  const statements: BatchStatement[] = [
    db.insert(returns).values({
      id: returnId,
      rma,
      orderId: order.id,
      customerId: order.customerId,
      status: "requested",
      reason: input.reason,
      createdAt: now,
      reasonCode: input.reasonCode,
      phoneE164: phone,
      requestedResolution: input.requestedResolution,
      staffNote: override ? input.overrideReason ?? null : null,
      updatedAt: now,
    }),
    ...chunkRows(returnItems, rows).map((part) => db.insert(returnItems).values(part)),
  ];
  // Against two RMAs taking the same units at once: what the open and finished returns hold never exceeds what was bought,
  // and a serial is in one return at a time.
  for (const orderItemId of ids) {
    statements.push(
      expectThat(
        db,
        sql`(SELECT coalesce(sum(ri.qty), 0) FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE ri.order_item_id = ${orderItemId} AND r.status NOT IN ('rejected', 'cancelled'))
          <= (SELECT qty FROM order_items WHERE id = ${orderItemId})`,
        { code: "RETURN_QTY_EXCEEDS", detail: orderItemId },
      ),
    );
  }
  for (const serialId of rows.map((row) => row.serialId).filter((value): value is string => typeof value === "string")) {
    statements.push(
      expectThat(db, sql`(SELECT count(*) FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE ri.serial_id = ${serialId} AND r.status NOT IN ('rejected', 'cancelled')) <= 1`, {
        code: "RETURN_QTY_EXCEEDS",
        detail: serialId,
      }),
    );
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: "returns.rma.create",
      entityType: "return",
      entityId: returnId,
      summary: `${rma} · ${order.ref}`,
      after: {
        rma,
        orderRef: order.ref,
        reasonCode: input.reasonCode,
        requestedResolution: input.requestedResolution,
        items: rows.map((row) => ({ orderItemId: row.orderItemId, qty: row.qty, serialId: row.serialId ?? null })),
        eligibility: lines
          .filter((line) => ids.includes(line.orderItemId))
          .map((line) => ({ orderItemId: line.orderItemId, eligible: line.eligibility.eligible, problems: line.eligibility.problems, windowDays: line.eligibility.windowDays, rule: line.eligibility.rule.id, source: line.eligibility.rule.source, sealed: sealed.get(line.orderItemId) ?? null })),
        override,
      },
      reason: override ? (input.overrideReason ?? null) : null,
      at: now,
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error, "returns.id") || isUniqueViolation(error, "returns")) {
      const again = await db.select({ id: returns.id, rma: returns.rma }).from(returns).where(eq(returns.id, returnId)).get();
      if (again) return { returnId: again.id, rma: again.rma, replayed: true };
    }
    if (isDbError(error, "RETURN_QTY_EXCEEDS")) throw new AppError("return_qty_exceeds", 409, { fields: { items: "return_qty_exceeds" }, cause: error });
    throw error;
  }
  return { returnId, rma, replayed: false };
}

// ───────────────────────────────────────────────────────────────── decisions and steps

/** The RMA's guarded status change (only from `from`) with the caller's statements in the same batch. */
export async function guardedStatus(db: Db, ret: ReturnRequest, from: readonly RmaStatus[], set: Partial<typeof returns.$inferInsert> & { updatedAt: number }, extra: BatchStatement[]): Promise<void> {
  try {
    await runBatch(db, [
      db
        .update(returns)
        .set(set)
        .where(and(eq(returns.id, ret.id), inArray(returns.status, [...from]))),
      expectChanged(db, 1, { code: "RMA_CHANGED", detail: ret.id }),
      ...extra,
    ]);
  } catch (error) {
    if (isDbError(error, "RMA_CHANGED")) throw new AppError("rma_changed", 409, { detail: ret.id, cause: error });
    throw error;
  }
}

export const DecideInput = z.object({
  approve: z.boolean(),
  /** Required to reject (shown to the customer); optional note when approving. */
  note: z.string().trim().max(500, "too_long").optional(),
});

/** Approves or rejects a requested RMA (returns.rma.approve, never the employee who opened it). */
export async function decideReturn(db: Db, actor: Actor, returnId: string, raw: z.input<typeof DecideInput>, now: number): Promise<{ status: RmaStatus; replayed: boolean }> {
  assertCan(actor, "returns.rma.approve");
  const input = DecideInput.parse(raw);
  const ret = await returnById(db, returnId);
  const target: RmaStatus = input.approve ? "approved" : "rejected";
  if (ret.status === target) return { status: target, replayed: true };
  if (actor.kind === "employee" && (await openerOf(db, ret.id)) === actor.id) throw new AppError("approver_is_requester", 403, { detail: ret.id });
  const note = input.note ?? "";
  if (!input.approve && note.length < 3) throw invalid({ note: "required" });
  await guardedStatus(
    db,
    ret,
    ["requested"],
    input.approve ? { status: "approved", approvedBy: actor.kind === "employee" ? actor.id : null, approvedAt: now, updatedAt: now } : { status: "rejected", rejectReason: note, closedAt: now, updatedAt: now },
    [auditStatement(db, { actor, action: input.approve ? "returns.rma.approve" : "returns.rma.reject", entityType: "return", entityId: ret.id, summary: ret.rma, before: { status: ret.status }, after: { status: target }, reason: note || null, at: now })],
  );
  return { status: target, replayed: false };
}

/** The parcel is on its way back (pickup arranged or the customer sent it). returns.rma.inspect or returns.rma.create. */
export async function markInTransit(db: Db, actor: Actor, returnId: string, raw: { note?: string }, now: number): Promise<{ replayed: boolean }> {
  if (!canAny(actor, ["returns.rma.inspect", "returns.rma.create"])) throw forbidden("returns.rma.inspect");
  const ret = await returnById(db, returnId);
  await assertMayChange(db, actor, ret, ["returns.rma.inspect"]);
  if (ret.status === "in_transit") return { replayed: true };
  const note = z.string().trim().max(500, "too_long").optional().parse(raw.note);
  await guardedStatus(db, ret, ["approved"], { status: "in_transit", updatedAt: now }, [
    auditStatement(db, { actor, action: "returns.rma.in_transit", entityType: "return", entityId: ret.id, summary: ret.rma, before: { status: ret.status }, after: { status: "in_transit" }, reason: note || null, at: now }),
  ]);
  return { replayed: false };
}

/** Cancels an RMA before its goods arrived (returns.rma.approve), with a reason. */
export async function cancelReturn(db: Db, actor: Actor, returnId: string, raw: { reason?: string }, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "returns.rma.approve");
  const ret = await returnById(db, returnId);
  if (ret.status === "cancelled") return { replayed: true };
  const reason = (raw.reason ?? "").trim();
  if (reason.length < 3) throw invalid({ reason: "required" });
  await guardedStatus(db, ret, ["requested", "approved", "in_transit"], { status: "cancelled", closedAt: now, updatedAt: now }, [
    auditStatement(db, { actor, action: "returns.rma.cancel", entityType: "return", entityId: ret.id, summary: ret.rma, before: { status: ret.status }, after: { status: "cancelled" }, reason: reason.slice(0, 500), at: now }),
  ]);
  return { replayed: false };
}

export const CloseInput = z.object({ resolution: z.enum(RESOLUTION_LIST, "required"), note: z.string().trim().min(3, "required").max(500, "too_long") });

/**
 * Closes an RMA once nothing is left to do (returns.rma.approve): every item inspected, no refund of it waiting. The
 * resolution says how it ended — only what happened: refund → a refund was paid; store credit or exchange → store
 * credit (a wallet refund) was paid; repair → a repair of this RMA was finished; supplier return → a unit was set
 * aside for (or sent to) its supplier. The final status follows it (refunded, exchanged, repaired, otherwise closed).
 */
export async function closeReturn(db: Db, actor: Actor, returnId: string, raw: z.input<typeof CloseInput>, now: number): Promise<{ status: RmaStatus; replayed: boolean }> {
  assertCan(actor, "returns.rma.approve");
  const input = CloseInput.parse(raw);
  const ret = await returnById(db, returnId);
  if (["closed", "refunded", "exchanged", "repaired"].includes(ret.status) && ret.closedAt) return { status: ret.status, replayed: true };
  const n = sql<number>`count(*)`;
  const [open, pending, paid, credit, repaired, supplier] = await Promise.all([
    db.select({ n }).from(returnItems).where(and(eq(returnItems.returnId, ret.id), isNull(returnItems.inspectedBy))).get(),
    db.select({ n }).from(refunds).where(and(returnRefundFilter(ret.id), inArray(refunds.status, ["pending", "approved"]))).get(),
    db.select({ n }).from(refunds).where(and(returnRefundFilter(ret.id), eq(refunds.status, "paid"))).get(),
    db.select({ n }).from(refunds).where(and(returnRefundFilter(ret.id), eq(refunds.status, "paid"), eq(refunds.method, "wallet"))).get(),
    db.select({ n }).from(repairTickets).where(and(eq(repairTickets.returnId, ret.id), isNotNull(repairTickets.completedAt))).get(),
    db.select({ n }).from(returnItems).where(and(eq(returnItems.returnId, ret.id), eq(returnItems.restockAction, "return_to_supplier"))).get(),
  ]);
  if (Number(open?.n ?? 0) > 0) throw new AppError("rma_changed", 409, { detail: "items not inspected", fields: { resolution: "items_not_inspected" } });
  if (Number(pending?.n ?? 0) > 0) throw new AppError("rma_changed", 409, { detail: "refund waiting", fields: { resolution: "refund_waiting" } });
  const moneyBack = Number(paid?.n ?? 0) > 0;
  if (input.resolution === "refund" && !moneyBack) throw invalid({ resolution: "no_refund_issued" });
  if ((input.resolution === "store_credit" || input.resolution === "exchange") && Number(credit?.n ?? 0) === 0) throw invalid({ resolution: "no_store_credit_issued" });
  if (input.resolution === "repair" && Number(repaired?.n ?? 0) === 0) throw invalid({ resolution: "no_repair_done" });
  if (input.resolution === "supplier_return" && Number(supplier?.n ?? 0) === 0) throw invalid({ resolution: "no_supplier_unit" });
  const status: RmaStatus = input.resolution === "exchange" ? "exchanged" : input.resolution === "repair" ? "repaired" : moneyBack && (input.resolution === "refund" || input.resolution === "store_credit") ? "refunded" : "closed";
  await guardedStatus(db, ret, ["received", "inspected", "refunded", "exchanged", "repaired"], { status, resolution: input.resolution, closedAt: now, updatedAt: now, staffNote: input.note }, [
    auditStatement(db, { actor, action: "returns.rma.close", entityType: "return", entityId: ret.id, summary: ret.rma, before: { status: ret.status, resolution: ret.resolution }, after: { status, resolution: input.resolution }, reason: input.note, at: now }),
  ]);
  return { status, replayed: false };
}

/** An internal note on the RMA's history (never shown to the customer). */
export async function addReturnNote(db: Db, actor: Actor, returnId: string, raw: { text?: string }, now: number): Promise<void> {
  if (!canAny(actor, ["returns.rma.create", "returns.rma.inspect", "returns.rma.approve"])) throw forbidden("returns.rma.create");
  const ret = await returnById(db, returnId);
  await assertMayChange(db, actor, ret, ["returns.rma.inspect", "returns.rma.approve"]);
  const text = z.string().trim().min(2, "required").max(1000, "too_long").parse(raw.text ?? "");
  await runBatch(db, [auditStatement(db, { actor, action: "returns.rma.note", entityType: "return", entityId: ret.id, summary: ret.rma, reason: text, at: now })]);
}

// ───────────────────────────────────────────────────────────────── photos (private files)

/** Before a photo is stored: may this employee add one, and is there room? Returns the RMA. */
export async function assertPhotoSlot(db: Db, actor: Actor, returnId: string): Promise<ReturnRequest> {
  if (!canAny(actor, ["returns.rma.create", "returns.rma.inspect"])) throw forbidden("returns.rma.create");
  const ret = await returnById(db, returnId);
  await assertMayChange(db, actor, ret, ["returns.rma.inspect"]);
  if (ret.status === "cancelled" || ret.status === "rejected" || ret.closedAt) throw new AppError("rma_changed", 409, { detail: ret.status });
  const count = await db
    .select({ n: sql<number>`count(*)` })
    .from(files)
    .where(and(eq(files.ownerType, "return"), eq(files.ownerId, ret.id), isNull(files.deletedAt)))
    .get();
  if (Number(count?.n ?? 0) >= MAX_RETURN_PHOTOS) throw new AppError("photo_limit", 409, { fields: { file: "photo_limit" } });
  return ret;
}

/** The audit line for a stored photo (the file row itself names the RMA as its owner). */
export async function recordReturnPhoto(db: Db, actor: Actor, ret: ReturnRequest, fileId: string, now: number): Promise<void> {
  await runBatch(db, [auditStatement(db, { actor, action: "returns.rma.photo", entityType: "return", entityId: ret.id, summary: ret.rma, after: { fileId }, at: now })]);
}

/** A return photo for an employee who may read that RMA; null for anything else (one answer: 404). */
export async function returnPhotoFile(db: Db, actor: Actor, fileId: string): Promise<{ id: string } | null> {
  if (!canAny(actor, ["returns.rma.read", "returns.rma.create"])) throw forbidden("returns.rma.read");
  if (typeof fileId !== "string" || !ID.test(fileId)) return null;
  const row = await db
    .select({ id: files.id, ownerId: files.ownerId })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.ownerType, "return"), eq(files.visibility, "private"), isNull(files.deletedAt)))
    .get();
  if (!row?.ownerId) return null;
  if (!can(actor, "returns.rma.read")) {
    // An employee who may only open RMAs sees the photos of the RMAs they opened.
    if (actor.kind !== "employee" || (await openerOf(db, row.ownerId)) !== actor.id) return null;
  }
  return { id: row.id };
}

// ───────────────────────────────────────────────────────────────── the RMA page

/** The grade and decision an inspection event recorded (for the history), or null. */
function inspectionOf(after: unknown): { condition: Condition; decision: Decision } | null {
  const value = after as { condition?: unknown; decision?: unknown } | null;
  if (!value || !(CONDITION_LIST as readonly unknown[]).includes(value.condition) || !(DECISION_LIST as readonly unknown[]).includes(value.decision)) return null;
  return { condition: value.condition as Condition, decision: value.decision as Decision };
}

export type ReturnUrls = { photo: (fileId: string) => string };

export async function getReturnDetail(db: Db, actor: Actor, rma: string, locale: Locale, now: number, urls: ReturnUrls): Promise<RmaDetail> {
  const scope = readScope(actor);
  const ret = await returnByRma(db, rma);
  const opener = await openerOf(db, ret.id);
  if (scope === "own" && (actor.kind !== "employee" || opener !== actor.id)) throw notFound("return");
  const order = await db.select().from(orders).where(eq(orders.id, ret.orderId)).get();
  if (!order) throw notFound("order");

  const [items, photoRows, refundRows, paymentRows, repairRows, audits, customer, signals, locations] = await Promise.all([
    db
      .select({
        id: returnItems.id,
        orderItemId: returnItems.orderItemId,
        qty: returnItems.qty,
        serialId: returnItems.serialId,
        serial: serials.serial,
        condition: returnItems.condition,
        inspectedBy: returnItems.inspectedBy,
        notes: returnItems.notes,
        restockAction: returnItems.restockAction,
        restockedAt: returnItems.restockedAt,
        name: orderItems.nameSnapshot,
        sku: orderItems.sku,
        usedUnitId: orderItems.usedUnitId,
      })
      .from(returnItems)
      .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
      .leftJoin(serials, eq(serials.id, returnItems.serialId))
      .where(eq(returnItems.returnId, ret.id))
      .orderBy(asc(returnItems.id)),
    db
      .select({ id: files.id, width: files.width, height: files.height })
      .from(files)
      .where(and(eq(files.ownerType, "return"), eq(files.ownerId, ret.id), isNull(files.deletedAt)))
      .orderBy(asc(files.createdAt)),
    db.select().from(refunds).where(returnRefundFilter(ret.id)).orderBy(asc(refunds.createdAt)),
    db.select().from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, "paid"))).orderBy(asc(payments.createdAt)),
    db.select({ id: repairTickets.id, ref: repairTickets.ref, status: repairTickets.status }).from(repairTickets).where(eq(repairTickets.returnId, ret.id)),
    db
      .select()
      .from(auditEvents)
      .where(or(and(eq(auditEvents.entityType, "return"), eq(auditEvents.entityId, ret.id)), and(eq(auditEvents.entityType, "refund"), sql`${auditEvents.entityId} IN (SELECT id FROM refunds WHERE return_id = ${ret.id} OR substr(idempotency_key, 1, ${`rma:${ret.id}:`.length}) = ${`rma:${ret.id}:`})`)))
      .orderBy(asc(auditEvents.seq))
      .limit(200),
    order.customerId ? db.select({ name: customers.name }).from(customers).where(eq(customers.id, order.customerId)).get() : Promise.resolve(undefined),
    fraudSignals(db, [ret]),
    returnLocations(db, actor),
  ]);
  const itemIds = items.map((item) => item.id);
  const [exits, warrantyRows, refunded, values, created, failed, lines] = await Promise.all([
    itemIds.length
      ? db
          .select({ refId: stockMovements.refId, kind: stockMovements.kind })
          .from(stockMovements)
          .where(and(eq(stockMovements.refType, "return_item"), inArray(stockMovements.refId, itemIds), lt(stockMovements.qtyDelta, 0)))
      : Promise.resolve([]),
    items.length
      ? db
          .select({ id: warranties.id, orderItemId: warranties.orderItemId, serialId: warranties.serialId, endsAt: warranties.endsAt, status: warranties.status })
          .from(warranties)
          .where(inArray(warranties.orderItemId, [...new Set(items.map((item) => item.orderItemId))]))
      : Promise.resolve([]),
    refundRows.length
      ? db
          .select({ refundId: refundItems.refundId, orderItemId: refundItems.orderItemId, qty: refundItems.qty })
          .from(refundItems)
          .where(inArray(refundItems.refundId, refundRows.filter((refund) => !(VOID_REFUND as readonly string[]).includes(refund.status)).map((refund) => refund.id)))
      : Promise.resolve([]),
    unitValuesFor(db, [order]),
    db.select({ after: auditEvents.after }).from(auditEvents).where(and(eq(auditEvents.entityType, "return"), eq(auditEvents.entityId, ret.id), eq(auditEvents.action, "returns.rma.create"))).get(),
    failedRepairs(
      db,
      items.filter((item) => item.inspectedBy && item.restockAction === null).map((item) => item.id),
    ),
    // the restocking fee of a change of mind (12.02): none when the store is at fault
    isFaultReason(ret.reasonCode) ? Promise.resolve([]) : evaluateOrder(db, order, ret.createdAt, locale, { exceptReturnId: ret.id }),
  ]);

  const names = await employeeNames(db, [opener, ret.approvedBy, ...refundRows.flatMap((refund) => [refund.createdBy, refund.approvedBy]), ...items.map((item) => item.inspectedBy), ...audits.map((event) => event.actorId)]);
  // Units refunded through this return, given to the lines whose money may go back first (a kept unit only shows
  // refunded units when nothing else could hold them). held = in a refund not rejected (issued or waiting); paid = issued.
  const paidRefunds = new Set(refundRows.filter((refund) => refund.status === "paid").map((refund) => refund.id));
  const refundedLeft = new Map<string, number>();
  const paidLeft = new Map<string, number>();
  for (const row of refunded) {
    refundedLeft.set(row.orderItemId, (refundedLeft.get(row.orderItemId) ?? 0) + Number(row.qty));
    if (paidRefunds.has(row.refundId)) paidLeft.set(row.orderItemId, (paidLeft.get(row.orderItemId) ?? 0) + Number(row.qty));
  }
  const handed = new Map<string, { refundedQty: number; refundPaidQty: number }>();
  for (const item of [...items.filter((entry) => refundableLine(entry, failed)), ...items.filter((entry) => !refundableLine(entry, failed))]) {
    const left = refundedLeft.get(item.orderItemId) ?? 0;
    const refundedQty = Math.min(left, item.qty);
    refundedLeft.set(item.orderItemId, left - refundedQty);
    const paid = paidLeft.get(item.orderItemId) ?? 0;
    const refundPaidQty = Math.min(paid, refundedQty);
    paidLeft.set(item.orderItemId, paid - refundPaidQty);
    handed.set(item.id, { refundedQty, refundPaidQty });
  }
  const feeBps = new Map(lines.map((line) => [line.orderItemId, line.eligibility.restockingFeeBps]));
  const snapshot = ((created?.after as { eligibility?: unknown[] } | null)?.eligibility ?? []) as { orderItemId: string; eligible: boolean; problems: string[]; windowDays: number; source: string; sealed: boolean | null }[];
  const itemViews: RmaItemView[] = items.map((item) => {
    const { refundedQty, refundPaidQty } = handed.get(item.id) ?? { refundedQty: 0, refundPaidQty: 0 };
    const refundable = refundableLine(item, failed);
    const unitValueIqd = values.get(item.orderItemId) ?? 0;
    const exit = exits.find((row) => row.refId === item.id);
    const warranty = warrantyRows.find((row) => row.orderItemId === item.orderItemId && (item.serialId ? row.serialId === item.serialId : true));
    const verdict = snapshot.find((entry) => entry.orderItemId === item.orderItemId);
    const decision: Decision | null = item.inspectedBy ? ((item.restockAction ?? "keep") as Decision) : null;
    return {
      id: item.id,
      orderItemId: item.orderItemId,
      name: lineName(item.name, locale),
      sku: item.sku,
      qty: item.qty,
      serial: item.serialId ? { id: item.serialId, serial: item.serial ?? "—" } : null,
      unitValueIqd,
      condition: (CONDITION_LIST as readonly string[]).includes(item.condition ?? "") ? (item.condition as Condition) : null,
      decision: decision && (DECISION_LIST as readonly string[]).includes(decision) ? decision : null,
      restockedAt: item.restockedAt,
      inspectedBy: item.inspectedBy ? (names.get(item.inspectedBy) ?? item.inspectedBy) : null,
      notes: item.notes,
      refundedQty,
      refundPaidQty,
      refundable,
      feeIqd: refundable ? restockingFee(unitValueIqd, Math.max(0, item.qty - refundedQty), feeBps.get(item.orderItemId) ?? 0) : 0,
      used: item.usedUnitId !== null,
      quarantineExit: exit ? (exit.kind === "transfer_out" ? "stock" : exit.kind === "damage" ? "scrap" : "supplier") : null,
      eligibility: verdict
        ? {
            eligible: verdict.eligible,
            problems: verdict.problems as Eligibility["problems"],
            windowDays: verdict.windowDays,
            windowEndsAt: order.deliveredAt === null ? null : order.deliveredAt + verdict.windowDays * DAY_MS,
            daysSinceDelivery: order.deliveredAt === null ? null : Math.max(0, Math.floor((ret.createdAt - order.deliveredAt) / DAY_MS)),
            requiresSealed: false,
            restockingFeeBps: 0,
            rule: { id: null, source: verdict.source as Eligibility["rule"]["source"], note: null },
          }
        : null,
      warranty: warranty ? { id: warranty.id, endsAt: warranty.endsAt, state: (warranty.status === "void" ? "void" : warranty.endsAt < now ? "expired" : "active") as WarrantyState } : null,
    };
  });

  const me = actor.kind === "employee" ? actor.id : null;
  const refundViews: RmaRefundView[] = await Promise.all(
    refundRows.map(async (refund) => {
      const payment = paymentRows.find((row) => row.id === refund.paymentId) ?? (await db.select().from(payments).where(eq(payments.id, refund.paymentId)).get());
      const destination = payment ? refundDestination(refund.method, payment.method) : null;
      return {
        id: refund.id,
        amountIqd: refund.amountIqd,
        method: refund.method,
        status: refund.status,
        reason: ownReason(ret.rma, refund.reason),
        reference: refund.reference,
        createdBy: refund.createdBy ? (names.get(refund.createdBy) ?? refund.createdBy) : null,
        createdAt: refund.createdAt,
        approvedBy: refund.approvedBy ? (names.get(refund.approvedBy) ?? refund.approvedBy) : null,
        rejectReason: refund.rejectReason,
        mine: me !== null && refund.createdBy === me,
        needsReference: destination?.needsReference === true && !refund.reference,
      };
    }),
  );
  const paymentsView = await Promise.all(paymentRows.map(async (payment) => ({ id: payment.id, method: payment.method, amountIqd: payment.amountIqd, refundableIqd: await getRefundableAmount(db, payment.id) })));

  // The refund suggestion (and, with the payments' ceiling, the most refund.server accepts): the units that came back and
  // are not refunded yet, minus the policy's restocking fee on a change of mind.
  const refundable = itemViews.filter((item) => item.refundable && item.refundedQty < item.qty);
  const itemsValueIqd = refundable.reduce((sum, item) => sum + item.unitValueIqd * (item.qty - item.refundedQty), 0);
  const feeIqd = refundable.reduce((sum, item) => sum + item.feeIqd, 0);
  const capIqd = paymentsView.reduce((sum, payment) => sum + payment.refundableIqd, 0);
  const refundSuggestion = refundable.length ? { amountIqd: Math.max(0, Math.min(itemsValueIqd - feeIqd, capIqd)), feeIqd, itemsValueIqd, capIqd } : null;

  const dueAt = dueOf(ret, await slaTargets(db));
  const open = (RMA_OPEN_STATUSES as readonly string[]).includes(ret.status);
  const uninspected = itemViews.some((item) => item.decision === null);
  const anyPending = refundViews.some((refund) => refund.status === "pending" || refund.status === "approved");
  const ownRequest = me !== null && opener === me;
  return {
    id: ret.id,
    rma: ret.rma,
    status: ret.status,
    order: { id: order.id, ref: order.ref, status: order.status, deliveredAt: order.deliveredAt, paymentMethod: order.paymentMethod, totalIqd: order.totalIqd, paidIqd: order.paidIqd, refundedIqd: order.refundedIqd },
    customer: { kind: order.customerId ? "customer" : "guest", id: order.customerId, name: order.contactName ?? customer?.name ?? null, profileId: customerProfileId(actor, order.customerId), phone: phoneView(actor, ret.phoneE164 ?? order.contactPhoneE164), hasWallet: order.customerId !== null },
    reasonCode: ret.reasonCode,
    reason: ret.reason,
    requestedResolution: ret.requestedResolution,
    resolution: ret.resolution,
    rejectReason: ret.rejectReason,
    staffNote: ret.staffNote,
    createdAt: ret.createdAt,
    createdBy: opener ? (names.get(opener) ?? opener) : null,
    approvedBy: ret.approvedBy ? (names.get(ret.approvedBy) ?? ret.approvedBy) : null,
    approvedAt: ret.approvedAt,
    receivedAt: ret.receivedAt,
    inspectedAt: ret.inspectedAt,
    closedAt: ret.closedAt,
    dueAt,
    late: dueAt !== null && now > dueAt,
    items: itemViews,
    photos: photoRows.map((photo) => ({ id: photo.id, url: urls.photo(photo.id), width: photo.width, height: photo.height })),
    refunds: refundViews,
    payments: paymentsView,
    refundSuggestion,
    repairs: repairRows.map((row) => ({ id: row.id, ref: row.ref, status: row.status })),
    flags: (signals.get(ret.id) ?? []).filter((signal) => (FRAUD_RULE_IDS as readonly FraudRuleId[]).includes(signal.id)),
    // The core records every refund of this return (orders.refund.*); this module's own refund events mirror them, so
    // the history shows each act once (both stay in the audit log). "RMA-…: " in front of a reason is this page's own.
    timeline: audits.filter((event) => !MIRRORED_REFUND_EVENTS.has(event.action)).map((event) => ({
      id: event.id,
      at: event.at,
      action: event.action,
      actor: { kind: event.actorKind, name: event.actorKind === "employee" && event.actorId ? (names.get(event.actorId) ?? event.actorLabel ?? null) : (event.actorLabel ?? null) },
      reason: ownReason(ret.rma, event.reason),
      summary: null,
      inspection: event.action === "returns.rma.inspect" ? inspectionOf(event.after) : null,
    })),
    quarantineLocations: locations.quarantine,
    sellableLocations: locations.sellable,
    can: {
      decide: can(actor, "returns.rma.approve") && ret.status === "requested" && !ownRequest,
      ownRequest,
      transit: canAny(actor, ["returns.rma.inspect", "returns.rma.create"]) && ret.status === "approved",
      inspect: can(actor, "returns.rma.inspect") && ["approved", "in_transit", "received"].includes(ret.status) && uninspected,
      refund: can(actor, "orders.refund.create") && can(actor, "returns.rma.read") && ["received", "inspected", "refunded"].includes(ret.status) && !ret.closedAt && refundable.length > 0 && capIqd > 0 && !anyPending,
      approveRefund: can(actor, "orders.refund.approve"),
      close: can(actor, "returns.rma.approve") && ["received", "inspected", "refunded", "exchanged", "repaired"].includes(ret.status) && !ret.closedAt && !uninspected && !anyPending,
      cancel: can(actor, "returns.rma.approve") && ["requested", "approved", "in_transit"].includes(ret.status),
      addPhoto: canAny(actor, ["returns.rma.create", "returns.rma.inspect"]) && open,
      note: canAny(actor, ["returns.rma.create", "returns.rma.inspect", "returns.rma.approve"]),
      repair: can(actor, "returns.repair.manage") && ["received", "inspected"].includes(ret.status) && itemViews.some((item) => item.decision === "keep") && repairRows.length === 0,
      // an employee limited to a branch names the location (the default — where the unit left from — may be another branch's)
      restockDefault: !branchLimited(actor),
      print: true,
    },
    isDemo: order.isDemo,
  };
}
