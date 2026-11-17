/**
 * Admin 06 — a CASH REFUND PAID AT THE TILL (2026-11-13): cash a till sale took, given back in cash out of an open
 * drawer — so the drawer's expected cash, its blind count and the shift report know the money left it.
 *
 *   const view = await tillRefundView(db, actor, "TT-8K2M4Q", locale);                                   // the receipt page
 *   await requestTillRefund(db, actor, { ref, shiftId, paymentId, amountIqd, reason, idempotencyKey }, now);
 *   await decideTillRefund(db, otherActor, { ref, refundId, approve: true, note }, now);                   // a second person
 *   await payTillRefundFromDrawer(db, actor, { ref, refundId }, now);                                     // approved elsewhere
 *
 * THE MONEY RULES ARE THE COMMERCE CORE'S (refunds.server.ts — nothing here re-implements or loosens them): createRefund
 * (orders.refund.create; never more than the payment has left; issued at once only up to the owner's threshold — by
 * default EVERY refund waits for a second person), approveRefund (orders.refund.approve, never the one who asked), the
 * database's bounds, the books (Dr sales refunds / Cr cash), the points and the digital codes given back or revoked.
 * This file adds one thing to the batch that ISSUES the money: the drawer — a `cash_movements` row kind "refund"
 * (−amount, the sale and its payment; key "refund:<refund id>:drawer", unique: one drawer per refund, never twice),
 * guarded on that shift still being open, and an audit event `pos.cash.refund`. It rides inside the core's own batch
 * the way module 12 adds its guards to createRefund (returns/refund.server.ts withBatchGuards): all or nothing — never
 * a refund issued without its drawer row, never a drawer row without the refund.
 *
 * ONLY CASH: a till refund gives back what a CASH payment of a till sale took (pos_cash), in cash — a card or wallet
 * payment goes back its own way through orders 05 (cash for a wallet payment would turn store credit into cash).
 *
 * WHO
 *   · asks: pos.sale.refund + orders.refund.create, paying from their OWN open drawer — or, with pos.shift.review, an
 *     open drawer at their branch (a supervisor paying from a cashier's drawer). The drawer is named in the refund's
 *     key ("till:<shift>:<form key>"), so whoever approves later knows where the cash leaves from;
 *   · approves at the till: orders.refund.approve — never the one who asked (the core) — and the drawer's owner or a
 *     supervisor (pos.shift.review); the drawer must still be open;
 *   · approved elsewhere (orders 05, returns 12) no drawer moved: the receipt says so, and "pay it from the drawer"
 *     records the drawer row afterwards (pos.cash.move; the drawer named at the request, still open; its owner or a
 *     supervisor; once).
 * The amounts reach the drawer's owner as they paid them (a refund is a move they made, like a pay-out) — never the
 * drawer's expected total (blind count).
 *
 * Errors: forbidden (403), not_found (404), invalid (400), till_refund_drawer (409 — no open drawer of yours, or it
 * closed meanwhile), till_refund_not_cash (409), till_refund_paid (409 — paid from a drawer already),
 * till_refund_not_till (409 — not asked at a till), plus the core's (refund_exceeds_payment, payment_not_paid,
 * approver_is_requester, refund_not_pending, period_closed…).
 */
import { and, desc, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { actorRef, assertBranch, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { cashMovements, orders, payments, posRegisters, posShifts, refunds } from "~/server/db/schema";
import { batchSql, expectThat, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, notFound, toAppError } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { cleanLine } from "~/server/text.server";
import { approveRefund, createRefund, getRefundableAmount } from "../../refunds.server";
import { employeeNames, ID_PATTERN, KEY_PATTERN } from "./shared.server";

export const TILL_REFUND_ERROR_KEYS = ["till_refund_drawer", "till_refund_not_cash", "till_refund_paid", "till_refund_not_till"] as const;

const REF = /^[A-Z]{2,4}-[A-Z0-9]{4,16}$/;
/** A till refund's key names its drawer: "till:<shift id>:<form key>". */
const TILL_KEY_PREFIX = "till:";
export const tillRefundKey = (shiftId: string, formKey: string) => `${TILL_KEY_PREFIX}${shiftId}:${formKey}`;
/** The drawer a till refund was asked at, from its key (null: not asked at a till). */
export function drawerOfRefundKey(key: string | null | undefined): string | null {
  if (!key || !key.startsWith(TILL_KEY_PREFIX)) return null;
  const rest = key.slice(TILL_KEY_PREFIX.length);
  const shiftId = rest.slice(0, rest.indexOf(":"));
  return ID_PATTERN.test(shiftId) ? shiftId : null;
}
/** The drawer row of a refund (unique: one per refund). */
export const refundDrawerKey = (refundId: string) => `refund:${refundId}:drawer`;

/**
 * `db` for a core call whose write batch must carry this module's statements: every `batch` it runs gets `extra` at its
 * end — the same transaction, all or nothing (module 12's withBatchGuards). Reads go to `db` unchanged.
 */
function withStatements(db: Db, extra: readonly BatchStatement[]): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") return (statements: readonly BatchStatement[]) => target.batch([...statements, ...extra] as unknown as Parameters<Db["batch"]>[0]);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

type TillSale = { id: string; ref: string; branchId: string | null; isDemo: boolean; status: string };

/** A sale of the till by its reference, at the employee's branch (not_found for a web order or another branch's sale). */
async function tillSale(db: Db, actor: Actor, ref: string): Promise<TillSale> {
  const clean = typeof ref === "string" ? ref.trim().toUpperCase() : "";
  if (!REF.test(clean)) throw notFound("receipt");
  const row = await db.select({ id: orders.id, ref: orders.ref, branchId: orders.branchId, isDemo: orders.isDemo, status: orders.status }).from(orders).where(and(eq(orders.ref, clean), eq(orders.channel, "pos"))).get();
  if (!row) throw notFound("receipt");
  assertBranch(actor, row.branchId);
  return row;
}

type Drawer = { id: string; openedBy: string; registerCode: string; branchId: string | null; open: boolean };

async function drawerById(db: Db, shiftId: string): Promise<Drawer | null> {
  if (!ID_PATTERN.test(shiftId)) return null;
  const row = await db
    .select({ id: posShifts.id, openedBy: posShifts.openedBy, status: posShifts.status, code: posRegisters.code, branchId: posRegisters.branchId })
    .from(posShifts)
    .innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId))
    .where(eq(posShifts.id, shiftId))
    .get();
  return row ? { id: row.id, openedBy: row.openedBy, registerCode: row.code, branchId: row.branchId, open: row.status === "open" } : null;
}

/** May this employee move cash in this drawer: its owner, or a supervisor (pos.shift.review) at its branch. */
function mayUseDrawer(actor: Actor, drawer: Drawer): boolean {
  if (actor.kind !== "employee") return false;
  if (drawer.openedBy === actor.id) return true;
  if (!can(actor, "pos.shift.review")) return false;
  return actor.branchId == null || actor.branchId === drawer.branchId;
}

/** The drawer row of a refund being issued now, and its audit event — appended to the core's issuing batch. */
function drawerStatements(db: Db, actor: Actor, input: { shiftId: string; registerCode: string; sale: TillSale; refund: { id: string; amountIqd: number; paymentId: string } | { key: string; amountIqd: number; paymentId: string }; now: number; late?: boolean }): BatchStatement[] {
  const { actorKind, actorId } = actorRef(actor);
  const movementId = newId("cmv");
  const statements: BatchStatement[] = [expectThat(db, sql`EXISTS (SELECT 1 FROM pos_shifts WHERE id = ${input.shiftId} AND status = 'open')`, { code: "TILL_DRAWER_CLOSED", detail: input.shiftId })];
  if ("id" in input.refund) {
    statements.push(
      db.insert(cashMovements).values({ id: movementId, shiftId: input.shiftId, kind: "refund", amountIqd: -input.refund.amountIqd, orderId: input.sale.id, paymentId: input.refund.paymentId, reason: sql`(SELECT reason FROM refunds WHERE id = ${input.refund.id})`, actorKind, actorId, idempotencyKey: refundDrawerKey(input.refund.id), at: input.now }),
    );
  } else {
    // the refund is inserted by the core in this same batch: its id is read there, by the key this module gave it
    statements.push(
      batchSql(
        db,
        sql`INSERT INTO cash_movements (id, shift_id, kind, amount_iqd, order_id, payment_id, reason, actor_kind, actor_id, idempotency_key, at)
          SELECT ${movementId}, ${input.shiftId}, 'refund', -r.amount_iqd, r.order_id, r.payment_id, r.reason, ${actorKind}, ${actorId}, 'refund:' || r.id || ':drawer', ${input.now}
          FROM refunds AS r WHERE r.idempotency_key = ${input.refund.key} AND r.status = 'paid'`,
      ),
      // exactly one drawer row for that refund now (the prediction "issued at once" held — else the whole batch goes)
      expectThat(db, sql`(SELECT count(*) FROM cash_movements WHERE id = ${movementId}) = 1`, { code: "TILL_REFUND_RETRY", detail: input.refund.key }),
    );
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: "pos.cash.refund",
      entityType: "pos_shift",
      entityId: input.shiftId,
      summary: `${input.registerCode}: cash refund ${input.refund.amountIqd} IQD for ${input.sale.ref}`,
      after: { kind: "refund", amountIqd: -input.refund.amountIqd, orderRef: input.sale.ref, paymentId: input.refund.paymentId, ...("id" in input.refund ? { refundId: input.refund.id } : { refundKey: input.refund.key }), late: input.late ?? false },
      at: input.now,
    }),
  );
  return statements;
}

function drawerFailure(error: unknown): never {
  const code = mapDbError(error)?.code ?? toAppError(error)?.code?.toUpperCase();
  if (code === "TILL_DRAWER_CLOSED") throw new AppError("till_refund_drawer", 409, { fields: { shiftId: "till_refund_drawer" }, cause: error });
  throw error;
}

// ───────────────────────────────────────────────────────────────── ask

export const TillRefundInput = z.object({
  ref: z.string({ error: "required" }).trim().min(1, "required").max(32, "invalid"),
  shiftId: z.string({ error: "required" }).regex(ID_PATTERN, "invalid"),
  paymentId: z.string({ error: "required" }).regex(ID_PATTERN, "invalid"),
  amountIqd: z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(1, "too_small").max(10_000_000_000, "too_big"),
  reason: z.string({ error: "reason_required" }).overwrite(cleanLine).trim().min(3, "reason_required").max(300, "too_long"),
  idempotencyKey: z.string({ error: "invalid" }).regex(KEY_PATTERN, "invalid"),
});
export type TillRefundInput = z.input<typeof TillRefundInput>;

/**
 * Asks for a cash refund of a till sale's cash payment, paid from a drawer (file header). Issued at once (and out of
 * the drawer, in the same batch) when the owner's threshold allows; otherwise it waits for a second person and the
 * drawer is named for when it is approved. A repeat of the same form answers the first refund.
 */
export async function requestTillRefund(db: Db, actor: Actor, raw: TillRefundInput, now: number): Promise<{ refundId: string; status: "paid" | "pending"; replayed: boolean }> {
  assertCan(actor, "pos.sale.refund");
  assertCan(actor, "orders.refund.create");
  const input = TillRefundInput.parse(raw);
  const sale = await tillSale(db, actor, input.ref);
  const key = tillRefundKey(input.shiftId, input.idempotencyKey);
  const core = { orderId: sale.id, paymentId: input.paymentId, amountIqd: input.amountIqd, method: "cash" as const, reason: input.reason, idempotencyKey: key };
  // a repeat of a form already recorded answers that refund (the core checks it is the same one), whatever the drawer is now
  if (await db.select({ id: refunds.id }).from(refunds).where(eq(refunds.idempotencyKey, key)).get()) return createRefund(db, actor, core, now);
  const drawer = await drawerById(db, input.shiftId);
  if (!drawer || !drawer.open || !mayUseDrawer(actor, drawer)) throw new AppError("till_refund_drawer", 409, { fields: { shiftId: "till_refund_drawer" } });
  const payment = await db.select({ id: payments.id, orderId: payments.orderId, method: payments.method, status: payments.status }).from(payments).where(eq(payments.id, input.paymentId)).get();
  if (!payment || payment.orderId !== sale.id) throw notFound("payment");
  if (payment.method !== "pos_cash") throw new AppError("till_refund_not_cash", 409, { fields: { paymentId: "till_refund_not_cash" } });

  for (let attempt = 1; ; attempt++) {
    // The core issues at once up to the owner's threshold (refunds.approval_threshold_iqd); the drawer row goes with it.
    // Waiting: nothing leaves the drawer yet. A changed threshold between this read and the core's is caught in the
    // batch (TILL_REFUND_RETRY) and decided again.
    const immediate = input.amountIqd <= (await getSetting(db, "refunds.approval_threshold_iqd"));
    const extra = immediate
      ? drawerStatements(db, actor, { shiftId: drawer.id, registerCode: drawer.registerCode, sale, refund: { key, amountIqd: input.amountIqd, paymentId: payment.id }, now })
      : [expectThat(db, sql`EXISTS (SELECT 1 FROM refunds WHERE idempotency_key = ${key} AND status = 'pending')`, { code: "TILL_REFUND_RETRY", detail: key })];
    try {
      return await createRefund(withStatements(db, extra), actor, core, now);
    } catch (error) {
      const code = mapDbError(error)?.code ?? toAppError(error)?.code?.toUpperCase();
      if (code === "TILL_REFUND_RETRY" && attempt < 2) continue;
      drawerFailure(error);
    }
  }
}

// ───────────────────────────────────────────────────────────────── decide at the till

/**
 * A till decision as the form sends it: "approve" → true, "reject" → false, anything else null (refused as invalid —
 * a missing or garbled field must never become a rejection, review 2026-11-17).
 */
export function tillDecisionOf(value: unknown): boolean | null {
  return value === "approve" ? true : value === "reject" ? false : null;
}

export const TillRefundDecision = z.object({
  ref: z.string().trim().max(32, "invalid"),
  refundId: z.string().regex(ID_PATTERN, "invalid"),
  approve: z.boolean(),
  note: z.string().overwrite(cleanLine).trim().max(500, "too_long").optional(),
});

/**
 * The second person's decision on a till refund that waits (orders.refund.approve, never the one who asked — the core).
 * Approving pays it from the drawer named when it was asked, in the core's issuing batch (the drawer must be open; its
 * owner or a supervisor decides); rejecting moves nothing. Repeating the same decision answers it again.
 */
export async function decideTillRefund(db: Db, actor: Actor, raw: z.input<typeof TillRefundDecision>, now: number): Promise<{ status: "paid" | "rejected"; fromDrawer: boolean }> {
  assertCan(actor, "orders.refund.approve");
  const input = TillRefundDecision.parse(raw);
  const sale = await tillSale(db, actor, input.ref);
  const refund = await db.select().from(refunds).where(and(eq(refunds.id, input.refundId), eq(refunds.orderId, sale.id))).get();
  if (!refund) throw notFound("refund");
  const drawerId = drawerOfRefundKey(refund.idempotencyKey);
  if (!drawerId) throw new AppError("till_refund_not_till", 409);
  if (!input.approve) {
    const result = await approveRefund(db, actor, refund.id, { approve: false, note: input.note ?? null }, now);
    return { status: result.status === "paid" ? "paid" : "rejected", fromDrawer: false };
  }
  const drawer = await drawerById(db, drawerId);
  if (refund.status === "pending") {
    if (!drawer || !drawer.open) throw new AppError("till_refund_drawer", 409, { fields: { shiftId: "till_refund_drawer" } });
    if (!mayUseDrawer(actor, drawer)) throw forbidden("pos.shift.review");
  }
  const extra = drawer ? drawerStatements(db, actor, { shiftId: drawer.id, registerCode: drawer.registerCode, sale, refund: { id: refund.id, amountIqd: refund.amountIqd, paymentId: refund.paymentId }, now }) : [];
  try {
    await approveRefund(withStatements(db, extra), actor, refund.id, { approve: true, note: input.note ?? null }, now);
  } catch (error) {
    drawerFailure(error);
  }
  const moved = await db.select({ id: cashMovements.id }).from(cashMovements).where(eq(cashMovements.idempotencyKey, refundDrawerKey(refund.id))).get();
  return { status: "paid", fromDrawer: Boolean(moved) };
}

// ───────────────────────────────────────────────────────────────── approved elsewhere: the drawer afterwards

/**
 * A till refund approved outside the till (orders 05, returns 12) moved no drawer: the cash handed over from the drawer
 * it was asked at is recorded now (pos.cash.move; that drawer still open; its owner or a supervisor; once — the
 * drawer row's key is unique).
 */
export async function payTillRefundFromDrawer(db: Db, actor: Actor, input: { ref: string; refundId: string }, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "pos.cash.move");
  const sale = await tillSale(db, actor, input.ref);
  if (typeof input.refundId !== "string" || !ID_PATTERN.test(input.refundId)) throw notFound("refund");
  const refund = await db.select().from(refunds).where(and(eq(refunds.id, input.refundId), eq(refunds.orderId, sale.id))).get();
  if (!refund) throw notFound("refund");
  const drawerId = drawerOfRefundKey(refund.idempotencyKey);
  if (!drawerId) throw new AppError("till_refund_not_till", 409);
  if (refund.status !== "paid" || refund.method !== "cash") throw new AppError("refund_not_pending", 409, { detail: refund.status });
  const earlier = await db.select({ id: cashMovements.id, shiftId: cashMovements.shiftId }).from(cashMovements).where(eq(cashMovements.idempotencyKey, refundDrawerKey(refund.id))).get();
  if (earlier) return { replayed: true };
  const drawer = await drawerById(db, drawerId);
  if (!drawer || !drawer.open) throw new AppError("till_refund_drawer", 409, { fields: { shiftId: "till_refund_drawer" } });
  if (!mayUseDrawer(actor, drawer)) throw forbidden("pos.shift.review");
  try {
    await runBatch(db, drawerStatements(db, actor, { shiftId: drawer.id, registerCode: drawer.registerCode, sale, refund: { id: refund.id, amountIqd: refund.amountIqd, paymentId: refund.paymentId }, now, late: true }));
  } catch (error) {
    if (isUniqueViolation(error, "cash_movements.idempotency_key")) return { replayed: true };
    drawerFailure(error);
  }
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── the receipt page's panel

export type TillRefundRow = {
  id: string;
  amountIqd: number;
  method: string;
  status: string;
  reason: string | null;
  createdAt: number;
  requestedBy: string | null;
  /** This employee asked for it (someone else decides). */
  mine: boolean;
  /** The drawer it was asked at (null: asked outside the till). */
  drawer: { shiftId: string; register: string; open: boolean } | null;
  /** The cash left a drawer for it (a `refund` drawer row exists). */
  fromDrawer: boolean;
};

export type TillRefundView = {
  /** The sale's cash payments and what each still has to refund (only cash goes back at the till). */
  cash: { paymentId: string; amountIqd: number; refundableIqd: number }[];
  /** Other payments (card, wallet): they go back their own way, through orders. */
  otherMethods: string[];
  refunds: TillRefundRow[];
  /** This employee's own open drawer (where a refund they ask for is paid from). */
  myDrawer: { shiftId: string; register: string } | null;
  canAsk: boolean;
  /** Why not, when they could otherwise: no open drawer of their own, or a right missing (named). */
  askBlocked: "no_drawer" | "no_right" | null;
  canApprove: boolean;
  /** Refunds up to this amount are paid at once; above it they wait for a second person (0: every refund waits). */
  thresholdIqd: number;
};

/** What the receipt page's refund panel shows and offers (null for an employee with no refund or drawer right at all). */
export async function tillRefundView(db: Db, actor: Actor, ref: string, _locale: Locale): Promise<TillRefundView | null> {
  if (!can(actor, "pos.sale.refund") && !can(actor, "orders.refund.approve") && !can(actor, "pos.cash.move")) return null;
  const sale = await tillSale(db, actor, ref);
  const [paid, rows, mine, thresholdIqd] = await Promise.all([
    db.select({ id: payments.id, method: payments.method, amountIqd: payments.amountIqd }).from(payments).where(and(eq(payments.orderId, sale.id), eq(payments.status, "paid"))),
    db.select().from(refunds).where(and(eq(refunds.orderId, sale.id), notInArray(refunds.status, ["cancelled"]))).orderBy(desc(refunds.createdAt), desc(refunds.id)).limit(20),
    actor.kind === "employee"
      ? db.select({ id: posShifts.id, code: posRegisters.code }).from(posShifts).innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId)).where(and(eq(posShifts.openedBy, actor.id), eq(posShifts.status, "open"))).limit(1).get()
      : Promise.resolve(undefined),
    getSetting(db, "refunds.approval_threshold_iqd"),
  ]);
  const cashPayments = paid.filter((payment) => payment.method === "pos_cash");
  const refundable = await Promise.all(cashPayments.map((payment) => getRefundableAmount(db, payment.id)));
  const drawerIds = [...new Set(rows.map((row) => drawerOfRefundKey(row.idempotencyKey)).filter((id): id is string => Boolean(id)))];
  const [drawers, moved, names] = await Promise.all([
    drawerIds.length
      ? db.select({ id: posShifts.id, status: posShifts.status, code: posRegisters.code }).from(posShifts).innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId)).where(inArray(posShifts.id, drawerIds))
      : Promise.resolve([]),
    rows.length ? db.select({ key: cashMovements.idempotencyKey }).from(cashMovements).where(and(eq(cashMovements.orderId, sale.id), eq(cashMovements.kind, "refund"), like(cashMovements.idempotencyKey, "refund:%"))) : Promise.resolve([]),
    employeeNames(db, rows.map((row) => row.createdBy)),
  ]);
  const movedKeys = new Set(moved.map((row) => row.key));
  const rights = can(actor, "pos.sale.refund") && can(actor, "orders.refund.create");
  return {
    cash: cashPayments.map((payment, index) => ({ paymentId: payment.id, amountIqd: payment.amountIqd, refundableIqd: refundable[index] ?? 0 })),
    otherMethods: [...new Set(paid.filter((payment) => payment.method !== "pos_cash").map((payment) => payment.method))],
    refunds: rows.map((row) => {
      const drawerId = drawerOfRefundKey(row.idempotencyKey);
      const drawer = drawerId ? drawers.find((entry) => entry.id === drawerId) : undefined;
      return {
        id: row.id,
        amountIqd: row.amountIqd,
        method: row.method,
        status: row.status,
        reason: row.reason,
        createdAt: row.createdAt,
        requestedBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
        mine: actor.kind === "employee" && row.createdBy === actor.id,
        drawer: drawerId ? { shiftId: drawerId, register: drawer?.code ?? "—", open: drawer?.status === "open" } : null,
        fromDrawer: movedKeys.has(refundDrawerKey(row.id)),
      };
    }),
    myDrawer: mine ? { shiftId: mine.id, register: mine.code } : null,
    canAsk: rights && Boolean(mine) && cashPayments.length > 0,
    askBlocked: !rights ? (can(actor, "pos.sale.refund") || can(actor, "orders.refund.create") ? "no_right" : null) : !mine ? "no_drawer" : null,
    canApprove: can(actor, "orders.refund.approve"),
    thresholdIqd: Number(thresholdIqd),
  };
}
