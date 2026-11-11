/**
 * aftersales — returns (RMA), return eligibility rules, warranties and repair tickets
 * (admin module 12, and the repair side of module 14 / the maintenance assistant).
 *
 * A refund for a return is a row in `refunds` (commerce) with `return_id` set; the refund bounds
 * are enforced there. `repair_events` is [A] append-only.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTOR_KINDS, NOW_MS, PRODUCT_KIND_SCOPES, at, flag, id, iqd, json, l10n, type Ref } from "../columns";
import { categories, deviceModels } from "./catalog";
import { orderItems, orders } from "./commerce";
import { customers } from "./customers";
import { serials } from "./inventory";
import { usedUnits } from "./used";

// ───────────────────────────────────────────────────────────────── returns

export const RETURN_STATUSES = ["requested", "approved", "rejected", "in_transit", "received", "inspected", "refunded", "exchanged", "repaired", "closed", "cancelled"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_RESOLUTIONS = ["refund", "store_credit", "exchange", "repair", "supplier_return", "none"] as const;
export type ReturnResolution = (typeof RETURN_RESOLUTIONS)[number];
export const RETURN_REASONS = ["defective", "damaged_in_delivery", "wrong_item", "not_as_described", "changed_mind", "incompatible", "other"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** A return request (RMA) tied to the original order (12.01). Photos are private files with owner_type "return". */
export const returns = sqliteTable(
  "returns",
  {
    id: id(),
    rma: text("rma").notNull(),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    customerId: text("customer_id").references((): Ref => customers.id),
    status: text("status", { enum: RETURN_STATUSES }).notNull().default("requested"),
    /** The customer's explanation in their own words. */
    reason: text("reason"),
    /** Decided by staff after inspection. */
    resolution: text("resolution", { enum: RETURN_RESOLUTIONS }),
    createdAt: at("created_at").notNull(),
    reasonCode: text("reason_code", { enum: RETURN_REASONS }),
    /** Contact for guests (and for pickup). */
    phoneE164: text("phone_e164"),
    /** What the customer asked for. */
    requestedResolution: text("requested_resolution", { enum: RETURN_RESOLUTIONS }),
    staffNote: text("staff_note"),
    rejectReason: text("reject_reason"),
    approvedBy: text("approved_by"),
    approvedAt: at("approved_at"),
    receivedAt: at("received_at"),
    inspectedAt: at("inspected_at"),
    closedAt: at("closed_at"),
    /** sha256 of the guest tracking token. */
    accessTokenHash: text("access_token_hash"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("returns_rma_uq").on(t.rma),
    index("returns_order_idx").on(t.orderId),
    index("returns_customer_idx").on(t.customerId),
    index("returns_phone_idx").on(t.phoneE164),
    index("returns_status_idx").on(t.status, t.createdAt),
  ],
);
export type ReturnRequest = typeof returns.$inferSelect;
export type NewReturnRequest = typeof returns.$inferInsert;

export const RETURN_ITEM_CONDITIONS = ["sellable", "opened", "defective", "damaged"] as const;
export type ReturnItemCondition = (typeof RETURN_ITEM_CONDITIONS)[number];
export const RESTOCK_ACTIONS = ["restock", "refurbish", "return_to_supplier", "scrap"] as const;
export type RestockAction = (typeof RESTOCK_ACTIONS)[number];

/** Lines of a return. Serialized units get one line per serial (qty 1). `condition` is set at inspection (12.03). */
export const returnItems = sqliteTable(
  "return_items",
  {
    id: id(),
    returnId: text("return_id")
      .notNull()
      .references((): Ref => returns.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id")
      .notNull()
      .references((): Ref => orderItems.id),
    qty: integer("qty").notNull().default(1),
    serialId: text("serial_id").references((): Ref => serials.id),
    condition: text("condition", { enum: RETURN_ITEM_CONDITIONS }),
    inspectedBy: text("inspected_by"),
    notes: text("notes"),
    restockAction: text("restock_action", { enum: RESTOCK_ACTIONS }),
    restockedAt: at("restocked_at"),
  },
  (t) => [
    index("return_items_return_idx").on(t.returnId),
    index("return_items_order_item_idx").on(t.orderItemId),
    index("return_items_serial_idx").on(t.serialId),
    check("return_items_qty_check", sql`${t.qty} > 0`),
  ],
);
export type ReturnItem = typeof returnItems.$inferSelect;
export type NewReturnItem = typeof returnItems.$inferInsert;

/** Whether a rule covers new items, used items, or both ("*"). */
export const ITEM_CONDITION_SCOPES = ["*", "new", "used"] as const;
export type ItemConditionScope = (typeof ITEM_CONDITION_SCOPES)[number];

/**
 * Return eligibility rules (12.02). The most specific active rule wins (category, then product kind,
 * then the catch-all); with no rule, `settings["returns.window_days"]` applies.
 */
export const returnPolicies = sqliteTable(
  "return_policies",
  {
    id: id(),
    /** "*" = every product kind. */
    productKind: text("product_kind", { enum: PRODUCT_KIND_SCOPES }).notNull().default("*"),
    categoryId: text("category_id").references((): Ref => categories.id, { onDelete: "cascade" }),
    /** "new" | "used" | "*" */
    itemCondition: text("item_condition", { enum: ITEM_CONDITION_SCOPES }).notNull().default("*"),
    isReturnable: flag("is_returnable").notNull().default(true),
    windowDays: integer("window_days"),
    /** Opened digital codes and unsealed games are typically not returnable. */
    requiresSealed: flag("requires_sealed").notNull().default(false),
    restockingFeeBps: integer("restocking_fee_bps").notNull().default(0),
    /** Text shown to shoppers on the product page and in the return form. */
    note: l10n("note"),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [index("return_policies_kind_idx").on(t.productKind, t.isActive), index("return_policies_category_idx").on(t.categoryId)],
);
export type ReturnPolicy = typeof returnPolicies.$inferSelect;
export type NewReturnPolicy = typeof returnPolicies.$inferInsert;

// ───────────────────────────────────────────────────────────────── warranties

/** `expired` is derived from `ends_at`; a job may persist it for reporting. */
export const WARRANTY_STATUSES = ["active", "expired", "void"] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

/** Warranty of a sold item, started at delivery / hand-over and linked to the serial when there is one (12.06). */
export const warranties = sqliteTable(
  "warranties",
  {
    id: id(),
    orderItemId: text("order_item_id")
      .notNull()
      .references((): Ref => orderItems.id),
    serialId: text("serial_id").references((): Ref => serials.id),
    customerId: text("customer_id").references((): Ref => customers.id),
    phoneE164: text("phone_e164"),
    startsAt: at("starts_at").notNull(),
    endsAt: at("ends_at").notNull(),
    /** Snapshot of the terms the customer was given. */
    terms: l10n("terms"),
    status: text("status", { enum: WARRANTY_STATUSES }).notNull().default("active"),
    usedUnitId: text("used_unit_id").references((): Ref => usedUnits.id),
    voidReason: text("void_reason"),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [
    index("warranties_order_item_idx").on(t.orderItemId),
    index("warranties_serial_idx").on(t.serialId),
    index("warranties_customer_idx").on(t.customerId),
    index("warranties_phone_idx").on(t.phoneE164),
    index("warranties_used_unit_idx").on(t.usedUnitId),
    index("warranties_status_idx").on(t.status, t.endsAt),
    check("warranties_dates_check", sql`${t.endsAt} >= ${t.startsAt}`),
  ],
);
export type Warranty = typeof warranties.$inferSelect;
export type NewWarranty = typeof warranties.$inferInsert;

// ───────────────────────────────────────────────────────────────── repairs

export const REPAIR_STATUSES = ["submitted", "received", "diagnosing", "awaiting_approval", "awaiting_parts", "repairing", "ready", "delivered", "unrepairable", "cancelled"] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];
export const REPAIR_SOURCES = ["storefront", "assistant", "store", "return", "warranty"] as const;
export type RepairSource = (typeof REPAIR_SOURCES)[number];

/** A part used (or quoted) in a repair. Internal part cost is never stored here — it comes from stock movements. */
export type RepairPart = { variantId?: string; name: string; qty: number; priceIqd: number };

/**
 * Repair / maintenance tickets (12.07). `cost_iqd` is what the customer is charged (0 under warranty);
 * the quote must be approved by the customer before chargeable work starts.
 */
export const repairTickets = sqliteTable(
  "repair_tickets",
  {
    id: id(),
    ref: text("ref").notNull(),
    customerId: text("customer_id").references((): Ref => customers.id),
    phoneE164: text("phone_e164").notNull(),
    deviceModelId: text("device_model_id").references((): Ref => deviceModels.id),
    /** Unit from our own registry, when we sold it. */
    serialId: text("serial_id").references((): Ref => serials.id),
    warrantyId: text("warranty_id").references((): Ref => warranties.id),
    /** The problem as the customer described it. */
    issue: text("issue").notNull(),
    status: text("status", { enum: REPAIR_STATUSES }).notNull().default("submitted"),
    slaDueAt: at("sla_due_at"),
    assignedTo: text("assigned_to"),
    parts: json<RepairPart[]>("parts"),
    costIqd: iqd("cost_iqd"),
    createdAt: at("created_at").notNull(),
    contactName: text("contact_name"),
    /** Serial as typed by the customer, for devices we did not sell. */
    serialText: text("serial_text"),
    /** Free-text device description when the model is not in the catalogue. */
    deviceText: text("device_text"),
    source: text("source", { enum: REPAIR_SOURCES }).notNull().default("storefront"),
    /** Maintenance-assistant conversation that led here (its summary is copied to the ticket on hand-off). */
    assistantSessionId: text("assistant_session_id"),
    returnId: text("return_id").references((): Ref => returns.id),
    isWarranty: flag("is_warranty").notNull().default(false),
    /** Technician's findings — a diagnosis is only ever made by a person who has the device. */
    diagnosis: text("diagnosis"),
    resolution: text("resolution"),
    quoteIqd: iqd("quote_iqd"),
    quoteApprovedAt: at("quote_approved_at"),
    receivedAt: at("received_at"),
    completedAt: at("completed_at"),
    deliveredAt: at("delivered_at"),
    accessTokenHash: text("access_token_hash"),
    isDemo: flag("is_demo").notNull().default(false),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("repair_tickets_ref_uq").on(t.ref),
    index("repair_tickets_customer_idx").on(t.customerId),
    index("repair_tickets_phone_idx").on(t.phoneE164),
    index("repair_tickets_device_model_idx").on(t.deviceModelId),
    index("repair_tickets_serial_idx").on(t.serialId),
    index("repair_tickets_warranty_idx").on(t.warrantyId),
    index("repair_tickets_return_idx").on(t.returnId),
    index("repair_tickets_status_idx").on(t.status, t.slaDueAt),
    index("repair_tickets_assigned_idx").on(t.assignedTo, t.status),
    index("repair_tickets_created_at_idx").on(t.createdAt),
  ],
);
export type RepairTicket = typeof repairTickets.$inferSelect;
export type NewRepairTicket = typeof repairTickets.$inferInsert;

/** [A] History of a repair: status changes, notes, parts used, customer approvals. */
export const repairEvents = sqliteTable(
  "repair_events",
  {
    id: id(),
    ticketId: text("ticket_id")
      .notNull()
      .references((): Ref => repairTickets.id),
    kind: text("kind").notNull(),
    note: text("note"),
    data: json<Record<string, unknown>>("data"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    at: at("at").notNull(),
  },
  (t) => [index("repair_events_ticket_idx").on(t.ticketId, t.at)],
);
export type RepairEvent = typeof repairEvents.$inferSelect;
export type NewRepairEvent = typeof repairEvents.$inferInsert;
