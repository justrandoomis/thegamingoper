/**
 * pos — registers, cash shifts and drawer movements (admin module 06).
 *
 * A POS sale is an ordinary order (`orders.channel = 'pos'`) with `pos_shift_id` set; stock is the
 * same stock as the web store. Offline sales are replayed with their original `idempotency_key`,
 * so syncing twice cannot create a second order.
 *
 * `cash_movements` is [A] append-only. Expected cash of a shift =
 *   opening_float_iqd + Σ cash_movements.amount_iqd.
 */
import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTOR_KINDS, at, flag, id, iqd, json, type Ref } from "../columns";
import { orders, payments } from "./commerce";
import { inventoryLocations } from "./inventory";
import { branches } from "./ops";

export const posRegisters = sqliteTable(
  "pos_registers",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    branchId: text("branch_id").references((): Ref => branches.id),
    /** Stock location sales from this register are taken from. */
    locationId: text("location_id").references((): Ref => inventoryLocations.id),
    isActive: flag("is_active").notNull().default(true),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("pos_registers_code_uq").on(t.code),
    index("pos_registers_branch_idx").on(t.branchId),
    index("pos_registers_location_idx").on(t.locationId),
  ],
);
export type PosRegister = typeof posRegisters.$inferSelect;
export type NewPosRegister = typeof posRegisters.$inferInsert;

export const POS_SHIFT_STATUSES = ["open", "closed"] as const;
export type PosShiftStatus = (typeof POS_SHIFT_STATUSES)[number];

/**
 * A cashier's drawer session (06.02). At close: variance_iqd = counted_cash_iqd − expected_cash_iqd;
 * a non-zero variance needs a reason. Only one shift can be open per register (UNIQUE partial index).
 */
export const posShifts = sqliteTable(
  "pos_shifts",
  {
    id: id(),
    registerId: text("register_id")
      .notNull()
      .references((): Ref => posRegisters.id),
    openedBy: text("opened_by").notNull(),
    openedAt: at("opened_at").notNull(),
    openingFloatIqd: iqd("opening_float_iqd").notNull().default(0),
    closedBy: text("closed_by"),
    closedAt: at("closed_at"),
    countedCashIqd: iqd("counted_cash_iqd"),
    expectedCashIqd: iqd("expected_cash_iqd"),
    varianceIqd: iqd("variance_iqd"),
    status: text("status", { enum: POS_SHIFT_STATUSES }).notNull().default("open"),
    varianceReason: text("variance_reason"),
    /** Count by denomination at close, e.g. `{ "25000": 4, "10000": 7 }`. */
    denominations: json<Record<string, number>>("denominations"),
    notes: text("notes"),
    approvedBy: text("approved_by"),
  },
  (t) => [
    uniqueIndex("pos_shifts_open_register_uq").on(t.registerId).where(sql`${t.status} = 'open'`),
    index("pos_shifts_register_idx").on(t.registerId, t.openedAt),
    index("pos_shifts_opened_by_idx").on(t.openedBy, t.openedAt),
    check("pos_shifts_float_check", sql`${t.openingFloatIqd} >= 0`),
  ],
);
export type PosShift = typeof posShifts.$inferSelect;
export type NewPosShift = typeof posShifts.$inferInsert;

export const CASH_MOVEMENT_KINDS = ["sale", "refund", "pay_in", "pay_out", "drop", "adjustment"] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

/** [A] Cash entering (+) or leaving (−) the drawer during a shift. */
export const cashMovements = sqliteTable(
  "cash_movements",
  {
    id: id(),
    shiftId: text("shift_id")
      .notNull()
      .references((): Ref => posShifts.id),
    kind: text("kind", { enum: CASH_MOVEMENT_KINDS }).notNull(),
    amountIqd: iqd("amount_iqd").notNull(),
    orderId: text("order_id").references((): Ref => orders.id),
    paymentId: text("payment_id").references((): Ref => payments.id),
    reason: text("reason"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    /** Offline-safe: replaying the same movement is rejected by the UNIQUE index. */
    idempotencyKey: text("idempotency_key"),
    at: at("at").notNull(),
  },
  (t) => [
    uniqueIndex("cash_movements_idempotency_key_uq").on(t.idempotencyKey),
    index("cash_movements_shift_idx").on(t.shiftId, t.at),
    index("cash_movements_order_idx").on(t.orderId),
    index("cash_movements_payment_idx").on(t.paymentId),
    check("cash_movements_amount_check", sql`${t.amountIqd} <> 0`),
  ],
);
export type CashMovement = typeof cashMovements.$inferSelect;
export type NewCashMovement = typeof cashMovements.$inferInsert;
