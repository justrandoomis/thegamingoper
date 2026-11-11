/**
 * commerce — carts, orders, payments, payment proofs, refunds, coupons, the customer wallet,
 * gift cards, loyalty points and invoices (admin modules 05, 08, 10 and the storefront checkout).
 *
 * Invariants enforced in the database (triggers in drizzle/0001_invariants.sql, plus the UNIQUE
 * and CHECK constraints below):
 *   orders.idempotency_key, payments.idempotency_key, wallet_ledger.idempotency_key   UNIQUE — a retry cannot create a second row
 *   order_item_serials    a serial is attached to at most one order item at a time (UNIQUE while released_at IS NULL)
 *   payments              bank_transfer / zaincash can only be 'paid' with verified_by + verified_at → TT:PAYMENT_NOT_VERIFIED:<payment_id>
 *   refunds               must point at a payment of the same order → TT:REFUND_PAYMENT_MISMATCH:<refund_id>
 *                         Σ refunds (not rejected/cancelled) ≤ paid amount of that payment → TT:REFUND_EXCEEDS_PAYMENT:<payment_id>
 *   refund_items          Σ qty (not rejected/cancelled refunds) ≤ order_items.qty → TT:REFUND_QTY_EXCEEDS:<order_item_id>
 *   order_items           refunded_qty ≤ qty → TT:REFUND_QTY_EXCEEDS:<order_item_id>
 *   orders                refunded_iqd ≤ paid_iqd → TT:ORDER_REFUND_EXCEEDS_PAID:<order_id>
 *   wallet_ledger         [A]; a debit that would overdraw is rejected → TT:WALLET_OVERDRAFT:<customer_id>
 *   loyalty_ledger        [A]; a redemption that would overdraw is rejected → TT:LOYALTY_OVERDRAFT:<customer_id>
 *   order_events          [A]
 *
 * Money: integer IQD everywhere. An order's totals always satisfy
 *   total_iqd = subtotal_iqd − discount_iqd + shipping_iqd + tax_iqd        (CHECK)
 * and each line satisfies  total_iqd = unit_price_iqd × qty − discount_iqd  (CHECK).
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { OrderStatus as OrderStatusDto, PaymentMethod as PaymentMethodDto, PaymentStatus as PaymentStatusDto } from "~/lib/dto";
import type { Locale } from "~/lib/locales";
import { ACTOR_KINDS, NOW_MS, at, flag, id, iqd, json, l10n, type Ref, type Same, type Subset } from "../columns";
import { returns } from "./aftersales";
import { variants } from "./catalog";
import { files } from "./core";
import { customers, guestContacts } from "./customers";
import { serials } from "./inventory";
import { branches } from "./ops";
import { posRegisters, posShifts } from "./pos";
import { districts, governorates } from "./shipping";
import { usedUnits } from "./used";

// ───────────────────────────────────────────────────────────────── carts

export const carts = sqliteTable(
  "carts",
  {
    id: id(),
    /** sha256 of the cart token kept in the httpOnly `tt_cart` cookie. */
    tokenHash: text("token_hash").notNull(),
    customerId: text("customer_id").references((): Ref => customers.id),
    couponCode: text("coupon_code"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
    locale: text("locale").$type<Locale>(),
    /** Set when the cart became an order; a converted cart is not reused. */
    convertedOrderId: text("converted_order_id"),
  },
  (t) => [
    uniqueIndex("carts_token_hash_uq").on(t.tokenHash),
    index("carts_customer_idx").on(t.customerId),
    index("carts_updated_at_idx").on(t.updatedAt),
  ],
);
export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;

/**
 * A line is either `qty` of a variant, or exactly one specific used unit (`used_unit_id`, qty 1).
 * A cart holds a variant once and a used unit once (two partial UNIQUE indexes). "Add to cart" is
 * an upsert that must name the partial index:
 *
 *   db.insert(cartItems).values({ id, cartId, variantId, qty, addedAt })
 *     .onConflictDoUpdate({
 *       target: [cartItems.cartId, cartItems.variantId],
 *       targetWhere: sql`${cartItems.usedUnitId} IS NULL`,
 *       set: { qty: sql`${cartItems.qty} + excluded.qty` },
 *     })
 */
export const cartItems = sqliteTable(
  "cart_items",
  {
    id: id(),
    cartId: text("cart_id")
      .notNull()
      .references((): Ref => carts.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    usedUnitId: text("used_unit_id").references((): Ref => usedUnits.id),
    qty: integer("qty").notNull().default(1),
    addedAt: at("added_at").notNull(),
    /** Unit price when added — lets the cart say "the price changed". */
    priceSnapshotIqd: iqd("price_snapshot_iqd"),
  },
  (t) => [
    uniqueIndex("cart_items_cart_variant_uq").on(t.cartId, t.variantId).where(sql`${t.usedUnitId} IS NULL`),
    uniqueIndex("cart_items_cart_used_unit_uq").on(t.cartId, t.usedUnitId).where(sql`${t.usedUnitId} IS NOT NULL`),
    index("cart_items_variant_idx").on(t.variantId),
    index("cart_items_used_unit_idx").on(t.usedUnitId),
    check("cart_items_qty_check", sql`${t.qty} > 0 AND (${t.usedUnitId} IS NULL OR ${t.qty} = 1)`),
  ],
);
export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── orders

export const ORDER_CHANNELS = ["web", "pos"] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];
export const ORDER_STATUSES = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped", "delivered", "cancelled", "returned"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** Payment state of the order as a whole (`orders.payment_status`). */
export const ORDER_PAYMENT_STATUSES = ["unpaid", "cod_due", "pending_verification", "paid", "rejected", "partially_refunded", "refunded"] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];
export const PAYMENT_METHODS = ["cod", "wallet", "bank_transfer", "zaincash", "pos_cash", "pos_card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** Human review state for suspicious or late orders (05.09). */
export const ORDER_REVIEW_STATUSES = ["none", "needs_review", "cleared", "blocked"] as const;
export type OrderReviewStatus = (typeof ORDER_REVIEW_STATUSES)[number];

/** Where an order came from, captured at checkout (16.04). */
export type OrderAttribution = { source?: string; medium?: string; campaign?: string; content?: string; term?: string; referrer?: string; landing?: string };

export const orders = sqliteTable(
  "orders",
  {
    id: id(),
    /** Human reference, publicRef("TT") → "TT-7K4M2Q9X". */
    ref: text("ref").notNull(),
    /** Client-generated; a retry with the same key returns the first order. */
    idempotencyKey: text("idempotency_key").notNull(),
    channel: text("channel", { enum: ORDER_CHANNELS }).notNull().default("web"),
    customerId: text("customer_id").references((): Ref => customers.id),
    guestContactId: text("guest_contact_id").references((): Ref => guestContacts.id),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("new"),
    paymentStatus: text("payment_status", { enum: ORDER_PAYMENT_STATUSES }).notNull().default("unpaid"),
    /** Method chosen at checkout; split POS payments are in `payments`. */
    paymentMethod: text("payment_method", { enum: PAYMENT_METHODS }),
    subtotalIqd: iqd("subtotal_iqd").notNull(),
    discountIqd: iqd("discount_iqd").notNull().default(0),
    shippingIqd: iqd("shipping_iqd").notNull().default(0),
    totalIqd: iqd("total_iqd").notNull(),
    /** Verified money received so far (mirror of `payments`). */
    paidIqd: iqd("paid_iqd").notNull().default(0),
    /** Money returned so far (mirror of `refunds`). */
    refundedIqd: iqd("refunded_iqd").notNull().default(0),
    couponId: text("coupon_id").references((): Ref => coupons.id),
    contactName: text("contact_name"),
    contactPhoneE164: text("contact_phone_e164"),
    governorateId: text("governorate_id").references((): Ref => governorates.id),
    districtId: text("district_id").references((): Ref => districts.id),
    areaText: text("area_text"),
    addressText: text("address_text"),
    /** The shopper's note to the store / courier. */
    notes: text("notes"),
    /** Requested delivery day "YYYY-MM-DD" — a preference, never a promise. */
    preferredDay: text("preferred_day"),
    /** Requested time window, e.g. "morning" | "afternoon" | "evening". */
    preferredWindow: text("preferred_window"),
    /** Answer to the (never pre-checked) marketing question at checkout; the legal record is in `consents`. */
    marketingConsent: flag("marketing_consent").notNull().default(false),
    locale: text("locale").$type<Locale>().notNull().default("ar"),
    /** sha256 of the guest access token in the confirmation link. */
    accessTokenHash: text("access_token_hash"),
    /** Placed while STORE_MODE=demo, or seeded. Excluded from real metrics. */
    isDemo: flag("is_demo").notNull().default(false),
    /** Codes raised by risk checks, e.g. ["high_value_cod", "phone_many_cancellations"]. */
    riskFlags: json<string[]>("risk_flags"),
    placedAt: at("placed_at").notNull(),
    confirmedAt: at("confirmed_at"),
    cancelledAt: at("cancelled_at"),
    cancelReason: text("cancel_reason"),
    /** Tax added on top of the prices; 0 while no tax is configured or prices are tax-inclusive. */
    taxIqd: iqd("tax_iqd").notNull().default(0),
    /** Coupon code as typed, kept even if the coupon is later renamed. */
    couponCode: text("coupon_code"),
    reviewStatus: text("review_status", { enum: ORDER_REVIEW_STATUSES }).notNull().default("none"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: at("reviewed_at"),
    /** Staff-only notes. */
    internalNotes: text("internal_notes"),
    /** Employee preparing the order (05.03). */
    assignedTo: text("assigned_to"),
    /** Deadline for uploading a transfer proof before the reservation is released. */
    paymentDueAt: at("payment_due_at"),
    /** Guest phone was verified by OTP (order lookup / account linking). */
    phoneVerifiedAt: at("phone_verified_at"),
    /** Pre-orders (05.07). */
    isPreorder: flag("is_preorder").notNull().default(false),
    expectedAt: at("expected_at"),
    shippedAt: at("shipped_at"),
    deliveredAt: at("delivered_at"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
    /** POS context (06.x). */
    branchId: text("branch_id").references((): Ref => branches.id),
    registerId: text("register_id").references((): Ref => posRegisters.id),
    posShiftId: text("pos_shift_id").references((): Ref => posShifts.id),
    cashierId: text("cashier_id"),
    /** When an offline POS sale was rung up on the device, if later than it reached the server. */
    offlineCreatedAt: at("offline_created_at"),
    /** Attribution (16.04). */
    utmLinkId: text("utm_link_id"),
    attribution: json<OrderAttribution>("attribution"),
  },
  (t) => [
    uniqueIndex("orders_ref_uq").on(t.ref),
    uniqueIndex("orders_idempotency_key_uq").on(t.idempotencyKey),
    index("orders_customer_idx").on(t.customerId, t.placedAt),
    index("orders_guest_contact_idx").on(t.guestContactId),
    index("orders_phone_idx").on(t.contactPhoneE164, t.placedAt),
    index("orders_status_idx").on(t.status, t.placedAt),
    index("orders_payment_status_idx").on(t.paymentStatus, t.placedAt),
    index("orders_placed_at_idx").on(t.placedAt),
    index("orders_channel_idx").on(t.channel, t.placedAt),
    index("orders_governorate_idx").on(t.governorateId),
    index("orders_district_idx").on(t.districtId),
    index("orders_coupon_idx").on(t.couponId),
    index("orders_review_idx").on(t.reviewStatus, t.placedAt),
    index("orders_assigned_idx").on(t.assignedTo, t.status),
    index("orders_branch_idx").on(t.branchId, t.placedAt),
    index("orders_register_idx").on(t.registerId),
    index("orders_pos_shift_idx").on(t.posShiftId),
    index("orders_utm_link_idx").on(t.utmLinkId),
    check(
      "orders_amounts_check",
      sql`${t.subtotalIqd} >= 0 AND ${t.discountIqd} >= 0 AND ${t.shippingIqd} >= 0 AND ${t.taxIqd} >= 0 AND ${t.totalIqd} >= 0 AND ${t.paidIqd} >= 0 AND ${t.refundedIqd} >= 0`,
    ),
    check("orders_total_check", sql`${t.totalIqd} = ${t.subtotalIqd} - ${t.discountIqd} + ${t.shippingIqd} + ${t.taxIqd}`),
    check("orders_web_phone_check", sql`${t.channel} <> 'web' OR ${t.contactPhoneE164} IS NOT NULL`),
  ],
);
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

/**
 * Order lines with snapshots of what was sold. `cost_snapshot_iqd` is [P] (landed cost per unit at
 * the time of sale) and is only selected for actors with cost.read / profit.read.
 */
export const orderItems = sqliteTable(
  "order_items",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    usedUnitId: text("used_unit_id").references((): Ref => usedUnits.id),
    sku: text("sku").notNull(),
    nameSnapshot: l10n("name_snapshot").notNull(),
    optionsSnapshot: json<Record<string, string>>("options_snapshot"),
    unitPriceIqd: iqd("unit_price_iqd").notNull(),
    qty: integer("qty").notNull(),
    discountIqd: iqd("discount_iqd").notNull().default(0),
    /** unit_price_iqd × qty − discount_iqd. */
    totalIqd: iqd("total_iqd").notNull(),
    /** [P] */
    costSnapshotIqd: iqd("cost_snapshot_iqd"),
    refundedQty: integer("refunded_qty").notNull().default(0),
    warrantyMonths: integer("warranty_months"),
    /** Used units carry their warranty in days. */
    warrantyDays: integer("warranty_days"),
    isPreorder: flag("is_preorder").notNull().default(false),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    index("order_items_variant_idx").on(t.variantId),
    index("order_items_used_unit_idx").on(t.usedUnitId),
    check("order_items_qty_check", sql`${t.qty} > 0 AND ${t.refundedQty} >= 0 AND (${t.usedUnitId} IS NULL OR ${t.qty} = 1)`),
    check("order_items_amounts_check", sql`${t.unitPriceIqd} >= 0 AND ${t.discountIqd} >= 0 AND ${t.totalIqd} >= 0`),
    check("order_items_total_check", sql`${t.totalIqd} = ${t.unitPriceIqd} * ${t.qty} - ${t.discountIqd}`),
  ],
);
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;

/**
 * Which physical unit left the building for which order line. A serial can be attached to only one
 * order item at a time: the UNIQUE index covers rows with `released_at IS NULL`. When a sold unit
 * comes back (return, cancelled before hand-over) the returns flow sets `released_at`, which keeps
 * the history and lets the unit be sold again after inspection.
 */
export const orderItemSerials = sqliteTable(
  "order_item_serials",
  {
    orderItemId: text("order_item_id")
      .notNull()
      .references((): Ref => orderItems.id),
    serialId: text("serial_id")
      .notNull()
      .references((): Ref => serials.id),
    attachedAt: at("attached_at").notNull().default(NOW_MS),
    attachedBy: text("attached_by"),
    releasedAt: at("released_at"),
  },
  (t) => [
    primaryKey({ columns: [t.orderItemId, t.serialId] }),
    uniqueIndex("order_item_serials_serial_uq").on(t.serialId).where(sql`${t.releasedAt} IS NULL`),
  ],
);
export type OrderItemSerial = typeof orderItemSerials.$inferSelect;
export type NewOrderItemSerial = typeof orderItemSerials.$inferInsert;

/** [A] Timeline of an order: status changes, payment events, edits, notifications (05.08). */
export const orderEvents = sqliteTable(
  "order_events",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    /** e.g. "placed", "status_changed", "proof_submitted", "payment_verified", "edited", "note". */
    kind: text("kind").notNull(),
    data: json<Record<string, unknown>>("data"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    at: at("at").notNull(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId, t.at), index("order_events_kind_idx").on(t.kind, t.at)],
);
export type OrderEvent = typeof orderEvents.$inferSelect;
export type NewOrderEvent = typeof orderEvents.$inferInsert;

// ───────────────────────────────────────────────────────────────── payments

/** State of one payment row (`payments.status`) — not to be confused with `orders.payment_status`. */
export const PAYMENT_TXN_STATUSES = ["pending", "pending_verification", "paid", "rejected", "cancelled"] as const;
export type PaymentTxnStatus = (typeof PAYMENT_TXN_STATUSES)[number];

/**
 * Money owed or received for an order. Manual transfers (bank_transfer, zaincash) are created as
 * `pending_verification` and become `paid` only when an employee verifies a proof — the database
 * refuses 'paid' for those methods without `verified_by` and `verified_at`.
 * Card numbers, CVV and expiry dates are never collected or stored.
 */
export const payments = sqliteTable(
  "payments",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    method: text("method", { enum: PAYMENT_METHODS }).notNull(),
    status: text("status", { enum: PAYMENT_TXN_STATUSES }).notNull().default("pending"),
    /** Amount due on this payment; once `paid`, the verified amount received. */
    amountIqd: iqd("amount_iqd").notNull(),
    /** What the shopper says they transferred. */
    declaredAmountIqd: iqd("declared_amount_iqd"),
    /** Transfer reference typed by the shopper or the verifier; duplicates are flagged. */
    reference: text("reference"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Employee who verified a manual transfer or recorded a COD/POS collection. */
    verifiedBy: text("verified_by"),
    verifiedAt: at("verified_at"),
    rejectReason: text("reject_reason"),
    createdAt: at("created_at").notNull(),
    paidAt: at("paid_at"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
    posShiftId: text("pos_shift_id").references((): Ref => posShifts.id),
    /** Wallet payments: the ledger row that moved the money. */
    walletLedgerId: text("wallet_ledger_id"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("payments_idempotency_key_uq").on(t.idempotencyKey),
    index("payments_order_idx").on(t.orderId),
    index("payments_status_idx").on(t.status, t.createdAt),
    index("payments_method_idx").on(t.method, t.status),
    index("payments_reference_idx").on(t.reference),
    index("payments_pos_shift_idx").on(t.posShiftId),
    check("payments_amount_check", sql`${t.amountIqd} >= 0 AND (${t.declaredAmountIqd} IS NULL OR ${t.declaredAmountIqd} >= 0)`),
  ],
);
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

export const PAYMENT_PROOF_STATUSES = ["submitted", "approved", "rejected"] as const;
export type PaymentProofStatus = (typeof PAYMENT_PROOF_STATUSES)[number];

/**
 * Uploaded evidence of a manual transfer. The image is a PRIVATE file; it is only readable with the
 * `payment_proof.read` permission (or by the shopper who uploaded it). A rejected proof can be
 * replaced by a new row. `duplicate_of` flags a proof whose sha256 or reference was seen before.
 */
export const paymentProofs = sqliteTable(
  "payment_proofs",
  {
    id: id(),
    paymentId: text("payment_id")
      .notNull()
      .references((): Ref => payments.id),
    fileId: text("file_id")
      .notNull()
      .references((): Ref => files.id),
    declaredAmountIqd: iqd("declared_amount_iqd").notNull(),
    note: text("note"),
    status: text("status", { enum: PAYMENT_PROOF_STATUSES }).notNull().default("submitted"),
    duplicateOf: text("duplicate_of").references((): Ref => paymentProofs.id),
    sha256: text("sha256").notNull(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: at("reviewed_at"),
    reviewNote: text("review_note"),
    createdAt: at("created_at").notNull(),
    /** Transfer reference number, when the shopper typed one. */
    reference: text("reference"),
  },
  (t) => [
    index("payment_proofs_payment_idx").on(t.paymentId),
    index("payment_proofs_file_idx").on(t.fileId),
    index("payment_proofs_sha256_idx").on(t.sha256),
    index("payment_proofs_reference_idx").on(t.reference),
    index("payment_proofs_status_idx").on(t.status, t.createdAt),
    index("payment_proofs_duplicate_idx").on(t.duplicateOf),
    check("payment_proofs_amount_check", sql`${t.declaredAmountIqd} > 0`),
  ],
);
export type PaymentProof = typeof paymentProofs.$inferSelect;
export type NewPaymentProof = typeof paymentProofs.$inferInsert;

// ───────────────────────────────────────────────────────────────── refunds

export const REFUND_METHODS = ["original", "wallet", "cash"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];
/** Rejected and cancelled refunds do not count against the refundable amount or quantity. */
export const REFUND_STATUSES = ["pending", "approved", "paid", "rejected", "cancelled"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Money going back to a customer. Always tied to the original payment (12.04, 12.05). */
export const refunds = sqliteTable(
  "refunds",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    paymentId: text("payment_id")
      .notNull()
      .references((): Ref => payments.id),
    amountIqd: iqd("amount_iqd").notNull(),
    method: text("method", { enum: REFUND_METHODS }).notNull(),
    reason: text("reason"),
    status: text("status", { enum: REFUND_STATUSES }).notNull().default("pending"),
    approvedBy: text("approved_by"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    returnId: text("return_id").references((): Ref => returns.id),
    approvedAt: at("approved_at"),
    paidAt: at("paid_at"),
    /** Wallet refunds: the ledger row that credited the customer. */
    walletLedgerId: text("wallet_ledger_id"),
    /** Outgoing transfer reference for refunds to the original method. */
    reference: text("reference"),
    idempotencyKey: text("idempotency_key"),
    rejectReason: text("reject_reason"),
  },
  (t) => [
    uniqueIndex("refunds_idempotency_key_uq").on(t.idempotencyKey),
    index("refunds_order_idx").on(t.orderId),
    index("refunds_payment_idx").on(t.paymentId, t.status),
    index("refunds_return_idx").on(t.returnId),
    index("refunds_status_idx").on(t.status, t.createdAt),
    check("refunds_amount_check", sql`${t.amountIqd} > 0`),
  ],
);
export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;

export const refundItems = sqliteTable(
  "refund_items",
  {
    refundId: text("refund_id")
      .notNull()
      .references((): Ref => refunds.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id")
      .notNull()
      .references((): Ref => orderItems.id),
    qty: integer("qty").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.refundId, t.orderItemId] }),
    index("refund_items_order_item_idx").on(t.orderItemId),
    check("refund_items_qty_check", sql`${t.qty} > 0`),
  ],
);
export type RefundItem = typeof refundItems.$inferSelect;
export type NewRefundItem = typeof refundItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── coupons

export const COUPON_KINDS = ["fixed", "percent"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

/** Conditions a coupon can carry beyond the columns (08.02). All present keys must match. */
export type CouponConditions = {
  platformIds?: string[];
  categoryIds?: string[];
  productIds?: string[];
  productKinds?: string[];
  segmentIds?: string[];
  channels?: string[];
  firstOrderOnly?: boolean;
  minQty?: number;
};

export const coupons = sqliteTable(
  "coupons",
  {
    id: id(),
    /** Stored upper-case; compared case-insensitively. */
    code: text("code").notNull(),
    kind: text("kind", { enum: COUPON_KINDS }).notNull(),
    /** `fixed`: an IQD amount. `percent`: basis points (1% = 100), use bpsOf(). */
    value: integer("value").notNull(),
    minSubtotalIqd: iqd("min_subtotal_iqd"),
    maxDiscountIqd: iqd("max_discount_iqd"),
    /** Total redemptions allowed; null = unlimited. */
    usageLimit: integer("usage_limit"),
    /** Per customer (or per phone for guests); null = unlimited. */
    perCustomerLimit: integer("per_customer_limit"),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    conditions: json<CouponConditions>("conditions"),
    isActive: flag("is_active").notNull().default(true),
    description: text("description"),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("coupons_code_uq").on(t.code),
    index("coupons_active_idx").on(t.isActive, t.endsAt),
    check("coupons_value_check", sql`${t.value} > 0 AND (${t.kind} <> 'percent' OR ${t.value} <= 10000)`),
  ],
);
export type Coupon = typeof coupons.$inferSelect;
export type NewCoupon = typeof coupons.$inferInsert;

/** One row per order that used a coupon. `voided_at` frees the use when the order is cancelled. */
export const couponRedemptions = sqliteTable(
  "coupon_redemptions",
  {
    id: id(),
    couponId: text("coupon_id")
      .notNull()
      .references((): Ref => coupons.id),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    customerId: text("customer_id").references((): Ref => customers.id),
    phoneE164: text("phone_e164"),
    amountIqd: iqd("amount_iqd").notNull(),
    at: at("at").notNull(),
    voidedAt: at("voided_at"),
  },
  (t) => [
    uniqueIndex("coupon_redemptions_coupon_order_uq").on(t.couponId, t.orderId),
    index("coupon_redemptions_order_idx").on(t.orderId),
    index("coupon_redemptions_customer_idx").on(t.customerId, t.couponId),
    index("coupon_redemptions_phone_idx").on(t.phoneE164, t.couponId),
  ],
);
export type CouponRedemption = typeof couponRedemptions.$inferSelect;
export type NewCouponRedemption = typeof couponRedemptions.$inferInsert;

// ───────────────────────────────────────────────────────────────── wallet [A]

export const WALLET_ENTRY_KINDS = ["topup", "purchase", "refund", "trade_in_credit", "gift_card", "adjustment"] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

/**
 * [A] The customer wallet is this ledger and nothing else: balance = SUM(amount_iqd) per customer.
 * Credits are positive, debits negative. A debit that would take the balance below zero is rejected
 * by a trigger. Only customers have wallets (customer_id is required) — guests never do.
 * Every entry needs an `idempotency_key` (e.g. "order:<id>:wallet", "refund:<id>") so a retry
 * cannot move money twice.
 */
export const walletLedger = sqliteTable(
  "wallet_ledger",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id),
    amountIqd: iqd("amount_iqd").notNull(),
    kind: text("kind", { enum: WALLET_ENTRY_KINDS }).notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    reason: text("reason"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    at: at("at").notNull(),
  },
  (t) => [
    uniqueIndex("wallet_ledger_idempotency_key_uq").on(t.idempotencyKey),
    index("wallet_ledger_customer_idx").on(t.customerId, t.at),
    index("wallet_ledger_ref_idx").on(t.refType, t.refId),
    check("wallet_ledger_amount_check", sql`${t.amountIqd} <> 0`),
  ],
);
export type WalletEntry = typeof walletLedger.$inferSelect;
export type NewWalletEntry = typeof walletLedger.$inferInsert;

export const WALLET_TOPUP_METHODS = ["bank_transfer", "zaincash", "cash"] as const;
export type WalletTopupMethod = (typeof WALLET_TOPUP_METHODS)[number];
export const WALLET_TOPUP_STATUSES = ["pending_verification", "approved", "rejected", "cancelled"] as const;
export type WalletTopupStatus = (typeof WALLET_TOPUP_STATUSES)[number];

/**
 * A customer's request to add money to their wallet. Like any manual transfer it is never credited
 * automatically: an employee checks the proof, and approving it writes the `wallet_ledger` row
 * (kind 'topup', idempotency_key "topup:<id>") in the same batch. The database refuses 'approved'
 * without a verifier (CHECK). The proof image is a private file.
 */
export const walletTopups = sqliteTable(
  "wallet_topups",
  {
    id: id(),
    ref: text("ref").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id),
    method: text("method", { enum: WALLET_TOPUP_METHODS }).notNull(),
    /** Amount credited once approved (the verified amount). */
    amountIqd: iqd("amount_iqd").notNull(),
    /** What the customer says they sent. */
    declaredAmountIqd: iqd("declared_amount_iqd"),
    reference: text("reference"),
    proofFileId: text("proof_file_id").references((): Ref => files.id),
    /** sha256 of the proof image, to flag re-used screenshots. */
    sha256: text("sha256"),
    status: text("status", { enum: WALLET_TOPUP_STATUSES }).notNull().default("pending_verification"),
    verifiedBy: text("verified_by"),
    verifiedAt: at("verified_at"),
    rejectReason: text("reject_reason"),
    walletLedgerId: text("wallet_ledger_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("wallet_topups_ref_uq").on(t.ref),
    uniqueIndex("wallet_topups_idempotency_key_uq").on(t.idempotencyKey),
    index("wallet_topups_customer_idx").on(t.customerId, t.createdAt),
    index("wallet_topups_status_idx").on(t.status, t.createdAt),
    index("wallet_topups_proof_file_idx").on(t.proofFileId),
    index("wallet_topups_sha256_idx").on(t.sha256),
    index("wallet_topups_reference_idx").on(t.reference),
    check("wallet_topups_amount_check", sql`${t.amountIqd} > 0`),
    check("wallet_topups_verified_check", sql`${t.status} <> 'approved' OR (${t.verifiedBy} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`),
  ],
);
export type WalletTopup = typeof walletTopups.$inferSelect;
export type NewWalletTopup = typeof walletTopups.$inferInsert;

// ───────────────────────────────────────────────────────────────── gift cards

export const GIFT_CARD_STATUSES = ["active", "redeemed", "void", "expired"] as const;
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number];

/**
 * Gift cards (08.07). A card is redeemed ONCE, in full, into the customer's wallet
 * (wallet_ledger kind 'gift_card', idempotency_key "gift_card:<id>") — the wallet then carries the
 * balance. Redemption is a guarded update (`WHERE status = 'active'` + expectChanged), so the same
 * card cannot be redeemed twice. Only the hash of the code is stored for lookup.
 */
export const giftCards = sqliteTable(
  "gift_cards",
  {
    id: id(),
    codeHash: text("code_hash").notNull(),
    /** Last characters of the code, for staff to tell cards apart. */
    codeHint: text("code_hint"),
    /** Encrypted code (DATA_KEY) when the card must be shown again to its buyer; otherwise null. */
    codeEnc: text("code_enc"),
    amountIqd: iqd("amount_iqd").notNull(),
    status: text("status", { enum: GIFT_CARD_STATUSES }).notNull().default("active"),
    /** Order line that sold the card, when bought in the store. */
    orderItemId: text("order_item_id").references((): Ref => orderItems.id),
    redeemedBy: text("redeemed_by").references((): Ref => customers.id),
    redeemedAt: at("redeemed_at"),
    walletLedgerId: text("wallet_ledger_id"),
    expiresAt: at("expires_at"),
    note: text("note"),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("gift_cards_code_hash_uq").on(t.codeHash),
    index("gift_cards_status_idx").on(t.status),
    index("gift_cards_order_item_idx").on(t.orderItemId),
    index("gift_cards_redeemed_by_idx").on(t.redeemedBy),
    check("gift_cards_amount_check", sql`${t.amountIqd} > 0`),
  ],
);
export type GiftCard = typeof giftCards.$inferSelect;
export type NewGiftCard = typeof giftCards.$inferInsert;

// ───────────────────────────────────────────────────────────────── loyalty [A]

export const LOYALTY_ENTRY_KINDS = ["earn", "redeem", "expire", "adjust", "reversal"] as const;
export type LoyaltyEntryKind = (typeof LOYALTY_ENTRY_KINDS)[number];

/**
 * [A] Loyalty points ledger (08.04): balance = SUM(points). Earned points may carry `expires_at`;
 * expiry is posted as a negative 'expire' row. A trigger rejects a row that would overdraw.
 */
export const loyaltyLedger = sqliteTable(
  "loyalty_ledger",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id),
    points: integer("points").notNull(),
    kind: text("kind", { enum: LOYALTY_ENTRY_KINDS }).notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    reason: text("reason"),
    expiresAt: at("expires_at"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    at: at("at").notNull(),
  },
  (t) => [
    uniqueIndex("loyalty_ledger_idempotency_key_uq").on(t.idempotencyKey),
    index("loyalty_ledger_customer_idx").on(t.customerId, t.at),
    index("loyalty_ledger_ref_idx").on(t.refType, t.refId),
    index("loyalty_ledger_expiry_idx").on(t.expiresAt),
    check("loyalty_ledger_points_check", sql`${t.points} <> 0`),
  ],
);
export type LoyaltyEntry = typeof loyaltyLedger.$inferSelect;
export type NewLoyaltyEntry = typeof loyaltyLedger.$inferInsert;

// ───────────────────────────────────────────────────────────────── invoices

export const INVOICE_KINDS = ["invoice", "receipt", "credit_note"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

/**
 * Numbered documents (05.06, 06.01): invoices, POS receipts and credit notes. `number` comes from
 * the `sequences` table inside the issuing batch; `data` is the frozen content for reprints.
 * Never contains [P] fields.
 */
export const invoices = sqliteTable(
  "invoices",
  {
    id: id(),
    number: text("number").notNull(),
    kind: text("kind", { enum: INVOICE_KINDS }).notNull().default("invoice"),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    /** Credit notes: the refund they document. */
    refundId: text("refund_id").references((): Ref => refunds.id),
    totalIqd: iqd("total_iqd").notNull(),
    data: json<Record<string, unknown>>("data").notNull(),
    issuedAt: at("issued_at").notNull(),
    issuedBy: text("issued_by"),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.number),
    index("invoices_order_idx").on(t.orderId),
    index("invoices_refund_idx").on(t.refundId),
    index("invoices_issued_at_idx").on(t.issuedAt),
  ],
);
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;

// Compile-time guards: keep these enums in step with the view-model unions in ~/lib/dto.
const dtoGuards: [Same<OrderStatus, OrderStatusDto>, Same<OrderPaymentStatus, PaymentStatusDto>, Subset<PaymentMethodDto, PaymentMethod>] = [true, true, true];
void dtoGuards;
